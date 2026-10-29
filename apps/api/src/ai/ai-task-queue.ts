import { PIPELINE_VERSIONS } from './pipeline-versions.js';
import { STANDARDIZATION_PROMPT_VERSION } from './standardization-request.js';
import { IDENTITY_POLICY_VERSION } from '../standardization/identity-policy.js';
import { jsonb } from '../database/types.js';
import { sql, type Kysely } from 'kysely';
import { DomainValidationError } from '../common/errors.js';
import { buildCursorPage, normalizePageRequest, type PageRequest } from '../common/pagination.js';
import type { DatabaseSchema } from '../database/types.js';
import { currentManualDecision, currentUnclassifiedQuery } from './ai-retry-pool.js';
import { BUSINESS_REFUSAL_REASONS } from './product-standardization-state.js';
import { currentTagMemberSource } from './tag-extraction-jobs.js';

export interface TaskQueueFilter extends PageRequest { status?: string; jobType?: string; scopeShopId?: bigint }
const unfinished = sql<boolean>`j.status in ('queued', 'running', 'paused', 'ready')`;
const currentPending = (scopeShopId?: bigint) => sql<bigint>`(select count(distinct m.product_id) from ai_job_input_members m
  join products p on p.id = m.product_id join shops s on s.id = p.shop_id
  where m.job_id = j.id and ${scopeShopId === undefined ? sql`true` : sql`p.shop_id = ${scopeShopId}`}
    and m.content_version = p.content_version
    and m.standardization_revision = p.standardization_revision and m.status in ('queued', 'processing')
    and p.deleted_at is null and s.deleted_at is null and s.enabled and not p.standardization_locked
    and not ${currentManualDecision}
    and not exists (select 1 from standard_product_members assignment
      join standard_products standard on standard.id = assignment.standard_product_id
      where assignment.product_id = p.id and (assignment.assignment_source = 'human'
        or (assignment.publication_state = 'published' and standard.verification_state = 'verified' and standard.merged_into_id is null)))
    and not exists (select 1 from ai_job_input_members newer
      where newer.product_id = p.id and newer.job_id > m.job_id and newer.content_version = p.content_version
        and newer.standardization_revision = p.standardization_revision))`;

/** Job history stays available; attention and pending counts project current product state. */
export async function readAiTaskQueue(db: Kysely<DatabaseSchema>, input: TaskQueueFilter) {
  if (input.jobType !== undefined && !['identity','incremental','manual_full','calibration','tag_extraction'].includes(input.jobType)) throw new DomainValidationError('INVALID_TASK_TYPE','任务类型无效');
  if(input.scopeShopId!==undefined && input.scopeShopId<=0n) throw new DomainValidationError('INVALID_ID','店铺 ID 无效');
  if(input.jobType==='tag_extraction') return readTagTaskQueue(db,input);
  const filter = input.status ?? 'unfinished';
  if (!['unfinished', 'attention', 'all'].includes(filter)) throw new DomainValidationError('INVALID_TASK_FILTER', '任务筛选无效');
  const page = normalizePageRequest(input);
  const processed = sql<bigint>`greatest(j.processed, (select count(*) from ai_standardization_results r where r.job_id = j.id))`;
  const productScope = input.scopeShopId === undefined ? sql<boolean>`true` : sql<boolean>`p.shop_id = ${input.scopeShopId}`;
  const scopedPending = currentPending(input.scopeShopId);
  const current = currentUnclassifiedQuery(db).where(productScope).where(sql<boolean>`r.job_id = j.id`)
    .where(eb => eb.or([eb('r.reason_code', 'is', null), eb('r.reason_code', 'not in', BUSINESS_REFUSAL_REASONS)]));
  const attention = sql<boolean>`exists (${current.select(sql<number>`1`.as('present'))})`;
  const currentCount = current.select(sql<bigint>`count(*)`.as('count'));
  const reasonClass = sql<string>`case
    when r.reason_code = 'provider_policy_rejection' then 'provider_policy_rejection'
    when r.reason_code in ('insufficient_evidence', 'missing_identity') then 'insufficient_evidence'
    when r.reason_code = 'not_sellable' then 'not_sellable'
    when r.reason_code in ('evidence_invalid', 'attribute_conflict', 'identity_conflict', 'publication_blocked', 'input_too_large', 'review_rejected') then r.reason_code
    when r.reason_code in ('provider_error', 'invalid_response', 'request_outcome_unknown', 'result_not_saved', 'publication_error', 'publication_too_large') then 'technical_failure'
    else 'other_unclassified' end`;
  // Version-expired jobs can never run again; the board only lists jobs on the current pipeline.
  const configCurrent=sql<boolean>`j.prompt_version = ${STANDARDIZATION_PROMPT_VERSION} and j.rule_version = ${IDENTITY_POLICY_VERSION} and j.pipeline_versions @> ${jsonb(PIPELINE_VERSIONS)}`;
  const typeScope=sql<boolean>`j.job_type <> 'tag_extraction' ${input.jobType==='incremental'||input.jobType==='manual_full'||input.jobType==='calibration'?sql`and j.job_type=${input.jobType}`:sql``} ${input.scopeShopId===undefined?sql``:sql`and (j.scope_shop_id=${input.scopeShopId} or exists(select 1 from ai_job_input_members scope_member join products scope_product on scope_product.id=scope_member.product_id where scope_member.job_id=j.id and scope_product.shop_id=${input.scopeShopId}))`}`;
  const statusScope=filter==='unfinished'?unfinished:filter==='attention'?attention:sql<boolean>`true`;
  let query = db.selectFrom('ai_jobs as j').leftJoin('shops as s', 's.id', 'j.scope_shop_id')
    .select(['j.id', 'j.status', 'j.total', 'j.model', 'j.job_type', 'j.source_fetch_run_id', 'j.scope_shop_id',
      'j.created_at', 'j.finished_at', 'j.unclassified', 's.name as shop_name', processed.as('processed'),
      currentCount.as('current_unclassified'), scopedPending.as('current_pending')])
    .where(typeScope)
    .where(configCurrent)
    .orderBy('j.id', 'desc').limit(page.limit + 1);
  if (filter === 'unfinished') query = query.where(unfinished);
  if (filter === 'attention') query = query.where(attention);
  if (page.afterId !== undefined) query = query.where('j.id', '<', page.afterId);
  const [rows, totals, pending, reasons] = await Promise.all([
    query.execute(),
    sql<Record<string, string | number | bigint>>`
      select count(*) as total, count(*) filter (where ${unfinished}) as unfinished,
        count(*) filter (where j.status = 'queued') as queued,
        count(*) filter (where j.status = 'running') as running,
        count(*) filter (where j.status in ('paused', 'ready')) as paused,
        count(*) filter (where ${attention}) as attention,
        coalesce(sum(${scopedPending}) filter (where ${unfinished}), 0) as pending_products
      from ai_jobs j where ${typeScope} and ${configCurrent} and ${statusScope}
    `.execute(db),
    sql<{ count: bigint }>`select count(distinct o.product_id) as count from standardization_outbox o
      join product_change_events e on e.id = o.event_id join products p on p.id = o.product_id join shops s on s.id = p.shop_id
      where ${input.scopeShopId===undefined?sql`true`:sql`p.shop_id=${input.scopeShopId}`} and ${filter==='attention'?sql`false`:sql`true`} and o.status in ('queued', 'running') and e.content_version = p.content_version
        and p.deleted_at is null and s.deleted_at is null and s.enabled = true`.execute(db),
    currentUnclassifiedQuery(db).where(productScope).innerJoin('ai_jobs as j','j.id','r.job_id').where(typeScope).where(configCurrent).where(statusScope).select([reasonClass.as('reason'), sql<number>`count(*)::int`.as('count')]).groupBy(reasonClass).execute(),
  ]);
  const result = buildCursorPage(rows, page.limit);
  const counts = totals.rows[0]!;
  const currentReasons: Record<string, number> = { technical_failure: 0, provider_policy_rejection: 0,
    insufficient_evidence: 0, not_sellable: 0,
    evidence_invalid: 0, attribute_conflict: 0, identity_conflict: 0, publication_blocked: 0, review_rejected: 0, other_unclassified: 0 };
  for (const row of reasons) currentReasons[row.reason] = (currentReasons[row.reason] ?? 0) + Number(row.count);
  return {
    items: result.items.map(row => ({
      id: row.id.toString(), status: row.status, total: Number(row.total), processed: Math.min(Number(row.total), Number(row.processed)),
      remaining: Number(row.current_pending), unclassified: Number(row.current_unclassified), historicalUnclassified: Number(row.unclassified),
      model: row.model, jobType: row.job_type, sourceFetchRunId: row.source_fetch_run_id?.toString() ?? null,
      scopeShopId: row.scope_shop_id?.toString() ?? null, shopName: row.shop_name, createdAt: row.created_at, finishedAt: row.finished_at,
    })),
    nextCursor: result.nextCursor ?? null,
    summary: { total: Number(counts.total), unfinished: Number(counts.unfinished), queued: Number(counts.queued),
      running: Number(counts.running), paused: Number(counts.paused), attention: Number(counts.attention),
      pendingProducts: Number(counts.pending_products), pendingEvents: Number(pending.rows[0]!.count), currentReasons },
  };
}

/** Job summaries follow the list filter; pending products match the actionable all-pending scope. */
async function readTagTaskQueue(db:Kysely<DatabaseSchema>,input:TaskQueueFilter) {
 const status=input.status??'unfinished';
 if(!['unfinished','attention','all'].includes(status)) throw new DomainValidationError('INVALID_TASK_FILTER','任务筛选无效');
 const page=normalizePageRequest(input);
 const needsAttention=sql<boolean>`(status='failed' or current_attention>0 or (not configuration_current and status in ('queued','running','paused','ready')))`;
 const result=await sql<{items: Array<Record<string,unknown>>;summary: Record<string,unknown>}>`
 with eligible_products as (
 select p.id from products p join shops s on s.id=p.shop_id
 where p.deleted_at is null and s.deleted_at is null and s.enabled and not p.standardization_locked
 ${input.scopeShopId===undefined?sql``:sql`and p.shop_id=${input.scopeShopId}`}
 and not ${currentManualDecision}
 and not exists(select 1 from standard_product_members a where a.product_id=p.id and a.assignment_source='human')
 and exists(select 1 from standard_product_members a join standard_products standard on standard.id=a.standard_product_id where a.product_id=p.id and a.assignment_source='ai' and a.publication_state='published' and standard.verification_state='verified' and standard.merged_into_id is null)
 ), current_members as (
  select m.job_id,m.product_id,m.status,j.status job_status,
    m.output->>'outcome' outcome,
    coalesce(m.output->>'reasonCode',m.reason_code,'unrecorded') reason,
    m.output is null output_missing,
    jsonb_array_length(coalesce(m.output->'rejectedTags','[]'::jsonb))>0 has_rejected
   from ai_job_input_members m join ai_jobs j on j.id=m.job_id
   join products p on p.id=m.product_id join shops s on s.id=p.shop_id
  where j.job_type='tag_extraction' ${input.scopeShopId===undefined?sql``:sql`and p.shop_id=${input.scopeShopId}`} and m.content_version=p.content_version
   and m.standardization_revision=p.standardization_revision and m.fingerprint=p.content_fingerprint
   and ${currentTagMemberSource('m')}
   and j.prompt_version=${STANDARDIZATION_PROMPT_VERSION} and j.rule_version=${IDENTITY_POLICY_VERSION} and j.pipeline_versions @> ${jsonb(PIPELINE_VERSIONS)}
   and p.deleted_at is null and s.deleted_at is null and s.enabled and not p.standardization_locked
   and not ${currentManualDecision}
   and not exists(select 1 from standard_product_members a where a.product_id=p.id and a.assignment_source='human')
   and exists(select 1 from standard_product_members a join standard_products standard on standard.id=a.standard_product_id where a.product_id=p.id and a.assignment_source='ai' and a.publication_state='published' and standard.verification_state='verified' and standard.merged_into_id is null)
   and not exists(select 1 from ai_job_input_members newer join ai_jobs nj on nj.id=newer.job_id where newer.product_id=m.product_id and newer.job_id>m.job_id and nj.job_type='tag_extraction' and newer.content_version=p.content_version and newer.standardization_revision=p.standardization_revision and newer.fingerprint=p.content_fingerprint and ${currentTagMemberSource('newer')} and nj.prompt_version=${STANDARDIZATION_PROMPT_VERSION} and nj.rule_version=${IDENTITY_POLICY_VERSION} and nj.pipeline_versions @> ${jsonb(PIPELINE_VERSIONS)})
 ), current_counts as (
  select job_id,
    count(*) filter(where status in ('queued','processing'))::int current_pending,
    count(*) filter(where outcome in ('review','failed') or has_rejected)::int current_attention,
    count(*) filter(where outcome in ('updated','unchanged','empty','review'))::int covered_products,
    count(*) filter(where outcome='review' or has_rejected)::int review_products,
    count(*) filter(where outcome='failed')::int failed_products
  from current_members group by job_id
 ), jobs as (
  select j.id,j.status,j.phase,j.model,j.job_type,j.parent_identity_job_id,j.retry_of_job_id,j.source_fetch_run_id,
    j.scope_shop_id,j.pipeline_versions,j.input_bytes,j.estimated_tokens,j.created_at,j.finished_at,s.name shop_name,
    coalesce(j.prompt_version=${STANDARDIZATION_PROMPT_VERSION} and j.rule_version=${IDENTITY_POLICY_VERSION}
      and j.pipeline_versions @> ${jsonb(PIPELINE_VERSIONS)},false) configuration_current,
    coalesce(c.current_pending,0) current_pending,coalesce(c.current_attention,0) current_attention,
    coalesce(c.covered_products,0) covered_products,coalesce(c.review_products,0) review_products,coalesce(c.failed_products,0) failed_products
  from ai_jobs j left join shops s on s.id=j.scope_shop_id
    left join current_counts c on c.job_id=j.id where j.job_type='tag_extraction'
   ${input.scopeShopId===undefined?sql``:sql`and (j.scope_shop_id=${input.scopeShopId} or j.id in(select m.job_id from ai_job_input_members m join products p on p.id=m.product_id where p.shop_id=${input.scopeShopId}))`}
 ), filtered as (select * from jobs where ${status==='unfinished'?sql`configuration_current and status in ('queued','running','paused','ready')`:status==='attention'?needsAttention:sql`true`}),
 page as (
  select j.*,
    (select count(*)::int from ai_job_input_members m where m.job_id=j.id) raw_count,
    (select count(*)::int from ai_job_inputs i where i.job_id=j.id) unique_count,
    (select count(*)::int from ai_job_input_members m where m.job_id=j.id and m.status not in ('queued','processing')) member_processed
  from (select * from filtered where ${page.afterId===undefined?sql`true`:sql`id<${page.afterId}`} order by id desc limit ${page.limit+1}) j
 )
 select coalesce((select jsonb_agg(jsonb_build_object('id',id::text,'status',status,'phase',phase,'total',raw_count,'processed',member_processed,'remaining',current_pending,'unclassified',current_attention,'model',model,'jobType',job_type,'parentIdentityJobId',parent_identity_job_id::text,'retryOfJobId',retry_of_job_id::text,'sourceFetchRunId',source_fetch_run_id::text,'scopeShopId',scope_shop_id::text,'shopName',shop_name,'uniqueInputCount',unique_count,'pipelineVersions',pipeline_versions,'configurationCurrent',configuration_current,'inputBytes',input_bytes::text,'estimatedTokens',estimated_tokens::text,'createdAt',created_at,'finishedAt',finished_at) order by id desc) from page),'[]'::jsonb) items,
 (select jsonb_build_object('total',count(*),'unfinished',count(*) filter(where status in ('queued','running','paused','ready')),'queued',count(*) filter(where status='queued'),'running',count(*) filter(where status='running'),'paused',count(*) filter(where status in ('paused','ready')),'attention',count(*) filter(where ${needsAttention}),'pendingProducts',(select count(*) from eligible_products p
   where not exists(select 1 from current_members m where m.product_id=p.id and (
     (m.outcome in ('updated','unchanged','empty','review'))
     or (m.job_status in ('queued','running','paused','ready') and m.status in ('queued','processing'))))),'pendingEvents',0,'currentReasons',(select coalesce(jsonb_object_agg(reason,n),'{}'::jsonb) from (select m.reason,count(*)::int n from current_members m where m.job_id in(select id from filtered) and m.status not in ('queued','processing') and (m.output_missing or m.outcome in ('review','failed','skipped','cancelled') or m.has_rejected) group by m.reason) reasons),
 'coveredProducts',coalesce(sum(covered_products),0),
 'reviewProducts',coalesce(sum(review_products),0),
 'failedProducts',coalesce(sum(failed_products),0)) from filtered) summary
 `.execute(db);
 const row=result.rows[0]!;
 const paged=buildCursorPage(row.items.map(i=>({...i,id:BigInt(String(i.id))})),page.limit);
 return {items:paged.items.map(i=>({...i,id:String(i.id)})),nextCursor:paged.nextCursor??null,summary:row.summary};
}

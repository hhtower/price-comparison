import { currentExecutionPipeline, STANDARDIZATION_POLICY_VERSION, taskExecutionVersions, taskResultVersions } from './pipeline-versions.js';
import { STANDARDIZATION_PROMPT_VERSION } from './standardization-request.js';
import { isAttributeJobType, jsonb, type AttributeJobType } from '../database/types.js';
import { sql, type Kysely } from 'kysely';
import { DomainValidationError } from '../common/errors.js';
import { buildCursorPage, normalizePageRequest, type PageRequest } from '../common/pagination.js';
import type { DatabaseSchema } from '../database/types.js';
import { currentManualDecision, currentUnclassifiedQuery } from './ai-retry-pool.js';
import { currentAttributeMemberHistory, currentTagMemberSource } from './tag-extraction-jobs.js';
import { hasUsableOffer } from './offer-eligibility.js';
import { currentMembershipKind } from '../standardization/membership-classification.js';
import { hasLostMemberRequest, lostBatchRequest } from './request-outcome.js';

export interface TaskQueueFilter extends PageRequest { status?: string; jobType?: string; scopeShopId?: bigint; totalOnly?: boolean }
const unfinished = sql<boolean>`j.status in ('queued', 'running', 'paused', 'ready')`;
const taskShopScope = (shopId?: bigint) => shopId === undefined ? sql<boolean>`true` : sql<boolean>`j.id in (
  select id from ai_jobs where scope_shop_id=${shopId}
  union select m.job_id from products p join ai_job_input_members m on m.product_id=p.id where p.shop_id=${shopId}
)`;
const currentPending = (scopeShopId?: bigint) => sql<bigint>`(select count(distinct m.product_id) from ai_job_input_members m
  join products p on p.id = m.product_id join shops s on s.id = p.shop_id
  where m.job_id = j.id and ${scopeShopId === undefined ? sql`true` : sql`p.shop_id = ${scopeShopId}`}
    and m.content_version = p.content_version
    and m.standardization_revision = p.standardization_revision and m.status in ('queued', 'processing')
    and p.deleted_at is null and s.deleted_at is null and s.enabled and not p.standardization_locked
    and ${hasUsableOffer()}
    and not ${currentManualDecision}
    and not exists (select 1 from standard_product_members assignment
      join standard_products standard on standard.id = assignment.standard_product_id
      where assignment.product_id = p.id and assignment.publication_state = 'published'
        and standard.verification_state = 'verified' and standard.merged_into_id is null)
    and not exists (select 1 from ai_job_input_members newer join ai_jobs newer_job on newer_job.id = newer.job_id
      where newer.product_id = p.id and newer.job_id > m.job_id and newer.content_version = p.content_version
        and newer.standardization_revision = p.standardization_revision
        and ${currentExecutionPipeline('newer_job')}
        and newer_job.job_type not in ('tag_extraction', 'membership_features', 'text_review')))`;

/** Job history stays available; attention and pending counts project current product state. */
export async function readAiTaskQueue(db: Kysely<DatabaseSchema>, input: TaskQueueFilter) {
  if (db.isTransaction) return readTaskQueue(db, input);
  return db.transaction().setIsolationLevel('repeatable read').execute(async tx => {
    await sql`set local jit = off`.execute(tx);
    return readTaskQueue(tx, input);
  });
}

async function readTaskQueue(db: Kysely<DatabaseSchema>, input: TaskQueueFilter) {
  if (input.jobType !== undefined && !isAttributeJobType(input.jobType) && !['identity','incremental','manual_full','calibration'].includes(input.jobType)) throw new DomainValidationError('INVALID_TASK_TYPE','任务类型无效');
  if(input.scopeShopId!==undefined && input.scopeShopId<=0n) throw new DomainValidationError('INVALID_ID','店铺 ID 无效');
  if(input.jobType && isAttributeJobType(input.jobType)) return readAttributeTaskQueue(db,{...input,jobType:input.jobType});
  const filter = input.status ?? 'unfinished';
  if (!['unfinished', 'attention', 'all'].includes(filter)) throw new DomainValidationError('INVALID_TASK_FILTER', '任务筛选无效');
  const page = normalizePageRequest(input);
  const processed = sql<bigint>`greatest(j.processed, (select count(*) from ai_standardization_results r where r.job_id = j.id))`;
  const productScope = input.scopeShopId === undefined ? sql<boolean>`true` : sql<boolean>`p.shop_id = ${input.scopeShopId}`;
  const scopedPending = currentPending(input.scopeShopId);
  const current = currentUnclassifiedQuery(db, sql<bigint>`j.id`).where(productScope)
    .where(sql<boolean>`r.job_id = j.id`);
  const attention = filter === 'attention'
    ? sql<boolean>`exists (select 1 from report_unclassified r where r.job_id = j.id)`
    : sql<boolean>`exists (${current.select(sql<number>`1`.as('present'))})`;
  const currentCount = filter === 'attention'
    ? sql<bigint>`(select count(*) from report_unclassified r where r.job_id = j.id)`
    : current.select(sql<bigint>`count(*)`.as('count'));
  const reasonClass = sql<string>`case
    when r.reason_code = 'provider_policy_rejection' then 'provider_policy_rejection'
    when r.reason_code in ('evidence_invalid', 'attribute_conflict', 'identity_conflict', 'publication_blocked', 'input_too_large', 'review_rejected') then r.reason_code
    when r.reason_code in ('provider_error', 'invalid_response', 'request_outcome_unknown', 'result_not_saved', 'publication_error', 'publication_too_large') then 'technical_failure'
    else 'other_unclassified' end`;
  // Completed history uses business versions; active jobs must still be executable.
  const configCurrent=sql<boolean>`(j.prompt_version = ${STANDARDIZATION_PROMPT_VERSION}
    and j.rule_version = ${STANDARDIZATION_POLICY_VERSION}
    and (coalesce(j.job_type in ('incremental','manual_full','calibration')
      and j.pipeline_versions @> ${jsonb(taskExecutionVersions('manual_full'))}, false)
      ${filter === 'unfinished' ? sql`` : sql`or (not (${unfinished})
        and j.pipeline_versions @> ${jsonb(taskResultVersions('standardization'))})`}))`;
  const typeScope=sql<boolean>`j.job_type not in ('tag_extraction', 'membership_features', 'text_review') ${input.jobType==='incremental'||input.jobType==='manual_full'||input.jobType==='calibration'?sql`and j.job_type=${input.jobType}`:sql``} and ${taskShopScope(input.scopeShopId)}`;
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
  // Shop membership and current failures require live joins; plain history totals only need metadata.
  const profileTotal = input.totalOnly && filter !== 'attention' && input.scopeShopId === undefined;
  const totalQuery = sql<Record<string, string | number | bigint>>`
      select ${profileTotal ? sql`coalesce(sum((select count(*) from ai_job_report_rows r where r.identity_hash=j.identity_hash)), 0)` : sql`count(*)`} as total ${input.totalOnly ? sql`` : sql`, count(*) filter (where ${unfinished}) as unfinished,
        count(*) filter (where j.status = 'queued') as queued,
        count(*) filter (where j.status = 'running') as running,
        count(*) filter (where j.status in ('paused', 'ready')) as paused,
        count(*) filter (where ${attention}) as attention,
        coalesce(sum(${scopedPending}) filter (where ${unfinished}), 0) as pending_products`}
      from ${profileTotal ? sql`ai_job_report_profiles` : sql`ai_jobs`} j where ${typeScope} and ${configCurrent} and ${statusScope}
    `;
  const pendingQuery = sql<{ count: bigint }>`select count(distinct o.product_id) as count from standardization_outbox o
      join product_change_events e on e.id = o.event_id join products p on p.id = o.product_id join shops s on s.id = p.shop_id
      where ${input.scopeShopId===undefined?sql`true`:sql`p.shop_id=${input.scopeShopId}`} and ${filter==='attention'?sql`false`:sql`true`} and o.status in ('queued', 'running') and e.content_version = p.content_version
        and p.deleted_at is null and s.deleted_at is null and s.enabled = true and ${hasUsableOffer()}`;
  const report = async () => {
    if (filter !== 'attention') {
      let totals = profileTotal ? await totalQuery.execute(db) : undefined;
      const rows = totals && Number(totals.rows[0]!.total) === 0 ? [] : await query.execute();
      totals ??= await totalQuery.execute(db);
      const pending = input.totalOnly ? undefined : await pendingQuery.execute(db);
      const reasons = input.totalOnly ? [] : await currentUnclassifiedQuery(db).where(productScope).innerJoin('ai_jobs as j','j.id','r.job_id')
          .where(typeScope).where(configCurrent).where(statusScope)
          .select([reasonClass.as('reason'), sql<number>`count(*)::int`.as('count')]).groupBy(reasonClass).execute();
      return { rows, counts: totals.rows[0]!, pending, reasons };
    }
    type Task = Awaited<ReturnType<typeof query.execute>>[number];
    const unresolved = currentUnclassifiedQuery(db).where(productScope).select(['r.job_id', 'r.reason_code']);
    const results = await sql<Task & {
      counts: Record<string, string | number | bigint>; reasons: Array<{ reason: string; count: number }>;
    }>`with report_unclassified as materialized (${unresolved}),
      totals as (${totalQuery}), page as (${query})
      select page.*, to_jsonb(totals) as counts,
        ${input.totalOnly ? sql`'[]'::jsonb` : sql`(
          select coalesce(jsonb_agg(reasons), '[]'::jsonb) from (
            select ${reasonClass} as reason, count(*)::int as count from report_unclassified r
            join ai_jobs j on j.id = r.job_id where ${typeScope} and ${configCurrent}
            group by ${reasonClass}
          ) reasons
        )`} as reasons
      from totals left join page on true order by page.id desc nulls last`.execute(db);
    const first = results.rows[0]!;
    return {
      rows: results.rows.filter(row => row.id !== null).map(({ counts: _counts, reasons: _reasons, ...row }) => row as Task),
      counts: first.counts, reasons: first.reasons,
      pending: input.totalOnly ? undefined : { rows: [{ count: 0n }] },
    };
  };
  const { rows, counts, pending, reasons } = await report();
  const result = buildCursorPage(rows, page.limit);
  const currentReasons: Record<string, number> = { technical_failure: 0, provider_policy_rejection: 0,
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
    summary: { total: Number(counts.total), ...(pending && { unfinished: Number(counts.unfinished), queued: Number(counts.queued),
      running: Number(counts.running), paused: Number(counts.paused), attention: Number(counts.attention),
      pendingProducts: Number(counts.pending_products), pendingEvents: Number(pending.rows[0]!.count), currentReasons }) },
  };
}

/** The active board counts task members; history retains current product coverage diagnostics. */
async function readAttributeTaskQueue(db:Kysely<DatabaseSchema>,input:TaskQueueFilter & {jobType:AttributeJobType}) {
 const status=input.status??'unfinished';
 if(!['unfinished','attention','all'].includes(status)) throw new DomainValidationError('INVALID_TASK_FILTER','任务筛选无效');
 const page=normalizePageRequest(input);
 const publication=sql<boolean>`exists(
   select 1 from standard_product_members a join standard_products standard on standard.id=a.standard_product_id
   where a.product_id=p.id and a.assignment_source='ai' and a.publication_state='published'
     and standard.verification_state='verified' and standard.merged_into_id is null
     ${input.jobType==='membership_features'?sql`and is_ai_membership(standard.canonical_family,standard.canonical_product,standard.canonical_tier)`:sql``}
 )`;
 const capture=sql`(p.source_data->'ratingText')`;
 const warrantyEligible = input.jobType === 'tag_extraction' ? sql<boolean>`exists(
   select 1 from standard_product_members a join standard_products standard on standard.id=a.standard_product_id
   where a.product_id=p.id and a.assignment_source='ai' and a.publication_state='published'
     and standard.verification_state='verified' and standard.merged_into_id is null
     and is_ai_membership(standard.canonical_family,standard.canonical_product,standard.canonical_tier)
 )` : undefined;
 const currentSource=(member:'m'|'newer')=>sql<boolean>`${currentTagMemberSource(member, warrantyEligible)}
   ${input.jobType==='text_review'?sql`and ${sql.ref(`${member}.payload`)}->'shopText'->>'hash'=${capture}->>'hash'`:sql``}`;
 const currentFeatures = input.jobType === 'membership_features' ? sql<boolean>`coalesce(
   ${currentMembershipKind('p','s')} is not null
   and jsonb_typeof(p.membership_features->'tags')='array'
   and jsonb_typeof(p.membership_features->'rejectedNames')='array'
   and not exists(select 1 from jsonb_array_elements(case when jsonb_typeof(p.membership_features->'tags')='array'
     then p.membership_features->'tags' else '[]'::jsonb end) tag
     where jsonb_typeof(tag->'name') is distinct from 'string' or jsonb_typeof(tag->'value') is distinct from 'string'),false)` : sql<boolean>`false`;
 const currentHistory = (member: 'm' | 'newer', job: 'j' | 'nj') =>
   sql<boolean>`(${currentAttributeMemberHistory(input.jobType,member,job,currentFeatures)})`;
 const executing = sql<boolean>`
   ${currentExecutionPipeline()}
   and j.status in ('queued','running') and not j.pause_requested and not j.cancel_requested`;
 const lostRequest = input.jobType === 'text_review' ? sql<boolean>`false` : hasLostMemberRequest('m', executing);
 const eligible=sql<boolean>`p.deleted_at is null and s.deleted_at is null and s.enabled and not p.standardization_locked and ${hasUsableOffer()}
   ${input.scopeShopId===undefined?sql``:sql`and p.shop_id=${input.scopeShopId}`}
   ${input.jobType==='text_review'?sql`and case when jsonb_typeof(${capture})='object' then
     ${capture}-array['unitId','name','description','hash']='{}'::jsonb
     and jsonb_typeof(${capture}->'unitId')='string' and ${capture}->>'unitId' ~ '[^[:space:]]'
     and jsonb_typeof(${capture}->'name')='string'
     and jsonb_typeof(${capture}->'description')='string'
     and jsonb_typeof(${capture}->'hash')='string' and ${capture}->>'hash' ~ '^[a-f0-9]{64}$'
     else false end`:sql``}
   and not ${currentManualDecision}
   and not exists(select 1 from standard_product_members a where a.product_id=p.id and a.assignment_source='human')
   and ${publication}`;
 const needsAttention=sql<boolean>`(status='failed' or current_attention>0 or (not configuration_current and status in ('queued','running','paused','ready')))`;
 const pageFirst = input.totalOnly && status !== 'attention';
 const attentionMembers = input.totalOnly && status === 'attention';
 const pageWindow = sql`${page.afterId === undefined ? sql`` : sql`where id < ${page.afterId}`} order by id desc limit ${page.limit + 1}`;
 const jobScope = sql`j.job_type=${input.jobType}
   ${status==='unfinished'?sql`and ${unfinished} and ${currentExecutionPipeline()}`:sql``}
   and ${taskShopScope(input.scopeShopId)}`;
 const memberNeedsReport = sql`(m.status in ('queued','processing') or m.output->>'outcome' in ('review','partial_success','failed')
   ${input.jobType === 'text_review' ? sql`` : sql`or coalesce(m.output->>'reasonCode',m.reason_code)='request_outcome_unknown' or ${lostRequest}`}
   or jsonb_array_length(coalesce(m.output->'rejectedTags','[]'::jsonb))>0)`;
 const currentCandidate = sql`m.content_version=p.content_version and m.standardization_revision=p.standardization_revision
   and m.fingerprint=p.content_fingerprint and p.deleted_at is null and not p.standardization_locked
   ${input.scopeShopId === undefined ? sql`` : sql`and p.shop_id=${input.scopeShopId}`}`;
 const result=await sql<{items: Array<Record<string,unknown>>;summary: Record<string,unknown>}>`
 with ${pageFirst ? sql`scoped_ids as not materialized (select j.id from ai_jobs j where ${jobScope}),
 page_ids as (select id from scoped_ids ${pageWindow}),
 page_members as materialized (
   select m.job_id,m.input_id,m.product_id,m.status,m.output,m.reason_code,m.content_version,m.standardization_revision,m.fingerprint,m.payload
   from page_ids j join ai_job_input_members m on m.job_id=j.id
 ),` : sql``}
 ${attentionMembers ? sql`attention_member_keys as materialized (
   select m.job_id,m.product_id
   from ai_job_input_members m join ai_jobs j on j.id=m.job_id
   join products p on p.id=m.product_id and ${currentCandidate}
   where ${jobScope} and (case when m.status in ('queued','processing') or m.output->>'outcome' in ('review','partial_success','failed')
     or coalesce(m.output->>'reasonCode',m.reason_code)='request_outcome_unknown'
     or coalesce(m.output->'rejectedTags','[]'::jsonb) <> '[]'::jsonb then 1 else 0 end) = 1
   ${input.jobType === 'text_review' ? sql`` : sql`union
   select m.job_id,m.product_id
   from ai_job_batches b join ai_jobs j on j.id=b.job_id
   join ai_job_input_members m on m.job_id=b.job_id and b.product_ids @> jsonb_build_array(m.input_id::text)
   join products p on p.id=m.product_id and ${currentCandidate}
   where ${jobScope} and b.step='request' and ${lostBatchRequest('b', executing)}`}
 ),` : sql``}
 ${status==='unfinished'||input.totalOnly?sql``:sql`eligible_products as (
 select p.id,${currentFeatures} features_current from products p join shops s on s.id=p.shop_id
 where ${eligible}
 ),`} current_members as (
  select m.job_id,m.product_id,m.status,j.status job_status,
    ${currentExecutionPipeline()} execution_current,
    m.output->>'outcome' outcome,
    case when ${lostRequest} then 'request_outcome_unknown'
      else coalesce(m.output->>'reasonCode',m.reason_code,'unrecorded') end reason,
    m.output is null output_missing,
    jsonb_array_length(coalesce(m.output->'rejectedTags','[]'::jsonb))>0 has_rejected
  from ${pageFirst ? sql`page_members m` : attentionMembers ? sql`attention_member_keys candidate
    join lateral (select source.* from ai_job_input_members source
      where source.job_id=candidate.job_id and source.product_id=candidate.product_id offset 0) m on true`
    : sql`ai_job_input_members m`} join ai_jobs j on j.id=m.job_id
 ${status==='unfinished'?sql`
  where j.job_type=${input.jobType} and ${unfinished}
    and ${currentExecutionPipeline()}
    ${input.jobType==='membership_features'?sql`and exists(
      select 1 from products p join shops s on s.id=p.shop_id
      where p.id=m.product_id and ${eligible}
        and m.content_version=p.content_version and m.standardization_revision=p.standardization_revision
        and m.fingerprint=p.content_fingerprint and ${currentTagMemberSource('m')}
    )`:sql``}
 `:sql`
   join products p on p.id=m.product_id join shops s on s.id=p.shop_id
  where j.job_type=${input.jobType} and m.content_version=p.content_version
   and m.standardization_revision=p.standardization_revision and m.fingerprint=p.content_fingerprint
   and ${currentSource('m')}
   and ${currentHistory('m','j')}
   and ${eligible}
   and not exists(select 1 from ai_job_input_members newer join ai_jobs nj on nj.id=newer.job_id where newer.product_id=m.product_id and newer.job_id>m.job_id and nj.job_type=${input.jobType} and newer.content_version=p.content_version and newer.standardization_revision=p.standardization_revision and newer.fingerprint=p.content_fingerprint and ${currentSource('newer')} and ${currentHistory('newer','nj')} offset 0)`}
 ${input.totalOnly && !attentionMembers ? sql`and ${memberNeedsReport}` : sql``}
 ), current_counts as (
  select job_id,
    count(*) filter(where status in ('queued','processing') and execution_current
      ${input.jobType === 'text_review' ? sql`` : sql`and reason<>'request_outcome_unknown'`})::int current_pending,
    count(*) filter(where outcome in ('review','partial_success','failed') or has_rejected
      ${input.jobType === 'text_review' ? sql`` : sql`or reason='request_outcome_unknown'`})::int current_attention,
    count(*) filter(where outcome in ('updated','unchanged','empty','review'))::int covered_products,
    count(*) filter(where outcome in ('review','partial_success') or has_rejected)::int review_products,
    count(*) filter(where outcome='failed')::int failed_products
  from current_members group by job_id
 ), jobs as (
  select j.id,j.status,j.phase,j.model,j.job_type,j.parent_identity_job_id,j.retry_of_job_id,j.source_fetch_run_id,
    j.scope_shop_id,j.pipeline_versions,j.input_bytes,j.estimated_tokens,j.created_at,j.finished_at,s.name shop_name,
    ${currentExecutionPipeline()} configuration_current,
    coalesce(c.current_pending,0) current_pending,coalesce(c.current_attention,0) current_attention,
    coalesce(c.covered_products,0) covered_products,coalesce(c.review_products,0) review_products,coalesce(c.failed_products,0) failed_products
  from ai_jobs j left join shops s on s.id=j.scope_shop_id
    left join current_counts c on c.job_id=j.id where ${pageFirst ? sql`j.id in (select id from page_ids)` : jobScope}
 ), filtered as (select * from jobs where ${status==='unfinished'?sql`configuration_current and status in ('queued','running','paused','ready')`:status==='attention'?needsAttention:sql`true`}),
 page as (
  select j.*,
    (select count(*)::int from ai_job_input_members m where m.job_id=j.id) raw_count,
    (select count(*)::int from ai_job_inputs i where i.job_id=j.id) unique_count,
    (select count(*)::int from ai_job_input_members m where m.job_id=j.id and m.status not in ('queued','processing')) member_processed
  from (select * from filtered ${pageFirst ? sql`` : pageWindow}) j
 )
 select coalesce((select jsonb_agg(jsonb_build_object('id',id::text,'status',status,'phase',phase,'total',raw_count,'processed',member_processed,'remaining',current_pending,'unclassified',current_attention,'model',model,'jobType',job_type,'parentIdentityJobId',parent_identity_job_id::text,'retryOfJobId',retry_of_job_id::text,'sourceFetchRunId',source_fetch_run_id::text,'scopeShopId',scope_shop_id::text,'shopName',shop_name,'uniqueInputCount',unique_count,'pipelineVersions',pipeline_versions,'configurationCurrent',configuration_current,'inputBytes',input_bytes::text,'estimatedTokens',estimated_tokens::text,'createdAt',created_at,'finishedAt',finished_at) order by id desc) from page),'[]'::jsonb) items,
 ${input.totalOnly ? sql`(select jsonb_build_object('total',count(*)) from ${pageFirst ? sql`scoped_ids` : sql`filtered`})` : sql`(select jsonb_build_object('total',count(*),'unfinished',count(*) filter(where status in ('queued','running','paused','ready')),'queued',count(*) filter(where status='queued'),'running',count(*) filter(where status='running'),'paused',count(*) filter(where status in ('paused','ready')),'attention',count(*) filter(where ${needsAttention}),'pendingProducts',${status==='unfinished'?sql`coalesce(sum(current_pending),0)`:sql`(select count(*) from eligible_products p
   where not p.features_current and not exists(select 1 from current_members m where m.product_id=p.id and (
     (m.outcome in ('updated','unchanged','empty','review'))
     or (m.job_status in ('queued','running','paused','ready') and m.status in ('queued','processing') and m.execution_current)
     ${input.jobType === 'text_review' ? sql`` : sql`or m.reason='request_outcome_unknown'`})))`},'pendingEvents',0,'currentReasons',(select coalesce(jsonb_object_agg(reason,n),'{}'::jsonb) from (select m.reason,count(*)::int n from current_members m where m.job_id in(select id from filtered)
       and ((m.status not in ('queued','processing') and (m.output_missing or m.outcome in ('review','partial_success','failed','skipped','cancelled') or m.has_rejected))
         ${input.jobType === 'text_review' ? sql`` : sql`or m.reason='request_outcome_unknown'`}) group by m.reason) reasons),
 'coveredProducts',coalesce(sum(covered_products),0),
 'reviewProducts',coalesce(sum(review_products),0),
 'failedProducts',coalesce(sum(failed_products),0)) from filtered)`} summary
 `.execute(db);
 const row=result.rows[0]!;
 const paged=buildCursorPage(row.items.map(i=>({...i,id:BigInt(String(i.id))})),page.limit);
 return {items:paged.items.map(i=>({...i,id:String(i.id)})),nextCursor:paged.nextCursor??null,summary:row.summary};
}

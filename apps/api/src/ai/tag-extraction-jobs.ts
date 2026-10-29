import { createHash } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DomainConflictError, DomainNotFoundError, DomainValidationError } from '../common/errors.js';
import { jsonb, type DatabaseSchema, type JsonValue } from '../database/types.js';
import { readAiBatchLimits } from '../config/env.js';
import { buildExtractionPayload, estimateInputSize, extractionPayloadKey } from './adaptive-batching.js';
import { planBulkStandardizationBatches, planIndependentStandardizationBatches } from './standardization-batch-planner.js';
import { currentManualDecision } from './ai-retry-pool.js';
import { PIPELINE_VERSIONS, pipelineVersionSnapshot } from './pipeline-versions.js';
import { STANDARDIZATION_PROMPT_VERSION } from './standardization-request.js';
import { IDENTITY_POLICY_VERSION } from '../standardization/identity-policy.js';
import { readAiConcurrency } from './ai-concurrency.js';
import { incrementJobProgress } from './ai-progress.repository.js';
import { buildTagExtractionOutcome, tagExtractionVersions } from './tag-extraction-result.js';
import { readTextEvidence } from '../shops/shop-text-review.js';

type Db = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;
export interface TagJobScope { allPending?: boolean; productIds?: readonly bigint[]; scopeShopId?: bigint; retryOfJobId?: bigint }
export interface TagJobRequest extends TagJobScope { model: string; requestId: string; previewDigest?: string }
const MAX_SCOPE = 500;
export function currentTagMemberSource(member: 'm' | 'newer') {
  const payload = sql.ref(`${member}.payload`);
  // Only legacy tag-only payloads without a source binding retain source-independent coverage.
  return sql<boolean>`(${payload}->'shopSource'=jsonb_build_object('url',s.url,'protocol',s.protocol,'platform',s.platform)
    or (not (${payload} ? 'shopSource') and coalesce(${payload}->'shopText','null'::jsonb)='null'::jsonb))`;
}
function canonicalScope(input: TagJobScope) {
  if ((input.allPending !== undefined && input.allPending !== true) || Number(input.productIds !== undefined) + Number(input.scopeShopId !== undefined) + Number(input.allPending === true) !== 1 || (input.allPending && input.retryOfJobId !== undefined)) throw new DomainValidationError('AI_TAG_SCOPE_REQUIRED', '请选择全部未完成、商品或店铺范围');
  if (input.productIds && (!input.productIds.length || input.productIds.length > MAX_SCOPE || new Set(input.productIds.map(String)).size !== input.productIds.length || input.productIds.some(id => id <= 0n))) throw new DomainValidationError('AI_TAG_SCOPE_INVALID', '商品范围必须是 1 到 500 个不同的正整数');
  if (input.scopeShopId !== undefined && input.scopeShopId <= 0n) throw new DomainValidationError('AI_TAG_SCOPE_INVALID', '店铺 ID 无效');
  return { ...(input.allPending ? { allPending: true } : {}), productIds: input.productIds?.map(String).sort((a,b)=>BigInt(a)<BigInt(b)?-1:1) ?? null, scopeShopId: input.scopeShopId?.toString() ?? null, retryOfJobId: input.retryOfJobId?.toString() ?? null };
}
async function selection(db: Db, input: TagJobScope, lock = false) {
  const scope = canonicalScope(input);
  if(input.retryOfJobId!==undefined && !input.productIds) throw new DomainValidationError('AI_TAG_RETRY_SCOPE_INVALID','重试必须明确选择商品');
  let query = db.selectFrom('products as p').innerJoin('shops as s','s.id','p.shop_id')
    .leftJoin('standard_product_members as assignment','assignment.product_id','p.id')
    .leftJoin('standard_products as standard','standard.id','assignment.standard_product_id')
    .select(['p.id','p.name','p.spec','p.source_category','p.source_data','p.content_version','p.content_fingerprint','p.standardization_revision','p.standardization_locked','p.deleted_at','s.enabled','s.deleted_at as shop_deleted_at'])
    .select(['assignment.standard_product_id', 's.url as shop_url', 's.protocol as shop_protocol', 's.platform as shop_platform'])
    .select(currentManualDecision.as('manual'))
    .select(sql<boolean>`coalesce(assignment.assignment_source='ai' and assignment.publication_state='published' and standard.verification_state='verified' and standard.merged_into_id is null,false)`.as('published'))
    .select(sql<boolean>`coalesce(assignment.assignment_source='human',false)`.as('human'))
    .orderBy('p.id');
  if (input.productIds) query = query.where('p.id','in',input.productIds);
  else if (input.scopeShopId !== undefined) query = query.where('p.shop_id','=',input.scopeShopId);
  if (input.allPending) {
    query = query.where('p.deleted_at','is',null).where('s.deleted_at','is',null).where('s.enabled','=',true).where('p.standardization_locked','=',false)
      .where(sql<boolean>`not ${currentManualDecision}`)
      .where('assignment.assignment_source','=','ai').where('assignment.publication_state','=','published')
      .where('standard.verification_state','=','verified').where('standard.merged_into_id','is',null)
      .where(sql<boolean>`not coalesce((
        select (m.output->>'outcome' in ('updated','unchanged','empty','review'))
          or (j.status in ('queued','running','paused','ready') and m.status in ('queued','processing'))
        from ai_job_input_members m join ai_jobs j on j.id=m.job_id
        where m.product_id=p.id and j.job_type='tag_extraction'
          and m.content_version=p.content_version and m.standardization_revision=p.standardization_revision and m.fingerprint=p.content_fingerprint
          and ${currentTagMemberSource('m')}
          and j.prompt_version=${STANDARDIZATION_PROMPT_VERSION} and j.rule_version=${IDENTITY_POLICY_VERSION} and j.pipeline_versions @> ${jsonb(PIPELINE_VERSIONS)}
        order by j.id desc limit 1
      ),false)`);
  } else query = query.limit(MAX_SCOPE + 1);
  if (lock) query = query.forUpdate('p');
  const products = await query.execute();
  if (!input.allPending && products.length > MAX_SCOPE) throw new DomainValidationError('AI_TAG_SCOPE_TOO_LARGE','店铺范围超过 500 个商品，请选择全部未完成范围');
  if (input.retryOfJobId !== undefined) {
    const source = await db.selectFrom('ai_jobs').select(['id','job_type','parent_identity_job_id']).where('id','=',input.retryOfJobId).executeTakeFirst();
    if (!source || source.job_type !== 'tag_extraction') throw new DomainValidationError('AI_TAG_RETRY_SOURCE_INVALID','重试来源必须是标签任务');
    if (products.length !== input.productIds!.length) throw new DomainValidationError('AI_TAG_RETRY_SCOPE_INVALID','重试商品不存在，请重新选择');
    const members = await db.selectFrom('ai_job_input_members').select('product_id').where('job_id','=',source.id).where('product_id','in',input.productIds!).execute();
    const allowed = new Set(members.map(m=>String(m.product_id)));
    if (products.some(p=>!allowed.has(String(p.id))) || scope.productIds?.some(id=>!allowed.has(id))) throw new DomainValidationError('AI_TAG_RETRY_SCOPE_INVALID','重试范围必须属于来源标签任务');
  }
  const sized = products.map(product => {
    const payload = buildExtractionPayload({id:String(product.id),name:product.name,spec:product.spec,category:product.source_category,sourceData:product.source_data});
    payload.shopSource = { url: product.shop_url, protocol: product.shop_protocol, platform: product.shop_platform };
    const fingerprint = product.content_fingerprint;
    const payloadKey = extractionPayloadKey(payload);
    const text = readTextEvidence(payload);
    const inputKey = JSON.stringify([fingerprint,payloadKey,text ? [text.name,text.description,text.hash] : null]);
    return {product,payload,fingerprint,payloadKey,inputKey,...estimateInputSize(payload), protected: !!(product.deleted_at || product.shop_deleted_at || !product.enabled || product.standardization_locked || product.manual || product.human || !product.published)};
  });
  return {scope,sized};
}
function plan(sized: Awaited<ReturnType<typeof selection>>['sized']) {
  const representatives = new Map<string, typeof sized[number]>();
  for (const item of sized) if (!item.protected && !representatives.has(item.inputKey)) representatives.set(item.inputKey,item);
  const inputs=[...representatives.values()].map(item=>({productId:item.product.id,standardProductId:item.product.standard_product_id!,payload:item.payload,inputBytes:item.inputBytes,estimatedTokens:item.estimatedTokens}));
  // shortcut: bulk scopes use published identities instead of fuzzy similarity above 1,000 inputs; refine only if refusal isolation needs it.
  const batches = inputs.length > 1_000
    ? planBulkStandardizationBatches(inputs,readAiBatchLimits())
    : planIndependentStandardizationBatches(inputs,readAiBatchLimits());
  const planned = new Set(batches.flatMap(b=>b.productIds.map(String)));
  return {representatives,batches,planned};
}
async function preview(db: Db,input: TagJobScope & {model:string},lock=false) {
  if (input.allPending) throw new DomainValidationError('AI_TAG_PREVIEW_SCOPE_INVALID','预览仅支持最多 500 个商品或单个店铺；全部未完成任务请直接创建');
  const {scope,sized}=await selection(db,input,lock);
  const {representatives,batches,planned}=plan(sized);
  const digest=createHash('sha256').update(JSON.stringify({scope,model:input.model,pipeline:pipelineVersionSnapshot(input.model),limits:readAiBatchLimits(),members:sized.map(i=>({id:String(i.product.id),version:String(i.product.content_version),revision:String(i.product.standardization_revision),fingerprint:i.fingerprint,storedFingerprint:i.product.content_fingerprint,inputKey:i.inputKey,standardProductId:String(i.product.standard_product_id),shopSource:i.payload.shopSource,protected:i.protected}))})).digest('hex');
  return {scope,sized,representatives,batches,planned,digest};
}
export async function previewTagJob(db: Db,input: TagJobScope & {model:string}) {
  const p=await preview(db,input);
  return {previewDigest:p.digest,productIds:p.sized.map(i=>String(i.product.id)),scope:p.scope,model:input.model,pipelineVersions:pipelineVersionSnapshot(input.model),counts:{selected:p.sized.length,missing:(input.productIds?.length ?? p.sized.length)-p.sized.length,protected:p.sized.filter(i=>i.protected).length,eligible:p.sized.filter(i=>!i.protected).length,oversized:p.sized.filter(i=>!i.protected&&!p.planned.has(String(p.representatives.get(i.inputKey)!.product.id))).length,uniqueInputs:p.representatives.size,requestBatches:p.batches.length}};
}
export async function createManualTagJob(db: Kysely<DatabaseSchema>,input:TagJobRequest) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.requestId)) throw new DomainValidationError('AI_TAG_REQUEST_INVALID','requestId 必须是 UUID');
  const scope=canonicalScope(input);
  if (input.allPending) {
    if (input.previewDigest !== undefined) throw new DomainValidationError('AI_TAG_PREVIEW_NOT_ALLOWED','全部未完成任务不接受预览摘要，请直接创建后台任务');
    return enqueueAllPendingTagJob(db,input,scope);
  }
  if (!input.previewDigest || !/^[a-f0-9]{64}$/u.test(input.previewDigest)) throw new DomainValidationError('AI_TAG_PREVIEW_REQUIRED','请先预览任务范围');
  return db.transaction().execute(async tx=>{
    await sql`select pg_advisory_xact_lock(hashtextextended(${input.requestId.toLowerCase()},0))`.execute(tx);
    const alias=await tx.selectFrom('ai_tag_job_requests').select('job_id').where('request_id','=',input.requestId.toLowerCase()).executeTakeFirst();
    if(alias) throw new DomainConflictError('AI_TAG_REQUEST_CONFLICT','该 requestId 已用于其他范围或预览');
    const existing=await tx.selectFrom('ai_jobs').selectAll().where('retry_request_id','=',input.requestId.toLowerCase()).executeTakeFirst();
    const requested={scope,previewDigest:input.previewDigest!};
    if (existing) {
      const saved=existing.requested_scope as typeof requested;
      if (existing.job_type!=='tag_extraction'||JSON.stringify(Object.entries(saved.scope??{}).sort())!==JSON.stringify(Object.entries(scope).sort())||saved.previewDigest!==input.previewDigest) throw new DomainConflictError('AI_TAG_REQUEST_CONFLICT','该 requestId 已用于其他范围或预览');
      return existing;
    }
    const p=await preview(tx,input,true);
    if (p.digest!==input.previewDigest) throw new DomainConflictError('AI_TAG_PREVIEW_STALE','商品范围或版本已变化，请重新预览');
    const source=input.retryOfJobId===undefined?null:await tx.selectFrom('ai_jobs').select('parent_identity_job_id').where('id','=',input.retryOfJobId).executeTakeFirstOrThrow();
    return persistTagJob(tx,{model:input.model,productIds:p.sized.map(i=>i.product.id),scopeShopId:input.scopeShopId,parentIdentityJobId:source?.parent_identity_job_id ?? null,retryOfJobId:input.retryOfJobId,requestId:input.requestId.toLowerCase(),requested},p);
  });
}

async function enqueueAllPendingTagJob(db: Kysely<DatabaseSchema>, input: TagJobRequest, scope: ReturnType<typeof canonicalScope>) {
  return db.transaction().execute(async tx => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${input.requestId.toLowerCase()},0))`.execute(tx);
    await sql`select pg_advisory_xact_lock(hashtextextended('ai-tag-enqueue',0))`.execute(tx);
    const replay=await tx.selectFrom('ai_tag_job_requests as r').innerJoin('ai_jobs as j','j.id','r.job_id').selectAll('j').where('r.request_id','=',input.requestId.toLowerCase()).executeTakeFirst();
    if(replay) return replay;
    const previous=await tx.selectFrom('ai_jobs').selectAll().where('retry_request_id','=',input.requestId.toLowerCase()).executeTakeFirst();
    if (previous) {
      const saved=previous.requested_scope as {scope?:ReturnType<typeof canonicalScope>;previewDigest?:string};
      if (previous.job_type!=='tag_extraction'||JSON.stringify(saved.scope)!==JSON.stringify(scope)||saved.previewDigest!==undefined) throw new DomainConflictError('AI_TAG_REQUEST_CONFLICT','该 requestId 已用于其他范围或预览');
      return previous;
    }
    const active=await tx.selectFrom('ai_jobs').selectAll().where('job_type','=','tag_extraction')
      .where('status','in',['queued','running','paused','ready'])
      .where(sql<boolean>`requested_scope @> '{"scope":{"allPending":true}}'::jsonb`)
      .where('prompt_version','=',STANDARDIZATION_PROMPT_VERSION).where('rule_version','=',IDENTITY_POLICY_VERSION)
      .where(sql<boolean>`pipeline_versions @> ${jsonb(PIPELINE_VERSIONS)}`).orderBy('id','desc').executeTakeFirst();
    if(active) {
      await tx.insertInto('ai_tag_job_requests').values({request_id:input.requestId.toLowerCase(),job_id:active.id}).execute();
      return active;
    }
    const job=await tx.insertInto('ai_jobs').values({job_type:'tag_extraction',status:'queued',phase:'preparing',total:0n,model:input.model,
      prompt_version:STANDARDIZATION_PROMPT_VERSION,rule_version:IDENTITY_POLICY_VERSION,pipeline_versions:jsonb(pipelineVersionSnapshot(input.model)),
      retry_request_id:input.requestId.toLowerCase(),requested_scope:jsonb({scope}),request_window_size:readAiConcurrency()}).returningAll().executeTakeFirstOrThrow();
    await tx.insertInto('ai_job_batches').values({job_id:job.id,batch_index:-1n,product_ids:jsonb([]),product_count:0n,status:'queued',step:'prepare'}).execute();
    await tx.insertInto('ai_tag_job_requests').values({request_id:input.requestId.toLowerCase(),job_id:job.id}).execute();
    await incrementJobProgress(tx,{jobId:job.id});
    return job;
  });
}

/** Durable local work runs under the same worker lease, without reserving a provider request. */
export async function prepareAllPendingTagJob(db: Kysely<DatabaseSchema>, batchId: bigint, claim: {workerId:string;attempt:bigint;token:string}, signal?:AbortSignal) {
  signal?.throwIfAborted();
  await db.transaction().execute(async tx => {
    await sql`select pg_advisory_xact_lock(hashtextextended('ai-tag-all-pending',0))`.execute(tx);
    const located=await tx.selectFrom('ai_job_batches').select('job_id').where('id','=',batchId).executeTakeFirstOrThrow();
    const job=await tx.selectFrom('ai_jobs').selectAll().where('id','=',located.job_id).forNoKeyUpdate().executeTakeFirstOrThrow();
    if(job.status==='cancelled'||job.cancel_requested) return;
    const batch=await tx.selectFrom('ai_job_batches').selectAll().where('id','=',batchId).executeTakeFirstOrThrow();
    if(batch.step==='done') return;
    if(job.job_type!=='tag_extraction'||job.phase!=='preparing'||batch.step!=='prepare'||batch.status!=='running'||batch.claimed_by!==claim.workerId||batch.attempts!==claim.attempt||batch.claim_token!==claim.token) throw new Error('tag preparation claim is stale');
    if(job.status==='paused'||job.pause_requested) {
      const requeued=await tx.updateTable('ai_job_batches').set({status:'queued',claimed_by:null,claim_token:null,lease_until:null,attempts:batch.attempts-1n,available_at:sql`now()`})
        .where('id','=',batchId).where('lease_until','>',sql<Date>`clock_timestamp()`).executeTakeFirst();
      if(requeued.numUpdatedRows!==1n) throw new Error('tag preparation lease expired');
      return;
    }
    const {sized}=await selection(tx,{allPending:true},true);
    signal?.throwIfAborted();
    if(sized.length) await persistTagJob(tx,{model:job.model,productIds:sized.map(i=>i.product.id)}, {sized,...plan(sized)},job.id);
    else await tx.updateTable('ai_jobs').set({status:'succeeded',phase:'completed',finished_at:sql`now()`}).where('id','=',job.id).execute();
    signal?.throwIfAborted();
    const completed=await tx.updateTable('ai_job_batches').set({step:'done',status:'succeeded',claimed_by:null,claim_token:null,lease_until:null,finished_at:sql`now()`})
      .where('id','=',batchId).where('status','=','running').where('claimed_by','=',claim.workerId).where('attempts','=',claim.attempt).where('claim_token','=',claim.token)
      .where('lease_until','>',sql<Date>`clock_timestamp()`).executeTakeFirst();
    if(completed.numUpdatedRows!==1n) throw new Error('tag preparation lease expired');
    await incrementJobProgress(tx,{jobId:job.id});
  });
}
/** Both identity completion and manual submissions freeze members before sharing the same plan. */
type TagJobInput = {model:string;productIds:readonly bigint[];parentIdentityJobId?:bigint|null;scopeShopId?:bigint;retryOfJobId?:bigint;requestId?:string;requested?:JsonValue};
export async function createTagJob(tx:Transaction<DatabaseSchema>,input:TagJobInput) {
  if (!input.productIds.length) throw new DomainNotFoundError('AI_TAG_SCOPE_EMPTY','范围内没有商品');
  // Automatic sources may exceed the manual preview bound; select in bounded pieces.
  const sized: Awaited<ReturnType<typeof selection>>['sized']=[];
  for(let offset=0;offset<input.productIds.length;offset+=MAX_SCOPE) sized.push(...(await selection(tx,{productIds:input.productIds.slice(offset,offset+MAX_SCOPE)},true)).sized);
  return persistTagJob(tx,input,{sized,...plan(sized)});
}
async function persistTagJob(tx:Transaction<DatabaseSchema>,input:TagJobInput,{sized,representatives,batches,planned}:{sized:Awaited<ReturnType<typeof selection>>['sized']} & ReturnType<typeof plan>, existingJobId?:bigint) {
  const active=sized.filter(i=>!i.protected);
  if (!active.length) throw new DomainNotFoundError('AI_TAG_SCOPE_EMPTY','范围内没有可抽取商品');
  const values={status:batches.length?'queued' as const:'ready_with_errors' as const,phase:batches.length?'standardizing':'completed',total:BigInt(active.length),input_bytes:BigInt([...representatives.values()].reduce((n,i)=>n+i.inputBytes,0)),estimated_tokens:BigInt([...representatives.values()].reduce((n,i)=>n+i.estimatedTokens,0)),finished_at:batches.length?null:new Date()};
  const job=existingJobId===undefined
    ? await tx.insertInto('ai_jobs').values({...values,job_type:'tag_extraction',model:input.model,prompt_version:STANDARDIZATION_PROMPT_VERSION,rule_version:IDENTITY_POLICY_VERSION,pipeline_versions:jsonb(pipelineVersionSnapshot(input.model)),parent_identity_job_id:input.parentIdentityJobId??null,retry_of_job_id:input.retryOfJobId??null,retry_request_id:input.requestId??null,requested_scope:jsonb(input.requested??{}),scope_shop_id:input.scopeShopId??null,request_window_size:readAiConcurrency()}).returningAll().executeTakeFirstOrThrow()
    : await tx.updateTable('ai_jobs').set(values).where('id','=',existingJobId).returningAll().executeTakeFirstOrThrow();
  const inputs=[...representatives.values()];
  for(let offset=0;offset<inputs.length;offset+=MAX_SCOPE) await tx.insertInto('ai_job_inputs').values(inputs.slice(offset,offset+MAX_SCOPE).map(item=>{
    const oversized=!planned.has(String(item.product.id));
    return {job_id:job.id,input_id:item.product.id,payload:jsonb(item.payload),fingerprint:item.fingerprint,content_version:item.product.content_version,input_bytes:BigInt(item.inputBytes),estimated_tokens:BigInt(item.estimatedTokens),status:oversized?'failed':'queued',reason_code:oversized?'input_too_large':null,error:oversized?'input_too_large':null};
  })).execute();
  for(let offset=0;offset<active.length;offset+=MAX_SCOPE) await tx.insertInto('ai_job_input_members').values(active.slice(offset,offset+MAX_SCOPE).map(item=>{
    const inputId=representatives.get(item.inputKey)!.product.id, oversized=!planned.has(String(inputId));
    const member={content_version:item.product.content_version,fingerprint:item.fingerprint,standardization_revision:item.product.standardization_revision};
    return {job_id:job.id,input_id:inputId,product_id:item.product.id,...member,payload:jsonb(item.payload),status:oversized?'unclassified':'queued',retry_source_job_id:input.retryOfJobId??null,reason_code:oversized?'input_too_large':null,output:oversized?jsonb({...buildTagExtractionOutcome({productId:inputId,tags:[],rejectedTags:[]},[],{outcome:'failed',reasonCode:'input_too_large'}),versions:tagExtractionVersions(member,job.pipeline_versions)} as unknown as JsonValue):null};
  })).execute();
  const memberCounts=new Map<bigint,number>();
  for(const item of active) {
    const id=representatives.get(item.inputKey)!.product.id;
    memberCounts.set(id,(memberCounts.get(id)??0)+1);
  }
  for(let offset=0;offset<batches.length;offset+=MAX_SCOPE) await tx.insertInto('ai_job_batches').values(batches.slice(offset,offset+MAX_SCOPE).map((batch,index)=>({
    job_id:job.id,batch_index:BigInt(offset+index),product_ids:jsonb(batch.productIds.map(String)),product_count:BigInt(batch.productIds.reduce((count,id)=>count+memberCounts.get(id)!,0)),
    input_bytes:BigInt(batch.inputBytes),estimated_tokens:BigInt(batch.estimatedTokens),status:'queued' as const,round:0,step:'request' as const,request_budget_limit:2,
  }))).execute();
  await incrementJobProgress(tx,{jobId:job.id});
  return job;
}

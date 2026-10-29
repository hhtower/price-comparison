import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { migrateToLatest } from '../scripts/migrate.js';
import { AiRepository } from '../src/ai/ai.repository.js';
import type { DatabaseSchema } from '../src/database/types.js';
import { jsonb } from '../src/database/types.js';
import { productContentFingerprint } from '../src/standardization/fingerprint.js';
import { pipelineVersionSnapshot } from '../src/ai/pipeline-versions.js';
import { STANDARDIZATION_PROMPT_VERSION } from '../src/ai/standardization-request.js';
import { IDENTITY_POLICY_VERSION } from '../src/standardization/identity-policy.js';
import { createManualTagJob, previewTagJob, createTagJob, prepareAllPendingTagJob } from '../src/ai/tag-extraction-jobs.js';
import { readAiTaskQueue } from '../src/ai/ai-task-queue.js';
import { getJobProgress } from '../src/ai/ai-progress.repository.js';
import { randomUUID } from 'node:crypto';
import { JobsRepository } from '../src/jobs/jobs.repository.js';
import { createAiWorker, createOpenAiModelCall } from '../src/ai/ai.worker.js';

let db: Kysely<DatabaseSchema>, admin: Pool, schema: string;
let capturedQueries:string[]|undefined;
before(async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required');
  schema = `tag_audit_${Date.now()}_${Math.floor(Math.random()*1000000)}`;
  admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path="${schema}",public` }) }), log(event){if(event.level==='query')capturedQueries?.push(event.query.sql);} });
  process.env.PG_SCHEMA = schema;
  await migrateToLatest(db);
});
after(async () => { await db?.destroy(); if (schema) await admin.query(`drop schema "${schema}" cascade`); await admin?.end(); delete process.env.PG_SCHEMA; });
async function fixture(count = 1) {
  const shop = await db.insertInto('shops').values({ platform: 'test', name: 'test', url: `https://test.invalid/${Math.random()}`, enabled: true }).returning('id').executeTakeFirstOrThrow();
  const payload = { name: 'ChatGPT Plus 成品账号', spec: '1个月', sourceData: {} };
  const fingerprint = productContentFingerprint({ ...payload, sourceCategory: '' });
  const products = [];
  for (let offset=0;offset<count;offset+=500) products.push(...await db.insertInto('products').values(Array.from({length:Math.min(500,count-offset)},(_,i)=>({ shop_id: shop.id, external_id: String(offset+i), name: payload.name, spec: payload.spec, source_category: '', source_data: jsonb({}), normalized_key: `tag-${Math.random()}`, url: 'https://test.invalid/p', content_version: 1n, content_fingerprint: fingerprint }))).returningAll().execute());
  const job = await db.insertInto('ai_jobs').values({ total: BigInt(count), model: 'mock', job_type: 'tag_extraction', status: 'running', phase: 'standardizing', prompt_version: STANDARDIZATION_PROMPT_VERSION, rule_version: IDENTITY_POLICY_VERSION, pipeline_versions: jsonb(pipelineVersionSnapshot('mock')) }).returningAll().executeTakeFirstOrThrow();
  const inputId = products[0]!.id;
  await db.insertInto('ai_job_inputs').values({ job_id: job.id, input_id: inputId, fingerprint, payload: jsonb(payload), content_version: 1n, input_bytes: 100n, estimated_tokens: 100n }).execute();
  for (let offset=0;offset<products.length;offset+=500) await db.insertInto('ai_job_input_members').values(products.slice(offset,offset+500).map(p=>({ job_id: job.id, input_id: inputId, product_id: p.id, fingerprint, payload: jsonb(payload), content_version: 1n, standardization_revision: p.standardization_revision }))).execute();
  const batch = await db.insertInto('ai_job_batches').values({ job_id: job.id, batch_index: 0n, product_ids: jsonb([String(inputId)]), product_count: BigInt(count), status: 'running', claimed_by: 'test', claim_token: 'claim', attempts: 1n, lease_until: new Date(Date.now()+60000), step: 'request', request_budget_limit: 2 }).returningAll().executeTakeFirstOrThrow();
  const standard = await db.insertInto('standard_products').values({ canonical_family: 'openai', canonical_product: 'chatgpt', canonical_tier: 'plus', name: 'test', verification_state:'verified' }).returning('id').executeTakeFirstOrThrow();
  for (let offset=0;offset<products.length;offset+=500) await db.insertInto('standard_product_members').values(products.slice(offset,offset+500).map(p=>({ product_id: p.id, standard_product_id: standard.id, assignment_source: 'ai', publication_state: 'published' }))).execute();
  return { repo: new AiRepository(db), job, batch, products, inputId, payload };
}
async function preparePending(jobId: bigint) {
 await db.updateTable('ai_jobs').set({priority:999999}).where('id','=',jobId).execute();
 const claim=(await new JobsRepository(db).claimNext('ai_batch','tag-scope-preparation',120000))!;
 assert.equal(claim.row.job_id,jobId);
 assert.equal(claim.row.step,'prepare');
 await prepareAllPendingTagJob(db,claim.id,{workerId:claim.claimed_by,attempt:claim.attempts,token:String(claim.row.claim_token)});
 return db.selectFrom('ai_jobs').selectAll().where('id','=',jobId).executeTakeFirstOrThrow();
}
async function completeTagJob(jobId: bigint) {
 await db.updateTable('ai_job_input_members').set({status:'classified',output:jsonb({outcome:'empty',rejectedTags:[]})}).where('job_id','=',jobId).execute();
 await db.updateTable('ai_jobs').set({status:'succeeded',phase:'completed'}).where('id','=',jobId).execute();
}

test('standardization status excludes a newer disabled tag job', async () => {
 const previous = process.env.AI_TAG_EXTRACTION_ENABLED;
 try {
  process.env.AI_TAG_EXTRACTION_ENABLED = 'false';
  const f = await fixture();
  const identity = await db.insertInto('ai_jobs').values({ model: 'mock', total: 0n, status: 'succeeded', job_type: 'manual_full' }).returning('id').executeTakeFirstOrThrow();
  const tag = await db.transaction().execute(tx => createTagJob(tx, { productIds: [f.inputId], model: 'mock' }));
  assert.ok(tag.id > identity.id);
  const status = await f.repo.adminStatus();
  assert.equal(status.job?.id, identity.id);
  assert.equal(status.tagExtractionEnabled, false);
 } finally {
  if (previous === undefined) delete process.env.AI_TAG_EXTRACTION_ENABLED;
  else process.env.AI_TAG_EXTRACTION_ENABLED = previous;
 }
});

test('API rejects all-pending preview and digest creation before any database access', async () => {
 const f=await fixture();
 capturedQueries=[];
 try {
  await assert.rejects(previewTagJob(db,{allPending:true,model:'mock'}),{code:'AI_TAG_PREVIEW_SCOPE_INVALID'});
  await assert.rejects(createManualTagJob(db,{allPending:true,model:'mock',requestId:randomUUID(),previewDigest:'a'.repeat(64)}),{code:'AI_TAG_PREVIEW_NOT_ALLOWED'});
  assert.deepEqual(capturedQueries,[]);
 } finally { capturedQueries=undefined; }
 assert.equal((await db.selectFrom('ai_job_input_members').select('product_id').where('job_id','=',f.job.id).execute()).length,1);
});

test('missing retry IDs never load the source job member list', async () => {
 const f=await fixture(501);
 for (const productIds of [[999999999n],[f.inputId,999999999n]]) {
  capturedQueries=[];
  try {
   await assert.rejects(previewTagJob(db,{productIds,retryOfJobId:f.job.id,model:'mock'}),{code:'AI_TAG_RETRY_SCOPE_INVALID'});
   assert.ok(capturedQueries.every(query=>!query.includes('from "ai_job_input_members"')));
  } finally { capturedQueries=undefined; }
 }
 const valid=await previewTagJob(db,{productIds:[f.inputId],retryOfJobId:f.job.id,model:'mock'});
 assert.deepEqual(valid.productIds,[String(f.inputId)]);
 assert.equal(valid.counts.eligible,1);
});

test('bounded previews accept 500 explicit or shop products and reject expansion to 501', async () => {
 const f=await fixture(500);
 const ids=f.products.map(product=>product.id);
 const shopId=f.products[0]!.shop_id;
 const explicit=await previewTagJob(db,{productIds:ids,model:'mock'});
 const shop=await previewTagJob(db,{scopeShopId:shopId,model:'mock'});
 assert.equal(explicit.counts.selected,500);
 assert.deepEqual(shop.productIds,explicit.productIds);
 await db.insertInto('products').values({shop_id:shopId,external_id:'extra',name:'extra',spec:'',normalized_key:'extra',url:'https://test.invalid/extra'}).execute();
 await assert.rejects(previewTagJob(db,{scopeShopId:shopId,model:'mock'}),{code:'AI_TAG_SCOPE_TOO_LARGE'});
 capturedQueries=[];
 try {
  await assert.rejects(previewTagJob(db,{productIds:[...ids,999999999n],model:'mock'}),{code:'AI_TAG_SCOPE_INVALID'});
  assert.deepEqual(capturedQueries,[]);
 } finally {capturedQueries=undefined;}
});

test('all-pending scope creates 9001 products in one job and prevents repeated or concurrent bulk submission', async () => {
 const f = await fixture(9001);
 await db.updateTable('ai_jobs').set({ status: 'cancelled' }).where('id', '=', f.job.id).execute();
 const scope = { allPending: true, model: 'mock' };
 const input = { ...scope, requestId: randomUUID() };
 const [created,duplicate] = await Promise.all([createManualTagJob(db,input),createManualTagJob(db,{...input,requestId:randomUUID()})]);
 assert.equal(duplicate.id,created.id);
 assert.equal(created.phase,'preparing');
 assert.equal(created.total,0n);
 assert.equal((await preparePending(created.id)).total,9001n);
 const members = await db.selectFrom('ai_job_input_members').select('product_id').where('job_id', '=', created.id).execute();
 assert.equal(new Set(members.map(m => String(m.product_id))).size, 9001);
 assert.equal((await db.selectFrom('ai_job_inputs').select('input_id').where('job_id','=',created.id).execute()).length,1);
 assert.equal((await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', created.id).where('batch_index','>=',0n).execute()).length, 1);
 assert.equal((await getJobProgress(db,created.id))!.requests.budgetUsed,0);
 assert.equal((await createManualTagJob(db, { ...input, requestId: created.retry_request_id! })).id, created.id);
 await completeTagJob(created.id);
 const empty=await createManualTagJob(db,{...scope,requestId:randomUUID()});
 const completed=await preparePending(empty.id);
 assert.equal(completed.total,0n);
 assert.equal(completed.status,'succeeded');
});

test('background bulk preparation plans unique inputs within published identity boundaries', async () => {
 const f = await fixture(1002);
 await db.updateTable('ai_jobs').set({status:'cancelled'}).where('id','=',f.job.id).execute();
 const values=f.products.map((p,index)=>{
  const spec=`套餐 ${index}`;
  return sql`(${p.id}::bigint,${spec})`;
 });
 await sql`update products p set spec=v.spec from (values ${sql.join(values)}) v(id,spec) where p.id=v.id`.execute(db);
 const other=await db.insertInto('standard_products').values({canonical_family:'steam',canonical_product:'wallet',canonical_tier:'standard',name:'另一商品',verification_state:'verified'}).returning('id').executeTakeFirstOrThrow();
 const separate=f.products.at(-1)!.id;
 await db.updateTable('standard_product_members').set({standard_product_id:other.id}).where('product_id','=',separate).execute();
 const job=await createManualTagJob(db,{allPending:true,model:'mock',requestId:randomUUID()});
 await preparePending(job.id);
 assert.equal((await db.selectFrom('ai_job_inputs').select('input_id').where('job_id','=',job.id).execute()).length,1002);
 const batches=await db.selectFrom('ai_job_batches').select('product_ids').where('job_id','=',job.id).where('batch_index','>=',0n).execute();
 assert.ok(batches.length<1002);
 assert.equal(batches.flatMap(b=>b.product_ids as string[]).length,1002);
 assert.deepEqual(batches.find(b=>(b.product_ids as string[]).includes(String(separate)))!.product_ids,[String(separate)]);
 const before=await previewTagJob(db,{productIds:[separate],model:'mock'});
 const standardId=(await db.selectFrom('standard_product_members').select('standard_product_id').where('product_id','=',f.inputId).executeTakeFirstOrThrow()).standard_product_id;
 await db.updateTable('standard_product_members').set({standard_product_id:standardId}).where('product_id','=',separate).execute();
 await assert.rejects(createManualTagJob(db,{productIds:[separate],model:'mock',requestId:randomUUID(),previewDigest:before.previewDigest}),{code:'AI_TAG_PREVIEW_STALE'});
 await completeTagJob(job.id);
});

test('all-pending and tag queue pending counts use the latest current audited outcomes', async () => {
 const f = await fixture(25);
 const ids = f.products.map(p => p.id);
 const success = { outcome: 'updated', rejectedTags: [] };
 await db.updateTable('ai_jobs').set({ status: 'succeeded' }).where('id', '=', f.job.id).execute();
 await db.updateTable('ai_job_input_members').set({ status: 'classified', output: jsonb(success) }).where('job_id', '=', f.job.id).execute();
 for (const [index, outcome] of [[1, 'empty'], [2, 'review'], [3, 'failed'], [4, 'cancelled']] as const) await db.updateTable('ai_job_input_members').set({ output: jsonb({ ...success, outcome }) }).where('job_id', '=', f.job.id).where('product_id', '=', ids[index]!).execute();
 await db.transaction().execute(tx => createTagJob(tx, { productIds: [ids[5]!], model: 'mock' }));
 await db.updateTable('ai_job_input_members').set({ content_version: 0n }).where('job_id', '=', f.job.id).where('product_id', '=', ids[6]!).execute();
 await db.updateTable('ai_job_input_members').set({ output: null }).where('job_id', '=', f.job.id).where('product_id', '=', ids[7]!).execute();
 await db.updateTable('products').set({ standardization_locked: true }).where('id', '=', ids[8]!).execute();
 await db.deleteFrom('standard_product_members').where('product_id', '=', ids[9]!).execute();
 const old = await db.transaction().execute(tx => createTagJob(tx, { productIds: [ids[10]!], model: 'mock' }));
 await db.updateTable('ai_jobs').set({ prompt_version: 'old' }).where('id', 'in', [old.id, f.job.id]).execute();
 // Keep the original job current, except the newer obsolete task for product 10.
 await db.updateTable('ai_jobs').set({ prompt_version: STANDARDIZATION_PROMPT_VERSION }).where('id', '=', f.job.id).execute();
 await db.updateTable('ai_job_input_members').set({ output: null }).where('job_id', '=', f.job.id).where('product_id', '=', ids[10]!).execute();
 await db.updateTable('products').set({ standardization_revision: f.products[11]!.standardization_revision + 1n }).where('id', '=', ids[11]!).execute();
 await db.updateTable('ai_job_input_members').set({ output: jsonb({ ...success, outcome: 'unchanged' }) }).where('job_id', '=', f.job.id).where('product_id', '=', ids[12]!).execute();
 await db.updateTable('ai_job_input_members').set({ output: jsonb({ ...success, rejectedTags: [{ reason: 'attribute_conflict' }] }) }).where('job_id', '=', f.job.id).where('product_id', '=', ids[13]!).execute();
 await db.updateTable('ai_job_input_members').set({ fingerprint: 'stale' }).where('job_id', '=', f.job.id).where('product_id', '=', ids[14]!).execute();
 for (const index of [15, 16, 17, 18, 19, 20, 22, 23]) {
   const newer = await db.transaction().execute(tx => createTagJob(tx, { productIds: [ids[index]!], model: 'mock' }));
   if (index === 15) await db.updateTable('ai_jobs').set({ status: 'cancelled' }).where('id', '=', newer.id).execute();
   if (index === 16) {
     await db.updateTable('ai_jobs').set({ status: 'running' }).where('id', '=', newer.id).execute();
     await db.updateTable('ai_job_input_members').set({ status: 'processing' }).where('job_id', '=', newer.id).execute();
   }
   if ([17, 18, 19, 20].includes(index)) {
     await db.updateTable('ai_jobs').set(index === 17 || index === 20 ? { prompt_version: 'old' } : index === 18 ? { rule_version: 'old' } : { pipeline_versions: jsonb({ tagPrompt: 'old' }) }).where('id', '=', newer.id).execute();
     await db.updateTable('ai_job_input_members').set({ status: 'classified', output: jsonb({ ...success, outcome: index === 20 ? 'failed' : 'updated' }) }).where('job_id', '=', newer.id).execute();
     if (index !== 20) await db.deleteFrom('ai_job_input_members').where('job_id', '=', f.job.id).where('product_id', '=', ids[index]!).execute();
   }
   if (index === 22 || index === 23) {
     await db.updateTable('ai_jobs').set({ status: 'succeeded' }).where('id', '=', newer.id).execute();
     await db.updateTable('ai_job_input_members').set({ status: 'classified', output: jsonb({ ...success, outcome: index === 22 ? 'failed' : 'updated' }) }).where('job_id', '=', newer.id).execute();
     if (index === 23) await db.updateTable('ai_job_input_members').set({ output: jsonb({ ...success, outcome: 'failed' }) }).where('job_id', '=', f.job.id).where('product_id', '=', ids[index]!).execute();
   }
 }
 await db.deleteFrom('ai_job_input_members').where('job_id', '=', f.job.id).where('product_id', 'in', [ids[21]!, ids[24]!]).execute();
 await db.insertInto('product_tags').values({ product_id: ids[21]!, name: 'warranty', value: 'covered' }).execute();
 for (const status of ['unfinished', 'attention', 'all']) {
   const queue = await readAiTaskQueue(db, { jobType: 'tag_extraction', scopeShopId: f.products[0]!.shop_id, status, limit: 1 });
   assert.equal(queue.summary.pendingProducts, 14, status);
   if (queue.nextCursor) {
     const next = await readAiTaskQueue(db, { jobType: 'tag_extraction', scopeShopId: f.products[0]!.shop_id, status, limit: 1, cursor: queue.nextCursor });
     assert.deepEqual(next.summary, queue.summary);
   }
 }
 const retry = await previewTagJob(db, { productIds: [ids[2]!, ids[13]!], retryOfJobId: f.job.id, model: 'mock' });
 assert.deepEqual(retry.productIds, [String(ids[2]), String(ids[13])]);
 assert.equal(retry.counts.eligible, 2);
 for (const extra of [{ productIds: [ids[0]!] }, { scopeShopId: f.products[0]!.shop_id }, { retryOfJobId: f.job.id }]) await assert.rejects(createManualTagJob(db, { allPending: true, model: 'mock',requestId:randomUUID(), ...extra }), { code: 'AI_TAG_SCOPE_REQUIRED' });
 const pending=await createManualTagJob(db,{allPending:true,model:'mock',requestId:randomUUID()});
 await preparePending(pending.id);
 const members=await db.selectFrom('ai_job_input_members').select('product_id').where('job_id','=',pending.id).orderBy('product_id').execute();
 assert.deepEqual(members.map(member=>String(member.product_id)),[3,4,6,7,10,11,14,15,17,18,19,21,22,24].map(i=>String(ids[i])));
 await f.repo.cancelJob(pending.id);
});


test('claimed tag batches keep their type and use the streaming tag protocol', async () => {
 const f = await fixture();
 const job = await db.transaction().execute(tx => createTagJob(tx, { productIds: [f.inputId], model: 'mock' }));
 await db.updateTable('ai_jobs').set({ priority: 9999 }).where('id', '=', job.id).execute();
 const claimed = await new JobsRepository(db).claimNext('ai_batch', 'tag-route', 60000);
 assert.equal(claimed?.row.job_id, job.id);
 assert.equal(claimed?.row.job_type, 'tag_extraction');
 const call = createOpenAiModelCall(f.repo, { AI_BASE_URL: 'https://mock.invalid/v1', AI_API_KEY: 'mock', AI_MODEL: 'mock' }, async (_url, init) => {
   const sent = JSON.parse(String(init?.body));
   assert.equal(sent.stream, true);
   assert.match(sent.messages[0].content, /extract buyer-facing product tags/);
   const content = JSON.stringify({ items: [{ id: String(f.inputId), tags: [] }] });
   return new Response([content.slice(0, 12), content.slice(12)].map((chunk, i) => `data: ${JSON.stringify({ choices: [{ delta: { content: chunk }, finish_reason: i ? 'stop' : null }] })}\n\n`).join('') + 'data: [DONE]\n\n');
 });
 const result = await call(claimed, new AbortController().signal);
 assert.equal(result.tagExtractionItems?.[0]?.productId, f.inputId);
 await db.updateTable('ai_jobs').set({ status: 'cancelled' }).where('id', '=', job.id).execute();
});

test('tag queue retains obsolete history and exposes obsolete active tasks for attention', async () => {
 const f = await fixture();
 const job = await db.transaction().execute(tx => createTagJob(tx, { productIds: [f.inputId], model: 'mock' }));
 const scope = { jobType: 'tag_extraction', scopeShopId: f.products[0]!.shop_id };
 const current = await readAiTaskQueue(db, { ...scope, status: 'unfinished' });
 assert.equal(current.items.find(item => item.id === String(job.id))?.configurationCurrent, true);
 for (const change of [{ pipeline_versions: jsonb({ tagPrompt: 'old' }) },
   { pipeline_versions: jsonb(pipelineVersionSnapshot('mock')), prompt_version: 'old' },
   { prompt_version: STANDARDIZATION_PROMPT_VERSION, rule_version: 'old' }]) {
   await db.updateTable('ai_jobs').set(change).where('id', '=', job.id).execute();
   const attention = await readAiTaskQueue(db, { ...scope, status: 'attention' });
   assert.deepEqual(attention.items.map(item => item.id), [String(job.id)]);
   assert.equal(attention.items[0]!.configurationCurrent, false);
   assert.equal(Number(attention.summary.total), 1);
   assert.equal(Number(attention.summary.attention), 1);
   const unfinished = await readAiTaskQueue(db, { ...scope, status: 'unfinished' });
   assert.deepEqual(unfinished.items.map(item => item.id), [String(f.job.id)]);
   assert.equal(Number(unfinished.summary.total), 1);
   const history = await readAiTaskQueue(db, { ...scope, status: 'all', limit: 1 });
   assert.equal(history.items[0]!.id, String(job.id));
   assert.equal(history.items[0]!.configurationCurrent, false);
   assert.equal(Number(history.summary.total), 2);
   assert.equal(Number(history.summary.attention), 1);
   assert.ok(history.nextCursor);
   const next = await readAiTaskQueue(db, { ...scope, status: 'all', limit: 1, cursor: history.nextCursor });
   assert.deepEqual(next.items.map(item => item.id), [String(f.job.id)]);
   assert.deepEqual(next.summary, history.summary);
 }
 await db.updateTable('ai_jobs').set({ status: 'succeeded' }).where('id', '=', job.id).execute();
 assert.equal((await readAiTaskQueue(db, { ...scope, status: 'attention' })).items.length, 0);
 assert.equal((await readAiTaskQueue(db, { ...scope, status: 'all' })).items.length, 2);
 assert.deepEqual((await f.repo.listTagJobResults({ jobId: job.id, limit: 10 })).items.map(item => item.id), [String(f.inputId)]);
});

test('manual scope deduplicates before planning, freezes all members and serializes exact idempotence',async()=>{
 const f=await fixture(3);const ids=f.products.map(p=>p.id);
 const preview=await previewTagJob(db,{productIds:ids,model:'mock'});
 assert.equal(preview.counts.uniqueInputs,1);assert.equal(preview.counts.eligible,3);
 const input={productIds:ids,model:'mock',requestId:randomUUID(),previewDigest:preview.previewDigest};
 const [a,b]=await Promise.all([createManualTagJob(db,input),createManualTagJob(db,input)]);
 assert.equal(a.id,b.id);assert.equal(a.total,3n);
 const inputs=await db.selectFrom('ai_job_inputs').selectAll().where('job_id','=',a.id).execute(); assert.equal(inputs.length,1);
 const members=await db.selectFrom('ai_job_input_members').selectAll().where('job_id','=',a.id).execute();assert.equal(members.length,3);
 const batches=await db.selectFrom('ai_job_batches').selectAll().where('job_id','=',a.id).execute();assert.equal(batches[0]!.product_count,3n);assert.deepEqual(batches[0]!.product_ids,[String(ids[0])]);
 await assert.rejects(createManualTagJob(db,{...input,productIds:[ids[0]!]}),{code:'AI_TAG_REQUEST_CONFLICT'});
 const p=await getJobProgress(db,a.id);assert.equal(p!.rawProductCount,3);assert.equal(p!.uniqueInputCount,1);assert.equal(p!.queued,'3');
});
test('preview rejects version, protection and shop expansion drift and reports missing/oversized',async()=>{
 const f=await fixture();const id=f.inputId;
 const before=await previewTagJob(db,{productIds:[id],model:'mock'});
 await db.updateTable('products').set({standardization_locked:true}).where('id','=',id).execute();
 await assert.rejects(createManualTagJob(db,{productIds:[id],model:'mock',requestId:randomUUID(),previewDigest:before.previewDigest}),{code:'AI_TAG_PREVIEW_STALE'});
 const protectedPreview=await previewTagJob(db,{productIds:[id,999999999n],model:'mock'});assert.equal(protectedPreview.counts.protected,1);assert.equal(protectedPreview.counts.missing,1);
 await db.updateTable('products').set({standardization_locked:false,name:'x'.repeat(100000)}).where('id','=',id).execute();
 const oversized=await previewTagJob(db,{productIds:[id],model:'mock'});assert.equal(oversized.counts.oversized,1);
 const job=await createManualTagJob(db,{productIds:[id],model:'mock',requestId:randomUUID(),previewDigest:oversized.previewDigest});
 const progress=await getJobProgress(db,job.id);assert.equal(progress!.tagResults!.failed,1);assert.equal(progress!.processed,'1');
});
test('automatic parent provenance and exact selected tag retry do not invoke identity work',async()=>{
 const f=await fixture(2);
 const parent=await db.insertInto('ai_jobs').values({model:'mock',total:2n,status:'succeeded',job_type:'manual_full'}).returning('id').executeTakeFirstOrThrow();
 const auto=await db.transaction().execute(tx=>createTagJob(tx,{productIds:f.products.map(p=>p.id),model:'mock',parentIdentityJobId:parent.id}));
 assert.equal(auto.parent_identity_job_id,parent.id);
 const selected=[f.inputId];const preview=await previewTagJob(db,{productIds:selected,retryOfJobId:auto.id,model:'mock'});
 const retry=await createManualTagJob(db,{productIds:selected,retryOfJobId:auto.id,model:'mock',requestId:randomUUID(),previewDigest:preview.previewDigest});
 assert.equal(retry.job_type,'tag_extraction');assert.equal(retry.retry_of_job_id,auto.id);assert.equal(retry.parent_identity_job_id,parent.id);
 const members=await db.selectFrom('ai_job_input_members').selectAll().where('job_id','=',retry.id).execute();assert.deepEqual(members.map(m=>m.product_id),selected);assert.equal(members[0]!.retry_source_job_id,auto.id);
 await assert.rejects(f.repo.retryJob(auto.id),{code:'AI_TAG_TARGETED_RETRY_REQUIRED'});
 const other=await fixture();await assert.rejects(previewTagJob(db,{productIds:[other.inputId],retryOfJobId:auto.id,model:'mock'}),{code:'AI_TAG_RETRY_SCOPE_INVALID'});
});
test('tag queue current coverage, filtering, audit and cursor pagination',async()=>{
 const f=await fixture(2);const job=await db.transaction().execute(tx=>createTagJob(tx,{productIds:f.products.map(p=>p.id),model:'mock'}));
 const source=await db.selectFrom('shops').select(['url','protocol','platform']).where('id','=',f.products[0]!.shop_id).executeTakeFirstOrThrow();
 await db.updateTable('ai_job_input_members').set({payload:jsonb({...f.payload,shopSource:source})}).where('job_id','=',f.job.id).execute();
 const output={outcome:'updated',acceptedTags:[],rejectedTags:[],diff:[]};
 await db.updateTable('ai_job_input_members').set({status:'classified',output:jsonb(output)}).where('job_id','=',job.id).where('product_id','=',f.inputId).execute();
 await db.updateTable('ai_job_input_members').set({status:'unclassified',output:jsonb({...output,outcome:'failed'})}).where('job_id','=',job.id).where('product_id','=',f.products[1]!.id).execute();
 const queue=await readAiTaskQueue(db,{jobType:'tag_extraction',status:'attention',scopeShopId:f.products[0]!.shop_id,limit:100});
 assert.equal(Number(queue.summary.total),1);assert.equal(queue.items.length,1);assert.equal(queue.summary.coveredProducts,1);assert.equal(queue.summary.failedProducts,1);
 await db.updateTable('ai_job_input_members').set({output:jsonb({...output,rejectedTags:[{reason:'attribute_conflict'}],reasonCode:'attribute_conflict'})}).where('job_id','=',job.id).where('product_id','=',f.inputId).execute();
 const rejection=await readAiTaskQueue(db,{jobType:'tag_extraction',status:'attention',scopeShopId:f.products[0]!.shop_id});
 assert.equal(rejection.summary.reviewProducts,1);assert.equal((rejection.summary.currentReasons as Record<string,number>).attribute_conflict,1);
 const first=await f.repo.listTagJobResults({jobId:job.id,limit:1});assert.equal(first.items.length,1);assert.ok(first.nextCursor);
 const second=await f.repo.listTagJobResults({jobId:job.id,limit:1,cursor:first.nextCursor});assert.equal(second.items.length,1);assert.notEqual(first.items[0]!.id,second.items[0]!.id);
 const audit=await f.repo.tagProductAudit(job.id,f.inputId);assert.equal(audit.member.outcome,'updated');
 const frozen=await db.selectFrom('ai_job_input_members').select('payload').where('job_id','=',job.id).where('product_id','=',f.inputId).executeTakeFirstOrThrow();
 assert.deepEqual(audit.member.payload,frozen.payload);
 await db.updateTable('products').set({content_version:2n}).where('id','=',f.inputId).execute();
 const current=await readAiTaskQueue(db,{jobType:'tag_extraction',status:'all',scopeShopId:f.products[0]!.shop_id,limit:100});assert.equal(current.summary.coveredProducts,0);assert.equal(current.summary.pendingProducts,2);
 const other=await fixture();
 await db.updateTable('products').set({shop_id:other.products[0]!.shop_id}).where('id','=',f.products[1]!.id).execute();
 const scoped=await readAiTaskQueue(db,{jobType:'tag_extraction',status:'attention',scopeShopId:f.products[0]!.shop_id,limit:100});
 assert.equal(scoped.items.length,0);assert.equal(scoped.summary.failedProducts,0);assert.deepEqual(scoped.summary.currentReasons,{});
 await db.deleteFrom('ai_job_input_members').where('product_id','=',other.inputId).execute();
 const neverRun=await readAiTaskQueue(db,{jobType:'tag_extraction',status:'all',scopeShopId:other.products[0]!.shop_id,limit:100});
 assert.equal(neverRun.summary.pendingProducts,2);assert.equal(neverRun.summary.failedProducts,0,'the failure belongs to the previous shop source');
});

test('shop scope is bounded and rejects expansion; model/revision changes invalidate preview',async()=>{
 const f=await fixture();const shopId=f.products[0]!.shop_id;
 const shopPreview=await previewTagJob(db,{scopeShopId:shopId,model:'mock'});
 assert.deepEqual(shopPreview.productIds,[String(f.inputId)]);
 await db.insertInto('products').values({shop_id:shopId,external_id:'extra',name:'extra',spec:'',normalized_key:'extra',url:'https://test.invalid/extra'}).execute();
 await assert.rejects(createManualTagJob(db,{scopeShopId:shopId,model:'mock',requestId:randomUUID(),previewDigest:shopPreview.previewDigest}),{code:'AI_TAG_PREVIEW_STALE'});
 const explicit=await previewTagJob(db,{productIds:[f.inputId],model:'mock'});
 await assert.rejects(createManualTagJob(db,{productIds:[f.inputId],model:'different',requestId:randomUUID(),previewDigest:explicit.previewDigest}),{code:'AI_TAG_PREVIEW_STALE'});
 await db.updateTable('products').set({standardization_revision:f.products[0]!.standardization_revision+1n}).where('id','=',f.inputId).execute();
 await assert.rejects(createManualTagJob(db,{productIds:[f.inputId],model:'mock',requestId:randomUUID(),previewDigest:explicit.previewDigest}),{code:'AI_TAG_PREVIEW_STALE'});
 await assert.rejects(previewTagJob(db,{model:'mock'}),{code:'AI_TAG_SCOPE_REQUIRED'});
 await assert.rejects(previewTagJob(db,{productIds:[f.inputId],scopeShopId:shopId,model:'mock'}),{code:'AI_TAG_SCOPE_REQUIRED'});
});

test('all-pending submits durable preparation without reading evidence or spending an AI request', async () => {
 await db.updateTable('ai_jobs').set({status:'cancelled'}).execute();
 await db.updateTable('shops').set({enabled:false}).execute();
 const f=await fixture(3);
 await db.updateTable('ai_jobs').set({status:'cancelled'}).where('id','=',f.job.id).execute();
 const input={allPending:true,model:'mock',requestId:randomUUID()};
 capturedQueries=[];
 const started=performance.now();
 const job=await createManualTagJob(db,input as never);
 const enqueueQueries=capturedQueries;capturedQueries=undefined;
 console.info(`全量任务入队耗时 ${Math.round(performance.now()-started)} ms`);
 assert.ok(enqueueQueries.every(query=>!query.includes('source_data')&&!query.includes('from "products"')));
 assert.equal(job.phase,'preparing');
 assert.equal(job.total,0n);
 assert.equal((await db.selectFrom('ai_job_inputs').select('input_id').where('job_id','=',job.id).execute()).length,0);
 assert.equal((await createManualTagJob(db,input as never)).id,job.id);
 const duplicate={...input,requestId:randomUUID()};
 assert.equal((await createManualTagJob(db,duplicate)).id,job.id);
 await assert.rejects(createManualTagJob(db,{productIds:[f.inputId],model:'mock',requestId:duplicate.requestId,previewDigest:'a'.repeat(64)}),{code:'AI_TAG_REQUEST_CONFLICT'});
 await f.repo.pauseJob(job.id);
 assert.equal(await new JobsRepository(db).claimNext('ai_batch','paused-preparation',60000),null);
 await f.repo.resumeJob(job.id);
 await db.updateTable('ai_jobs').set({priority:9999}).where('id','=',job.id).execute();
 let modelCalls=0,leases=0;
 let settled!:()=>void;
 const finished=new Promise<void>(resolve=>{settled=resolve;});
 const service=Object.assign(new JobsRepository(db),{onSettled:()=>settled()});
 const worker=createAiWorker(service,{repository:f.repo,concurrency:1,modelCall:async()=>{modelCalls++;throw new Error('must not call model during preparation');},aiStage:'standardization',aiCoordinator:{acquire:async()=>{leases++;throw new Error('must not reserve AI during preparation');}}});
 try { assert.equal(await worker.runOnce(),1);await finished; } finally { await worker.stop(); }
 const prepared=await db.selectFrom('ai_jobs').selectAll().where('id','=',job.id).executeTakeFirstOrThrow();
 assert.equal(prepared.phase,'standardizing');assert.equal(prepared.total,3n);
 assert.equal(modelCalls,0);assert.equal(leases,0);
 const progress=await getJobProgress(db,job.id);
 assert.equal(progress!.requests.totalBatches,1);
 assert.equal(progress!.requests.budgetUsed,0);
 assert.equal((await db.selectFrom('ai_job_input_members').select('product_id').where('job_id','=',job.id).execute()).length,3);
 await f.repo.cancelJob(job.id);
 assert.equal((await createManualTagJob(db,duplicate)).id,job.id);
 const next=await createManualTagJob(db,{...input,requestId:randomUUID()} as never);
 await f.repo.cancelJob(next.id);
 assert.equal(await new JobsRepository(db).claimNext('ai_batch','cancelled-preparation',60000),null);
});

test('pause after a preparation claim preserves the job and local retry budget',async()=>{
 const f=await fixture();
 await f.repo.cancelJob(f.job.id);
 const job=await createManualTagJob(db,{allPending:true,model:'mock',requestId:randomUUID()});
 await db.updateTable('ai_jobs').set({priority:99999}).where('id','=',job.id).execute();
 await db.updateTable('ai_job_batches').set({attempts:3n}).where('job_id','=',job.id).execute();
 const original=f.repo.prepareTagJob.bind(f.repo);
 f.repo.prepareTagJob=async(...args)=>{await f.repo.pauseJob(job.id);return original(...args);};
 let settled!:()=>void;
 const finished=new Promise<void>(resolve=>{settled=resolve;});
 const jobs=Object.assign(new JobsRepository(db),{onSettled:()=>settled()});
 const worker=createAiWorker(jobs,{repository:f.repo,workerId:'resumed-preparation',concurrency:1,modelCall:async()=>{throw new Error('must not call model');}});
 try {assert.equal(await worker.runOnce(),1);await finished;} finally {await worker.stop();}
 const paused=await db.selectFrom('ai_jobs').selectAll().where('id','=',job.id).executeTakeFirstOrThrow();
 const batch=await db.selectFrom('ai_job_batches').selectAll().where('job_id','=',job.id).executeTakeFirstOrThrow();
 assert.equal(paused.status,'paused');assert.equal(batch.status,'queued');assert.equal(batch.attempts,3n);
 await f.repo.resumeJob(job.id);
 const claim=(await jobs.claimNext('ai_batch','resumed-preparation',60000))!;
 await jobs.complete('ai_batch',claim.id,claim.claimed_by);
 assert.equal((await db.selectFrom('ai_job_batches').select('status').where('id','=',claim.id).executeTakeFirstOrThrow()).status,'running');
 await prepareAllPendingTagJob(db,claim.id,{workerId:claim.claimed_by,attempt:claim.attempts,token:String(claim.row.claim_token)});
 assert.equal((await db.selectFrom('ai_jobs').select('phase').where('id','=',job.id).executeTakeFirstOrThrow()).phase,'standardizing');
 await f.repo.cancelJob(job.id);
});

test('expired preparation lease rolls back all members and exhausted local retries expose failure',async()=>{
 const input={allPending:true,model:'mock',requestId:randomUUID()};
 const job=await createManualTagJob(db,input);
 await db.updateTable('ai_jobs').set({priority:99999}).where('id','=',job.id).execute();
 const jobs=new JobsRepository(db);
 const claim=(await jobs.claimNext('ai_batch','expired-preparation',60000))!;
 assert.equal(claim.row.step,'prepare');
 await db.updateTable('ai_job_batches').set({lease_until:new Date(0)}).where('id','=',claim.id).execute();
 await assert.rejects(prepareAllPendingTagJob(db,claim.id,{workerId:claim.claimed_by,attempt:claim.attempts,token:String(claim.row.claim_token)}),/lease expired/);
 assert.equal((await db.selectFrom('ai_job_input_members').select('product_id').where('job_id','=',job.id).execute()).length,0);
 const recovered=(await jobs.claimNext('ai_batch','recovered-preparation',60000))!;
 assert.equal(recovered.id,claim.id);
 await jobs.fail('ai_batch',recovered.id,recovered.claimed_by,'证据准备失败',{retry:false,retryClass:'local'});
 const failed=await db.selectFrom('ai_jobs').selectAll().where('id','=',job.id).executeTakeFirstOrThrow();
 assert.equal(failed.status,'failed');assert.equal(failed.error,'证据准备失败');
 assert.ok((await readAiTaskQueue(db,{jobType:'tag_extraction',status:'attention'})).items.some(item=>item.id===String(job.id)));
});

test('empty asynchronous scope completes without a model request',async()=>{
 await db.updateTable('shops').set({enabled:false}).execute();
 const job=await createManualTagJob(db,{allPending:true,model:'mock',requestId:randomUUID()});
 await db.updateTable('ai_jobs').set({priority:999999}).where('id','=',job.id).execute();
 const claim=(await new JobsRepository(db).claimNext('ai_batch','empty-preparation',60000))!;
 await prepareAllPendingTagJob(db,claim.id,{workerId:claim.claimed_by,attempt:claim.attempts,token:String(claim.row.claim_token)});
 const done=await db.selectFrom('ai_jobs').selectAll().where('id','=',job.id).executeTakeFirstOrThrow();
 assert.equal(done.status,'succeeded');assert.equal(done.total,0n);
 assert.equal((await getJobProgress(db,job.id))!.requests.totalBatches,0);
});

test('tag batches respect the same rolling window as identity batches when an earlier batch remains slow',async()=>{
 const f=await fixture();
 await db.updateTable('ai_jobs').set({priority:9999}).where('id','=',f.job.id).execute();
 const concurrency=Number(process.env.AI_CONCURRENCY||2);
 await db.insertInto('ai_job_batches').values({job_id:f.job.id,batch_index:BigInt(concurrency),product_ids:jsonb([]),product_count:0n,status:'queued',step:'request'}).execute();
 await db.updateTable('ai_jobs').set({job_type:'manual_full'}).where('id','=',f.job.id).execute();
 assert.equal(await new JobsRepository(db).claimNext('ai_batch','identity-window',60000),null);
 await db.updateTable('ai_jobs').set({job_type:'tag_extraction'}).where('id','=',f.job.id).execute();
  assert.equal(await new JobsRepository(db).claimNext('ai_batch','tag-window',60000),null);
  await db.updateTable('ai_job_batches').set({status:'succeeded',step:'done'}).where('id','=',f.batch.id).execute();
 const claim=await new JobsRepository(db).claimNext('ai_batch','tag-free-slot',60000);
 assert.equal(claim?.row.job_id,f.job.id);
 assert.equal(claim?.row.batch_index,BigInt(concurrency));
 await f.repo.cancelJob(f.job.id);
});

for (const field of ['url', 'protocol', 'platform'] as const) for (const completed of [true, false]) {
 test(`source-bound ${completed ? 'completed' : 'pending'} tag tasks become pending after shop ${field} changes`, async () => {
  const f=await fixture();
  const shopId=f.products[0]!.shop_id;
  const source=await db.selectFrom('shops').select(['url','protocol','platform']).where('id','=',shopId).executeTakeFirstOrThrow();
  // New tag-only payloads still bind their source even when shopText is absent.
  await db.updateTable('ai_job_input_members').set({payload:jsonb({...f.payload,shopSource:source}),
   ...(completed?{status:'classified' as const,output:jsonb({outcome:'review',reasonCode:'source-review',rejectedTags:[]})}:{})
  }).where('job_id','=',f.job.id).execute();
  if(completed) await db.updateTable('ai_jobs').set({status:'succeeded'}).where('id','=',f.job.id).execute();
  const queue=()=>readAiTaskQueue(db,{jobType:'tag_extraction',status:'all',scopeShopId:shopId});
  const before=await queue();
  assert.equal(before.summary.pendingProducts,0);
  assert.equal(before.summary.coveredProducts,completed?1:0);
  assert.equal(before.items.find(i=>i.id===String(f.job.id))!.remaining,completed?0:1);
  const changed={...source,[field]:field==='url'?`${source.url}/changed`:field==='protocol'?'changed-protocol':'changed-platform'};
  await db.updateTable('shops').set(changed).where('id','=',shopId).execute();
  const stale=await queue();
  assert.equal(stale.summary.pendingProducts,1);
  assert.equal(stale.summary.coveredProducts,0);
  assert.equal(stale.summary.reviewProducts,0);
  assert.deepEqual(stale.summary.currentReasons,{});
  assert.equal(stale.items.find(i=>i.id===String(f.job.id))!.remaining,0);
  const replacement=await db.transaction().execute(tx=>createTagJob(tx,{productIds:[f.inputId],model:'mock'}));
  const member=await db.selectFrom('ai_job_input_members').select('payload').where('job_id','=',replacement.id).executeTakeFirstOrThrow();
  assert.deepEqual((member.payload as Record<string,unknown>).shopSource,changed);
  assert.equal((await queue()).summary.pendingProducts,0);
  // A newer task for another source must not supersede a matching older task.
  await db.updateTable('shops').set(source).where('id','=',shopId).execute();
  const restored=await queue();
  assert.equal(restored.summary.pendingProducts,0);
  assert.equal(restored.summary.coveredProducts,completed?1:0);
  assert.equal(restored.items.find(i=>i.id===String(f.job.id))!.remaining,completed?0:1);
  assert.equal(restored.items.find(i=>i.id===String(replacement.id))!.remaining,0);
  const preparationSource={...source,[field]:field==='url'?`${source.url}/preparation`:field==='protocol'?'preparation-protocol':'preparation-platform'};
  await db.updateTable('shops').set(preparationSource).where('id','=',shopId).execute();
  const pending=await createManualTagJob(db,{allPending:true,model:'mock',requestId:randomUUID()});
  await preparePending(pending.id);
  const preparedMember=await db.selectFrom('ai_job_input_members').select('product_id').where('job_id','=',pending.id).where('product_id','=',f.inputId).executeTakeFirst();
  assert.equal(preparedMember?.product_id,f.inputId);
  await completeTagJob(pending.id);
 });
}

for (const legacy of [
 {name:'absent text and source',extra:{},current:true},
 {name:'null text and absent source',extra:{shopText:null},current:true},
 {name:'text without source',extra:{shopText:{unitId:'1',name:'name',description:'body',hash:'hash'}},current:false},
 {name:'null source',extra:{shopSource:null},current:false},
 {name:'malformed source',extra:{shopSource:{}},current:false},
]) test(`legacy tag source compatibility: ${legacy.name}`,async()=>{
 const f=await fixture();
 const shopId=f.products[0]!.shop_id;
 await db.updateTable('ai_jobs').set({status:'succeeded'}).where('id','=',f.job.id).execute();
 await db.updateTable('ai_job_input_members').set({payload:jsonb({...f.payload,...legacy.extra}),status:'classified',output:jsonb({outcome:'updated',rejectedTags:[]})}).where('job_id','=',f.job.id).execute();
 await db.updateTable('shops').set({url:`https://changed.invalid/${randomUUID()}`}).where('id','=',shopId).execute();
 const queue=await readAiTaskQueue(db,{jobType:'tag_extraction',status:'all',scopeShopId:shopId});
 assert.equal(queue.summary.pendingProducts,legacy.current?0:1);
 assert.equal(queue.summary.coveredProducts,legacy.current?1:0);
 const pending=await createManualTagJob(db,{allPending:true,model:'mock',requestId:randomUUID()});
 await preparePending(pending.id);
 const member=await db.selectFrom('ai_job_input_members').select('product_id').where('job_id','=',pending.id).where('product_id','=',f.inputId).executeTakeFirst();
 assert.equal(Boolean(member),!legacy.current);
 await completeTagJob(pending.id);
});

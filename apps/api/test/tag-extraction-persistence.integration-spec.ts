import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { migrateToLatest } from '../scripts/migrate.js';
import { AiRepository } from '../src/ai/ai.repository.js';
import type { DatabaseSchema } from '../src/database/types.js';
import { jsonb } from '../src/database/types.js';
import { productContentFingerprint } from '../src/standardization/fingerprint.js';
import { pipelineVersionSnapshot } from '../src/ai/pipeline-versions.js';
import { STANDARDIZATION_PROMPT_VERSION } from '../src/ai/standardization-request.js';
import { IDENTITY_POLICY_VERSION } from '../src/standardization/identity-policy.js';
import { validateTagExtractionDecision } from '../src/ai/tag-extraction-result.js';

let db: Kysely<DatabaseSchema>, admin: Pool, schema: string;
before(async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required');
  schema = `tag_audit_${Date.now()}_${Math.floor(Math.random()*1000000)}`;
  admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path="${schema}",public` }) }) });
  process.env.PG_SCHEMA = schema;
  await migrateToLatest(db);
});
after(async () => { await db?.destroy(); if (schema) await admin.query(`drop schema "${schema}" cascade`); await admin?.end(); delete process.env.PG_SCHEMA; });
async function fixture(count = 1) {
  const shop = await db.insertInto('shops').values({ platform: 'test', name: 'test', url: `https://test.invalid/${Math.random()}`, enabled: true }).returning('id').executeTakeFirstOrThrow();
  const payload = { name: 'ChatGPT Plus 成品账号', spec: '1个月', sourceData: {} };
  const fingerprint = productContentFingerprint({ ...payload, sourceCategory: '' });
  const products = [];
  for (let i=0;i<count;i++) products.push(await db.insertInto('products').values({ shop_id: shop.id, external_id: String(i), name: payload.name, spec: payload.spec, source_category: '', source_data: jsonb({}), normalized_key: `tag-${Math.random()}`, url: 'https://test.invalid/p', content_version: 1n, content_fingerprint: fingerprint }).returningAll().executeTakeFirstOrThrow());
  const job = await db.insertInto('ai_jobs').values({ total: BigInt(count), model: 'mock', job_type: 'tag_extraction', status: 'running', phase: 'standardizing', prompt_version: STANDARDIZATION_PROMPT_VERSION, rule_version: IDENTITY_POLICY_VERSION, pipeline_versions: jsonb(pipelineVersionSnapshot('mock')) }).returningAll().executeTakeFirstOrThrow();
  const inputId = products[0]!.id;
  await db.insertInto('ai_job_inputs').values({ job_id: job.id, input_id: inputId, fingerprint, payload: jsonb(payload), content_version: 1n, input_bytes: 100n, estimated_tokens: 100n }).execute();
  for (const p of products) await db.insertInto('ai_job_input_members').values({ job_id: job.id, input_id: inputId, product_id: p.id, fingerprint, payload: jsonb(payload), content_version: 1n, standardization_revision: p.standardization_revision }).execute();
  const batch = await db.insertInto('ai_job_batches').values({ job_id: job.id, batch_index: 0n, product_ids: jsonb([String(inputId)]), product_count: BigInt(count), status: 'running', claimed_by: 'test', claim_token: 'claim', attempts: 1n, lease_until: new Date(Date.now()+60000), step: 'request', request_budget_limit: 2 }).returningAll().executeTakeFirstOrThrow();
  const standard = await db.insertInto('standard_products').values({ canonical_family: 'openai', canonical_product: 'chatgpt', canonical_tier: 'plus', name: 'test' }).returning('id').executeTakeFirstOrThrow();
  for (const p of products) await db.insertInto('standard_product_members').values({ product_id: p.id, standard_product_id: standard.id, assignment_source: 'ai', publication_state: 'published' }).execute();
  return { repo: new AiRepository(db), job, batch, products, inputId, payload };
}
const claim = { workerId: 'test', attempt: 1n, token: 'claim' };
async function outputs(jobId: bigint) { return db.selectFrom('ai_job_input_members').select(['output', 'reason_code']).where('job_id','=',jobId).orderBy('product_id').execute(); }

test('atomic audited fanout, real diff, retention, independent locked guard and done idempotence', async () => {
  const f=await fixture(2);
  await db.insertInto('product_tags').values({ product_id: f.inputId, name: 'renewable', value: '有' }).execute();
  await db.updateTable('products').set({ standardization_locked: true }).where('id','=',f.products[1]!.id).execute();
  const decision=validateTagExtractionDecision(f.inputId,[{ name:'duration', value:'1 month', evidence:[{path:'spec',quote:'1个月'}] }],f.payload);
  await f.repo.persistTagExtractionBatchDecision(f.job.id,f.batch.id,[decision],{},claim);
  const result=await outputs(f.job.id);
  assert.equal((result[0]!.output as any).outcome,'updated');
  assert.deepEqual((result[0]!.output as any).retainedUnconfirmed,[{name:'renewable',value:'有'}]);
  assert.equal((result[1]!.output as any).outcome,'skipped');
  assert.equal(result[1]!.reason_code,'product_locked');
  await f.repo.persistTagExtractionBatchDecision(f.job.id,f.batch.id,[decision],{},claim);
  assert.deepEqual(await outputs(f.job.id),result);
  assert.equal((await db.selectFrom('ai_standardization_results').selectAll().where('job_id','=',f.job.id).execute()).length,0);
});

test('duplicate and unknown IDs roll back; stale claims cannot write',async()=>{
  const f=await fixture(); const d=validateTagExtractionDecision(f.inputId,[],f.payload);
  await assert.rejects(f.repo.persistTagExtractionBatchDecision(f.job.id,f.batch.id,[d,d],{},claim),/does not match/);
  await assert.rejects(f.repo.persistTagExtractionBatchDecision(f.job.id,f.batch.id,[{...d,productId:999999999n}],{},claim),/does not match/);
  await assert.rejects(f.repo.persistTagExtractionBatchDecision(f.job.id,f.batch.id,[d],{},{...claim,token:'stale'}),/claim token/);
  assert.equal((await outputs(f.job.id))[0]!.output,null);
});

test('missing response schedules only one bounded round and persists terminal missing audit',async()=>{
  const f=await fixture();
  await f.repo.persistTagExtractionBatchDecision(f.job.id,f.batch.id,[],{},claim);
  const retry=await db.selectFrom('ai_job_batches').selectAll().where('job_id','=',f.job.id).where('round','=',1).executeTakeFirstOrThrow();
  assert.equal(retry.request_budget_limit,1);
  await db.updateTable('ai_job_batches').set({status:'running',claimed_by:'test',claim_token:'claim',attempts:1n,lease_until:new Date(Date.now()+60000)}).where('id','=',retry.id).execute();
  await f.repo.persistTagExtractionBatchDecision(f.job.id,retry.id,[],{},claim);
  assert.equal((await db.selectFrom('ai_job_batches').select('id').where('job_id','=',f.job.id).execute()).length,2);
  assert.equal((await outputs(f.job.id))[0]!.reason_code,'missing_id');
  assert.equal((await outputs(f.job.id))[0]!.output && ((await outputs(f.job.id))[0]!.output as any).outcome,'failed');
});

test('cancel records explicit outcome without overwriting committed output',async()=>{
  const f=await fixture(); await f.repo.cancelJob(f.job.id);
  assert.equal(((await outputs(f.job.id))[0]!.output as any).outcome,'cancelled');
});

test('missing retry preserves committed skipped members of the same input',async()=>{
  const f=await fixture(2);
  await db.updateTable('products').set({standardization_locked:true}).where('id','=',f.products[1]!.id).execute();
  await f.repo.prepareBatch(f.batch.id);
  assert.equal(await f.repo.reserveBatchRequest(f.batch.id,claim),'reserved');
  const skipped=(await outputs(f.job.id))[1]!;
  await f.repo.persistTagExtractionBatchDecision(f.job.id,f.batch.id,[],{},claim);
  assert.deepEqual((await outputs(f.job.id))[1],skipped);
  const members=await db.selectFrom('ai_job_input_members').select(['status','missing_reprocess_count']).where('job_id','=',f.job.id).orderBy('product_id').execute();
  assert.deepEqual(members.map(m=>[m.status,m.missing_reprocess_count]),[['queued',1],['classified',0]]);
});

test('cancel converts provisional missing while another first-round batch runs and retains committed skips',async()=>{
  const f=await fixture(2);
  await db.updateTable('products').set({standardization_locked:true}).where('id','=',f.products[1]!.id).execute();
  await f.repo.prepareBatch(f.batch.id);
  await f.repo.reserveBatchRequest(f.batch.id,claim);
  const skipped=(await outputs(f.job.id))[1]!;
  await db.insertInto('ai_job_batches').values({job_id:f.job.id,batch_index:1n,product_ids:jsonb([]),product_count:0n,status:'running'}).execute();
  await f.repo.persistTagExtractionBatchDecision(f.job.id,f.batch.id,[],{},claim);
  assert.equal(((await outputs(f.job.id))[0]!.output as any).reasonCode,'missing_id');
  await f.repo.cancelJob(f.job.id);
  const result=await outputs(f.job.id);
  assert.equal((result[0]!.output as any).outcome,'cancelled');
  assert.equal(result[0]!.reason_code,'job_cancelled');
  assert.deepEqual(result[1],skipped);
  assert.equal((await db.selectFrom('ai_job_input_members').select('status').where('job_id','=',f.job.id).where('product_id','=',f.inputId).executeTakeFirstOrThrow()).status,'cancelled');
});

test('reserve uses member input IDs and skips fully protected batches without spending',async()=>{
  const f=await fixture(2);
  await db.updateTable('products').set({deleted_at:new Date()}).where('id','=',f.inputId).execute();
  await f.repo.prepareBatch(f.batch.id);
  assert.equal(await f.repo.reserveBatchRequest(f.batch.id,claim),'reserved');
  assert.equal((await f.repo.getTagExtractionBatchInputs(f.batch.id)).inputs[0]!.productId,f.inputId);
  const protectedJob=await fixture();
  await db.updateTable('products').set({standardization_locked:true}).where('id','=',protectedJob.inputId).execute();
  await protectedJob.repo.prepareBatch(protectedJob.batch.id);
  assert.equal(await protectedJob.repo.reserveBatchRequest(protectedJob.batch.id,claim),'skipped');
  assert.equal(((await outputs(protectedJob.job.id))[0]!.output as any).outcome,'skipped');
  assert.equal((await db.selectFrom('ai_job_batches').select('request_budget_used').where('id','=',protectedJob.batch.id).executeTakeFirstOrThrow()).request_budget_used,0);
});

test('unchanged and empty results do not rewrite tags or bump catalog, mixed rejection remains visible',async()=>{
  const f=await fixture();
  await db.insertInto('product_tags').values({product_id:f.inputId,name:'duration',value:'1 month'}).execute();
  const decision=validateTagExtractionDecision(f.inputId,[{name:'duration',value:'1 month',evidence:[{path:'spec',quote:'1个月'}]},{name:'renewable',value:'有',evidence:[{path:'spec',quote:'1个月'}]}],f.payload);
  const versionBefore=await db.selectFrom('catalog_cache_versions').selectAll().execute();
  await f.repo.persistTagExtractionBatchDecision(f.job.id,f.batch.id,[decision],{},claim);
  const output=(await outputs(f.job.id))[0]!.output as any;
  assert.equal(output.outcome,'review'); assert.equal(output.rejectedTags.length,1); assert.equal(output.diff.length,0);
  assert.deepEqual(await db.selectFrom('catalog_cache_versions').selectAll().execute(),versionBefore);
  const empty=await fixture(); await empty.repo.persistTagExtractionBatchDecision(empty.job.id,empty.batch.id,[validateTagExtractionDecision(empty.inputId,[],empty.payload)],{},claim);
  assert.equal(((await outputs(empty.job.id))[0]!.output as any).outcome,'empty');
});

test('persistence revalidation keeps vocabulary rejections and duplicates out of tags across fanout', async () => {
  const f = await fixture(2);
  const duration = { name: 'duration', value: '1 month', evidence: [{ path: 'spec', quote: '1个月' }] };
  const decision = validateTagExtractionDecision(f.inputId, [
    duration, duration,
    { name: 'invented', value: 'password=hidden', evidence: [{ path: 'spec', quote: '1个月' }] },
    { name: 'renewable', value: 'yes', evidence: [{ path: 'spec', quote: '1个月' }] },
  ], f.payload);
  await f.repo.persistTagExtractionBatchDecision(f.job.id, f.batch.id, [decision], {}, claim);
  for (const row of await outputs(f.job.id)) {
    const output = row.output as any;
    assert.equal(output.outcome, 'updated');
    assert.equal(output.acceptedTags.length, 1);
    assert.deepEqual(output.rejectedTags.map((tag: any) => tag.reasonCode).sort(),
      ['tag_duplicate', 'tag_name_unknown', 'tag_value_invalid']);
    assert.ok(!JSON.stringify(output).includes('hidden'));
  }
  const stored = await db.selectFrom('product_tags').select(['product_id', 'name', 'value'])
    .where('product_id', 'in', f.products.map(p => p.id)).execute();
  assert.equal(stored.length, 2);
  assert.ok(stored.every(tag => tag.name === 'duration' && tag.value === '1 month'));
});

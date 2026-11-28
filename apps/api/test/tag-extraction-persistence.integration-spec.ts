import { tagRows } from './tag-fixtures.js';
import { seedUsableOffers } from './standardization-review-fixture.js';
import { seedAttributePublication } from './attribute-publication-fixture.js';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { migrateToLatest } from '../scripts/migrate.js';
import { AiRepository } from '../src/ai/ai.repository.js';
import type { DatabaseSchema } from '../src/database/types.js';
import { jsonb } from '../src/database/types.js';
import { productContentFingerprint } from '../src/standardization/fingerprint.js';
import { pipelineVersionSnapshot, STANDARDIZATION_POLICY_VERSION } from '../src/ai/pipeline-versions.js';
import { STANDARDIZATION_PROMPT_VERSION } from '../src/ai/standardization-request.js';
import { validateReviewedTagExtractionDecision, type TagExtractionDecision } from '../src/ai/tag-extraction-result.js';

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
  const shop = await db.insertInto('shops').values({ platform: 'test', name: 'test', url: `https://test.invalid/${Math.random()}`, enabled: true }).returningAll().executeTakeFirstOrThrow();
  const payload = { name: 'ChatGPT Plus 成品账号', spec: '1个月', sourceData: {},
    shopSource: { url: shop.url, protocol: shop.protocol, platform: shop.platform } };
  const fingerprint = productContentFingerprint({ ...payload, sourceCategory: '' });
  const products = [];
  for (let i=0;i<count;i++) products.push(await db.insertInto('products').values({ shop_id: shop.id, external_id: String(i), name: payload.name, spec: payload.spec, source_category: '', source_data: jsonb({}), normalized_key: `tag-${Math.random()}`, url: 'https://test.invalid/p', content_version: 1n, content_fingerprint: fingerprint }).returningAll().executeTakeFirstOrThrow());
  await seedUsableOffers(db, products.map(product => product.id));
  const job = await db.insertInto('ai_jobs').values({ total: BigInt(count), model: 'mock', job_type: 'tag_extraction', status: 'running', phase: 'standardizing', prompt_version: STANDARDIZATION_PROMPT_VERSION, rule_version: STANDARDIZATION_POLICY_VERSION, pipeline_versions: jsonb(pipelineVersionSnapshot('mock')) }).returningAll().executeTakeFirstOrThrow();
  const inputId = products[0]!.id;
  await db.insertInto('ai_job_inputs').values({ job_id: job.id, input_id: inputId, fingerprint, payload: jsonb(payload), status: 'queued', content_version: 1n, input_bytes: 100n, estimated_tokens: 100n }).execute();
  for (const p of products) await db.insertInto('ai_job_input_members').values({ job_id: job.id, input_id: inputId, product_id: p.id, fingerprint, payload: jsonb(payload), content_version: 1n, standardization_revision: p.standardization_revision }).execute();
  const batch = await db.insertInto('ai_job_batches').values({ job_id: job.id, batch_index: 0n, product_ids: jsonb([String(inputId)]), product_count: BigInt(count), status: 'running', claimed_by: 'test', claim_token: 'claim', attempts: 1n, lease_until: new Date(Date.now()+60000), step: 'request', request_budget_limit: 2 }).returningAll().executeTakeFirstOrThrow();
  // Non-membership tags retain their existing partial-update semantics.
  const standard = await db.insertInto('standard_products').values({ canonical_family: 'openai', canonical_product: 'chatgpt', canonical_tier: 'free', name: 'test', verification_state: 'verified' }).returning('id').executeTakeFirstOrThrow();
  for (const p of products) await db.insertInto('standard_product_members').values({ product_id: p.id, standard_product_id: standard.id, assignment_source: 'ai', publication_state: 'published' }).execute();
  return { repo: new AiRepository(db), job, batch, products, inputId, payload };
}
const claim = { workerId: 'test', attempt: 1n, token: 'claim' };
async function outputs(jobId: bigint) { return db.selectFrom('ai_job_input_members').select(['output', 'reason_code']).where('job_id','=',jobId).orderBy('product_id').execute(); }

async function reserveRemainingMember(f: Awaited<ReturnType<typeof fixture>>) {
  await f.repo.prepareBatch(f.batch.id);
  assert.equal(await f.repo.reserveBatchRequest(f.batch.id, claim), 'refresh');
  assert.deepEqual(await db.selectFrom('ai_job_batches').select(['request_budget_used', 'product_count'])
    .where('id', '=', f.batch.id).executeTakeFirstOrThrow(), { request_budget_used: 0, product_count: 1n });
  await f.repo.prepareBatch(f.batch.id);
  assert.equal(await f.repo.reserveBatchRequest(f.batch.id, claim), 'reserved');
}

for (const invalid of ['unreviewed', 'missing_votes', 'non_boolean_votes', 'missing_complete'] as const) {
  for (const step of ['request', 'publish'] as const) {
    test(`${step}: ${invalid} saved tag result cannot publish`, async () => {
      const f = await fixture();
      const before = [{ name: 'duration', value: 90 }];
      await db.insertInto('product_tags').values(tagRows(before.map(tag => ({ product_id: f.inputId, ...tag })))).execute();
      const decision: TagExtractionDecision = {
        productId: f.inputId, tags: [{ name: 'duration', value: 30, evidence: [], proposalIndex: 0 }],
        rejectedTags: [], reviewed: true, complete: true, reviewDecisions: [true],
      };
      if (invalid === 'unreviewed') delete decision.reviewed;
      if (invalid === 'missing_votes') delete decision.reviewDecisions;
      if (invalid === 'non_boolean_votes') decision.reviewDecisions = ['true'] as unknown as boolean[];
      if (invalid === 'missing_complete') delete decision.complete;
      await seedAttributePublication(db, f.batch.id, [decision]);
      await db.updateTable('ai_job_batches').set({ step }).where('id', '=', f.batch.id).execute();
      const batchBefore = await db.selectFrom('ai_job_batches').selectAll().where('id', '=', f.batch.id).executeTakeFirstOrThrow();
      const cacheBefore = await db.selectFrom('catalog_cache_versions').selectAll().execute();
      await assert.rejects(f.repo.publishTagExtractionBatch(f.batch.id, claim));
      assert.deepEqual(await db.selectFrom('product_tags').select(['name', 'value']).where('product_id', '=', f.inputId).execute(), before);
      assert.equal((await outputs(f.job.id))[0]!.output, null);
      assert.deepEqual(await db.selectFrom('ai_job_batches').selectAll().where('id', '=', f.batch.id).executeTakeFirstOrThrow(), batchBefore);
      assert.deepEqual(await db.selectFrom('catalog_cache_versions').selectAll().execute(), cacheBefore);
    });
  }
}

test('publication requires a review snapshot even when the saved decisions are complete', async () => {
  const f = await fixture();
  const decision = validateReviewedTagExtractionDecision(f.inputId, [], [], f.payload, [], true);
  await seedAttributePublication(db, f.batch.id, [decision]);
  const stored = await db.insertInto('product_tags').values(tagRows({ product_id: f.inputId, name: 'duration', value: 90 }))
    .returningAll().execute();
  for (const reference of Array.of<import('../src/database/types.js').JsonValue>(null, {}, { tagStage: 'review' }, { reviewStage: 'generate' }, { reviewStage: 'repair' }, { reviewStage: 'warranty' })) {
    await db.updateTable('ai_job_batches').set({ reference_snapshot: reference === null ? null : jsonb(reference) })
      .where('id', '=', f.batch.id).execute();
    const before = await db.selectFrom('ai_job_batches').selectAll().where('id', '=', f.batch.id).executeTakeFirstOrThrow();
    await assert.rejects(f.repo.publishTagExtractionBatch(f.batch.id, claim), /stage|reviewed/i);
    assert.deepEqual(await db.selectFrom('ai_job_batches').selectAll().where('id', '=', f.batch.id).executeTakeFirstOrThrow(), before);
    assert.deepEqual(await db.selectFrom('product_tags').selectAll().where('product_id', '=', f.inputId).execute(), stored);
    assert.deepEqual(await outputs(f.job.id), [{ output: null, reason_code: null }]);
  }
});

test('LLM-approved supported client publishes without a second semantic inference', async () => {
  const f = await fixture();
  const value = 'codex';
  const decision = validateReviewedTagExtractionDecision(f.inputId,
    [{ name: 'supported_client', value, evidence: [], proposalIndex: 0 }], [], f.payload, [true], true);
  await seedAttributePublication(db, f.batch.id, [decision]);
  await f.repo.publishTagExtractionBatch(f.batch.id, claim);
  assert.deepEqual(await db.selectFrom('product_tags').select(['name', 'value']).where('product_id', '=', f.inputId).execute(),
    [{ name: 'supported_client', value }]);
  const output = (await outputs(f.job.id))[0]!.output as any;
  assert.equal(output.outcome, 'updated');
  assert.deepEqual(output.review, { mode: 'per_tag_binary', decisions: [true] });
  assert.deepEqual(output.rejectedTags, []);
});

test('atomic audited full replacement, independent locked guard and done idempotence', async () => {
  const f=await fixture(2);
  await db.insertInto('product_tags').values(tagRows({ product_id: f.inputId, name: 'region', value: 'us' })).execute();
  await db.updateTable('products').set({ standardization_locked: true }).where('id','=',f.products[1]!.id).execute();
  const decision=validateReviewedTagExtractionDecision(f.inputId,[{ name:'duration', value:30, evidence:[], proposalIndex:0 }],[],f.payload,[true],true);
  await seedAttributePublication(db, f.batch.id, [decision]);
  await f.repo.publishTagExtractionBatch(f.batch.id, claim);
  const result=await outputs(f.job.id);
  assert.equal((result[0]!.output as any).outcome,'updated');
  assert.equal((result[0]!.output as any).retainedUnconfirmed, undefined);
  assert.deepEqual(await db.selectFrom('product_tags').select(['name','value']).where('product_id','=',f.inputId).execute(), [{name:'duration',value:30}]);
  assert.equal((result[1]!.output as any).outcome,'skipped');
  assert.equal(result[1]!.reason_code,'product_locked');
  await f.repo.publishTagExtractionBatch(f.batch.id, claim);
  assert.deepEqual(await outputs(f.job.id),result);
  assert.equal((await db.selectFrom('ai_standardization_results').selectAll().where('job_id','=',f.job.id).execute()).length,0);
});

test('duplicate and unknown IDs roll back; stale claims cannot write',async()=>{
  const f=await fixture(); const d=validateReviewedTagExtractionDecision(f.inputId,[],[],f.payload,[],true);
  for (const items of [[d, d], [{ ...d, productId: 999999999n }]]) {
    await seedAttributePublication(db, f.batch.id, items);
    await assert.rejects(f.repo.publishTagExtractionBatch(f.batch.id, claim), /does not match/);
  }
  await seedAttributePublication(db, f.batch.id, [d]);
  await assert.rejects(f.repo.publishTagExtractionBatch(f.batch.id, { ...claim, token: 'stale' }), /claim/);
  assert.equal((await outputs(f.job.id))[0]!.output,null);
});

test('an incomplete saved response is rejected without confirmation, product changes or retry batches',async()=>{
  const f=await fixture();
  const stored = await db.insertInto('product_tags').values(tagRows({ product_id: f.inputId, name: 'duration', value: 90 }))
    .returningAll().execute();
  await seedAttributePublication(db, f.batch.id, []);
  const before = await db.selectFrom('ai_job_batches').selectAll().where('id', '=', f.batch.id).executeTakeFirstOrThrow();
  await assert.rejects(f.repo.publishTagExtractionBatch(f.batch.id, claim), /does not match/);
  assert.deepEqual(await db.selectFrom('ai_job_batches').selectAll().where('job_id', '=', f.job.id).execute(), [before]);
  assert.deepEqual(await outputs(f.job.id), [{ output: null, reason_code: null }]);
  assert.deepEqual(await db.selectFrom('product_tags').selectAll().where('product_id', '=', f.inputId).execute(), stored);
});

test('cancel records explicit outcome without overwriting committed output',async()=>{
  const f=await fixture(); await f.repo.cancelJob(f.job.id);
  assert.equal(((await outputs(f.job.id))[0]!.output as any).outcome,'cancelled');
});

test('an omitted input is rejected without altering committed skipped members',async()=>{
  const f=await fixture(2);
  await db.updateTable('products').set({standardization_locked:true}).where('id','=',f.products[1]!.id).execute();
  await reserveRemainingMember(f);
  const skipped=(await outputs(f.job.id))[1]!;
  await assert.rejects(f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [], {}, claim, 'generate'), /does not match/);
  assert.deepEqual((await outputs(f.job.id))[1],skipped);
  const members=await db.selectFrom('ai_job_input_members').select(['status','missing_reprocess_count']).where('job_id','=',f.job.id).orderBy('product_id').execute();
  assert.deepEqual(members.map(m=>[m.status,m.missing_reprocess_count]),[['queued',0],['classified',0]]);
  assert.equal((await db.selectFrom('ai_job_batches').select('confirmed_requests').where('id', '=', f.batch.id).executeTakeFirstOrThrow()).confirmed_requests, 0);
  assert.equal((await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', f.job.id).execute()).length, 1);
});

test('cancel after an incomplete response retains committed skips without recording missing results',async()=>{
  const f=await fixture(2);
  await db.updateTable('products').set({standardization_locked:true}).where('id','=',f.products[1]!.id).execute();
  await reserveRemainingMember(f);
  const skipped=(await outputs(f.job.id))[1]!;
  await db.insertInto('ai_job_batches').values({job_id:f.job.id,batch_index:1n,product_ids:jsonb([]),product_count:0n,status:'running'}).execute();
  await assert.rejects(f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [], {}, claim, 'generate'), /does not match/);
  assert.equal((await outputs(f.job.id))[0]!.output, null);
  const provisional=await db.selectFrom('ai_job_input_members').select(['status','missing_reprocess_count']).where('job_id','=',f.job.id).where('product_id','=',f.inputId).executeTakeFirstOrThrow();
  assert.deepEqual(provisional,{status:'queued',missing_reprocess_count:0});
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
  await reserveRemainingMember(f);
  assert.equal((await f.repo.getTagExtractionBatchInputs(f.batch.id)).inputs[0]!.productId,f.inputId);
  const protectedJob=await fixture();
  await db.updateTable('products').set({standardization_locked:true}).where('id','=',protectedJob.inputId).execute();
  await protectedJob.repo.prepareBatch(protectedJob.batch.id);
  assert.equal(await protectedJob.repo.reserveBatchRequest(protectedJob.batch.id,claim),'skipped');
  assert.equal(((await outputs(protectedJob.job.id))[0]!.output as any).outcome,'skipped');
  assert.equal((await db.selectFrom('ai_job_batches').select('request_budget_used').where('id','=',protectedJob.batch.id).executeTakeFirstOrThrow()).request_budget_used,0);
});

test('unchanged partial results preserve tags and catalog version; complete empty results clear tags',async()=>{
  const f=await fixture();
  const stored=await db.insertInto('product_tags').values(tagRows({product_id:f.inputId,name:'duration',value:30})).returningAll().executeTakeFirstOrThrow();
  const decision=validateReviewedTagExtractionDecision(f.inputId,[{name:'duration',value:30,evidence:[],proposalIndex:0},{name:'unknown',value:'invalid',evidence:[],proposalIndex:1}],[],f.payload,[true,true],true);
  const versionBefore=await db.selectFrom('catalog_cache_versions').selectAll().execute();
  await seedAttributePublication(db, f.batch.id, [decision]);
  await f.repo.publishTagExtractionBatch(f.batch.id, claim);
  const output=(await outputs(f.job.id))[0]!.output as any;
  assert.equal(output.outcome,'partial_success'); assert.equal(output.rejectedTags.length,1); assert.equal(output.diff.length,0);
  assert.equal(output.successfulCount,1); assert.equal(output.failedCount,1); assert.equal(output.complete,true);
  assert.deepEqual(await db.selectFrom('product_tags').selectAll().where('product_id','=',f.inputId).execute(),[stored]);
  assert.deepEqual(await db.selectFrom('catalog_cache_versions').selectAll().execute(),versionBefore);
  const empty=await fixture(); await db.insertInto('product_tags').values(tagRows({product_id:empty.inputId,name:'duration',value:90})).execute();
  await seedAttributePublication(db, empty.batch.id, [validateReviewedTagExtractionDecision(empty.inputId, [], [], empty.payload, [], true)]);
  await empty.repo.publishTagExtractionBatch(empty.batch.id, claim);
  const cleared=(await outputs(empty.job.id))[0]!.output as any;
  assert.equal(cleared.outcome,'empty'); assert.equal(cleared.complete,true);
  assert.deepEqual(cleared.diff,[{name:'duration',before:[90],after:[]}]);
  assert.equal((await db.selectFrom('product_tags').selectAll().where('product_id','=',empty.inputId).execute()).length,0);
});

test('persistence revalidation keeps vocabulary rejections and duplicates out of tags across fanout', async () => {
  const f = await fixture(2);
  const duration = { name: 'duration', value: 30 };
  const decision = validateReviewedTagExtractionDecision(f.inputId, [
    duration, duration,
    { name: 'invented', value: 'password=hidden' },
    { name: 'subscription_override', value: 'yes' },
  ].map((tag, proposalIndex) => ({ ...tag, evidence: [], proposalIndex })), [], f.payload, [true, true, true, true], true);
  await seedAttributePublication(db, f.batch.id, [decision]);
  await f.repo.publishTagExtractionBatch(f.batch.id, claim);
  for (const row of await outputs(f.job.id)) {
    const output = row.output as any;
    assert.equal(output.outcome, 'partial_success');
    assert.equal(output.acceptedTags.length, 1);
    assert.equal(output.successfulCount, 1);
    assert.equal(output.failedCount, 3);
    assert.equal(output.complete, true);
    assert.deepEqual(output.rejectedTags.map((tag: any) => tag.reasonCode).sort(),
      ['tag_duplicate', 'tag_name_unknown', 'tag_value_invalid']);
    assert.ok(!JSON.stringify(output).includes('hidden'));
  }
  const stored = await db.selectFrom('product_tags').select(['product_id', 'name', 'value'])
    .where('product_id', 'in', f.products.map(p => p.id)).execute();
  assert.equal(stored.length, 2);
  assert.ok(stored.every(tag => tag.name === 'duration' && tag.value === 30));
});

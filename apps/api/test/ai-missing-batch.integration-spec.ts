import assert from 'node:assert/strict';
import { seedUsableOffers } from './standardization-review-fixture.js';
import { after, before, describe, test } from 'node:test';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { migrateToLatest } from '../scripts/migrate.js';
import { AiRepository } from '../src/ai/ai.repository.js';
import { finalizeAiJob } from '../src/ai/standardization-finalizer.js';
import { jsonb, type DatabaseSchema } from '../src/database/types.js';
import { productContentFingerprint } from '../src/standardization/fingerprint.js';
import { createAiWorker, createOpenAiModelCall } from '../src/ai/ai.worker.js';
import { JobsRepository } from '../src/jobs/jobs.repository.js';
import { createTagJob } from '../src/ai/tag-extraction-jobs.js';
import { seedAttributePublication } from './attribute-publication-fixture.js';

describe('standardization and attribute response completeness', () => {
  let database: Kysely<DatabaseSchema>;
  let admin: Pool;
  let schema = '';
  let sequence = 0;

  before(async () => {
    if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required for AI integration tests');
    schema = `ai_missing_batch_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`create schema "${schema}"`);
    process.env.PG_SCHEMA = schema;
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path="${schema}",public`, max: 12 });
    database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    await migrateToLatest(database);
    await database.insertInto('standard_products').values({
      name: 'Fixture subscription', canonical_family: 'fixture', canonical_product: 'subscription', canonical_tier: 'standard',
      verification_state: 'verified', catalog_definition: 'Only the named fixture subscription; unrelated listings are not matches.',
    }).execute();
  });

  after(async () => {
    await database?.destroy();
    if (admin && schema) await admin.query(`drop schema if exists "${schema}" cascade`);
    await admin?.end();
    delete process.env.PG_SCHEMA;
  });

  async function missingJob(batchSize = 2, attribute = true) {
    const shop = await database.insertInto('shops').values({
      platform: 'integration', url: `https://shop.invalid/missing-${++sequence}`, name: `missing-${sequence}`,
      enabled: true, deleted_at: null, last_fetch_at: null, last_error: null,
    }).returning('id').executeTakeFirstOrThrow();
    const productIds: bigint[] = [];
    for (const name of [`alpha-${sequence}`, `beta-${sequence}`]) {
      const sourceData = { evidence: name.repeat(name.startsWith('alpha') ? 50 : 65) };
      const fingerprint = productContentFingerprint({ name, spec: 'monthly', sourceData });
      const product = await database.insertInto('products').values({
        shop_id: shop.id, external_id: name, name, spec: 'monthly', source_category: '', source_data: jsonb(sourceData),
        normalized_key: name, url: `https://product.invalid/${name}`, deleted_at: null, content_version: 1n,
        content_fingerprint: fingerprint, standardization_locked: false,
      }).returning('id').executeTakeFirstOrThrow();
      productIds.push(product.id);
    }
    await seedUsableOffers(database, productIds);
    if (!attribute) return new AiRepository(database).createJob({ model: `missing-${sequence}`, productIds, batchSize });
    const standard = await database.selectFrom('standard_products').select('id').executeTakeFirstOrThrow();
    await database.insertInto('standard_product_members').values(productIds.map(productId => ({
      product_id: productId, standard_product_id: standard.id, assignment_source: 'ai' as const, publication_state: 'published' as const,
    }))).execute();
    const job = await database.transaction().execute(tx => createTagJob(tx, { model: `missing-${sequence}`, productIds }));
    const batches = await database.selectFrom('ai_job_batches').selectAll().where('job_id', '=', job.id).orderBy('id').execute();
    assert.equal(batches.length, 1);
    return { ...job, batches };
  }

  test('incomplete standardization output fails the entire streamed request without checkpointing or automatic retry', async () => {
    const job = await missingJob(2, false);
    const repository = new AiRepository(database);
    const jobs = new JobsRepository(database);
    let calls = 0;
    const settled = Promise.withResolvers<void>();
    const call = createOpenAiModelCall(repository, {
      AI_BASE_URL: 'https://model.invalid/v1', AI_API_KEY: 'mock', AI_MODEL: job.model,
    }, async (_url, init) => {
      calls++;
      assert.equal(JSON.parse(String(init?.body)).stream, true);
      const request = await repository.getBatchRequest(job.batches[0]!.id);
      const first = request.inputs[0]!;
      const name = (first.payload as { name: string }).name;
      const content = JSON.stringify({ items: [{
        id: String(first.productId), standardProductId: null, nullReason: 'insufficient_source', evidence: [{ path: 'name', quote: name }],
      }] });
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
    const worker = createAiWorker({
      claimNext: jobs.claimNext.bind(jobs), heartbeat: jobs.heartbeat.bind(jobs),
      complete: jobs.complete.bind(jobs), fail: jobs.fail.bind(jobs), requeue: jobs.requeue.bind(jobs),
      onSettled: () => settled.resolve(),
    }, { repository, modelCall: call, workerId: 'missing-standardization', concurrency: 1 });
    try {
      assert.equal(await worker.runOnce(), 1);
      await settled.promise;
      assert.equal(await worker.runOnce(), 0);
      assert.equal(calls, 1, JSON.stringify(await database.selectFrom('ai_job_batches').select(['error_source', 'error'])
        .where('job_id', '=', job.id).execute()));
      const batches = await database.selectFrom('ai_job_batches')
        .select(['status', 'error_source', 'round', 'validated_decision', 'request_budget_used', 'confirmed_requests'])
        .where('job_id', '=', job.id).execute();
      assert.deepEqual(batches, [{
        status: 'failed', error_source: 'invalid_response', round: 0, validated_decision: null,
        request_budget_used: 1, confirmed_requests: 1,
      }]);
      const results = await database.selectFrom('ai_standardization_results').select(['status', 'reason_code'])
        .where('job_id', '=', job.id).execute();
      assert.deepEqual(results, [
        { status: 'unclassified', reason_code: 'invalid_response' }, { status: 'unclassified', reason_code: 'invalid_response' },
      ]);
      const members = await database.selectFrom('ai_job_input_members').select('missing_reprocess_count').where('job_id', '=', job.id).execute();
      assert.ok(members.every(member => member.missing_reprocess_count === 0));
      const finished = await database.selectFrom('ai_jobs').select('status').where('id', '=', job.id).executeTakeFirstOrThrow();
      assert.equal(finished.status, 'ready_with_errors');
    } finally { await worker.stop(); }
  });

  for (const invalid of ['empty', 'missing', 'duplicate', 'unknown'] as const) {
    test(`attribute ${invalid} IDs reject the whole checkpoint and saved publication without partial writes`, async () => {
      const job = await missingJob();
      const batch = job.batches[0]!;
      const repository = new AiRepository(database);
      const claim = { workerId: 'attribute-completeness', attempt: 1n, token: 'complete-claim' };
      await database.updateTable('ai_job_batches').set({
        status: 'running', claimed_by: claim.workerId, attempts: claim.attempt, claim_token: claim.token,
        lease_until: new Date(Date.now() + 60_000),
      }).where('id', '=', batch.id).execute();
      await repository.prepareBatch(batch.id);
      assert.equal(await repository.reserveBatchRequest(batch.id, claim), 'reserved');
      const request = await repository.getTagExtractionBatchInputs(batch.id);
      assert.equal(request.inputs.length, 2);
      const decisions = request.inputs.map(input => ({ productId: input.productId, tags: [], rejectedTags: [],
        reviewed: true, complete: true, reviewDecisions: [] }));
      const items = invalid === 'empty' ? [] : invalid === 'missing' ? decisions.slice(0, 1)
        : invalid === 'duplicate' ? [decisions[0]!, decisions[0]!]
        : [decisions[0]!, { ...decisions[1]!, productId: 999999999n }];
      const batchBefore = await database.selectFrom('ai_job_batches').selectAll().where('id', '=', batch.id).executeTakeFirstOrThrow();
      const membersBefore = await database.selectFrom('ai_job_input_members').selectAll().where('job_id', '=', job.id).orderBy('product_id').execute();
      const productsBefore = await database.selectFrom('products').selectAll().where('id', 'in', membersBefore.map(member => member.product_id)).orderBy('id').execute();
      const cacheBefore = await database.selectFrom('catalog_cache_versions').selectAll().execute();
      await assert.rejects(repository.checkpointTagExtractionBatchDecision(job.id, batch.id, items, {}, claim, 'generate'), /does not match/);
      assert.deepEqual(await database.selectFrom('ai_job_batches').selectAll().where('id', '=', batch.id).executeTakeFirstOrThrow(), batchBefore);
      assert.equal(batchBefore.confirmed_requests, 0);
      await seedAttributePublication(database, batch.id, items);
      const saved = await database.selectFrom('ai_job_batches').selectAll().where('id', '=', batch.id).executeTakeFirstOrThrow();
      await assert.rejects(repository.publishTagExtractionBatch(batch.id, claim), /does not match/);
      await database.transaction().execute(tx => finalizeAiJob(tx, job.id));
      assert.deepEqual(await database.selectFrom('ai_job_batches').selectAll().where('job_id', '=', job.id).execute(), [saved]);
      assert.deepEqual(await database.selectFrom('ai_job_input_members').selectAll().where('job_id', '=', job.id).orderBy('product_id').execute(), membersBefore);
      assert.deepEqual(await database.selectFrom('products').selectAll().where('id', 'in', membersBefore.map(member => member.product_id)).orderBy('id').execute(), productsBefore);
      assert.deepEqual(await database.selectFrom('catalog_cache_versions').selectAll().execute(), cacheBefore);
      assert.equal((await database.selectFrom('ai_jobs').select('status').where('id', '=', job.id).executeTakeFirstOrThrow()).status, 'queued');
      await repository.cancelJob(job.id);
    });
  }
});

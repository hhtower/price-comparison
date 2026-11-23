import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Kysely, PostgresDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';
import { AiRepository } from '../src/ai/ai.repository.js';
import { AdminRepository } from '../src/admin/admin.repository.js';
import { createMembershipFeatureJob, previewTagJob, previewMembershipFeatureJob, previewProductTextReviewJob } from '../src/ai/tag-extraction-jobs.js';
import { parseStandardizationProtocolResponse } from '../src/ai/ai.schemas.js';
import { saveStandardizationThroughReview } from './standardization-review-fixture.js';
import { ProductsRepository } from '../src/products/products.repository.js';
import { StandardizationRepository } from '../src/standardization/standardization.repository.js';
import { productContentFingerprint } from '../src/standardization/fingerprint.js';
import { jsonb, type DatabaseSchema } from '../src/database/types.js';

let db: Kysely<DatabaseSchema>, admin: Pool, schema: string, repository: AiRepository;
before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL required');
  schema = `ai_offer_${randomUUID().replaceAll('-', '')}`;
  admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({
    connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public`, max: 4,
  }) }) });
  const migrated = await new Migrator({ db, provider: migrationProvider, migrationTableSchema: schema }).migrateToLatest();
  if (migrated.error) throw migrated.error;
  repository = new AiRepository(db);
});
after(async () => {
  await db?.destroy();
  if (schema) await admin?.query(`drop schema "${schema}" cascade`);
  await admin?.end();
});

async function seed() {
  const shop = await db.insertInto('shops').values({ platform: 'test', name: 'Inventory test', enabled: true,
    url: `https://${randomUUID()}.invalid` }).returning('id').executeTakeFirstOrThrow();
  const product = await db.insertInto('products').values({
    shop_id: shop.id, external_id: randomUUID(), name: 'ChatGPT Plus', source_name: 'ChatGPT Plus',
    source_description: 'Monthly subscription', source_data: jsonb({ evidence: 'Monthly subscription' }),
    spec: '', source_category: '', normalized_key: randomUUID(), url: 'https://example.invalid/item',
    content_version: 1n, content_fingerprint: productContentFingerprint({ name: 'ChatGPT Plus',
      description: 'Monthly subscription', spec: '', sourceData: { evidence: 'Monthly subscription' } }),
  }).returningAll().executeTakeFirstOrThrow();
  return product;
}
async function quote(productId: bigint, stock: boolean, capturedAt = new Date(), stale = false) {
  return db.insertInto('offers').values({ product_id: productId, price: '10', currency: 'CNY',
    idempotency_key: randomUUID(), stock_available: stock, is_stale: stale, captured_at: capturedAt })
    .returning('id').executeTakeFirstOrThrow();
}
async function catalog() {
  return db.insertInto('standard_products').values({ name: 'ChatGPT Plus', canonical_family: 'openai',
    canonical_product: 'chatgpt', canonical_tier: 'plus', verification_state: 'verified',
    catalog_definition: 'ChatGPT Plus subscriptions. Other tiers are excluded.' }).returning('id').executeTakeFirstOrThrow();
}
async function reserve(job: { id: bigint; batches: readonly { id: bigint }[] }) {
  const id = job.batches[0]!.id;
  await repository.prepareBatch(id);
  await db.updateTable('ai_jobs').set({ status: 'running' }).where('id', '=', job.id).execute();
  await db.updateTable('ai_job_batches').set({ status: 'running', claimed_by: 'test', attempts: 1n,
    claim_token: 'test-claim', lease_until: new Date(Date.now() + 60_000) }).where('id', '=', id).execute();
  return { id, claim: { workerId: 'test', attempt: 1n, token: 'test-claim' } };
}

test('identity creation excludes missing, sold-out and stale latest quotes', async () => {
  const missing = await seed(), sold = await seed(), stale = await seed(), available = await seed();
  await quote(sold.id, true, new Date(Date.now() - 10_000));
  await quote(sold.id, false);
  await quote(stale.id, true, new Date(), true);
  await quote(available.id, true);
  const job = await repository.createJob({ model: 'mock', productIds: [missing.id, sold.id, stale.id, available.id] });
  assert.equal(Number(job.total), 1);
  assert.deepEqual(job.inputs.map(input => input.productId), [available.id]);
});

test('latest offer wins even when captured_at ties', async () => {
  const product = await seed(), at = new Date();
  await quote(product.id, true, at);
  await quote(product.id, false, at);
  const job = await repository.createJob({ model: 'mock', productIds: [product.id] });
  assert.equal(Number(job.total), 0);
  assert.equal(job.batches.length, 0);
});

test('pending product summary distinguishes waiting for stock from missing model results', async () => {
  const product = await seed();
  await quote(product.id, false);
  const adminRepository = new AdminRepository(db);
  const waiting = await adminRepository.listProducts({ pending: true, shopId: product.shop_id, page: 1, limit: 20 });
  assert.equal(waiting.items.find(item => item.id === product.id)?.processing_summary?.reasonCode, 'offer_unavailable');
  await quote(product.id, true, new Date(Date.now() + 1000));
  const available = await adminRepository.listProducts({ pending: true, shopId: product.shop_id, page: 1, limit: 20 });
  assert.equal(available.items.find(item => item.id === product.id)?.processing_summary?.reasonCode, 'not_processed');
});

test('sellout after queue consumes no model budget and restock can register the same evidence again', async () => {
  const product = await seed();
  await catalog();
  await quote(product.id, true, new Date(Date.now() - 10_000));
  const job = await repository.createJob({ model: 'mock', productIds: [product.id], jobType: 'incremental' });
  const request = await reserve(job);
  await quote(product.id, false);
  assert.equal(await repository.reserveBatchRequest(request.id, request.claim), 'skipped');
  const batch = await db.selectFrom('ai_job_batches').select(['request_budget_used', 'status']).where('id', '=', request.id).executeTakeFirstOrThrow();
  assert.equal(batch.request_budget_used, 0);
  assert.equal(batch.status, 'succeeded');
  const member = await db.selectFrom('ai_job_input_members').select('reason_code').where('job_id', '=', job.id).executeTakeFirstOrThrow();
  assert.equal(member.reason_code, 'offer_unavailable');
  await quote(product.id, true, new Date(Date.now() + 1000));
  const resumed = await repository.createJob({ model: 'mock', productIds: [product.id], jobType: 'incremental' });
  assert.equal(Number(resumed.total), 1);
  const execution = await db.selectFrom('ai_standardization_executions').select('job_id').where('product_id', '=', product.id).executeTakeFirstOrThrow();
  assert.equal(execution.job_id, resumed.id);
});

test('sellout cannot erase an unresolved provider request and enable an automatic resend', async () => {
  const product = await seed();
  await quote(product.id, true, new Date(Date.now() - 10_000));
  const job = await repository.createJob({ model: 'mock', productIds: [product.id], jobType: 'incremental' });
  const request = await reserve(job);
  await db.updateTable('ai_job_batches').set({ request_budget_used: 1 }).where('id', '=', request.id).execute();
  await quote(product.id, false);
  await assert.rejects(repository.reserveBatchRequest(request.id, request.claim), /request_outcome_unknown/);
  await quote(product.id, true, new Date(Date.now() + 1000));
  const resumed = await repository.createJob({ model: 'mock', productIds: [product.id], jobType: 'incremental' });
  assert.equal(Number(resumed.total), 0);
});

test('a sold-out member of a shared identity input is deferred and never published with its available peer', async () => {
  const available = await seed(), sold = await seed();
  await catalog();
  await quote(available.id, true);
  await quote(sold.id, true, new Date(Date.now() - 10_000));
  const job = await repository.createJob({ model: 'mock', productIds: [available.id, sold.id], jobType: 'incremental' });
  assert.equal(job.inputs.length, 1, 'same evidence shares one input');
  const request = await reserve(job);
  await quote(sold.id, false);
  assert.equal(await repository.reserveBatchRequest(request.id, request.claim), 'refresh');
  const deferred = await db.selectFrom('ai_job_input_members').select(['status', 'reason_code'])
    .where('job_id', '=', job.id).where('product_id', '=', sold.id).executeTakeFirstOrThrow();
  assert.equal(deferred.reason_code, 'offer_unavailable');
  assert.equal(deferred.status, 'unclassified');
  await repository.prepareBatch(request.id);
  assert.equal(await repository.reserveBatchRequest(request.id, request.claim), 'reserved');
  const source = await repository.getBatchRequest(request.id);
  const input = source.inputs[0]!;
  const decision = parseStandardizationProtocolResponse({ items: [{
    id: String(input.productId), standardProductId: input.candidateStandardProductIds[0], nullReason: null,
    evidence: [{ path: 'name', quote: 'ChatGPT Plus' }],
  }] }, [{ id: String(input.productId), candidateStandardProductIds: input.candidateStandardProductIds }]);
  const reviewId = await saveStandardizationThroughReview(db, repository, {
    jobId: job.id, batchId: request.id, decision, claim: request.claim,
  });
  await db.updateTable('ai_job_batches').set({ status: 'running', claimed_by: request.claim.workerId,
    attempts: request.claim.attempt, claim_token: request.claim.token, lease_until: new Date(Date.now() + 60_000) })
    .where('id', '=', reviewId).execute();
  await repository.publishBatch(reviewId, request.claim);
  const assignments = await db.selectFrom('standard_product_members').select('product_id')
    .where('product_id', 'in', [available.id, sold.id]).execute();
  assert.deepEqual(assignments.map(row => row.product_id), [available.id]);
  assert.equal((await db.selectFrom('ai_standardization_results').select('reason_code')
    .where('job_id', '=', job.id).where('product_id', '=', sold.id).executeTakeFirstOrThrow()).reason_code, 'offer_unavailable');
});

test('a sold-out member of a shared attribute input gets a skipped output while its peer can proceed', async () => {
  const available = await seed(), sold = await seed(), standard = await catalog();
  for (const product of [available, sold]) {
    await quote(product.id, true, new Date(Date.now() - 10_000));
    await db.insertInto('standard_product_members').values({ product_id: product.id, standard_product_id: standard.id,
      publication_state: 'published', assignment_source: 'ai' }).execute();
  }
  const job = await db.transaction().execute(tx => createMembershipFeatureJob(tx, {
    model: 'mock', productIds: [available.id, sold.id],
  }));
  const inputs = await db.selectFrom('ai_job_inputs').select('input_id').where('job_id', '=', job.id).execute();
  assert.equal(inputs.length, 1);
  const batches = await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', job.id).execute();
  const request = await reserve({ id: job.id, batches });
  await quote(sold.id, false);
  assert.equal(await repository.reserveBatchRequest(request.id, request.claim), 'refresh');
  const deferred = await db.selectFrom('ai_job_input_members').select(['reason_code', 'output'])
    .where('job_id', '=', job.id).where('product_id', '=', sold.id).executeTakeFirstOrThrow();
  assert.equal(deferred.reason_code, 'offer_unavailable');
  assert.equal((deferred.output as { outcome: string }).outcome, 'skipped');
  await repository.prepareBatch(request.id);
  assert.equal(await repository.reserveBatchRequest(request.id, request.claim), 'reserved');
});

test('attribute previews exclude sold-out published products', async () => {
  const product = await seed(), standard = await catalog();
  await quote(product.id, false);
  await db.insertInto('standard_product_members').values({ standard_product_id: standard.id, product_id: product.id,
    publication_state: 'published', assignment_source: 'ai' }).execute();
  for (const preview of [previewTagJob, previewMembershipFeatureJob, previewProductTextReviewJob]) {
    const result = await preview(db, { model: 'mock', productIds: [product.id] });
    assert.equal(result.counts.eligible, 0);
    assert.equal(result.counts.requestBatches, 0);
  }
});

test('outbox claims wait for availability without incrementing attempts', async () => {
  const product = await seed();
  await quote(product.id, false);
  const event = await db.insertInto('product_change_events').values({ product_id: product.id, shop_id: product.shop_id,
    content_version: product.content_version, fingerprint: product.content_fingerprint, event_type: 'created', payload: jsonb({}) })
    .returning('id').executeTakeFirstOrThrow();
  const outbox = await db.insertInto('standardization_outbox').values({ product_id: product.id, event_id: event.id,
    fingerprint: product.content_fingerprint, status: 'queued' }).returning('id').executeTakeFirstOrThrow();
  const worker = new StandardizationRepository(db, repository);
  const claims = await worker.claimOutbox('stock-worker');
  assert.ok(!claims.some(claim => claim.id === outbox.id));
  assert.equal((await db.selectFrom('standardization_outbox').select('attempts').where('id', '=', outbox.id).executeTakeFirstOrThrow()).attempts, 0n);
  await quote(product.id, true, new Date(Date.now() + 1000));
  assert.ok((await worker.claimOutbox('stock-worker')).some(claim => claim.id === outbox.id));
});

test('stock-only replenishment preserves evidence and exposes a wakeup without content invalidation', async () => {
  const product = await seed();
  await quote(product.id, false);
  const changes = await db.transaction().execute(tx => new ProductsRepository(db).upsertFetchedProducts(tx, [{
    shopId: product.shop_id, externalId: product.external_id, name: product.name,
    sourceName: product.source_name, description: product.source_description, spec: '', sourceCategory: '',
    sourceData: { evidence: 'Monthly subscription' }, normalizedKey: product.normalized_key, url: product.url,
    price: '10', stockAvailable: true,
  }]));
  assert.deepEqual(changes.changedProducts, []);
  assert.deepEqual((changes as typeof changes & { restockedProducts: bigint[] }).restockedProducts, [product.id]);
  const current = await db.selectFrom('products').select(['content_version', 'content_fingerprint']).where('id', '=', product.id).executeTakeFirstOrThrow();
  assert.equal(current.content_version, product.content_version);
  assert.equal(current.content_fingerprint, product.content_fingerprint);
});

test('restock keeps a published identity and schedules only missing attribute work', async () => {
  const product = await seed(), standard = await catalog();
  await quote(product.id, true);
  await db.insertInto('standard_product_members').values({ standard_product_id: standard.id, product_id: product.id,
    publication_state: 'published', assignment_source: 'ai' }).execute();
  const worker = new StandardizationRepository(db, repository);
  const restore = async () => {
    const event = await db.insertInto('product_change_events').values({ product_id: product.id, shop_id: product.shop_id,
      content_version: product.content_version, fingerprint: product.content_fingerprint, event_type: 'restored', payload: jsonb({}) })
      .returning('id').executeTakeFirstOrThrow();
    const claim = await db.insertInto('standardization_outbox').values({ product_id: product.id, event_id: event.id,
      fingerprint: product.content_fingerprint, status: 'running', claimed_by: 'restore', attempts: 1n,
      claim_token: randomUUID(), lease_until: new Date(Date.now() + 60_000) }).returningAll().executeTakeFirstOrThrow();
    return worker.createIncrementalJob({ outbox: [claim], workerId: 'restore', priority: 50 });
  };
  const first = await restore();
  assert.ok(first);
  assert.equal(Number((await db.selectFrom('ai_jobs').select('total').where('id', '=', first.id).executeTakeFirstOrThrow()).total), 0);
  const before = await db.selectFrom('ai_job_input_members as m').innerJoin('ai_jobs as j', 'j.id', 'm.job_id')
    .select('j.id').where('m.product_id', '=', product.id).where('j.job_type', 'in', ['membership_features', 'tag_extraction', 'text_review']).execute();
  assert.ok(before.length > 0);
  await restore();
  const afterJobs = await db.selectFrom('ai_job_input_members as m').innerJoin('ai_jobs as j', 'j.id', 'm.job_id')
    .select('j.id').where('m.product_id', '=', product.id).where('j.job_type', 'in', ['membership_features', 'tag_extraction', 'text_review']).execute();
  assert.equal(afterJobs.length, before.length);
  assert.equal((await db.selectFrom('standard_product_members').select('standard_product_id').where('product_id', '=', product.id).executeTakeFirstOrThrow()).standard_product_id, standard.id);
});

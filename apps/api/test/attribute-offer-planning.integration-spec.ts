import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Kysely, PostgresDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';
import { AiRepository } from '../src/ai/ai.repository.js';
import {
  createTagJob, createMembershipFeatureJob, createProductTextReviewJob,
  createManualTagJob, createManualMembershipFeatureJob, createManualProductTextReviewJob,
  previewTagJob, previewMembershipFeatureJob, previewProductTextReviewJob,
} from '../src/ai/tag-extraction-jobs.js';
import { finalizeAiJob } from '../src/ai/standardization-finalizer.js';
import { StandardizationRepository } from '../src/standardization/standardization.repository.js';
import { productContentFingerprint } from '../src/standardization/fingerprint.js';
import { jsonb, type AttributeJobType, type DatabaseSchema } from '../src/database/types.js';

let db: Kysely<DatabaseSchema>, admin: Pool, schema: string;
const kinds = {
  tag_extraction: { create: createTagJob, preview: previewTagJob, manual: createManualTagJob },
  membership_features: { create: createMembershipFeatureJob, preview: previewMembershipFeatureJob, manual: createManualMembershipFeatureJob },
  text_review: { create: createProductTextReviewJob, preview: previewProductTextReviewJob, manual: createManualProductTextReviewJob },
};
const capture = (description: string) => ({
  unitId: 'listing', name: 'Captured account title', description,
  hash: createHash('sha256').update(description).digest('hex'),
});

before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL required');
  const url = new URL(process.env.TEST_DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'dedicated local PostgreSQL required');
  schema = `attribute_offer_${randomUUID().replaceAll('-', '')}`;
  admin = new Pool({ connectionString: url.href });
  await admin.query(`create schema "${schema}"`);
  db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({
    connectionString: url.href, options: `-c search_path=${schema},public`, max: 4,
  }) }) });
  const migrated = await new Migrator({ db, provider: migrationProvider, migrationTableSchema: schema }).migrateToLatest();
  if (migrated.error) throw migrated.error;
  process.env.AI_MODEL = 'mock';
  process.env.AI_TAG_EXTRACTION_ENABLED = 'true';
  process.env.AI_BATCH_MAX_INPUT_BYTES = '24576';
  process.env.AI_BATCH_MAX_INPUT_TOKENS = '6000';
});
after(async () => {
  await db?.destroy();
  if (schema) await admin?.query(`drop schema "${schema}" cascade`);
  await admin?.end();
});

async function fixture(body = 'Delivered monthly account.') {
  const shop = await db.insertInto('shops').values({
    platform: 'test', name: 'Attribute planning', enabled: true, url: `https://${randomUUID()}.invalid`,
  }).returningAll().executeTakeFirstOrThrow();
  const product = await db.insertInto('products').values({
    shop_id: shop.id, external_id: randomUUID(), name: 'ChatGPT Plus', source_name: 'ChatGPT Plus',
    source_description: '', source_data: jsonb({ ratingText: capture(body) }),
    spec: '', source_category: '', normalized_key: randomUUID(), url: 'https://example.invalid/item',
    content_version: 1n, content_fingerprint: productContentFingerprint({ name: 'ChatGPT Plus', spec: '' }),
  }).returningAll().executeTakeFirstOrThrow();
  await db.insertInto('offers').values({ product_id: product.id, price: '10', currency: 'CNY',
    idempotency_key: randomUUID(), stock_available: true, is_stale: false }).execute();
  const standard = await db.insertInto('standard_products').values({
    name: 'ChatGPT Plus', canonical_family: 'openai', canonical_product: 'chatgpt', canonical_tier: 'plus',
    verification_state: 'verified',
  }).returning('id').executeTakeFirstOrThrow();
  await db.insertInto('standard_product_members').values({
    standard_product_id: standard.id, product_id: product.id, publication_state: 'published', assignment_source: 'ai',
  }).execute();
  return product;
}

async function automatic(productId: bigint, kind: AttributeJobType) {
  const parent = await new AiRepository(db).createJob({ model: 'mock', productIds: [] });
  return db.transaction().execute(tx => kinds[kind].create(tx, {
    model: 'mock', productIds: [productId], parentIdentityJobId: parent.id,
  }));
}

async function failUnknown(jobId: bigint) {
  await db.updateTable('ai_job_batches').set({
    status: 'failed', error_source: 'request_outcome_unknown', error: 'response lost',
    request_budget_used: 1, unknown_requests: 1,
  }).where('job_id', '=', jobId).execute();
  await db.transaction().execute(tx => finalizeAiJob(tx, jobId));
}

async function restock(productId: bigint) {
  await db.updateTable('offers').set({ stock_available: false }).where('product_id', '=', productId).execute();
  await db.updateTable('offers').set({ stock_available: true }).where('product_id', '=', productId).execute();
  const product = await db.selectFrom('products').selectAll().where('id', '=', productId).executeTakeFirstOrThrow();
  const event = await db.insertInto('product_change_events').values({
    product_id: productId, shop_id: product.shop_id, content_version: product.content_version,
    fingerprint: product.content_fingerprint, event_type: 'restored', payload: jsonb({}),
  }).returning('id').executeTakeFirstOrThrow();
  const claim = await db.insertInto('standardization_outbox').values({
    product_id: productId, event_id: event.id, fingerprint: product.content_fingerprint,
    status: 'running', claimed_by: 'attribute-restock', attempts: 1n, claim_token: randomUUID(),
    lease_until: new Date(Date.now() + 60_000),
  }).returningAll().executeTakeFirstOrThrow();
  return new StandardizationRepository(db, new AiRepository(db)).createIncrementalJob({
    outbox: [claim], workerId: 'attribute-restock', priority: 50,
  });
}

function jobs(productId: bigint, kind: AttributeJobType) {
  return db.selectFrom('ai_jobs as j').innerJoin('ai_job_input_members as m', 'm.job_id', 'j.id')
    .select('j.id').where('m.product_id', '=', productId).where('j.job_type', '=', kind).orderBy('j.id').execute();
}

for (const kind of Object.keys(kinds) as AttributeJobType[]) {
  test(`${kind}: unknown terminal request blocks restock but permits explicit manual retry`, async () => {
    const product = await fixture();
    const original = await automatic(product.id, kind);
    await failUnknown(original.id);
    await restock(product.id);
    assert.deepEqual((await jobs(product.id, kind)).map(row => row.id), [original.id]);
    const scope = { model: 'mock', productIds: [product.id], retryOfJobId: original.id };
    const preview = await kinds[kind].preview(db, scope);
    assert.equal(preview.counts.eligible, 1);
    const retry = await kinds[kind].manual(db, { ...scope, requestId: randomUUID(), previewDigest: preview.previewDigest });
    assert.equal(retry.retry_of_job_id, original.id);
    assert.equal(retry.status, 'queued');
  });

  test(`${kind}: a changed content version can resume after an unknown request`, async () => {
    const product = await fixture();
    const original = await automatic(product.id, kind);
    await failUnknown(original.id);
    await db.updateTable('products').set({ content_version: 2n }).where('id', '=', product.id).execute();
    await restock(product.id);
    assert.equal((await jobs(product.id, kind)).length, 2);
  });
}

test('automatic scheduling uses the latest relevant outcome, not every historical unknown', async () => {
  const product = await fixture();
  const original = await automatic(product.id, 'tag_extraction');
  await failUnknown(original.id);
  const scope = { model: 'mock', productIds: [product.id], retryOfJobId: original.id };
  const preview = await previewTagJob(db, scope);
  const retry = await createManualTagJob(db, { ...scope, requestId: randomUUID(), previewDigest: preview.previewDigest });
  await db.updateTable('ai_job_batches').set({ status: 'failed', error_source: 'provider_error' })
    .where('job_id', '=', retry.id).execute();
  await db.transaction().execute(tx => finalizeAiJob(tx, retry.id));
  await restock(product.id);
  assert.equal((await jobs(product.id, 'tag_extraction')).length, 3);
});

test('a new captured text hash is a new source for automatic text review', async () => {
  const product = await fixture();
  await failUnknown((await automatic(product.id, 'text_review')).id);
  await db.updateTable('products').set({ source_data: jsonb({ ratingText: capture('Changed delivery conditions.') }) })
    .where('id', '=', product.id).execute();
  await restock(product.id);
  assert.equal((await jobs(product.id, 'text_review')).length, 2);
});

test('a changed shop source does not inherit an old unknown outcome', async () => {
  const product = await fixture();
  await failUnknown((await automatic(product.id, 'tag_extraction')).id);
  await db.updateTable('shops').set({ url: 'https://changed-source.invalid' }).where('id', '=', product.shop_id).execute();
  await restock(product.id);
  assert.equal((await jobs(product.id, 'tag_extraction')).length, 2);
});

for (const kind of ['text_review', 'tag_extraction'] as const) {
  test(`${kind}: a 13KB differing capture fits one transported copy and keeps the full snapshot`, async () => {
    const body = 'a'.repeat(13_000);
    const product = await fixture(body);
    const job = await automatic(product.id, kind);
    assert.equal(job.status, 'queued');
    const input = await db.selectFrom('ai_job_inputs').selectAll().where('job_id', '=', job.id).executeTakeFirstOrThrow();
    const payload = input.payload as any;
    assert.equal(payload.originalText.description, body);
    assert.equal(payload.shopText.description, body);
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) > 24_576);
    assert.ok(input.input_bytes > 13_000n && input.input_bytes < 14_000n);
    const batch = await db.selectFrom('ai_job_batches').selectAll().where('job_id', '=', job.id).executeTakeFirstOrThrow();
    assert.equal(batch.request_budget_used, 0);
    await new AiRepository(db).prepareBatch(batch.id);
    assert.ok((await db.selectFrom('ai_job_batches').select('request_estimate').where('id', '=', batch.id)
      .executeTakeFirstOrThrow()).request_estimate);
  });
}

test('membership planning counts encoded line overhead instead of the smaller frozen body', async () => {
  const product = await fixture('A\n'.repeat(600).trim());
  const job = await automatic(product.id, 'membership_features');
  assert.equal(job.status, 'ready_with_errors');
  const input = await db.selectFrom('ai_job_inputs').selectAll().where('job_id', '=', job.id).executeTakeFirstOrThrow();
  assert.equal(input.reason_code, 'input_too_large');
  assert.ok(Buffer.byteLength(JSON.stringify(input.payload)) < 6_000);
  assert.ok(input.input_bytes > 24_576n);
});

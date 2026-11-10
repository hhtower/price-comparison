import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Kysely, PostgresDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';
import { readAiTaskQueue } from '../src/ai/ai-task-queue.js';
import { pipelineVersionSnapshot } from '../src/ai/pipeline-versions.js';
import { STANDARDIZATION_PROMPT_VERSION } from '../src/ai/standardization-request.js';
import { jsonb, type AiJobType, type DatabaseSchema, type JsonValue } from '../src/database/types.js';
import { recordManualDecisions } from '../src/standardization/decision-history.js';
import { IDENTITY_POLICY_VERSION } from '../src/standardization/identity-policy.js';

let db: Kysely<DatabaseSchema>, admin: Pool;
const schema = `feature_queue_${randomUUID().replaceAll('-', '')}`;
before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'Dedicated TEST_DATABASE_URL required');
  assert.equal(new URL(process.env.TEST_DATABASE_URL).hostname, '127.0.0.1');
  admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({
    connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public`,
  }) }) });
  const { error } = await new Migrator({ db, provider: migrationProvider, migrationTableSchema: schema }).migrateToLatest();
  if (error) throw error;
});
after(async () => {
  await db?.destroy();
  if (admin) { await admin.query(`drop schema if exists "${schema}" cascade`); await admin.end(); }
});

async function fixture(count = 1) {
  const shop = await db.insertInto('shops').values({
    name: 'Feature queue', platform: 'test', url: `https://test.invalid/${randomUUID()}`,
  }).returningAll().executeTakeFirstOrThrow();
  const products = await db.insertInto('products').values(Array.from({ length: count }, (_, i) => ({
    shop_id: shop.id, external_id: String(i), name: 'ChatGPT Plus', spec: '', normalized_key: randomUUID(),
    url: `${shop.url}/${i}`, content_version: 1n, content_fingerprint: `source-${i}`,
  }))).returningAll().execute();
  return { shop, products };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function task(f: Fixture, jobType: AiJobType, outcome?: string, productIndex = 0) {
  const product = await db.selectFrom('products').selectAll()
    .where('id', '=', f.products[productIndex]!.id).executeTakeFirstOrThrow();
  const job = await db.insertInto('ai_jobs').values({
    job_type: jobType, model: 'mock', status: outcome ? 'succeeded' : 'running', total: 1n,
    scope_shop_id: f.shop.id, prompt_version: STANDARDIZATION_PROMPT_VERSION,
    rule_version: IDENTITY_POLICY_VERSION, pipeline_versions: jsonb(pipelineVersionSnapshot('mock')),
  }).returning('id').executeTakeFirstOrThrow();
  const payload = jsonb({ shopSource: { url: f.shop.url, protocol: f.shop.protocol, platform: f.shop.platform } });
  await db.insertInto('ai_job_inputs').values({
    job_id: job.id, input_id: product.id, fingerprint: product.content_fingerprint, payload,
  }).execute();
  await db.insertInto('ai_job_input_members').values({
    job_id: job.id, input_id: product.id, product_id: product.id, payload,
    content_version: product.content_version, standardization_revision: product.standardization_revision,
    fingerprint: product.content_fingerprint, status: outcome ? 'classified' : 'queued',
    output: outcome ? jsonb({ outcome, acceptedTags: [], rejectedTags: [],
      versions: { contentVersion: String(product.content_version), fingerprint: product.content_fingerprint,
        revision: String(product.standardization_revision) } }) : null,
  }).execute();
  return job.id;
}

async function assign(f: Fixture, index: number, publicationState: 'published' | 'provisional', human = false) {
  const standard = await db.insertInto('standard_products').values({
    name: 'ChatGPT Plus', canonical_family: 'openai', canonical_product: 'chatgpt', canonical_tier: 'plus',
    verification_state: 'verified',
  }).returning('id').executeTakeFirstOrThrow();
  await db.insertInto('standard_product_members').values({
    product_id: f.products[index]!.id, standard_product_id: standard.id, publication_state: publicationState,
    assignment_source: human ? 'human' : 'ai',
  }).execute();
}

test('feature eligibility includes raw and provisional products; tags require publication and both protect manual work', async () => {
  const f = await fixture(7);
  await assign(f, 1, 'provisional');
  await assign(f, 2, 'published');
  await assign(f, 3, 'published', true);
  await db.updateTable('products').set({ standardization_locked: true }).where('id', '=', f.products[4]!.id).execute();
  await db.updateTable('products').set({ deleted_at: new Date() }).where('id', '=', f.products[5]!.id).execute();
  await db.transaction().execute(tx => recordManualDecisions(tx, [f.products[6]!.id], {
    action: 'exclude', standardProductId: null, reason: 'Keep manual decision',
  }));
  for (const kind of ['membership_features', 'tag_extraction'] as const) {
    const queue = await readAiTaskQueue(db, { jobType: kind, status: 'all', scopeShopId: f.shop.id });
    assert.equal(queue.summary.pendingProducts, kind === 'membership_features' ? 3 : 1);
  }
  const featureId = await task(f, 'membership_features', 'empty');
  const tagId = await task(f, 'tag_extraction', 'empty', 1);
  const features = await readAiTaskQueue(db, { jobType: 'membership_features', status: 'all', scopeShopId: f.shop.id });
  assert.equal(features.summary.coveredProducts, 1);
  assert.equal(features.summary.pendingProducts, 2);
  assert.equal(features.items[0]!.id, String(featureId));
  assert.equal(features.items[0]!.jobType, 'membership_features');
  const tags = await readAiTaskQueue(db, { jobType: 'tag_extraction', status: 'all', scopeShopId: f.shop.id });
  assert.equal(tags.summary.coveredProducts, 0, 'provisional assignment is not tag coverage');
  assert.equal(tags.items[0]!.id, String(tagId), 'history remains visible');
  await db.updateTable('shops').set({ enabled: false }).where('id', '=', f.shop.id).execute();
  const disabled = await readAiTaskQueue(db, { jobType: 'membership_features', status: 'all', scopeShopId: f.shop.id });
  assert.equal(disabled.summary.pendingProducts, 0);
  assert.equal(disabled.summary.coveredProducts, 0);
  await db.updateTable('shops').set({ enabled: true, deleted_at: new Date() }).where('id', '=', f.shop.id).execute();
  assert.equal((await readAiTaskQueue(db, { jobType: 'membership_features', status: 'all',
    scopeShopId: f.shop.id })).summary.pendingProducts, 0);
});

test('only a newer current task of the same attribute kind supersedes feature coverage and attention', async () => {
  const f = await fixture();
  const first = await task(f, 'membership_features', 'empty');
  await task(f, 'tag_extraction', 'failed');
  const scope = { jobType: 'membership_features', scopeShopId: f.shop.id };
  let queue = await readAiTaskQueue(db, { ...scope, status: 'all' });
  assert.equal(queue.summary.coveredProducts, 1);
  assert.equal(queue.summary.pendingProducts, 0);
  const second = await task(f, 'membership_features', 'failed');
  const attention = await readAiTaskQueue(db, { ...scope, status: 'attention' });
  assert.deepEqual(attention.items.map(item => item.id), [String(second)]);
  queue = await readAiTaskQueue(db, { ...scope, status: 'all', limit: 1 });
  assert.equal(queue.summary.coveredProducts, 0);
  assert.equal(queue.summary.pendingProducts, 1);
  assert.equal(queue.summary.failedProducts, 1);
  assert.ok(queue.nextCursor);
  const next = await readAiTaskQueue(db, { ...scope, status: 'all', limit: 1, cursor: queue.nextCursor });
  assert.deepEqual(next.items.map(item => item.id), [String(first)]);
  assert.deepEqual(next.summary, queue.summary);
});

test('feature coverage excludes stale member versions, sources and pipeline configurations', async () => {
  const f = await fixture();
  const id = await task(f, 'membership_features', 'empty');
  const scope = { jobType: 'membership_features', status: 'all', scopeShopId: f.shop.id };
  for (const patch of [
    { content_version: 0n }, { fingerprint: 'old' }, { standardization_revision: 1n },
    { payload: jsonb({ shopSource: { url: 'https://other.invalid', protocol: null, platform: 'test' } }) },
  ]) {
    const original = await db.selectFrom('ai_job_input_members').selectAll().where('job_id', '=', id).executeTakeFirstOrThrow();
    await db.updateTable('ai_job_input_members').set(patch).where('job_id', '=', id).execute();
    const queue = await readAiTaskQueue(db, scope);
    assert.equal(queue.summary.coveredProducts, 0);
    assert.equal(queue.summary.pendingProducts, 1);
    await db.updateTable('ai_job_input_members').set({
      content_version: original.content_version, fingerprint: original.fingerprint,
      standardization_revision: original.standardization_revision, payload: jsonb(original.payload as JsonValue),
    }).where('job_id', '=', id).execute();
  }
  await db.updateTable('ai_jobs').set({ pipeline_versions: jsonb({}) }).where('id', '=', id).execute();
  const legacy = await readAiTaskQueue(db, scope);
  assert.equal(legacy.items[0]!.configurationCurrent, false);
  assert.equal(legacy.summary.coveredProducts, 0);
  assert.equal(legacy.summary.pendingProducts, 1);
});

test('identity queues exclude both attribute kinds without letting their newer members hide identity work', async () => {
  const f = await fixture();
  const identity = await task(f, 'manual_full');
  await task(f, 'tag_extraction');
  const feature = await task(f, 'membership_features');
  for (const jobType of [undefined, 'identity', 'manual_full']) {
    const queue = await readAiTaskQueue(db, { jobType, status: 'unfinished', scopeShopId: f.shop.id });
    assert.deepEqual(queue.items.map(item => item.id), [String(identity)]);
    assert.equal(queue.items[0]!.remaining, 1);
    assert.equal(queue.summary.pendingProducts, 1);
  }
  const features = await readAiTaskQueue(db, { jobType: 'membership_features', status: 'unfinished', scopeShopId: f.shop.id });
  assert.deepEqual(features.items.map(item => item.id), [String(feature)]);
  assert.equal(features.items[0]!.remaining, 1);
});

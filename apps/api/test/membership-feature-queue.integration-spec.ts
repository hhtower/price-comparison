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
import { captureRatingText } from '../src/platforms/source-evidence.js';
import { projectShopText } from '../src/shops/shop-text-review.js';

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
  const payload = jsonb({ shopSource: { url: f.shop.url, protocol: f.shop.protocol, platform: f.shop.platform },
    ...(jobType === 'text_review' ? { shopText: projectShopText(product.source_data) } : {}) });
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
  return standard.id;
}

test('feature queue admits only published verified AI identities and protects manual work', async () => {
  const f = await fixture(11);
  await assign(f, 1, 'provisional');
  await assign(f, 2, 'published');
  await assign(f, 3, 'published', true);
  for (const index of [4, 5, 6]) await assign(f, index, 'published');
  const nonAi = await assign(f, 7, 'published');
  await db.updateTable('standard_products').set({ canonical_tier: 'free' }).where('id', '=', nonAi).execute();
  const unverified = await assign(f, 8, 'published');
  await db.updateTable('standard_products').set({ verification_state: 'provisional' }).where('id', '=', unverified).execute();
  const unknown = await assign(f, 9, 'published');
  await db.updateTable('standard_products').set({ canonical_product: null }).where('id', '=', unknown).execute();
  const merged = await assign(f, 10, 'published');
  await db.updateTable('standard_products').set({ merged_into_id: nonAi }).where('id', '=', merged).execute();
  await db.updateTable('products').set({ standardization_locked: true }).where('id', '=', f.products[4]!.id).execute();
  await db.updateTable('products').set({ deleted_at: new Date() }).where('id', '=', f.products[5]!.id).execute();
  await db.transaction().execute(tx => recordManualDecisions(tx, [f.products[6]!.id], {
    action: 'exclude', standardProductId: null, reason: 'Keep manual decision',
  }));
  for (const kind of ['membership_features', 'tag_extraction'] as const) {
    const queue = await readAiTaskQueue(db, { jobType: kind, status: 'all', scopeShopId: f.shop.id });
    assert.equal(queue.summary.pendingProducts, kind === 'membership_features' ? 1 : 3);
  }
  const featureId = await task(f, 'membership_features', 'empty', 2);
  for (const index of [0, 1, 3, 4, 5, 6, 7, 8, 9, 10]) await task(f, 'membership_features', 'failed', index);
  const tagId = await task(f, 'tag_extraction', 'empty', 1);
  const features = await readAiTaskQueue(db, { jobType: 'membership_features', status: 'all', scopeShopId: f.shop.id });
  assert.equal(features.summary.coveredProducts, 1);
  assert.equal(features.summary.pendingProducts, 0);
  assert.equal(features.summary.failedProducts, 0);
  assert.equal(features.summary.attention, 0);
  assert.ok(features.items.some(item => item.id === String(featureId)));
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
  await assign(f, 0, 'published');
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
  await assign(f, 0, 'published');
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

test('identity queues exclude all attribute kinds without letting their newer members hide identity work', async () => {
  const f = await fixture();
  const identity = await task(f, 'manual_full');
  await task(f, 'tag_extraction');
  const feature = await task(f, 'membership_features');
  const text = await task(f, 'text_review');
  for (const jobType of [undefined, 'identity', 'manual_full']) {
    const queue = await readAiTaskQueue(db, { jobType, status: 'unfinished', scopeShopId: f.shop.id });
    assert.deepEqual(queue.items.map(item => item.id), [String(identity)]);
    assert.equal(queue.items[0]!.remaining, 1);
    assert.equal(queue.summary.pendingProducts, 1);
  }
  const features = await readAiTaskQueue(db, { jobType: 'membership_features', status: 'unfinished', scopeShopId: f.shop.id });
  assert.deepEqual(features.items.map(item => item.id), [String(feature)]);
  assert.equal(features.items[0]!.remaining, 0);
  assert.equal(features.summary.pendingProducts, 0);
  const texts = await readAiTaskQueue(db, { jobType: 'text_review', status: 'unfinished', scopeShopId: f.shop.id });
  assert.deepEqual(texts.items.map(item => item.id), [String(text)]);
  assert.equal(texts.summary.pendingProducts, 1);
});

for (const jobType of ['tag_extraction', 'membership_features'] as const) {
  test(`${jobType} incomplete partial outcomes need attention even without rejected tags`, async () => {
    const f = await fixture();
    await assign(f, 0, 'published');
    const partial = await task(f, jobType, 'partial_success');
    await db.updateTable('ai_job_input_members').set({
      output: jsonb({ outcome: 'partial_success', complete: false, successfulCount: 1, failedCount: 0,
        acceptedTags: [{ name: 'region', value: 'us', evidence: [] }], rejectedTags: [], reasonCode: 'incomplete' }),
    }).where('job_id', '=', partial).execute();
    await db.updateTable('ai_jobs').set({ status: 'ready_with_errors' }).where('id', '=', partial).execute();
    await task(f, 'text_review', 'updated');
    const queue = await readAiTaskQueue(db, { jobType, status: 'attention', scopeShopId: f.shop.id });
    assert.deepEqual(queue.items.map(item => item.id), [String(partial)]);
    assert.equal(queue.items[0]!.status, 'ready_with_errors');
    assert.equal(queue.items[0]!.unclassified, 1);
    assert.equal(queue.summary.attention, 1);
    assert.equal(queue.summary.reviewProducts, 1);
    assert.equal(queue.summary.failedProducts, 0);
    assert.equal(queue.summary.coveredProducts, 0);
    assert.equal(queue.summary.pendingProducts, 1);
    assert.equal(queue.summary.currentReasons.incomplete, 1);
  });
}

test('unfinished feature counts recheck current published AI identity and shop scope', async () => {
  const f = await fixture(3);
  const standard = await assign(f, 0, 'published');
  await assign(f, 1, 'provisional');
  const nonAi = await assign(f, 2, 'published');
  await db.updateTable('standard_products').set({ canonical_tier: 'free' }).where('id', '=', nonAi).execute();
  const ids = [];
  for (let index = 0; index < 3; index++) ids.push(await task(f, 'membership_features', undefined, index));
  const scope = { jobType: 'membership_features', status: 'unfinished', scopeShopId: f.shop.id };
  let queue = await readAiTaskQueue(db, scope);
  assert.equal(queue.summary.pendingProducts, 1);
  assert.equal(queue.items.find(item => item.id === String(ids[0]))!.remaining, 1);
  assert.equal(queue.items.find(item => item.id === String(ids[1]))!.remaining, 0);
  assert.equal(queue.items.find(item => item.id === String(ids[2]))!.remaining, 0);
  const other = await fixture();
  await assign(other, 0, 'published');
  const otherJob = await task(other, 'membership_features');
  const otherMember = await db.selectFrom('ai_job_input_members').selectAll().where('job_id', '=', otherJob).executeTakeFirstOrThrow();
  await db.insertInto('ai_job_input_members').values({ ...otherMember, job_id: ids[0], input_id: f.products[0].id,
    payload: jsonb(otherMember.payload as JsonValue) }).execute();
  assert.equal((await readAiTaskQueue(db, scope)).summary.pendingProducts, 1);
  await db.updateTable('standard_products').set({ canonical_tier: 'free' }).where('id', '=', standard).execute();
  queue = await readAiTaskQueue(db, scope);
  assert.equal(queue.summary.pendingProducts, 0);
  assert.equal(queue.items.find(item => item.id === String(ids[0]))!.remaining, 0);
});

test('text review history drops hash-stale coverage and ignores newer tasks for another capture', async () => {
  const f = await fixture();
  await assign(f, 0, 'published');
  const product = f.products[0]!;
  const original = captureRatingText('listing', product.name, 'Support provided.')!;
  await db.updateTable('products').set({ source_data: jsonb({ ratingText: original }) }).where('id', '=', product.id).execute();
  const completed = await task(f, 'text_review', 'updated');
  const scope = { jobType: 'text_review', status: 'all', scopeShopId: f.shop.id };
  let queue = await readAiTaskQueue(db, scope);
  assert.equal(queue.summary.coveredProducts, 1);
  assert.equal(queue.summary.pendingProducts, 0);

  const changed = captureRatingText('listing', product.name, 'Support  provided.')!;
  assert.notEqual(changed.hash, original.hash);
  const current = await db.updateTable('products').set({ source_data: jsonb({ ratingText: changed }) })
    .where('id', '=', product.id).returningAll().executeTakeFirstOrThrow();
  assert.equal(current.content_version, product.content_version);
  assert.equal(current.content_fingerprint, product.content_fingerprint);
  assert.equal(current.standardization_revision, product.standardization_revision);
  queue = await readAiTaskQueue(db, scope);
  assert.equal(queue.summary.coveredProducts, 0);
  assert.equal(queue.summary.pendingProducts, 1);
  assert.ok(queue.items.some(item => item.id === String(completed)), 'stale job history remains visible');

  const newer = await task(f, 'text_review');
  queue = await readAiTaskQueue(db, scope);
  assert.equal(queue.summary.pendingProducts, 0);
  assert.equal(queue.items.find(item => item.id === String(newer))!.remaining, 1);
  await db.updateTable('products').set({ source_data: jsonb({ ratingText: original }) }).where('id', '=', product.id).execute();
  queue = await readAiTaskQueue(db, scope);
  assert.equal(queue.summary.coveredProducts, 1, 'a newer hash-stale task cannot hide current successful coverage');
  assert.equal(queue.summary.pendingProducts, 0);
  assert.equal(queue.items.find(item => item.id === String(newer))!.remaining, 0);
  await db.updateTable('shops').set({ url: `${f.shop.url}/changed` }).where('id', '=', f.shop.id).execute();
  queue = await readAiTaskQueue(db, scope);
  assert.equal(queue.summary.coveredProducts, 0, 'a matching capture still requires its original shop source');
  assert.equal(queue.summary.pendingProducts, 1);
});

test('text review history excludes unavailable captures but accepts explicitly empty captured text', async () => {
  const f = await fixture();
  await assign(f, 0, 'published');
  const scope = { jobType: 'text_review', status: 'all', scopeShopId: f.shop.id };
  assert.equal((await readAiTaskQueue(db, scope)).summary.pendingProducts, 0, 'a product without captured text is not pending');
  const empty = captureRatingText('listing', '', '')!;
  for (const invalid of [null, 'invalid', [], {}, { ...empty, hash: 'invalid' },
    { ...empty, unitId: ' \t\n' }, { ...empty, name: 1 }, { ...empty, description: null },
    { ...empty, extra: true }]) {
    await db.updateTable('products').set({ source_data: jsonb({ ratingText: invalid }) }).where('id', '=', f.products[0]!.id).execute();
    assert.equal((await readAiTaskQueue(db, scope)).summary.pendingProducts, 0, JSON.stringify(invalid));
  }
  await db.updateTable('products').set({ source_data: jsonb({ ratingText: empty }) }).where('id', '=', f.products[0]!.id).execute();
  assert.equal((await readAiTaskQueue(db, scope)).summary.pendingProducts, 1);
});

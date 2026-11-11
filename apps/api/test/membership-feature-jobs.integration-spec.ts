import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { Kysely, PostgresDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';
import { jsonb, type DatabaseSchema, type JsonValue } from '../src/database/types.js';
import { recordManualDecisions } from '../src/standardization/decision-history.js';
import { buildMembershipFeatures } from '../src/standardization/membership-classification.js';
import { ProductsRepository } from '../src/products/products.repository.js';
import {
  createManualMembershipFeatureJob, createMembershipFeatureJob, previewMembershipFeatureJob,
  createManualTagJob, createTagJob, previewTagJob, prepareAllPendingTagJob,
} from '../src/ai/tag-extraction-jobs.js';
import { planIndependentStandardizationBatches } from '../src/ai/standardization-batch-planner.js';
import { readAiBatchLimits } from '../src/config/env.js';

let db: Kysely<DatabaseSchema>, admin: Pool, schema: string;
before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL required');
  schema = `membership_feature_jobs_${randomUUID().replaceAll('-', '')}`;
  admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({
    connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public`,
  }) }) });
  const { error } = await new Migrator({ db, provider: migrationProvider, migrationTableSchema: schema }).migrateToLatest();
  if (error) throw error;
});
beforeEach(async () => {
  await db.updateTable('shops').set({ enabled: false }).execute();
  await db.updateTable('ai_jobs').set({ status: 'cancelled' }).execute();
});
after(async () => {
  await db?.destroy();
  if (schema) await admin.query(`drop schema "${schema}" cascade`);
  await admin?.end();
});

async function fixture(count = 1, distinct = false, published = true) {
  const shop = await db.insertInto('shops').values({
    name: 'raw source', platform: 'test', url: `https://test.invalid/${randomUUID()}`,
  }).returningAll().executeTakeFirstOrThrow();
  const products = [];
  for (let offset = 0; offset < count; offset += 500) {
    products.push(...await db.insertInto('products').values(
      Array.from({ length: Math.min(count - offset, 500) }, (_, index) => ({
        shop_id: shop.id, external_id: String(offset + index),
        name: distinct ? (offset + index === count - 1 ? 'Steam game gift code' : `ChatGPT Plus account ${offset + index}`) : 'ChatGPT Plus account',
        normalized_key: randomUUID(), url: 'https://test.invalid/product',
        content_version: 1n, content_fingerprint: distinct ? `source-${offset + index}` : 'same-source',
      })),
    ).returningAll().execute());
  }
  const ids = products.map(p => p.id);
  const standardId = published ? await assign(ids) : null;
  return { shop, products, ids, standardId };
}
async function assign(ids: bigint[], publication: 'published' | 'provisional' = 'published', source = 'ai') {
  const standard = await db.insertInto('standard_products').values({
    name: 'legacy ChatGPT Plus', canonical_family: 'openai', canonical_product: 'chatgpt', canonical_tier: 'plus',
    verification_state: 'verified',
  }).returning('id').executeTakeFirstOrThrow();
  await db.insertInto('standard_product_members').values(ids.map(id => ({
    product_id: id, standard_product_id: standard.id, publication_state: publication, assignment_source: source,
  }))).execute();
  return standard.id;
}
async function prepare(jobId: bigint) {
  const batch = await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', jobId)
    .where('step', '=', 'prepare').executeTakeFirstOrThrow();
  const claim = { workerId: 'feature-test', attempt: 1n, token: randomUUID() };
  await db.updateTable('ai_job_batches').set({
    status: 'running', claimed_by: claim.workerId, attempts: claim.attempt, claim_token: claim.token,
    lease_until: new Date(Date.now() + 60000),
  }).where('id', '=', batch.id).execute();
  await prepareAllPendingTagJob(db, batch.id, claim);
  return db.selectFrom('ai_jobs').selectAll().where('id', '=', jobId).executeTakeFirstOrThrow();
}

test('published AI features deduplicate quote inputs and preserve their shared standard, parent and products', async () => {
  const f = await fixture(3);
  const preview = await previewMembershipFeatureJob(db, { productIds: f.ids, model: 'frozen-model' });
  assert.equal(preview.counts.eligible, 3);
  assert.equal(preview.counts.uniqueInputs, 1);
  assert.equal((await previewTagJob(db, { productIds: f.ids, model: 'frozen-model' })).counts.eligible, 3);
  const parent = await db.insertInto('ai_jobs').values({
    model: 'identity-model', total: 3n, job_type: 'manual_full', status: 'queued',
  }).returningAll().executeTakeFirstOrThrow();
  const job = await db.transaction().execute(tx => createMembershipFeatureJob(tx, {
    productIds: f.ids, model: 'frozen-model', parentIdentityJobId: parent.id,
  }));
  assert.equal(job.job_type, 'membership_features');
  assert.equal(job.model, 'frozen-model');
  assert.equal(job.parent_identity_job_id, parent.id);
  assert.equal(job.total, 3n);
  const inputs = await db.selectFrom('ai_job_inputs').selectAll().where('job_id', '=', job.id).execute();
  assert.equal(inputs.length, 1);
  const members = await db.selectFrom('ai_job_input_members').selectAll().where('job_id', '=', job.id).execute();
  assert.equal(members.length, 3);
  for (const member of members) {
    assert.equal(member.content_version, 1n);
    assert.equal(member.standardization_revision, 0n);
    assert.equal(member.fingerprint, 'same-source');
    assert.deepEqual(member.payload, { ...(inputs[0].payload as Record<string, JsonValue>), id: String(member.product_id) });
  }
  assert.deepEqual(await db.selectFrom('ai_jobs').selectAll().where('id', '=', parent.id).executeTakeFirstOrThrow(), parent);
  assert.deepEqual(await db.selectFrom('products').selectAll().where('id', 'in', f.ids).orderBy('id').execute(), f.products);
  assert.deepEqual((await db.selectFrom('standard_product_members').select('standard_product_id')
    .where('product_id', 'in', f.ids).execute()).map(member => member.standard_product_id),
  [f.standardId, f.standardId, f.standardId]);
  assert.equal((await db.selectFrom('product_tags').select('id').where('product_id', 'in', f.ids).execute()).length, 0);
});

test('provisional assignments and unverified standards cannot schedule features or tags', async () => {
  const f = await fixture(1, false, false);
  const id = await assign(f.ids, 'provisional');
  assert.equal((await previewMembershipFeatureJob(db, { productIds: f.ids, model: 'mock' })).counts.eligible, 0);
  assert.equal((await previewTagJob(db, { productIds: f.ids, model: 'mock' })).counts.eligible, 0);
  await db.updateTable('standard_product_members').set({ publication_state: 'published' }).where('product_id', 'in', f.ids).execute();
  await db.updateTable('standard_products').set({ verification_state: 'provisional' }).where('id', '=', id).execute();
  assert.equal((await previewMembershipFeatureJob(db, { productIds: f.ids, model: 'mock' })).counts.eligible, 0);
});

test('every feature entry point admits only published verified AI identities regardless of raw text', async () => {
  const f = await fixture(6, false, false);
  const names = ['ChatGPT Plus account', 'ChatGPT Plus account', 'ChatGPT Plus account',
    'ChatGPT Free account', 'unrecognized service package', 'Steam game gift code'];
  for (const [index, name] of names.entries()) {
    await db.updateTable('products').set({ name }).where('id', '=', f.ids[index]).execute();
  }
  await assign([f.ids[1]], 'provisional');
  const nonAi = await assign([f.ids[2]]);
  await db.updateTable('standard_products').set({ canonical_family: 'network', canonical_product: 'ip',
    canonical_tier: 'standard' }).where('id', '=', nonAi).execute();
  await assign(f.ids.slice(3));
  const input = { productIds: f.ids, model: 'mock' };
  const preview = await previewMembershipFeatureJob(db, input);
  assert.equal(preview.counts.selected, 6);
  assert.equal(preview.counts.missing, 0);
  assert.equal(preview.counts.protected, 3);
  assert.equal(preview.counts.eligible, 3);
  assert.equal((await previewMembershipFeatureJob(db, { scopeShopId: f.shop.id, model: 'mock' })).counts.eligible, 3);
  const manual = await createManualMembershipFeatureJob(db, {
    ...input, requestId: randomUUID(), previewDigest: preview.previewDigest,
  });
  const automatic = await db.transaction().execute(tx => createMembershipFeatureJob(tx, input));
  for (const job of [manual, automatic]) {
    assert.equal(job.total, 3n);
    assert.deepEqual((await db.selectFrom('ai_job_input_members').select('product_id').where('job_id', '=', job.id)
      .orderBy('product_id').execute()).map(member => member.product_id), f.ids.slice(3));
    await db.updateTable('ai_jobs').set({ status: 'cancelled' }).where('id', '=', job.id).execute();
  }
  const pending = await createManualMembershipFeatureJob(db, { allPending: true, model: 'mock', requestId: randomUUID() });
  assert.equal((await prepare(pending.id)).total, 3n);
  assert.deepEqual((await db.selectFrom('ai_job_input_members').select('product_id').where('job_id', '=', pending.id)
    .orderBy('product_id').execute()).map(member => member.product_id), f.ids.slice(3));
});

for (const [family, product, tier] of [
  ['openai', 'chatgpt', 'free'], ['google', 'email', 'standard'], ['network', 'ip', 'standard'],
]) {
  test(`verified non-membership ${family}/${product}/${tier} is excluded without making preview counts missing`, async () => {
    const f = await fixture(2, false, false);
    const standard = await assign([f.ids[0]]);
    await assign([f.ids[1]]);
    await db.updateTable('standard_products').set({
      canonical_family: family, canonical_product: product, canonical_tier: tier,
    }).where('id', '=', standard).execute();
    const preview = await previewMembershipFeatureJob(db, { productIds: f.ids, model: 'mock' });
    assert.equal(preview.counts.selected, 2);
    assert.equal(preview.counts.missing, 0);
    assert.equal(preview.counts.protected, 1);
    assert.equal(preview.counts.eligible, 1);
    assert.equal((await previewTagJob(db, { productIds: [f.ids[0]], model: 'mock' })).counts.eligible, 1);
    const automatic = await db.transaction().execute(tx => createMembershipFeatureJob(tx, { productIds: f.ids, model: 'mock' }));
    assert.deepEqual((await db.selectFrom('ai_job_input_members').select('product_id').where('job_id', '=', automatic.id).execute())
      .map(member => member.product_id), [f.ids[1]]);
    await db.updateTable('ai_jobs').set({ status: 'cancelled' }).where('id', '=', automatic.id).execute();
    const pending = await createManualMembershipFeatureJob(db, { allPending: true, model: 'mock', requestId: randomUUID() });
    assert.equal((await prepare(pending.id)).total, 1n);
    assert.deepEqual((await db.selectFrom('ai_job_input_members').select('product_id').where('job_id', '=', pending.id).execute())
      .map(member => member.product_id), [f.ids[1]]);
  });
}

test('unverified, incomplete and merged identities reject unknown raw feature inputs', async () => {
  const f = await fixture();
  await db.updateTable('products').set({ name: 'unrecognized service package' }).where('id', '=', f.ids[0]).execute();
  const standard = f.standardId!;
  await db.updateTable('standard_products').set({
    canonical_family: 'network', canonical_product: 'ip', canonical_tier: 'standard', verification_state: 'provisional',
  }).where('id', '=', standard).execute();
  assert.equal((await previewMembershipFeatureJob(db, { productIds: f.ids, model: 'mock' })).counts.eligible, 0);
  await db.updateTable('standard_products').set({ verification_state: 'verified', canonical_product: null }).where('id', '=', standard).execute();
  assert.equal((await previewMembershipFeatureJob(db, { productIds: f.ids, model: 'mock' })).counts.eligible, 0);
  const other = await fixture();
  await db.updateTable('standard_products').set({ canonical_family: 'openai', canonical_product: 'chatgpt',
    canonical_tier: 'plus', merged_into_id: other.standardId }).where('id', '=', standard).execute();
  assert.equal((await previewMembershipFeatureJob(db, { productIds: f.ids, model: 'mock' })).counts.eligible, 0);
});

test('an all-pending scope containing only confidently non-AI facts completes without request batches', async () => {
  const f = await fixture(1, false, false);
  await db.updateTable('products').set({ name: 'ChatGPT Free account' }).where('id', '=', f.ids[0]).execute();
  const pending = await createManualMembershipFeatureJob(db, { allPending: true, model: 'mock', requestId: randomUUID() });
  const done = await prepare(pending.id);
  assert.equal(done.total, 0n);
  assert.equal(done.status, 'succeeded');
  assert.equal((await db.selectFrom('ai_job_inputs').select('input_id').where('job_id', '=', pending.id).execute()).length, 0);
  assert.equal((await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', pending.id).where('step', '=', 'request').execute()).length, 0);
});

for (const protection of ['locked', 'deleted', 'disabled', 'deleted shop', 'human', 'manual']) {
  test(`feature scopes preserve ${protection} protection`, async () => {
    const f = await fixture();
    if (protection === 'locked') await db.updateTable('products').set({ standardization_locked: true }).where('id', '=', f.ids[0]).execute();
    if (protection === 'deleted') await db.updateTable('products').set({ deleted_at: new Date() }).where('id', '=', f.ids[0]).execute();
    if (protection === 'disabled') await db.updateTable('shops').set({ enabled: false }).where('id', '=', f.shop.id).execute();
    if (protection === 'deleted shop') await db.updateTable('shops').set({ deleted_at: new Date() }).where('id', '=', f.shop.id).execute();
    if (protection === 'human') await db.updateTable('standard_product_members').set({ assignment_source: 'human' })
      .where('product_id', 'in', f.ids).execute();
    if (protection === 'manual') await db.transaction().execute(tx =>
      recordManualDecisions(tx, f.ids, { action: 'quarantine', standardProductId: null, reason: 'review protected raw evidence' }));
    const p = await previewMembershipFeatureJob(db, { productIds: f.ids, model: 'mock' });
    assert.equal(p.counts.protected, 1);
    assert.equal(p.counts.eligible, 0);
    await assert.rejects(db.transaction().execute(tx => createMembershipFeatureJob(tx, { productIds: f.ids, model: 'mock' })),
      { code: 'AI_TAG_SCOPE_EMPTY' });
  });
}

test('manual features use digest idempotence and cannot replay tag requests or digests', async () => {
  const f = await fixture();
  const p = await previewMembershipFeatureJob(db, { productIds: f.ids, model: 'mock' });
  const tags = await previewTagJob(db, { productIds: f.ids, model: 'mock' });
  assert.notEqual(p.previewDigest, tags.previewDigest);
  const request = { productIds: f.ids, model: 'mock', requestId: randomUUID(), previewDigest: p.previewDigest };
  const [a, b] = await Promise.all([createManualMembershipFeatureJob(db, request), createManualMembershipFeatureJob(db, request)]);
  assert.equal(a.id, b.id);
  assert.equal(a.job_type, 'membership_features');
  assert.equal(a.parent_identity_job_id, null);
  await assert.rejects(createManualTagJob(db, { ...request, previewDigest: tags.previewDigest }), { code: 'AI_TAG_REQUEST_CONFLICT' });
  await assert.rejects(createManualMembershipFeatureJob(db, { ...request, requestId: randomUUID(), previewDigest: tags.previewDigest }),
    { code: 'AI_TAG_PREVIEW_STALE' });
  await assert.rejects(createManualMembershipFeatureJob(db, { ...request, requestId: randomUUID(), model: 'changed' }),
    { code: 'AI_TAG_PREVIEW_STALE' });
});

test('manual feature retries keep provenance and remain independent of the original identity parent', async () => {
  const f = await fixture(2);
  const parent = await db.insertInto('ai_jobs').values({ model: 'mock', total: 2n, job_type: 'manual_full', status: 'queued' })
    .returning('id').executeTakeFirstOrThrow();
  const feature = await db.transaction().execute(tx => createMembershipFeatureJob(tx, { model: 'mock', productIds: f.ids, parentIdentityJobId: parent.id }));
  const tag = await db.transaction().execute(tx => createTagJob(tx, { model: 'mock', productIds: f.ids }));
  await assert.rejects(previewMembershipFeatureJob(db, { productIds: [f.ids[0]], model: 'mock', retryOfJobId: tag.id }),
    { code: 'AI_TAG_RETRY_SOURCE_INVALID' });
  await assert.rejects(previewTagJob(db, { productIds: [f.ids[0]], model: 'mock', retryOfJobId: feature.id }),
    { code: 'AI_TAG_RETRY_SOURCE_INVALID' });
  const input = { productIds: [f.ids[0]], model: 'mock', retryOfJobId: feature.id };
  const p = await previewMembershipFeatureJob(db, input);
  const retry = await createManualMembershipFeatureJob(db, { ...input, requestId: randomUUID(), previewDigest: p.previewDigest });
  assert.equal(retry.job_type, 'membership_features');
  assert.equal(retry.retry_of_job_id, feature.id);
  assert.equal(retry.parent_identity_job_id, null);
  assert.equal(retry.total, 1n);
});

for (const identity of ['unassigned', 'provisional assignment', 'unverified standard', 'non-AI', 'unknown', 'merged']) {
  test(`all feature entry points and retries reject a now ${identity} identity`, async () => {
    const f = await fixture();
    const source = await db.transaction().execute(tx => createMembershipFeatureJob(tx, { model: 'mock', productIds: f.ids }));
    await db.updateTable('ai_jobs').set({ status: 'cancelled' }).where('id', '=', source.id).execute();
    if (identity === 'unassigned') await db.deleteFrom('standard_product_members').where('product_id', 'in', f.ids).execute();
    if (identity === 'provisional assignment') await db.updateTable('standard_product_members')
      .set({ publication_state: 'provisional' }).where('product_id', 'in', f.ids).execute();
    if (identity === 'unverified standard') await db.updateTable('standard_products')
      .set({ verification_state: 'provisional' }).where('id', '=', f.standardId!).execute();
    if (identity === 'non-AI') await db.updateTable('standard_products').set({ canonical_tier: 'free' }).where('id', '=', f.standardId!).execute();
    if (identity === 'unknown') await db.updateTable('standard_products').set({ canonical_product: null }).where('id', '=', f.standardId!).execute();
    if (identity === 'merged') {
      const target = await db.insertInto('standard_products').values({ name: 'merged target' }).returning('id').executeTakeFirstOrThrow();
      await db.updateTable('standard_products').set({ merged_into_id: target.id }).where('id', '=', f.standardId!).execute();
    }
    for (const retryOfJobId of [undefined, source.id]) {
      const scope = { productIds: f.ids, model: 'mock', retryOfJobId };
      const preview = await previewMembershipFeatureJob(db, scope);
      assert.equal(preview.counts.eligible, 0);
      assert.equal(preview.counts.protected, 1);
      await assert.rejects(createManualMembershipFeatureJob(db, { ...scope,
        requestId: randomUUID(), previewDigest: preview.previewDigest }), { code: 'AI_TAG_SCOPE_EMPTY' });
    }
    await assert.rejects(db.transaction().execute(tx => createMembershipFeatureJob(tx, { model: 'mock', productIds: f.ids })),
      { code: 'AI_TAG_SCOPE_EMPTY' });
    const pending = await createManualMembershipFeatureJob(db, { allPending: true, model: 'mock', requestId: randomUUID() });
    assert.equal((await prepare(pending.id)).total, 0n);
  });
}

test('one verified standard keeps all four quote kinds and deduplicates only identical evidence', async () => {
  const f = await fixture(5);
  const names = ['ChatGPT Plus account', 'ChatGPT Plus top up', 'ChatGPT Plus rental',
    'ChatGPT Plus short term', 'ChatGPT Plus account'];
  for (const [index, name] of names.entries()) await db.updateTable('products').set({ name })
    .where('id', '=', f.ids[index]).execute();
  const scope = { productIds: f.ids, model: 'mock' };
  const preview = await previewMembershipFeatureJob(db, scope);
  assert.equal(preview.counts.eligible, 5);
  assert.equal(preview.counts.uniqueInputs, 4);
  const job = await createManualMembershipFeatureJob(db, { ...scope, requestId: randomUUID(), previewDigest: preview.previewDigest });
  const members = await db.selectFrom('ai_job_input_members').select(['product_id', 'input_id', 'payload'])
    .where('job_id', '=', job.id).orderBy('product_id').execute();
  assert.equal(job.total, 5n);
  assert.deepEqual(members.map(member => member.product_id), f.ids);
  assert.equal(new Set(members.map(member => member.input_id)).size, 4);
  assert.equal(members[0].input_id, members[4].input_id);
  assert.deepEqual(members.map(member => (member.payload as Record<string, JsonValue>).name), names);
  assert.deepEqual((await db.selectFrom('standard_product_members').select('standard_product_id')
    .where('product_id', 'in', f.ids).execute()).map(member => member.standard_product_id), f.ids.map(() => f.standardId));
});

test('async all-pending preparation routes feature jobs and ignores tag completion', async () => {
  const f = await fixture(2);
  const tag = await db.transaction().execute(tx => createTagJob(tx, { productIds: f.ids, model: 'mock' }));
  await db.updateTable('ai_job_input_members').set({ status: 'classified', output: jsonb({ outcome: 'empty', acceptedTags: [] }) })
    .where('job_id', '=', tag.id).execute();
  await db.updateTable('ai_jobs').set({ status: 'succeeded' }).where('id', '=', tag.id).execute();
  const input = { allPending: true, model: 'feature-model', requestId: randomUUID() };
  const job = await createManualMembershipFeatureJob(db, input);
  assert.equal(job.job_type, 'membership_features');
  assert.equal(job.phase, 'preparing');
  assert.equal(job.total, 0n);
  const prepared = await prepare(job.id);
  assert.equal(prepared.total, 2n);
  assert.equal(prepared.model, 'feature-model');
  assert.equal((await db.selectFrom('ai_job_input_members').select('product_id').where('job_id', '=', job.id).execute()).length, 2);
  assert.ok((await db.selectFrom('ai_job_batches').select(['request_budget_used', 'confirmed_requests'])
    .where('job_id', '=', job.id).execute()).every(batch => batch.request_budget_used === 0 && batch.confirmed_requests === 0));
});

test('all-pending coalesces within its kind and rejects request aliases from another kind', async () => {
  const f = await fixture();
  const input = { allPending: true, model: 'mock', requestId: randomUUID() };
  const [feature, duplicate] = await Promise.all([
    createManualMembershipFeatureJob(db, input),
    createManualMembershipFeatureJob(db, { ...input, requestId: randomUUID() }),
  ]);
  assert.equal(feature.id, duplicate.id);
  const tag = await createManualTagJob(db, { ...input, requestId: randomUUID() });
  assert.notEqual(feature.id, tag.id);
  await assert.rejects(createManualTagJob(db, input), { code: 'AI_TAG_REQUEST_CONFLICT' });
  const alias = { ...input, requestId: randomUUID() };
  assert.equal((await createManualTagJob(db, alias)).id, tag.id);
  await assert.rejects(createManualMembershipFeatureJob(db, alias), { code: 'AI_TAG_REQUEST_CONFLICT' });
});

test('active feature work suppresses only current feature members in all-pending selection', async () => {
  const f = await fixture(2);
  await db.transaction().execute(tx => createTagJob(tx, { model: 'mock', productIds: [f.ids[0]] }));
  await db.transaction().execute(tx => createMembershipFeatureJob(tx, { model: 'mock', productIds: [f.ids[1]] }));
  const pending = await createManualMembershipFeatureJob(db, { allPending: true, model: 'mock', requestId: randomUUID() });
  await prepare(pending.id);
  const members = await db.selectFrom('ai_job_input_members').select('product_id').where('job_id', '=', pending.id).execute();
  assert.deepEqual(members.map(member => member.product_id), [f.ids[0]]);
});

test('current feature snapshots suppress automatic work while stale and missing snapshots do not', async () => {
  const f = await fixture(4);
  const current = buildMembershipFeatures([], f.products[0], [], 'short_term');
  await db.updateTable('products').set({ membership_features: jsonb(current as unknown as JsonValue) }).where('id', '=', f.ids[0]).execute();
  await db.updateTable('products').set({
    membership_features: jsonb({ ...current, contentVersion: '0' } as unknown as JsonValue),
  }).where('id', '=', f.ids[1]).execute();
  await db.updateTable('products').set({
    membership_features: jsonb({ ...current, policyVersion: 'old' } as unknown as JsonValue),
  }).where('id', '=', f.ids[2]).execute();
  const pending = await createManualMembershipFeatureJob(db, { allPending: true, model: 'mock', requestId: randomUUID() });
  await prepare(pending.id);
  const members = await db.selectFrom('ai_job_input_members').select('product_id').where('job_id', '=', pending.id).orderBy('product_id').execute();
  assert.deepEqual(members.map(member => member.product_id), f.ids.slice(1));
  await db.updateTable('ai_jobs').set({ status: 'cancelled' }).where('id', '=', pending.id).execute();
  const automatic = await db.transaction().execute(tx => createMembershipFeatureJob(tx, { model: 'mock', productIds: f.ids }));
  assert.equal(automatic.total, 3n);
  assert.deepEqual((await db.selectFrom('ai_job_input_members').select('product_id')
    .where('job_id', '=', automatic.id).orderBy('product_id').execute()).map(member => member.product_id), f.ids.slice(1));
  await assert.rejects(db.transaction().execute(tx =>
    createMembershipFeatureJob(tx, { model: 'mock', productIds: [f.ids[0]] })), { code: 'AI_TAG_SCOPE_EMPTY' });
});

test('successful feature output without a saved current snapshot remains pending', async () => {
  const f = await fixture();
  const feature = await db.transaction().execute(tx => createMembershipFeatureJob(tx, { model: 'mock', productIds: f.ids }));
  await db.updateTable('ai_job_input_members').set({ status: 'classified', output: jsonb({ outcome: 'empty', acceptedTags: [] }) })
    .where('job_id', '=', feature.id).execute();
  await db.updateTable('ai_jobs').set({ status: 'succeeded' }).where('id', '=', feature.id).execute();
  const pending = await createManualMembershipFeatureJob(db, { allPending: true, model: 'mock', requestId: randomUUID() });
  assert.equal((await prepare(pending.id)).total, 1n);
});

for (const changed of ['name', 'spec', 'source_data'] as const) {
  test(`feature selection waits for identity republication after ${changed} invalidates the snapshot`, async () => {
    const f = await fixture();
    f.products[0]!.name = `ChatGPT Plus fingerprint ${changed}`;
    await db.updateTable('products').set({ name: f.products[0]!.name }).where('id', '=', f.ids[0]).execute();
    await db.updateTable('products').set({
      membership_features: jsonb(buildMembershipFeatures([], f.products[0], [], 'short_term') as unknown as JsonValue),
    }).where('id', '=', f.ids[0]).execute();
    const updated = await new ProductsRepository(db).update(f.ids[0]!, changed === 'source_data'
      ? { sourceData: { evidence: 'new subscription terms' } } : { [changed]: 'changed evidence' });
    assert.notEqual(updated?.content_fingerprint, f.products[0]!.content_fingerprint);
    assert.equal((await previewMembershipFeatureJob(db, { productIds: f.ids, model: 'mock' })).counts.eligible, 0);
    await assert.rejects(db.transaction().execute(tx => createMembershipFeatureJob(tx, { model: 'mock', productIds: f.ids })),
      { code: 'AI_TAG_SCOPE_EMPTY' });
    await assign(f.ids);
    const pending = await createManualMembershipFeatureJob(db, { allPending: true, model: 'mock', requestId: randomUUID() });
    assert.equal((await prepare(pending.id)).total, 1n);
    await db.updateTable('ai_jobs').set({ status: 'cancelled' }).where('id', '=', pending.id).execute();
    const automatic = await db.transaction().execute(tx => createMembershipFeatureJob(tx, { model: 'mock', productIds: f.ids }));
    assert.equal(automatic.total, 1n);
  });
}

for (const stale of ['pipeline', 'source', 'revision', 'version', 'fingerprint']) {
  test(`obsolete active feature ${stale} does not suppress current all-pending work`, async () => {
    const f = await fixture();
    const active = await db.transaction().execute(tx => createMembershipFeatureJob(tx, { model: 'mock', productIds: f.ids }));
    if (stale === 'pipeline') await db.updateTable('ai_jobs').set({ pipeline_versions: jsonb({}) }).where('id', '=', active.id).execute();
    if (stale === 'source') await db.updateTable('shops').set({ url: 'https://changed.invalid' }).where('id', '=', f.shop.id).execute();
    if (stale === 'revision') await db.updateTable('products').set({ standardization_revision: 2n }).where('id', '=', f.ids[0]).execute();
    if (stale === 'version') await db.updateTable('products').set({ content_version: 2n }).where('id', '=', f.ids[0]).execute();
    if (stale === 'fingerprint') await db.updateTable('products').set({ content_fingerprint: 'changed' }).where('id', '=', f.ids[0]).execute();
    const pending = await createManualMembershipFeatureJob(db, { allPending: true, model: 'mock', requestId: randomUUID() });
    assert.equal((await prepare(pending.id)).total, 1n);
  });
}

test('oversized standalone features record a terminal local failure without creating identity work', async () => {
  const f = await fixture();
  await db.updateTable('products').set({ name: 'x'.repeat(100000) }).where('id', '=', f.ids[0]).execute();
  const input = { productIds: f.ids, model: 'mock' };
  const preview = await previewMembershipFeatureJob(db, input);
  assert.equal(preview.counts.oversized, 1);
  const job = await createManualMembershipFeatureJob(db, { ...input, previewDigest: preview.previewDigest, requestId: randomUUID() });
  assert.equal(job.job_type, 'membership_features');
  assert.equal(job.parent_identity_job_id, null);
  assert.equal(job.status, 'ready_with_errors');
  assert.equal((await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', job.id).execute()).length, 0);
  assert.equal((await db.selectFrom('ai_job_input_members').select('reason_code').where('job_id', '=', job.id).executeTakeFirstOrThrow()).reason_code, 'input_too_large');
});

test('large published feature scopes preserve independent batching and existing batch limits', async () => {
  const f = await fixture(1002, true);
  const job = await db.transaction().execute(tx => createMembershipFeatureJob(tx, { model: 'mock', productIds: f.ids }));
  const inputs = await db.selectFrom('ai_job_inputs').selectAll().where('job_id', '=', job.id).orderBy('input_id').execute();
  assert.equal(inputs.length, 1002);
  const expected = planIndependentStandardizationBatches(inputs.map(input => ({
    productId: input.input_id, payload: input.payload, inputBytes: Number(input.input_bytes), estimatedTokens: Number(input.estimated_tokens),
  })), readAiBatchLimits());
  const actual = await db.selectFrom('ai_job_batches').select('product_ids').where('job_id', '=', job.id).orderBy('batch_index').execute();
  assert.deepEqual(actual.map(batch => batch.product_ids), expected.map(batch => batch.productIds.map(String)));
  assert.deepEqual(actual.find(batch => (batch.product_ids as string[]).includes(String(f.ids.at(-1))))?.product_ids, [String(f.ids.at(-1))]);
});

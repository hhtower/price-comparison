import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { migrateToLatest } from '../scripts/migrate.js';
import { AiRepository } from '../src/ai/ai.repository.js';
import { createMembershipFeatureJob, createManualMembershipFeatureJob, previewMembershipFeatureJob } from '../src/ai/tag-extraction-jobs.js';
import { validateReviewedTagExtractionDecision, type TagExtractionDecision } from '../src/ai/tag-extraction-result.js';
import type { MembershipKind } from '@price-comparison/catalog/membership-policy';
import { jsonb, type DatabaseSchema } from '../src/database/types.js';
import { buildCanonicalStandardKey } from '../src/standardization/canonical-key.js';
import { readCurrentMembershipFeatures } from '../src/standardization/membership-classification.js';
import { productContentFingerprint } from '../src/standardization/fingerprint.js';
import { saveStandardizationThroughReview } from './standardization-review-fixture.js';
import { ProductsRepository } from '../src/products/products.repository.js';
import { JobsRepository } from '../src/jobs/jobs.repository.js';
import { ShopsRepository } from '../src/shops/shops.repository.js';

let db: Kysely<DatabaseSchema>, admin: Pool;
const schema = `membership_${randomUUID().replaceAll('-', '')}`;
const previous = { ...process.env };

before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'Dedicated TEST_DATABASE_URL required');
  admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({
    connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public`,
  }) }) });
  process.env.PG_SCHEMA = schema;
  process.env.CATALOG_VERSION_BUMP_MIN_INTERVAL_MS = '0';
  await migrateToLatest(db);
});

after(async () => {
  await db?.destroy();
  if (admin) { await admin.query(`drop schema if exists "${schema}" cascade`); await admin.end(); }
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  Object.assign(process.env, previous);
});

async function fixture(name = 'ChatGPT Plus 成品账号 质保28天') {
  const shop = await db.insertInto('shops').values({ name: 'membership test', platform: 'test', url: `https://test.invalid/${randomUUID()}` })
    .returning('id').executeTakeFirstOrThrow();
  const product = await db.insertInto('products').values({
    shop_id: shop.id, external_id: '1', name, spec: '', normalized_key: randomUUID(), url: 'https://test.invalid/product',
    source_data: jsonb({}), content_version: 1n, content_fingerprint: productContentFingerprint({ name, spec: '' }),
  }).returningAll().executeTakeFirstOrThrow();
  const identity = { family: 'openai', product: 'chatgpt', tier: 'plus' };
  const key = buildCanonicalStandardKey(identity);
  let standard = await db.selectFrom('standard_products').select('id').where('standard_key', '=', key).executeTakeFirst();
  standard ??= await db.insertInto('standard_products').values({
    name: 'ChatGPT Plus', canonical_family: identity.family, canonical_product: identity.product,
    canonical_tier: identity.tier, standard_key: key, verification_state: 'verified',
  }).returning('id').executeTakeFirstOrThrow();
  await db.insertInto('standard_product_members').values({ product_id: product.id, standard_product_id: standard.id,
    assignment_source: 'ai', publication_state: 'provisional' }).execute();
  return { product, baseId: standard.id, repo: new AiRepository(db) };
}

async function featureTask(productId: bigint, existingId?: bigint, reserve = true) {
  const repo = new AiRepository(db);
  const job = existingId ? await db.selectFrom('ai_jobs').selectAll().where('id', '=', existingId).executeTakeFirstOrThrow()
    : await db.transaction().execute(tx => createMembershipFeatureJob(tx, { model: 'mock', productIds: [productId] }));
  const batch = await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', job.id).executeTakeFirstOrThrow();
  const claim = { workerId: 'membership-test', token: randomUUID(), attempt: 1n };
  await db.updateTable('ai_job_batches').set({ status: 'running', claimed_by: claim.workerId,
    claim_token: claim.token, attempts: claim.attempt, lease_until: new Date(Date.now() + 60_000) }).where('id', '=', batch.id).execute();
  await repo.prepareBatch(batch.id);
  const input = await db.selectFrom('ai_job_input_members').select(['input_id', 'payload'])
    .where('job_id', '=', job.id).where('product_id', '=', productId).executeTakeFirstOrThrow();
  if (reserve) assert.equal(await repo.reserveBatchRequest(batch.id, claim), 'reserved');
  return { repo, job, batch, claim, input };
}

async function rerunFeatures(productId: bigint) {
  const input = { model: 'mock', productIds: [productId] };
  const preview = await previewMembershipFeatureJob(db, input);
  const job = await createManualMembershipFeatureJob(db, { ...input, requestId: randomUUID(), previewDigest: preview.previewDigest });
  return featureTask(productId, job.id);
}

function reviewedFeature(task: Awaited<ReturnType<typeof featureTask>>, kind: MembershipKind,
  tags: TagExtractionDecision['tags'] = [{ name: 'delivery', value: 'account', evidence: [{ path: 'name', quote: '成品账号' }] }]) {
  return { ...validateReviewedTagExtractionDecision(task.input.input_id,
    tags.map((tag, proposalIndex) => ({ ...tag, proposalIndex })), [], task.input.payload, tags.map(() => true), null),
    membershipKind: kind, classificationReviewed: true };
}

async function saveFeature(task: Awaited<ReturnType<typeof featureTask>>, kind: MembershipKind, classificationReviewed = true,
  tags?: TagExtractionDecision['tags']) {
  const reviewed = reviewedFeature(task, kind, tags);
  await db.updateTable('ai_job_batches').set({ step: 'publish' }).where('id', '=', task.batch.id).execute();
  await task.repo.persistTagExtractionBatchDecision(task.job.id, task.batch.id,
    [{ ...reviewed, membershipKind: kind, classificationReviewed }], {}, task.claim, 'publish');
}

async function publishIdentity(f: Awaited<ReturnType<typeof fixture>>, existingJob?: Awaited<ReturnType<AiRepository['createJob']>>,
  expectedStatus: 'classified' | 'unclassified' = 'classified') {
  const product = await db.selectFrom('products').selectAll().where('id', '=', f.product.id).executeTakeFirstOrThrow();
  const repo = f.repo;
  const job = existingJob ?? await repo.createJob({ model: 'mock', productIds: [product.id] });
  const batchId = job.batches[0]!.id;
  const claim = { workerId: 'membership-test', attempt: 1n, token: randomUUID() };
  await db.updateTable('ai_job_batches').set({ status: 'running', attempts: 1n, claimed_by: claim.workerId,
    claim_token: claim.token, lease_until: new Date(Date.now() + 60_000) }).where('id', '=', batchId).execute();
  await repo.prepareBatch(batchId);
  assert.equal(await repo.reserveBatchRequest(batchId, claim), 'reserved');
  const evidence = [{ path: 'name', quote: product.name }];
  const identity = { family: 'openai', product: 'chatgpt', tier: 'plus' };
  const publishBatch = await saveStandardizationThroughReview(db, repo, {
    jobId: job.id, batchId, claim,
    decision: { identities: [{ ...identity, ref: 'plus', canonicalKey: buildCanonicalStandardKey(identity), evidence, reason: 'same identity' }],
      items: [{ id: String(product.id), status: 'classified', identity: { kind: 'new', ref: 'plus', canonicalKey: buildCanonicalStandardKey(identity) },
        evidence, ruleIds: [], reason: 'same identity', reasonCode: null }], missingIds: [] },
  });
  await db.updateTable('ai_job_batches').set({ status: 'running', attempts: 1n, claimed_by: claim.workerId,
    claim_token: claim.token, lease_until: new Date(Date.now() + 60_000) }).where('id', '=', publishBatch).execute();
  await repo.publishBatch(publishBatch, claim);
  const result = await db.selectFrom('ai_standardization_results').select(['status', 'reason_code', 'reason'])
    .where('job_id', '=', job.id).where('product_id', '=', product.id).executeTakeFirstOrThrow();
  assert.equal(result.status, expectedStatus, JSON.stringify(result));
  return job;
}

test('feature review precedes identity and every membership kind keeps the same ChatGPT Plus standard', async () => {
  const standardIds = new Set<bigint>();
  for (const kind of ['account', 'top_up', 'rental', 'short_term'] as const) {
    const f = await fixture();
    const parent = await f.repo.createJob({ model: 'mock', productIds: [f.product.id] });
    const child = await db.selectFrom('ai_jobs').select('id').where('parent_identity_job_id', '=', parent.id)
      .where('job_type', '=', 'membership_features').executeTakeFirstOrThrow();
    const task = await featureTask(f.product.id, child.id);
    const parentBatch = await db.selectFrom('ai_job_batches').select('request_budget_used').where('job_id', '=', parent.id).execute();
    assert.ok(parentBatch.length > 0 && parentBatch.every(batch => batch.request_budget_used === 0));
    await saveFeature(task, kind);
    const before = await db.selectFrom('standard_product_members').selectAll().where('product_id', '=', f.product.id).executeTakeFirstOrThrow();
    assert.equal(before.standard_product_id, f.baseId);
    assert.equal(before.publication_state, 'provisional');
    await publishIdentity(f, parent);
    const member = await db.selectFrom('standard_product_members').selectAll().where('product_id', '=', f.product.id).executeTakeFirstOrThrow();
    assert.equal(member.standard_product_id, f.baseId);
    assert.equal(member.publication_state, 'published');
    standardIds.add(member.standard_product_id);
    const product = await db.selectFrom('products').selectAll().where('id', '=', f.product.id).executeTakeFirstOrThrow();
    assert.equal(readCurrentMembershipFeatures(product.membership_features, product)?.decision.kind, kind);
    const result = await db.selectFrom('ai_job_input_members').select('output').where('job_id', '=', task.job.id).executeTakeFirstOrThrow();
    assert.equal((result.output as Record<string, unknown>).proposedMembershipKind, kind);
    assert.equal((result.output as Record<string, unknown>).classificationReviewed, true);
    assert.equal((await db.selectFrom('product_tags').select('id').where('product_id', '=', product.id).execute()).length, 0);
  }
  assert.equal(standardIds.size, 1);
  assert.equal((await db.selectFrom('standard_products').select('id').where('canonical_family', '=', 'openai')
    .where('canonical_product', '=', 'chatgpt').where('canonical_tier', '=', 'plus').execute()).length, 1);
});

test('changing features on a published SKU updates the snapshot and catalog without rerunning identity', async () => {
  const f = await fixture();
  const initial = await featureTask(f.product.id);
  await saveFeature(initial, 'account');
  await publishIdentity(f);
  const published = await db.selectFrom('standard_product_members').selectAll().where('product_id', '=', f.product.id).executeTakeFirstOrThrow();
  const version = await db.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow();
  const identityResults = await db.selectFrom('ai_standardization_results').selectAll().where('product_id', '=', f.product.id).execute();
  const next = await rerunFeatures(f.product.id);
  await saveFeature(next, 'rental');
  const current = await db.selectFrom('standard_product_members').selectAll().where('product_id', '=', f.product.id).executeTakeFirstOrThrow();
  assert.deepEqual(current, published);
  assert.deepEqual(await db.selectFrom('ai_standardization_results').selectAll().where('product_id', '=', f.product.id).execute(), identityResults);
  const product = await db.selectFrom('products').selectAll().where('id', '=', f.product.id).executeTakeFirstOrThrow();
  assert.equal(readCurrentMembershipFeatures(product.membership_features, product)?.decision.kind, 'rental');
  const changed = await db.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow();
  assert.ok(changed.version > version.version);
  const rejected = await rerunFeatures(f.product.id);
  await saveFeature(rejected, 'short_term', false);
  assert.deepEqual((await db.selectFrom('products').select('membership_features')
    .where('id', '=', f.product.id).executeTakeFirstOrThrow()).membership_features, product.membership_features);
  assert.deepEqual(await db.selectFrom('standard_product_members').selectAll().where('product_id', '=', f.product.id).executeTakeFirstOrThrow(), published);
  assert.deepEqual(await db.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow(), changed);
});

test('post-publication tags cannot overwrite the approved membership snapshot or standard association', async () => {
  const f = await fixture();
  await saveFeature(await featureTask(f.product.id), 'rental');
  const parent = await publishIdentity(f);
  const product = await db.selectFrom('products').selectAll().where('id', '=', f.product.id).executeTakeFirstOrThrow();
  const member = await db.selectFrom('standard_product_members').selectAll().where('product_id', '=', f.product.id).executeTakeFirstOrThrow();
  const child = await db.selectFrom('ai_jobs').select('id').where('parent_identity_job_id', '=', parent.id)
    .where('job_type', '=', 'tag_extraction').executeTakeFirstOrThrow();
  const task = await featureTask(product.id, child.id);
  const reviewed = validateReviewedTagExtractionDecision(task.input.input_id, [], [], task.input.payload, [], null);
  await f.repo.persistTagExtractionBatchDecision(task.job.id, task.batch.id, [reviewed], {}, task.claim);
  assert.deepEqual((await db.selectFrom('products').select('membership_features')
    .where('id', '=', product.id).executeTakeFirstOrThrow()).membership_features, product.membership_features);
  assert.deepEqual(await db.selectFrom('standard_product_members').selectAll().where('product_id', '=', product.id).executeTakeFirstOrThrow(), member);
});

test('rejected feature review never saves features or changes publication state', async () => {
  const f = await fixture();
  const task = await featureTask(f.product.id);
  await saveFeature(task, 'account', false);
  const product = await db.selectFrom('products').select('membership_features').where('id', '=', f.product.id).executeTakeFirstOrThrow();
  const member = await db.selectFrom('standard_product_members').selectAll().where('product_id', '=', f.product.id).executeTakeFirstOrThrow();
  assert.equal(product.membership_features, null);
  assert.equal(member.standard_product_id, f.baseId);
  assert.equal(member.publication_state, 'provisional');
  const output = await db.selectFrom('ai_job_input_members').select('output').where('job_id', '=', task.job.id).executeTakeFirstOrThrow();
  assert.equal((output.output as Record<string, unknown>).classificationReviewed, false);
});

for (const step of ['request', 'publish'] as const) {
  for (const rejected of ['unreviewed', 'classification_unreviewed', 'missing_kind', 'invalid_kind'] as const) {
    test(`${step}: ${rejected} feature decision never saves a snapshot`, async () => {
      const f = await fixture();
      const task = await featureTask(f.product.id);
      const decision: TagExtractionDecision = reviewedFeature(task, 'account');
      if (rejected === 'unreviewed') { delete decision.reviewed; delete decision.textReview; }
      else if (rejected === 'classification_unreviewed') delete decision.classificationReviewed;
      else if (rejected === 'missing_kind') delete decision.membershipKind;
      else decision.membershipKind = 'unknown' as MembershipKind;
      await db.updateTable('ai_job_batches').set({ step }).where('id', '=', task.batch.id).execute();
      if (rejected === 'invalid_kind') {
        await assert.rejects(f.repo.persistTagExtractionBatchDecision(task.job.id, task.batch.id, [decision], {}, task.claim, step),
          { message: 'Reviewed membership kind is required' });
      } else await f.repo.persistTagExtractionBatchDecision(task.job.id, task.batch.id, [decision], {}, task.claim, step);
      assert.equal((await db.selectFrom('products').select('membership_features')
        .where('id', '=', f.product.id).executeTakeFirstOrThrow()).membership_features, null);
      const result = await db.selectFrom('ai_job_input_members').select(['status', 'reason_code'])
        .where('job_id', '=', task.job.id).executeTakeFirstOrThrow();
      assert.equal(result.status, rejected === 'invalid_kind' ? 'queued' : 'failed');
      assert.equal(result.reason_code, rejected === 'invalid_kind' ? null : 'classification_review_rejected');
      const member = await db.selectFrom('standard_product_members').select(['standard_product_id', 'publication_state'])
        .where('product_id', '=', f.product.id).executeTakeFirstOrThrow();
      assert.deepEqual(member, { standard_product_id: f.baseId, publication_state: 'provisional' });
    });
  }
}

test('completed feature dependency does not gate identity publication on a surviving snapshot', async () => {
  const f = await fixture();
  const parent = await f.repo.createJob({ model: 'mock', productIds: [f.product.id] });
  const child = await db.selectFrom('ai_jobs').select('id').where('parent_identity_job_id', '=', parent.id)
    .where('job_type', '=', 'membership_features').executeTakeFirstOrThrow();
  await saveFeature(await featureTask(f.product.id, child.id), 'account');
  await db.updateTable('products').set({ membership_features: null }).where('id', '=', f.product.id).execute();
  await publishIdentity(f, parent);
  const member = await db.selectFrom('standard_product_members').select(['standard_product_id', 'publication_state'])
    .where('product_id', '=', f.product.id).executeTakeFirstOrThrow();
  assert.deepEqual(member, { standard_product_id: f.baseId, publication_state: 'published' });
  assert.equal((await db.selectFrom('products').select('membership_features')
    .where('id', '=', f.product.id).executeTakeFirstOrThrow()).membership_features, null);
});

test('feature child remains a prerequisite for identity work when it is cancelled', async () => {
  const f = await fixture();
  const parent = await f.repo.createJob({ model: 'mock', productIds: [f.product.id] });
  const child = await db.selectFrom('ai_jobs').select('id').where('parent_identity_job_id', '=', parent.id)
    .where('job_type', '=', 'membership_features').executeTakeFirstOrThrow();
  await f.repo.cancelJob(child.id);
  const batches = await db.selectFrom('ai_job_batches').select(['status', 'request_budget_used', 'error_source'])
    .where('job_id', '=', parent.id).execute();
  assert.ok(batches.every(batch => batch.status === 'failed' && batch.request_budget_used === 0 && batch.error_source === 'membership_features_failed'));
});

test('cancelled and stale feature tasks never become implicit short-term classifications', async () => {
  const f = await fixture();
  const cancelled = await featureTask(f.product.id);
  await f.repo.cancelJob(cancelled.job.id);
  assert.equal((await db.selectFrom('standard_product_members').select('publication_state').where('product_id', '=', f.product.id).executeTakeFirstOrThrow()).publication_state, 'provisional');
  const stale = await featureTask(f.product.id);
  await db.updateTable('products').set({ name: 'ChatGPT Plus 代充 质保30天', content_version: f.product.content_version + 1n,
    content_fingerprint: productContentFingerprint({ name: 'ChatGPT Plus 代充 质保30天', spec: '' }) }).where('id', '=', f.product.id).execute();
  await f.repo.persistTagExtractionBatchDecision(stale.job.id, stale.batch.id,
    [reviewedFeature(stale, 'account', [])], {}, stale.claim);
  const product = await db.selectFrom('products').selectAll().where('id', '=', f.product.id).executeTakeFirstOrThrow();
  assert.equal(product.membership_features, null);
  assert.equal((await db.selectFrom('standard_product_members').select('publication_state').where('product_id', '=', product.id).executeTakeFirstOrThrow()).publication_state, 'provisional');
});

test('feature provider refusal stays out of the identity retry pool', async () => {
  const f = await fixture();
  const parent = await f.repo.createJob({ model: 'mock', productIds: [f.product.id] });
  const child = await db.selectFrom('ai_jobs').select('id').where('parent_identity_job_id', '=', parent.id)
    .where('job_type', '=', 'membership_features').executeTakeFirstOrThrow();
  const task = await featureTask(f.product.id, child.id);
  await new JobsRepository(db).fail('ai_batch', task.batch.id, task.claim.workerId, 'provider refused',
    { retry: false, retryClass: 'provider_policy_rejection' });
  const result = await db.selectFrom('ai_standardization_results').select('reason_code')
    .where('job_id', '=', parent.id).where('product_id', '=', f.product.id).executeTakeFirstOrThrow();
  assert.equal(result.reason_code, 'provider_policy_rejection');
  assert.ok(!(await f.repo.listRetryPool({ limit: 100 })).items.some(row => row.productId === String(f.product.id)));
});

test('a shop source change invalidates features and blocks identity work with stale evidence', async () => {
  const f = await fixture();
  const parent = await f.repo.createJob({ model: 'mock', productIds: [f.product.id] });
  const child = await db.selectFrom('ai_jobs').select('id').where('parent_identity_job_id', '=', parent.id)
    .where('job_type', '=', 'membership_features').executeTakeFirstOrThrow();
  const task = await featureTask(f.product.id, child.id);
  await saveFeature(task, 'account', true, [
      { name: 'delivery', value: 'account', evidence: [{ path: 'name', quote: '成品账号' }] },
      { name: 'warranty_days', value: '28', evidence: [{ path: 'name', quote: '质保28天' }] },
    ]);
  const snapshot = await db.selectFrom('products').select('membership_features').where('id', '=', f.product.id).executeTakeFirstOrThrow();
  assert.ok((snapshot.membership_features as { source?: unknown }).source);
  await new ShopsRepository(db).update(f.product.shop_id, { url: `https://changed.invalid/${randomUUID()}` });
  await publishIdentity(f, parent, 'unclassified');
  const product = await db.selectFrom('products').selectAll().where('id', '=', f.product.id).executeTakeFirstOrThrow();
  assert.equal(product.membership_features, null);
  assert.equal((await db.selectFrom('standard_product_members').select('product_id')
    .where('product_id', '=', product.id).where('publication_state', '=', 'published').execute()).length, 0);
});

test('a claimed feature batch rechecks its paused parent before reserving a request', async () => {
  const f = await fixture();
  const parent = await f.repo.createJob({ model: 'mock', productIds: [f.product.id] });
  const child = await db.selectFrom('ai_jobs').select('id').where('parent_identity_job_id', '=', parent.id)
    .where('job_type', '=', 'membership_features').executeTakeFirstOrThrow();
  const task = await featureTask(f.product.id, child.id, false);
  await f.repo.pauseJob(parent.id);
  assert.equal(await f.repo.reserveBatchRequest(task.batch.id, task.claim), 'skipped');
  const batch = await db.selectFrom('ai_job_batches').select(['status', 'request_budget_used', 'claimed_by'])
    .where('id', '=', task.batch.id).executeTakeFirstOrThrow();
  assert.deepEqual(batch, { status: 'queued', request_budget_used: 0, claimed_by: null });
  await new JobsRepository(db).complete('ai_batch', task.batch.id, task.claim.workerId);
  await f.repo.resumeJob(parent.id);
  await featureTask(f.product.id, child.id);
  await f.repo.cancelJob(parent.id);
});

for (const change of ['shop_source', 'product_shop'] as const) {
  test(`${change}: feature invalidation preserves the human identity assignment and review`, async () => {
    const f = await fixture();
    const task = await featureTask(f.product.id);
    await saveFeature(task, 'account', true, [
        { name: 'delivery', value: 'account', evidence: [{ path: 'name', quote: '成品账号' }] },
        { name: 'warranty_days', value: '28', evidence: [{ path: 'name', quote: '质保28天' }] },
      ]);
    await publishIdentity(f);
    const member = await db.selectFrom('standard_product_members').select('standard_product_id')
      .where('product_id', '=', f.product.id).executeTakeFirstOrThrow();
    await new ProductsRepository(db).assignStandardProduct(f.product.id, member.standard_product_id);
    const audit = await db.selectFrom('product_standardization_decisions').selectAll().where('product_id', '=', f.product.id).execute();
    const before = await db.selectFrom('products').select('standardization_revision').where('id', '=', f.product.id).executeTakeFirstOrThrow();
    if (change === 'shop_source') await new ShopsRepository(db).update(f.product.shop_id, { url: `https://changed.invalid/${randomUUID()}` });
    else {
      const next = await db.insertInto('shops').values({ name: 'moved source', platform: 'test', url: `https://moved.invalid/${randomUUID()}` })
        .returning('id').executeTakeFirstOrThrow();
      await db.updateTable('products').set({ shop_id: next.id }).where('id', '=', f.product.id).execute();
    }
    assert.deepEqual(await db.selectFrom('product_standardization_decisions').selectAll().where('product_id', '=', f.product.id).execute(), audit);
    assert.equal((await db.selectFrom('products').select('standardization_revision').where('id', '=', f.product.id)
      .executeTakeFirstOrThrow()).standardization_revision, before.standardization_revision + 1n);
    assert.equal((await db.selectFrom('standard_product_members').select('publication_state').where('product_id', '=', f.product.id)
      .executeTakeFirstOrThrow()).publication_state, 'published');
    assert.equal((await db.selectFrom('products').select('membership_features')
      .where('id', '=', f.product.id).executeTakeFirstOrThrow()).membership_features, null);
  });
}

for (const path of ['fetch', 'batch', 'update'] as const) {
  test(`${path}: independent sale warranty changes invalidate membership evidence`, async () => {
    const f = await fixture('ChatGPT Plus 成品账号');
    await db.updateTable('products').set({ source_data: jsonb({ warranty_info: '质保28天' }) }).where('id', '=', f.product.id).execute();
    const task = await featureTask(f.product.id);
    const tags = [
      { name: 'delivery', value: 'account', evidence: [{ path: 'name', quote: '成品账号' }] },
      { name: 'warranty_days', value: '28', evidence: [{ path: 'sourceData.warranty_info', quote: '质保28天' }] },
    ];
    await saveFeature(task, 'account', true, tags);
    const features = await db.selectFrom('products').selectAll().where('id', '=', f.product.id).executeTakeFirstOrThrow();
    assert.ok(readCurrentMembershipFeatures(features.membership_features, features),
      JSON.stringify((await db.selectFrom('ai_job_input_members').select('output').where('job_id', '=', task.job.id).execute())));
    await publishIdentity(f);
    const before = await db.selectFrom('products').selectAll().where('id', '=', f.product.id).executeTakeFirstOrThrow();
    assert.equal(readCurrentMembershipFeatures(before.membership_features, before)?.decision.kind, 'account');
    const products = new ProductsRepository(db);
    const input = { shopId: before.shop_id, externalId: before.external_id, name: before.name, spec: before.spec,
      normalizedKey: before.normalized_key, url: before.url, sourceData: { warranty_info: '无质保' } };
    if (path === 'fetch') await db.transaction().execute(tx => products.upsertFetchedProducts(tx, [input]));
    else if (path === 'batch') await products.upsertBatch([input]);
    else await products.update(before.id, { sourceData: input.sourceData });
    const after = await db.selectFrom('products').selectAll().where('id', '=', before.id).executeTakeFirstOrThrow();
    assert.equal(after.content_version, before.content_version + 1n);
    assert.equal(readCurrentMembershipFeatures(after.membership_features, after), null);
    assert.equal((await db.selectFrom('standard_product_members').select('product_id')
      .where('product_id', '=', before.id).where('publication_state', '=', 'published').execute()).length, 0);
  });
}

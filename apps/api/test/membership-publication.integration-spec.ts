import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { migrateToLatest } from '../scripts/migrate.js';
import { AiRepository } from '../src/ai/ai.repository.js';
import { createOpenAiModelCall } from '../src/ai/ai.worker.js';
import { getJobProgress } from '../src/ai/ai-progress.repository.js';
import { buildMembershipFeatureRequest, buildMembershipFeatureReviewRequest } from '../src/ai/membership-feature-request.js';
import { estimateStandardizationRequest } from '../src/ai/standardization-request.js';
import { createMembershipFeatureJob, createManualMembershipFeatureJob, createTagJob, previewMembershipFeatureJob } from '../src/ai/tag-extraction-jobs.js';
import { extractionPayloadKey } from '../src/ai/adaptive-batching.js';
import { createHash } from 'node:crypto';
import { validateReviewedTagExtractionDecision, type TagExtractionDecision } from '../src/ai/tag-extraction-result.js';
import type { MembershipKind } from '@price-comparison/catalog/membership-policy';
import { jsonb, type DatabaseSchema, type JsonValue } from '../src/database/types.js';
import { buildCanonicalStandardKey } from '../src/standardization/canonical-key.js';
import { buildMembershipFeatures, readCurrentMembershipFeatures } from '../src/standardization/membership-classification.js';
import { productContentFingerprint } from '../src/standardization/fingerprint.js';
import { saveStandardizationThroughReview } from './standardization-review-fixture.js';
import { ProductsRepository } from '../src/products/products.repository.js';
import { JobsRepository, type ClaimedJob } from '../src/jobs/jobs.repository.js';
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
  tags: TagExtractionDecision['tags'] = []): TagExtractionDecision {
  return { productId: task.input.input_id, tags, rejectedTags: [], reviewed: true,
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

test('compact feature batch streams extraction and mixed review through real checkpoints, budgets and publication', async t => {
  const limits = { AI_REQUEST_MAX_BYTES: '131072', AI_REQUEST_MAX_CONTEXT_TOKENS: '65536',
    AI_REQUEST_OUTPUT_RESERVE_TOKENS: '256', AI_BATCH_MAX_ITEMS: '32' };
  const saved = Object.fromEntries(Object.keys(limits).map(key => [key, process.env[key]]));
  Object.assign(process.env, limits);
  t.after(() => { for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const accepted = await fixture('ChatGPT Plus 成品账号 质保28天');
  const rejected = await fixture('ChatGPT Plus 成品账号 质保7天');
  const ids = [accepted.product.id, rejected.product.id];
  const repo = accepted.repo;
  const job = await db.transaction().execute(tx => createMembershipFeatureJob(tx, { model: 'mock', productIds: ids }));
  const batches = () => db.selectFrom('ai_job_batches').selectAll().where('job_id', '=', job.id).orderBy('batch_index').execute();
  const snapshots = () => db.selectFrom('products').select('membership_features').where('id', 'in', ids).orderBy('id').execute();
  const initial = await batches();
  assert.equal(initial.length, 1);
  assert.deepEqual(initial[0]!.product_ids, ids.map(String), 'distinct inputs must share the extraction batch');
  const extraction = { items: [
    { id: String(rejected.product.id), membershipKind: 'rental' },
    { id: String(accepted.product.id), membershipKind: 'account' },
  ] };
  const review = { items: [
    { id: String(accepted.product.id), classificationDecision: true },
    { id: String(rejected.product.id), classificationDecision: false },
  ] };
  async function claimBatch(batchId: bigint): Promise<ClaimedJob> {
    const batch = await db.updateTable('ai_job_batches').set({ status: 'running', claimed_by: 'feature-stream-test',
      claim_token: randomUUID(), attempts: 1n, lease_until: new Date(Date.now() + 60_000) })
      .where('id', '=', batchId).returningAll().executeTakeFirstOrThrow();
    return { kind: 'ai_batch', id: batch.id, attempts: batch.attempts, claimed_by: batch.claimed_by!,
      lease_until: batch.lease_until!, row: { ...batch, job_type: 'membership_features' } };
  }
  const claimToken = (claimed: ClaimedJob) => ({
    workerId: claimed.claimed_by, attempt: claimed.attempts, token: String(claimed.row.claim_token),
  });
  let sends = 0;
  let batchId = initial[0]!.id;
  for (const stage of ['extract', 'review'] as const) {
    const claimed = await claimBatch(batchId);
    const frozen = await repo.getTagExtractionBatchInputs(batchId);
    assert.equal(frozen.stage, stage);
    assert.equal(frozen.inputs.length, 2);
    const payloads = frozen.inputs.map(input => ({ ...(input.payload as Record<string, JsonValue>),
      id: String(input.productId), name: input.name, spec: input.spec, sourceData: input.sourceData }));
    const built = stage === 'extract' ? buildMembershipFeatureRequest(payloads, 'mock')
      : buildMembershipFeatureReviewRequest(payloads, frozen.proposals!, 'mock');
    const estimate = estimateStandardizationRequest(built);
    if (stage === 'review') {
      assert.deepEqual(JSON.parse(built.messages[1]!.content).proposals, extraction);
      // Fit exactly the compact request, so the repository cannot budget a different review prompt.
      process.env.AI_REQUEST_MAX_BYTES = String(estimate.requestBytes);
    }
    await repo.prepareBatch(batchId);
    const planned = await batches();
    assert.equal(planned.length, stage === 'extract' ? 1 : 2, 'review must not split a fitting two-product batch');
    const batch = planned.find(row => row.id === batchId)!;
    assert.deepEqual(batch.product_ids, ids.map(String));
    assert.deepEqual(batch.request_estimate, estimate);
    assert.equal(await repo.reserveBatchRequest(batchId, claimToken(claimed)), 'reserved');
    const call = createOpenAiModelCall(repo, { ...process.env, AI_BASE_URL: 'https://mock.invalid/v1',
      AI_API_KEY: 'mock-only', AI_MODEL: 'mock' }, async (_url, init) => {
      sends++;
      const request = JSON.parse(String(init?.body));
      assert.equal(request.stream, true);
      assert.deepEqual(request.messages, built.messages);
      assert.equal(Buffer.byteLength(String(init?.body)), estimate.requestBytes);
      const content = JSON.stringify(stage === 'extract' ? extraction : review);
      return new Response([
        { choices: [{ delta: { content: content.slice(0, 25) } }] },
        { choices: [{ delta: { content: content.slice(25) }, finish_reason: 'stop' }] },
      ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
    });
    const result = await call(claimed, new AbortController().signal);
    assert.equal(result.tagExtractionStage, stage);
    assert.deepEqual(result.tagExtractionItems?.map(item => ({
      id: String(item.productId), kind: item.membershipKind, tags: item.tags, rejectedTags: item.rejectedTags,
      ...(stage === 'review' ? { reviewed: item.reviewed, approved: item.classificationReviewed } : {}),
    })).sort((a, b) => a.id.localeCompare(b.id)), [
      { id: String(accepted.product.id), kind: 'account', tags: [], rejectedTags: [],
        ...(stage === 'review' ? { reviewed: true, approved: true } : {}) },
      { id: String(rejected.product.id), kind: 'rental', tags: [], rejectedTags: [],
        ...(stage === 'review' ? { reviewed: true, approved: false } : {}) },
    ].sort((a, b) => a.id.localeCompare(b.id)));
    await repo.checkpointTagExtractionBatchDecision(job.id, batchId, result.tagExtractionItems!,
      result.metadata, claimToken(claimed), result.tagExtractionStage);
    assert.deepEqual(await snapshots(), [{ membership_features: null }, { membership_features: null }]);
    assert.ok((await db.selectFrom('ai_job_input_members').select('output').where('job_id', '=', job.id).execute())
      .every(member => member.output === null));
    const checkpointed = await batches();
    assert.equal(checkpointed.length, 2);
    assert.equal(checkpointed.find(row => row.id === batchId)!.confirmed_requests, 1);
    batchId = checkpointed[1]!.id;
  }
  assert.equal(sends, 2);
  const publish = await claimBatch(batchId);
  await repo.publishTagExtractionBatch(batchId, claimToken(publish));
  const products = await db.selectFrom('products').selectAll().where('id', 'in', ids).orderBy('id').execute();
  assert.deepEqual(readCurrentMembershipFeatures(products[0]!.membership_features, products[0]!)?.decision,
    { kind: 'account', reason: 'llm_reviewed' });
  assert.equal(products[1]!.membership_features, null);
  const results = await repo.listTagJobResults({ jobId: job.id, limit: 10 });
  assert.deepEqual(results.items.map(item => [item.id, item.outcome, item.acceptedCount, item.rejectedCount]), [
    [String(accepted.product.id), 'updated', 1, 0], [String(rejected.product.id), 'failed', 0, 1],
  ]);
  for (const [productId, kind, decision] of [[accepted.product.id, 'account', true], [rejected.product.id, 'rental', false]] as const) {
    const audit = await repo.tagProductAudit(job.id, productId);
    assert.deepEqual(audit.member.output.review, { mode: 'membership_binary', decision });
    assert.equal(audit.member.output.classificationReviewed, decision);
    assert.equal(audit.batches[0].proposed_membership_kind, kind);
    assert.equal(audit.batches[1].classification_decision, decision);
  }
  const progress = await getJobProgress(db, job.id);
  assert.deepEqual(progress?.featureAcceptance, { acceptedProducts: 1, rejectedProducts: 1 });
  assert.equal(progress?.processed, '2');
  assert.equal(progress?.requests.confirmed, 2);
  assert.equal(progress?.requests.totalBatches, 2);
});

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
  assert.deepEqual((output.output as Record<string, unknown>).review, { mode: 'membership_binary', decision: false });
});

test('first empty-fact short-term classification is updated, repeated kind unchanged, and rejection retains the snapshot', async () => {
  const f = await fixture();
  for (const [kind, approved, outcome] of [
    ['short_term', true, 'updated'], ['short_term', true, 'unchanged'], ['rental', false, 'failed'],
  ] as const) {
    const task = outcome === 'updated' ? await featureTask(f.product.id) : await rerunFeatures(f.product.id);
    await saveFeature(task, kind, approved);
    const product = await db.selectFrom('products').selectAll().where('id', '=', f.product.id).executeTakeFirstOrThrow();
    const snapshot = readCurrentMembershipFeatures(product.membership_features, product);
    assert.deepEqual(snapshot?.decision, { kind: 'short_term', reason: 'llm_reviewed' });
    assert.deepEqual(snapshot?.tags, []);
    const result = await task.repo.tagProductAudit(task.job.id, f.product.id);
    assert.equal(result.member.output.outcome, outcome);
    assert.deepEqual(result.member.output.review, { mode: 'membership_binary', decision: approved });
    assert.equal(result.member.output.textReview, undefined);
    const listed = await task.repo.listTagJobResults({ jobId: task.job.id, limit: 10 });
    assert.equal(listed.items[0]?.acceptedCount, Number(approved));
    assert.equal(listed.items[0]?.rejectedCount, Number(!approved));
  }
});

for (const invalid of ['tags', 'rejectedTags', 'invalid_kind'] as const) {
  test(`feature checkpoint and publication reject ${invalid} atomically`, async () => {
    const f = await fixture();
    const task = await featureTask(f.product.id);
    const decision = reviewedFeature(task, 'account');
    if (invalid === 'invalid_kind') decision.membershipKind = 'unknown' as MembershipKind;
    else {
      const tag = { name: 'delivery', value: 'account', evidence: [{ path: 'name', quote: '成品账号' }] };
      if (invalid === 'tags') decision.tags = [tag];
      else decision.rejectedTags = [{ ...tag, reasonCode: 'review_rejected', reason: 'rejected' }];
    }
    await assert.rejects(task.repo.checkpointTagExtractionBatchDecision(task.job.id, task.batch.id, [decision], {}, task.claim, 'extract'));
    await assert.rejects(task.repo.persistTagExtractionBatchDecision(task.job.id, task.batch.id, [decision], {}, task.claim));
    const batch = await db.selectFrom('ai_job_batches').select(['validated_decision', 'confirmed_requests', 'step'])
      .where('id', '=', task.batch.id).executeTakeFirstOrThrow();
    assert.deepEqual(batch, { validated_decision: null, confirmed_requests: 0, step: 'request' });
    assert.equal((await db.selectFrom('products').select('membership_features').where('id', '=', f.product.id).executeTakeFirstOrThrow()).membership_features, null);
  });
}

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
  await saveFeature(task, 'account');
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
    await saveFeature(task, 'account');
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

test('all three tasks share the four-field fingerprint and full merchant context', async () => {
  const f = await fixture();
  await new ProductsRepository(db).upsertBatch([{
    shopId: f.product.shop_id, externalId: f.product.external_id, name: 'ChatGPT Plus · 月卡',
    sourceName: 'ChatGPT Plus', description: '<p>商家提供成品账号</p><p>完整详情</p>', spec: '月卡',
    sourceCategory: '会员', sourceData: { content: '<p>完整详情</p>', usage_guide: '仅限\n自用', warranty_info: '保订阅28天',
      tags: ['共享'], attributes: { delivery: '代充' }, microPrice: 100, arbitrary: '代充' }, normalizedKey: 'shared-evidence', url: '',
  }]);
  await db.insertInto('standard_product_members').values({ product_id: f.product.id, standard_product_id: f.baseId,
    assignment_source: 'ai', publication_state: 'published' }).execute();
  const standard = await f.repo.createJob({ model: 'mock', productIds: [f.product.id] });
  const feature = await db.selectFrom('ai_jobs').select('id').where('parent_identity_job_id', '=', standard.id)
    .where('job_type', '=', 'membership_features').executeTakeFirstOrThrow();
  const tag = await db.transaction().execute(tx => createTagJob(tx, { model: 'mock', productIds: [f.product.id] }));
  const product = await db.selectFrom('products').selectAll().where('id', '=', f.product.id).executeTakeFirstOrThrow();
  const inputs = await db.selectFrom('ai_job_inputs').select(['fingerprint', 'payload'])
    .where('job_id', 'in', [standard.id, feature.id, tag.id]).execute();
  assert.equal(inputs.length, 3);
  for (const input of inputs) {
    assert.equal(input.fingerprint, product.content_fingerprint);
    const evidence = extractionPayloadKey(input.payload as Record<string, JsonValue>);
    assert.equal(createHash('sha256').update(evidence).digest('hex'), product.content_fingerprint);
    const payload = input.payload as Record<string, JsonValue>;
    assert.equal(payload.name, 'ChatGPT Plus');
    const context = payload.sourceData as Record<string, JsonValue>;
    assert.equal(context.evidence, '商家提供成品账号\n完整详情');
    assert.equal(context.content, '完整详情');
    assert.equal(context.usage_guide, '仅限 自用');
    assert.equal(context.warranty_info, '保订阅28天');
    assert.deepEqual(context.tags, ['共享']);
    assert.deepEqual(context.attributes, { delivery: '代充' });
    assert.equal(context.arbitrary, '代充');
    assert.equal(payload.category, '会员');
  }
  const changed = await new ProductsRepository(db).update(product.id, { sourceData: { evidence: '新的完整商品说明' } });
  assert.equal(changed?.source_description, '新的完整商品说明');
  assert.notEqual(changed?.content_fingerprint, product.content_fingerprint);
});

test('identical crawler evidence with captured shop text preserves published membership', async () => {
  const f = await fixture();
  const sourceData = { ratingText: { unitId: '1', name: f.product.name, description: '', hash: 'a'.repeat(64) } };
  await saveFeature(await featureTask(f.product.id), 'account');
  await publishIdentity(f);
  await db.updateTable('products').set({ source_data: jsonb(sourceData) }).where('id', '=', f.product.id).execute();
  const published = await db.selectFrom('products').selectAll().where('id', '=', f.product.id).executeTakeFirstOrThrow();
  const features = buildMembershipFeatures([], published, [], 'account');
  const before = await db.updateTable('products').set({ membership_features: jsonb(features as unknown as JsonValue) })
    .where('id', '=', f.product.id).returningAll().executeTakeFirstOrThrow();
  const member = await db.selectFrom('standard_product_members').selectAll().where('product_id', '=', before.id).executeTakeFirstOrThrow();
  await db.insertInto('product_tags').values({ product_id: before.id, name: 'delivery', value: 'account' }).execute();
  const input = { shopId: before.shop_id, externalId: before.external_id, name: before.name, spec: before.spec,
    normalizedKey: before.normalized_key, url: before.url, sourceData };
  const change = await db.transaction().execute(async tx => {
    const result = await new ProductsRepository(db).upsertFetchedProducts(tx, [input]);
    // Match the crawler's same-transaction restoration of separately captured rating text.
    await tx.updateTable('products').set({ source_data: jsonb(sourceData) }).where('id', '=', before.id).execute();
    return result;
  });
  assert.deepEqual(change.changedProducts, []);
  assert.deepEqual(change.unchangedProducts, [before.id]);
  const after = await db.selectFrom('products').selectAll().where('id', '=', before.id).executeTakeFirstOrThrow();
  assert.equal(after.content_version, before.content_version);
  assert.equal(after.standardization_revision, before.standardization_revision);
  assert.deepEqual(after.membership_features, before.membership_features);
  assert.equal(readCurrentMembershipFeatures(after.membership_features, after)?.decision.kind, 'account');
  assert.deepEqual(await db.selectFrom('standard_product_members').selectAll().where('product_id', '=', before.id).executeTakeFirstOrThrow(), member);
  assert.equal((await db.selectFrom('product_tags').select('id').where('product_id', '=', before.id).execute()).length, 1);
});

for (const path of ['fetch', 'batch', 'update'] as const) {
  for (const state of ['unassigned', 'features_only', 'ai_member', 'other_member'] as const) {
    test(`${path}: goods changes are independent of recognition state (${state})`, async () => {
      const f = await fixture();
      if (state === 'unassigned' || state === 'features_only') {
        await db.deleteFrom('standard_product_members').where('product_id', '=', f.product.id).execute();
      } else if (state === 'other_member') {
        const other = await db.insertInto('standard_products').values({ name: 'ordinary product',
          standard_key: randomUUID(), canonical_family: 'test', canonical_product: 'ordinary', canonical_tier: 'basic' })
          .returning('id').executeTakeFirstOrThrow();
        await db.updateTable('standard_product_members').set({ standard_product_id: other.id })
          .where('product_id', '=', f.product.id).execute();
      }
      await db.updateTable('products').set({ source_data: jsonb({ warranty_info: '质保28天' }), content_fingerprint: productContentFingerprint({ name: f.product.name, spec: f.product.spec, sourceData: { warranty_info: '质保28天' } }) })
        .where('id', '=', f.product.id).execute();
      if (state === 'features_only') {
        const product = await db.selectFrom('products').selectAll().where('id', '=', f.product.id).executeTakeFirstOrThrow();
        await db.updateTable('products').set({ membership_features: jsonb(buildMembershipFeatures([], product, [], 'account') as unknown as JsonValue) })
          .where('id', '=', product.id).execute();
      }
      const products = new ProductsRepository(db);
      const write = async (sourceData: JsonValue, sourceCategory?: string) => {
        const p = await db.selectFrom('products').selectAll().where('id', '=', f.product.id).executeTakeFirstOrThrow();
        const input = { shopId: p.shop_id, externalId: p.external_id, name: p.name, sourceName: p.source_name,
          description: p.source_description, spec: p.spec, sourceCategory, normalizedKey: p.normalized_key, url: p.url, sourceData };
        if (path === 'fetch') await db.transaction().execute(tx => products.upsertFetchedProducts(tx, [input]));
        else if (path === 'batch') await products.upsertBatch([input]);
        else await products.update(p.id, { sourceData, sourceCategory });
        return db.selectFrom('products').selectAll().where('id', '=', p.id).executeTakeFirstOrThrow();
      };
      await db.updateTable('products').set({ source_category: '旧分类' }).where('id', '=', f.product.id).execute();
      const before = await db.selectFrom('products').selectAll().where('id', '=', f.product.id).executeTakeFirstOrThrow();
      const unchanged = await write({ warranty_info: '质保28天', price: 99, stock: 20,
        usage_guide: '更新后的使用说明', microPrice: 500, tags: ['租号'], attributes: { delivery: '自有号代充' },
        unknown_merchant_flag: true, ratingText: { unitId: '1', name: before.name, description: '', hash: 'b'.repeat(64) } }, '新分类');
      assert.equal(unchanged.content_version, before.content_version, 'non-fingerprint context must not invalidate goods');
      assert.equal(unchanged.content_fingerprint, before.content_fingerprint);
      assert.equal(unchanged.standardization_revision, before.standardization_revision);
      assert.equal(unchanged.source_category, '新分类');
      assert.equal((await db.selectFrom('product_change_events').select('id').where('product_id', '=', before.id).execute()).length, 0);
      assert.equal((await db.selectFrom('standard_product_members').select('product_id').where('product_id', '=', before.id).execute()).length,
        state === 'unassigned' || state === 'features_only' ? 0 : 1);
      const changed = await write({ warranty_info: '无质保' });
      assert.equal(changed.content_version, before.content_version + 1n, 'warranty changes must be detected in every recognition state');
      assert.notEqual(changed.content_fingerprint, before.content_fingerprint);
      assert.equal(changed.membership_features, null);
      assert.equal((await db.selectFrom('standard_product_members').select('product_id').where('product_id', '=', before.id).execute()).length, 0);
      const repeated = await write({ warranty_info: '无质保' });
      assert.equal(repeated.content_version, changed.content_version, 'repeating identical evidence must not trigger another change');
    });
  }

  test(`${path}: independent sale warranty changes invalidate membership evidence`, async () => {
    const f = await fixture('ChatGPT Plus 成品账号');
    await db.updateTable('products').set({ source_data: jsonb({ warranty_info: '质保28天' }) }).where('id', '=', f.product.id).execute();
    const task = await featureTask(f.product.id);
    await saveFeature(task, 'account');
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

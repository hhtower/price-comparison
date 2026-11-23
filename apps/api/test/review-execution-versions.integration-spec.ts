import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { migrateToLatest } from '../scripts/migrate.js';
import { jsonb, type AiJobType, type DatabaseSchema } from '../src/database/types.js';
import { PIPELINE_VERSIONS, currentExecutionPipeline } from '../src/ai/pipeline-versions.js';
import { AiRepository } from '../src/ai/ai.repository.js';
import { JobsRepository, type ClaimedJob } from '../src/jobs/jobs.repository.js';
import { readAiTaskQueue } from '../src/ai/ai-task-queue.js';
import { createManualTagJob, createTagJob } from '../src/ai/tag-extraction-jobs.js';
import { hasActiveStandardizationWork, hasCurrentStandardizationResult } from '../src/ai/product-standardization-state.js';
import { standardizationResultSource } from '../src/ai/standardization-result-source.js';
import { recoverAbandonedStandardizationBatches, recoverStandardizationFinalization } from '../src/ai/standardization-finalizer.js';
import { productContentFingerprint } from '../src/standardization/fingerprint.js';

let db: Kysely<DatabaseSchema>, admin: Pool, schema: string;
const previousSchema = process.env.PG_SCHEMA;
before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL must point to an isolated test database');
  schema = `review_execution_${randomUUID().replaceAll('-', '')}`;
  admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  process.env.PG_SCHEMA = schema;
  db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({
    connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path="${schema}",public`,
  }) }) });
  await migrateToLatest(db);
});
beforeEach(async () => {
  await db.updateTable('ai_jobs').set({ status: 'cancelled' }).execute();
});
after(async () => {
  await db?.destroy();
  if (admin && schema) await admin.query(`drop schema "${schema}" cascade`);
  await admin?.end();
  if (previousSchema === undefined) delete process.env.PG_SCHEMA;
  else process.env.PG_SCHEMA = previousSchema;
});

async function fixture(kind: AiJobType = 'tag_extraction', changes: Record<string, string> = {}) {
  const shop = await db.insertInto('shops').values({
    name: 'Execution isolation', platform: 'test', url: `https://${randomUUID()}.invalid`, enabled: true,
  }).returningAll().executeTakeFirstOrThrow();
  const source = { name: kind === 'membership_features' ? 'ChatGPT Plus account' : 'Game key', spec: '30 days' };
  const product = await db.insertInto('products').values({
    shop_id: shop.id, external_id: randomUUID(), ...source, source_category: '', source_data: jsonb({}),
    normalized_key: randomUUID(), url: '', content_version: 1n, content_fingerprint: productContentFingerprint(source),
  }).returningAll().executeTakeFirstOrThrow();
  await db.insertInto('offers').values({
    product_id: product.id, price: '10', currency: 'USD', stock_available: true, is_stale: false,
    captured_at: new Date(), idempotency_key: randomUUID(),
  }).execute();
  if (['tag_extraction', 'membership_features', 'text_review'].includes(kind)) {
    const standard = await db.insertInto('standard_products').values({
      name: source.name,
      canonical_family: kind === 'membership_features' ? 'openai' : 'steam',
      canonical_product: kind === 'membership_features' ? 'chatgpt' : 'game',
      canonical_tier: kind === 'membership_features' ? 'plus' : 'standard',
      verification_state: 'verified',
    }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('standard_product_members').values({
      product_id: product.id, standard_product_id: standard.id, assignment_source: 'ai', publication_state: 'published',
    }).execute();
  }
  const job = await db.insertInto('ai_jobs').values({
    model: 'mock', job_type: kind, total: 1n, status: 'queued', phase: 'standardizing',
    prompt_version: PIPELINE_VERSIONS.prompt, rule_version: PIPELINE_VERSIONS.standardizationPolicy,
    pipeline_versions: jsonb({ ...PIPELINE_VERSIONS, ...changes }),
  }).returningAll().executeTakeFirstOrThrow();
  const payload = { id: String(product.id), ...source, sourceData: {}, warrantyEligible: false,
    shopSource: { url: shop.url, protocol: shop.protocol, platform: shop.platform } };
  await db.insertInto('ai_job_inputs').values({
    job_id: job.id, input_id: product.id, fingerprint: product.content_fingerprint,
    payload: jsonb(payload), content_version: product.content_version, input_bytes: 100n, estimated_tokens: 30n,
  }).execute();
  await db.insertInto('ai_job_input_members').values({
    job_id: job.id, input_id: product.id, product_id: product.id, fingerprint: product.content_fingerprint,
    payload: jsonb(payload), content_version: product.content_version, standardization_revision: product.standardization_revision,
    status: 'queued',
  }).execute();
  const batch = await db.insertInto('ai_job_batches').values({
    job_id: job.id, batch_index: 0n, product_ids: jsonb([String(product.id)]), product_count: 1n,
    step: 'request', status: 'queued', request_budget_limit: 2,
    reference_snapshot: jsonb({ reviewStage: 'generate', strategyVersion: 'approved-candidate-20261119-v1', catalogVersion: '0', candidates: [],
      inputs: [{ id: String(product.id), candidateStandardProductIds: [], stats: { scanned: 0, compared: 0, truncated: false } }] }),
  }).returningAll().executeTakeFirstOrThrow();
  return { job, product, shop, batch, ai: new AiRepository(db), jobs: new JobsRepository(db) };
}

function fence(claim: ClaimedJob) {
  return { workerId: claim.claimed_by, attempt: claim.attempts, token: String(claim.row.claim_token) };
}

for (const kind of ['incremental', 'manual_full', 'calibration', 'tag_extraction', 'membership_features', 'text_review'] as const) {
  test(`${kind} SQL header validation matches its task contract`, async () => {
    const f = await fixture(kind);
    for (const field of ['prompt_version', 'rule_version'] as const) {
      await db.updateTable('ai_jobs').set({
        prompt_version: PIPELINE_VERSIONS.prompt, rule_version: PIPELINE_VERSIONS.standardizationPolicy, [field]: 'older',
      }).where('id', '=', f.job.id).execute();
      const row = await db.selectFrom('ai_jobs as j').select(currentExecutionPipeline().as('current'))
        .where('j.id', '=', f.job.id).executeTakeFirstOrThrow();
      assert.equal(row.current, kind === 'tag_extraction' || kind === 'membership_features');
      if (row.current) await f.ai.prepareBatch(f.batch.id);
      else await assert.rejects(f.ai.prepareBatch(f.batch.id), { code: 'AI_POLICY_STALE' });
    }
  });
}

for (const [kind, key, allowed] of [
  ['tag_extraction', 'membershipFeaturePrompt', true],
  ['tag_extraction', 'prompt', true],
  ['tag_extraction', 'tagPrompt', false],
  ['tag_extraction', 'reviewWorkflow', false],
  ['tag_extraction', 'offerEligibility', false],
  ['tag_extraction', 'attributeOrder', false],
  ['membership_features', 'tagPrompt', true],
  ['membership_features', 'membershipFeaturePrompt', false],
  ['membership_features', 'reviewWorkflow', false],
  ['manual_full', 'tagPrompt', true],
  ['manual_full', 'prompt', false],
  ['manual_full', 'reviewWorkflow', false],
  ['text_review', 'tagPrompt', false],
  ['text_review', 'membershipFeaturePrompt', false],
] as const) {
  test(`${kind} claim and reservation ${allowed ? 'survive' : 'block'} changed ${key}`, async () => {
    const f = await fixture(kind, { [key]: 'older' });
    const actual = await db.selectFrom('ai_jobs as candidate').select(currentExecutionPipeline('candidate').as('current'))
      .where('candidate.id', '=', f.job.id).executeTakeFirstOrThrow();
    assert.equal(actual.current, allowed);
    const claims = await f.jobs.claimAvailable('ai_standardization', 'isolation-test', 1);
    assert.equal(claims.length, Number(allowed));
    if (allowed) {
      assert.equal(claims[0]!.id, f.batch.id);
      assert.equal(await f.ai.reserveBatchRequest(f.batch.id, fence(claims[0]!)), 'reserved');
    } else await assert.rejects(f.ai.reserveBatchRequest(f.batch.id), /stale_policy/);
  });
}

test('tag generation and review can claim, reserve and checkpoint after feature and standardization changes', async () => {
  const f = await fixture('tag_extraction', { membershipFeaturePrompt: 'older', prompt: 'older' });
  await db.updateTable('ai_jobs').set({ prompt_version: 'older', rule_version: 'older' }).where('id', '=', f.job.id).execute();
  const generated = (await f.jobs.claimAvailable('ai_standardization', 'isolation-test', 1))[0]!;
  assert.ok(generated);
  await f.ai.prepareBatch(generated.id);
  assert.equal(await f.ai.reserveBatchRequest(generated.id, fence(generated)), 'reserved');
  const item = { productId: f.product.id, tags: [], rejectedTags: [] };
  await f.ai.checkpointTagExtractionBatchDecision(f.job.id, generated.id, [item], {}, fence(generated), 'generate');
  const review = (await f.jobs.claimAvailable('ai_standardization', 'isolation-test', 1))[0]!;
  assert.ok(review);
  await f.ai.prepareBatch(review.id);
  const request = await f.ai.getTagExtractionBatchInputs(review.id);
  assert.equal(request.stage, 'review');
  assert.deepEqual(request.proposals, { items: [{ id: String(f.product.id), tags: [] }] });
  assert.equal(await f.ai.reserveBatchRequest(review.id, fence(review)), 'reserved');
  await f.ai.checkpointTagExtractionBatchDecision(f.job.id, review.id, [{
    ...item, reviewed: true, complete: true, reviewDecisions: [], reviewFeedback: '',
  }], {}, fence(review), 'review');
  const saved = await db.selectFrom('ai_job_batches').select(['step', 'confirmed_requests'])
    .where('id', '=', review.id).executeTakeFirstOrThrow();
  assert.deepEqual(saved, { step: 'publish', confirmed_requests: 1 });
  const publication = (await f.jobs.claimAvailable('ai_standardization', 'isolation-test', 1))[0]!;
  assert.ok(publication);
  await f.ai.prepareBatch(publication.id);
  await f.ai.publishTagExtractionBatch(publication.id, fence(publication));
  const published = await db.selectFrom('ai_job_batches').select('step')
    .where('id', '=', publication.id).executeTakeFirstOrThrow();
  assert.equal(published.step, 'done');
});

for (const key of ['membershipFeaturePrompt', 'tagPrompt', 'reviewWorkflow']) {
  test(`tag live stream display and unknown protection after ${key} changes`, async () => {
    const f = await fixture();
    const claim = (await f.jobs.claimAvailable('ai_standardization', 'isolation-test', 1))[0]!;
    await db.updateTable('ai_job_batches').set({ request_budget_used: 1 }).where('id', '=', claim.id).execute();
    await db.updateTable('ai_jobs').set({ pipeline_versions: jsonb({ ...PIPELINE_VERSIONS, [key]: 'older' }) })
      .where('id', '=', f.job.id).execute();
    const current = key === 'membershipFeaturePrompt';
    const queue = await readAiTaskQueue(db, { jobType: 'tag_extraction', status: 'all', scopeShopId: f.shop.id });
    assert.equal(queue.items[0]?.configurationCurrent, current);
    assert.equal(queue.summary.pendingProducts, 0);
    assert.equal(queue.items[0]?.remaining, current ? 1 : 0);
    assert.equal((queue.summary.currentReasons as Record<string, number>).request_outcome_unknown ?? 0, current ? 0 : 1);
    const parent = await db.insertInto('ai_jobs').values({ model: 'mock', total: 0n, status: 'succeeded' })
      .returning('id').executeTakeFirstOrThrow();
    await assert.rejects(db.transaction().execute(tx => createTagJob(tx, {
      model: 'mock', productIds: [f.product.id], parentIdentityJobId: parent.id,
    })), { code: 'AI_TAG_SCOPE_EMPTY' });
  });
}

test('standardization live request remains active across tag changes and becomes unknown across own changes', async () => {
  const f = await fixture('manual_full');
  const claim = (await f.jobs.claimAvailable('ai_standardization', 'isolation-test', 1))[0]!;
  await db.updateTable('ai_job_batches').set({ request_budget_used: 1 }).where('id', '=', claim.id).execute();
  for (const key of ['tagPrompt', 'prompt']) {
    await db.updateTable('ai_jobs').set({ pipeline_versions: jsonb({ ...PIPELINE_VERSIONS, [key]: 'older' }) })
      .where('id', '=', f.job.id).execute();
    const state = await db.selectFrom('products as p')
      .select([hasActiveStandardizationWork.as('active'), hasCurrentStandardizationResult().as('protected')])
      .where('p.id', '=', f.product.id).executeTakeFirstOrThrow();
    assert.equal(state.active, key === 'tagPrompt');
    assert.equal(state.protected, true);
    const fallback = await db.selectFrom(standardizationResultSource(sql.val(f.product.id)).as('r'))
      .select('r.reason_code').execute();
    assert.deepEqual(fallback, key === 'tagPrompt' ? [] : [{ reason_code: 'request_outcome_unknown' }]);
  }
});

for (const key of ['membershipFeaturePrompt', 'tagPrompt', 'reviewWorkflow']) {
  test(`abandoned tag recovery uses execution versions for ${key}`, async () => {
    const f = await fixture('tag_extraction', { [key]: 'older' });
    await db.updateTable('ai_job_batches').set({
      status: 'running', lease_until: new Date(0), request_budget_used: 1, unknown_requests: 1,
    }).where('id', '=', f.batch.id).execute();
    const recovered = await recoverAbandonedStandardizationBatches(db);
    assert.equal(recovered, key === 'membershipFeaturePrompt' ? 1 : 0);
    const saved = await db.selectFrom('ai_job_batches').select(['status', 'request_budget_used'])
      .where('id', '=', f.batch.id).executeTakeFirstOrThrow();
    assert.equal(saved.status, recovered ? 'failed' : 'running');
    assert.equal(saved.request_budget_used, 1);
  });
}

test('finalization recovers attribute jobs with unrelated changes and stale identity headers', async () => {
  const job = await db.insertInto('ai_jobs').values({
    job_type: 'tag_extraction', model: 'mock', total: 0n, status: 'running', phase: 'standardizing',
    prompt_version: 'older', rule_version: 'older',
    pipeline_versions: jsonb({ ...PIPELINE_VERSIONS, membershipFeaturePrompt: 'older' }),
  }).returning('id').executeTakeFirstOrThrow();
  assert.equal(await recoverStandardizationFinalization(db), 1);
  const saved = await db.selectFrom('ai_jobs').select('status').where('id', '=', job.id).executeTakeFirstOrThrow();
  assert.equal(saved.status, 'succeeded');
});

test('all-pending deduplication follows tag execution versions', async () => {
  const first = await createManualTagJob(db, { allPending: true, model: 'mock', requestId: randomUUID() });
  await db.updateTable('ai_jobs').set({
    prompt_version: 'older', rule_version: 'older',
    pipeline_versions: jsonb({ ...PIPELINE_VERSIONS, membershipFeaturePrompt: 'older' }),
  }).where('id', '=', first.id).execute();
  const same = await createManualTagJob(db, { allPending: true, model: 'mock', requestId: randomUUID() });
  assert.equal(same.id, first.id);
  await db.updateTable('ai_jobs').set({ pipeline_versions: jsonb({ ...PIPELINE_VERSIONS, tagPrompt: 'older' }) })
    .where('id', '=', first.id).execute();
  const newer = await createManualTagJob(db, { allPending: true, model: 'mock', requestId: randomUUID() });
  assert.ok(newer.id > first.id);
});

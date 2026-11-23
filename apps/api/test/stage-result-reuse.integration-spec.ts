import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { migrateToLatest } from '../scripts/migrate.js';
import { jsonb, type AttributeJobType, type DatabaseSchema, type JsonValue } from '../src/database/types.js';
import { PIPELINE_VERSIONS, assertCurrentPipeline, pipelineVersionSnapshot } from '../src/ai/pipeline-versions.js';
import { hasActiveStandardizationWork, hasCurrentRelayExclusion, hasCurrentStandardizationResult } from '../src/ai/product-standardization-state.js';
import { currentUnclassifiedQuery } from '../src/ai/ai-retry-pool.js';
import { readAiTaskQueue } from '../src/ai/ai-task-queue.js';
import { createMembershipFeatureJob, createTagJob, createManualTagJob, createManualMembershipFeatureJob, previewTagJob, previewMembershipFeatureJob, prepareAllPendingTagJob } from '../src/ai/tag-extraction-jobs.js';
import { buildMembershipFeatures } from '../src/standardization/membership-classification.js';
import { API_RELAY_EXCLUSION_CODE } from '../src/standardization/catalog-exclusion.js';
import { productContentFingerprint } from '../src/standardization/fingerprint.js';
import { captureRatingText } from '../src/platforms/source-evidence.js';
import { AiRepository } from '../src/ai/ai.repository.js';
import { readRetryPool } from '../src/ai/ai-retry-pool.js';

let db: Kysely<DatabaseSchema>, admin: Pool, schema: string;
const previousSchema = process.env.PG_SCHEMA;
before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL must point to an isolated test database');
  schema = `stage_result_reuse_${randomUUID().replaceAll('-', '')}`;
  admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  process.env.PG_SCHEMA = schema;
  db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({
    connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path="${schema}",public`,
  }) }) });
  await migrateToLatest(db);
});
after(async () => {
  await db?.destroy();
  if (admin && schema) await admin.query(`drop schema "${schema}" cascade`);
  await admin?.end();
  if (previousSchema === undefined) delete process.env.PG_SCHEMA;
  else process.env.PG_SCHEMA = previousSchema;
});

async function fixture(kind: 'manual_full' | AttributeJobType = 'manual_full') {
  const shop = await db.insertInto('shops').values({
    name: 'Stage reuse', platform: 'test', url: `https://${randomUUID()}.invalid`, enabled: true,
  }).returningAll().executeTakeFirstOrThrow();
  const product = await db.insertInto('products').values({
    shop_id: shop.id, external_id: randomUUID(), name: 'ChatGPT Plus', spec: '30 days',
    source_category: '', source_data: jsonb({}), normalized_key: randomUUID(), url: '',
    content_version: 1n, content_fingerprint: productContentFingerprint({ name: 'ChatGPT Plus', spec: '30 days' }),
  }).returningAll().executeTakeFirstOrThrow();
  await db.insertInto('offers').values({
    product_id: product.id, price: '10', currency: 'USD', stock_available: true, is_stale: false,
    captured_at: new Date(), idempotency_key: randomUUID(),
  }).execute();
  const job = await db.insertInto('ai_jobs').values({
    model: 'mock', job_type: kind, total: 1n, status: 'succeeded', phase: 'completed',
    prompt_version: PIPELINE_VERSIONS.prompt, rule_version: PIPELINE_VERSIONS.standardizationPolicy,
    pipeline_versions: jsonb(pipelineVersionSnapshot('mock')),
  }).returningAll().executeTakeFirstOrThrow();
  const payload = { id: String(product.id), name: product.name, spec: product.spec, warrantyEligible: true,
    shopSource: { url: shop.url, protocol: shop.protocol, platform: shop.platform } };
  await db.insertInto('ai_job_inputs').values({
    job_id: job.id, input_id: product.id, fingerprint: product.content_fingerprint,
    payload: jsonb(payload), content_version: product.content_version, input_bytes: 100n, estimated_tokens: 30n,
  }).execute();
  await db.insertInto('ai_job_input_members').values({
    job_id: job.id, input_id: product.id, product_id: product.id, fingerprint: product.content_fingerprint,
    payload: jsonb(payload), content_version: product.content_version, standardization_revision: product.standardization_revision,
    status: kind === 'manual_full' ? 'unclassified' : 'classified',
    ...(kind === 'tag_extraction' ? { output: jsonb({ outcome: 'empty', complete: true }) } : {}),
  }).execute();
  if (kind === 'manual_full') {
    await db.insertInto('ai_standardization_results').values({
      job_id: job.id, input_id: product.id, product_id: product.id, batch_id: null,
      content_version: product.content_version, fingerprint: product.content_fingerprint,
      status: 'unclassified', reason_code: 'unmatched', reason: 'mock result', decision: jsonb({}),
      tags: jsonb([]), evidence: jsonb([]), standard_product_id: null,
    }).execute();
  } else {
    const standard = await db.insertInto('standard_products').values({
      name: 'ChatGPT Plus', canonical_family: 'openai', canonical_product: 'chatgpt', canonical_tier: 'plus',
      verification_state: 'verified',
    }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('standard_product_members').values({
      product_id: product.id, standard_product_id: standard.id, assignment_source: 'ai', publication_state: 'published',
    }).execute();
  }
  return { job, product, shop };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function changeVersions(f: Fixture, changes: Record<string, JsonValue>) {
  const snapshot = { ...PIPELINE_VERSIONS, ...changes };
  await db.updateTable('ai_jobs').set({ pipeline_versions: jsonb(snapshot) }).where('id', '=', f.job.id).execute();
  return snapshot;
}
async function currentResult(f: Fixture) {
  return (await db.selectFrom('products as p').select(hasCurrentStandardizationResult().as('current'))
    .where('p.id', '=', f.product.id).executeTakeFirstOrThrow()).current;
}
async function autoAttribute(f: Fixture, kind: 'tag_extraction' | 'membership_features') {
  const parent = await db.insertInto('ai_jobs').values({ model: 'mock', total: 0n, status: 'succeeded' })
    .returning('id').executeTakeFirstOrThrow();
  return db.transaction().execute(tx => (kind === 'tag_extraction' ? createTagJob : createMembershipFeatureJob)(tx, {
    model: 'mock', productIds: [f.product.id], parentIdentityJobId: parent.id,
  }));
}
const emptyScope = { code: 'AI_TAG_SCOPE_EMPTY' };
const history = (f: Fixture, jobType = f.job.job_type) => readAiTaskQueue(db, {
  jobType, status: 'all', scopeShopId: f.shop.id,
});

test('standardization results and retry pool ignore attribute and scheduling versions', async () => {
  const f = await fixture();
  const snapshot = await changeVersions(f, {
    tagPrompt: 'older', tagProtocol: 'older', tagReviewPrompt: 'older', tagWarrantyPrompt: 'older',
    tagValidation: 'older', membershipPolicy: 'older', membershipFeaturePrompt: 'older',
    membershipFeatureReviewPrompt: 'older', productTextReviewPrompt: 'older',
    standardizationRepair: 'older', reviewWorkflow: 'older', attributeOrder: 'older', offerEligibility: 'older',
  });
  assert.equal(await currentResult(f), true);
  assert.equal((await currentUnclassifiedQuery(db).select('r.job_id').where('p.id', '=', f.product.id).execute())[0]?.job_id, f.job.id);
  const queue = await history(f);
  assert.deepEqual(queue.items.map(item => item.id), [String(f.job.id)]);
  assert.equal(queue.summary.attention, 1);
  assert.equal((await readAiTaskQueue(db, { jobType: f.job.job_type, scopeShopId: f.shop.id })).summary.total, 0);
  assert.throws(() => assertCurrentPipeline({ ...f.job, pipeline_versions: snapshot }), { code: 'AI_POLICY_STALE' });
  await db.updateTable('ai_standardization_results').set({ reason_code: API_RELAY_EXCLUSION_CODE }).where('job_id', '=', f.job.id).execute();
  const exclusion = await db.selectFrom('products as p').select(hasCurrentRelayExclusion().as('excluded'))
    .where('p.id', '=', f.product.id).executeTakeFirstOrThrow();
  assert.equal(exclusion.excluded, true);
});

for (const key of ['prompt', 'schema', 'projection', 'retrieval', 'mapping', 'standardizationPolicy', 'validation', 'standardizationReviewPrompt'] as const) {
  test(`standardization result invalidates its own ${key}`, async () => {
    const f = await fixture();
    await changeVersions(f, { [key]: 'older' });
    assert.equal(await currentResult(f), false);
    assert.deepEqual(await currentUnclassifiedQuery(db).select('r.job_id').where('p.id', '=', f.product.id).execute(), []);
  });
}

test('newer standardization results supersede retry history across unrelated version changes', async () => {
  const f = await fixture();
  const newer = await db.insertInto('ai_jobs').values({
    model: 'mock', total: 1n, job_type: 'manual_full', status: 'succeeded',
    prompt_version: PIPELINE_VERSIONS.prompt, rule_version: PIPELINE_VERSIONS.standardizationPolicy,
    pipeline_versions: jsonb({ ...PIPELINE_VERSIONS, tagPrompt: 'older' }),
  }).returning('id').executeTakeFirstOrThrow();
  const member = await db.selectFrom('ai_job_input_members').selectAll().where('job_id', '=', f.job.id).executeTakeFirstOrThrow();
  const input = await db.selectFrom('ai_job_inputs').selectAll().where('job_id', '=', f.job.id).executeTakeFirstOrThrow();
  await db.insertInto('ai_job_inputs').values({ ...input, job_id: newer.id, payload: jsonb(input.payload) }).execute();
  await db.insertInto('ai_job_input_members').values({ ...member, job_id: newer.id, payload: jsonb(member.payload), output: null }).execute();
  const result = await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', f.job.id).executeTakeFirstOrThrow();
  await db.insertInto('ai_standardization_results').values({
    ...result, job_id: newer.id, reason_code: 'insufficient_source',
    tags: jsonb([]), evidence: jsonb([]), decision: jsonb({}),
  }).execute();
  const rows = await currentUnclassifiedQuery(db).select('r.job_id').where('p.id', '=', f.product.id).execute();
  assert.deepEqual(rows.map(row => row.job_id), [newer.id]);
});

for (const field of ['content_version', 'content_fingerprint', 'standardization_revision'] as const) {
  test(`standardization reuse still requires matching ${field}`, async () => {
    const f = await fixture();
    await db.updateTable('products').set({ [field]: field === 'content_fingerprint' ? 'changed' : 99n }).where('id', '=', f.product.id).execute();
    assert.equal(await currentResult(f), false);
  });
}

test('unknown standardization outcome stays visible and blocks backfill across protocol versions', async () => {
  const f = await fixture();
  await changeVersions(f, { prompt: 'older', standardizationPolicy: 'older', tagPrompt: 'older' });
  await db.updateTable('ai_jobs').set({ prompt_version: 'older', rule_version: 'older' }).where('id', '=', f.job.id).execute();
  await db.updateTable('ai_standardization_results').set({ reason_code: 'request_outcome_unknown' }).where('job_id', '=', f.job.id).execute();
  assert.equal(await currentResult(f), true);
  assert.equal((await currentUnclassifiedQuery(db).select('r.job_id').where('p.id', '=', f.product.id).execute())[0]?.job_id, f.job.id);
  assert.ok((await readRetryPool(db, { limit: 100 })).items.some(item => item.productId === String(f.product.id)));
  const global = await new AiRepository(db).listGlobalResults({ limit: 100 });
  const item = global.items.find(item => item.productId === String(f.product.id));
  assert.equal(item?.reasonCode, 'request_outcome_unknown');
  assert.equal(item?.sourceJobId, String(f.job.id));
  assert.equal(item?.processingDisposition, 'retry_available');
  await db.updateTable('products').set({ standardization_revision: 99n }).where('id', '=', f.product.id).execute();
  assert.equal(await currentResult(f), false);
});

async function unmaterializedRequest(f: Fixture, mode: 'unknown' | 'unresolved') {
  await changeVersions(f, { reviewWorkflow: 'older' });
  await db.updateTable('ai_jobs').set({ status: 'running' }).where('id', '=', f.job.id).execute();
  await db.updateTable('ai_job_input_members').set({ status: 'processing', output: null, reason_code: null })
    .where('job_id', '=', f.job.id).execute();
  await db.insertInto('ai_job_batches').values({
    job_id: f.job.id, batch_index: 0n, product_ids: jsonb([String(f.product.id)]), product_count: 1n,
    step: 'request', status: 'running', request_budget_limit: 2, request_budget_used: 1,
    confirmed_requests: 0, unknown_requests: mode === 'unknown' ? 1 : 0,
  }).execute();
}

async function manualAttributeRetry(f: Fixture, kind: AttributeJobType) {
  const scope = { model: 'mock', productIds: [f.product.id], retryOfJobId: f.job.id };
  const preview = await (kind === 'tag_extraction' ? previewTagJob : previewMembershipFeatureJob)(db, scope);
  return (kind === 'tag_extraction' ? createManualTagJob : createManualMembershipFeatureJob)(db, {
    ...scope, requestId: randomUUID(), previewDigest: preview.previewDigest,
  });
}

for (const kind of ['tag_extraction', 'membership_features'] as const) {
  for (const mode of ['unknown', 'unresolved'] as const) {
    test(`${kind} ${mode} survives a manual retry cancelled before reservation`, async () => {
      const f = await fixture(kind);
      await unmaterializedRequest(f, mode);
      const retry = await manualAttributeRetry(f, kind);
      await new AiRepository(db).cancelJob(retry.id);
      const batches = await db.selectFrom('ai_job_batches').select('request_budget_used')
        .where('job_id', '=', retry.id).execute();
      assert.ok(batches.length > 0);
      assert.ok(batches.every(batch => batch.request_budget_used === 0));
      const cancelled = await db.selectFrom('ai_job_input_members').select(['reason_code', 'output'])
        .where('job_id', '=', retry.id).executeTakeFirstOrThrow();
      assert.equal(cancelled.reason_code, 'job_cancelled');
      assert.equal((cancelled.output as Record<string, JsonValue>).outcome, 'cancelled');
      const queue = await history(f);
      await assert.rejects(autoAttribute(f, kind), emptyScope);
      assert.equal(queue.summary.pendingProducts, 0);
      assert.equal(queue.summary.currentReasons.request_outcome_unknown, 1);
      assert.equal(queue.items.find(item => item.id === String(f.job.id))?.unclassified, 1);
      assert.equal(queue.items.find(item => item.id === String(retry.id))?.unclassified, 0);
      for (const status of ['all', 'attention']) {
        const scope = { jobType: kind, status, scopeShopId: f.shop.id, limit: 1 };
        const first = await readAiTaskQueue(db, scope);
        assert.deepEqual(await readAiTaskQueue(db, { ...scope, totalOnly: true }),
          { ...first, summary: { total: first.summary.total } });
        const older = await readAiTaskQueue(db, { ...scope, cursor: first.nextCursor ?? undefined });
        assert.equal(older.items.find(item => item.id === String(f.job.id))?.unclassified, 1);
      }
      const nextRetry = await manualAttributeRetry({ ...f, job: retry }, kind);
      assert.ok(nextRetry.id > retry.id, 'manual retry remains available');
      await db.updateTable('ai_jobs').set({ status: 'succeeded' }).where('id', '=', nextRetry.id).execute();
      await db.updateTable('ai_job_batches').set({
        status: 'succeeded', step: 'done', request_budget_used: 1, confirmed_requests: 1,
      }).where('job_id', '=', nextRetry.id).execute();
      await db.updateTable('ai_job_input_members').set({
        status: 'classified', output: jsonb({ outcome: 'empty', complete: true }),
      }).where('job_id', '=', nextRetry.id).execute();
      if (kind === 'membership_features') {
        const snapshot = buildMembershipFeatures([], {
          ...f.product, shop_url: f.shop.url, shop_protocol: f.shop.protocol, shop_platform: f.shop.platform,
        }, [], 'account');
        await db.updateTable('products').set({ membership_features: jsonb(snapshot as unknown as JsonValue) })
          .where('id', '=', f.product.id).execute();
      }
      const covered = await history(f);
      assert.equal(covered.summary.currentReasons.request_outcome_unknown, undefined);
      assert.equal(covered.summary.coveredProducts, 1);
      await assert.rejects(autoAttribute(f, kind), emptyScope);
    });
  }
  for (const change of ['source', 'revision'] as const) {
    test(`${kind} cancelled retry preserves unknown only for the same ${change}`, async () => {
      const f = await fixture(kind);
      await unmaterializedRequest(f, 'unknown');
      await new AiRepository(db).cancelJob((await manualAttributeRetry(f, kind)).id);
      if (change === 'source') await db.updateTable('shops').set({ url: `https://${randomUUID()}.invalid` })
        .where('id', '=', f.shop.id).execute();
      else await db.updateTable('products').set({ standardization_revision: 99n }).where('id', '=', f.product.id).execute();
      const queue = await history(f);
      assert.equal(queue.summary.pendingProducts, 1);
      assert.equal(queue.summary.currentReasons.request_outcome_unknown, undefined);
      assert.ok((await autoAttribute(f, kind)).id > f.job.id);
    });
  }
  for (const state of ['running', 'queued', 'unknown', 'expired', 'noLease', 'batchStopped', 'oldProtocol', 'oldHeader', 'paused', 'pauseRequested', 'cancelRequested'] as const) {
    test(`${kind} request display distinguishes ${state} from a lost request`, async () => {
      const f = await fixture(kind);
      await unmaterializedRequest(f, state === 'unknown' ? 'unknown' : 'unresolved');
      await db.updateTable('ai_jobs').set({
        status: state === 'paused' ? 'paused' : state === 'queued' ? 'queued' : 'running',
        pipeline_versions: jsonb({ ...PIPELINE_VERSIONS, ...(state === 'oldProtocol' ? { reviewWorkflow: 'older' } : {}) }),
        ...(state === 'oldHeader' ? { prompt_version: 'older' } : {}),
        pause_requested: state === 'pauseRequested', cancel_requested: state === 'cancelRequested',
      }).where('id', '=', f.job.id).execute();
      await db.updateTable('ai_job_batches').set({
        status: state === 'batchStopped' ? 'cancelled' : 'running',
        lease_until: state === 'noLease' ? null : new Date(Date.now() + (state === 'expired' ? -60_000 : 60_000)),
      }).where('job_id', '=', f.job.id).execute();
      const lost = !['running', 'queued'].includes(state);
      const queue = await history(f);
      assert.equal(queue.items[0]?.unclassified, lost ? 1 : 0);
      assert.equal(queue.items[0]?.remaining, lost ? 0 : 1);
      assert.equal(queue.summary.currentReasons.request_outcome_unknown, lost ? 1 : undefined);
      if (state === 'running' || state === 'queued') {
        const scope = { jobType: kind, scopeShopId: f.shop.id };
        const active = await readAiTaskQueue(db, scope);
        assert.equal(active.summary.pendingProducts, 1);
        assert.deepEqual(await readAiTaskQueue(db, { ...scope, totalOnly: true }),
          { ...active, summary: { total: active.summary.total } });
      }
      await assert.rejects(autoAttribute(f, kind), emptyScope);
    });
  }
}

for (const mode of ['unknown', 'unresolved'] as const) {
  for (const kind of ['tag_extraction', 'membership_features'] as const) {
    test(`${kind} ${mode} batch blocks automatic replay before materialization and after cancellation`, async () => {
      const f = await fixture(kind);
      await unmaterializedRequest(f, mode);
      for (const cancelled of [false, true]) {
        if (cancelled) {
          await new AiRepository(db).cancelJob(f.job.id);
          const member = await db.selectFrom('ai_job_input_members').select('reason_code').where('job_id', '=', f.job.id).executeTakeFirstOrThrow();
          assert.equal(member.reason_code, 'job_cancelled');
        }
        await assert.rejects(autoAttribute(f, kind), emptyScope);
        const scope = { jobType: kind, status: 'attention', scopeShopId: f.shop.id };
        const queue = await readAiTaskQueue(db, scope);
        assert.equal(queue.summary.pendingProducts, 0);
        assert.equal(queue.summary.currentReasons.request_outcome_unknown, 1);
        assert.equal(queue.items.find(item => item.id === String(f.job.id))?.unclassified, 1);
        assert.deepEqual(await readAiTaskQueue(db, { ...scope, totalOnly: true }),
          { ...queue, summary: { total: queue.summary.total } });
      }
      await db.updateTable('products').set({ standardization_revision: 99n }).where('id', '=', f.product.id).execute();
      assert.ok((await autoAttribute(f, kind)).id > f.job.id, 'new evidence revision is independent');
    });
  }
  test(`identity ${mode} batch blocks backfill before materialization and after cancellation`, async () => {
    const f = await fixture();
    await db.deleteFrom('ai_standardization_results').where('job_id', '=', f.job.id).execute();
    await unmaterializedRequest(f, mode);
    assert.equal(await currentResult(f), true);
    const repo = new AiRepository(db);
    const pending = await repo.backfillMissingResults({ model: 'mock' });
    assert.equal(pending.productIds.includes(String(f.product.id)), false);
    await repo.cancelJob(f.job.id);
    assert.equal(await currentResult(f), true);
    await db.updateTable('products').set({ standardization_revision: 99n }).where('id', '=', f.product.id).execute();
    assert.equal(await currentResult(f), false);
  });
}

test('a materialized unknown result with old headers supersedes older current retry history', async () => {
  const f = await fixture();
  const newer = await db.insertInto('ai_jobs').values({
    model: 'mock', total: 1n, job_type: 'manual_full', status: 'ready_with_errors',
    prompt_version: 'older', rule_version: 'older', pipeline_versions: jsonb({}),
  }).returning('id').executeTakeFirstOrThrow();
  const member = await db.selectFrom('ai_job_input_members').selectAll().where('job_id', '=', f.job.id).executeTakeFirstOrThrow();
  const input = await db.selectFrom('ai_job_inputs').selectAll().where('job_id', '=', f.job.id).executeTakeFirstOrThrow();
  await db.insertInto('ai_job_inputs').values({ ...input, job_id: newer.id, payload: jsonb(input.payload) }).execute();
  await db.insertInto('ai_job_input_members').values({ ...member, job_id: newer.id, payload: jsonb(member.payload), output: null }).execute();
  const result = await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', f.job.id).executeTakeFirstOrThrow();
  await db.insertInto('ai_standardization_results').values({
    ...result, job_id: newer.id, reason_code: 'request_outcome_unknown',
    tags: jsonb([]), evidence: jsonb([]), decision: jsonb({}),
  }).execute();
  const current = () => currentUnclassifiedQuery(db).select('r.job_id').where('p.id', '=', f.product.id).execute();
  assert.deepEqual((await current()).map(row => row.job_id), [newer.id]);
  await db.updateTable('ai_job_input_members').set({ fingerprint: 'older-source' }).where('job_id', '=', newer.id).execute();
  assert.deepEqual((await current()).map(row => row.job_id), [f.job.id]);
});

test('stale active standardization work is not made executable or reused as current work', async () => {
  const f = await fixture();
  await changeVersions(f, { tagPrompt: 'older' });
  await db.updateTable('ai_jobs').set({ status: 'running' }).where('id', '=', f.job.id).execute();
  await db.updateTable('ai_job_input_members').set({ status: 'processing' }).where('job_id', '=', f.job.id).execute();
  const active = await db.selectFrom('products as p').select(hasActiveStandardizationWork.as('active'))
    .where('p.id', '=', f.product.id).executeTakeFirstOrThrow();
  assert.equal(active.active, false);
});

test('completed tags ignore standardization, feature and workflow versions and legacy job headers', async () => {
  const f = await fixture('tag_extraction');
  await changeVersions(f, {
    prompt: 'older', schema: 'older', retrieval: 'older', mapping: 'older', standardizationPolicy: 'older',
    standardizationReviewPrompt: 'older', membershipPolicy: 'older', membershipFeaturePrompt: 'older', membershipFeatureReviewPrompt: 'older',
    productTextReviewPrompt: 'older', standardizationRepair: 'older', reviewWorkflow: 'older',
    attributeOrder: 'older', offerEligibility: 'older',
  });
  await db.updateTable('ai_jobs').set({ prompt_version: 'older', rule_version: 'older' }).where('id', '=', f.job.id).execute();
  await assert.rejects(autoAttribute(f, 'tag_extraction'), emptyScope);
  const queue = await history(f);
  assert.equal(queue.summary.coveredProducts, 1);
  assert.equal(queue.summary.pendingProducts, 0);
  assert.equal(queue.items[0]?.configurationCurrent, false);
});

test('a newer incompatible unfinished tag job does not hide a reusable completed result', async () => {
  const f = await fixture('tag_extraction');
  const newer = await db.transaction().execute(tx => createTagJob(tx, { model: 'mock', productIds: [f.product.id] }));
  await db.updateTable('ai_jobs').set({ pipeline_versions: jsonb({ ...PIPELINE_VERSIONS, prompt: 'older' }) })
    .where('id', '=', newer.id).execute();
  await assert.rejects(autoAttribute(f, 'tag_extraction'), emptyScope);
  const queue = await history(f);
  assert.equal(queue.summary.coveredProducts, 1);
  assert.equal(queue.summary.pendingProducts, 0);
  assert.equal(queue.items.find(item => item.id === String(newer.id))?.remaining, 0);
  assert.equal((await readAiTaskQueue(db, { jobType: 'tag_extraction', scopeShopId: f.shop.id })).summary.total, 0);
});

for (const key of ['tagPrompt', 'tagProtocol', 'tagReviewPrompt', 'tagWarrantyPrompt', 'tagValidation', 'projection'] as const) {
  test(`completed tags invalidate their own ${key}`, async () => {
    const f = await fixture('tag_extraction');
    await changeVersions(f, { [key]: 'older' });
    const queue = await history(f);
    assert.equal(queue.summary.coveredProducts, 0);
    assert.equal(queue.summary.pendingProducts, 1);
    assert.ok((await autoAttribute(f, 'tag_extraction')).id > f.job.id);
  });
}

for (const change of ['source', 'fingerprint', 'contentVersion', 'revision', 'eligibility'] as const) {
  test(`completed tag reuse still requires current ${change}`, async () => {
    const f = await fixture('tag_extraction');
    if (change === 'source') await db.updateTable('shops').set({ url: 'https://changed.invalid' }).where('id', '=', f.shop.id).execute();
    else if (change === 'eligibility') await db.updateTable('standard_products').set({ canonical_tier: 'free' })
      .where('id', 'in', db.selectFrom('standard_product_members').select('standard_product_id').where('product_id', '=', f.product.id)).execute();
    else await db.updateTable('products').set(change === 'fingerprint' ? { content_fingerprint: 'changed' }
      : change === 'revision' ? { standardization_revision: 99n } : { content_version: 99n }).where('id', '=', f.product.id).execute();
    assert.ok((await autoAttribute(f, 'tag_extraction')).id > f.job.id);
  });
}

for (const kind of ['tag_extraction', 'membership_features'] as const) {
  test(`unknown ${kind} outcome cannot be bypassed by unrelated or own protocol versions`, async () => {
    const f = await fixture(kind);
    await changeVersions(f, { prompt: 'older', tagPrompt: 'older', membershipFeaturePrompt: 'older' });
    await db.updateTable('ai_jobs').set({ status: 'ready_with_errors', prompt_version: 'older', rule_version: 'older' })
      .where('id', '=', f.job.id).execute();
    await db.updateTable('ai_job_input_members').set({
      status: 'unclassified', reason_code: 'request_outcome_unknown',
      output: jsonb({ outcome: 'failed', reasonCode: 'request_outcome_unknown' }),
    }).where('job_id', '=', f.job.id).execute();
    await assert.rejects(autoAttribute(f, kind), emptyScope);
    const queue = await history(f);
    assert.equal(queue.summary.coveredProducts, 0);
    assert.equal(queue.summary.pendingProducts, 0);
    assert.equal(queue.summary.currentReasons.request_outcome_unknown, 1);
    assert.equal(queue.summary.attention, 1);
    const other = kind === 'tag_extraction' ? 'membership_features' : 'tag_extraction';
    assert.ok((await autoAttribute(f, other)).id > f.job.id, 'another stage is independent');
    await db.updateTable('shops').set({ url: `https://new-${kind}.invalid` }).where('id', '=', f.shop.id).execute();
    assert.ok((await autoAttribute(f, kind)).id > f.job.id, 'new source evidence can run');
  });
}

test('all-pending tag preparation does not automatically retry an unknown outcome', async () => {
  const f = await fixture('tag_extraction');
  await changeVersions(f, { tagPrompt: 'older' });
  await db.updateTable('ai_job_input_members').set({
    status: 'unclassified', reason_code: 'request_outcome_unknown', output: null,
  }).where('job_id', '=', f.job.id).execute();
  const queued = await createManualTagJob(db, { allPending: true, model: 'mock', requestId: randomUUID() });
  const batch = await db.updateTable('ai_job_batches').set({
    status: 'running', claimed_by: 'test', claim_token: 'test', attempts: 1n, lease_until: new Date(Date.now() + 60_000),
  }).where('job_id', '=', queued.id).returning('id').executeTakeFirstOrThrow();
  await prepareAllPendingTagJob(db, batch.id, { workerId: 'test', token: 'test', attempt: 1n });
  const member = await db.selectFrom('ai_job_input_members').select('product_id')
    .where('job_id', '=', queued.id).where('product_id', '=', f.product.id).executeTakeFirst();
  assert.equal(member, undefined);
});

test('approved feature snapshots survive old prompt protocols with the same policy and source', async () => {
  const f = await fixture('membership_features');
  await changeVersions(f, { membershipFeaturePrompt: 'older', membershipFeatureReviewPrompt: 'older', tagPrompt: 'older' });
  const snapshot = buildMembershipFeatures([], {
    ...f.product, shop_url: f.shop.url, shop_protocol: f.shop.protocol, shop_platform: f.shop.platform,
  }, [], 'account');
  await db.updateTable('products').set({ membership_features: jsonb(snapshot as unknown as JsonValue) })
    .where('id', '=', f.product.id).execute();
  await db.updateTable('ai_job_input_members').set({ output: jsonb({ outcome: 'updated' }) }).where('job_id', '=', f.job.id).execute();
  await assert.rejects(autoAttribute(f, 'membership_features'), emptyScope);
  const queue = await history(f);
  assert.equal(queue.summary.coveredProducts, 1);
  assert.equal(queue.summary.pendingProducts, 0);
  await db.updateTable('shops').set({ url: 'https://changed-membership.invalid' }).where('id', '=', f.shop.id).execute();
  assert.ok((await autoAttribute(f, 'membership_features')).id > f.job.id);
});

test('a later completed tag failure supersedes older coverage across identity versions in every history page', async () => {
  const f = await fixture('tag_extraction');
  const newer = await db.transaction().execute(tx => createTagJob(tx, { model: 'mock', productIds: [f.product.id] }));
  await db.updateTable('ai_jobs').set({
    status: 'succeeded', pipeline_versions: jsonb({ ...PIPELINE_VERSIONS, prompt: 'older' }),
  }).where('id', '=', newer.id).execute();
  await db.updateTable('ai_job_input_members').set({
    status: 'unclassified', output: jsonb({ outcome: 'failed', reasonCode: 'provider_error' }),
  }).where('job_id', '=', newer.id).execute();
  const all = await history(f);
  assert.equal(all.summary.coveredProducts, 0);
  assert.equal(all.summary.pendingProducts, 1);
  assert.equal(all.summary.currentReasons.provider_error, 1);
  for (const status of ['all', 'attention', 'unfinished']) {
    let cursor: string | undefined;
    do {
      const input = { jobType: 'tag_extraction', status, scopeShopId: f.shop.id, limit: 1, cursor };
      const full = await readAiTaskQueue(db, input);
      assert.equal(full.summary.pendingProducts, status === 'unfinished' ? 0 : 1);
      assert.deepEqual(await readAiTaskQueue(db, { ...input, totalOnly: true }),
        { ...full, summary: { total: full.summary.total } });
      cursor = full.nextCursor ?? undefined;
    } while (cursor);
  }
  assert.ok((await autoAttribute(f, 'tag_extraction')).id > newer.id);
});

test('unknown tag history without an output remains attention, not automatic pending work', async () => {
  const f = await fixture('tag_extraction');
  await changeVersions(f, { tagPrompt: 'older' });
  await db.updateTable('ai_job_input_members').set({
    status: 'unclassified', output: null, reason_code: 'request_outcome_unknown',
  }).where('job_id', '=', f.job.id).execute();
  const scope = { jobType: 'tag_extraction', status: 'attention', scopeShopId: f.shop.id };
  const queue = await readAiTaskQueue(db, scope);
  assert.equal(queue.summary.total, 1);
  assert.equal(queue.summary.pendingProducts, 0);
  assert.equal(queue.items[0]?.unclassified, 1);
  assert.deepEqual(await readAiTaskQueue(db, { ...scope, totalOnly: true }),
    { ...queue, summary: { total: queue.summary.total } });
});

test('text review history retains its full-version compatibility rule', async () => {
  const f = await fixture('text_review');
  const capture = captureRatingText('listing', f.product.name, 'Support provided.')!;
  await db.updateTable('products').set({ source_data: jsonb({ ratingText: capture }) }).where('id', '=', f.product.id).execute();
  const member = await db.selectFrom('ai_job_input_members').select('payload').where('job_id', '=', f.job.id).executeTakeFirstOrThrow();
  await db.updateTable('ai_job_input_members').set({
    payload: jsonb({ ...member.payload as Record<string, JsonValue>, shopText: capture }), output: jsonb({ outcome: 'updated' }),
  }).where('job_id', '=', f.job.id).execute();
  assert.equal((await history(f)).summary.coveredProducts, 1);
  await changeVersions(f, { tagPrompt: 'older' });
  const queue = await history(f);
  assert.equal(queue.summary.coveredProducts, 0);
  assert.equal(queue.summary.pendingProducts, 1);
});

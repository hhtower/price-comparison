import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, test } from 'node:test';
import { Kysely, PostgresDialect, type Selectable } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';
import { jsonb, type DatabaseSchema, type JsonValue } from '../src/database/types.js';
import { assertCurrentPipeline, pipelineVersionSnapshot, PIPELINE_VERSIONS, STANDARDIZATION_POLICY_VERSION } from '../src/ai/pipeline-versions.js';
import { hasCurrentStandardizationResult, hasManualIsolation, productStandardizationOutcome } from '../src/ai/product-standardization-state.js';
import { readRetryPool } from '../src/ai/ai-retry-pool.js';
import { createManualTagJob, createManualMembershipFeatureJob, createManualProductTextReviewJob, createTagJob, previewMembershipFeatureJob } from '../src/ai/tag-extraction-jobs.js';
import { suppressManualDecisionTrigger } from '../src/standardization/decision-history.js';
import { AdminRepository } from '../src/admin/admin.repository.js';
import { JobsRepository } from '../src/jobs/jobs.repository.js';
import { readAiTaskQueue } from '../src/ai/ai-task-queue.js';
import { IDENTITY_POLICY_VERSION } from '../src/standardization/identity-policy.js';
import { AiRepository } from '../src/ai/ai.repository.js';
import { buildMembershipFeatures } from '../src/standardization/membership-classification.js';
import { finalizeOrScheduleMissing } from '../src/ai/standardization-finalizer.js';
import { seedUsableOffers } from './standardization-review-fixture.js';
import { parseStandardizationProtocolResponse } from '../src/ai/ai.schemas.js';
import { parseStandardizationReviewResponse } from '../src/ai/standardization-review-request.js';

let db: Kysely<DatabaseSchema>, admin: Pool, schema: string;
before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'Dedicated TEST_DATABASE_URL required');
  schema = `match_state_${randomUUID().replaceAll('-', '')}`;
  admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({
    connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public`,
  }) }) });
  const migrated = await new Migrator({ db, provider: migrationProvider, migrationTableSchema: schema }).migrateToLatest();
  if (migrated.error) throw migrated.error;
});
afterEach(async () => { await db.updateTable('shops').set({ enabled: false }).execute(); });
after(async () => {
  await db?.destroy();
  if (admin && schema) await admin.query(`drop schema "${schema}" cascade`);
  await admin?.end();
});

const evidence = [{ path: 'name', quote: 'Unmatched offer' }];
async function fixture(existingProduct?: Selectable<DatabaseSchema['products']>, nullReason: 'candidate_unavailable' | 'insufficient_source' = 'insufficient_source') {
  const shopId = existingProduct?.shop_id ?? (await db.insertInto('shops').values({ platform: 'test', name: 'match state', url: `https://${randomUUID()}.invalid` })
    .returning('id').executeTakeFirstOrThrow()).id;
  const product = existingProduct ?? await db.insertInto('products').values({
    shop_id: shopId, external_id: randomUUID(), name: nullReason === 'candidate_unavailable' ? 'Cursor Pro' : 'Unmatched offer', normalized_key: randomUUID(), url: '',
  }).returningAll().executeTakeFirstOrThrow();
  if (!existingProduct) await seedUsableOffers(db, [product.id]);
  const evidence = [{ path: 'name', quote: product.name }];
  const input = { id: String(product.id), candidateStandardProductIds: [] };
  const proposals = parseStandardizationProtocolResponse({ items: [{
    id: input.id, standardProductId: null, nullReason, evidence,
  }] }, [input]);
  const decision = parseStandardizationReviewResponse(JSON.stringify({ items: [{
    id: input.id, approved: true, code: null, evidence: [],
  }] }), proposals, {
    model: 'mock', candidates: [], inputs: [{ productId: product.id, payload: { name: product.name }, candidateStandardProductIds: [] }],
  }).items[0]!;
  const job = await db.insertInto('ai_jobs').values({
    model: 'mock', job_type: 'manual_full', status: 'succeeded', phase: 'completed', total: 1n,
    prompt_version: PIPELINE_VERSIONS.prompt, rule_version: STANDARDIZATION_POLICY_VERSION,
    pipeline_versions: jsonb(pipelineVersionSnapshot('mock')),
  }).returningAll().executeTakeFirstOrThrow();
  await db.insertInto('ai_job_inputs').values({
    job_id: job.id, input_id: product.id, payload: jsonb({ name: product.name }), fingerprint: product.content_fingerprint,
    content_version: product.content_version, input_bytes: 30n, estimated_tokens: 8n, status: 'succeeded',
  }).execute();
  await db.insertInto('ai_job_input_members').values({
    job_id: job.id, input_id: product.id, product_id: product.id, payload: jsonb({ name: product.name }),
    content_version: product.content_version, fingerprint: product.content_fingerprint,
    standardization_revision: product.standardization_revision, status: 'unclassified', reason_code: decision.reasonCode,
  }).execute();
  await db.insertInto('ai_standardization_results').values({
    job_id: job.id, input_id: product.id, product_id: product.id, batch_id: null,
    content_version: product.content_version, fingerprint: product.content_fingerprint, status: 'unclassified',
    standard_product_id: null, tags: jsonb([]), evidence: jsonb(evidence), reason_code: decision.reasonCode, reason: decision.reason,
    decision: jsonb(decision as unknown as JsonValue),
    current_assignment_preserved: false,
  }).execute();
  return { product, job };
}

async function technicalFailure(existingProduct?: Selectable<DatabaseSchema['products']>) {
  const f = await fixture(existingProduct);
  await db.deleteFrom('ai_standardization_results').where('job_id', '=', f.job.id).execute();
  await db.updateTable('ai_jobs').set({ status: 'running', phase: 'standardizing' }).where('id', '=', f.job.id).execute();
  await db.updateTable('ai_job_inputs').set({ status: 'running', reason_code: null }).where('job_id', '=', f.job.id).execute();
  await db.updateTable('ai_job_input_members').set({ status: 'processing', reason_code: null }).where('job_id', '=', f.job.id).execute();
  await db.insertInto('ai_job_batches').values({
    job_id: f.job.id, batch_index: 0n, product_ids: jsonb([String(f.product.id)]), product_count: 1n,
    status: 'failed', step: 'request', error_source: 'provider_error', error: 'Fixture provider unavailable',
  }).execute();
  await db.transaction().execute(tx => finalizeOrScheduleMissing(tx, f.job.id));
  return f;
}

const retry = () => readRetryPool(db, { limit: 100 });
const outcome = (id: bigint) => db.selectFrom('products as p')
  .select([hasManualIsolation().as('isolated'), productStandardizationOutcome().as('outcome')])
  .where('p.id', '=', id).executeTakeFirstOrThrow();

test('technical failures stay visible in the retry pool without invented evidence or cannot-process outcome', async () => {
  const { product } = await technicalFailure();
  assert.deepEqual(await outcome(product.id), { isolated: false, outcome: null });
  const pool = await retry();
  assert.equal(pool.total, 1);
  assert.equal(pool.items[0]?.reasonCode, 'provider_error');
  assert.deepEqual(pool.items[0]?.evidence, []);
  const page = await new AdminRepository(db).listProducts({ pending: true, shopId: product.shop_id, limit: 10 });
  assert.equal(page.items[0]?.processing_summary?.processingDisposition, 'retry_available');
  assert.equal(Object.hasOwn(page.items[0]!.processing_summary!, 'evidence'), false);
});

for (const nullReason of ['candidate_unavailable', 'insufficient_source'] as const) test(`${nullReason} remains review-required with source evidence and cannot enter the retry pool`, async () => {
  const { product, job } = await fixture(undefined, nullReason);
  assert.deepEqual(await outcome(product.id), { isolated: false, outcome: null });
  assert.equal((await retry()).total, 0);
  const page = await new AdminRepository(db).listProducts({ pending: true, shopId: product.shop_id, limit: 10 });
  assert.equal(page.items[0]?.processing_summary?.reasonCode, nullReason);
  assert.equal(page.items[0]?.processing_summary?.processingDisposition, 'review_required');
  assert.deepEqual(page.items[0]?.processing_summary?.evidence, [{ path: 'name', quote: product.name }]);
  await assert.rejects(new AiRepository(db).retryJob(job.id), { code: 'AI_JOB_STATE' });
  assert.deepEqual(await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', job.id).execute(), []);
});

test('pending summaries omit citations from stale evidence, stale revisions and missing input members', async () => {
  const { product, job } = await fixture();
  const summary = async () => (await new AdminRepository(db).listProducts({ pending: true, shopId: product.shop_id, limit: 10 }))
    .items[0]!.processing_summary!;
  for (const stale of [{ content_version: product.content_version + 1n }, { fingerprint: 'old-result' }]) {
    await db.updateTable('ai_standardization_results').set({
      content_version: product.content_version, fingerprint: product.content_fingerprint, ...stale,
    }).where('job_id', '=', job.id).execute();
    const state = await summary();
    assert.equal(state.reasonCode, 'source_changed');
    assert.equal(Object.hasOwn(state, 'evidence'), false);
  }
  await db.updateTable('ai_standardization_results').set({
    content_version: product.content_version, fingerprint: product.content_fingerprint,
  }).where('job_id', '=', job.id).execute();
  for (const stale of [
    { content_version: product.content_version + 1n }, { fingerprint: 'old-member' },
    { standardization_revision: product.standardization_revision + 1n },
  ]) {
    await db.updateTable('ai_job_input_members').set({
      content_version: product.content_version, fingerprint: product.content_fingerprint,
      standardization_revision: product.standardization_revision, ...stale,
    }).where('job_id', '=', job.id).execute();
    const state = await summary();
    assert.equal(state.reasonCode, 'source_changed');
    assert.equal(Object.hasOwn(state, 'evidence'), false);
  }
  await db.deleteFrom('ai_job_input_members').where('job_id', '=', job.id).execute();
  const state = await summary();
  assert.equal(state.reasonCode, 'source_changed');
  assert.equal(Object.hasOwn(state, 'evidence'), false);
  assert.deepEqual((await db.selectFrom('ai_standardization_results').select('evidence').where('job_id', '=', job.id).executeTakeFirstOrThrow()).evidence, evidence);
});

test('unknown or stale manual evidence is not a wildcard; exact evidence and ongoing locks protect', async () => {
  const { product } = await technicalFailure();
  const decision = {
    product_id: product.id, action: 'exclude' as const, reason: 'historical review', source: 'direct_sql' as const,
    content_version: product.content_version, content_fingerprint: product.content_fingerprint,
    evidence_known: false, evidence_snapshot: jsonb({ name: product.name }),
  };
  await db.insertInto('product_standardization_decisions').values(decision).execute();
  assert.deepEqual(await outcome(product.id), { isolated: false, outcome: null });
  assert.equal((await retry()).total, 1);
  await db.insertInto('product_standardization_decisions').values({ ...decision, evidence_known: true }).execute();
  assert.deepEqual(await outcome(product.id), { isolated: true, outcome: 'cannot_process' });
  assert.equal((await retry()).total, 0);
  await db.insertInto('product_standardization_decisions').values({ ...decision, evidence_known: true, content_fingerprint: 'stale' }).execute();
  assert.deepEqual(await outcome(product.id), { isolated: false, outcome: null });
  assert.equal((await retry()).total, 1);
  await db.updateTable('products').set({ standardization_locked: true }).where('id', '=', product.id).execute();
  assert.deepEqual(await outcome(product.id), { isolated: true, outcome: 'cannot_process' });
  assert.equal((await retry()).total, 0);
});

test('unreviewed historical human membership does not hide retryable technical work', async () => {
  const { product, job } = await technicalFailure();
  const standard = await db.insertInto('standard_products').values({ name: 'Historical target', verification_state: 'quarantined' })
    .returning('id').executeTakeFirstOrThrow();
  await db.transaction().execute(async tx => {
    await suppressManualDecisionTrigger(tx, [product.id]);
    await tx.insertInto('standard_product_members').values({
      product_id: product.id, standard_product_id: standard.id, assignment_source: 'human', publication_state: 'quarantined',
    }).execute();
  });
  assert.deepEqual(await outcome(product.id), { isolated: false, outcome: null });
  assert.equal((await retry()).total, 1);
  await db.updateTable('ai_jobs').set({ status: 'queued' }).where('id', '=', job.id).execute();
  await db.updateTable('ai_job_input_members').set({ status: 'queued' }).where('job_id', '=', job.id).execute();
  assert.equal((await readAiTaskQueue(db, { status: 'unfinished', scopeShopId: product.shop_id })).items[0]?.remaining, 1);
});

test('old active jobs cannot suppress retry, while current active jobs do', async () => {
  const { product } = await technicalFailure();
  const { job } = await fixture(product);
  await db.deleteFrom('ai_standardization_results').where('job_id', '=', job.id).execute();
  await db.updateTable('ai_jobs').set({ status: 'queued', pipeline_versions: jsonb({}) }).where('id', '=', job.id).execute();
  await db.updateTable('ai_job_input_members').set({ status: 'queued' }).where('job_id', '=', job.id).execute();
  assert.equal((await retry()).total, 1);
  await db.updateTable('ai_jobs').set({ pipeline_versions: jsonb(pipelineVersionSnapshot('mock')) }).where('id', '=', job.id).execute();
  assert.equal((await retry()).total, 0);
});

test('model refusals cannot create a cannot-process outcome', async () => {
  const { product, job } = await fixture();
  for (const reason of ['insufficient_evidence', 'not_sellable']) {
    await db.updateTable('ai_standardization_results').set({ reason_code: reason }).where('job_id', '=', job.id).execute();
    assert.deepEqual(await outcome(product.id), { isolated: false, outcome: null });
  }
});

test('old prompt, rule or snapshot results cannot block processing or enter current retry and summaries', async () => {
  const { product, job } = await technicalFailure();
  const current = () => db.selectFrom('products as p').select(hasCurrentStandardizationResult().as('current'))
    .where('p.id', '=', product.id).executeTakeFirstOrThrow();
  assert.equal((await current()).current, true);
  for (const stale of [
    { prompt_version: 'old' }, { rule_version: IDENTITY_POLICY_VERSION }, { pipeline_versions: jsonb({}) },
  ]) {
    await db.updateTable('ai_jobs').set({
      prompt_version: PIPELINE_VERSIONS.prompt, rule_version: STANDARDIZATION_POLICY_VERSION,
      pipeline_versions: jsonb(pipelineVersionSnapshot('mock')), ...stale,
    }).where('id', '=', job.id).execute();
    assert.equal((await current()).current, false);
    assert.equal((await retry()).total, 0);
    const page = await new AdminRepository(db).listProducts({ pending: true, shopId: product.shop_id, limit: 10 });
    assert.equal(page.items[0]?.processing_summary?.reasonCode, 'not_processed');
    assert.equal(Object.hasOwn(page.items[0]!.processing_summary!, 'evidence'), false);
    assert.equal((await db.selectFrom('ai_standardization_results').select('product_id').where('job_id', '=', job.id).execute()).length, 1);
  }
});

test('a newer obsolete result cannot hide a current retry or pending item', async () => {
  const { product, job } = await technicalFailure();
  const newer = await technicalFailure(product);
  await db.updateTable('ai_jobs').set({ pipeline_versions: jsonb({}), status: 'queued' }).where('id', '=', newer.job.id).execute();
  assert.equal((await retry()).items[0]?.sourceJobId, String(job.id));
  await db.updateTable('ai_jobs').set({ status: 'queued' }).where('id', '=', job.id).execute();
  await db.updateTable('ai_job_input_members').set({ status: 'queued' }).where('job_id', '=', job.id).execute();
  const queue = await readAiTaskQueue(db, { status: 'unfinished', scopeShopId: product.shop_id });
  assert.equal(queue.items[0]?.remaining, 1);
  await db.updateTable('ai_jobs').set({ status: 'succeeded', pipeline_versions: jsonb(pipelineVersionSnapshot('mock')) }).where('id', '=', newer.job.id).execute();
  await db.updateTable('ai_jobs').set({ status: 'succeeded' }).where('id', '=', job.id).execute();
  assert.equal((await retry()).items[0]?.sourceJobId, String(newer.job.id));
});

test('all attribute job producers use the shared current task policy', async () => {
  for (const create of [createManualTagJob, createManualMembershipFeatureJob, createManualProductTextReviewJob]) {
    const job = await create(db, { model: 'mock', allPending: true, requestId: randomUUID() });
    assert.doesNotThrow(() => assertCurrentPipeline(job));
    const reused = await create(db, { model: 'mock', allPending: true, requestId: randomUUID() });
    assert.equal(reused.id, job.id);
    for (const totalOnly of [false, true]) {
      const queue = await readAiTaskQueue(db, { jobType: job.job_type, status: 'unfinished', totalOnly });
      assert.ok(queue.items.some(item => item.id === String(job.id)));
      assert.equal(queue.items.find(item => item.id === String(job.id))?.configurationCurrent, true);
    }
  }
  const { product } = await fixture();
  const standard = await db.insertInto('standard_products').values({ name: 'Published target', verification_state: 'verified' })
    .returning('id').executeTakeFirstOrThrow();
  await db.insertInto('standard_product_members').values({
    product_id: product.id, standard_product_id: standard.id, assignment_source: 'ai', publication_state: 'published',
  }).execute();
  const automatic = await db.transaction().execute(tx => createTagJob(tx, { model: 'mock', productIds: [product.id] }));
  assert.doesNotThrow(() => assertCurrentPipeline(automatic));
  const batch = await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', automatic.id).executeTakeFirstOrThrow();
  const claim = { workerId: 'attribute-version', attempt: 1n, token: randomUUID() };
  await db.updateTable('ai_job_batches').set({ status: 'running', claimed_by: claim.workerId, attempts: claim.attempt,
    claim_token: claim.token, lease_until: new Date(Date.now() + 60000) }).where('id', '=', batch.id).execute();
  assert.equal(await new AiRepository(db).reserveBatchRequest(batch.id, claim), 'reserved');
});

test('automatic children skip current membership features but retain missing/stale features and explicit manual requests', async () => {
  const previous = process.env.AI_TAG_EXTRACTION_ENABLED;
  process.env.AI_TAG_EXTRACTION_ENABLED = 'true';
  try {
    for (const state of ['current', 'stale', 'missing']) {
      const { product, job } = await fixture();
      if (state !== 'missing') await db.updateTable('products').set({
        membership_features: jsonb(buildMembershipFeatures([], {
          ...product, content_fingerprint: state === 'stale' ? 'old' : product.content_fingerprint,
        }, [], 'short_term') as unknown as JsonValue),
      }).where('id', '=', product.id).execute();
      const standard = await db.insertInto('standard_products').values({
        name: 'ChatGPT Plus', canonical_family: 'openai', canonical_product: 'chatgpt', canonical_tier: 'plus',
        verification_state: 'verified', catalog_definition: 'ChatGPT Plus subscriptions and accounts.',
      }).returning('id').executeTakeFirstOrThrow();
      await db.insertInto('standard_product_members').values({
        product_id: product.id, standard_product_id: standard.id, assignment_source: 'ai', publication_state: 'published',
      }).execute();
      await db.updateTable('ai_jobs').set({ status: 'running' }).where('id', '=', job.id).execute();
      await db.updateTable('ai_standardization_results').set({ status: 'classified', standard_product_id: standard.id, reason_code: null })
        .where('job_id', '=', job.id).execute();
      await db.updateTable('ai_job_input_members').set({ status: 'classified' }).where('job_id', '=', job.id).execute();
      await db.transaction().execute(tx => finalizeOrScheduleMissing(tx, job.id));
      const children = await db.selectFrom('ai_jobs').select('job_type').where('parent_identity_job_id', '=', job.id).orderBy('job_type').execute();
      assert.deepEqual(children.map(child => child.job_type),
        state === 'current' ? ['tag_extraction'] : ['membership_features', 'tag_extraction']);
      if (state === 'current') {
        const input = { model: 'mock', productIds: [product.id] };
        const preview = await previewMembershipFeatureJob(db, input);
        const manual = await createManualMembershipFeatureJob(db, { ...input, requestId: randomUUID(), previewDigest: preview.previewDigest });
        assert.equal(manual.job_type, 'membership_features');
        assert.equal(manual.parent_identity_job_id, null);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.AI_TAG_EXTRACTION_ENABLED;
    else process.env.AI_TAG_EXTRACTION_ENABLED = previous;
  }
});

test('pending summaries protect only known current manual evidence or an explicit lock', async () => {
  const { product } = await fixture();
  const decision = {
    product_id: product.id, action: 'unbind' as const, reason: 'manual review', source: 'direct_sql' as const,
    content_version: product.content_version, content_fingerprint: product.content_fingerprint,
    evidence_known: false, evidence_snapshot: jsonb({ name: product.name }),
  };
  const adminRepository = new AdminRepository(db);
  const summary = async () => (await adminRepository.listProducts({ pending: true, shopId: product.shop_id, limit: 10 }))
    .items.find(item => item.id === product.id)?.processing_summary;
  await db.insertInto('product_standardization_decisions').values(decision).execute();
  assert.equal((await summary())?.reasonCode, 'insufficient_source');
  await db.insertInto('product_standardization_decisions').values({ ...decision, evidence_known: true }).execute();
  assert.equal((await summary())?.reasonCode, 'manual_decision_preserved');
  assert.equal(Object.hasOwn((await summary())!, 'evidence'), false);
  await db.insertInto('product_standardization_decisions').values({ ...decision, evidence_known: true, content_fingerprint: 'stale' }).execute();
  assert.equal((await summary())?.reasonCode, 'insufficient_source');
  await db.updateTable('products').set({ standardization_locked: true }).where('id', '=', product.id).execute();
  assert.equal((await summary())?.reasonCode, 'manual_decision_preserved');
  assert.equal(Object.hasOwn((await summary())!, 'evidence'), false);
});

test('claims and identity queue reject old rules and snapshots while admitting current tasks', async () => {
  const { product, job } = await fixture();
  await db.updateTable('ai_jobs').set({ status: 'queued', priority: 100000 }).where('id', '=', job.id).execute();
  await db.updateTable('ai_job_input_members').set({ status: 'queued' }).where('job_id', '=', job.id).execute();
  const obsolete = await db.insertInto('ai_jobs').values([
    { model: 'old rule', job_type: 'manual_full', status: 'queued', total: 1n, priority: 100001, scope_shop_id: product.shop_id,
      prompt_version: PIPELINE_VERSIONS.prompt, rule_version: IDENTITY_POLICY_VERSION, pipeline_versions: jsonb(pipelineVersionSnapshot('mock')) },
    { model: 'old snapshot', job_type: 'manual_full', status: 'queued', total: 1n, priority: 100002, scope_shop_id: product.shop_id,
      prompt_version: PIPELINE_VERSIONS.prompt, rule_version: STANDARDIZATION_POLICY_VERSION, pipeline_versions: jsonb({}) },
  ]).returning('id').execute();
  const batches = await db.insertInto('ai_job_batches').values([job, ...obsolete].map(parent => ({
    job_id: parent.id, batch_index: 0n, product_ids: jsonb([String(product.id)]), product_count: 1n,
    status: 'queued' as const, step: 'request' as const, request_budget_limit: 2,
  }))).returning(['id', 'job_id']).execute();
  const claimed = await new JobsRepository(db).claimNext('ai_batch', 'match-only-claim', 30000);
  assert.equal(claimed?.id, batches.find(batch => batch.job_id === job.id)?.id);
  const queue = await readAiTaskQueue(db, { status: 'unfinished', scopeShopId: product.shop_id });
  assert.deepEqual(queue.items.map(item => item.id), [String(job.id)]);
  const oldBatches = await db.selectFrom('ai_job_batches').select('status').where('job_id', 'in', obsolete.map(parent => parent.id)).execute();
  assert.deepEqual(oldBatches.map(batch => batch.status), ['queued', 'queued']);
});

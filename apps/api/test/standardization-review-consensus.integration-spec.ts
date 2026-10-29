import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Kysely, Migrator, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';
import { finalizeOrScheduleMissing } from '../src/ai/standardization-finalizer.js';
import { pipelineVersionSnapshot } from '../src/ai/pipeline-versions.js';
import { jsonb, type AiJobStatus, type DatabaseSchema, type JsonValue, type StandardizationMemberStatus } from '../src/database/types.js';
import { reconcileNameConsensus } from '../src/standardization/name-consensus-repair.js';
import { productContentFingerprint } from '../src/standardization/fingerprint.js';

let db: Kysely<DatabaseSchema>, admin: Pool, schema: string;
let majorityId: bigint, minorityId: bigint;
before(async () => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url?.trim(), 'TEST_DATABASE_URL required');
  schema = `review_consensus_${randomUUID().replaceAll('-', '')}`;
  admin = new Pool({ connectionString: url });
  await admin.query(`create schema "${schema}"`);
  db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({
    connectionString: url, options: `-c search_path=${schema},public`, max: 4,
  }) }) });
  const migrated = await new Migrator({ db, provider: migrationProvider, migrationTableSchema: schema }).migrateToLatest();
  if (migrated.error) throw migrated.error;
  const standards = await db.insertInto('standard_products').values(['plus', 'free'].map(tier => ({
    name: `ChatGPT ${tier}`, canonical_family: 'openai', canonical_product: 'chatgpt',
    canonical_tier: tier, verification_state: 'verified' as const,
  }))).returning('id').execute();
  majorityId = standards[0]!.id;
  minorityId = standards[1]!.id;
});
after(async () => {
  await db?.destroy();
  if (schema) await admin.query(`drop schema "${schema}" cascade`);
  await admin?.end();
});

async function fixture(assigned: boolean, peers = true) {
  const shop = await db.insertInto('shops').values({
    platform: 'test', name: 'Consensus review test', url: `https://${randomUUID()}.invalid`, enabled: true,
  }).returning('id').executeTakeFirstOrThrow();
  const name = `ChatGPT Plus consensus regression ${randomUUID()}`;
  const products = await db.insertInto('products').values(Array.from({ length: peers ? 4 : 1 }, (_, index) => ({
    shop_id: shop.id, external_id: String(index), name, spec: '', source_category: '',
    source_data: jsonb({}), normalized_key: randomUUID(), url: '', content_version: 1n,
    source_name: name, content_fingerprint: productContentFingerprint({ name }),
  }))).returning('id').execute();
  const target = products[0]!;
  if (peers) await db.insertInto('standard_product_members').values(products.slice(1).map(product => ({
    product_id: product.id, standard_product_id: majorityId, assignment_source: 'ai', publication_state: 'published' as const,
  }))).execute();
  if (assigned) await db.insertInto('standard_product_members').values({
    product_id: target.id, standard_product_id: minorityId, assignment_source: 'ai', publication_state: 'published',
  }).execute();
  return target.id;
}

type WorkOptions = {
  status?: AiJobStatus;
  memberStatus?: StandardizationMemberStatus;
  contentVersion?: bigint;
  revision?: bigint;
  pendingReview?: boolean;
  cancelRequested?: boolean;
  fingerprint?: string;
};
async function work(productId: bigint, options: WorkOptions = {}) {
  const product = await db.selectFrom('products').selectAll().where('id', '=', productId).executeTakeFirstOrThrow();
  const job = await db.insertInto('ai_jobs').values({
    model: 'mock', total: 1n, status: options.status ?? 'succeeded', cancel_requested: options.cancelRequested ?? false,
  }).returning('id').executeTakeFirstOrThrow();
  await db.insertInto('ai_job_inputs').values({
    job_id: job.id, input_id: productId, fingerprint: options.fingerprint ?? product.content_fingerprint, payload: jsonb({}),
    content_version: options.contentVersion ?? product.content_version,
    status: options.memberStatus === 'queued' ? 'queued' : options.memberStatus === 'processing' ? 'running' : 'succeeded',
  }).execute();
  await db.insertInto('ai_job_input_members').values({
    job_id: job.id, input_id: productId, product_id: productId, fingerprint: options.fingerprint ?? product.content_fingerprint, payload: jsonb({}),
    content_version: options.contentVersion ?? product.content_version,
    standardization_revision: options.revision ?? product.standardization_revision,
    status: options.memberStatus ?? 'classified',
  }).execute();
  if (options.pendingReview) await db.insertInto('ai_job_batches').values({
    job_id: job.id, batch_index: 0n, product_ids: jsonb([String(productId)]), product_count: 1n,
    status: 'queued', step: 'request', reference_snapshot: jsonb({ standardizationStage: 'review' }),
  }).execute();
  return job.id;
}

async function result(productId: bigint, approved: JsonValue | undefined, options: WorkOptions & { resultVersion?: bigint } = {}) {
  const jobId = await work(productId, options);
  const product = await db.selectFrom('products').select(['content_version', 'content_fingerprint']).where('id', '=', productId).executeTakeFirstOrThrow();
  await db.insertInto('ai_standardization_results').values({
    job_id: jobId, input_id: productId, product_id: productId,
    content_version: options.resultVersion ?? options.contentVersion ?? product.content_version,
    fingerprint: options.fingerprint ?? product.content_fingerprint, status: approved === true ? 'classified' : 'unclassified',
    standard_product_id: approved === true ? minorityId : null,
    reason_code: approved === true ? null : approved === false ? 'review_rejected' : 'insufficient_evidence',
    reason: 'Fixture decision', decision: jsonb(approved === undefined ? {} : { review: { approved } }),
  }).execute();
  return jobId;
}

async function failedReview(productId: bigint, errorSource: string, options: WorkOptions & { stage?: string } = {}) {
  const jobId = await work(productId, { ...options, status: 'running', memberStatus: 'processing' });
  const generation = await db.insertInto('ai_job_batches').values({
    job_id: jobId, batch_index: 0n, product_ids: jsonb([String(productId)]), product_count: 1n,
    status: 'succeeded', step: 'done', validated_decision: jsonb({
      items: [{ id: String(productId), status: 'unclassified', reasonCode: 'insufficient_evidence',
        reason: 'Frozen proposal', ruleIds: [], evidence: [] }], identities: [], missingIds: [],
    }),
  }).returning('id').executeTakeFirstOrThrow();
  await db.insertInto('ai_job_batches').values({
    job_id: jobId, batch_index: 1n, product_ids: jsonb([String(productId)]), product_count: 1n,
    status: 'failed', step: 'request', error_source: errorSource,
    reference_snapshot: jsonb({ standardizationStage: options.stage ?? 'review', generationBatchId: String(generation.id) }),
  }).execute();
  await db.transaction().execute(tx => finalizeOrScheduleMissing(tx, jobId));
  const terminal = await db.selectFrom('ai_standardization_results').select(['decision', 'reason_code'])
    .where('job_id', '=', jobId).where('product_id', '=', productId).executeTakeFirstOrThrow();
  assert.equal(terminal.reason_code, errorSource);
  assert.equal((terminal.decision as Record<string, JsonValue>).review, undefined);
  assert.equal((await db.selectFrom('ai_jobs').select('status').where('id', '=', jobId).executeTakeFirstOrThrow()).status, 'ready_with_errors');
  return jobId;
}

async function assertProtected(productId: bigint) {
  const productBefore = await db.selectFrom('products').selectAll().where('id', '=', productId).executeTakeFirstOrThrow();
  const membershipBefore = await db.selectFrom('standard_product_members').selectAll().where('product_id', '=', productId).execute();
  const resultsBefore = await db.selectFrom('ai_standardization_results').selectAll().where('product_id', '=', productId).orderBy('job_id').execute();
  const preview = await reconcileNameConsensus(db);
  assert.equal(preview.changes.some(change => change.productId === productId), false, 'review/pending work must prevent repair');
  const applied = await reconcileNameConsensus(db, { apply: true, beforeApply: async () => {} });
  assert.equal(applied.changes.some(change => change.productId === productId), false);
  assert.deepEqual(await db.selectFrom('products').selectAll().where('id', '=', productId).executeTakeFirstOrThrow(), productBefore);
  assert.deepEqual(await db.selectFrom('standard_product_members').selectAll().where('product_id', '=', productId).execute(), membershipBefore);
  assert.deepEqual(await db.selectFrom('ai_standardization_results').selectAll().where('product_id', '=', productId).orderBy('job_id').execute(), resultsBefore);
}

async function assertRepairable(productId: bigint, method = 'same_name_majority') {
  const preview = await reconcileNameConsensus(db);
  const change = preview.changes.find(change => change.productId === productId);
  assert.equal(change?.toStandardProductId, majorityId);
  assert.equal(change?.method, method);
  await reconcileNameConsensus(db, { apply: true, beforeApply: async () => {} });
  const membership = await db.selectFrom('standard_product_members').select('standard_product_id')
    .where('product_id', '=', productId).executeTakeFirstOrThrow();
  assert.equal(membership.standard_product_id, majorityId);
}

for (const assigned of [true, false]) {
  const label = assigned ? 'assigned' : 'unassigned';
  for (const reasonCode of ['invalid_response', 'provider_error']) {
    test(`${label}: current review-pipeline generation ${reasonCode} prevents unchecked repair without a stage or vote`, async () => {
      const productId = await fixture(assigned);
      const jobId = await result(productId, undefined, { status: 'failed' });
      await db.updateTable('ai_jobs').set({ pipeline_versions: jsonb(pipelineVersionSnapshot('mock')) }).where('id', '=', jobId).execute();
      await db.updateTable('ai_standardization_results').set({ reason_code: reasonCode })
        .where('job_id', '=', jobId).execute();
      await assertProtected(productId);
    });
  }

  for (const [state, options] of [
    ['old evidence', { contentVersion: 0n }],
    ['old revision', { revision: 1n }],
  ] as const) {
    test(`${label}: review-pipeline marker does not protect generation errors with ${state}`, async () => {
      const productId = await fixture(assigned);
      const jobId = await result(productId, undefined, options);
      await db.updateTable('ai_jobs').set({ pipeline_versions: jsonb(pipelineVersionSnapshot('mock')) }).where('id', '=', jobId).execute();
      await assertRepairable(productId);
    });
  }

  for (const marker of ['', null]) {
    test(`${label}: empty review-pipeline marker ${String(marker)} keeps legacy repair`, async () => {
      const productId = await fixture(assigned);
      const jobId = await result(productId, undefined);
      await db.updateTable('ai_jobs').set({ pipeline_versions: jsonb({ standardizationReviewPrompt: marker }) })
        .where('id', '=', jobId).execute();
      await assertRepairable(productId);
    });
  }

  test(`${label}: tag jobs with a review-pipeline marker do not protect legacy standardization results`, async () => {
    const productId = await fixture(assigned);
    const jobId = await result(productId, undefined);
    await db.updateTable('ai_jobs').set({ job_type: 'tag_extraction', pipeline_versions: jsonb(pipelineVersionSnapshot('mock')) })
      .where('id', '=', jobId).execute();
    await assertRepairable(productId);
  });

  for (const [failure, errorSource] of [
    ['timeout', 'request_outcome_unknown'],
    ['invalid_response', 'invalid_response'],
    ['input_too_large', 'input_too_large'],
    ['result_not_saved', 'result_not_saved'],
  ]) {
    test(`${label}: current failed review (${failure}) prevents consensus repair without a binary vote`, async () => {
      const productId = await fixture(assigned);
      await result(productId, undefined);
      await failedReview(productId, errorSource);
      await result(productId, undefined, { revision: 1n });
      await assertProtected(productId);
    });
  }

  for (const [state, options] of [
    ['old evidence', { contentVersion: 0n }],
    ['old revision', { revision: 1n }],
  ] as const) {
    test(`${label}: ${state} leaves a historical failed review unprotected`, async () => {
      const productId = await fixture(assigned);
      const jobId = await failedReview(productId, 'invalid_response', options);
      if (assigned) await db.updateTable('standard_product_members').set({ decision_version: jobId })
        .where('product_id', '=', productId).execute();
      await assertRepairable(productId);
    });
  }

  test(`${label}: a newer current legacy result supersedes a failed review`, async () => {
    const productId = await fixture(assigned);
    await failedReview(productId, 'result_not_saved');
    await result(productId, undefined);
    await assertRepairable(productId);
  });

  test(`${label}: a generation-stage technical failure keeps legacy repair`, async () => {
    const productId = await fixture(assigned);
    await failedReview(productId, 'invalid_response', { stage: 'generate' });
    await assertRepairable(productId);
  });

  for (const approved of [true, false]) {
    test(`${label}: current binary review approved=${approved} prevents consensus repair`, async () => {
      const productId = await fixture(assigned);
      const jobId = await result(productId, approved);
      if (assigned && approved) await db.updateTable('standard_product_members').set({ decision_version: jobId })
        .where('product_id', '=', productId).execute();
      await assertProtected(productId);
    });
  }

  for (const [labelSuffix, options] of [
    ['old evidence', { contentVersion: 0n }],
    ['old revision', { revision: 1n }],
    ['mismatched result version', { resultVersion: 0n }],
    ['mismatched input version', { contentVersion: 0n, resultVersion: 1n }],
    ['mismatched fingerprint', { fingerprint: 'old-fingerprint' }],
  ] as const) {
    test(`${label}: ${labelSuffix} does not protect a historical binary review`, async () => {
      const productId = await fixture(assigned);
      const jobId = await result(productId, true, options);
      if (assigned) await db.updateTable('standard_product_members').set({ decision_version: jobId })
        .where('product_id', '=', productId).execute();
      await assertRepairable(productId);
    });
  }

  test(`${label}: newest applicable review survives newer historical results`, async () => {
    const productId = await fixture(assigned);
    await result(productId, undefined);
    await result(productId, false);
    await result(productId, undefined, { revision: 1n });
    await assertProtected(productId);
  });

  test(`${label}: a newer current legacy result supersedes an older review without a usable membership source`, async () => {
    const productId = await fixture(assigned);
    await result(productId, true);
    const legacyJobId = await result(productId, undefined);
    if (assigned) await db.updateTable('standard_product_members').set({ decision_version: legacyJobId })
      .where('product_id', '=', productId).execute();
    await assertRepairable(productId);
  });

  test(`${label}: review without an input snapshot does not protect legacy repair`, async () => {
    const productId = await fixture(assigned);
    const jobId = await result(productId, true);
    await db.deleteFrom('ai_job_input_members').where('job_id', '=', jobId).execute();
    await assertRepairable(productId);
  });

  for (const approved of [undefined, 'false', null]) {
    test(`${label}: non-binary review ${String(approved)} keeps legacy repair`, async () => {
      const productId = await fixture(assigned);
      await result(productId, approved);
      await assertRepairable(productId);
    });
  }

  for (const [stage, options] of [
    ['queued generation', { status: 'queued', memberStatus: 'queued' }],
    ['running generation', { status: 'running', memberStatus: 'processing' }],
    ['paused generation', { status: 'paused', memberStatus: 'queued' }],
    ['pending review with a terminal member', { status: 'ready', pendingReview: true }],
  ] as const) {
    test(`${label}: ${stage} prevents consensus repair`, async () => {
      const productId = await fixture(assigned);
      await work(productId, options);
      await assertProtected(productId);
    });
  }

  for (const [state, options] of [
    ['stale evidence', { status: 'running', memberStatus: 'queued', contentVersion: 0n }],
    ['stale revision', { status: 'running', memberStatus: 'queued', revision: 1n }],
    ['finished', { status: 'succeeded', memberStatus: 'queued' }],
    ['cancelled', { status: 'cancelled', memberStatus: 'queued' }],
    ['cancel requested', { status: 'running', memberStatus: 'queued', cancelRequested: true }],
  ] as const) {
    test(`${label}: ${state} work does not block legacy repair`, async () => {
      const productId = await fixture(assigned);
      await work(productId, options);
      await assertRepairable(productId);
    });
  }
}

test('assigned: current reviewed membership source takes precedence over a later unrelated legacy result', async () => {
  const productId = await fixture(true);
  const jobId = await result(productId, true);
  await db.updateTable('standard_product_members').set({ decision_version: jobId }).where('product_id', '=', productId).execute();
  await result(productId, undefined);
  await assertProtected(productId);
});

test('unassigned: binary rejection and pending review also prevent identity-rule autoassignment', async () => {
  const rejected = await fixture(false, false);
  await result(rejected, false);
  await assertProtected(rejected);
  const pending = await fixture(false, false);
  await work(pending, { status: 'running', pendingReview: true });
  await assertProtected(pending);
  const legacy = await fixture(false, false);
  await assertRepairable(legacy, 'identity_rule');
});

test('unassigned: failed review prevents identity-rule autoassignment without a binary vote', async () => {
  const productId = await fixture(false, false);
  await failedReview(productId, 'input_too_large');
  await assertProtected(productId);
});

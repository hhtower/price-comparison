import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Kysely, PostgresDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';
import type { ParsedStandardizationResponse, StandardizationDecision } from '../src/ai/ai.schemas.js';
import { AiRepository } from '../src/ai/ai.repository.js';
import { pipelineVersionSnapshot } from '../src/ai/pipeline-versions.js';
import { finalizeOrScheduleMissing } from '../src/ai/standardization-finalizer.js';
import { STANDARDIZATION_PROMPT_VERSION } from '../src/ai/standardization-request.js';
import { jsonb, type AiJobType, type DatabaseSchema, type JsonValue } from '../src/database/types.js';
import { productContentFingerprint } from '../src/standardization/fingerprint.js';
import { IDENTITY_POLICY_VERSION } from '../src/standardization/identity-policy.js';

let db: Kysely<DatabaseSchema>, admin: Pool, schema: string;
before(async () => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url?.trim(), 'TEST_DATABASE_URL required');
  schema = `review_failure_${randomUUID().replaceAll('-', '')}`;
  admin = new Pool({ connectionString: url });
  await admin.query(`create schema "${schema}"`);
  db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({
    connectionString: url, options: `-c search_path=${schema},public`, max: 4,
  }) }) });
  const migrated = await new Migrator({ db, provider: migrationProvider, migrationTableSchema: schema }).migrateToLatest();
  if (migrated.error) throw migrated.error;
});
after(async () => {
  await db?.destroy();
  if (schema) await admin.query(`drop schema "${schema}" cascade`);
  await admin?.end();
});

async function fixture(errorSource = 'input_too_large', jobType: AiJobType = 'manual_full', stage = 'review') {
  const shop = await db.insertInto('shops').values({
    platform: 'test', name: 'Frozen review failures', url: `https://${randomUUID()}.invalid`, enabled: true,
  }).returning('id').executeTakeFirstOrThrow();
  const products = await db.insertInto('products').values(Array.from({ length: 7 }, (_, index) => ({
    shop_id: shop.id, external_id: String(index), name: `Frozen input ${index}`, spec: '',
    source_data: jsonb({}), normalized_key: randomUUID(), url: '', content_version: 1n,
  }))).returning('id').execute();
  const ids = products.slice(0, 6).map(product => product.id);
  const job = await db.insertInto('ai_jobs').values({
    model: 'mock', job_type: jobType, status: 'running', total: 7n,
  }).returning('id').executeTakeFirstOrThrow();
  await db.insertInto('ai_job_inputs').values(ids.map(inputId => ({
    job_id: job.id, input_id: inputId, fingerprint: `frozen-${inputId}`, payload: jsonb({ name: 'Frozen evidence' }),
    content_version: 1n, input_bytes: 100n, estimated_tokens: 25n, status: 'succeeded' as const,
  }))).execute();
  await db.insertInto('ai_job_input_members').values(products.map((product, index) => ({
    job_id: job.id, input_id: index === 6 ? ids[5]! : product.id, product_id: product.id,
    fingerprint: `frozen-${index === 6 ? ids[5] : product.id}`, payload: jsonb({ name: 'Frozen evidence' }), content_version: 1n,
    status: 'processing' as const,
  }))).execute();
  const local: StandardizationDecision[] = ['invalid_response', 'evidence_invalid'].map((code, index) => ({
    id: String(ids[index + 3]), status: 'unclassified', reasonCode: code as 'invalid_response' | 'evidence_invalid',
    reason: `Original local ${code}`, ruleIds: ['frozen-rule'], evidence: [],
    diagnostic: { stage: index === 0 ? 'schema' : 'evidence', code: `original_${code}`, itemId: String(ids[index + 3]), fieldPath: 'evidence[0].quote' },
  }));
  const document: ParsedStandardizationResponse = {
    items: [
      { id: String(ids[0]), status: 'classified', identity: { kind: 'existing', standardProductId: '91' },
        reasonCode: null, reason: 'Original proposal', ruleIds: [], evidence: [{ path: 'name', quote: 'Frozen evidence' }] },
      ...(['insufficient_evidence', 'not_sellable'] as const).map((reasonCode, index) => ({
        id: String(ids[index + 1]), status: 'unclassified' as const, reasonCode,
        reason: `Business ${reasonCode}`, ruleIds: [], evidence: [],
      })),
      ...local,
    ],
    identities: [], missingIds: [String(ids[5])],
  };
  const generation = await db.insertInto('ai_job_batches').values({
    job_id: job.id, batch_index: 0n, product_ids: jsonb(ids.map(String)), product_count: 7n,
    status: 'succeeded', step: 'done', validated_decision: jsonb(document as unknown as JsonValue),
    request_budget_used: 1, confirmed_requests: 1,
    reference_snapshot: jsonb({ standardizationStage: 'generate' }),
  }).returningAll().executeTakeFirstOrThrow();
  const review = await db.insertInto('ai_job_batches').values({
    job_id: job.id, batch_index: 1n, round: 1, product_ids: jsonb(ids.map(String)), product_count: 7n,
    status: 'failed', step: 'request', error_source: errorSource, error: `Review ${errorSource}`,
    request_budget_used: errorSource === 'input_too_large' ? 0 : 1,
    confirmed_requests: errorSource === 'input_too_large' ? 0 : 1,
    reference_snapshot: jsonb({ standardizationStage: stage, generationBatchId: String(generation.id) }),
  }).returningAll().executeTakeFirstOrThrow();
  return { jobId: job.id, ids, products, generation, review, document, local };
}

async function finalize(jobId: bigint) {
  await db.transaction().execute(tx => finalizeOrScheduleMissing(tx, jobId));
}

for (const errorSource of ['input_too_large', 'invalid_response', 'provider_error']) {
  test(`${errorSource}: failed review retains missing IDs and schedules only the original single retry`, async () => {
    const f = await fixture(errorSource);
    await finalize(f.jobId);
    const results = await db.selectFrom('ai_standardization_results').selectAll()
      .where('job_id', '=', f.jobId).orderBy('product_id').execute();
    assert.deepEqual(results.slice(0, 3).map(row => [row.status, row.reason_code, row.batch_id]),
      Array.from({ length: 3 }, () => ['unclassified', errorSource, f.review.id]));
    for (const row of results) assert.equal((row.decision as Record<string, JsonValue>).review, undefined);
    assert.deepEqual(results.slice(5).map(row => [row.input_id, row.status, row.reason_code, row.batch_id]),
      [[f.ids[5], 'unclassified', 'missing_id', f.review.id], [f.ids[5], 'unclassified', 'missing_id', f.review.id]]);
    const retry = await db.selectFrom('ai_job_batches').selectAll()
      .where('job_id', '=', f.jobId).where('id', 'not in', [f.generation.id, f.review.id]).execute();
    assert.equal(retry.length, 1);
    assert.deepEqual([retry[0]!.product_ids, retry[0]!.product_count, retry[0]!.round, retry[0]!.request_budget_limit, retry[0]!.request_budget_used],
      [[String(f.ids[5])], 2n, 1, 1, 0]);
    const members = await db.selectFrom('ai_job_input_members').select(['status', 'reason_code', 'missing_reprocess_count'])
      .where('job_id', '=', f.jobId).where('input_id', '=', f.ids[5]!).execute();
    assert.deepEqual(members, Array.from({ length: 2 }, () => ({ status: 'queued', reason_code: null, missing_reprocess_count: 1 })));
    await finalize(f.jobId);
    assert.equal((await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', f.jobId).execute()).length, 3);
    assert.deepEqual(await db.selectFrom('ai_job_input_members').select(['status', 'reason_code', 'missing_reprocess_count'])
      .where('job_id', '=', f.jobId).where('input_id', '=', f.ids[5]!).execute(), members);
    assert.deepEqual(await db.selectFrom('ai_job_inputs').select(['status', 'round', 'missing_reprocess_count'])
      .where('job_id', '=', f.jobId).where('input_id', '=', f.ids[5]!).executeTakeFirstOrThrow(),
    { status: 'queued', round: 1, missing_reprocess_count: 1 });
    await db.updateTable('ai_job_batches').set({ status: 'succeeded', step: 'done' }).where('id', '=', retry[0]!.id).execute();
    await db.updateTable('ai_job_input_members').set({ status: 'unclassified', reason_code: 'missing_id' })
      .where('job_id', '=', f.jobId).where('input_id', '=', f.ids[5]!).execute();
    await db.updateTable('ai_job_inputs').set({ status: 'succeeded', reason_code: 'missing_id' })
      .where('job_id', '=', f.jobId).where('input_id', '=', f.ids[5]!).execute();
    await finalize(f.jobId);
    const batches = await db.selectFrom('ai_job_batches').selectAll().where('job_id', '=', f.jobId).orderBy('batch_index').execute();
    assert.equal(batches.length, 3, 'a repeated omission must not create another generation or review request');
    assert.deepEqual(batches[0], f.generation);
    assert.deepEqual(batches[1], f.review);
    assert.equal((await db.selectFrom('ai_jobs').select('status').where('id', '=', f.jobId).executeTakeFirstOrThrow()).status, 'ready_with_errors');
  });

  test(`${errorSource}: failed review preserves frozen local errors and diagnostics`, async () => {
    const f = await fixture(errorSource);
    await db.updateTable('products').set({ name: 'Changed live evidence', source_data: jsonb({ changed: true }) })
      .where('shop_id', '=', (await db.selectFrom('products').select('shop_id').where('id', '=', f.ids[0]!).executeTakeFirstOrThrow()).shop_id).execute();
    await finalize(f.jobId);
    for (const original of f.local) {
      const row = await db.selectFrom('ai_standardization_results').selectAll()
        .where('job_id', '=', f.jobId).where('product_id', '=', BigInt(original.id)).executeTakeFirstOrThrow();
      assert.deepEqual([row.status, row.reason_code, row.reason, row.decision, row.batch_id, row.content_version],
        ['unclassified', original.reasonCode, original.reason, original, f.review.id, 1n]);
      const input = await db.selectFrom('ai_job_inputs').select(['reason_code', 'error', 'missing_reprocess_count'])
        .where('job_id', '=', f.jobId).where('input_id', '=', BigInt(original.id)).executeTakeFirstOrThrow();
      assert.deepEqual(input, { reason_code: original.reasonCode, error: original.reason, missing_reprocess_count: 0 });
      const member = await db.selectFrom('ai_job_input_members').select(['status', 'reason_code', 'missing_reprocess_count'])
        .where('job_id', '=', f.jobId).where('product_id', '=', BigInt(original.id)).executeTakeFirstOrThrow();
      assert.deepEqual(member, { status: 'unclassified', reason_code: original.reasonCode, missing_reprocess_count: 0 });
    }
  });
}

test('repeated finalization leaves a missing retry pending through real mock-result publication', async () => {
  const f = await fixture();
  const missingId = f.ids[5]!;
  const productIds = f.products.slice(5).map(product => product.id);
  const fingerprint = productContentFingerprint({ name: 'ChatGPT Plus', spec: '', sourceCategory: '', sourceData: {} });
  await db.updateTable('products').set({ name: 'ChatGPT Plus', content_fingerprint: fingerprint }).where('id', 'in', productIds).execute();
  await db.updateTable('ai_job_inputs').set({ fingerprint }).where('job_id', '=', f.jobId).where('input_id', '=', missingId).execute();
  await db.updateTable('ai_job_input_members').set({ fingerprint }).where('job_id', '=', f.jobId).where('input_id', '=', missingId).execute();
  await db.updateTable('ai_jobs').set({ prompt_version: STANDARDIZATION_PROMPT_VERSION, rule_version: IDENTITY_POLICY_VERSION,
    pipeline_versions: jsonb(pipelineVersionSnapshot('mock')) }).where('id', '=', f.jobId).execute();
  await finalize(f.jobId);
  const retry = await db.selectFrom('ai_job_batches').selectAll().where('job_id', '=', f.jobId)
    .where('id', 'not in', [f.generation.id, f.review.id]).executeTakeFirstOrThrow();
  for (const status of ['queued', 'processing'] as const) {
    await db.updateTable('ai_job_input_members').set({ status }).where('job_id', '=', f.jobId).where('input_id', '=', missingId).execute();
    await db.updateTable('ai_job_inputs').set({ status: status === 'queued' ? 'queued' : 'running' })
      .where('job_id', '=', f.jobId).where('input_id', '=', missingId).execute();
    await db.updateTable('ai_job_batches').set({ status: status === 'queued' ? 'queued' : 'running' }).where('id', '=', retry.id).execute();
    await finalize(f.jobId);
    assert.deepEqual(await db.selectFrom('ai_job_input_members').select(['status', 'missing_reprocess_count'])
      .where('job_id', '=', f.jobId).where('input_id', '=', missingId).execute(),
    productIds.map(() => ({ status, missing_reprocess_count: 1 })));
    assert.equal((await db.selectFrom('ai_job_inputs').select('status').where('job_id', '=', f.jobId)
      .where('input_id', '=', missingId).executeTakeFirstOrThrow()).status, status === 'queued' ? 'queued' : 'running');
  }
  const standard = await db.insertInto('standard_products').values({
    name: 'ChatGPT Plus', canonical_family: 'openai', canonical_product: 'chatgpt', canonical_tier: 'plus', verification_state: 'verified',
  }).returning('id').executeTakeFirstOrThrow();
  await db.updateTable('ai_job_batches').set({
    step: 'publish', status: 'running', lease_until: new Date(Date.now() + 60_000),
    validated_decision: jsonb({ items: [{
      id: String(missingId), status: 'classified', identity: { kind: 'existing', standardProductId: String(standard.id) },
      reasonCode: null, reason: 'Mock retry approved', ruleIds: [], evidence: [], review: { approved: true },
    }], identities: [], missingIds: [] }),
    reference_snapshot: jsonb({ standardizationStage: 'review',
      inputs: [{ id: String(missingId), candidateStandardProductIds: [String(standard.id)] }],
      candidates: [{ id: String(standard.id), family: 'openai', product: 'chatgpt', tier: 'plus', aliases: [] }] }),
  }).where('id', '=', retry.id).execute();
  await db.insertInto('ai_publication_units').values({
    batch_id: retry.id, unit_index: 0, product_ids: jsonb(productIds.map(String)), member_count: 2,
  }).execute();
  await new AiRepository(db).publishBatch(retry.id);
  assert.deepEqual(await db.selectFrom('ai_job_input_members').select(['status', 'missing_reprocess_count'])
    .where('job_id', '=', f.jobId).where('input_id', '=', missingId).execute(),
  productIds.map(() => ({ status: 'classified', missing_reprocess_count: 1 })));
  assert.deepEqual(await db.selectFrom('ai_standardization_results').select(['status', 'standard_product_id', 'batch_id'])
    .where('job_id', '=', f.jobId).where('input_id', '=', missingId).execute(),
  productIds.map(() => ({ status: 'classified', standard_product_id: standard.id, batch_id: retry.id })));
  const batches = await db.selectFrom('ai_job_batches').selectAll().where('job_id', '=', f.jobId).orderBy('batch_index').execute();
  assert.equal(batches.length, 3);
  assert.deepEqual(batches[0], f.generation);
  assert.deepEqual(batches[1], f.review);
  assert.equal(batches[2]!.request_budget_limit, 1);
  assert.equal(batches[2]!.request_budget_used, 0);
});

test('historical generation failures retain their original terminal behavior', async () => {
  const f = await fixture('provider_error', 'manual_full', 'generate');
  await finalize(f.jobId);
  const results = await db.selectFrom('ai_standardization_results').select('reason_code').where('job_id', '=', f.jobId).execute();
  assert.deepEqual(results.map(row => row.reason_code), Array(7).fill('provider_error'));
  assert.equal((await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', f.jobId).execute()).length, 2);
});

test('tag extraction failures keep tag outcomes and do not consume the generation missing-ID retry', async () => {
  const f = await fixture('provider_error', 'tag_extraction');
  await finalize(f.jobId);
  const members = await db.selectFrom('ai_job_input_members').select(['status', 'reason_code'])
    .where('job_id', '=', f.jobId).execute();
  assert.deepEqual(members, Array.from({ length: 7 }, () => ({ status: 'failed', reason_code: 'provider_error' })));
  assert.equal((await db.selectFrom('ai_standardization_results').select('product_id').where('job_id', '=', f.jobId).execute()).length, 0);
  assert.equal((await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', f.jobId).execute()).length, 2);
});

for (const checkpoint of ['different job', 'unfinished', 'no decision']) {
  test(`review failure refuses a generation checkpoint with ${checkpoint}`, async () => {
    const f = await fixture();
    if (checkpoint === 'different job') {
      const other = await db.insertInto('ai_jobs').values({ model: 'mock', status: 'running', total: 0n })
        .returning('id').executeTakeFirstOrThrow();
      await db.updateTable('ai_job_batches').set({ job_id: other.id }).where('id', '=', f.generation.id).execute();
    } else {
      await db.updateTable('ai_job_batches').set(checkpoint === 'unfinished'
        ? { status: 'running', step: 'request' } : { validated_decision: null }).where('id', '=', f.generation.id).execute();
    }
    await assert.rejects(finalize(f.jobId));
    assert.equal((await db.selectFrom('ai_standardization_results').select('product_id').where('job_id', '=', f.jobId).execute()).length, 0);
  });
}

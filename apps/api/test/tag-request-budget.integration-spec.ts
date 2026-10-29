import assert from 'node:assert/strict';
import { after, before, beforeEach, test, type TestContext } from 'node:test';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { migrateToLatest } from '../scripts/migrate.js';
import { AiRepository } from '../src/ai/ai.repository.js';
import { createAiWorker, createOpenAiModelCall } from '../src/ai/ai.worker.js';
import { createTagJob } from '../src/ai/tag-extraction-jobs.js';
import { buildTagReviewRequest } from '../src/ai/tag-review-request.js';
import { assertStandardizationRequestFits, estimateStandardizationRequest, readStandardizationRequestLimits } from '../src/ai/standardization-request.js';
import { jsonb, type DatabaseSchema } from '../src/database/types.js';
import { JobsRepository } from '../src/jobs/jobs.repository.js';
import { productContentFingerprint } from '../src/standardization/fingerprint.js';

let db: Kysely<DatabaseSchema>, admin: Pool, schema: string;
const requestLimits = {
  AI_REQUEST_MAX_BYTES: '131072',
  AI_REQUEST_MAX_CONTEXT_TOKENS: '65536',
  AI_REQUEST_OUTPUT_RESERVE_TOKENS: '32768',
};

function configureLimits(t: TestContext, overrides: Record<string, string> = {}) {
  for (const [key, value] of Object.entries({ ...requestLimits, ...overrides })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}

before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL required');
  schema = `tag_budget_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: new Pool({
    connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path="${schema}",public`,
  }) }) });
  process.env.PG_SCHEMA = schema;
  await migrateToLatest(db);
});
beforeEach(async () => {
  await db.updateTable('ai_jobs').set({ status: 'cancelled' }).execute();
});
after(async () => {
  await db?.destroy();
  if (schema) await admin.query(`drop schema "${schema}" cascade`);
  await admin?.end();
  delete process.env.PG_SCHEMA;
});

async function fixture(count = 1, fanout = false) {
  const shop = await db.insertInto('shops').values({
    platform: 'test', name: 'budget', url: `https://budget.invalid/${Math.random()}`, enabled: true,
  }).returning('id').executeTakeFirstOrThrow();
  const source = { name: 'ChatGPT Plus account', spec: '1 month', sourceCategory: 'Subscriptions', sourceData: { evidence: 'Original frozen evidence' } };
  const products = [];
  for (let index = 0; index < count; index++) {
    const name = source.name + (index && !(fanout && index === count - 1) ? ` variant ${index}` : '');
    products.push(await db.insertInto('products').values({
      shop_id: shop.id, external_id: `budget-${index}`, name, spec: source.spec, source_category: source.sourceCategory,
      source_data: jsonb(source.sourceData), normalized_key: 'budget', url: 'https://budget.invalid/product',
      content_version: 1n, content_fingerprint: productContentFingerprint({ ...source, name }),
    }).returning('id').executeTakeFirstOrThrow());
  }
  const standard = await db.insertInto('standard_products').values({
    canonical_family: 'openai', canonical_product: 'chatgpt', canonical_tier: 'plus', name: 'budget', verification_state: 'verified',
  }).returning('id').executeTakeFirstOrThrow();
  for (const product of products) await db.insertInto('standard_product_members').values({
    product_id: product.id, standard_product_id: standard.id, assignment_source: 'ai', publication_state: 'published',
  }).execute();
  const job = await db.transaction().execute(tx => createTagJob(tx, { productIds: products.map(product => product.id), model: 'glm-5.3' }));
  const batch = await db.selectFrom('ai_job_batches').selectAll().where('job_id', '=', job.id).executeTakeFirstOrThrow();
  return { repository: new AiRepository(db), product: products[0]!, products, job, batch };
}

async function reviewFixture(count = 1, fanout = false) {
  const f = await fixture(count, fanout);
  await db.deleteFrom('ai_job_batches').where('job_id', '=', f.job.id).where('id', '!=', f.batch.id).execute();
  const rows = await db.selectFrom('ai_job_input_members').select(['input_id', 'payload']).where('job_id', '=', f.job.id).orderBy('input_id').execute();
  const members = [...new Map(rows.map(member => [String(member.input_id), member])).values()];
  const reference = {
    strategyVersion: 'evidence-canonical-candidate-v2', catalogVersion: '0', candidates: [],
    inputs: members.map(member => ({ id: String(member.input_id), candidateStandardProductIds: [], stats: { scanned: 0, compared: 0, truncated: false } })),
  };
  await db.updateTable('ai_job_batches').set({
    status: 'succeeded', step: 'done', request_budget_used: 1, confirmed_requests: 1,
    reference_snapshot: jsonb(reference), product_ids: jsonb(members.map(member => String(member.input_id))), product_count: BigInt(count),
    validated_decision: jsonb({ items: members.map(member => ({ productId: String(member.input_id), tags: [{
      name: 'duration', value: '1 month', evidence: [{ path: 'spec', quote: '1 month' }],
    }], rejectedTags: [] })) }),
  }).where('id', '=', f.batch.id).execute();
  for (const member of members) await db.updateTable('ai_job_input_members').set({
    payload: jsonb({ ...(member.payload as Record<string, string>), frozenOrigin: 'original-catalog', evidence: 'Additional frozen evidence' }),
  }).where('job_id', '=', f.job.id).where('input_id', '=', member.input_id).execute();
  const batch = await db.insertInto('ai_job_batches').values({
    job_id: f.job.id, batch_index: 1n, round: 1, status: 'queued', step: 'request',
    product_ids: jsonb(members.map(member => String(member.input_id))), product_count: BigInt(count),
    reference_snapshot: jsonb({ ...reference, tagStage: 'review', extractionBatchId: String(f.batch.id) }),
  }).returningAll().executeTakeFirstOrThrow();
  return { ...f, batch };
}

async function runWorker(repository: AiRepository, limits: Record<string, string>) {
  let sends = 0;
  const modelCall = createOpenAiModelCall(repository, {
    ...requestLimits, ...limits, AI_BASE_URL: 'https://mock.invalid/v1', AI_API_KEY: 'mock', AI_MODEL: 'mock',
  }, async () => { sends++; throw new Error('oversized requests must never reach transport'); });
  const settled = Promise.withResolvers<void>();
  const service = Object.assign(new JobsRepository(db), { onSettled: () => settled.resolve() });
  const worker = createAiWorker(service, { repository, modelCall, concurrency: 1 });
  try {
    assert.equal(await worker.runOnce(), 1);
    await settled.promise;
  } finally {
    await worker.stop();
  }
  return sends;
}

for (const [limit, overrides] of [
  ['bytes', { AI_REQUEST_MAX_BYTES: '1' }],
  ['context including output reserve', { AI_REQUEST_MAX_CONTEXT_TOKENS: '32769' }],
] as const) {
  test(`tag preparation rejects excessive complete request ${limit} without reserving a send`, async t => {
    configureLimits(t, overrides);
    const f = await fixture();
    await assert.rejects(f.repository.prepareBatch(f.batch.id), {
      retryClass: 'input_too_large', retryable: false, requestOutcome: 'local_failure',
    });
    const batch = await db.selectFrom('ai_job_batches').selectAll().where('id', '=', f.batch.id).executeTakeFirstOrThrow();
    assert.equal(batch.request_budget_used, 0);
    assert.equal(batch.reference_snapshot, null);
    assert.equal(await runWorker(f.repository, overrides), 0);
    const failed = await db.selectFrom('ai_job_batches').selectAll().where('id', '=', f.batch.id).executeTakeFirstOrThrow();
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error_source, 'input_too_large');
    assert.equal(failed.attempts, 1n);
    assert.equal(failed.request_budget_used, 0);
  });

  test(`worker checks complete tag request ${limit} again before reservation for an already frozen batch`, async t => {
    configureLimits(t);
    const f = await fixture();
    await f.repository.prepareBatch(f.batch.id);
    const sends = await runWorker(f.repository, overrides);
    const batch = await db.selectFrom('ai_job_batches').selectAll().where('id', '=', f.batch.id).executeTakeFirstOrThrow();
    assert.equal(sends, 0);
    assert.equal(batch.request_budget_used, 0);
    assert.equal(batch.status, 'failed');
    assert.equal(batch.error_source, 'input_too_large');
    assert.equal(batch.attempts, 1n);
  });

  test(`review preparation checks complete request ${limit} despite its existing frozen reference`, async t => {
    configureLimits(t, overrides);
    const f = await reviewFixture();
    await assert.rejects(f.repository.prepareBatch(f.batch.id), {
      retryClass: 'input_too_large', retryable: false, requestOutcome: 'local_failure',
    });
    assert.equal(await runWorker(f.repository, overrides), 0);
    const batch = await db.selectFrom('ai_job_batches').selectAll().where('id', '=', f.batch.id).executeTakeFirstOrThrow();
    assert.equal(batch.status, 'failed');
    assert.equal(batch.error_source, 'input_too_large');
    assert.equal(batch.attempts, 1n);
    assert.equal(batch.request_budget_used, 0);
    assert.deepEqual(batch.reference_snapshot, f.batch.reference_snapshot);
  });
}

for (const stage of ['extract', 'review'] as const) test(`saved ${stage} request estimate describes the sent full frozen payload and model options`, async t => {
  configureLimits(t);
  const f = await (stage === 'review' ? reviewFixture() : fixture());
  await f.repository.prepareBatch(f.batch.id);
  const prepared = await db.selectFrom('ai_job_batches').selectAll().where('id', '=', f.batch.id).executeTakeFirstOrThrow();
  assert.ok(prepared.request_estimate, 'complete tag request must retain its size estimate');
  await db.updateTable('products').set({
    name: 'Changed live name', source_data: jsonb({ evidence: 'Changed live evidence' }),
  }).where('id', '=', f.product.id).execute();
  let body: Record<string, any> | undefined;
  const modelCall = createOpenAiModelCall(f.repository, {
    ...requestLimits, AI_BASE_URL: 'https://mock.invalid/v1', AI_API_KEY: 'mock', AI_MODEL: 'gpt-6.1-sol',
  }, async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(`data: ${JSON.stringify({
      id: 'budget-response', model: 'glm-5.3',
      choices: [{ delta: { content: JSON.stringify({ items: [{ id: String(f.product.id),
        ...(stage === 'review' ? { decisions: [true], textReview: null } : { tags: [] }),
      }] }) }, finish_reason: 'stop' }],
    })}\n\ndata: [DONE]\n\n`);
  });
  const execute = await modelCall.prepare!({ id: f.batch.id, row: { job_type: 'tag_extraction' } }, new AbortController().signal);
  const result = await execute();
  assert.deepEqual(result.tagExtractionItems, [{ productId: f.product.id,
    tags: stage === 'review' ? [{ proposalIndex: 0, name: 'duration', value: '1 month', evidence: [{ path: 'spec', quote: '1 month' }] }] : [],
    rejectedTags: [], ...(stage === 'review' ? { reviewed: true, reviewDecisions: [true], textReview: null } : {}),
  }]);
  assert.ok(body);
  const estimate = prepared.request_estimate as Record<string, number>;
  assert.equal(estimate.requestBytes, Buffer.byteLength(JSON.stringify(body)));
  assert.equal(estimate.outputReserveTokens, 32768);
  assert.equal(estimate.estimatedTotalTokens, estimate.estimatedInputTokens! + 32768);
  assert.equal(body.model, 'glm-5.3');
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 32768);
  assert.equal(body.reasoning_effort, 'low');
  const expectedInput = {
    id: String(f.product.id), name: 'ChatGPT Plus account', spec: '1 month',
    category: 'Subscriptions', sourceData: { evidence: 'Original frozen evidence' },
  };
  const sentPayload = JSON.parse(body.messages[1].content);
  if (stage === 'review') {
    const frozen = await db.selectFrom('ai_job_input_members').select('payload')
      .where('job_id', '=', f.job.id).where('product_id', '=', f.product.id).executeTakeFirstOrThrow();
    assert.deepEqual(sentPayload.inputs, [{
      ...expectedInput, frozenOrigin: 'original-catalog', evidence: 'Additional frozen evidence',
      shopSource: (frozen.payload as Record<string, unknown>).shopSource,
    }]);
    assert.deepEqual(sentPayload.proposals, { items: [{ id: String(f.product.id), tags: [
      { name: 'duration', value: '1 month', path: 'spec', quote: '1 month' },
    ] }] });
    assert.deepEqual(prepared.reference_snapshot, f.batch.reference_snapshot);
  } else assert.deepEqual(sentPayload, [expectedInput]);
  await f.repository.prepareBatch(f.batch.id);
  assert.deepEqual((await db.selectFrom('ai_job_batches').select('request_estimate').where('id', '=', f.batch.id).executeTakeFirstOrThrow()).request_estimate, prepared.request_estimate);
});

test('fourteen-question output capacity splits frozen review batches before reserving requests', async t => {
  configureLimits(t);
  const f = await reviewFixture(9);
  const members = await db.selectFrom('ai_job_input_members').select(['input_id', 'payload'])
    .where('job_id', '=', f.job.id).execute();
  for (const member of members) await db.updateTable('ai_job_input_members').set({ payload: jsonb({
    ...(member.payload as object), shopText: { unitId: String(member.input_id), name: 'Parent', description: '', hash: 'a'.repeat(64) },
  }) }).where('job_id', '=', f.job.id).where('input_id', '=', member.input_id).execute();
  const original = await f.repository.getTagExtractionBatchInputs(f.batch.id);
  const payloads = original.inputs.map(input => ({ ...(input.payload as object), id: String(input.productId),
    name: input.name, spec: input.spec, sourceData: input.sourceData }));
  const estimate = estimateStandardizationRequest(buildTagReviewRequest(payloads, original.proposals!, original.model), readStandardizationRequestLimits());
  assert.ok(estimate.requestBytes < Number(requestLimits.AI_REQUEST_MAX_BYTES));
  assert.ok(estimate.estimatedTotalTokens < Number(requestLimits.AI_REQUEST_MAX_CONTEXT_TOKENS));
  await f.repository.prepareBatch(f.batch.id);
  const batches = await db.selectFrom('ai_job_batches').selectAll().where('job_id', '=', f.job.id)
    .where('round', '=', 1).orderBy('batch_index').execute();
  assert.deepEqual(batches.map(batch => (batch.product_ids as string[]).length), [4, 4, 1]);
  assert.deepEqual(batches.flatMap(batch => batch.product_ids as string[]), payloads.map(input => input.id));
  for (const batch of batches) {
    assert.equal(batch.request_budget_used, 0);
    assert.equal(batch.confirmed_requests, 0);
    const stored = batch.request_estimate as Record<string, number | boolean>;
    assert.equal(stored.oversized, false);
    assert.ok((batch.product_ids as string[]).length <= 4);
    const frozen = await f.repository.getTagExtractionBatchInputs(batch.id);
    assert.ok(frozen.inputs.every(input => (input.payload as Record<string, unknown>).shopText));
    await f.repository.prepareBatch(batch.id);
  }
  assert.equal((await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', f.job.id).where('round', '=', 1).execute()).length, 3);
});

for (const dimension of ['bytes', 'context'] as const) test(`review preparation splits complete requests by ${dimension} before reservation, atomically and idempotently`, async t => {
  configureLimits(t);
  const f = await reviewFixture(3, true);
  const original = await f.repository.getTagExtractionBatchInputs(f.batch.id);
  const payloads = original.inputs.map(input => ({
    ...(input.payload as object), id: String(input.productId), name: input.name, spec: input.spec, sourceData: input.sourceData,
  }));
  assert.equal(payloads.length, 2);
  const limits = readStandardizationRequestLimits();
  const singletonSizes = payloads.map(input => estimateStandardizationRequest(buildTagReviewRequest(
    [input], { items: original.proposals!.items.filter(item => item.id === input.id) }, original.model,
  ), limits));
  process.env[dimension === 'bytes' ? 'AI_REQUEST_MAX_BYTES' : 'AI_REQUEST_MAX_CONTEXT_TOKENS'] = String(Math.max(...singletonSizes.map(size =>
    dimension === 'bytes' ? size.requestBytes : size.estimatedTotalTokens)));
  await db.updateTable('ai_job_batches').set({
    status: 'running', claimed_by: 'planning-worker', claim_token: 'planning-claim', attempts: 1n, lease_until: new Date(Date.now() + 60000),
  }).where('id', '=', f.batch.id).execute();
  await Promise.all([f.repository.prepareBatch(f.batch.id), f.repository.prepareBatch(f.batch.id)]);
  await f.repository.prepareBatch(f.batch.id);
  const batches = await db.selectFrom('ai_job_batches').selectAll().where('job_id', '=', f.job.id).where('round', '=', 1).orderBy('batch_index').execute();
  assert.equal(batches.length, 2);
  assert.equal(batches[0]!.id, f.batch.id);
  assert.equal(batches[0]!.claimed_by, 'planning-worker');
  assert.equal(batches[0]!.claim_token, 'planning-claim');
  assert.equal(batches[1]!.batch_index, f.batch.batch_index + 1n);
  assert.deepEqual(batches.map(batch => Number(batch.product_count)).sort(), [1, 2]);
  const restoredInputs = [], restoredProposals = [];
  let sends = 0;
  const modelCall = createOpenAiModelCall(f.repository, {
    ...process.env, AI_BASE_URL: 'https://mock.invalid/v1', AI_API_KEY: 'mock', AI_MODEL: 'different-model',
  }, async () => { sends++; throw new Error('planning must never send'); });
  for (const batch of batches) {
    const restored = await f.repository.getTagExtractionBatchInputs(batch.id);
    const requestInputs = restored.inputs.map(input => ({
      ...(input.payload as object), id: String(input.productId), name: input.name, spec: input.spec, sourceData: input.sourceData,
    }));
    const estimate = assertStandardizationRequestFits(buildTagReviewRequest(requestInputs, restored.proposals!, restored.model), readStandardizationRequestLimits());
    const { oversized = false, ...storedEstimate } = batch.request_estimate as Record<string, unknown>;
    assert.deepEqual(storedEstimate, estimate);
    assert.equal(oversized, false);
    assert.equal(batch.request_budget_used, 0);
    assert.equal(batch.round, 1);
    assert.equal(batch.request_budget_limit, 2);
    const reference = batch.reference_snapshot as { tagStage: string; extractionBatchId: string; inputs: Array<{ id: string }> };
    assert.equal(reference.tagStage, 'review');
    assert.equal(reference.extractionBatchId, (f.batch.reference_snapshot as Record<string, string>).extractionBatchId);
    assert.deepEqual(reference.inputs.map(input => input.id), batch.product_ids);
    restoredInputs.push(...requestInputs);
    restoredProposals.push(...restored.proposals!.items);
    await modelCall.prepare!({ id: batch.id, row: { job_type: 'tag_extraction' } }, new AbortController().signal);
  }
  assert.deepEqual(restoredInputs, payloads);
  assert.deepEqual(restoredProposals, original.proposals!.items);
  assert.equal(sends, 0);
});

test('an oversized review singleton cannot discard fitting siblings or split a reserved request', async t => {
  configureLimits(t);
  const f = await reviewFixture(2);
  const original = await f.repository.getTagExtractionBatchInputs(f.batch.id);
  const first = original.inputs[0]!;
  await db.updateTable('ai_job_input_members').set({
    payload: jsonb({ ...(first.payload as object), evidence: 'x'.repeat(5000) }),
  }).where('job_id', '=', f.job.id).where('input_id', '=', first.productId).execute();
  const small = original.inputs[1]!;
  const payload = { ...(small.payload as object), id: String(small.productId), name: small.name, spec: small.spec, sourceData: small.sourceData };
  const singleton = estimateStandardizationRequest(buildTagReviewRequest([payload], {
    items: original.proposals!.items.filter(item => item.id === payload.id),
  }, original.model), readStandardizationRequestLimits());
  process.env.AI_REQUEST_MAX_BYTES = String(singleton.requestBytes);
  await assert.rejects(f.repository.prepareBatch(f.batch.id), { retryClass: 'input_too_large' });
  const batches = await db.selectFrom('ai_job_batches').selectAll().where('job_id', '=', f.job.id).where('round', '=', 1).orderBy('batch_index').execute();
  assert.equal(batches.length, 2);
  assert.deepEqual(batches.map(batch => batch.product_ids), [[String(first.productId)], [String(small.productId)]]);
  assert.equal((batches[0]!.request_estimate as Record<string, unknown>).oversized, true);
  await f.repository.prepareBatch(batches[1]!.id);
  await db.updateTable('ai_job_batches').set({
    product_ids: jsonb(f.batch.product_ids), reference_snapshot: jsonb(f.batch.reference_snapshot!),
    request_budget_used: 1, confirmed_requests: 1,
  }).where('id', '=', f.batch.id).execute();
  await assert.rejects(f.repository.prepareBatch(f.batch.id), { retryClass: 'input_too_large' });
  assert.equal((await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', f.job.id).where('round', '=', 1).execute()).length, 2);
});

for (const fittingSibling of [true, false]) test(`removed review inputs are skipped beside oversized inputs ${fittingSibling ? 'with' : 'without'} a fitting sibling`, async t => {
  configureLimits(t);
  const f = await reviewFixture(fittingSibling ? 3 : 2);
  const [oversized, removed, fitting] = f.products;
  const original = await f.repository.getTagExtractionBatchInputs(f.batch.id);
  const first = original.inputs.find(input => input.productId === oversized!.id)!;
  await db.updateTable('ai_job_input_members').set({
    payload: jsonb({ ...(first.payload as object), evidence: 'x'.repeat(5000) }),
  }).where('job_id', '=', f.job.id).where('input_id', '=', oversized!.id).execute();
  await db.updateTable('products').set({ deleted_at: new Date() }).where('id', '=', removed!.id).execute();
  const fittingInputs = original.inputs.filter(input => input.productId === fitting?.id).map(input => ({
    ...(input.payload as object), id: String(input.productId), name: input.name, spec: input.spec, sourceData: input.sourceData,
  }));
  const size = estimateStandardizationRequest(buildTagReviewRequest(fittingInputs, {
    items: original.proposals!.items.filter(item => item.id === String(fitting?.id)),
  }, original.model), readStandardizationRequestLimits());
  process.env.AI_REQUEST_MAX_BYTES = String(size.requestBytes + 128);
  await f.repository.prepareBatch(f.batch.id);
  const prepared = await db.selectFrom('ai_job_batches').selectAll().where('job_id', '=', f.job.id).where('round', '=', 1).orderBy('batch_index').execute();
  assert.equal(prepared.length, 2);
  assert.ok((prepared[0]!.product_ids as string[]).includes(String(removed!.id)));
  assert.deepEqual(prepared[1]!.product_ids, [String(oversized!.id)]);
  assert.ok(prepared.every(batch => batch.request_budget_used === 0));
  if (fittingSibling) {
    const claim = await new JobsRepository(db).claimNext('ai_batch', 'skip-before-failure', 60000);
    assert.equal(claim?.id, f.batch.id);
    assert.equal(await f.repository.reserveBatchRequest(claim!.id, {
      workerId: claim!.claimed_by, attempt: claim!.attempts, token: String(claim!.row.claim_token),
    }), 'refresh');
  } else {
    assert.equal(await runWorker(f.repository, { AI_REQUEST_MAX_BYTES: process.env.AI_REQUEST_MAX_BYTES }), 0);
    assert.equal((await db.selectFrom('ai_job_batches').select('status').where('id', '=', f.batch.id).executeTakeFirstOrThrow()).status, 'succeeded');
  }
  assert.equal(await runWorker(f.repository, { AI_REQUEST_MAX_BYTES: process.env.AI_REQUEST_MAX_BYTES }), 0);
  const members = await db.selectFrom('ai_job_input_members').select(['product_id', 'output', 'reason_code']).where('job_id', '=', f.job.id).execute();
  const failed = members.find(member => member.product_id === oversized!.id)!;
  const skipped = members.find(member => member.product_id === removed!.id)!;
  assert.equal(failed.reason_code, 'input_too_large');
  assert.equal((failed.output as Record<string, unknown>).outcome, 'failed');
  assert.equal(skipped.reason_code, 'source_unavailable');
  assert.equal((skipped.output as Record<string, unknown>).outcome, 'skipped');
  assert.equal(members.filter(member => (member.output as Record<string, unknown> | null)?.outcome === 'failed').length, 1);
  if (fitting) assert.equal(members.find(member => member.product_id === fitting.id)!.output, null);
  assert.ok((await db.selectFrom('ai_job_batches').select('request_budget_used').where('job_id', '=', f.job.id).where('round', '=', 1).execute())
    .every(batch => batch.request_budget_used === 0));
});

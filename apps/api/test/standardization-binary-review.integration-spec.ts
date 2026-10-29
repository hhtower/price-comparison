import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Kysely, Migrator, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';
import { AiRepository } from '../src/ai/ai.repository.js';
import { createOpenAiModelCall } from '../src/ai/ai.worker.js';
import { parseStandardizationProtocolResponse } from '../src/ai/ai.schemas.js';
import { STANDARDIZATION_PROMPT_VERSION } from '../src/ai/standardization-request.js';
import { pipelineVersionSnapshot } from '../src/ai/pipeline-versions.js';
import { parseStandardizationReviewResponse } from '../src/ai/standardization-review-request.js';
import { IDENTITY_POLICY_VERSION } from '../src/standardization/identity-policy.js';
import { buildExtractionPayload } from '../src/ai/adaptive-batching.js';
import { productContentFingerprint } from '../src/standardization/fingerprint.js';
import { buildCanonicalStandardKey } from '../src/standardization/canonical-key.js';
import { jsonb, type DatabaseSchema } from '../src/database/types.js';
import { JobsRepository } from '../src/jobs/jobs.repository.js';

let db: Kysely<DatabaseSchema>, admin: Pool, schema: string;
before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL required');
  schema = `standardization_review_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
  admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({
    connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public`, max: 4,
  }) }) });
  const migrated = await new Migrator({ db, provider: migrationProvider, migrationTableSchema: schema }).migrateToLatest();
  if (migrated.error) throw migrated.error;
});
after(async () => {
  await db?.destroy();
  if (schema) await admin.query(`drop schema "${schema}" cascade`);
  await admin?.end();
});

const claim = { workerId: 'review-worker', attempt: 1n, token: 'request-claim' };
const metadata = { responseMs: 20, usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } };

async function fixture(names = ['ChatGPT Plus', 'Claude Pro']) {
  const shop = await db.insertInto('shops').values({
    platform: 'test', name: 'test', url: `https://test.invalid/${Math.random()}`, enabled: true,
  }).returning('id').executeTakeFirstOrThrow();
  const products = await db.insertInto('products').values(names.map((name, index) => ({
    shop_id: shop.id, external_id: String(index), name, spec: '', source_category: '',
    source_data: jsonb({}), normalized_key: `review-${index}`, url: 'https://test.invalid/p',
    content_version: 1n, content_fingerprint: productContentFingerprint({ name, spec: '', sourceCategory: '', sourceData: {} }),
  }))).returningAll().execute();
  const job = await db.insertInto('ai_jobs').values({
    total: BigInt(products.length), model: 'mock', job_type: 'manual_full', status: 'running',
    prompt_version: STANDARDIZATION_PROMPT_VERSION, rule_version: IDENTITY_POLICY_VERSION,
    pipeline_versions: jsonb(pipelineVersionSnapshot('mock')),
  }).returning('id').executeTakeFirstOrThrow();
  for (const product of products) {
    const payload = buildExtractionPayload({ id: String(product.id), name: product.name, spec: '', sourceData: {} });
    await db.insertInto('ai_job_inputs').values({
      job_id: job.id, input_id: product.id, payload: jsonb(payload), fingerprint: product.content_fingerprint,
      content_version: 1n, input_bytes: 100n, estimated_tokens: 100n, status: 'queued',
    }).execute();
    await db.insertInto('ai_job_input_members').values({
      job_id: job.id, input_id: product.id, product_id: product.id, fingerprint: product.content_fingerprint,
      payload: jsonb(payload), content_version: 1n, standardization_revision: product.standardization_revision,
    }).execute();
  }
  const batch = await db.insertInto('ai_job_batches').values({
    job_id: job.id, batch_index: 0n, product_ids: jsonb(products.map(product => String(product.id))),
    product_count: BigInt(products.length), step: 'request', status: 'running', claimed_by: claim.workerId,
    attempts: claim.attempt, claim_token: claim.token, lease_until: new Date(Date.now() + 60000),
    request_budget_used: 1, request_budget_limit: 2,
    reference_snapshot: jsonb({ strategyVersion: 'evidence-canonical-candidate-v2', catalogVersion: '0',
      inputs: products.map(product => ({ id: String(product.id), candidateStandardProductIds: [],
        stats: { scanned: 0, compared: 0, truncated: false } })), candidates: [] }),
  }).returning('id').executeTakeFirstOrThrow();
  const raw = { items: products.map(product => ({
    id: String(product.id), action: 'create_identity',
    identity: { family: product.name.startsWith('Claude') ? 'anthropic' : 'openai',
      product: product.name.startsWith('Claude') ? 'claude' : 'chatgpt',
      tier: product.name.startsWith('Claude') ? 'pro' : 'plus',
      evidence: [{ path: 'name', quote: product.name }], reason: 'Explicit sold plan' },
    evidence: [{ path: 'name', quote: product.name }], reason: 'Explicit sold plan', ruleIds: [],
  })) };
  const proposals = parseStandardizationProtocolResponse(raw, products.map(product => ({
    id: String(product.id), candidateStandardProductIds: [], candidateRefs: {},
  })));
  return { job, batch, products, raw, proposals, repo: new AiRepository(db) };
}

async function reviewBatch(f: Awaited<ReturnType<typeof fixture>>) {
  return db.selectFrom('ai_job_batches').selectAll().where('job_id', '=', f.job.id)
    .where('id', '!=', f.batch.id).executeTakeFirstOrThrow();
}

async function claimBatch(id: bigint) {
  await db.updateTable('ai_job_batches').set({
    status: 'running', claimed_by: claim.workerId, attempts: claim.attempt, claim_token: claim.token,
    lease_until: new Date(Date.now() + 60000),
  }).where('id', '=', id).execute();
}

async function approve(f: Awaited<ReturnType<typeof fixture>>) {
  await f.repo.persistBatchDecision(f.job.id, f.batch.id, f.proposals, metadata, claim, 'generate');
  const batch = await reviewBatch(f);
  await claimBatch(batch.id);
  await f.repo.reserveBatchRequest(batch.id, claim);
  const request = await f.repo.getBatchRequest(batch.id);
  const decision = parseStandardizationReviewResponse(JSON.stringify({ items: request.proposals!.items.map(item => ({ id: item.id, approved: true })) }), request.proposals!);
  await f.repo.persistBatchDecision(f.job.id, batch.id, decision, metadata, claim, 'review');
  return batch;
}

for (const enabled of [false, true]) test(`identity completion derives tag extraction only when enabled (${enabled})`, async () => {
  const previous = process.env.AI_TAG_EXTRACTION_ENABLED;
  try {
    if (enabled) delete process.env.AI_TAG_EXTRACTION_ENABLED;
    else process.env.AI_TAG_EXTRACTION_ENABLED = 'false';
    const f = await fixture();
    const batch = await approve(f);
    await claimBatch(batch.id);
    await f.repo.publishBatch(batch.id, claim);
    const children = await db.selectFrom('ai_jobs').select('id').where('parent_identity_job_id', '=', f.job.id).execute();
    assert.equal(children.length, enabled ? 1 : 0);
    assert.equal((await db.selectFrom('ai_jobs').select('status').where('id', '=', f.job.id).executeTakeFirstOrThrow()).status, 'succeeded');
    await db.updateTable('ai_jobs').set({ status: 'cancelled' }).where('parent_identity_job_id', '=', f.job.id).execute();
  } finally {
    if (previous === undefined) delete process.env.AI_TAG_EXTRACTION_ENABLED;
    else process.env.AI_TAG_EXTRACTION_ENABLED = previous;
  }
});

test('generation checkpoints proposals and queues a separate review without creating identities or results', async () => {
  const f = await fixture();
  await f.repo.persistBatchDecision(f.job.id, f.batch.id, f.proposals, metadata, claim, 'generate');
  const generation = await db.selectFrom('ai_job_batches').selectAll().where('id', '=', f.batch.id).executeTakeFirstOrThrow();
  assert.equal(generation.step, 'done');
  assert.equal(generation.confirmed_requests, 1);
  assert.deepEqual(generation.validated_decision, f.proposals);
  const review = await reviewBatch(f);
  assert.equal(review.step, 'request');
  assert.equal(review.request_budget_used, 0);
  assert.equal((review.reference_snapshot as any).standardizationStage, 'review');
  assert.equal((review.reference_snapshot as any).generationBatchId, String(f.batch.id));
  const restored = await new AiRepository(db).getBatchRequest(review.id);
  assert.equal(restored.stage, 'review');
  assert.deepEqual(restored.proposals, f.proposals);
  assert.equal((await db.selectFrom('ai_publication_units').select('id').where('batch_id', '=', f.batch.id).execute()).length, 0);
  assert.equal((await db.selectFrom('ai_standardization_results').select('product_id').where('job_id', '=', f.job.id).execute()).length, 0);
  assert.equal((await db.selectFrom('standard_product_members').select('product_id').where('product_id', 'in', f.products.map(p => p.id)).execute()).length, 0);
  await assert.rejects(f.repo.persistBatchDecision(f.job.id, f.batch.id, f.proposals, metadata, claim, 'generate'), /stale batch/);
});

test('omitting a stage still requires generation review and cannot directly publish', async () => {
  const f = await fixture(['ChatGPT Plus']);
  await f.repo.persistBatchDecision(f.job.id, f.batch.id, f.proposals, metadata, claim);
  const generation = await db.selectFrom('ai_job_batches').selectAll().where('id', '=', f.batch.id).executeTakeFirstOrThrow();
  assert.equal(generation.step, 'done');
  assert.equal((await reviewBatch(f)).step, 'request');
  assert.equal((await db.selectFrom('ai_publication_units').select('id').where('batch_id', '=', f.batch.id).execute()).length, 0);
});

test('source removal after a complete generation cannot discard another product response', async () => {
  const f = await fixture();
  await db.updateTable('products').set({ deleted_at: new Date() }).where('id', '=', f.products[1]!.id).execute();
  await f.repo.persistBatchDecision(f.job.id, f.batch.id, f.proposals, metadata, claim, 'generate');
  const generation = await db.selectFrom('ai_job_batches').selectAll().where('id', '=', f.batch.id).executeTakeFirstOrThrow();
  assert.equal(generation.confirmed_requests, 1);
  assert.equal((generation.validated_decision as any).items.length, 2);
  const review = await reviewBatch(f);
  await claimBatch(review.id);
  assert.equal(await f.repo.reserveBatchRequest(review.id, claim), 'refresh');
  assert.equal(await f.repo.reserveBatchRequest(review.id, claim), 'reserved');
  const request = await f.repo.getBatchRequest(review.id);
  assert.deepEqual(request.proposals!.items.map(item => item.id), [String(f.products[0]!.id)]);
  const result = parseStandardizationReviewResponse(`{"items":[{"id":"${f.products[0]!.id}","approved":true}]}`, request.proposals!);
  await f.repo.persistBatchDecision(f.job.id, review.id, result, metadata, claim, 'review');
  await claimBatch(review.id);
  await f.repo.publishBatch(review.id, claim);
  const results = await db.selectFrom('ai_standardization_results').select(['product_id', 'status', 'reason_code'])
    .where('job_id', '=', f.job.id).orderBy('product_id').execute();
  assert.equal(results[0]?.status, 'classified');
  assert.equal(results[1]?.reason_code, 'source_changed');
  await db.updateTable('ai_jobs').set({ status: 'cancelled' }).where('parent_identity_job_id', '=', f.job.id).execute();
});

test('approved equal canonical identities preserve each product original evidence and reference', async () => {
  const f = await fixture(['ChatGPT Plus alpha', 'ChatGPT Plus beta']);
  const fields = { family: 'software', product: `evidence_test_${f.job.id}`, tier: 'standard' };
  const canonicalKey = buildCanonicalStandardKey(fields);
  f.proposals.identities = f.proposals.identities.map(identity => ({ ...identity, ...fields, canonicalKey }));
  f.proposals.items = f.proposals.items.map(item => ({ ...item,
    identity: { kind: 'new', ref: `i-${item.id}`, canonicalKey } }));
  const batch = await approve(f);
  const checkpoint = await db.selectFrom('ai_job_batches').select('validated_decision').where('id', '=', batch.id).executeTakeFirstOrThrow();
  const saved = checkpoint.validated_decision as any;
  assert.equal(saved.identities.length, 2);
  assert.notEqual(saved.items[0].identity.ref, saved.items[1].identity.ref);
  assert.deepEqual(saved.identities.map((identity: any) => identity.evidence[0].quote).sort(), ['ChatGPT Plus alpha', 'ChatGPT Plus beta']);
  await db.updateTable('products').set({ deleted_at: new Date() }).where('id', '=', f.products[0]!.id).execute();
  await claimBatch(batch.id);
  await f.repo.publishBatch(batch.id, claim);
  const result = await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', f.job.id)
    .where('product_id', '=', f.products[1]!.id).executeTakeFirstOrThrow();
  assert.equal(result.status, 'classified');
  const standard = await db.selectFrom('standard_products').select('verification_reason').where('id', '=', result.standard_product_id!).executeTakeFirstOrThrow();
  assert.equal((standard.verification_reason as any).evidence[0].quote, 'ChatGPT Plus beta');
  await db.updateTable('ai_jobs').set({ status: 'cancelled' }).where('parent_identity_job_id', '=', f.job.id).execute();
});

test('reviewed publication uses the reviewed identity despite local source heuristics and same-name majority', async () => {
  const f = await fixture(['ChatGPT Plus']);
  const input = f.products[0]!;
  const wrong = await db.insertInto('standard_products').values({
    name: 'wrong majority', canonical_family: 'openai', canonical_product: 'chatgpt', canonical_tier: 'free', verification_state: 'verified',
  }).returning('id').executeTakeFirstOrThrow();
  const peers = await db.insertInto('products').values([1, 2, 3].map(index => ({
    shop_id: input.shop_id, external_id: `peer-${index}`, name: input.name, spec: '', source_category: '',
    source_data: jsonb({}), normalized_key: `peer-${index}`, url: 'https://test.invalid/peer',
  }))).returning('id').execute();
  await db.insertInto('standard_product_members').values(peers.map(peer => ({
    product_id: peer.id, standard_product_id: wrong.id, assignment_source: 'ai' as const, publication_state: 'published' as const,
  }))).execute();
  await f.repo.persistBatchDecision(f.job.id, f.batch.id, f.proposals, metadata, claim, 'generate');
  const review = await reviewBatch(f);
  await claimBatch(review.id);
  await f.repo.reserveBatchRequest(review.id, claim);
  const approved = { ...f.proposals, items: f.proposals.items.map(item => ({ ...item, review: { approved: true } })) };
  await f.repo.persistBatchDecision(f.job.id, review.id, approved, metadata, claim, 'review');
  await claimBatch(review.id);
  await f.repo.publishBatch(review.id, claim);
  const membership = await db.selectFrom('standard_product_members as m').innerJoin('standard_products as s', 's.id', 'm.standard_product_id')
    .select(['s.canonical_tier']).where('m.product_id', '=', input.id).executeTakeFirstOrThrow();
  assert.equal(membership.canonical_tier, 'plus');
  await db.updateTable('ai_jobs').set({ status: 'cancelled' }).where('parent_identity_job_id', '=', f.job.id).execute();
});

test('mixed binary review persists before publication and rejected proposals preserve old membership', async () => {
  const f = await fixture();
  const previous = await db.insertInto('standard_products').values({
    name: 'old', canonical_family: 'generic', canonical_product: 'old', canonical_tier: 'standard', verification_state: 'verified',
  }).returning('id').executeTakeFirstOrThrow();
  await db.insertInto('standard_product_members').values({
    product_id: f.products[1]!.id, standard_product_id: previous.id, assignment_source: 'ai', publication_state: 'published',
  }).execute();
  await f.repo.persistBatchDecision(f.job.id, f.batch.id, f.proposals, metadata, claim, 'generate');
  const review = await reviewBatch(f);
  await claimBatch(review.id);
  await f.repo.prepareBatch(review.id);
  await f.repo.reserveBatchRequest(review.id, claim);
  const call = createOpenAiModelCall(f.repo, {
    AI_BASE_URL: 'https://mock.invalid/v1', AI_API_KEY: 'mock', AI_MODEL: 'mock',
  }, async (_url, init) => {
    const sent = JSON.parse(String(init?.body));
    assert.equal(sent.stream, true);
    const content = JSON.stringify({ items: [
      { id: String(f.products[1]!.id), approved: false }, { id: String(f.products[0]!.id), approved: true },
    ] });
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(0, 25) } }] })}\n\n`
      + `data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(25) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  const claimed = { id: review.id, row: { ...review, job_type: 'manual_full' }, attempts: 1n, claimed_by: claim.workerId };
  const result = await call(claimed, new AbortController().signal);
  assert.equal(result.standardizationStage, 'review');
  await f.repo.persistBatchDecision(f.job.id, review.id, result, result.metadata, claim, result.standardizationStage);
  const checkpoint = await db.selectFrom('ai_job_batches').selectAll().where('id', '=', review.id).executeTakeFirstOrThrow();
  assert.equal(checkpoint.step, 'publish');
  assert.equal(checkpoint.confirmed_requests, 1);
  await claimBatch(review.id);
  await new AiRepository(db).publishBatch(review.id, claim);
  const results = await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', f.job.id).orderBy('product_id').execute();
  assert.equal(results[0]?.status, 'classified');
  assert.equal(results[1]?.reason_code, 'review_rejected');
  assert.deepEqual((results[1]?.decision as any).review, { approved: false });
  assert.equal(results[1]?.current_assignment_preserved, true);
  const membership = await db.selectFrom('standard_product_members').select('standard_product_id')
    .where('product_id', '=', f.products[1]!.id).executeTakeFirstOrThrow();
  assert.equal(membership.standard_product_id, previous.id);
  await db.updateTable('ai_jobs').set({ status: 'cancelled' }).where('parent_identity_job_id', '=', f.job.id).execute();
});

test('review checkpoint rolls back confirmation on a changed proposal and rejects the wrong stage', async () => {
  const f = await fixture(['ChatGPT Plus']);
  await f.repo.persistBatchDecision(f.job.id, f.batch.id, f.proposals, metadata, claim, 'generate');
  const batch = await reviewBatch(f);
  await claimBatch(batch.id);
  await f.repo.reserveBatchRequest(batch.id, claim);
  const request = await f.repo.getBatchRequest(batch.id);
  const decision = parseStandardizationReviewResponse(`{"items":[{"id":"${f.products[0]!.id}","approved":true}]}`, request.proposals!);
  decision.items[0]!.reason = 'model attempted to repair proposal';
  await assert.rejects(f.repo.persistBatchDecision(f.job.id, batch.id, decision, metadata, claim, 'review'), /changed its original proposals/);
  const after = await db.selectFrom('ai_job_batches').selectAll().where('id', '=', batch.id).executeTakeFirstOrThrow();
  assert.equal(after.confirmed_requests, 0);
  assert.equal(after.validated_decision, null);
  assert.equal(after.step, 'request');
  await assert.rejects(f.repo.persistBatchDecision(f.job.id, batch.id, f.proposals, metadata, claim, 'generate'), /stage/);
});

test('review approval preserves source and manual protection and publishes no partial writes', async () => {
  for (const change of ['source', 'manual'] as const) {
    const f = await fixture(['ChatGPT Plus']);
    const batch = await approve(f);
    await db.updateTable('products').set(change === 'source' ? { name: 'new source', content_version: 2n } : { standardization_locked: true })
      .where('id', '=', f.products[0]!.id).execute();
    await claimBatch(batch.id);
    await f.repo.publishBatch(batch.id, claim);
    const result = await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', f.job.id).executeTakeFirstOrThrow();
    assert.equal(result.reason_code, change === 'source' ? 'source_changed' : 'manual_decision_preserved');
    assert.equal(result.current_assignment_preserved, true);
    assert.equal((await db.selectFrom('standard_product_members').select('product_id').where('product_id', '=', f.products[0]!.id).execute()).length, 0);
  }
});

test('local publication can resume after a database failure without another model request', async () => {
  const f = await fixture(['ChatGPT Plus']);
  const batch = await approve(f);
  await admin.query(`create function "${schema}".reject_review_publish() returns trigger language plpgsql as $$begin raise exception 'publish unavailable'; end$$`);
  await admin.query(`create trigger reject_review_publish before insert on "${schema}".standard_product_members for each row execute function "${schema}".reject_review_publish()`);
  await claimBatch(batch.id);
  try {
    await assert.rejects(f.repo.publishBatch(batch.id, claim), /publish unavailable/);
    const saved = await db.selectFrom('ai_job_batches').selectAll().where('id', '=', batch.id).executeTakeFirstOrThrow();
    assert.equal(saved.step, 'publish');
    assert.equal(saved.confirmed_requests, 1);
    assert.ok(saved.validated_decision);
    assert.equal((await db.selectFrom('ai_standardization_results').select('product_id').where('job_id', '=', f.job.id).execute()).length, 0);
  } finally {
    await admin.query(`drop trigger reject_review_publish on "${schema}".standard_product_members`);
    await admin.query(`drop function "${schema}".reject_review_publish()`);
  }
  await new AiRepository(db).publishBatch(batch.id, claim);
  const result = await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', f.job.id).executeTakeFirstOrThrow();
  assert.equal(result.status, 'classified');
  assert.equal((await db.selectFrom('ai_job_batches').select('request_budget_used').where('id', '=', batch.id).executeTakeFirstOrThrow()).request_budget_used, 1);
  await db.updateTable('ai_jobs').set({ status: 'cancelled' }).where('parent_identity_job_id', '=', f.job.id).execute();
});

test('review is claimable in its own window while generation remains active', async () => {
  await db.updateTable('ai_jobs').set({ status: 'cancelled' }).execute();
  const f = await fixture(['ChatGPT Plus']);
  const previousConcurrency = process.env.AI_CONCURRENCY;
  process.env.AI_CONCURRENCY = '1';
  try {
    await db.insertInto('ai_job_batches').values({
      job_id: f.job.id, batch_index: 1n, product_ids: jsonb([]), product_count: 0n, round: 0,
      status: 'running', claimed_by: 'other', claim_token: 'other', lease_until: new Date(Date.now() + 60000),
    }).execute();
    await f.repo.persistBatchDecision(f.job.id, f.batch.id, f.proposals, metadata, claim, 'generate');
    const queued = await db.selectFrom('ai_job_batches').selectAll().where('job_id', '=', f.job.id)
      .where('status', '=', 'queued').executeTakeFirstOrThrow();
    const jobs = new JobsRepository(db);
    const claimed = await jobs.claimAvailable('ai_standardization', 'review-priority', 1);
    assert.equal(claimed[0]?.id, queued.id);
    assert.equal((claimed[0]?.row.reference_snapshot as any).standardizationStage, 'review');
    await f.repo.prepareBatch(queued.id);
    assert.equal(await f.repo.reserveBatchRequest(queued.id, {
      workerId: claimed[0]!.claimed_by, attempt: claimed[0]!.attempts, token: String(claimed[0]!.row.claim_token),
    }), 'reserved');
    assert.equal((await f.repo.getBatchRequest(queued.id)).stage, 'review');
  } finally {
    await db.updateTable('ai_jobs').set({ status: 'cancelled' }).where('id', '=', f.job.id).execute();
    if (previousConcurrency === undefined) delete process.env.AI_CONCURRENCY;
    else process.env.AI_CONCURRENCY = previousConcurrency;
  }
});

test('missing generation IDs are never judged and still receive the original single retry round', async () => {
  const f = await fixture();
  f.proposals.items = f.proposals.items.slice(0, 1);
  f.proposals.identities = f.proposals.identities.filter(identity => identity.ref === `i-${f.products[0]!.id}`);
  f.proposals.missingIds = [String(f.products[1]!.id)];
  const batch = await approve(f);
  await claimBatch(batch.id);
  await f.repo.publishBatch(batch.id, claim);
  const retry = await db.selectFrom('ai_job_batches').selectAll().where('job_id', '=', f.job.id)
    .where('step', '=', 'request').where('status', '=', 'queued').executeTakeFirstOrThrow();
  assert.equal(retry.round, 1);
  assert.equal((retry.reference_snapshot as any)?.standardizationStage, undefined);
  assert.deepEqual(retry.product_ids, [String(f.products[1]!.id)]);
  await db.updateTable('ai_jobs').set({ status: 'cancelled' }).where('parent_identity_job_id', '=', f.job.id).execute();
});

test('an all-missing generation uses only local publication and never queues an empty review call', async () => {
  const f = await fixture(['ChatGPT Plus']);
  await f.repo.persistBatchDecision(f.job.id, f.batch.id, {
    identities: [], items: [], missingIds: [String(f.products[0]!.id)],
  }, metadata, claim, 'generate');
  const batch = await db.selectFrom('ai_job_batches').selectAll().where('id', '=', f.batch.id).executeTakeFirstOrThrow();
  assert.equal(batch.step, 'publish');
  assert.equal(batch.confirmed_requests, 1);
  assert.equal((await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', f.job.id).execute()).length, 1);
});

test('a reviewed legacy spelling cannot publish a different canonical identity through alias resolution', async () => {
  const f = await fixture(['DeepSeek Harness Bundle']);
  const legacy = { family: 'deepseek', product: 'deepseek_v4_1_harness_bundle', tier: 'standard' };
  const target = { family: 'deepseek', product: 'deepseek_harness', tier: 'standard' };
  await db.insertInto('standard_products').values({
    name: 'existing alias target', canonical_family: target.family, canonical_product: target.product, canonical_tier: target.tier,
    standard_key: buildCanonicalStandardKey(target), verification_state: 'verified',
  }).execute();
  const raw = structuredClone(f.raw);
  Object.assign(raw.items[0]!.identity, legacy);
  f.proposals = parseStandardizationProtocolResponse(raw, [{ id: String(f.products[0]!.id), candidateStandardProductIds: [], candidateRefs: {} }]);
  assert.equal(f.proposals.items[0]?.status, 'classified');
  const batch = await approve(f);
  await claimBatch(batch.id);
  await f.repo.publishBatch(batch.id, claim);
  const result = await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', f.job.id).executeTakeFirstOrThrow();
  assert.equal(result.status, 'unclassified');
  assert.equal(result.reason_code, 'publication_blocked');
  assert.equal(result.standard_product_id, null);
  assert.equal((await db.selectFrom('standard_product_members').select('product_id').where('product_id', '=', f.products[0]!.id).execute()).length, 0);
});

test('review model owns sales-claim semantics while publication retains deterministic source protection', async () => {
  const f = await fixture(['ChatGPT Plus']);
  const product = f.products[0]!;
  const sourceData = { evidence: '本商品支持提前续费。实际交付仅限到期之后续费。' };
  const payload = buildExtractionPayload({ id: String(product.id), name: product.name, spec: '', sourceData });
  const fingerprint = productContentFingerprint({ name: product.name, spec: '', sourceCategory: '', sourceData });
  await db.updateTable('products').set({ source_data: jsonb(sourceData), content_fingerprint: fingerprint }).where('id', '=', product.id).execute();
  await db.updateTable('ai_job_inputs').set({ payload: jsonb(payload), fingerprint }).where('job_id', '=', f.job.id).execute();
  await db.updateTable('ai_job_input_members').set({ payload: jsonb(payload), fingerprint }).where('job_id', '=', f.job.id).execute();
  const batch = await approve(f);
  await claimBatch(batch.id);
  await f.repo.publishBatch(batch.id, claim);
  const result = await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', f.job.id).executeTakeFirstOrThrow();
  assert.equal(result.status, 'classified', 'a mock YES verifies the pipeline boundary, not semantic accuracy');
  await db.updateTable('ai_jobs').set({ status: 'cancelled' }).where('parent_identity_job_id', '=', f.job.id).execute();
});

test('local generation errors remain retryable when another product is rejected by review', async () => {
  const f = await fixture();
  const invalid = { id: String(f.products[1]!.id), status: 'unclassified' as const, ruleIds: [], evidence: [],
    reasonCode: 'invalid_response' as const, reason: '模型提议缺少必填字段',
    diagnostic: { stage: 'schema' as const, code: 'missing_field', fieldPath: 'items[1].reason' } };
  f.proposals.items[1] = invalid;
  f.proposals.identities = f.proposals.identities.filter(identity => identity.ref === `i-${f.products[0]!.id}`);
  await f.repo.persistBatchDecision(f.job.id, f.batch.id, f.proposals, metadata, claim);
  const batch = await reviewBatch(f);
  await claimBatch(batch.id);
  await f.repo.reserveBatchRequest(batch.id, claim);
  const request = await f.repo.getBatchRequest(batch.id);
  const result = parseStandardizationReviewResponse(`{"items":[{"id":"${f.products[0]!.id}","approved":false}]}`, request.proposals!);
  assert.deepEqual(result.items[1], invalid);
  await f.repo.persistBatchDecision(f.job.id, batch.id, result, metadata, claim);
  await claimBatch(batch.id);
  await f.repo.publishBatch(batch.id, claim);
  const rows = await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', f.job.id).orderBy('product_id').execute();
  assert.equal(rows[0]?.reason_code, 'review_rejected');
  assert.equal(rows[1]?.reason_code, 'invalid_response');
  assert.equal((rows[1]?.decision as any).review, undefined);
});

import { withMembershipSource } from './membership-fixture.js';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';
import { AiRepository } from '../src/ai/ai.repository.js';
import { createOpenAiModelCall } from '../src/ai/ai.worker.js';
import { parseStandardizationProtocolResponse, standardizationProposal, STANDARDIZATION_REVIEW_REASONS } from '../src/ai/ai.schemas.js';
import { parseStandardizationReviewResponse } from '../src/ai/standardization-review-request.js';
import { buildExtractionPayload } from '../src/ai/adaptive-batching.js';
import { productContentFingerprint } from '../src/standardization/fingerprint.js';
import { jsonb, type DatabaseSchema, type JsonValue } from '../src/database/types.js';
import { JobsRepository } from '../src/jobs/jobs.repository.js';
import { seedMatchOnlyReviewFixture } from './standardization-review-fixture.js';
import { suppressManualDecisionTrigger } from '../src/standardization/decision-history.js';
import { buildMembershipFeatures, readCurrentMembershipFeatures } from '../src/standardization/membership-classification.js';

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

const fixture = async (names?: string[]) => {
  await db.updateTable('standard_products').set({ verification_state: 'quarantined' }).execute();
  return seedMatchOnlyReviewFixture(db, names);
};

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
  const decision = parseStandardizationReviewResponse(JSON.stringify({ items: request.proposals!.items.map(item => ({
    id: item.id, approved: true, code: null, evidence: [],
  })) }), request.proposals!, request);
  await f.repo.persistBatchDecision(f.job.id, batch.id, decision, metadata, claim, 'review');
  return batch;
}

async function rejectCorrection(f: Awaited<ReturnType<typeof fixture>>, reviewId: bigint) {
  const repair = await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', f.job.id)
    .where(sql<string>`reference_snapshot->>'repairReviewBatchId'`, '=', String(reviewId)).executeTakeFirstOrThrow();
  await claimBatch(repair.id);
  await f.repo.reserveBatchRequest(repair.id, claim);
  const request = await f.repo.getBatchRequest(repair.id);
  const original = request.repairFeedback!;
  const proposed = parseStandardizationProtocolResponse({ items: original.map(item => ({
    id: item.id, ...item.review!.proposal, evidence: item.evidence,
  })) }, request.inputs.map(input => ({ id: String(input.productId), candidateStandardProductIds: input.candidateStandardProductIds })));
  await f.repo.persistBatchDecision(f.job.id, repair.id, proposed, metadata, claim);
  const second = await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', f.job.id)
    .where(sql<string>`reference_snapshot->>'proposalBatchId'`, '=', String(repair.id)).executeTakeFirstOrThrow();
  await claimBatch(second.id);
  await f.repo.reserveBatchRequest(second.id, claim);
  const recheck = await f.repo.getBatchRequest(second.id);
  const rejected = parseStandardizationReviewResponse(JSON.stringify({ items: original.map(item => ({
    id: item.id, approved: false, code: item.review!.code, evidence: item.review!.evidence,
  })) }), recheck.proposals!, recheck);
  await f.repo.persistBatchDecision(f.job.id, second.id, rejected, metadata, claim);
  await claimBatch(second.id);
  await f.repo.publishBatch(second.id, claim);
}

for (const enabled of [false, true]) test(`identity completion schedules features independently of tag extraction (${enabled})`, async () => {
  const previous = process.env.AI_TAG_EXTRACTION_ENABLED;
  try {
    if (enabled) delete process.env.AI_TAG_EXTRACTION_ENABLED;
    else process.env.AI_TAG_EXTRACTION_ENABLED = 'false';
    const f = await fixture();
    const batch = await approve(f);
    assert.deepEqual(await db.selectFrom('ai_jobs').select('id').where('parent_identity_job_id', '=', f.job.id).execute(), []);
    await claimBatch(batch.id);
    await f.repo.publishBatch(batch.id, claim);
    const children = await db.selectFrom('ai_jobs').select('job_type').where('parent_identity_job_id', '=', f.job.id).execute();
    assert.deepEqual(children.map(child => child.job_type).sort(), enabled ? ['membership_features', 'tag_extraction'] : ['membership_features']);
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
  assert.equal((review.reference_snapshot as any).reviewStage, 'review');
  assert.equal((review.reference_snapshot as any).proposalBatchId, String(f.batch.id));
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
  const result = parseStandardizationReviewResponse(`{"items":[{"id":"${f.products[0]!.id}","approved":true,"code":null,"evidence":[]}]}`, request.proposals!, request);
  await f.repo.persistBatchDecision(f.job.id, review.id, result, metadata, claim, 'review');
  await claimBatch(review.id);
  await f.repo.publishBatch(review.id, claim);
  const results = await db.selectFrom('ai_standardization_results').select(['product_id', 'status', 'reason_code'])
    .where('job_id', '=', f.job.id).orderBy('product_id').execute();
  assert.equal(results[0]?.status, 'classified');
  assert.equal(results[1]?.reason_code, 'source_changed');
  await db.updateTable('ai_jobs').set({ status: 'cancelled' }).where('parent_identity_job_id', '=', f.job.id).execute();
});

test('approved matches to one existing standard preserve each product original evidence', async () => {
  const f = await fixture(['ChatGPT Plus alpha', 'ChatGPT Plus beta']);
  const standardsBefore = await db.selectFrom('standard_products').selectAll().orderBy('id').execute();
  const batch = await approve(f);
  const checkpoint = await db.selectFrom('ai_job_batches').select('validated_decision').where('id', '=', batch.id).executeTakeFirstOrThrow();
  const saved = checkpoint.validated_decision as any;
  assert.deepEqual(Object.keys(saved).sort(), ['items', 'missingIds']);
  assert.deepEqual(saved.items.map((item: any) => item.identity),
    Array.from({ length: 2 }, () => ({ kind: 'existing', standardProductId: String(f.standards[0]!.id) })));
  assert.deepEqual(saved.items.map((item: any) => item.evidence[0].quote), ['ChatGPT Plus alpha', 'ChatGPT Plus beta']);
  await db.updateTable('products').set({ deleted_at: new Date() }).where('id', '=', f.products[0]!.id).execute();
  await claimBatch(batch.id);
  await f.repo.publishBatch(batch.id, claim);
  const result = await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', f.job.id)
    .where('product_id', '=', f.products[1]!.id).executeTakeFirstOrThrow();
  assert.equal(result.status, 'classified');
  assert.equal(result.standard_product_id, f.standards[0]!.id);
  assert.deepEqual(result.evidence, [{ path: 'name', quote: 'ChatGPT Plus beta' }]);
  assert.deepEqual(await db.selectFrom('standard_products').selectAll().orderBy('id').execute(), standardsBefore);
  assert.deepEqual(await db.selectFrom('ai_batch_identity_mappings').selectAll().where('batch_id', '=', batch.id).execute(), []);
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
  const request = await f.repo.getBatchRequest(review.id);
  const approved = parseStandardizationReviewResponse(JSON.stringify({ items: f.proposals.items.map(item => ({
    id: item.id, approved: true, code: null, evidence: [],
  })) }), request.proposals!, request);
  await f.repo.persistBatchDecision(f.job.id, review.id, approved, metadata, claim, 'review');
  await claimBatch(review.id);
  await f.repo.publishBatch(review.id, claim);
  const membership = await db.selectFrom('standard_product_members as m').innerJoin('standard_products as s', 's.id', 'm.standard_product_id')
    .select(['s.canonical_tier']).where('m.product_id', '=', input.id).executeTakeFirstOrThrow();
  assert.equal(membership.canonical_tier, 'plus');
  await db.updateTable('ai_jobs').set({ status: 'cancelled' }).where('parent_identity_job_id', '=', f.job.id).execute();
});

test('mixed binary review persists before publication and rejected proposals preserve old membership', async () => {
  const f = await fixture(['ChatGPT Plus', 'Claude Pro 资格链接,不含订阅']);
  const feedbackEvidence = [{ path: 'name', quote: '资格链接,不含订阅' }];
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
      { id: String(f.products[1]!.id), approved: false, code: 'identity_mismatch', evidence: feedbackEvidence },
      { id: String(f.products[0]!.id), approved: true, code: null, evidence: [] },
    ] });
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(0, 25) } }] })}\n\n`
      + `data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(25) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  const claimed = { id: review.id, row: { ...review, job_type: 'manual_full' }, attempts: 1n, claimed_by: claim.workerId };
  const result = await call(claimed, new AbortController().signal);
  assert.equal(result.reviewStage, 'review');
  await f.repo.persistBatchDecision(f.job.id, review.id, result, result.metadata, claim, result.reviewStage);
  const checkpoint = await db.selectFrom('ai_job_batches').selectAll().where('id', '=', review.id).executeTakeFirstOrThrow();
  assert.equal(checkpoint.step, 'publish');
  assert.equal(checkpoint.confirmed_requests, 1);
  await claimBatch(review.id);
  await new AiRepository(db).publishBatch(review.id, claim);
  await rejectCorrection(f, review.id);
  const results = await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', f.job.id).orderBy('product_id').execute();
  assert.equal(results[0]?.status, 'classified');
  assert.equal(results[1]?.reason_code, 'review_rejected');
  assert.deepEqual((results[1]?.decision as any).review, {
    approved: false, code: 'identity_mismatch', evidence: feedbackEvidence,
    proposal: standardizationProposal(f.proposals.items[1]!),
  });
  assert.equal(results[1]?.reason, STANDARDIZATION_REVIEW_REASONS.identity_mismatch);
  assert.deepEqual(results[1]?.evidence, feedbackEvidence);
  assert.deepEqual((results[1]?.decision as any).evidence, f.raw.items[1]!.evidence);
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
  const decision = parseStandardizationReviewResponse(`{"items":[{"id":"${f.products[0]!.id}","approved":true,"code":null,"evidence":[]}]}`, request.proposals!, request);
  decision.items[0]!.reason = 'model attempted to repair proposal';
  await assert.rejects(f.repo.persistBatchDecision(f.job.id, batch.id, decision, metadata, claim, 'review'));
  const after = await db.selectFrom('ai_job_batches').selectAll().where('id', '=', batch.id).executeTakeFirstOrThrow();
  assert.equal(after.confirmed_requests, 0);
  assert.equal(after.validated_decision, null);
  assert.equal(after.step, 'request');
  await assert.rejects(f.repo.persistBatchDecision(f.job.id, batch.id, f.proposals, metadata, claim, 'generate'), /stage/);
});

test('review checkpoint rejects forged proposal snapshots, altered original evidence and fabricated diagnostics atomically', async () => {
  const f = await fixture(['ChatGPT Plus 资格链接,不含订阅']);
  await f.repo.persistBatchDecision(f.job.id, f.batch.id, f.proposals, metadata, claim, 'generate');
  const batch = await reviewBatch(f);
  await claimBatch(batch.id);
  await f.repo.reserveBatchRequest(batch.id, claim);
  const request = await f.repo.getBatchRequest(batch.id);
  const decision = parseStandardizationReviewResponse(JSON.stringify({ items: [{
    id: String(f.products[0]!.id), approved: false, code: 'identity_mismatch',
    evidence: [{ path: 'name', quote: '资格链接,不含订阅' }],
  }] }), request.proposals!, request);
  for (const mutate of [
    (item: any) => { item.review.proposal.standardProductId = String(f.standards[1]!.id); },
    (item: any) => { item.evidence = [{ path: 'name', quote: 'ChatGPT Plus' }]; },
    (item: any) => { item.review.evidence = [{ path: 'name', quote: 'fabricated subscription' }]; },
    (item: any) => { item.review.approved = true; },
    (item: any) => { item.review = { approved: false }; },
  ]) {
    const forged = structuredClone(decision);
    mutate(forged.items[0]);
    await assert.rejects(f.repo.persistBatchDecision(f.job.id, batch.id, forged, metadata, claim, 'review'));
    const saved = await db.selectFrom('ai_job_batches').select(['confirmed_requests', 'validated_decision', 'step'])
      .where('id', '=', batch.id).executeTakeFirstOrThrow();
    assert.deepEqual(saved, { confirmed_requests: 0, validated_decision: null, step: 'request' });
  }
  await f.repo.persistBatchDecision(f.job.id, batch.id, decision, metadata, claim, 'review');
  const saved = await db.selectFrom('ai_job_batches').select('validated_decision').where('id', '=', batch.id).executeTakeFirstOrThrow();
  assert.deepEqual(saved.validated_decision, decision);
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
    assert.equal((claimed[0]?.row.reference_snapshot as any).reviewStage, 'review');
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

test('missing generation IDs fail before checkpointing or scheduling review', async () => {
  const f = await fixture();
  f.proposals.items = f.proposals.items.slice(0, 1);
  f.proposals.missingIds = [String(f.products[1]!.id)];
  await assert.rejects(f.repo.persistBatchDecision(f.job.id, f.batch.id, f.proposals, metadata, claim));
  assert.deepEqual(await db.selectFrom('ai_job_batches').selectAll().where('job_id', '=', f.job.id).execute(), [f.batch]);
  assert.deepEqual(await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', f.job.id).execute(), []);
});

test('an all-missing generation fails without publishing unmatched results', async () => {
  const f = await fixture(['ChatGPT Plus']);
  await assert.rejects(f.repo.persistBatchDecision(f.job.id, f.batch.id, {
    items: [], missingIds: [String(f.products[0]!.id)],
  }, metadata, claim, 'generate'));
  const batch = await db.selectFrom('ai_job_batches').selectAll().where('id', '=', f.batch.id).executeTakeFirstOrThrow();
  assert.equal(batch.step, 'request');
  assert.equal(batch.confirmed_requests, 0);
  assert.equal(batch.validated_decision, null);
  assert.equal((await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', f.job.id).execute()).length, 1);
});

for (const nullReason of ['candidate_unavailable', 'insufficient_source'] as const) test(`${nullReason} proposals require review and retain evidence without creating standards`, async () => {
  const name = nullReason === 'candidate_unavailable' ? 'Cursor Pro' : 'Unlisted plan';
  const f = await fixture([name]);
  f.proposals = parseStandardizationProtocolResponse({
    items: [{ id: String(f.products[0]!.id), standardProductId: null, nullReason, evidence: [{ path: 'name', quote: name }] }],
  }, f.inputs);
  const standardsBefore = await db.selectFrom('standard_products').selectAll().orderBy('id').execute();
  const batch = await approve(f);
  assert.notEqual(batch.id, f.batch.id);
  await claimBatch(batch.id);
  await f.repo.publishBatch(batch.id, claim);
  const result = await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', f.job.id).executeTakeFirstOrThrow();
  assert.equal(result.status, 'unclassified');
  assert.equal(result.reason_code, nullReason);
  assert.equal(result.standard_product_id, null);
  assert.deepEqual(result.evidence, [{ path: 'name', quote: name }]);
  assert.deepEqual((result.decision as any).review, { approved: true, code: null, evidence: [],
    proposal: { standardProductId: null, nullReason } });
  assert.equal((await db.selectFrom('standard_product_members').select('product_id').where('product_id', '=', f.products[0]!.id).execute()).length, 0);
  assert.deepEqual(await db.selectFrom('standard_products').selectAll().orderBy('id').execute(), standardsBefore);
  assert.deepEqual(await db.selectFrom('ai_batch_identity_mappings').selectAll().where('batch_id', '=', batch.id).execute(), []);
});

test('approved unmatched enters pending atomically, retaining quotes, audit, locks and current manual assignments', async () => {
  const historyJob = await db.insertInto('ai_jobs').values({ model: 'mock', status: 'succeeded', total: 3n })
    .returning('id').executeTakeFirstOrThrow();
  const f = await fixture(['Unlisted plan', 'Unlisted locked plan', 'Unlisted manually assigned plan']);
  const productIds = f.products.map(product => product.id);
  const oldStandardId = f.standards[0]!.id;
  await db.insertInto('standard_product_members').values(productIds.map(productId => ({
    product_id: productId, standard_product_id: oldStandardId, assignment_source: 'ai',
    publication_state: 'published' as const, decision_version: historyJob.id,
  }))).execute();
  await db.insertInto('offers').values(productIds.map(productId => ({
    product_id: productId, idempotency_key: `unmatched-${productId}`, price: '19.99', currency: 'USD', stock_available: true, is_stale: false,
  }))).execute();
  await db.insertInto('ai_job_inputs').values(f.products.map(product => ({
    job_id: historyJob.id, input_id: product.id, content_version: product.content_version,
    fingerprint: product.content_fingerprint, payload: jsonb({ name: product.name }), status: 'succeeded' as const,
  }))).execute();
  await db.insertInto('ai_standardization_results').values(f.products.map(product => ({
    job_id: historyJob.id, input_id: product.id, product_id: product.id, content_version: product.content_version,
    fingerprint: product.content_fingerprint, status: 'classified' as const, standard_product_id: oldStandardId,
    reason: 'Historical assignment audit', decision: jsonb({ historical: true }),
  }))).execute();
  f.proposals = parseStandardizationProtocolResponse({
    items: f.raw.items.map(item => ({ ...item, standardProductId: null, nullReason: 'insufficient_source' })),
  }, f.inputs);
  const batch = await approve(f);
  await db.updateTable('products').set({ standardization_locked: true }).where('id', '=', productIds[1]!).execute();
  const manual = f.products[2]!;
  await db.transaction().execute(async tx => {
    await suppressManualDecisionTrigger(tx, [manual.id]);
    await tx.updateTable('standard_product_members').set({ assignment_source: 'human' }).where('product_id', '=', manual.id).execute();
    await tx.insertInto('product_standardization_decisions').values({
      product_id: manual.id, action: 'assign', standard_product_id: oldStandardId, previous_standard_product_id: oldStandardId,
      content_version: manual.content_version, content_fingerprint: manual.content_fingerprint,
      standardization_revision: manual.standardization_revision, evidence_known: true,
      evidence_snapshot: jsonb({ name: manual.name }), reason: 'Current manual assignment', source: 'application',
    }).execute();
  });
  const productsBefore = await db.selectFrom('products').selectAll().where('id', 'in', productIds).orderBy('id').execute();
  const offersBefore = await db.selectFrom('offers').selectAll().where('product_id', 'in', productIds).orderBy('id').execute();
  const membershipsBefore = await db.selectFrom('standard_product_members').selectAll().where('product_id', 'in', productIds).orderBy('product_id').execute();
  const historyBefore = await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', historyJob.id).orderBy('product_id').execute();
  const manualBefore = await db.selectFrom('product_standardization_decisions').selectAll().where('product_id', '=', manual.id).execute();
  const catalogBefore = await db.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow();
  await admin.query(`create function "${schema}".reject_unmatched_result() returns trigger language plpgsql as $$begin raise exception 'unmatched result unavailable'; end$$`);
  await admin.query(`create trigger reject_unmatched_result before insert on "${schema}".ai_standardization_results for each row execute function "${schema}".reject_unmatched_result()`);
  await claimBatch(batch.id);
  try {
    await assert.rejects(f.repo.publishBatch(batch.id, claim), /unmatched result unavailable/);
    assert.deepEqual(await db.selectFrom('standard_product_members').selectAll().where('product_id', 'in', productIds).orderBy('product_id').execute(), membershipsBefore);
    assert.deepEqual(await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', f.job.id).execute(), []);
  } finally {
    await admin.query(`drop trigger reject_unmatched_result on "${schema}".ai_standardization_results`);
    await admin.query(`drop function "${schema}".reject_unmatched_result()`);
  }
  await f.repo.publishBatch(batch.id, claim);
  const results = await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', f.job.id).orderBy('product_id').execute();
  assert.deepEqual(results.map(result => result.reason_code), ['insufficient_source', 'manual_decision_preserved', 'manual_decision_preserved']);
  assert.deepEqual(results.map(result => result.current_assignment_preserved), [false, true, true]);
  assert.deepEqual(results[0]!.evidence, f.raw.items[0]!.evidence);
  const pending = (await f.repo.listGlobalResults({ limit: 100 })).items.find(item => item.productId === String(productIds[0]));
  assert.equal(pending?.reasonCode, 'insufficient_source');
  assert.deepEqual(pending?.evidence, f.raw.items[0]!.evidence);
  assert.deepEqual(await db.selectFrom('standard_product_members').selectAll().where('product_id', 'in', productIds).orderBy('product_id').execute(), membershipsBefore.slice(1));
  assert.deepEqual(await db.selectFrom('products').selectAll().where('id', 'in', productIds).orderBy('id').execute(), productsBefore);
  assert.deepEqual(await db.selectFrom('offers').selectAll().where('product_id', 'in', productIds).orderBy('id').execute(), offersBefore);
  assert.deepEqual(await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', historyJob.id).orderBy('product_id').execute(), historyBefore);
  assert.deepEqual(await db.selectFrom('product_standardization_decisions').selectAll().where('product_id', '=', manual.id).execute(), manualBefore);
  assert.ok((await db.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow()).version > catalogBefore.version);
  await f.repo.publishBatch(batch.id, claim);
  assert.deepEqual(await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', f.job.id).orderBy('product_id').execute(), results);
});

test('review rejection of unmatched keeps the previous automatic assignment', async () => {
  const f = await fixture(['ChatGPT Plus']);
  await db.insertInto('standard_product_members').values({
    product_id: f.products[0]!.id, standard_product_id: f.standards[0]!.id, assignment_source: 'ai', publication_state: 'published',
  }).execute();
  f.proposals = parseStandardizationProtocolResponse({ items: f.raw.items.map(item => ({ ...item, standardProductId: null, nullReason: 'insufficient_source' })) }, f.inputs);
  await f.repo.persistBatchDecision(f.job.id, f.batch.id, f.proposals, metadata, claim);
  const batch = await reviewBatch(f);
  await claimBatch(batch.id);
  await f.repo.reserveBatchRequest(batch.id, claim);
  const request = await f.repo.getBatchRequest(batch.id);
  const rejected = parseStandardizationReviewResponse(JSON.stringify({
    items: [{ id: String(f.products[0]!.id), approved: false, code: 'supported_candidate', evidence: f.raw.items[0]!.evidence }],
  }), request.proposals!, request);
  await f.repo.persistBatchDecision(f.job.id, batch.id, rejected, metadata, claim);
  await claimBatch(batch.id);
  await f.repo.publishBatch(batch.id, claim);
  assert.equal((await db.selectFrom('standard_product_members').select('standard_product_id')
    .where('product_id', '=', f.products[0]!.id).executeTakeFirstOrThrow()).standard_product_id, f.standards[0]!.id);
  assert.deepEqual(await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', f.job.id).execute(), []);
  await rejectCorrection(f, batch.id);
  const result = await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', f.job.id).executeTakeFirstOrThrow();
  assert.equal(result.reason_code, 'review_rejected');
  assert.equal(result.current_assignment_preserved, true);
});

for (const matched of [false, true]) for (const protection of ['none', 'locked', 'current evidence'] as const) {
  test(`${matched ? 'matched' : 'insufficient_source'} publication handles unverified human membership with ${protection} protection without changing source revision or features`, async () => {
    const f = await fixture(['ChatGPT Plus']);
    const product = f.products[0]!;
    if (!matched) f.proposals = parseStandardizationProtocolResponse({
      items: f.raw.items.map(item => ({ ...item, standardProductId: null, nullReason: 'insufficient_source' })),
    }, f.inputs);
    const batch = await approve(f);
    await db.transaction().execute(async tx => {
      await suppressManualDecisionTrigger(tx, [product.id]);
      await tx.insertInto('standard_product_members').values({
        product_id: product.id, standard_product_id: f.standards[1]!.id, assignment_source: 'human', publication_state: 'published',
      }).execute();
      await tx.insertInto('product_standardization_decisions').values({
        product_id: product.id, action: 'assign', standard_product_id: f.standards[1]!.id, previous_standard_product_id: null,
        content_version: product.content_version, content_fingerprint: product.content_fingerprint,
        standardization_revision: product.standardization_revision, evidence_known: protection === 'current evidence',
        evidence_snapshot: protection === 'current evidence' ? jsonb({ name: product.name }) : null,
        reason: 'Previous human assignment', source: 'direct_sql',
      }).execute();
    });
    await db.updateTable('products').set({
      standardization_locked: protection === 'locked',
      membership_features: jsonb(buildMembershipFeatures([], await withMembershipSource(db, product), [], 'account') as unknown as JsonValue),
    }).where('id', '=', product.id).execute();
    const before = await db.selectFrom('products').selectAll().where('id', '=', product.id).executeTakeFirstOrThrow();
    const audit = await db.selectFrom('product_standardization_decisions').selectAll().where('product_id', '=', product.id).execute();
    assert.equal(readCurrentMembershipFeatures(before.membership_features, await withMembershipSource(db, before))?.decision.kind, 'account');
    await claimBatch(batch.id);
    await f.repo.publishBatch(batch.id, claim);
    const members = await db.selectFrom('standard_product_members').select(['standard_product_id', 'assignment_source']).where('product_id', '=', product.id).execute();
    assert.deepEqual(members, protection !== 'none'
      ? [{ standard_product_id: f.standards[1]!.id, assignment_source: 'human' }]
      : matched ? [{ standard_product_id: f.standards[0]!.id, assignment_source: 'ai' }] : []);
    const after = await db.selectFrom('products').selectAll().where('id', '=', product.id).executeTakeFirstOrThrow();
    assert.equal(after.standardization_revision, before.standardization_revision);
    assert.deepEqual(after.membership_features, before.membership_features);
    assert.equal(readCurrentMembershipFeatures(after.membership_features, await withMembershipSource(db, after))?.decision.kind, 'account');
    assert.deepEqual(await db.selectFrom('product_standardization_decisions').selectAll().where('product_id', '=', product.id).execute(), audit);
    const result = await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', f.job.id).executeTakeFirstOrThrow();
    assert.equal(result.reason_code, protection !== 'none' ? 'manual_decision_preserved' : matched ? null : 'insufficient_source');
    if (!matched && protection === 'none') {
      assert.equal((await f.repo.listGlobalResults({ limit: 100 })).items.find(item => item.productId === String(product.id))?.reasonCode, 'insufficient_source');
    }
  });
}

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

test('malformed item aborts the entire generation before review or partial publication', async () => {
  const f = await fixture();
  for (const invalid of [
    { id: String(f.products[1]!.id), evidence: f.raw.items[1]!.evidence },
    { id: String(f.products[1]!.id), standardProductId: null, nullReason: 'insufficient_source' },
    { ...f.raw.items[1], standardProductId: 91 },
  ]) {
    await assert.rejects(async () => {
      const decision = parseStandardizationProtocolResponse({ items: [f.raw.items[0], invalid] }, f.inputs);
      await f.repo.persistBatchDecision(f.job.id, f.batch.id, decision, metadata, claim);
    });
  }
  assert.deepEqual(await db.selectFrom('ai_job_batches').selectAll().where('job_id', '=', f.job.id).execute(), [f.batch]);
  assert.deepEqual(await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', f.job.id).execute(), []);
});

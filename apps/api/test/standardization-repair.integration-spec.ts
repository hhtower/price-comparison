import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';
import { AiRepository } from '../src/ai/ai.repository.js';
import { parseStandardizationProtocolResponse } from '../src/ai/ai.schemas.js';
import { parseStandardizationReviewResponse } from '../src/ai/standardization-review-request.js';
import { buildStandardizationRequest } from '../src/ai/standardization-request.js';
import { jsonb, type DatabaseSchema } from '../src/database/types.js';
import { seedMatchOnlyReviewFixture } from './standardization-review-fixture.js';
import { finalizeAiJob } from '../src/ai/standardization-finalizer.js';

let db: Kysely<DatabaseSchema>, admin: Pool, schema: string;
before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL required');
  schema = `standardization_repair_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
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
beforeEach(async () => {
  await db.updateTable('standard_products').set({ verification_state: 'quarantined' }).execute();
});

const claim = { workerId: 'repair-worker', attempt: 1n, token: 'repair-claim' };
async function claimBatch(id: bigint) {
  await db.updateTable('ai_job_batches').set({
    status: 'running', claimed_by: claim.workerId, attempts: claim.attempt, claim_token: claim.token,
    lease_until: new Date(Date.now() + 60000),
  }).where('id', '=', id).execute();
}
async function requestBatch(repo: AiRepository, id: bigint) {
  await claimBatch(id);
  await repo.prepareBatch(id);
  assert.equal(await repo.reserveBatchRequest(id, claim), 'reserved');
  return repo.getBatchRequest(id);
}
async function reviewChild(jobId: bigint, generationId: bigint) {
  return db.selectFrom('ai_job_batches').selectAll().where('job_id', '=', jobId)
    .where(sql<string>`reference_snapshot->>'proposalBatchId'`, '=', String(generationId)).executeTakeFirstOrThrow();
}
async function repairs(jobId: bigint) {
  return db.selectFrom('ai_job_batches').selectAll().where('job_id', '=', jobId)
    .where(sql<boolean>`reference_snapshot->>'repairReviewBatchId' is not null`)
    .where(sql<boolean>`reference_snapshot->>'reviewStage' is distinct from 'review'`).orderBy('id').execute();
}

test('a rejected identity supplements candidates, corrects once and publishes only after independent review', async () => {
  const f = await seedMatchOnlyReviewFixture(db, ['Claude Pro', 'ChatGPT Plus']);
  // The original snapshot missed Claude entirely and the generator chose ChatGPT.
  const original = { ...(f.batch.reference_snapshot as any), candidates: [f.candidates[0]],
    inputs: f.inputs.map(input => ({ ...input, candidateStandardProductIds: [String(f.standards[0]!.id)] })) };
  await db.updateTable('ai_job_batches').set({ reference_snapshot: jsonb(original) }).where('id', '=', f.batch.id).execute();
  const generated = parseStandardizationProtocolResponse({ items: f.raw.items.map(item => ({
    ...item, standardProductId: String(f.standards[0]!.id),
  })) }, original.inputs);
  await f.repo.persistBatchDecision(f.job.id, f.batch.id, generated, {}, f.claim);
  const firstReview = await reviewChild(f.job.id, f.batch.id);
  const request = await requestBatch(f.repo, firstReview.id);
  const feedback = parseStandardizationReviewResponse(JSON.stringify({ items: request.proposals!.items.map((item, i) => ({
    id: item.id, approved: i !== 0, code: i === 0 ? 'identity_mismatch' : null,
    evidence: i === 0 ? [{ path: 'name', quote: 'Claude Pro' }] : [],
  })) }), request.proposals!, request);
  await f.repo.persistBatchDecision(f.job.id, firstReview.id, feedback, {}, claim);
  const children = await repairs(f.job.id);
  assert.equal(children.length, 1, 'one repair generation must be enqueued');
  const repair = children[0]!;
  assert.equal(repair.request_budget_limit, 1);
  assert.deepEqual(repair.product_ids, [String(f.products[0]!.id)]);
  const pending = await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', f.job.id).execute();
  assert.equal(pending.length, 0);
  await claimBatch(firstReview.id);
  await f.repo.publishBatch(firstReview.id, claim);
  const published = await db.selectFrom('ai_standardization_results').select('product_id').where('job_id', '=', f.job.id).execute();
  assert.deepEqual(published.map(row => row.product_id), [f.products[1]!.id], 'unaffected inputs publish immediately');

  const restarted = new AiRepository(db);
  const correctionRequest = await requestBatch(restarted, repair.id);
  assert.equal(correctionRequest.stage, 'repair');
  assert.equal((repair.reference_snapshot as any).reviewStage, 'repair');
  assert.equal((repair.reference_snapshot as any).repairReviewBatchId, String(firstReview.id));
  assert.ok(correctionRequest.inputs[0]!.candidateStandardProductIds.includes(String(f.standards[1]!.id)));
  const body = JSON.parse(buildStandardizationRequest(correctionRequest).messages[1]!.content);
  assert.equal(body.feedback[0].review.code, 'identity_mismatch');
  assert.equal(body.feedback[0].proposal.standardProductId, String(f.standards[0]!.id));
  const corrected = parseStandardizationProtocolResponse({ items: [{
    id: String(f.products[0]!.id), standardProductId: String(f.standards[1]!.id), nullReason: null,
    evidence: [{ path: 'name', quote: 'Claude Pro' }],
  }] }, correctionRequest.inputs.map(input => ({ id: String(input.productId), candidateStandardProductIds: input.candidateStandardProductIds })));
  await restarted.persistBatchDecision(f.job.id, repair.id, corrected, {}, claim);
  const secondReview = await reviewChild(f.job.id, repair.id);
  assert.equal(secondReview.request_budget_limit, 1);
  assert.equal((secondReview.reference_snapshot as any).reviewStage, 'review');
  assert.equal((secondReview.reference_snapshot as any).proposalBatchId, String(repair.id));
  const recheck = await requestBatch(restarted, secondReview.id);
  const accepted = parseStandardizationReviewResponse(JSON.stringify({ items: [{
    id: corrected.items[0]!.id, approved: true, code: null, evidence: [],
  }] }), recheck.proposals!, recheck);
  await restarted.persistBatchDecision(f.job.id, secondReview.id, accepted, {}, claim);
  await claimBatch(secondReview.id);
  await restarted.publishBatch(secondReview.id, claim);
  const result = await db.selectFrom('ai_standardization_results').selectAll()
    .where('job_id', '=', f.job.id).where('product_id', '=', f.products[0]!.id).executeTakeFirstOrThrow();
  assert.equal(result.status, 'classified');
  assert.equal(result.standard_product_id, f.standards[1]!.id);
  assert.equal((await repairs(f.job.id)).length, 1);
  const audit = await db.selectFrom('ai_job_batches').select('validated_decision').where('id', '=', firstReview.id).executeTakeFirstOrThrow();
  assert.deepEqual(audit.validated_decision, feedback, 'first review stays intact');
  assert.equal((await db.selectFrom('ai_jobs').select('status').where('id', '=', f.job.id).executeTakeFirstOrThrow()).status, 'succeeded');
});

async function beginRepair(code = 'supported_candidate', publish = true) {
  const f = await seedMatchOnlyReviewFixture(db, ['ChatGPT Plus']);
  const proposed = parseStandardizationProtocolResponse({ items: f.raw.items.map(item => ({
    ...item, standardProductId: null, nullReason: 'insufficient_source',
  })) }, f.inputs);
  await f.repo.persistBatchDecision(f.job.id, f.batch.id, proposed, {}, f.claim);
  const review = await reviewChild(f.job.id, f.batch.id);
  const request = await requestBatch(f.repo, review.id);
  const decision = parseStandardizationReviewResponse(JSON.stringify({ items: [{
    id: proposed.items[0]!.id, approved: false, code, evidence: proposed.items[0]!.evidence,
  }] }), request.proposals!, request);
  await f.repo.persistBatchDecision(f.job.id, review.id, decision, {}, claim);
  if (publish) {
    await claimBatch(review.id);
    await f.repo.publishBatch(review.id, claim);
  }
  return { ...f, review, repair: (await repairs(f.job.id))[0] };
}

test('a second rejection stays unclassified and cannot create another correction round', async () => {
  const f = await beginRepair();
  assert.ok(f.repair);
  const request = await requestBatch(f.repo, f.repair.id);
  const corrected = parseStandardizationProtocolResponse(f.raw,
    request.inputs.map(input => ({ id: String(input.productId), candidateStandardProductIds: input.candidateStandardProductIds })));
  await f.repo.persistBatchDecision(f.job.id, f.repair.id, corrected, {}, claim);
  const second = await reviewChild(f.job.id, f.repair.id);
  const recheck = await requestBatch(f.repo, second.id);
  const rejected = parseStandardizationReviewResponse(JSON.stringify({ items: [{
    id: corrected.items[0]!.id, approved: false, code: 'identity_mismatch', evidence: corrected.items[0]!.evidence,
  }] }), recheck.proposals!, recheck);
  await f.repo.persistBatchDecision(f.job.id, second.id, rejected, {}, claim);
  await assert.rejects(f.repo.persistBatchDecision(f.job.id, second.id, rejected, {}, claim), /stale batch/);
  await claimBatch(second.id);
  await f.repo.publishBatch(second.id, claim);
  assert.equal((await repairs(f.job.id)).length, 1);
  assert.equal((await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', f.job.id).execute()).length, 4);
  const result = await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', f.job.id).executeTakeFirstOrThrow();
  assert.equal(result.reason_code, 'review_rejected');
  assert.equal(result.standard_product_id, null);
});

for (const code of ['source_conflict', 'insufficient_source']) {
  test(`${code} stops without spending correction requests`, async () => {
    const f = await beginRepair(code);
    assert.equal(f.repair, undefined);
    assert.equal((await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', f.job.id).execute()).length, 2);
    assert.equal((await db.selectFrom('ai_standardization_results').select('reason_code').where('job_id', '=', f.job.id).executeTakeFirstOrThrow()).reason_code, 'review_rejected');
  });
}

for (const change of ['stock', 'source', 'manual']) {
  test(`a ${change} change before correction skips the provider reservation`, async () => {
    const f = await beginRepair();
    assert.ok(f.repair);
    if (change === 'stock') await db.updateTable('offers').set({ stock_available: false }).where('product_id', '=', f.products[0]!.id).execute();
    if (change === 'source') await db.updateTable('products').set({ content_version: 2n }).where('id', '=', f.products[0]!.id).execute();
    if (change === 'manual') await db.updateTable('products').set({ standardization_locked: true }).where('id', '=', f.products[0]!.id).execute();
    await claimBatch(f.repair.id);
    assert.equal(await f.repo.reserveBatchRequest(f.repair.id, claim), 'skipped');
    const batch = await db.selectFrom('ai_job_batches').selectAll().where('id', '=', f.repair.id).executeTakeFirstOrThrow();
    assert.equal(batch.request_budget_used, 0);
    assert.equal(batch.step, 'done');
    const result = await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', f.job.id).executeTakeFirstOrThrow();
    assert.equal(result.standard_product_id, null);
  });
}

test('an uncertain correction request is terminal, retains its audit and never queues a re-review', async () => {
  const f = await beginRepair();
  assert.ok(f.repair);
  await requestBatch(f.repo, f.repair.id);
  await f.repo.recordBatchRequestOutcome(f.repair.id, 'unknown', undefined, claim);
  await db.updateTable('ai_job_batches').set({ status: 'failed', error_source: 'request_outcome_unknown' })
    .where('id', '=', f.repair.id).execute();
  await db.transaction().execute(tx => finalizeAiJob(tx, f.job.id));
  await db.transaction().execute(tx => finalizeAiJob(tx, f.job.id));
  assert.equal((await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', f.job.id).execute()).length, 3);
  const result = await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', f.job.id).executeTakeFirstOrThrow();
  assert.equal(result.reason_code, 'request_outcome_unknown');
  assert.equal(result.standard_product_id, null);
  assert.ok((await db.selectFrom('ai_job_batches').select('validated_decision').where('id', '=', f.review.id).executeTakeFirstOrThrow()).validated_decision);
});

test('a failed first-review publication cannot terminate inputs delegated to its active correction', async () => {
  const f = await beginRepair('supported_candidate', false);
  assert.ok(f.repair);
  await db.updateTable('ai_job_batches').set({ status: 'failed', error_source: 'local' })
    .where('id', '=', f.review.id).execute();
  await db.transaction().execute(tx => finalizeAiJob(tx, f.job.id));
  assert.deepEqual(await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', f.job.id).execute(), []);
  assert.equal((await db.selectFrom('ai_job_input_members').select('status').where('job_id', '=', f.job.id).executeTakeFirstOrThrow()).status, 'queued');
  await requestBatch(f.repo, f.repair.id);
});

test('a failed checkpoint rolls back correction enqueueing and request confirmation together', async () => {
  const f = await seedMatchOnlyReviewFixture(db, ['ChatGPT Plus']);
  await f.repo.persistBatchDecision(f.job.id, f.batch.id, f.proposals, {}, f.claim);
  const review = await reviewChild(f.job.id, f.batch.id);
  const request = await requestBatch(f.repo, review.id);
  const rejected = parseStandardizationReviewResponse(JSON.stringify({ items: [{
    id: String(f.products[0]!.id), approved: false, code: 'identity_mismatch', evidence: f.raw.items[0]!.evidence,
  }] }), request.proposals!, request);
  await admin.query(`create function "${schema}".reject_review_checkpoint() returns trigger language plpgsql as
    $$begin if new.step = 'publish' then raise exception 'checkpoint storage unavailable'; end if; return new; end$$`);
  await admin.query(`create trigger reject_review_checkpoint before update on "${schema}".ai_job_batches
    for each row execute function "${schema}".reject_review_checkpoint()`);
  try {
    await assert.rejects(f.repo.persistBatchDecision(f.job.id, review.id, rejected, {}, claim), /checkpoint storage unavailable/);
    assert.deepEqual(await repairs(f.job.id), []);
    const after = await db.selectFrom('ai_job_batches').select(['step', 'confirmed_requests', 'validated_decision'])
      .where('id', '=', review.id).executeTakeFirstOrThrow();
    assert.deepEqual(after, { step: 'request', confirmed_requests: 0, validated_decision: null });
  } finally {
    await admin.query(`drop trigger reject_review_checkpoint on "${schema}".ai_job_batches`);
    await admin.query(`drop function "${schema}".reject_review_checkpoint()`);
  }
});

test('approved candidate absence supplements only verified unmerged catalog definitions', async () => {
  const f = await seedMatchOnlyReviewFixture(db, ['Claude Pro']);
  const original = { ...(f.batch.reference_snapshot as any), candidates: [f.candidates[0]],
    inputs: f.inputs.map(input => ({ ...input, candidateStandardProductIds: [String(f.standards[0]!.id)] })) };
  await db.updateTable('ai_job_batches').set({ reference_snapshot: jsonb(original) }).where('id', '=', f.batch.id).execute();
  const hidden = await db.insertInto('standard_products').values([
    { name: 'Claude Pro quarantined', canonical_family: 'anthropic', canonical_product: 'claude', canonical_tier: 'quarantined',
      verification_state: 'quarantined', catalog_definition: 'Claude Pro subscriptions' },
    { name: 'Claude Pro merged', canonical_family: 'anthropic', canonical_product: 'claude', canonical_tier: 'merged',
      verification_state: 'verified', merged_into_id: f.standards[1]!.id, catalog_definition: 'Claude Pro subscriptions' },
  ]).returning('id').execute();
  const absent = parseStandardizationProtocolResponse({ items: f.raw.items.map(item => ({
    ...item, standardProductId: null, nullReason: 'candidate_unavailable',
  })) }, original.inputs);
  await f.repo.persistBatchDecision(f.job.id, f.batch.id, absent, {}, f.claim);
  const review = await reviewChild(f.job.id, f.batch.id);
  const request = await requestBatch(f.repo, review.id);
  const decision = parseStandardizationReviewResponse(JSON.stringify({ items: [{
    id: absent.items[0]!.id, approved: true, code: null, evidence: [],
  }] }), request.proposals!, request);
  await f.repo.persistBatchDecision(f.job.id, review.id, decision, {}, claim);
  const repair = (await repairs(f.job.id))[0]!;
  assert.ok(repair);
  const correction = await f.repo.getBatchRequest(repair.id);
  const allowed = correction.inputs[0]!.candidateStandardProductIds;
  assert.ok(allowed.includes(String(f.standards[1]!.id)));
  assert.ok(hidden.every(candidate => !allowed.includes(String(candidate.id))));
});

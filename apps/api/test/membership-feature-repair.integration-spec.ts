import { withMembershipSource } from './membership-fixture.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { migrateToLatest } from '../scripts/migrate.js';
import { AiRepository } from '../src/ai/ai.repository.js';
import { createOpenAiModelCall } from '../src/ai/ai.worker.js';
import { createMembershipFeatureJob } from '../src/ai/tag-extraction-jobs.js';
import { buildMembershipFeatureRequest, type MembershipFeatureReviewFeedback } from '../src/ai/membership-feature-request.js';
import type { TagExtractionDecision } from '../src/ai/tag-extraction-result.js';
import { estimateStandardizationRequest } from '../src/ai/standardization-request.js';
import { jsonb, type DatabaseSchema, type JsonValue } from '../src/database/types.js';
import type { ClaimedJob } from '../src/jobs/jobs.repository.js';
import { productContentFingerprint } from '../src/standardization/fingerprint.js';
import { readCurrentMembershipFeatures } from '../src/standardization/membership-classification.js';
import { seedUsableOffers } from './standardization-review-fixture.js';

let db: Kysely<DatabaseSchema>, admin: Pool;
const schema = `membership_repair_${randomUUID().replaceAll('-', '')}`;
const previous = { ...process.env };
const claim = { workerId: 'membership-repair-test', attempt: 1n, token: 'repair-claim' };

before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'Dedicated TEST_DATABASE_URL required');
  admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({
    connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public`,
  }) }) });
  Object.assign(process.env, { PG_SCHEMA: schema, CATALOG_VERSION_BUMP_MIN_INTERVAL_MS: '0' });
  await migrateToLatest(db);
});

after(async () => {
  await db?.destroy();
  if (admin) { await admin.query(`drop schema if exists "${schema}" cascade`); await admin.end(); }
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  Object.assign(process.env, previous);
});

async function fixture(count = 1) {
  const shop = await db.insertInto('shops').values({ name: 'feature repair', platform: 'test',
    url: `https://${randomUUID()}.invalid` }).returning('id').executeTakeFirstOrThrow();
  const standard = await db.insertInto('standard_products').values({
    name: 'ChatGPT Plus', canonical_family: 'openai', canonical_product: 'chatgpt', canonical_tier: 'plus',
    verification_state: 'verified',
  }).returning('id').executeTakeFirstOrThrow();
  const products: Array<{ id: bigint }> = [];
  for (let i = 0; i < count; i++) {
    const name = `ChatGPT Plus seller account ${i + 1}`;
    const spec = 'Seller provides the account. Subscription protected for 30 days.';
    const product = await db.insertInto('products').values({
      shop_id: shop.id, external_id: String(i + 1), name, spec, normalized_key: randomUUID(),
      url: `https://test.invalid/${i}`, source_data: jsonb({}), content_version: 1n,
      content_fingerprint: productContentFingerprint({ name, spec }),
    }).returningAll().executeTakeFirstOrThrow();
    products.push(product);
    await db.insertInto('standard_product_members').values({ product_id: product.id, standard_product_id: standard.id,
      assignment_source: 'ai', publication_state: 'published' }).execute();
  }
  await seedUsableOffers(db, products.map(product => product.id));
  const job = await db.transaction().execute(tx => createMembershipFeatureJob(tx, { model: 'mock', productIds: products.map(p => p.id) }));
  const repo = new AiRepository(db);
  const batches = () => db.selectFrom('ai_job_batches').selectAll().where('job_id', '=', job.id).orderBy('batch_index').execute();
  const batch = (await batches())[0]!;
  assert.equal((await batches()).length, 1);
  return { repo, job, products, standard, batches, batch };
}

async function claimBatch(id: bigint): Promise<ClaimedJob> {
  const batch = await db.updateTable('ai_job_batches').set({
    status: 'running', claimed_by: claim.workerId, attempts: claim.attempt, claim_token: claim.token,
    lease_until: new Date(Date.now() + 60_000),
  }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  return { kind: 'ai_batch', id, attempts: claim.attempt, claimed_by: claim.workerId,
    lease_until: batch.lease_until!, row: { ...batch, job_type: 'membership_features' } };
}

async function runStage(repo: AiRepository, id: bigint, output: unknown) {
  const claimed = await claimBatch(id);
  await repo.prepareBatch(id);
  assert.equal(await repo.reserveBatchRequest(id, claim), 'reserved');
  const call = createOpenAiModelCall(repo, {
    ...process.env, AI_BASE_URL: 'https://mock.invalid/v1', AI_API_KEY: 'mock-only', AI_MODEL: 'mock',
  }, async (_url, init) => {
    const sent = JSON.parse(String(init?.body));
    assert.equal(sent.stream, true);
    assert.equal(sent.model, 'mock');
    const content = JSON.stringify(output);
    return new Response([content.slice(0, 19), content.slice(19)].map((part, i) =>
      `data: ${JSON.stringify({ choices: [{ delta: { content: part }, ...(i ? { finish_reason: 'stop' } : {}) }] })}\n\n`
    ).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  const result = await call(claimed, new AbortController().signal);
  await repo.checkpointTagExtractionBatchDecision(BigInt(claimed.row.job_id as string), id,
    result.tagExtractionItems!, result.metadata, claim, result.reviewStage);
  return result;
}

const reference = (batch: { reference_snapshot: JsonValue }) => batch.reference_snapshot as Record<string, JsonValue>;
const rejected = (code: MembershipFeatureReviewFeedback['code']) => ({
  id: '1', classificationDecision: false, code, refs: [1],
});
const approved = { id: '1', classificationDecision: true, code: null, refs: [] };

async function beginReview(count = 1) {
  const f = await fixture(count);
  await runStage(f.repo, f.batch.id, { items: f.products.map((_p, i) => ({
    id: String(i + 1), membershipKind: 'short_term', refs: [0, 1],
  })) });
  const review = (await f.batches()).find(batch => reference(batch).reviewStage === 'review')!;
  assert.ok(review);
  return { ...f, review };
}

async function beginRepair(code: MembershipFeatureReviewFeedback['code'] = 'protection_mismatch') {
  const f = await beginReview();
  await runStage(f.repo, f.review.id, { items: [rejected(code)] });
  return { ...f, repair: (await f.batches()).find(batch => reference(batch).reviewStage === 'repair') };
}

async function publish(repo: AiRepository, id: bigint) {
  await claimBatch(id);
  await repo.publishTagExtractionBatch(id, claim);
}

for (const code of ['protection_mismatch', 'delivery_mismatch', 'evidence_mismatch'] as const) {
  test(`${code} corrects once from durable feedback and publishes only after independent review`, async () => {
    const f = await beginRepair(code);
    assert.ok(f.repair);
    assert.equal(f.repair.request_budget_limit, 1);
    assert.equal(reference(f.repair).repairReviewBatchId, String(f.review.id));
    assert.equal(reference(f.repair).reviewRepairRound, 1);
    const firstAudit = (await f.batches()).find(batch => batch.id === f.review.id)!.validated_decision;
    const checkpoint = firstAudit as unknown as { items: TagExtractionDecision[] };
    assert.deepEqual(checkpoint.items[0]!.membershipReview, { classificationDecision: false, code, refs: [1] });
    const restarted = new AiRepository(db);
    const input = await restarted.getTagExtractionBatchInputs(f.repair.id);
    assert.equal(input.stage, 'repair');
    assert.deepEqual(input.previousDecisions?.[0]?.membershipReview, { classificationDecision: false, code, refs: [1] });
    const payloads = input.inputs.map(row => ({ ...(row.payload as Record<string, JsonValue>),
      id: String(row.productId), name: row.name, spec: row.spec, sourceData: row.sourceData }));
    const built = buildMembershipFeatureRequest(payloads, 'mock', input.previousDecisions);
    assert.deepEqual(JSON.parse(built.messages[1]!.content).feedback, [{
      id: '1', proposal: { membershipKind: 'short_term', refs: [0, 1] },
      review: { classificationDecision: false, code, refs: [1] },
    }]);
    await runStage(restarted, f.repair.id, { items: [{ id: '1', membershipKind: 'account', refs: [1] }] });
    const repaired = (await f.batches()).find(batch => batch.id === f.repair!.id)!;
    assert.deepEqual(repaired.request_estimate, estimateStandardizationRequest(built));
    const review = (await f.batches()).find(batch => reference(batch).proposalBatchId === String(f.repair!.id))!;
    assert.equal(review.request_budget_limit, 1);
    assert.equal(reference(review).repairReviewBatchId, String(f.review.id));
    const recheck = await restarted.getTagExtractionBatchInputs(review.id);
    assert.deepEqual(recheck.proposals?.items, [{
      id: String(input.inputs[0]!.productId), membershipKind: 'account', refs: [1], tags: [],
    }]);
    await runStage(restarted, review.id, { items: [approved] });
    assert.equal((await db.selectFrom('products').select('membership_features')
      .where('id', '=', f.products[0]!.id).executeTakeFirstOrThrow()).membership_features, null);
    assert.equal((await db.selectFrom('ai_job_input_members').select('output')
      .where('job_id', '=', f.job.id).executeTakeFirstOrThrow()).output, null);
    await publish(restarted, review.id);
    const product = await db.selectFrom('products').selectAll().where('id', '=', f.products[0]!.id).executeTakeFirstOrThrow();
    assert.equal(readCurrentMembershipFeatures(product.membership_features, await withMembershipSource(db, product))?.decision.kind, 'account');
    const audit = await restarted.tagProductAudit(f.job.id, product.id);
    assert.deepEqual(audit.member.output.review, { mode: 'membership_binary', decision: true, code: null, refs: [] });
    assert.equal(audit.member.output.outcome, 'updated');
    const batches = await f.batches();
    assert.equal(batches.length, 4);
    assert.ok(batches.every(batch => batch.request_budget_used === 1 && batch.confirmed_requests === 1 && batch.unknown_requests === 0));
    assert.deepEqual(batches.find(batch => batch.id === f.review.id)!.validated_decision, firstAudit);
    assert.equal((await db.selectFrom('ai_jobs').select('status').where('id', '=', f.job.id).executeTakeFirstOrThrow()).status, 'succeeded');
    assert.deepEqual(await db.selectFrom('standard_product_members').select(['standard_product_id', 'publication_state'])
      .where('product_id', '=', product.id).executeTakeFirstOrThrow(),
    { standard_product_id: f.standard.id, publication_state: 'published' });
  });
}

test('a second repairable rejection stops using the shared reference even without a round marker', async () => {
  const f = await beginRepair();
  assert.ok(f.repair);
  await runStage(f.repo, f.repair.id, { items: [{ id: '1', membershipKind: 'account', refs: [1] }] });
  const review = (await f.batches()).find(batch => reference(batch).proposalBatchId === String(f.repair!.id))!;
  const saved = { ...reference(review) };
  delete saved.reviewRepairRound;
  await db.updateTable('ai_job_batches').set({ reference_snapshot: jsonb(saved) }).where('id', '=', review.id).execute();
  await runStage(f.repo, review.id, { items: [rejected('delivery_mismatch')] });
  await publish(f.repo, review.id);
  assert.equal((await f.batches()).length, 4);
  assert.equal((await f.batches()).filter(batch => reference(batch).reviewStage === 'repair').length, 1);
  const audit = await f.repo.tagProductAudit(f.job.id, f.products[0]!.id);
  assert.equal(audit.member.output.outcome, 'failed');
  assert.equal(audit.member.reason_code, 'classification_review_rejected');
  assert.deepEqual(audit.member.output.review, { mode: 'membership_binary', decision: false, code: 'delivery_mismatch', refs: [1] });
  assert.equal((await db.selectFrom('products').select('membership_features')
    .where('id', '=', f.products[0]!.id).executeTakeFirstOrThrow()).membership_features, null);
  assert.equal((await db.selectFrom('ai_jobs').select('status').where('id', '=', f.job.id).executeTakeFirstOrThrow()).status, 'ready_with_errors');
});

for (const code of ['insufficient_source', 'source_conflict'] as const) {
  test(`${code} ends without spending correction requests`, async () => {
    const f = await beginRepair(code);
    assert.equal(f.repair, undefined);
    await publish(f.repo, f.review.id);
    const batches = await f.batches();
    assert.equal(batches.length, 2);
    assert.deepEqual(batches.map(batch => batch.request_budget_used), [1, 1]);
    const audit = await f.repo.tagProductAudit(f.job.id, f.products[0]!.id);
    assert.equal(audit.member.output.outcome, 'failed');
    assert.deepEqual(audit.member.output.review, { mode: 'membership_binary', decision: false, code, refs: [1] });
    assert.equal((await db.selectFrom('products').select('membership_features')
      .where('id', '=', f.products[0]!.id).executeTakeFirstOrThrow()).membership_features, null);
  });
}

test('review checkpoint rejects changed proposals and legacy feedback atomically', async () => {
  const f = await beginReview();
  await claimBatch(f.review.id);
  await f.repo.prepareBatch(f.review.id);
  assert.equal(await f.repo.reserveBatchRequest(f.review.id, claim), 'reserved');
  const input = await f.repo.getTagExtractionBatchInputs(f.review.id);
  const decision: TagExtractionDecision = {
    productId: input.inputs[0]!.productId, tags: [], rejectedTags: [], membershipKind: 'short_term', membershipRefs: [0, 1],
    reviewed: true, classificationReviewed: true, membershipReview: { classificationDecision: true, code: null, refs: [] },
  };
  const before = await f.batches();
  for (const changed of [
    { ...decision, membershipKind: 'account' as const },
    { ...decision, membershipRefs: [1] },
    { ...decision, membershipReview: undefined },
    { ...decision, classificationReviewed: false },
    { ...decision, membershipReview: { classificationDecision: false, code: 'evidence_mismatch' as const, refs: [99] } },
  ]) {
    await assert.rejects(f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.review.id, [changed], {}, claim, 'review'));
    assert.deepEqual(await f.batches(), before);
  }
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.review.id, [decision], {}, claim, 'review');
  const saved = (await f.batches()).find(batch => batch.id === f.review.id)!;
  assert.equal(saved.confirmed_requests, 1);
  assert.equal(saved.step, 'publish');
});

test('correction requires a complete first review checkpoint and rejects nested repair parents', async () => {
  const f = await beginRepair();
  assert.ok(f.repair);
  const parent = (await f.batches()).find(batch => batch.id === f.review.id)!;
  const restore = {
    step: parent.step, status: parent.status, reference_snapshot: jsonb(parent.reference_snapshot),
    validated_decision: jsonb(parent.validated_decision),
  };
  const document = parent.validated_decision as unknown as { items: Array<{ productId: string }> };
  for (const changed of [
    { status: 'queued' as const },
    { step: 'request' as const },
    { reference_snapshot: jsonb({ ...reference(parent), reviewStage: 'generate' }) },
    { reference_snapshot: jsonb({ ...reference(parent), repairReviewBatchId: String(f.batch.id) }) },
    { validated_decision: jsonb({ items: [] }) },
    { validated_decision: jsonb({ items: [document.items[0]!, document.items[0]!] }) },
  ]) {
    await db.updateTable('ai_job_batches').set({ ...restore, ...changed }).where('id', '=', parent.id).execute();
    await assert.rejects(new AiRepository(db).getTagExtractionBatchInputs(f.repair.id), /checkpoint|feedback/i);
    const pending = (await f.batches()).find(batch => batch.id === f.repair!.id)!;
    assert.equal(pending.request_budget_used, 0);
    assert.equal(pending.validated_decision, null);
  }
  await db.updateTable('ai_job_batches').set(restore).where('id', '=', parent.id).execute();
  assert.equal((await f.repo.getTagExtractionBatchInputs(f.repair.id)).previousDecisions?.length, 1);
});

test('mixed review publishes unaffected inputs while only rejected inputs enter correction', async () => {
  const f = await beginReview(2);
  await runStage(f.repo, f.review.id, { items: [{ ...approved, id: '2' }, rejected('protection_mismatch')] });
  const batches = await f.batches();
  const repair = batches.find(batch => reference(batch).reviewStage === 'repair')!;
  const ready = batches.find(batch => batch.step === 'publish')!;
  assert.ok(repair);
  assert.ok(ready);
  const members = await db.selectFrom('ai_job_input_members').select(['product_id', 'input_id'])
    .where('job_id', '=', f.job.id).orderBy('product_id').execute();
  assert.deepEqual(repair.product_ids, [String(members[0]!.input_id)]);
  assert.deepEqual(ready.product_ids, [String(members[1]!.input_id)]);
  await publish(f.repo, ready.id);
  const results = await db.selectFrom('ai_job_input_members').select(['output', 'status'])
    .where('job_id', '=', f.job.id).orderBy('product_id').execute();
  assert.equal(results[0]!.output, null);
  assert.equal(results[1]!.status, 'classified');
  await runStage(f.repo, repair.id, { items: [{ id: '1', membershipKind: 'account', refs: [1] }] });
  const recheck = (await f.batches()).find(batch => reference(batch).proposalBatchId === String(repair.id))!;
  await runStage(f.repo, recheck.id, { items: [approved] });
  await publish(f.repo, recheck.id);
  assert.equal((await f.batches()).length, 5);
  assert.equal((await db.selectFrom('ai_jobs').select('status').where('id', '=', f.job.id).executeTakeFirstOrThrow()).status, 'succeeded');
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';
import { AiRepository } from '../src/ai/ai.repository.js';
import { createTagJob, createProductTextReviewJob } from '../src/ai/tag-extraction-jobs.js';
import { finalizeOrScheduleMissing } from '../src/ai/standardization-finalizer.js';
import { jsonb, type DatabaseSchema } from '../src/database/types.js';
import { productContentFingerprint } from '../src/standardization/fingerprint.js';
import { mergeTagExtractionDecision, type TagExtractionDecision } from '../src/ai/tag-extraction-result.js';
import { CONSISTENCY_KEYS, DISCLOSURE_KEYS, type TextReview } from '../src/shops/shop-text-review.js';

let db: Kysely<DatabaseSchema>, admin: Pool;
const schema = `tag_partial_${randomUUID().replaceAll('-', '')}`;
before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required');
  admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({
    connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public`,
  }) }) });
  const result = await new Migrator({ db, provider: migrationProvider, migrationTableSchema: schema }).migrateToLatest();
  assert.ifError(result.error);
});
after(async () => {
  await db?.destroy();
  await admin?.query(`drop schema if exists "${schema}" cascade`);
  await admin?.end();
});

const candidate = (name: string, value: string | number, proposalIndex: number) => ({
  name, value, proposalIndex, evidence: [],
});
const refusedWarranty = () => ({
  ...candidate('warranty', '质保30天', 1), reasonCode: 'review_rejected', reason: '标签复核未通过',
});
async function fixture(kind: 'tag_extraction' | 'text_review' = 'tag_extraction') {
  const shop = await db.insertInto('shops').values({
    name: 'Partial test', platform: 'test', url: `https://partial.invalid/${randomUUID()}`,
  }).returning('id').executeTakeFirstOrThrow();
  const evidence = { name: 'Monthly account', spec: '1个月', sourceData: {
    evidence: '仅保首登，封号不保',
    ...(kind === 'text_review' ? { ratingText: {
      unitId: 'partial-listing', name: 'Monthly account', description: '仅保首登，封号不保', hash: 'b'.repeat(64),
    } } : {}),
  } };
  const product = await db.insertInto('products').values({
    shop_id: shop.id, external_id: 'partial', name: evidence.name, spec: evidence.spec,
    source_data: jsonb(evidence.sourceData), content_fingerprint: productContentFingerprint(evidence),
    normalized_key: 'partial', url: 'https://partial.invalid/product',
  }).returningAll().executeTakeFirstOrThrow();
  const standard = await db.insertInto('standard_products').values({
    name: 'Monthly plan', canonical_family: 'openai', canonical_product: 'chatgpt', canonical_tier: 'plus',
    verification_state: 'verified',
  }).returning('id').executeTakeFirstOrThrow();
  await db.insertInto('standard_product_members').values({
    product_id: product.id, standard_product_id: standard.id, assignment_source: 'ai', publication_state: 'published',
  }).execute();
  await db.insertInto('product_tags').values([
    { product_id: product.id, name: 'duration', value: jsonb(7) },
    { product_id: product.id, name: 'warranty', value: jsonb('仅保首登，封号不保') },
  ]).execute();
  const job = await db.transaction().execute(tx => (kind === 'text_review' ? createProductTextReviewJob : createTagJob)(
    tx, { model: 'mock', productIds: [product.id] }));
  const repo = new AiRepository(db);
  const next = () => db.selectFrom('ai_job_batches').selectAll().where('job_id', '=', job.id)
    .where('status', '=', 'queued').orderBy('batch_index').executeTakeFirstOrThrow();
  const claim = async (batchId: bigint) => {
    const token = randomUUID();
    await db.updateTable('ai_jobs').set({ status: 'running' }).where('id', '=', job.id).execute();
    await db.updateTable('ai_job_batches').set({
      status: 'running', attempts: 1n, claimed_by: 'partial-worker', claim_token: token,
      lease_until: new Date(Date.now() + 60_000), request_budget_used: 1, confirmed_requests: 0,
    }).where('id', '=', batchId).execute();
    return { workerId: 'partial-worker', token, attempt: 1n };
  };
  const extraction: TagExtractionDecision = {
    productId: product.id, tags: [candidate('duration', 30, 0), candidate('warranty', '质保30天', 1)], rejectedTags: [],
  };
  const review = {
    productId: product.id, tags: [candidate('duration', 30, 0)], rejectedTags: [refusedWarranty()],
    reviewed: true, reviewDecisions: [true, false], complete: true,
  };
  const firstReview = async () => {
    const batch = await next();
    const lease = await claim(batch.id);
    await repo.prepareBatch(batch.id);
    await repo.checkpointTagExtractionBatchDecision(job.id, batch.id, [extraction], {}, lease, 'extract');
    const reviewing = await next();
    await repo.checkpointTagExtractionBatchDecision(job.id, reviewing.id, [review], {}, await claim(reviewing.id), 'review');
    return reviewing.id;
  };
  const stored = () => db.selectFrom('product_tags').select(['name', 'value'])
    .where('product_id', '=', product.id).orderBy('name').execute();
  return { product, job, repo, next, claim, extraction, review, firstReview, stored };
}

test('a failed candidate schedules one repair and retains successful decisions in its context', async () => {
  const f = await fixture();
  await f.firstReview();
  const repair = await f.next();
  assert.equal((repair.reference_snapshot as any).tagStage, 'repair');
  const input = await f.repo.getTagExtractionBatchInputs(repair.id);
  assert.equal(input.stage, 'repair');
  assert.deepEqual(input.previousDecisions?.[0]?.tags.map(tag => [tag.name, tag.value]), [['duration', 30]]);
  assert.deepEqual(await f.stored(), [
    { name: 'duration', value: 7 }, { name: 'warranty', value: '仅保首登，封号不保' },
  ]);
});

test('the final review publishes partial success without deleting a failed dimension', async () => {
  const f = await fixture();
  await f.firstReview();
  const repair = await f.next();
  const repaired: TagExtractionDecision = {
    productId: f.product.id, tags: [candidate('warranty', '质保30天', 0)], rejectedTags: [],
  };
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, repair.id, [repaired], {}, await f.claim(repair.id), 'repair');
  const review = await f.next();
  const merged = mergeTagExtractionDecision(f.review, {
    productId: f.product.id, tags: [], rejectedTags: [{ ...refusedWarranty(), proposalIndex: 0 }],
    reviewed: true, reviewDecisions: [false], complete: true,
  });
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, review.id, [merged], {}, await f.claim(review.id), 'review');
  const publication = await f.next();
  assert.equal(publication.step, 'publish');
  await f.repo.publishTagExtractionBatch(publication.id, await f.claim(publication.id));
  assert.deepEqual(await f.stored(), [
    { name: 'duration', value: 30 }, { name: 'warranty', value: '仅保首登，封号不保' },
  ]);
  const member = await db.selectFrom('ai_job_input_members').selectAll().where('job_id', '=', f.job.id).executeTakeFirstOrThrow();
  assert.equal((member.output as any).outcome, 'partial_success');
  assert.equal((member.output as any).successfulCount, 1);
  assert.equal((member.output as any).failedCount, 1);
  const audit = await f.repo.tagProductAudit(f.job.id, f.product.id);
  const reviewAudit = audit.batches.find((batch: any) => batch.id === String(review.id));
  assert.deepEqual(reviewAudit.review_decisions, [false]);
  assert.deepEqual((member.output as any).attempts.map((attempt: any) => attempt.reviewDecisions), [[true, false], [false]]);
  assert.equal((await db.selectFrom('ai_jobs').select('status').where('id', '=', f.job.id).executeTakeFirstOrThrow()).status, 'ready_with_errors');
  assert.equal((await db.selectFrom('ai_job_batches').select(sql<number>`count(*)::int`.as('count'))
    .where('job_id', '=', f.job.id).executeTakeFirstOrThrow()).count, 4);
});

test('a terminal repair error still publishes earlier approved tags through a publication checkpoint', async () => {
  const f = await fixture();
  await f.firstReview();
  const repair = await f.next();
  await db.updateTable('ai_job_batches').set({
    status: 'failed', error_source: 'provider_terminal', error: 'mock terminal failure',
  }).where('id', '=', repair.id).execute();
  await db.transaction().execute(tx => finalizeOrScheduleMissing(tx, f.job.id));
  const publication = await f.next();
  assert.equal(publication.step, 'publish');
  await f.repo.publishTagExtractionBatch(publication.id, await f.claim(publication.id));
  assert.deepEqual(await f.stored(), [
    { name: 'duration', value: 30 }, { name: 'warranty', value: '仅保首登，封号不保' },
  ]);
  const member = await db.selectFrom('ai_job_input_members').select('output').where('job_id', '=', f.job.id).executeTakeFirstOrThrow();
  assert.equal((member.output as any).outcome, 'partial_success');
});

test('a verified complete empty result clears old tags without a repair', async () => {
  const f = await fixture();
  const extraction = await f.next();
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, extraction.id,
    [{ productId: f.product.id, tags: [], rejectedTags: [] }], {}, await f.claim(extraction.id), 'extract');
  const review = await f.next();
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, review.id,
    [{ productId: f.product.id, tags: [], rejectedTags: [], reviewed: true, reviewDecisions: [], complete: true }],
    {}, await f.claim(review.id), 'review');
  const publication = await f.next();
  await f.repo.publishTagExtractionBatch(publication.id, await f.claim(publication.id));
  assert.deepEqual(await f.stored(), []);
});

test('reviewed tags without the frozen shop source cannot be published', async () => {
  const f = await fixture();
  const before = await f.stored();
  const extraction = await f.next();
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, extraction.id,
    [{ productId: f.product.id, tags: [candidate('duration', 30, 0)], rejectedTags: [] }],
    {}, await f.claim(extraction.id), 'extract');
  const review = await f.next();
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, review.id,
    [{ productId: f.product.id, tags: [candidate('duration', 30, 0)], rejectedTags: [],
      reviewed: true, reviewDecisions: [true], complete: true }], {}, await f.claim(review.id), 'review');
  await db.updateTable('ai_job_input_members').set({ payload: sql`payload - 'shopSource'` })
    .where('job_id', '=', f.job.id).execute();
  const publication = await f.next();
  await f.repo.publishTagExtractionBatch(publication.id, await f.claim(publication.id));
  assert.deepEqual(await f.stored(), before);
  const member = await db.selectFrom('ai_job_input_members').select('output')
    .where('job_id', '=', f.job.id).executeTakeFirstOrThrow();
  assert.equal((member.output as any).outcome, 'skipped');
  assert.equal((member.output as any).reasonCode, 'source_changed');
});

test('partial publication preserves every existing fact exactly beyond the audit size limit', async () => {
  const f = await fixture();
  const oldClients = Array.from({ length: 200 }, (_, index) => ({
    name: 'supported_client', value: index === 0 ? 'https://client.invalid/?mode=web' : `old-client-${index}`,
  }));
  await db.insertInto('product_tags').values(oldClients.map(tag => ({
    product_id: f.product.id, name: tag.name, value: jsonb(tag.value),
  }))).execute();
  const newClients = Array.from({ length: 100 }, (_, index) => candidate('supported_client', `new-client-${index}`, index));
  const batch = await f.next();
  await db.updateTable('ai_job_batches').set({
    reference_snapshot: jsonb({ tagStage: 'review', tagRepairRound: 1 }),
  }).where('id', '=', batch.id).execute();
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, batch.id,
    [{ productId: f.product.id, tags: newClients, rejectedTags: [], reviewed: true, complete: false,
      reviewDecisions: newClients.map(() => true) }], {}, await f.claim(batch.id), 'review');
  await f.repo.publishTagExtractionBatch(batch.id, await f.claim(batch.id));
  const stored = await f.stored();
  assert.equal(stored.length, 302);
  for (const tag of oldClients) assert.ok(stored.some(saved => saved.name === tag.name && saved.value === tag.value));
  const member = await db.selectFrom('ai_job_input_members').select('output').where('job_id', '=', f.job.id).executeTakeFirstOrThrow();
  assert.equal((member.output as any).outcome, 'partial_success');
  assert.equal((member.output as any).after.length, 256);
});

test('text review publishes independently in one request and leaves product labels unchanged', async () => {
  const f = await fixture('text_review');
  const before = await f.stored();
  const batch = await f.next();
  const lease = await f.claim(batch.id);
  await f.repo.prepareBatch(batch.id);
  const textReview = {
    answers: Object.fromEntries(DISCLOSURE_KEYS.map(key => [key, false])),
    consistency: Object.fromEntries(CONSISTENCY_KEYS.map(key => [key, false])),
  } as TextReview;
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, batch.id,
    [{ productId: f.product.id, tags: [], rejectedTags: [], textReview }], {}, lease, 'extract');
  const publication = await f.next();
  assert.equal(publication.id, batch.id);
  assert.equal(publication.step, 'publish');
  await f.repo.publishTagExtractionBatch(publication.id, await f.claim(publication.id));
  assert.deepEqual(await f.stored(), before);
  const product = await db.selectFrom('products').select('text_review').where('id', '=', f.product.id).executeTakeFirstOrThrow();
  assert.deepEqual((product.text_review as any).review, textReview);
  await assert.rejects(db.transaction().execute(tx => createProductTextReviewJob(tx, {
    model: 'mock', productIds: [f.product.id],
  })), (error: any) => error.code === 'AI_TAG_SCOPE_EMPTY');
});

test('cancelled repair publication cannot write even previously approved tags', async () => {
  const f = await fixture();
  await f.firstReview();
  const repair = await f.next();
  await f.repo.cancelJob(f.job.id);
  await assert.rejects(f.repo.checkpointTagExtractionBatchDecision(f.job.id, repair.id,
    [{ productId: f.product.id, tags: [], rejectedTags: [] }], {}, await f.claim(repair.id), 'repair'), /cannot checkpoint/u);
  assert.deepEqual(await f.stored(), [
    { name: 'duration', value: 7 }, { name: 'warranty', value: '仅保首登，封号不保' },
  ]);
});

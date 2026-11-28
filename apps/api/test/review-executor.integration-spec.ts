import { jsonObject } from './json-object.js';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Kysely, PostgresDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';
import { executeReviewCheckpoint } from '../src/ai/review-executor.js';
import { jsonb, type DatabaseSchema, type JsonValue } from '../src/database/types.js';
import { seedMatchOnlyReviewFixture } from './standardization-review-fixture.js';
import { planPublicationUnits } from '../src/ai/publication-planner.js';

let db: Kysely<DatabaseSchema>, admin: Pool, schema: string;
before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  schema = `review_executor_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
  admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({
    connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public`, max: 4,
  }) }) });
  const migration = await new Migrator({ db, provider: migrationProvider, migrationTableSchema: schema }).migrateToLatest();
  assert.ifError(migration.error);
});
after(async () => {
  await db?.destroy();
  if (schema) await admin.query(`drop schema "${schema}" cascade`);
  await admin?.end();
});

async function fixture() {
  const f = await seedMatchOnlyReviewFixture(db);
  const document = f.proposals as unknown as JsonValue;
  const input = { jobId: f.job.id, batchId: f.batch.id, claim: f.claim, stage: 'generate' as const,
    inputIds: f.products.map(product => product.id), metadata: { usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 } } };
  return { ...f, document, input };
}

test('the executor confirms, saves and queues the independent review atomically', async () => {
  const f = await fixture();
  await executeReviewCheckpoint(db, { ...f.input, plan: async () => ({
    document: f.document, next: [{ stage: 'review', inputIds: f.input.inputIds }],
  }) });
  const rows = await db.selectFrom('ai_job_batches').selectAll().where('job_id', '=', f.job.id).orderBy('id').execute();
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.confirmed_requests, 1);
  assert.equal(rows[0]!.step, 'done');
  assert.deepEqual(rows[0]!.validated_decision, f.document);
  assert.equal(jsonObject(rows[0]!.response_usage).totalTokens, 8);
  assert.equal(rows[1]!.step, 'request');
  assert.equal(rows[1]!.request_budget_limit, 2);
  assert.deepEqual(rows[1]!.product_ids, f.input.inputIds.map(String));
  assert.equal((rows[1]!.reference_snapshot as any).reviewStage, 'review');
  assert.equal((rows[1]!.reference_snapshot as any).proposalBatchId, String(f.batch.id));
  await assert.rejects(executeReviewCheckpoint(db, { ...f.input, plan: async () => ({
    document: f.document, next: [{ stage: 'review', inputIds: f.input.inputIds }],
  }) }), /stale batch/);
});

test('missing, duplicated or prematurely published inputs cannot commit any part of a checkpoint', async () => {
  for (const mode of ['missing', 'duplicate', 'publish', 'repair-before-review'] as const) {
    const f = await fixture();
    await assert.rejects(executeReviewCheckpoint(db, { ...f.input, plan: async () => ({
      document: f.document,
      next: mode === 'publish' ? [] : [{
        stage: mode === 'repair-before-review' ? 'repair' : 'review',
        inputIds: mode === 'missing' ? f.input.inputIds.slice(0, 1)
          : mode === 'duplicate' ? [...f.input.inputIds, f.input.inputIds[0]!] : f.input.inputIds,
      }],
      ...(mode === 'publish' ? { publication: { inputIds: f.input.inputIds } } : {}),
    }) }));
    const rows = await db.selectFrom('ai_job_batches').selectAll().where('job_id', '=', f.job.id).execute();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.confirmed_requests, 0);
    assert.equal(rows[0]!.validated_decision, null);
  }
});

test('a failed child insert rolls back the request confirmation and saved response', async () => {
  const f = await fixture();
  await admin.query(`create function "${schema}".reject_review_child() returns trigger language plpgsql as
    $$begin raise exception 'child insertion failed'; end$$`);
  await admin.query(`create trigger reject_review_child before insert on "${schema}".ai_job_batches
    for each row execute function "${schema}".reject_review_child()`);
  try {
    await assert.rejects(executeReviewCheckpoint(db, { ...f.input, plan: async () => ({
      document: f.document, next: [{ stage: 'review', inputIds: f.input.inputIds }],
    }) }), /child insertion failed/);
    const saved = await db.selectFrom('ai_job_batches').selectAll().where('id', '=', f.batch.id).executeTakeFirstOrThrow();
    assert.equal(saved.confirmed_requests, 0);
    assert.equal(saved.validated_decision, null);
  } finally {
    await admin.query(`drop trigger reject_review_child on "${schema}".ai_job_batches`);
    await admin.query(`drop function "${schema}".reject_review_child()`);
  }
});

test('business reference fields cannot replace executor-owned stage lineage', async () => {
  const f = await fixture();
  await executeReviewCheckpoint(db, { ...f.input, plan: async () => ({
    document: f.document, next: [{ stage: 'review', inputIds: f.input.inputIds,
      reference: { reviewStage: 'repair', proposalBatchId: '999', repairReviewBatchId: '999', reviewRepairRound: 1 },
    }],
  }) });
  const next = await db.selectFrom('ai_job_batches').selectAll().where('job_id', '=', f.job.id).where('id', '!=', f.batch.id).executeTakeFirstOrThrow();
  const reference = next.reference_snapshot as Record<string, JsonValue>;
  assert.equal(reference.reviewStage, 'review');
  assert.equal(reference.proposalBatchId, String(f.batch.id));
  assert.equal(reference.repairReviewBatchId, undefined);
  assert.equal(reference.reviewRepairRound, undefined);
  assert.equal(next.request_budget_limit, 2);
});

test('publication units cannot publish another input while claiming complete coverage', async () => {
  const f = await fixture();
  const other = await fixture();
  await db.updateTable('ai_job_batches').set({ reference_snapshot: jsonb({
    ...(f.batch.reference_snapshot as Record<string, JsonValue>), reviewStage: 'review',
  }) }).where('id', '=', f.batch.id).execute();
  const plan = planPublicationUnits([{ productId: other.products[0]!.id, inputId: other.products[0]!.id, tags: [], payload: {} }]);
  await assert.rejects(executeReviewCheckpoint(db, { ...f.input, stage: 'review', plan: async () => ({
    document: f.document, next: [], publication: { inputIds: f.input.inputIds, plan },
  }) }), /publication scope/);
  const saved = await db.selectFrom('ai_job_batches').selectAll().where('id', '=', f.batch.id).executeTakeFirstOrThrow();
  assert.equal(saved.confirmed_requests, 0);
  assert.equal(saved.validated_decision, null);
});

test('a completed repair cannot enqueue another repair and retains its single-request review budget', async () => {
  const f = await fixture();
  await db.updateTable('ai_job_batches').set({ reference_snapshot: jsonb({
    ...(f.batch.reference_snapshot as Record<string, JsonValue>),
    reviewStage: 'repair', repairReviewBatchId: '9', reviewRepairRound: 1,
  }) }).where('id', '=', f.batch.id).execute();
  await executeReviewCheckpoint(db, { ...f.input, stage: 'repair', plan: async () => ({
    document: f.document, next: [{ stage: 'review', inputIds: f.input.inputIds }],
  }) });
  const review = await db.selectFrom('ai_job_batches').selectAll().where('job_id', '=', f.job.id).where('id', '!=', f.batch.id).executeTakeFirstOrThrow();
  assert.equal(review.request_budget_limit, 1);
  await db.updateTable('ai_job_batches').set({ status: 'running', attempts: 1n, claimed_by: f.claim.workerId,
    claim_token: f.claim.token, lease_until: new Date(Date.now() + 60_000), request_budget_used: 1,
  }).where('id', '=', review.id).execute();
  await assert.rejects(executeReviewCheckpoint(db, { ...f.input, batchId: review.id, stage: 'review', plan: async () => ({
    document: f.document, next: [{ stage: 'repair', inputIds: f.input.inputIds }],
  }) }), /repair/);
});

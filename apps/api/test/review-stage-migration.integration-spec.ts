import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';
import { down, up } from '../src/database/migrations/050_review_stage_contract_20261123.js';

type Snapshot = Record<string, unknown>;
const schema = `review_stage_${randomUUID().replaceAll('-', '')}`;
let admin: Pool;
let pool: Pool;
let database: Kysely<unknown>;

before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required');
  admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema},public -c statement_timeout=5000`,
  });
  database = new Kysely({ dialect: new PostgresDialect({ pool }) });
  const result = await new Migrator({
    db: database, provider: migrationProvider, migrationTableSchema: schema,
  }).migrateTo('049_official_membership_prices_20261121');
  if (result.error) throw result.error;
});

after(async () => {
  await database?.destroy();
  if (admin) {
    await admin.query(`drop schema if exists "${schema}" cascade`);
    await admin.end();
  }
});

beforeEach(async () => {
  await pool.query('delete from ai_jobs');
});

const evidence = {
  strategyVersion: 'approved-candidate-20261119-v1',
  catalogVersion: '17',
  inputs: [{ id: '7', candidateStandardProductIds: ['23'], stats: { scanned: 3, compared: 1, truncated: false } }],
  candidates: [{ id: '23', name: 'original candidate', evidence: { tagStage: 'extract', generationBatchId: 'nested evidence' } }],
};

async function seed(jobType: string, reference: Snapshot | null, status = 'queued', lease: string | null = null) {
  const job = (await pool.query(`insert into ai_jobs
    (status, total, processed, applied, model, job_type, pipeline_versions, input_bytes, estimated_tokens)
    values ('running', 5, 2, 1, 'migration-only-no-model', $1, '{"reviewWorkflow":"original-version"}', 987, 123)
    returning id`, [jobType])).rows[0];
  const batch = (await pool.query(`insert into ai_job_batches
    (job_id, batch_index, product_ids, product_count, status, reference_snapshot, lease_until,
     attempts, claimed_by, claim_token, step, round, reference_version,
     request_budget_limit, request_budget_used, confirmed_requests, unknown_requests,
     validated_decision, decision_hash, publication_plan, publication_cursor,
     request_estimate, response_usage, response_model, response_id, response_ms, response_diagnostic,
     error, error_source, input_bytes, estimated_tokens, decision_saved_at)
    values ($1, 0, '["7"]', 1, $2, $3::jsonb, $4::timestamptz,
     3, 'original-worker', 'original-token', 'publish', 1, 17,
     2, 2, 1, 1, '{"items":[{"id":"7","reason":"original decision"}]}', 'original-hash',
     '{"units":[{"id":"7"}]}', 1, '{"inputBytes":987}', '{"totalTokens":123}',
     'original-model', 'original-response', 27, '{"body":"original audit"}',
     'original error', 'original source', 987, 123, '2026-11-22T00:00:00Z')
    returning id`, [job.id, status, reference === null ? null : JSON.stringify(reference), lease])).rows[0];
  await pool.query(`insert into ai_job_inputs (job_id, input_id, fingerprint, payload, status)
    values ($1, 7, 'original-fingerprint', '{"name":"original body","description":"unchanged text"}', 'succeeded')`, [job.id]);
  return batch.id as string;
}

async function rows() {
  const [jobs, batches, inputs] = await Promise.all([
    pool.query('select * from ai_jobs order by id'),
    pool.query('select *, xmin::text as row_version from ai_job_batches order by id'),
    pool.query('select * from ai_job_inputs order by job_id, input_id'),
  ]);
  return { jobs: jobs.rows, batches: batches.rows, inputs: inputs.rows };
}

function withoutSnapshot(state: Awaited<ReturnType<typeof rows>>) {
  return {
    ...state,
    batches: state.batches.map(({ reference_snapshot, row_version, ...batch }) => batch),
  };
}

const cases: Array<{ name: string; type: string; old: Snapshot; next: Snapshot; restored?: Snapshot }> = [];
for (const type of ['tag_extraction', 'membership_features']) {
  for (const [old, next] of [
    [{ tagStage: 'extract' }, { reviewStage: 'generate' }],
    [{ tagStage: 'review', extractionBatchId: '101' }, { reviewStage: 'review', proposalBatchId: '101' }],
    [{ tagStage: 'repair', repairReviewBatchId: '102', reviewRepairRound: 1 }, { reviewStage: 'repair', repairReviewBatchId: '102', reviewRepairRound: 1 }],
    [{ tagStage: 'review', extractionBatchId: '103', repairReviewBatchId: '102', reviewRepairRound: 1 }, { reviewStage: 'review', proposalBatchId: '103', repairReviewBatchId: '102', reviewRepairRound: 1 }],
  ]) cases.push({ name: `${type} ${old.tagStage} ${old.extractionBatchId ?? ''}`.trim(), type, old, next });
}
cases.push(
  { name: 'tag warranty', type: 'tag_extraction', old: { tagStage: 'warranty' }, next: { reviewStage: 'warranty' } },
  { name: 'tag warranty lineage', type: 'tag_extraction', old: { tagStage: 'extract', warrantyBatchId: '99' }, next: { reviewStage: 'generate', warrantyBatchId: '99' } },
  { name: 'membership implicit generation', type: 'membership_features', old: {}, next: { reviewStage: 'generate' }, restored: { tagStage: 'extract' } },
  { name: 'text single request', type: 'text_review', old: {}, next: { reviewStage: 'generate' }, restored: { tagStage: 'extract' } },
  { name: 'identity repair without a round', type: 'incremental', old: { repairReviewBatchId: '202' }, next: { reviewStage: 'repair', repairReviewBatchId: '202' } },
  { name: 'identity round alone does not imply repair', type: 'incremental', old: { reviewRepairRound: 1 }, next: { reviewStage: 'generate', reviewRepairRound: 1 } },
);
for (const type of ['incremental', 'manual_full', 'calibration']) {
  for (const [name, old, next] of [
    ['generate', {}, { reviewStage: 'generate' }],
    ['review', { standardizationStage: 'review', generationBatchId: '201' }, { reviewStage: 'review', proposalBatchId: '201' }],
    ['repair', { repairReviewBatchId: '202', reviewRepairRound: 1 }, { reviewStage: 'repair', repairReviewBatchId: '202', reviewRepairRound: 1 }],
    ['repaired review', { standardizationStage: 'review', generationBatchId: '203', repairReviewBatchId: '202', reviewRepairRound: 1 }, { reviewStage: 'review', proposalBatchId: '203', repairReviewBatchId: '202', reviewRepairRound: 1 }],
  ] as const) cases.push({ name: `${type} ${name}`, type, old, next });
}

for (const fixture of cases) {
  test(`migrates and reverses ${fixture.name} without changing evidence, counts or audit`, async () => {
    await seed(fixture.type, { ...evidence, ...fixture.old });
    const original = await rows();
    await up(database);
    const migrated = await rows();
    assert.deepEqual(migrated.batches[0].reference_snapshot, { ...evidence, ...fixture.next });
    assert.deepEqual(withoutSnapshot(migrated), withoutSnapshot(original));
    await up(database);
    assert.deepEqual(await rows(), migrated, 'idempotent up must not rewrite rows');
    await down(database);
    const restored = await rows();
    assert.deepEqual(restored.batches[0].reference_snapshot, { ...evidence, ...(fixture.restored ?? fixture.old) });
    assert.deepEqual(withoutSnapshot(restored), withoutSnapshot(original));
    await down(database);
    assert.deepEqual(await rows(), restored, 'idempotent down must not rewrite rows');
    await up(database);
    assert.deepEqual(withoutSnapshot(await rows()), withoutSnapshot(migrated));
    assert.deepEqual((await rows()).batches[0].reference_snapshot, migrated.batches[0].reference_snapshot);
  });
}

test('null stays unprepared for every job type and pure new snapshots are not rewritten', async () => {
  for (const type of ['tag_extraction', 'membership_features', 'text_review', 'incremental', 'manual_full', 'calibration']) {
    await seed(type, null);
  }
  for (const fixture of cases) await seed(fixture.type, { ...evidence, ...fixture.next });
  const original = await rows();
  await up(database);
  assert.deepEqual(await rows(), original);
  await down(database);
  assert.deepEqual((await rows()).batches.slice(0, 6), original.batches.slice(0, 6));
});

test('new names win and all four old keys are removed without changing nested evidence', async () => {
  for (const type of ['tag_extraction', 'incremental']) {
    await seed(type, {
      ...evidence, reviewStage: 'review', proposalBatchId: '999',
      tagStage: 'repair', standardizationStage: 'review', extractionBatchId: '101', generationBatchId: '201',
      reviewRepairRound: 1, repairReviewBatchId: '102', warrantyBatchId: '99',
    });
  }
  await up(database);
  for (const batch of (await rows()).batches) {
    assert.deepEqual(batch.reference_snapshot, {
      ...evidence, reviewStage: 'review', proposalBatchId: '999',
      reviewRepairRound: 1, repairReviewBatchId: '102', warrantyBatchId: '99',
    });
  }
});

test('expired running and terminal batches retain status and every non-snapshot field', async () => {
  await seed('incremental', evidence, 'running', '2000-01-01T00:00:00Z');
  for (const status of ['succeeded', 'failed', 'cancelled']) {
    await seed('incremental', evidence, status, '2999-01-01T00:00:00Z');
  }
  const original = await rows();
  await up(database);
  assert.deepEqual(withoutSnapshot(await rows()), withoutSnapshot(original));
  for (const batch of (await rows()).batches) assert.equal(batch.reference_snapshot.reviewStage, 'generate');
});

function pausedWorkersError(error: unknown): boolean {
  assert.ok(error instanceof Error);
  assert.match(`${error.message} ${Reflect.get(error, 'hint')}`, /pause.*drain.*AI workers/i);
  assert.equal(Reflect.get(error, 'code'), '55P03');
  return true;
}

for (const [name, type, snapshot] of [
  ['explicit attribute stage', 'tag_extraction', { tagStage: 'extract' }],
  ['implicit identity generation', 'incremental', evidence],
  ['implicit identity repair', 'manual_full', { ...evidence, repairReviewBatchId: '202' }],
  ['unprepared text', 'text_review', null],
] as const) {
  test(`up atomically refuses an effective running lease: ${name}`, async () => {
    await seed('tag_extraction', { tagStage: 'extract' });
    await seed(type, snapshot, 'running', '2999-01-01T00:00:00Z');
    const original = await rows();
    await assert.rejects(up(database), pausedWorkersError);
    assert.deepEqual(await rows(), original);
  });
}

test('down atomically refuses an effective running lease', async () => {
  await seed('incremental', { ...evidence, reviewStage: 'repair', repairReviewBatchId: '202' });
  await seed('tag_extraction', { reviewStage: 'review', proposalBatchId: '101' }, 'running', '2999-01-01T00:00:00Z');
  const original = await rows();
  await assert.rejects(down(database), pausedWorkersError);
  assert.deepEqual(await rows(), original);
});

for (const table of ['ai_jobs', 'ai_job_batches']) {
  for (const migrate of [up, down]) {
    test(`${migrate.name} rejects a concurrent ${table} writer without partial updates`, async () => {
      await seed('incremental', migrate === up ? evidence : { ...evidence, reviewStage: 'generate' });
      const original = await rows();
      const writer = await pool.connect();
      try {
        await writer.query('begin');
        await writer.query(`lock table ${table} in row exclusive mode`);
        await assert.rejects(migrate(database), pausedWorkersError);
        assert.deepEqual(await rows(), original);
      } finally {
        await writer.query('rollback');
        writer.release();
      }
    });
  }
}

test('both write locks stay held until the caller transaction commits', async () => {
  await seed('incremental', evidence);
  await database.transaction().execute(async tx => {
    await up(tx);
    const locks = await sql<{ relname: string; mode: string }>`
      select c.relname, l.mode from pg_locks l join pg_class c on c.oid = l.relation
      where l.pid = pg_backend_pid() and c.relnamespace = ${schema}::regnamespace
        and c.relname in ('ai_jobs', 'ai_job_batches') and l.mode = 'ExclusiveLock' and l.granted
      order by c.relname`.execute(tx);
    assert.deepEqual(locks.rows, [
      { relname: 'ai_job_batches', mode: 'ExclusiveLock' },
      { relname: 'ai_jobs', mode: 'ExclusiveLock' },
    ]);
    const writer = await pool.connect();
    try {
      for (const table of ['ai_jobs', 'ai_job_batches']) {
        await writer.query('begin');
        await assert.rejects(writer.query(`lock table ${table} in row exclusive mode nowait`), { code: '55P03' });
        await writer.query('rollback');
      }
    } finally {
      await writer.query('rollback');
      writer.release();
    }
  });
  assert.equal((await rows()).batches[0].reference_snapshot.reviewStage, 'generate');
});

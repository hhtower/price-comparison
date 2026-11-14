import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { Kysely, PostgresDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';

const previous = '038_seven_dimension_tags_20261113';
const current = '039_tag_workflow_20261114';

async function setup(t: TestContext) {
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.ok(connectionString, 'TEST_DATABASE_URL is required');
  const schema = `tag_workflow_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString });
  await admin.query(`create schema "${schema}"`);
  const pool = new Pool({ connectionString, max: 4,
    options: `-c search_path=${schema},public -c statement_timeout=15000` });
  const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
  const migrator = new Migrator({ db, provider: migrationProvider, migrationTableSchema: schema });
  t.after(async () => {
    await db.destroy();
    await admin.query(`drop schema "${schema}" cascade`);
    await admin.end();
  });
  assert.ifError((await migrator.migrateTo(previous)).error);
  return { pool, migrator };
}

test('text review migration preserves all job types and refuses a destructive rollback', async t => {
  const { pool, migrator } = await setup(t);
  const original = ['incremental', 'calibration', 'manual_full', 'tag_extraction', 'membership_features'];
  for (const kind of original) {
    await pool.query(`insert into ai_jobs (status, total, model, job_type) values ('queued', 0, $1, $2)`, ['mock', kind]);
  }
  assert.ifError((await migrator.migrateTo(current)).error);
  await pool.query(`insert into ai_jobs (status, total, model, job_type) values ('queued', 0, 'mock', 'text_review')`);
  await assert.rejects(pool.query(`insert into ai_jobs (status, total, model, job_type) values ('queued', 0, 'mock', 'unknown')`), { code: '23514' });
  const rollback = await migrator.migrateTo(previous);
  assert.ok(rollback.error, 'rollback must refuse while text review jobs exist');
  assert.equal((await pool.query('select count(*)::int as n from ai_jobs')).rows[0].n, 6);
  assert.equal((await pool.query('select count(*)::int as n from kysely_migration where name=$1', [current])).rows[0].n, 1);
  await pool.query(`delete from ai_jobs where job_type='text_review'`);
  assert.ifError((await migrator.migrateTo(previous)).error);
  assert.deepEqual((await pool.query('select job_type from ai_jobs order by id')).rows.map(row => row.job_type), original);
  await assert.rejects(pool.query(`insert into ai_jobs (status, total, model, job_type) values ('queued', 0, 'mock', 'text_review')`), { code: '23514' });
  assert.ifError((await migrator.migrateTo(current)).error);
});

test('text review migration does not lock unrelated product tables', async t => {
  const { pool, migrator } = await setup(t);
  const writer = await pool.connect();
  try {
    await writer.query('begin');
    await writer.query('lock table products in access exclusive mode');
    const result = await migrator.migrateTo(current);
    assert.ifError(result.error);
    assert.equal(result.results?.find(row => row.migrationName === current)?.status, 'Success');
  } finally {
    await writer.query('rollback');
    writer.release();
  }
});

test('text review migration bounds lock retries and preserves the old constraint on failure', async t => {
  const { pool, migrator } = await setup(t);
  const reader = await pool.connect();
  try {
    await reader.query('begin');
    await reader.query('select 1 from ai_jobs');
    const result = await migrator.migrateTo(current);
    assert.equal((result.error as { code?: string })?.code, '55P03');
    assert.equal((await pool.query('select count(*)::int as n from kysely_migration where name=$1', [current])).rows[0].n, 0);
    await assert.rejects(pool.query(`insert into ai_jobs (status, total, model, job_type) values ('queued', 0, 'mock', 'text_review')`), { code: '23514' });
  } finally {
    await reader.query('rollback');
    reader.release();
  }
  assert.ifError((await migrator.migrateTo(current)).error);
});

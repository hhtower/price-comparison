import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { after, before, describe, test } from 'node:test';
import { Kysely, PostgresDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';

describe('membership schema migration locks', { concurrency: false }, () => {
  const schema = `membership_locks_${randomUUID().replaceAll('-', '')}`;
  const previous = '033_mcp_key_storage_20261106';
  const current = '034_ai_membership_kind_20261109';
  let admin: Pool;
  let pool: Pool;
  let database: Kysely<unknown>;
  let migrator: Migrator;

  before(async () => {
    const connectionString = process.env.TEST_DATABASE_URL;
    assert.ok(connectionString, 'TEST_DATABASE_URL is required');
    admin = new Pool({ connectionString });
    await admin.query(`create schema "${schema}"`);
    pool = new Pool({
      connectionString, max: 4,
      options: `-c search_path=${schema},public -c statement_timeout=15000 -c application_name=${schema}`,
    });
    database = new Kysely({ dialect: new PostgresDialect({ pool }) });
    migrator = new Migrator({ db: database, provider: migrationProvider, migrationTableSchema: schema });
    await migrate(previous);
  });

  after(async () => {
    await database?.destroy();
    if (admin) {
      await admin.query(`drop schema if exists "${schema}" cascade`);
      await admin.end();
    }
  });

  async function migrate(target: string) {
    const result = await migrator.migrateTo(target);
    if (result.error) throw result.error;
  }

  async function waitForContention() {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = await admin.query(`select 1 from pg_stat_activity
        where application_name = $1 and state = 'active'
          and (wait_event_type = 'Lock' or wait_event = 'PgSleep')`, [schema]);
      if (result.rowCount) return;
      await setTimeout(10);
    }
    assert.fail('migration did not encounter the held relation lock');
  }

  for (const direction of ['upgrade', 'downgrade'] as const) {
    for (const [held, next] of [
      ['products', 'standard_products'],
      ['standard_products', 'shops'],
      ['ai_jobs', 'products'],
      ['shops', 'products'],
    ]) {
      test(`${direction} releases partial locks for ${held} -> ${next}`, async () => {
        await migrate(direction === 'upgrade' ? previous : current);
        const writer = await pool.connect();
        let pending: ReturnType<typeof migrator.migrateTo> | undefined;
        try {
          await writer.query('begin');
          await writer.query('set local statement_timeout = 4000');
          await writer.query(`select 1 from ${held} for share`);
          pending = migrator.migrateTo(direction === 'upgrade' ? current : previous);
          await waitForContention();
          await writer.query(`select 1 from ${next} for share`);
          await writer.query('commit');
          const result = await pending;
          assert.ifError(result.error);
          assert.equal(result.results?.find(row => row.migrationName === current)?.status, 'Success');
        } finally {
          await writer.query('rollback');
          writer.release();
          await pending;
        }
      });
    }
  }

  test('persistent contention leaves no partial schema and permits a later retry', async () => {
    await migrate(previous);
    const writer = await pool.connect();
    let pending: ReturnType<typeof migrator.migrateTo> | undefined;
    try {
      await writer.query('begin');
      await writer.query('select id from ai_jobs for share');
      pending = migrator.migrateTo(current);
      const result = await pending;
      assert.equal((result.error as { code?: string })?.code, '55P03');
      const columns = await pool.query(`select column_name from information_schema.columns
        where table_schema = $1 and column_name in ('membership_kind', 'membership_features', 'membership_classification')`,
      [schema]);
      assert.deepEqual(columns.rows, []);
      const completed = await pool.query('select name from kysely_migration where name = $1', [current]);
      assert.deepEqual(completed.rows, []);
    } finally {
      await writer.query('rollback');
      writer.release();
      await pending;
    }
    await migrate(current);
  });
});

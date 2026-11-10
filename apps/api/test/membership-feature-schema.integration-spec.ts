import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Kysely, PostgresDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';

test('membership features belong to merchant products, without changing standard identities', async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const schema = `feature_schema_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  let database: Kysely<unknown> | undefined;
  try {
    await admin.query(`create schema "${schema}"`);
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema},public` });
    database = new Kysely({ dialect: new PostgresDialect({ pool }) });
    const migrator = new Migrator({ db: database, provider: migrationProvider, migrationTableSchema: schema });
    assert.ifError((await migrator.migrateToLatest()).error);
    const columns = await pool.query(`select table_name, column_name from information_schema.columns
      where table_schema=$1 and column_name like 'membership_%' order by table_name,column_name`, [schema]);
    assert.deepEqual(columns.rows, [{ table_name: 'products', column_name: 'membership_features' }]);
    assert.ifError((await migrator.migrateTo('033_mcp_key_storage_20261106')).error);
    assert.ifError((await migrator.migrateToLatest()).error);
  } finally {
    await database?.destroy();
    await admin.query(`drop schema if exists "${schema}" cascade`);
    await admin.end();
  }
});

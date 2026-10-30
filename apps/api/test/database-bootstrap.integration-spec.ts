import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrateToLatest, migrationProvider } from '../scripts/migrate.js';
import type { DatabaseSchema } from '../src/database/types.js';

async function databaseFixture(t: TestContext) {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required');
  const schema = `bootstrap_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  const previousSchema = process.env.PG_SCHEMA;
  process.env.PG_SCHEMA = schema;
  const database = new Kysely<DatabaseSchema>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public` }),
    }),
  });
  t.after(async () => {
    await database.destroy();
    await admin.query(`drop schema "${schema}" cascade`);
    await admin.end();
    if (previousSchema === undefined) delete process.env.PG_SCHEMA;
    else process.env.PG_SCHEMA = previousSchema;
  });
  return { database, schema };
}

test('empty database migrates completely, preserves NOT NULL and can migrate again without losing data', async t => {
  const { database, schema } = await databaseFixture(t);
  await migrateToLatest(database);
  const columns = await sql<{ table_name: string; column_name: string; is_nullable: string }>`
    select table_name, column_name, is_nullable from information_schema.columns
    where table_schema = ${schema} and table_name in ('admin', 'shops', 'products', 'offers')
  `.execute(database);
  for (const name of ['admin.password_hash', 'shops.name', 'products.shop_id', 'products.name', 'offers.product_id', 'offers.price']) {
    assert.equal(columns.rows.find(column => `${column.table_name}.${column.column_name}` === name)?.is_nullable, 'NO', name);
  }
  await assert.rejects(sql`insert into admin (id, password_hash) values (1, null)`.execute(database), { code: '23502' });
  const shop = await database.insertInto('shops').values({
    name: 'Bootstrap preservation', platform: 'test', url: 'https://bootstrap.example',
  }).returning(['id', 'name']).executeTakeFirstOrThrow();
  const before = await sql<{ name: string; timestamp: string }>`select name, timestamp from kysely_migration order by name`.execute(database);
  assert.deepEqual(before.rows.map(row => row.name), Object.keys(await migrationProvider.getMigrations()).sort());
  await migrateToLatest(database);
  assert.deepEqual((await sql`select name, timestamp from kysely_migration order by name`.execute(database)).rows, before.rows);
  assert.deepEqual(await database.selectFrom('shops').select(['id', 'name']).where('id', '=', shop.id).executeTakeFirstOrThrow(), shop);
});

test('an existing initial schema upgrades through later migrations while preserving shop data', async t => {
  const { database, schema } = await databaseFixture(t);
  const migrator = new Migrator({ db: database, provider: migrationProvider, migrationTableSchema: schema });
  const initial = await migrator.migrateTo('001_initial');
  assert.ifError(initial.error);
  const shop = await sql<{ id: bigint; name: string }>`
    insert into shops (name, platform, url) values ('Existing installation', 'test', 'https://upgrade.example')
    returning id, name
  `.execute(database);
  await migrateToLatest(database);
  assert.deepEqual((await sql`select id, name from shops where id = ${shop.rows[0]!.id}`.execute(database)).rows, shop.rows);
  const records = await sql<{ name: string }>`select name from kysely_migration order by name`.execute(database);
  assert.deepEqual(records.rows.map(row => row.name), Object.keys(await migrationProvider.getMigrations()).sort());
});

test('review-key migration backfills existing reviews and rolls back without changing their evidence', async t => {
  const { database, schema } = await databaseFixture(t);
  const migrator = new Migrator({ db: database, provider: migrationProvider, migrationTableSchema: schema });
  assert.ifError((await migrator.migrateTo('024_crawler_monitor_indexes_20261027')).error);
  const shop = await sql<{ id: bigint }>`insert into shops (name, platform, url)
    values ('Review migration', 'test', 'https://review-migration.invalid') returning id`.execute(database);
  const product = await sql<{ id: bigint; source_data: unknown; text_review: unknown }>`
    insert into products (shop_id, external_id, name, normalized_key, url, source_data, text_review)
    values (${shop.rows[0]!.id}, 'review', 'Review product', 'review', '',
      '{"ratingText":{"name":"Complete source","description":"Do not truncate"}}'::jsonb,
      '{"contentVersion":"0","fingerprint":"","review":{"evidence":"Original review"}}'::jsonb)
    returning id, source_data, text_review`.execute(database);
  const original = product.rows[0]!;
  const read = () => sql<{ id: bigint; source_data: unknown; text_review: unknown; text_review_key: string }>`
    select id, source_data, text_review, text_review_key from products where id = ${original.id}`.execute(database);
  await migrateToLatest(database);
  const upgraded = (await read()).rows[0]!;
  assert.match(upgraded.text_review_key, /^[a-f0-9]{64}$/u);
  assert.deepEqual({ id: upgraded.id, source_data: upgraded.source_data, text_review: upgraded.text_review }, original);
  assert.ifError((await migrator.migrateTo('024_crawler_monitor_indexes_20261027')).error);
  assert.deepEqual((await sql`select id, source_data, text_review from products where id = ${original.id}`
    .execute(database)).rows[0], original);
  await migrateToLatest(database);
  assert.deepEqual((await read()).rows[0], upgraded);
});

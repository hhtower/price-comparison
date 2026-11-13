import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrateToLatest, migrationProvider } from '../scripts/migrate.js';
import type { DatabaseSchema } from '../src/database/types.js';
import { publishNextCatalogChange } from '../src/catalog/catalog-projection.js';

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
  assert.ifError((await migrator.migrateTo('025_shop_text_review_keys_20261030')).error);
  const upgraded = (await read()).rows[0]!;
  assert.match(upgraded.text_review_key, /^[a-f0-9]{64}$/u);
  assert.deepEqual({ id: upgraded.id, source_data: upgraded.source_data, text_review: upgraded.text_review }, original);
  assert.ifError((await migrator.migrateTo('024_crawler_monitor_indexes_20261027')).error);
  assert.deepEqual((await sql`select id, source_data, text_review from products where id = ${original.id}`
    .execute(database)).rows[0], original);
  assert.ifError((await migrator.migrateTo('025_shop_text_review_keys_20261030')).error);
  assert.deepEqual((await read()).rows[0], upgraded);
});


test('rating revision changes only for scoring inputs and survives rollback and reinstallation', async t => {
  const { database, schema } = await databaseFixture(t);
  const migrator = new Migrator({ db: database, provider: migrationProvider, migrationTableSchema: schema });
  const names = Object.keys(await migrationProvider.getMigrations()).sort();
  const previous = names[names.indexOf('028_catalog_rating_versions_20261101') - 1]!;
  assert.ifError((await migrator.migrateTo(previous)).error);
  const shop = await database.insertInto('shops').values({ name: 'Revision', platform: 'test', url: 'https://revision.invalid' })
    .returning('id').executeTakeFirstOrThrow();
  assert.ifError((await migrator.migrateTo('028_catalog_rating_versions_20261101')).error);
  const revision = async () => (await sql<{ revision: string }>`select rating_revision::text as revision from shops where id = ${shop.id}`.execute(database)).rows[0]!.revision;
  assert.equal(await revision(), '0');
  await database.updateTable('shops').set({ name: 'Renamed' }).where('id', '=', shop.id).execute();
  assert.equal(await revision(), '0');
  await database.updateTable('shops').set({ url: 'https://changed.invalid' }).where('id', '=', shop.id).execute();
  assert.equal(await revision(), '1');
  await database.updateTable('shops').set({ url: 'https://changed.invalid' }).where('id', '=', shop.id).execute();
  assert.equal(await revision(), '1');
  assert.ifError((await migrator.migrateTo(previous)).error);
  assert.equal((await database.selectFrom('shops').select('url').where('id', '=', shop.id).executeTakeFirstOrThrow()).url, 'https://changed.invalid');
  assert.ifError((await migrator.migrateTo('028_catalog_rating_versions_20261101')).error);
  assert.equal(await revision(), '0');
});

test('published results backfill asynchronously and survive migration rollback without changing source data', async t => {
  const { database, schema } = await databaseFixture(t);
  const migrator = new Migrator({ db: database, provider: migrationProvider, migrationTableSchema: schema });
  assert.ifError((await migrator.migrateTo('028_catalog_rating_versions_20261101')).error);
  const shop = await database.insertInto('shops').values({ name: 'Published', platform: 'test', url: 'https://published.invalid' })
    .returning('id').executeTakeFirstOrThrow();
  assert.ifError((await migrator.migrateTo('029_catalog_published_results_20261101')).error);
  assert.equal((await sql`select * from catalog_shop_ratings`.execute(database)).rows.length, 0);
  assert.equal(await publishNextCatalogChange(database), true);
  assert.equal((await sql`select * from catalog_shop_ratings`.execute(database)).rows.length, 0);
  while (await publishNextCatalogChange(database)) {}
  assert.equal((await sql`select * from catalog_shop_ratings`.execute(database)).rows.length, 1);
  assert.equal(await publishNextCatalogChange(database), false);
  await sql`insert into catalog_read_shop_totals values (99, ${shop.id}, 'CNY', 10, now(), 1, 99)`.execute(database);
  await sql`truncate catalog_read_offer_prices`.execute(database);
  while (await publishNextCatalogChange(database)) {}
  assert.equal((await sql`select * from catalog_read_shop_totals`.execute(database)).rows.length, 0);
  assert.ifError((await migrator.migrateTo('028_catalog_rating_versions_20261101')).error);
  assert.equal((await database.selectFrom('shops').select('name').where('id', '=', shop.id).executeTakeFirstOrThrow()).name, 'Published');
  assert.ifError((await migrator.migrateTo('029_catalog_published_results_20261101')).error);
  assert.equal(await publishNextCatalogChange(database), true);
});

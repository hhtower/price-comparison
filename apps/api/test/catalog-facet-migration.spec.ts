import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Kysely, Migrator, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { createPostgresPool } from '../src/database/database.providers.js';
import type { DatabaseSchema } from '../src/database/types.js';
import { migrationProvider } from '../scripts/migrate.js';

let database: Kysely<DatabaseSchema>;
let admin: Pool;
let migrator: Migrator;
const schema = `facet_migration_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
before(async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
  admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  process.env.PG_SCHEMA = schema;
  database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({
    pool: createPostgresPool({ ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, PG_SCHEMA: schema }),
  }) });
  migrator = new Migrator({ db: database, provider: migrationProvider, migrationTableSchema: schema });
  const { error } = await migrator.migrateTo('013_tag_job_preparation_20261017');
  if (error) throw error;
});

after(async () => {
  await database?.destroy();
  await admin?.query(`drop schema if exists "${schema}" cascade`);
  await admin?.end();
  delete process.env.PG_SCHEMA;
});

test('facet migration rebuilds existing projections, preserves source data and supports rollback and later writes', async () => {
  const shop = await database.insertInto('shops').values({ name: 'Facet migration', platform: 'test', url: 'https://facet.invalid' })
    .returning('id').executeTakeFirstOrThrow();
  const product = await database.insertInto('products').values({ shop_id: shop.id, external_id: 'facet', name: 'Example',
    normalized_key: 'facet', url: 'https://facet.invalid/item' }).returning('id').executeTakeFirstOrThrow();
  await database.insertInto('product_tags').values([
    { name: 'access', value: 'dedicated' }, { name: 'region', value: 'us' },
    { name: 'delivery_mode', value: 'automatic' }, { name: 'renewable', value: '有' },
    { name: 'warranty_detail', value: 'merchant-only text' },
  ].map(tag => ({ ...tag, product_id: product.id }))).execute();
  const source = await database.selectFrom('products').selectAll().where('id', '=', product.id).executeTakeFirstOrThrow();
  const tags = await database.selectFrom('product_tags').selectAll().orderBy('id').execute();
  const facts = () => database.selectFrom('catalog_product_facts').selectAll().where('product_id', '=', product.id).executeTakeFirstOrThrow();
  const version = async () => (await database.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow()).version;
  const beforeFacts = await facts();
  const beforeVersion = await version();
  assert.ok(!JSON.parse(beforeFacts.facet_tags).some((tag: { name: string }) => tag.name === 'region'));
  const expected = [
    { name: 'access', value: 'dedicated' }, { name: 'delivery_mode', value: 'automatic' },
    { name: 'region', value: 'us' }, { name: 'renewable', value: '有' },
    { name: 'sms_verification', value: 'unknown' }, { name: 'warranty', value: 'unknown' },
  ];
  assert.ifError((await migrator.migrateTo('014_catalog_readable_facets_20261018')).error);
  assert.deepEqual(JSON.parse((await facts()).facet_tags), expected);
  assert.deepEqual({ ...(await facts()), facet_tags: beforeFacts.facet_tags }, beforeFacts);
  assert.deepEqual(await database.selectFrom('products').selectAll().where('id', '=', product.id).executeTakeFirstOrThrow(), source);
  assert.deepEqual(await database.selectFrom('product_tags').selectAll().orderBy('id').execute(), tags);
  assert.equal(await version(), beforeVersion + 1n);
  assert.ifError((await migrator.migrateTo('014_catalog_readable_facets_20261018')).error);
  assert.equal(await version(), beforeVersion + 1n);

  const { error } = await migrator.migrateTo('013_tag_job_preparation_20261017');
  if (error) throw error;
  assert.deepEqual(await facts(), beforeFacts);
  assert.equal(await version(), beforeVersion + 2n);
  assert.ifError((await migrator.migrateTo('014_catalog_readable_facets_20261018')).error);
  await database.updateTable('product_tags').set({ value: 'jp' }).where('product_id', '=', product.id).where('name', '=', 'region').execute();
  assert.deepEqual(JSON.parse((await facts()).facet_tags), expected.map(tag => tag.name === 'region' ? { ...tag, value: 'jp' } : tag));
  const invalid = await sql<{ facets: unknown }>`select catalog_readable_facets('[{"name":"region","value":"unsupported-region"},{"name":"minimum_quantity","value":"1"}]'::jsonb) as facets`.execute(database);
  assert.deepEqual(invalid.rows[0]!.facets, []);
});

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { createPostgresPool } from '../src/database/database.providers.js';
import type { DatabaseSchema } from '../src/database/types.js';
import { migrateToLatest, migrationProvider } from '../scripts/migrate.js';

let database: Kysely<DatabaseSchema>;
let admin: Pool;
const schema = `rapid_migration_${Date.now()}`;
before(async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
  admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  process.env.PG_SCHEMA = schema;
  database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({
    pool: createPostgresPool({ ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, PG_SCHEMA: schema }),
  }) });
  const { error } = await new Migrator({ db: database, provider: migrationProvider, migrationTableSchema: schema })
    .migrateTo('003_offer_settlement_20261002');
  if (error) throw error;
});
after(async () => {
  await database?.destroy();
  await admin?.query(`drop schema if exists "${schema}" cascade`);
  await admin?.end();
  delete process.env.PG_SCHEMA;
});

test('migrates stored daily tags once, deduplicates rapid and rebuilds facts without rewriting merchant text', async () => {
  const shop = await database.insertInto('shops').values({ name: 'Migration', platform: 'test', url: 'https://migration.invalid' }).returning('id').executeTakeFirstOrThrow();
  const products = await database.insertInto('products').values(['legacy', 'both', 'plain', 'source', 'aliases'].map(external_id => ({
    shop_id: shop.id, external_id, name: external_id === 'source' ? '日抛账号' : external_id,
    spec: '原始描述保持不变', normalized_key: external_id, url: `https://migration.invalid/${external_id}`,
  }))).returning(['id', 'name', 'spec', 'standardization_revision']).execute();
  const [legacy, both, plain, source, aliases] = products;
  await database.insertInto('product_tags').values([
    { product_id: legacy.id, name: 'account_lifecycle', value: 'disposable' },
    { product_id: both.id, name: 'account_lifecycle', value: 'disposable' },
    { product_id: both.id, name: 'intended_use', value: 'rapid' },
    { product_id: legacy.id, name: 'duration', value: '1 days' },
    { product_id: aliases.id, name: '用途', value: '日抛' },
    { product_id: aliases.id, name: 'use', value: '日抛号' },
    { product_id: aliases.id, name: 'usage', value: 'rapid' },
    { product_id: aliases.id, name: 'subscription_duration', value: '日抛' },
  ]).execute();
  const version = await database.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow();
  await migrateToLatest(database);
  const tags = await database.selectFrom('product_tags').select(['product_id', 'name', 'value']).orderBy('product_id').orderBy('name').execute();
  assert.deepEqual(tags, [
    { product_id: legacy.id, name: 'duration', value: '1 days' },
    { product_id: legacy.id, name: 'intended_use', value: 'rapid' },
    { product_id: both.id, name: 'intended_use', value: 'rapid' },
    { product_id: aliases.id, name: 'intended_use', value: 'rapid' },
  ]);
  const facts = await sql<{ product_id: bigint; tags: Array<{ name: string; value: string }>; facets: Array<{ name: string; value: string }> }>`
    select product_id, tags, facet_tags::jsonb as facets from catalog_product_facts order by product_id
  `.execute(database);
  for (const product of [legacy, both, source, aliases]) {
    const row = facts.rows.find(row => row.product_id === product.id)!;
    assert.deepEqual(row.tags.filter(tag => tag.name === 'intended_use'), [{ name: 'intended_use', value: 'rapid' }]);
    assert.ok(row.facets.some(tag => tag.name === 'intended_use' && tag.value === 'rapid'));
    assert.ok(!row.tags.some(tag => tag.value === 'disposable'));
  }
  assert.ok(facts.rows.find(row => row.product_id === plain.id)!.tags.some(tag => tag.name === 'intended_use' && tag.value === 'unknown'));
  assert.deepEqual(await database.selectFrom('products').select(['id', 'name', 'spec']).orderBy('id').execute(),
    products.map(({ id, name, spec }) => ({ id, name, spec })));
  const changedVersion = await database.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow();
  assert.ok(changedVersion.version > version.version);
  const revisions = await database.selectFrom('products').select(['id', 'standardization_revision']).orderBy('id').execute();
  assert.equal(revisions[0].standardization_revision, legacy.standardization_revision + 1n);
  assert.equal(revisions[1].standardization_revision, both.standardization_revision + 1n);
  assert.equal(revisions[4].standardization_revision, aliases.standardization_revision + 1n);
  await migrateToLatest(database);
  assert.deepEqual(await database.selectFrom('products').select(['id', 'standardization_revision']).orderBy('id').execute(), revisions);
});

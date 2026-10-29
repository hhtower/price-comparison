import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import '../src/config/env.js';
import { migrateToLatest } from '../scripts/migrate.js';
import type { DatabaseSchema } from '../src/database/types.js';
import { AdminRepository } from '../src/admin/admin.repository.js';
import { CatalogRepository } from '../src/catalog/catalog.repository.js';
import { loadCatalogAliases } from '../src/standardization/catalog-aliases.js';
import { buildCanonicalStandardKey } from '../src/standardization/canonical-key.js';

const schema = 'alias_storage_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
let database: Kysely<DatabaseSchema>, admin: Pool, repository: AdminRepository, shopId: bigint;
before(async () => {
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.ok(connectionString, 'TEST_DATABASE_URL is required');
  admin = new Pool({ connectionString });
  await admin.query('create schema "' + schema + '"');
  database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString,
    options: '-c search_path="' + schema + '",public' }) }) });
  process.env.PG_SCHEMA = schema;
  await migrateToLatest(database);
  repository = new AdminRepository(database);
  shopId = (await database.insertInto('shops').values({ platform: 'test', url: 'https://aliases.invalid', name: 'Alias shop', enabled: true }).returning('id').executeTakeFirstOrThrow()).id;
});
after(async () => {
  await database?.destroy();
  await admin?.query('drop schema if exists "' + schema + '" cascade');
  await admin?.end();
  delete process.env.PG_SCHEMA;
});

async function standard(label: string) {
  const identity = { family: 'test', product: label, tier: 'standard' };
  const row = await database.insertInto('standard_products').values({ name: label, platform: 'test', canonical_family: identity.family,
    canonical_product: label, canonical_tier: 'standard', standard_key: buildCanonicalStandardKey(identity), verification_state: 'verified' }).returning('id').executeTakeFirstOrThrow();
  const product = await database.insertInto('products').values({ shop_id: shopId, external_id: label, name: label,
    normalized_key: label, url: 'https://aliases.invalid/' + label }).returning('id').executeTakeFirstOrThrow();
  await database.insertInto('standard_product_members').values({ standard_product_id: row.id, product_id: product.id, assignment_source: 'ai', publication_state: 'published' }).execute();
  await database.insertInto('offers').values({ idempotency_key: label, product_id: product.id, price: '10.00', currency: 'CNY' }).execute();
  return row.id;
}

test('admin edits one alias field used by public search and AI candidates', async () => {
  const id = await standard('editable');
  const updated = await repository.updateStandardProduct(id, { aliases: ['  小众名称  ', '小众 名称', 'Alternate Name'] });
  assert.deepEqual(updated?.aliases, ['小众名称', 'Alternate Name']);
  assert.deepEqual((await loadCatalogAliases(database, [id])).map(row => row.alias), ['小众名称', 'Alternate Name']);
  const catalog = new CatalogRepository(database);
  assert.deepEqual((await catalog.search({ search: '小众名称', tags: [], limit: 20 })).items.map(row => row.id), [String(id)]);
  await assert.rejects(repository.updateStandardProduct(id, { aliases: ['x'.repeat(81)] }), { code: 'STANDARD_PRODUCT_ALIASES_INVALID' });
  assert.deepEqual((await repository.listStandardProducts({})).items.find(row => row.id === id)?.aliases, ['小众名称', 'Alternate Name']);
});

test('editing aliases with unchanged identity fields does not create human decisions', async () => {
  const id = await standard('search-only');
  const membership = await database.selectFrom('standard_product_members').select('product_id').where('standard_product_id', '=', id).executeTakeFirstOrThrow();
  await repository.updateStandardProduct(id, { aliases: ['搜索提示'], canonicalFamily: 'TEST', canonicalProduct: 'search-only', canonicalTier: 'standard' });
  assert.deepEqual(await database.selectFrom('product_standardization_decisions').select('id').where('product_id', '=', membership.product_id).execute(), []);
  assert.equal((await database.selectFrom('standard_product_members').select('assignment_source').where('product_id', '=', membership.product_id).executeTakeFirstOrThrow()).assignment_source, 'ai');
  assert.deepEqual((await loadCatalogAliases(database, [id])).map(row => row.alias), ['搜索提示']);
});

test('clearing a duplicate alias restores the other owner and refreshes its index', async () => {
  const left = await standard('left'), right = await standard('right');
  await repository.updateStandardProduct(left, { aliases: ['Shared Alias'] });
  await repository.updateStandardProduct(right, { aliases: ['shared-alias'] });
  assert.deepEqual(await loadCatalogAliases(database, [left, right]), []);
  await repository.updateStandardProduct(right, { aliases: [] });
  assert.equal((await loadCatalogAliases(database, [left]))[0]?.alias, 'Shared Alias');
  const change = await database.selectFrom('catalog_index_changes').select('document').where('standard_product_id', '=', left).orderBy('id', 'desc').executeTakeFirstOrThrow();
  assert.deepEqual((change.document as { aliases: string[] }).aliases, ['Shared Alias']);
});

test('merging standard products keeps searchable aliases on the surviving product', async () => {
  const source = await standard('merge-source'), target = await standard('merge-target');
  await repository.updateStandardProduct(source, { aliases: ['原商品别名'] });
  await repository.updateStandardProduct(target, { aliases: ['保留商品别名'] });
  const merged = await repository.mergeStandardProducts([source], target);
  assert.deepEqual(merged.success, [String(source)]);
  assert.deepEqual(new Set((await loadCatalogAliases(database, [target])).map(row => row.alias)), new Set(['原商品别名', '保留商品别名']));
  assert.deepEqual(await loadCatalogAliases(database, [source]), []);
});

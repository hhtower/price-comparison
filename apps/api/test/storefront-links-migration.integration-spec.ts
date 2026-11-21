import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Kysely, PostgresDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';
import { up } from '../src/database/migrations/048_storefront_product_links_20261121.js';

test('storefront link migration repairs existing projections without changing product identity', async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required');
  const schema = `storefront_links_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public` });
  const database = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  try {
    const migrator = new Migrator({ db: database, provider: migrationProvider, migrationTableSchema: schema });
    const previous = await migrator.migrateTo('047_catalog_membership_totals_20261120');
    if (previous.error) throw previous.error;
    const host = 'https://gpthub.ciyuanapi.ai';
    const cases = [
      [host + '/', 'public-products-v1', host + '/products/claude%20pro?ref=shop', host + '/item/claude%20pro?ref=shop'],
      [host + '/', 'public-products-v1', host + '/item/already-correct', host + '/item/already-correct'],
      [host + '/', 'public-products-v1', host + '/products/', host + '/products/'],
      [host + '/', 'public-products-v1', 'https://other.test/products/plus', 'https://other.test/products/plus'],
      ['https://other.test/', 'public-products-v1', host + '/products/plus', host + '/products/plus'],
      [host + '.example.test/', 'public-products-v1', host + '.example.test/products/plus', host + '.example.test/products/plus'],
      [host, 'acg-faka', host + '/products/plus', host + '/products/plus'],
    ];
    const standard = (await pool.query(`insert into standard_products (name) values ('Test product') returning id`)).rows[0].id;
    const ids = [];
    for (const [shopUrl, protocol, url] of cases) {
      const shop = (await pool.query(`insert into shops (name, platform, url, protocol)
        values ($1, $2, $3, $4) on conflict (url) do update set url = excluded.url returning id`,
      ['Test shop', 'test', shopUrl, protocol])).rows[0].id;
      const product = (await pool.query(`insert into products (shop_id, external_id, name, normalized_key, url)
        values ($1, $2, 'Test product', $2, $3) returning id`, [shop, randomUUID(), url])).rows[0].id;
      ids.push(product);
      await pool.query(`insert into standard_product_members (standard_product_id, product_id) values ($1, $2)`, [standard, product]);
      await pool.query(`insert into offers (product_id, idempotency_key, price) values ($1, $2, 10)`, [product, randomUUID()]);
    }
    const before = (await pool.query('select * from products order by id')).rows;
    const cacheVersion = (await pool.query('select version from catalog_cache_versions where id = 1')).rows[0].version;
    const current = await migrator.migrateToLatest();
    if (current.error) throw current.error;
    const after = (await pool.query('select * from products order by id')).rows;
    assert.deepEqual(after.map(row => row.url), cases.map(row => row[3]));
    assert.deepEqual(after.map(({ url, ...row }) => row), before.map(({ url, ...row }) => row));
    assert.deepEqual((await pool.query('select product_url from catalog_read_offers where product_id = any($1) order by product_id', [ids])).rows.map(row => row.product_url),
      cases.map(row => row[3]));
    assert.ok(BigInt((await pool.query('select version from catalog_cache_versions where id = 1')).rows[0].version) > BigInt(cacheVersion));
    await up(database);
    assert.deepEqual((await pool.query('select * from products order by id')).rows, after);
  } finally {
    await database.destroy();
    await admin.query(`drop schema "${schema}" cascade`);
    await admin.end();
  }
});

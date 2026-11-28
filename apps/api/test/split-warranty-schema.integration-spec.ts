import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Kysely, PostgresDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';
import { AdminRepository } from '../src/admin/admin.repository.js';
import { CatalogRepository } from '../src/catalog/catalog.repository.js';
import { normalizeCatalogQuery } from '../src/catalog/catalog.service.js';
import type { DatabaseSchema } from '../src/database/types.js';
import { isCanonicalProductTag } from '@price-comparison/catalog/product-tag-policy';

for (const upgrade of [false, true]) test(`split warranty storage and filters: ${upgrade ? 'upgrade' : 'fresh'}`, async t => {
  assert.ok(process.env.TEST_DATABASE_URL, 'Dedicated TEST_DATABASE_URL required');
  const schema = `warranty_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public` });
  const db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
  t.after(async () => { await db.destroy(); await admin.query(`drop schema "${schema}" cascade`); await admin.end(); });
  const migrator = new Migrator({ db, provider: migrationProvider, migrationTableSchema: schema });
  assert.ifError((await (upgrade ? migrator.migrateTo('043_split_warranty_tags_20261114') : migrator.migrateToLatest())).error);
  const shop = (await pool.query(`insert into shops (name, platform, url) values ('test','test','https://test.invalid') returning id`)).rows[0].id;
  const product = (await pool.query(`insert into products (shop_id,external_id,name,normalized_key,url,source_description)
    values ($1,'one','plan','one','https://test.invalid/one','保订阅30天，交付后5分钟内保首登，封号不保') returning id`, [shop])).rows[0].id;
  const standard = (await pool.query(`insert into standard_products (name,platform,verification_state) values ('plan','test','verified') returning id`)).rows[0].id;
  await pool.query(`insert into standard_product_members (product_id,standard_product_id,assignment_source,publication_state) values ($1,$2,'human','published')`, [product, standard]);
  await pool.query(`insert into offers (product_id,idempotency_key,price,currency) values ($1,'one',10,'CNY')`, [product]);
  if (upgrade) {
    await pool.query(`insert into product_tags (product_id,name,value) values
      ($1,'warranty_terms','"旧保障条款"'),($1,'usage_warranty','"封号保障30天"')`, [product]);
    const cases = [
      {
        tags: [
          { name: 'subscription_warranty', value: '质保 7 天' }, { name: 'subscription_warranty', value: '质保 30 天' },
          { name: 'usage_warranty', value: '首登' }, { name: 'region', value: 'us' }, { name: 'region', value: 'jp' },
        ],
        expected: [{ name: 'region', value: 'jp' }, { name: 'region', value: 'us' }, { name: 'usage_warranty', value: '首登' }],
      },
      {
        tags: [
          { name: 'usage_warranty', value: '首登' }, { name: 'usage_warranty', value: '质保 7 天' },
          { name: 'subscription_warranty', value: '质保 30 天' }, { name: 'subscription_warranty', value: '旧订阅条款' },
        ],
        expected: [{ name: 'subscription_warranty', value: '质保 30 天' }],
      },
      {
        tags: [{ name: 'subscription_warranty', value: '质保 7 天' }, { name: 'usage_warranty', value: '质保 7 天' }],
        expected: [{ name: 'subscription_warranty', value: '质保 7 天' }, { name: 'usage_warranty', value: '质保 7 天' }],
      },
    ];
    const products: bigint[] = [];
    for (const [index, fixture] of cases.entries()) {
      const key = `upgrade-${index}`;
      const id: bigint = (await pool.query(`insert into products (shop_id,external_id,name,normalized_key,url)
        values ($1,$2,'upgrade plan',$2,'https://test.invalid/upgrade') returning id`, [shop, key])).rows[0].id;
      products.push(id);
      for (const tag of fixture.tags) await pool.query(`insert into product_tags (product_id,name,value) values ($1,$2,$3::jsonb)`,
        [id, tag.name, JSON.stringify(tag.value)]);
    }
    assert.ifError((await migrator.migrateToLatest()).error);
    assert.equal((await pool.query('select * from product_tags where product_id=$1', [product])).rowCount, 0);
    assert.deepEqual((await pool.query('select tags from catalog_product_facts where product_id=$1', [product])).rows[0].tags, []);
    for (const [index, fixture] of cases.entries()) {
      const id: bigint = products[index];
      assert.deepEqual((await pool.query('select name,value from product_tags where product_id=$1 order by name,value', [id])).rows,
        fixture.expected, `upgrade case ${index}: remove only ambiguous warranty groups after invalid values`);
      assert.deepEqual((await pool.query('select tags from catalog_product_facts where product_id=$1', [id])).rows[0].tags,
        fixture.expected, `upgrade case ${index}: refresh projected tags`);
    }
  }
  const tags = [
    { name: 'subscription_warranty', value: '质保 30 天' },
    { name: 'usage_warranty', value: '首登' },
  ];
  for (const tag of tags) await pool.query(`insert into product_tags (product_id,name,value) values ($1,$2,$3::jsonb)`,
    [product, tag.name, JSON.stringify(tag.value)]);
  const stored = (await pool.query(`select tags,facet_tags::jsonb as facets from catalog_product_facts where product_id=$1`, [product])).rows[0];
  for (const tag of tags) assert.ok(stored.tags.some((row: typeof tag) => row.name === tag.name && row.value === tag.value));
  assert.equal(stored.facets.some((tag: { name: string }) => tag.name === 'warranty_terms'), false);
  const offers = (await pool.query(`select tags,facet_tags::jsonb as facets from catalog_read_offers where product_id=$1`, [product])).rows[0];
  assert.deepEqual(offers, stored);
  const repo = new CatalogRepository(db);
  const filtered = await repo.search(normalizeCatalogQuery({ tags: tags.slice(0, 2), newcomer: false }));
  assert.equal(filtered.items[0]?.offers[0]?.productId, String(product));
  const noMatch = await repo.search(normalizeCatalogQuery({ tags: [{ name: 'usage_warranty', value: '质保 30 天' }], newcomer: false }));
  assert.equal(noMatch.items.length, 0);
  const listed = await new AdminRepository(db).listTags();
  assert.ok(listed.items.some(tag => tag.name === 'subscription_warranty'));
  assert.ok(!listed.items.some(tag => ['warranty', 'warranty_terms'].includes(tag.name)));
  for (const [name, value, valid] of [
    ['subscription_warranty', '字'.repeat(250), false], ['usage_warranty', '字'.repeat(251), false],
    ['warranty_terms', '字'.repeat(250), false], ['warranty_terms', '字'.repeat(251), false],
    ['warranty', '保订阅30天', false],
    ['subscription_warranty', '首登', false], ['usage_warranty', '首登', true],
    ['subscription_warranty', '质保（期限未注明）', true],
    ['usage_warranty', '质保 1.5 天', true], ['usage_warranty', '质保 6 小时', true],
    ['usage_warranty', '质保 0 小时', false], ['usage_warranty', '质保 -1 天', false],
    ['usage_warranty', '质保 1e+21 天', true], ['usage_warranty', '质保 1e999 天', false],
    ['usage_warranty', '质保 1e-999 天', false], ['usage_warranty', '质保30天', false],
  ] as const) {
    assert.equal(isCanonicalProductTag({ name, value }), valid);
    assert.equal((await pool.query(`select catalog_valid_tag($1,$2::jsonb) as valid`, [name, JSON.stringify(value)])).rows[0].valid, valid);
  }
});

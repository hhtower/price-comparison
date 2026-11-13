import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';
import { type DatabaseSchema, jsonb } from '../src/database/types.js';
import { CatalogRepository } from '../src/catalog/catalog.repository.js';
import { CatalogService, normalizeCatalogQuery } from '../src/catalog/catalog.service.js';
import { publishNextCatalogChange } from '../src/catalog/catalog-projection.js';
import { bumpCatalogVersion } from '../src/catalog/catalog-version.repository.js';
import { createCache } from '../src/cache/cache.js';
import { isCanonicalProductTag } from '@price-comparison/catalog/product-tag-policy';
import type { PurchaseTag } from '@price-comparison/catalog/purchase-attributes';

for (const upgrade of [false, true]) test(`seven-dimension read model: ${upgrade ? 'upgrade' : 'fresh install'}`, async t => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required');
  const schema = `tags_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  const db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: new Pool({
    connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public`,
  }) }) });
  t.after(async () => {
    await db.destroy();
    await admin.query(`drop schema "${schema}" cascade`);
    await admin.end();
  });
  const migrator = new Migrator({ db, provider: migrationProvider, migrationTableSchema: schema });
  const initial = await (upgrade ? migrator.migrateTo('037_catalog_membership_kinds_20261113') : migrator.migrateToLatest());
  if (initial.error) throw initial.error;
  const shop = await db.insertInto('shops').values({ name: 'Tag test', platform: 'test', url: 'https://tags.invalid' })
    .returning('id').executeTakeFirstOrThrow();
  const standard = await db.insertInto('standard_products').values({ name: 'Tag plan', platform: 'test', verification_state: 'verified' })
    .returning('id').executeTakeFirstOrThrow();
  const source = await db.insertInto('products').values({
    shop_id: shop.id, external_id: 'raw', name: '成品号 独享 质保30天 建议使用美区IP',
    spec: '仅保首登1小时', normalized_key: 'raw', url: 'https://tags.invalid/raw',
  }).returning('id').executeTakeFirstOrThrow();
  await db.insertInto('standard_product_members').values({
    product_id: source.id, standard_product_id: standard.id, assignment_source: 'human', publication_state: 'published',
  }).execute();
  await db.insertInto('offers').values({
    product_id: source.id, idempotency_key: 'raw', price: '10.00', currency: 'CNY',
    settlement_price: '3.333333333333', settlement_total_amount: '10.00', settlement_quantity: 3,
    settlement_verified_at: new Date(), settlement_payment_method: 'card',
  }).execute();
  if (upgrade) {
    await sql`insert into product_tags (product_id, name, value) values
      (${source.id}, 'duration', '30'), (${source.id}, 'warranty', 'covered'),
      (${source.id}, 'delivery', 'account'), (${source.id}, 'legacy', '{"kind":"permanent"}')`.execute(db);
    const result = await migrator.migrateToLatest();
    if (result.error) throw result.error;
    const raw = await db.selectFrom('product_tags').select(['name', 'value']).orderBy('name').execute();
    assert.deepEqual(raw, [
      { name: 'delivery', value: 'account' }, { name: 'duration', value: '30' },
      { name: 'legacy', value: '{"kind":"permanent"}' }, { name: 'warranty', value: 'covered' },
    ]);
  }
  const facts = async () => (await sql<{ tags: PurchaseTag[] }>`select tags from catalog_product_facts
    where product_id = ${source.id}`.execute(db)).rows[0]!.tags;
  assert.deepEqual(await facts(), [], 'raw prose and old strings cannot generate facts');
  const columns = await sql`select column_name from information_schema.columns
    where table_schema = current_schema() and table_name = 'catalog_read_offers' and column_name = 'warranty_days'`.execute(db);
  assert.deepEqual(columns.rows, []);
  assert.deepEqual((await sql`select to_regclass(current_schema() || '.catalog_read_offers_warranty_days') as idx,
    to_regprocedure(current_schema() || '.catalog_read_offers_max_warranty_days(jsonb)') as fn`.execute(db)).rows, [{ idx: null, fn: null }]);

  const valid: PurchaseTag[] = [
    { name: 'sms_verification', value: 'unverified' }, { name: 'region', value: 'us' }, { name: 'region', value: 'jp' },
    { name: 'duration', value: 30 }, { name: 'access_channel', value: 'web' }, { name: 'supported_client', value: 'codex' },
    { name: 'subscription_override', value: '无' }, { name: 'bulk_purchase', value: 'supported' },
    { name: 'warranty', value: '购买后1小时内仅保首登' },
  ];
  const samples: { name: string; value: unknown }[] = [
    ...valid, ...[0.5, 2, 90, 360, 365, { kind: 'range', min: 30, max: 90 }, { kind: 'min', days: 30 },
      { kind: 'max', days: 90 }, { kind: 'approx', days: 30 }, { kind: 'permanent' },
      '30', '1 month', 0, -1, 36501, null, [], {}, { kind: 'range', min: 30, max: 30 },
      { kind: 'range', min: '30', max: 90 }, { kind: 'min', days: 30, extra: true },
      ...[[], ['min'], ['max'], ['approx'], {}, null, 1, true].map(kind => ({ kind, days: 30 })),
    ].map(value => ({ name: 'duration', value })),
    { name: 'warranty', value: 'covered' }, { name: 'warranty', value: 'none' }, { name: 'warranty_days', value: '30' },
    { name: 'subscription_override', value: '有' }, { name: 'sms_verification', value: 'unknown' },
    { name: 'region', value: '美国' }, { name: 'supported_client', value: 'Codex' }, { name: 'access', value: 'dedicated' },
  ];
  for (const tag of samples) {
    const result = await sql<{ valid: boolean }>`select catalog_valid_tag(${tag.name}, ${JSON.stringify(tag.value)}::jsonb) as valid`.execute(db);
    assert.equal(result.rows[0]!.valid, isCanonicalProductTag(tag), JSON.stringify(tag));
  }
  for (const [value, expected] of [
    ['不享受质保', false], ['质保已过期', false], ['本商品不提供售后。', false], ['无售后，售出不退', false],
    ['本商品不保订阅30天', false], ['质保30天，质保到期后不再免费换货', true],
    ['仅保首登1小时，后续无售后', true], ['保订阅30天，封号不保', true],
    ['保修结束，支持退款', false], ['Warranty has expired; refund available', false],
    ['no warranty', false], ['warranty expired', false],
    ['质保unknown', false], ['无任何保障，仅保首登1小时', true],
    ['30 day warranty, bans not covered', true],
    ['30 day warranty; no refund', true], ['no warranty\nreplacement within 1 hour', true],
    ['商家说明', false],
  ] as const) {
    const tag = { name: 'warranty', value };
    assert.equal(isCanonicalProductTag(tag), expected, value);
    const result = await sql<{ valid: boolean; tags: PurchaseTag[] }>`select
      catalog_valid_tag('warranty', ${jsonb(value)}) as valid,
      catalog_readable_facets(${jsonb([tag])}) as tags`.execute(db);
    assert.equal(result.rows[0]!.valid, expected, value);
    assert.deepEqual(result.rows[0]!.tags, expected ? [tag] : [], value);
  }
  await db.deleteFrom('product_tags').execute();
  const insert = (id: bigint, tags: PurchaseTag[]) => db.insertInto('product_tags').values(
    tags.map(tag => ({ product_id: id, name: tag.name, value: jsonb(tag.value) })),
  ).execute();
  await insert(source.id, valid);
  assert.equal((await facts()).length, valid.length);
  const ids = new Map<number | string, bigint>([[30, source.id]]);
  for (const value of [2, 90, 360, 365, { kind: 'range' as const, min: 30, max: 90 }]) {
    const product = await db.insertInto('products').values({
      shop_id: shop.id, external_id: JSON.stringify(value), name: 'Typed plan', normalized_key: JSON.stringify(value), url: 'https://tags.invalid/other',
    }).returning('id').executeTakeFirstOrThrow();
    ids.set(typeof value === 'number' ? value : 'range', product.id);
    await db.insertInto('standard_product_members').values({
      product_id: product.id, standard_product_id: standard.id, assignment_source: 'human', publication_state: 'published',
    }).execute();
    await db.insertInto('offers').values({ product_id: product.id, idempotency_key: String(product.id), price: '20.00' }).execute();
    await insert(product.id, [{ name: 'duration', value }, { name: 'region', value: 'ph' }]);
  }
  while (await publishNextCatalogChange(db)) {}
  const repository = new CatalogRepository(db);
  const search = (tags: PurchaseTag[], q?: string) => repository.search(normalizeCatalogQuery({
    standardProductId: String(standard.id), detailKind: 'offers', detailPageSize: 50, tags, q,
  }));
  const results = (page: Awaited<ReturnType<typeof search>>) =>
    page.items.flatMap(item => item.detail?.entries ?? []).map(entry => 'productId' in entry ? entry.productId : entry.offer.productId);
  assert.deepEqual(results(await search([{ name: 'duration', value: 30 }])), [String(source.id)]);
  assert.deepEqual(results(await search([], '1个月')), [String(source.id)]);
  assert.deepEqual(results(await search([], '30天')), [String(source.id)]);
  const orTags = [{ name: 'region', value: 'jp' }, { name: 'region', value: 'ph' }, { name: 'duration', value: 30 }];
  assert.deepEqual(results(await search(orTags)), [String(source.id)]);
  assert.equal(results(await search([{ name: 'region', value: 'jp' }, { name: 'region', value: 'ph' }])).length, 6);
  assert.deepEqual((await repository.referenceOffers(normalizeCatalogQuery({
    standardProductId: String(standard.id), tags: orTags,
  }))).map(offer => offer.productId), [String(source.id)]);
  for (const days of [360, 365]) assert.deepEqual(results(await search([{ name: 'duration', value: days }])), [String(ids.get(days))]);
  const facets = await repository.facets({ tags: [], standardProductId: String(standard.id) });
  assert.ok(facets.tagFacets.every(isCanonicalProductTag));
  assert.deepEqual(facets.tagFacets.filter(tag => tag.name === 'duration' && typeof tag.value === 'number').map(tag => tag.value),
    [2, 30, 90, 360, 365]);
  const quote = (await search([{ name: 'duration', value: 30 }])).items[0]!.offers[0]!;
  assert.equal(quote.price, '3.333333333333');
  assert.equal(quote.settlementQuantity, 3);
  assert.equal(quote.spec, '仅保首登1小时');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const cache = createCache();
  t.after(() => cache.disconnect());
  const service = new CatalogService(repository, cache);
  assert.ok((await service.getFacets({})).tagFacets.length > 0);
  assert.ok((await service.getCatalog({})).items[0]!.offers[0]!.tags.length > 0);
  const beforeVersion = (await sql<{ version: bigint }>`select version from catalog_cache_versions`.execute(db)).rows[0]!.version;
  await db.transaction().execute(async tx => {
    await sql`truncate product_tags`.execute(tx);
    await bumpCatalogVersion(tx);
  });
  await db.updateTable('products').set({ name: '成品号 独享 有质保30天 已接码' }).where('id', '=', source.id).execute();
  assert.deepEqual(await facts(), []);
  assert.deepEqual((await repository.facets({ tags: [] })).tagFacets, []);
  const untagged = await search([]);
  assert.ok(untagged.items.flatMap(item => item.detail?.entries ?? []).every(entry => 'tags' in entry && entry.tags.length === 0));
  assert.equal(untagged.items[0]!.offers[0]!.settlementQuantity, 3);
  assert.ok((await sql<{ version: bigint }>`select version from catalog_cache_versions`.execute(db)).rows[0]!.version > beforeVersion);
  assert.deepEqual((await sql`select facet_tags, product_count::int from catalog_read_facet_counts`.execute(db)).rows,
    [{ facet_tags: '[]', product_count: 6 }]);
  t.mock.timers.tick(5000);
  assert.deepEqual((await service.getFacets({})).tagFacets, []);
  assert.ok((await service.getCatalog({})).items.every(item => item.offers.every(offer => offer.tags.length === 0)));
  const rollback = await migrator.migrateTo('037_catalog_membership_kinds_20261113');
  assert.match(String(rollback.error), /cannot be downgraded/);
  assert.deepEqual(await facts(), [], 'a refused downgrade leaves the current read model intact');
});

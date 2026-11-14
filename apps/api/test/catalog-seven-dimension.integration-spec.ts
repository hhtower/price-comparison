import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
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
import { isCanonicalProductTag, PRODUCT_TAG_RULES } from '@price-comparison/catalog/product-tag-policy';
import type { PurchaseTag } from '@price-comparison/catalog/purchase-attributes';

for (const upgrade of [false, true]) test(`seven-dimension read model: ${upgrade ? 'upgrade' : 'fresh install'}`, async t => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required');
  const schema = `tags_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  const db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: new Pool({
    connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public`, application_name: schema,
  }) }) });
  t.after(async () => {
    await db.destroy();
    await admin.query(`drop schema "${schema}" cascade`);
    await admin.end();
  });
  const migrator = new Migrator({ db, provider: migrationProvider, migrationTableSchema: schema });
  const initial = await (upgrade ? migrator.migrateTo('039_tag_workflow_20261114') : migrator.migrateToLatest());
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
  const facts = async () => (await sql<{ tags: PurchaseTag[] }>`select tags from catalog_product_facts
    where product_id = ${source.id}`.execute(db)).rows[0]!.tags;
  assert.deepEqual(await facts(), [], 'raw prose cannot generate facts');
  const repository = new CatalogRepository(db);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const cache = createCache();
  t.after(() => cache.disconnect());
  const service = new CatalogService(repository, cache);
  if (upgrade) {
    const hidden = { name: 'warranty', value: '不享受质保；如有问题请联系商家' };
    await db.insertInto('product_tags').values({
      product_id: source.id, name: hidden.name, value: jsonb(hidden.value),
    }).execute();
    const stored = await db.selectFrom('product_tags').selectAll().execute();
    assert.deepEqual(await facts(), [], '038 hides structurally valid approved warranty text');
    while (await publishNextCatalogChange(db)) {}
    assert.deepEqual((await service.getFacets({})).tagFacets, []);
    assert.deepEqual((await service.getCatalog({})).items[0]!.offers[0]!.tags, []);
    const before = (await sql<{ version: bigint }>`select version from catalog_cache_versions`.execute(db)).rows[0]!.version;
    const writer = await admin.connect();
    await writer.query('begin');
    await writer.query(`lock table "${schema}".catalog_cache_versions in row exclusive mode`);
    const migration = migrator.migrateToLatest();
    try {
      let retrying = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const activity = await admin.query(`select 1 from pg_stat_activity
          where application_name = $1 and wait_event = 'PgSleep'`, [schema]);
        if (activity.rowCount) { retrying = true; break; }
        await setTimeout(25);
      }
      assert.ok(retrying, '040 retries contention instead of waiting with a partial lock set');
      await writer.query(`lock table "${schema}".products in row exclusive mode nowait`);
    } finally {
      await writer.query('rollback');
      writer.release();
    }
    const result = await migration;
    if (result.error) throw result.error;
    assert.deepEqual(await facts(), [hidden], '040 restores existing approved text without retagging');
    assert.deepEqual(await db.selectFrom('product_tags').selectAll().execute(), stored, 'stored tags are neither converted nor deleted');
    assert.deepEqual((await sql`select tags from catalog_read_offers where product_id = ${source.id}`.execute(db)).rows,
      [{ tags: [hidden] }]);
    assert.deepEqual((await sql`select facet_tags::jsonb as facet_tags, product_count::int from catalog_read_facet_counts`.execute(db)).rows,
      [{ facet_tags: [hidden], product_count: 1 }]);
    assert.ok((await sql<{ version: bigint }>`select version from catalog_cache_versions`.execute(db)).rows[0]!.version > before);
    t.mock.timers.tick(5000);
    assert.ok((await service.getFacets({})).tagFacets.some(tag => tag.name === hidden.name && tag.value === hidden.value));
    assert.deepEqual((await service.getCatalog({})).items[0]!.offers[0]!.tags, [hidden]);
    const rollback = await migrator.migrateTo('039_tag_workflow_20261114');
    assert.match(String(rollback.error), /cannot be downgraded/);
    assert.deepEqual(await facts(), [hidden], 'refused rollback must not silently hide approved facts');
  }
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
  const accepted: { name: string; value: unknown }[] = [
    ...valid, ...[0.5, 2, 90, 360, 365, { kind: 'range', min: 30, max: 90 }, { kind: 'min', days: 30 },
      { kind: 'max', days: 90 }, { kind: 'approx', days: 30 }, { kind: 'permanent' },
      36500, { kind: 'range', min: 0.5, max: 36500 },
      ...['min', 'max', 'approx'].map(kind => ({ kind, days: 36500 })),
    ].map(value => ({ name: 'duration', value })),
    ...Object.entries(PRODUCT_TAG_RULES).flatMap(([name, rule]) => (rule.values ?? []).map(value => ({ name, value }))),
    { name: 'supported_client', value: 'x'.repeat(80) }, { name: 'warranty', value: 'x'.repeat(250) },
    ...[
      'covered', 'none', 'unknown', 'unspecified', '有质保', '有售后', '无售后', '无质保', '不保',
      '不质保', '不提供售后', '不提供质保', '未说明', '质保未说明',
      '不享受质保', '质保已过期', '本商品不提供售后。', '无售后，售出不退',
      '本商品不保订阅30天', '质保30天，质保到期后不再免费换货',
      '仅保首登1小时，后续无售后', '保订阅30天，封号不保',
      '保修结束，支持退款', 'Warranty has expired; refund available',
      'no warranty', 'warranty expired', '质保unknown', '无任何保障，仅保首登1小时',
      '30 day warranty, bans not covered', '30 day warranty; no refund',
      'no warranty\nreplacement within 1 hour', '商家说明', '联系卖家协商处理', '售后按实际情况处理',
    ].map(value => ({ name: 'warranty', value })),
  ];
  const rejected: { name: string; value: unknown }[] = [
    ...['30', '1 month', 0, -1, 36501, null, [], {}, true, { kind: 'range', min: 30, max: 30 },
      { kind: 'range', min: 90, max: 30 }, { kind: 'range', min: 0, max: 30 },
      { kind: 'range', min: 30, max: 36501 }, { kind: 'range', min: '30', max: 90 },
      { kind: 'range', min: 30, max: '90' }, { kind: 'range', min: 30 },
      { kind: 'range', max: 90 }, { kind: 'range', min: 30, max: 90, extra: true },
      { kind: 'permanent', days: 30 }, { kind: 'other', days: 30 },
      ...['min', 'max', 'approx'].flatMap(kind => [
        { kind }, { kind, days: 30, extra: true },
        ...[0, -1, 36501, '30', null, [], {}, true].map(days => ({ kind, days })),
      ]),
      ...[[], ['min'], ['max'], ['approx'], {}, null, 1, true].map(kind => ({ kind, days: 30 })),
    ].map(value => ({ name: 'duration', value })),
    ...Object.keys(PRODUCT_TAG_RULES).filter(name => name !== 'duration').flatMap(name =>
      [null, [], {}, true, 30, '', ' ', '\t', ' x', 'x ', '\nx', 'x\n', '\tx', 'x\t', 'x'.repeat(251)]
        .map(value => ({ name, value }))),
    { name: 'supported_client', value: 'x'.repeat(81) }, { name: 'supported_client', value: 'Codex' },
    { name: 'subscription_override', value: '有' }, { name: 'sms_verification', value: 'unknown' },
    { name: 'region', value: '美国' }, { name: 'access_channel', value: 'other' },
    { name: 'bulk_purchase', value: 'other' }, { name: 'warranty_days', value: '30' },
    { name: 'access', value: 'dedicated' }, { name: 'delivery', value: 'account' },
    { name: '', value: 'text' }, { name: 'constructor', value: 'text' },
  ];
  for (const [samples, expected] of [[accepted, true], [rejected, false]] as const) for (const tag of samples) {
    const result = await sql<{ valid: boolean; tags: PurchaseTag[] }>`select
      catalog_valid_tag(${tag.name}, ${jsonb(tag.value)}) as valid,
      catalog_readable_facets(${jsonb([tag])}) as tags`.execute(db);
    assert.equal(result.rows[0]!.valid, expected, JSON.stringify(tag));
    assert.equal(isCanonicalProductTag(tag), expected, JSON.stringify(tag));
    assert.deepEqual(result.rows[0]!.tags, expected ? [tag] : [], JSON.stringify(tag));
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
  t.mock.timers.tick(5000);
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
  const rollback = await migrator.migrateTo('039_tag_workflow_20261114');
  assert.match(String(rollback.error), /cannot be downgraded/);
  assert.deepEqual(await facts(), [], 'a refused downgrade leaves the current read model intact');
});

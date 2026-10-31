import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test, type TestContext } from 'node:test';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { createPostgresPool } from '../src/database/database.providers.js';
import type { DatabaseSchema } from '../src/database/types.js';
import { jsonb } from '../src/database/types.js';
import { migrateToLatest } from '../scripts/migrate.js';
import { CatalogRepository, encodeCatalogCursor, decodeCatalogCursor, type CatalogItem } from '../src/catalog/catalog.repository.js';
import { CatalogService, normalizeCatalogQuery } from '../src/catalog/catalog.service.js';
import { bumpCatalogVersion, CatalogVersionRepository } from '../src/catalog/catalog-version.repository.js';
import { createCache } from '../src/cache/cache.js';
import { ProductsRepository } from '../src/products/products.repository.js';
import { assertCatalogPlan } from './fixtures/catalog-plan.js';
import { PURCHASE_ATTRIBUTE_DEFINITIONS } from '@price-comparison/catalog/purchase-attributes';
import { defaultQuotePolicy } from '../src/catalog/quote-policy.js';
import { mergeShopObservation } from '../src/shops/shop-rating.js';
import { TEXT_REVIEW_VERSION } from '../src/shops/shop-text-review.js';

const quotePolicy = { now: () => Date.now(), ttlMs: 3 * 3_600_000 };

function detailOffers(item: CatalogItem) {
  const detail = item?.detail;
  assert.ok(detail?.kind === 'offers');
  return detail.entries;
}

describe('catalog SQL read model', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let adminPool: Pool;
  let database: Kysely<DatabaseSchema>;
  let schemaName: string;
  let repository: CatalogRepository;
  const statements: string[] = [];
  let versions: CatalogVersionRepository;
  let shopOne: bigint;
  let standardOne: bigint;
  let standardTwo: bigint;
  let productOne: bigint;
  let productTwo: bigint;
  let productThree: bigint;

  before(async () => {
    if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    else {
      container = await new PostgreSqlContainer('postgres:16-alpine').start();
      process.env.DATABASE_URL = container.getConnectionUri();
    }
    schemaName = `task4_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    adminPool = new Pool({ connectionString: process.env.DATABASE_URL });
    await adminPool.query(`create schema "${schemaName}"`);
    process.env.PG_SCHEMA = schemaName;
    const pool = createPostgresPool();
    database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }), log: event => { if (event.level === 'query') statements.push(event.query.sql); } });
    await migrateToLatest(database);
    repository = new CatalogRepository(database, quotePolicy);
    versions = new CatalogVersionRepository(database);
  });

  beforeEach(async context => {
    (context as TestContext).mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-10T03:00:00Z') });
    await database.deleteFrom('offers').execute();
    await database.deleteFrom('product_tags').execute();
    await database.deleteFrom('standard_product_members').execute();
    await database.deleteFrom('products').execute();
    await database.deleteFrom('standard_products').execute();
    await database.deleteFrom('shops').execute();
    await database.updateTable('catalog_cache_versions').set({ version: 1n }).where('id', '=', 1).execute();

    const shop = await database.insertInto('shops').values({
      platform: 'alpha', protocol: 'dujiaoka', url: 'https://catalog-shop.invalid', name: 'Catalog shop', enabled: true,
      last_fetch_at: null, last_error: null, deleted_at: null,
    }).returning('id').executeTakeFirstOrThrow();
    shopOne = shop.id;
    const standards = await database.insertInto('standard_products').values([
      { name: 'Widget One', platform: 'Alpha', sort_order: 1n, verification_state: 'verified' },
      { name: 'Widget Two', platform: 'Alpha', sort_order: 2n, verification_state: 'verified' },
    ]).returning('id').execute();
    standardOne = standards[0]!.id;
    standardTwo = standards[1]!.id;
    const products = await database.insertInto('products').values([
      { shop_id: shop.id, external_id: 'one', name: 'Widget One source', spec: 'large', source_category: '', source_data: jsonb({}), normalized_key: 'widget-one', url: 'https://catalog.invalid/one', image_url: null, updated_at: new Date(), deleted_at: null, standardization_locked: false },
      { shop_id: shop.id, external_id: 'two', name: 'Widget Two source', spec: 'small', source_category: '', source_data: jsonb({}), normalized_key: 'widget-two', url: 'https://catalog.invalid/two', image_url: null, updated_at: new Date(), deleted_at: null, standardization_locked: false },
      { shop_id: shop.id, external_id: 'three', name: 'Hidden source', spec: 'x', source_category: '', source_data: jsonb({}), normalized_key: 'hidden', url: 'https://catalog.invalid/three', image_url: null, updated_at: new Date(), deleted_at: null, standardization_locked: false },
    ]).returning('id').execute();
    productOne = products[0]!.id;
    productTwo = products[1]!.id;
    productThree = products[2]!.id;
    await database.insertInto('standard_product_members').values([
      { standard_product_id: standardOne, product_id: productOne, created_at: new Date() },
      { standard_product_id: standardTwo, product_id: productTwo, created_at: new Date() },
      { standard_product_id: standardOne, product_id: productThree, created_at: new Date() },
    ]).execute();
    await database.insertInto('product_tags').values([
      { product_id: productOne, name: 'color', value: 'red' },
      { product_id: productOne, name: 'size', value: 'large' },
      { product_id: productTwo, name: 'color', value: 'red' },
    ]).execute();
    await database.insertInto('offers').values([
      { idempotency_key: 'one-old', product_id: productOne, price: '20.00', currency: 'CNY', captured_at: new Date('2026-09-10T00:00:00Z'), is_stale: false, stock_available: true },
      { idempotency_key: 'one-new', product_id: productOne, price: '10.00', currency: 'CNY', captured_at: new Date('2026-09-10T01:00:00Z'), is_stale: false, stock_available: true },
      { idempotency_key: 'two-stale', product_id: productTwo, price: '5.00', currency: 'CNY', captured_at: new Date('2026-09-10T01:00:00Z'), is_stale: true, stock_available: true },
      { idempotency_key: 'two-visible', product_id: productTwo, price: '6.00', currency: 'CNY', captured_at: new Date('2026-09-10T02:00:00Z'), is_stale: false, stock_available: true },
      { idempotency_key: 'three-old', product_id: productThree, price: '4.00', currency: 'CNY', captured_at: new Date('2026-09-10T01:00:00Z'), is_stale: false, stock_available: true },
      { idempotency_key: 'three-out', product_id: productThree, price: '3.00', currency: 'CNY', captured_at: new Date('2026-09-10T01:00:00Z'), is_stale: false, stock_available: false },
    ].map(offer => ({ ...offer, settlement_price: offer.price, settlement_verified_at: offer.captured_at, settlement_payment_method: 'alipay' }))).execute();
  });

  after(async () => {
    await database?.destroy();
    if (adminPool && schemaName) {
      await adminPool.query(`drop schema if exists "${schemaName}" cascade`);
      await adminPool.end();
    }
    await container?.stop();
    delete process.env.PG_SCHEMA;
  });

  async function addSku(shopId: bigint, externalId: string, price: string, tags: { name: string; value: string }[] = []) {
    const product = await database.insertInto('products').values({
      shop_id: shopId, external_id: externalId, name: `Widget ${externalId}`, spec: externalId,
      normalized_key: externalId, url: `https://catalog.invalid/${externalId}`, image_url: null, deleted_at: null,
    }).returning('id').executeTakeFirstOrThrow();
    await database.insertInto('standard_product_members').values({ standard_product_id: standardOne, product_id: product.id }).execute();
    if (tags.length) await database.insertInto('product_tags').values(tags.map(tag => ({ ...tag, product_id: product.id }))).execute();
    await database.insertInto('offers').values({
      idempotency_key: `sku-${product.id}`, product_id: product.id, price, captured_at: new Date(), currency: 'CNY',
      settlement_price: price === 'NaN' ? null : price, settlement_verified_at: price === 'NaN' ? null : new Date(), settlement_payment_method: price === 'NaN' ? null : 'alipay',
    }).execute();
    return product.id;
  }

  test('catalog lists stay bounded when one shop has many SKUs and a large rating manifest', async () => {
    for (let i = 0; i < 600; i++) await addSku(shopOne, `bounded-${i}`, '15.00');
    await database.updateTable('shops').set({ rating_manifest: jsonb({
      sourceUrl: 'https://catalog-shop.invalid', sourceProtocol: 'dujiaoka', sourcePlatform: 'alpha',
      observedAt: Date.now(), units: Array.from({ length: 5000 }, (_, i) => ({ unitId: `unit-${i}`, hash: 'a'.repeat(64) })),
    }) }).where('id', '=', shopOne).execute();
    const duplicated = await sql<{ bytes: bigint }>`select
      pg_column_size(jsonb_build_object('manifest', rating_manifest))::bigint * 601 as bytes
      from shops where id = ${shopOne}`.execute(database);
    assert.ok(duplicated.rows[0]!.bytes > 268435455n, 'the old repeated manifests would exceed the JSONB array limit');
    let wireBytes = 0;
    const measured = database.withPlugin({
      transformQuery: args => args.node,
      async transformResult(args) {
        wireBytes += Buffer.byteLength(JSON.stringify(args.result.rows, (_key, value) => typeof value === 'bigint' ? String(value) : value));
        return args.result;
      },
    });
    const page = await new CatalogRepository(measured, quotePolicy).search({ tags: [], limit: 1 });
    assert.equal(page.items[0]?.productCount, 601);
    assert.equal(page.items[0]?.offers.length, 1);
    assert.equal('allOffers' in page.items[0]!, false);
    assert.ok(wireBytes < 1024 * 1024, `one manifest must be sent once, received ${wireBytes} bytes`);
    const ids: string[] = [];
    for (let detailPage = 0; detailPage < 13; detailPage++) {
      const detail = await repository.search({ tags: [], limit: 1, standardProductId: String(standardOne),
        detailKind: 'offers', detailPage, detailPageSize: 50 });
      assert.equal(detail.items[0]?.detail?.total, 601);
      ids.push(...detail.items[0]!.detail!.entries.map(entry => (entry as { productId: string }).productId));
    }
    assert.equal(new Set(ids).size, 601);
  });

  test('duplicate text reviews transfer once per content key and cached reads preserve late conflicts', async () => {
    const source = { url: 'https://catalog-shop.invalid', protocol: 'dujiaoka', platform: 'alpha' };
    const text = { unitId: 'shared-parent', name: '套餐', description: 'x'.repeat(32768), hash: 'a'.repeat(64) };
    const review = {
      answers: Object.fromEntries(['L1','L2','L3','R1','R2','R3','A1','A2'].map(key => [key,
        { value: true, reason: '明确说明', evidence: [{ field: 'name', quote: text.name }] }])),
      consistency: Object.fromEntries(['C1','C2','C3','C4','C5','C6'].map(key => [key,
        { value: false, reason: '无冲突', evidence: [] }])),
    };
    await database.updateTable('shops').set({ rating_manifest: jsonb({
      sourceUrl: source.url, sourceProtocol: source.protocol, sourcePlatform: source.platform,
      observedAt: Date.now(), units: [{ unitId: text.unitId, hash: text.hash }, { unitId: 'unknown', hash: null }],
    }) }).where('id', '=', shopOne).execute();
    await database.insertInto('products').values(Array.from({ length: 130 }, (_, i) => ({
      shop_id: shopOne, external_id: `review-${i}`, name: 'Review source', spec: '',
      normalized_key: `review-${i}`, url: `https://catalog.invalid/review-${i}`,
      content_version: BigInt(i + 1), content_fingerprint: i.toString(16).padStart(64, '0'), source_data: jsonb({ ratingText: text }),
      text_review: jsonb({ version: TEXT_REVIEW_VERSION, contentVersion: String(i + 1), fingerprint: i.toString(16).padStart(64, '0'),
        source, textHash: text.hash, review: i === 129
          ? { ...review, answers: { ...review.answers, L1: { value: false, reason: '未明确', evidence: [] } } } : review }),
    }))).execute();
    let maxBatchBytes = 0;
    let wireBytes = 0;
    let reviewRows = 0;
    let published = false;
    const measured = database.withPlugin({
      transformQuery: args => args.node,
      async transformResult(args) {
        const bytes = Buffer.byteLength(JSON.stringify(args.result.rows));
        maxBatchBytes = Math.max(maxBatchBytes, bytes);
        wireBytes += bytes;
        reviewRows += args.result.rows.filter(row => row.kind === 2).length;
        if (!published && args.result.rows.some(row => row.kind === 0)) {
          published = true;
          await database.updateTable('products').set({ text_review: jsonb({
            version: TEXT_REVIEW_VERSION, contentVersion: '130', fingerprint: (129).toString(16).padStart(64, '0'),
            source, textHash: text.hash, review,
          }) }).where('shop_id', '=', shopOne).where('external_id', '=', 'review-129').execute();
        }
        return args.result;
      },
    });
    const reader = new CatalogRepository(measured, quotePolicy);
    const page = await reader.search({ tags: [], limit: 1 });
    assert.deepEqual(page.items[0]?.offers[0]?.shopScoreDetails?.text,
      { total: 2, reviewed: 0, disclosureContribution: '0.00', consistencyContribution: '0.00' });
    assert.ok(maxBatchBytes < 3 * 1024 * 1024, `review bodies must not form one result array: ${maxBatchBytes}`);
    assert.equal(reviewRows, 2, 'identical SKUs share a review, but a different late judgment must remain');
    assert.ok(wireBytes < 128 * 1024, `duplicate bodies must not cross the wire: ${wireBytes}`);
    assert.equal(published, true);
    wireBytes = 0;
    reviewRows = 0;
    const after = await reader.search({ tags: [], limit: 1 });
    assert.equal(after.items[0]?.offers[0]?.shopScoreDetails?.text?.reviewed, 1,
      'a review published between FETCH batches only belongs to the next catalog snapshot');
    assert.equal(reviewRows, 1);
    assert.ok(wireBytes < 8 * 1024, `a cached review only needs its key: ${wireBytes}`);
    const plan = await repository.explain({ tags: [], limit: 1 });
    const sortSizes: number[] = [];
    const visit = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      if ('Sort Space Used' in value) sortSizes.push(Number(value['Sort Space Used']));
      for (const child of Object.values(value)) {
        if (Array.isArray(child)) child.forEach(visit);
        else visit(child);
      }
    };
    visit(plan);
    assert.ok(sortSizes.every(size => size < 256), `database sorts must not contain review bodies: ${sortSizes} KiB`);
  });

  test('expired shop manifests do not load text review bodies', async () => {
    const product = await database.selectFrom('products').select(['content_version', 'content_fingerprint'])
      .where('id', '=', productOne).executeTakeFirstOrThrow();
    await database.updateTable('shops').set({ rating_manifest: jsonb({
      sourceUrl: 'https://catalog-shop.invalid', sourceProtocol: 'dujiaoka', sourcePlatform: 'alpha',
      observedAt: Date.now() - 86_400_000, units: [{ unitId: 'expired', hash: 'a'.repeat(64) }],
    }) }).where('id', '=', shopOne).execute();
    const keyed = await database.updateTable('products').set({
      source_data: jsonb({ ratingText: { unitId: 'expired', name: 'Expired', description: 'x'.repeat(32768), hash: 'a'.repeat(64) } }),
      text_review: jsonb({ contentVersion: String(product.content_version), fingerprint: product.content_fingerprint, obsolete: true }),
    }).where('id', '=', productOne).returning('text_review_key').executeTakeFirstOrThrow();
    assert.ok(keyed.text_review_key, 'the expired manifest, not an invalid evidence binding, must exclude this review');
    let reviewRows = 0;
    const measured = database.withPlugin({
      transformQuery: args => args.node,
      async transformResult(args) {
        reviewRows += args.result.rows.filter(row => row.kind === 2).length;
        return args.result;
      },
    });
    const page = await new CatalogRepository(measured, quotePolicy).search({ tags: [], limit: 1 });
    assert.equal(page.items[0]?.offers[0]?.shopScoreDetails?.text, undefined);
    assert.equal(reviewRows, 0);
  });

  test('review content keys track every validation input and exclude unrelated source metadata', async () => {
    const text = { unitId: 'keyed', name: 'Plan', description: 'Complete description', hash: 'a'.repeat(64) };
    const stored = { version: TEXT_REVIEW_VERSION, contentVersion: '1', fingerprint: 'b'.repeat(64), marker: 'original' };
    const original = { content_version: 1n, content_fingerprint: 'b'.repeat(64),
      source_data: jsonb({ ratingText: text }), text_review: jsonb(stored) };
    const key = async (changes: Partial<typeof original> = {}) =>
      (await database.updateTable('products').set({ ...original, ...changes }).where('id', '=', productOne)
        .returning('text_review_key').executeTakeFirstOrThrow()).text_review_key;
    const initial = await key();
    assert.match(initial!, /^[a-f0-9]{64}$/u);
    assert.equal(await key({ source_data: jsonb({ ratingText: text, unrelated: 'metadata' }) }), initial);
    for (const changes of [
      { content_version: 2n }, { content_fingerprint: 'c'.repeat(64) },
      { source_data: jsonb({ ratingText: { ...text, description: 'Changed source text' } }) },
      { text_review: jsonb({ ...stored, marker: 'changed' }) },
    ]) assert.notEqual(await key(changes), initial);
    assert.equal(await key(), initial);
    assert.equal(await key({ content_version: 2n, content_fingerprint: 'c'.repeat(64),
      text_review: jsonb({ ...stored, contentVersion: '2', fingerprint: 'c'.repeat(64) }) }), initial,
    'different SKUs with valid evidence bindings can share the same reviewed text');
    assert.equal(await key({ text_review: jsonb({ ...stored, contentVersion: 1 }) }), null,
      'a numeric stored version must not bypass the string version contract');
    const cleared = await database.updateTable('products').set({ text_review: null }).where('id', '=', productOne)
      .returning('text_review_key').executeTakeFirstOrThrow();
    assert.equal(cleared.text_review_key, null);
  });

  test('failed catalog reads close their cursor and restore the caller transaction settings', async () => {
    const failure = new Error('interrupted catalog consumer');
    await database.transaction().execute(async tx => {
      await sql`set local jit = on`.execute(tx);
      const interrupted = tx.withPlugin({
        transformQuery: args => args.node,
        async transformResult(args) {
          if (args.result.rows.some(row => row.kind === 0)) throw failure;
          return args.result;
        },
      });
      await assert.rejects(new CatalogRepository(interrupted, quotePolicy).search({ tags: [], limit: 1 }),
        error => error === failure);
      assert.equal((await sql<{ jit: string }>`show jit`.execute(tx)).rows[0]?.jit, 'on');
      assert.equal((await sql<{ count: number }>`select count(*)::int as count from pg_cursors
        where name like 'catalog_%'`.execute(tx)).rows[0]?.count, 0);
      assert.equal((await new CatalogRepository(tx, quotePolicy).search({ tags: [], limit: 1 })).items.length, 1);
    });
  });

  test('shop scores stay identical in every catalog shape and expire without exposing source observations', async () => {
    const source = { url: 'https://catalog-shop.invalid', protocol: 'dujiaoka' };
    const now = Date.now();
    const state = mergeShopObservation(null, source, { deposit: { amountMinor: 10000, currency: 'CNY', purpose: null },
      volume: 1000, counterDefinition: 'public_display_count', observedAt: new Date(now - 86_370_000).toISOString() }, now);
    await database.updateTable('shops').set({ shop_rating: jsonb(state) }).where('id', '=', shopOne).execute();
    for (const input of [{}, { search: 'Widget' }, {},
      { standardProductId: String(standardOne), detailKind: 'offers' as const },
      { standardProductId: String(standardOne), detailKind: 'shops' as const }]) {
      const page = await repository.search({ ...input, tags: [], limit: 10 });
      const offers = page.items.flatMap(item => [...item.offers,
        ...(item.detail?.entries ?? []).map(entry => 'offer' in entry ? entry.offer : entry)]);
      assert.ok(offers.length > 0);
      assert.ok(offers.every(offer => offer.shopScore === '33.75'));
      for (const offer of offers) assert.deepEqual(offer.shopScoreDetails, {
        deposit: { amountMinor: 10000, currency: 'CNY', contribution: '18.75' },
        volume: { count: 1000, unit: 'count', contribution: '15.00' },
      });
      assert.equal(page.nextExpiryAt, new Date(now + 30000).toISOString());
      assert.ok(!JSON.stringify(page).includes('_shopRating'));
      assert.ok(!JSON.stringify(page).includes('public_display_unverified'));
    }
    const later = new CatalogRepository(database, { ...quotePolicy, now: () => now + 30000 });
    assert.ok((await later.search({ tags: [], limit: 10 })).items.every(item => item.offers.every(offer => offer.shopScore === null && offer.shopScoreDetails === null)));
    await database.updateTable('shops').set({ name: 'Renamed' }).where('id', '=', shopOne).execute();
    assert.notEqual((await database.selectFrom('shops').select('shop_rating').where('id', '=', shopOne).executeTakeFirstOrThrow()).shop_rating, null);
    await database.updateTable('shops').set({ protocol: '16688' }).where('id', '=', shopOne).execute();
    assert.equal((await database.selectFrom('shops').select('shop_rating').where('id', '=', shopOne).executeTakeFirstOrThrow()).shop_rating, null);
  });

  test('text rating uses the complete source manifest across searches and invalidates changed content', async () => {
    const source = { url: 'https://catalog-shop.invalid', protocol: 'dujiaoka', platform: 'alpha' };
    const text = { unitId: 'source-product', name: '月度套餐', description: '交付账号', hash: 'a'.repeat(64) };
    const review = { answers: Object.fromEntries(['L1','L2','L3','R1','R2','R3','A1','A2'].map(key => [key,
      { value: true, reason: '明确说明', evidence: [{ field: 'name', quote: text.name }] }])),
    consistency: Object.fromEntries(['C1','C2','C3','C4','C5','C6'].map(key => [key,
      { value: false, reason: '完整审核未见冲突', evidence: [] }])) };
    const product = await database.updateTable('products').set({ source_data: jsonb({ ratingText: text }),
      content_fingerprint: 'b'.repeat(64) }).where('id', '=', productOne).returningAll().executeTakeFirstOrThrow();
    const stored = { version: TEXT_REVIEW_VERSION, contentVersion: String(product.content_version),
      fingerprint: product.content_fingerprint, source, textHash: text.hash, review };
    await database.updateTable('products').set({ text_review: jsonb(stored) }).where('id', '=', productOne).execute();
    await database.updateTable('shops').set({ rating_manifest: jsonb({ sourceUrl: source.url, sourceProtocol: source.protocol,
      sourcePlatform: source.platform, observedAt: Date.now(), units: [{ unitId: text.unitId, hash: text.hash },
        { unitId: 'unpublished-product', hash: null }] }) }).where('id', '=', shopOne).execute();
    for (const input of [{}, { search: 'Widget One' }, {},
      { standardProductId: String(standardOne), detailKind: 'offers' as const },
      { standardProductId: String(standardOne), detailKind: 'shops' as const }]) {
      const page = await repository.search({ ...input, tags: [], limit: 10 });
      const offers = page.items.flatMap(item => [...item.offers,
        ...(item.detail?.entries ?? []).map(entry => 'offer' in entry ? entry.offer : entry)]);
      assert.ok(offers.length);
      assert.ok(offers.every(offer => offer.shopScore === '10.00'));
      assert.deepEqual(offers[0]!.shopScoreDetails?.text, { total: 2, reviewed: 1,
        disclosureContribution: '9.00', consistencyContribution: '1.00' });
      assert.ok(!JSON.stringify(page).includes(text.hash));
    }
    const sku = await addSku(shopOne, 'same-source-sku', '50.00');
    await database.updateTable('products').set({ source_data: jsonb({ ratingText: text }), content_fingerprint: product.content_fingerprint,
      content_version: product.content_version, text_review: jsonb(stored) }).where('id', '=', sku).execute();
    assert.ok((await repository.search({ tags: [], limit: 10 })).items.every(item => item.offers.every(offer => offer.shopScore === '10.00')));
    await database.updateTable('products').set({ content_version: product.content_version + 1n }).where('shop_id', '=', shopOne).execute();
    const changed = await repository.search({ tags: [], limit: 10 });
    assert.ok(changed.items.every(item => item.offers.every(offer => offer.shopScore === '0.00')));
    await database.updateTable('shops').set({ protocol: '16688' }).where('id', '=', shopOne).execute();
    assert.equal((await database.selectFrom('shops').select('rating_manifest').where('id', '=', shopOne).executeTakeFirstOrThrow()).rating_manifest, null);
  });

  test('text rating reads manifest and reviews from one snapshot during concurrent publication', async () => {
    const source = { url: 'https://catalog-shop.invalid', protocol: 'dujiaoka', platform: 'alpha' };
    const text = { unitId: 'one', name: '套餐', description: '账号', hash: 'a'.repeat(64) };
    const product = await database.updateTable('products').set({ source_data: jsonb({ ratingText: text }),
      content_fingerprint: 'b'.repeat(64) }).where('id', '=', productOne).returningAll().executeTakeFirstOrThrow();
    const manifest = { sourceUrl: source.url, sourceProtocol: source.protocol, sourcePlatform: source.platform,
      observedAt: Date.now(), units: [{ unitId: text.unitId, hash: text.hash }] };
    await database.updateTable('shops').set({ rating_manifest: jsonb(manifest) }).where('id', '=', shopOne).execute();
    const stored = { version: TEXT_REVIEW_VERSION, contentVersion: String(product.content_version),
      fingerprint: product.content_fingerprint, source, textHash: text.hash, review: {
        answers: Object.fromEntries(['L1','L2','L3','R1','R2','R3','A1','A2'].map(key => [key,
          { value: true, reason: '明确说明', evidence: [{ field: 'name', quote: text.name }] }])),
        consistency: Object.fromEntries(['C1','C2','C3','C4','C5','C6'].map(key => [key,
          { value: false, reason: '无冲突', evidence: [] }])),
      } };
    let changed = false;
    const concurrent = database.withPlugin({
      transformQuery: args => args.node,
      async transformResult(args) {
        if (!changed && args.result.rows.some(row => row.kind === 0)) {
          changed = true;
          await database.transaction().execute(async tx => {
            await tx.updateTable('shops').set({ rating_manifest: jsonb({ ...manifest,
              units: [...manifest.units, { unitId: 'new-unreviewed-parent', hash: null }] }) }).where('id', '=', shopOne).execute();
            await tx.updateTable('products').set({ text_review: jsonb(stored) }).where('id', '=', productOne).execute();
          });
        }
        return args.result;
      },
    });
    statements.length = 0;
    const page = await new CatalogRepository(concurrent, quotePolicy).search({ tags: [], limit: 10 });
    assert.ok(changed);
    assert.ok(page.items.every(item => item.offers.every(offer => offer.shopScore === '0.00')),
      'the old manifest must not be combined with a newly published review');
    assert.equal(statements.filter(statement => statement.startsWith('declare ')).length, 1);
    const next = await repository.search({ tags: [], limit: 10 });
    assert.ok(next.items.every(item => item.offers.every(offer => offer.shopScore === '10.00')));
  });

  test('newcomer mode filters actual offers before prices, totals, facets and detail pagination', async () => {
    const delivery = (value: string) => ({ name: 'delivery', value });
    const days = (value: number) => ({ name: 'warranty_days', value: String(value) });
    const topUp = await addSku(shopOne, 'newcomer-top-up', '30.00', [delivery('top_up'), days(30)]);
    const account = await addSku(shopOne, 'newcomer-account', '90.00', [delivery('account'), days(90)]);
    await addSku(shopOne, 'newcomer-short', '1.00', [delivery('account'), days(29)]);
    await addSku(shopOne, 'newcomer-unknown', '2.00', [delivery('top_up')]);
    await addSku(shopOne, 'newcomer-code', '3.00', [delivery('redemption'), days(90)]);
    {
      const page = await repository.search({ tags: [], newcomer: true, standardProductId: String(standardOne),
        detailKind: 'offers', detailPageSize: 50, limit: 20 });
      assert.equal(page.total, 1);
      assert.equal(page.offerTotal, 2);
      assert.equal(page.items[0]!.minPrice, '30.00');
      assert.equal(page.items[0]!.productCount, 2);
      assert.deepEqual(new Set(page.items[0]!.detail!.entries.map(offer => (offer as { productId: string }).productId)), new Set([String(topUp), String(account)]));
    }
    const detail = await repository.search({ tags: [], newcomer: true, standardProductId: String(standardOne),
      detailKind: 'offers', detailPageSize: 1, detailPage: 1, limit: 1 });
    assert.equal(detail.items[0]!.detail!.total, 2);
    assert.equal((detail.items[0]!.detail!.entries[0] as { productId: string }).productId, String(account));
    const stricter = await repository.search({ tags: [], newcomer: true, warrantyDaysMin: 90, limit: 20 });
    assert.equal(stricter.offerTotal, 1);
    assert.equal(stricter.items[0]!.minPrice, '90.00');
    assert.equal((await repository.search({ tags: [delivery('redemption')], newcomer: true, limit: 20 })).total, 0);
    const facets = await repository.facets({ tags: [], newcomer: true });
    assert.ok(facets.tagFacets.some(tag => tag.name === 'delivery' && tag.value === 'top_up'));
    assert.ok(facets.tagFacets.some(tag => tag.name === 'delivery' && tag.value === 'account'));
    assert.ok(!facets.tagFacets.some(tag => tag.name === 'delivery' && tag.value === 'redemption'));
    assert.ok(!facets.tagFacets.some(tag => tag.name === 'warranty_days' && tag.value === '29'));
  });

  test('orders all public products by approved platform and product order before pagination', async () => {
    const identities = [
      ['openai', 'chatgpt', 'free'], ['openai', 'chatgpt', 'plus'],
      ['openai', 'chatgpt', 'team'], ['openai', 'chatgpt', 'team_5x'],
      ['openai', 'codex', 'sms'], ['openai', 'codex', 'credits'], ['openai', 'chatgpt', 'tutorial'],
      ['anthropic', 'claude', 'pro'], ['anthropic', 'claude_sms', 'standard'],
      ['google', 'gemini', 'pro'], ['youtube', 'youtube', 'family'],
      ['google', 'gcp_account', 'standard'], ['google', 'google', 'sms'],
      ['xai', 'grok', 'plus'], ['xai', 'grok', 'premium'], ['xai', 'grok', 'super'], ['xai', 'grok', 'ultra'],
      ['xai', 'grok', 'heavy'], ['x', 'account', 'standard'], ['x', 'premium_membership', 'premium_plus'],
      ['cursor', 'cursor', 'pro_plus'], ['network', 'ip', 'standard'],
      ['google', 'email', 'standard'], ['microsoft', 'outlook', 'standard'],
      ['google', 'gmail_code_service', 'standard'], ['apple', 'icloud_mail', 'standard'],
    ];
    const ids: string[] = [];
    for (const [index, [family, product, tier]] of identities.entries()) {
      const standard = await database.insertInto('standard_products').values({
        name: `Approved ${family} / ${product} / ${tier}`, platform: family!,
        canonical_family: family!, canonical_product: product!, canonical_tier: tier!,
        sort_order: BigInt(100 - index), verification_state: 'verified',
      }).returning('id').executeTakeFirstOrThrow();
      const sku = await addSku(shopOne, `approved-${index}`, String(100 - index));
      await database.updateTable('standard_product_members').set({ standard_product_id: standard.id }).where('product_id', '=', sku).execute();
      ids.push(String(standard.id));
    }
    const expected = [...ids, String(standardOne), String(standardTwo)];
    {
      assert.deepEqual((await repository.search({ tags: [], limit: 100 })).items.map(item => item.id), expected);
      const combined = identities.flatMap(([family], index) => ['xai', 'x', 'cursor'].includes(family!) ? [ids[index]!] : []);
      for (const platform of ['xai', 'x', 'twitter', 'cursor']) {
        assert.deepEqual((await repository.search({ platform, tags: [], limit: 100 })).items.map(item => item.id), combined);
      }
      const paged: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await repository.search({ tags: [], limit: 3, ...(cursor ? { cursor } : {}) });
        paged.push(...page.items.map(item => item.id));
        cursor = page.nextCursor;
      } while (cursor);
      assert.deepEqual(paged, expected);
      assert.deepEqual((await repository.search({ platform: 'openai', tags: [], limit: 100 })).items.map(item => item.id), ids.slice(0, 7));
      assert.deepEqual((await repository.search({ platform: 'email', tags: [], limit: 100 })).items.map(item => item.id), ids.slice(22));
      assert.deepEqual((await repository.search({ search: 'Approved', tags: [], limit: 100 })).items.map(item => item.id), ids);
      assert.deepEqual((await repository.search({ sort: 'price', tags: [], limit: 100 })).items.map(item => item.id),
        [String(standardTwo), String(standardOne), ...ids.toReversed()]);
    }
    assert.deepEqual((await repository.publicProducts()).items.map(item => item.id), expected);
    const legacyCursor = encodeCatalogCursor({ sortOrder: 97n, standardProductId: BigInt(ids[3]!) });
    assert.deepEqual((await repository.search({ tags: [], limit: 100, cursor: legacyCursor })).items.map(item => item.id), expected.slice(4));
  });

  async function addOfferHistory() {
    // A sequential scan is reasonable for a six-row table and can appear after
    // auto-analyze. Plan assertions need enough history to exercise the index.
    await sql`
      insert into offers (idempotency_key, product_id, price, captured_at)
      select 'history-' || n, ${productOne}, 20, '2025-01-01'::timestamptz
      from generate_series(1, 5000) n
    `.execute(database);
    await sql`analyze offers`.execute(database);
  }

  test('public product metadata survives missing quotes and excludes non-public members and standards', async () => {
    await database.updateTable('standard_products').set({ name: 'openai / codex / sms', canonical_family: 'openai', canonical_product: 'codex', canonical_tier: 'sms' }).where('id', '=', standardOne).execute();
    await database.deleteFrom('offers').execute();
    assert.deepEqual(await repository.publicProducts(), { items: [
      { id: String(standardOne), name: 'Codex 手机接码', platform: 'Alpha', platformGroup: 'other', kind: '手机接码' },
      { id: String(standardTwo), name: 'Widget Two', platform: 'Alpha', platformGroup: 'other', kind: '其他' },
    ] });
    assert.equal((await repository.publicProduct(String(standardOne)))?.name, 'Codex 手机接码');
    await database.updateTable('standard_product_members').set({ publication_state: 'provisional' }).where('standard_product_id', '=', standardOne).execute();
    assert.equal(await repository.publicProduct(String(standardOne)), null);
    await database.updateTable('shops').set({ enabled: false }).where('id', '=', shopOne).execute();
    assert.deepEqual((await repository.publicProducts()).items, []);
    await database.updateTable('shops').set({ enabled: true }).where('id', '=', shopOne).execute();
    await database.updateTable('standard_product_members').set({ publication_state: 'published' }).execute();
    await database.updateTable('products').set({ deleted_at: new Date() }).where('id', 'in', [productOne, productThree]).execute();
    assert.equal(await repository.publicProduct(String(standardOne)), null);
    await database.updateTable('products').set({ deleted_at: null }).execute();
    await database.updateTable('shops').set({ deleted_at: new Date() }).where('id', '=', shopOne).execute();
    assert.deepEqual((await repository.publicProducts()).items, []);
    await database.updateTable('shops').set({ deleted_at: null }).execute();
    for (const verification_state of ['provisional', 'quarantined'] as const) {
      await database.updateTable('standard_products').set({ verification_state }).where('id', '=', standardOne).execute();
      assert.equal(await repository.publicProduct(String(standardOne)), null);
      assert.deepEqual((await repository.publicProducts()).items.map(item => item.id), [String(standardTwo)]);
    }
    await database.updateTable('standard_products').set({ verification_state: 'verified' }).where('id', '=', standardOne).execute();
    await database.updateTable('standard_products').set({ hidden: true }).where('id', '=', standardOne).execute();
    assert.equal(await repository.publicProduct(String(standardOne)), null);
    await database.updateTable('standard_products').set({ merged_into_id: standardTwo }).where('id', '=', standardOne).execute();
    assert.equal((await repository.publicProduct(String(standardOne)))?.mergedIntoId, String(standardTwo));
    assert.deepEqual((await repository.publicProducts()).items.map(item => item.id), [String(standardTwo)]);
    await database.updateTable('standard_products').set({ hidden: true }).where('id', '=', standardTwo).execute();
    assert.equal(await repository.publicProduct(String(standardOne)), null);
  });

  test('public directory explicitly fails beyond its 10000 metadata limit', async () => {
    await sql`insert into standard_products(name, platform, verification_state) select 'bulk-' || n, 'Alpha', 'verified' from generate_series(1, 9999) n`.execute(database);
    await sql`insert into products(shop_id, external_id, name, normalized_key, url) select ${shopOne}, 'bulk-' || sp.id, sp.name, 'bulk-' || sp.id, 'https://catalog.invalid/' || sp.id from standard_products sp where sp.name like 'bulk-%'`.execute(database);
    await sql`insert into standard_product_members(standard_product_id, product_id) select sp.id, p.id from standard_products sp join products p on p.name = sp.name where sp.name like 'bulk-%'`.execute(database);
    await assert.rejects(() => repository.publicProducts(), /10000/);
  });

  for (const query of [
    {},
    { search: 'Widget' }, { search: 'Widget' },
    { detailKind: 'offers' as const }, { detailKind: 'shops' as const },
  ]) test(`exposes database settlement quantity and unit price without totals: ${JSON.stringify(query)}`, async () => {
    await sql`update offers set settlement_quantity = 5, settlement_price = 2.002,
      settlement_total_amount = 10.01 where idempotency_key = 'one-new'`.execute(database);
    await database.insertInto('product_tags').values({ product_id: productOne, name: 'minimum_quantity', value: '10' }).execute();
    const page = await repository.search({
      ...query, ...(query.detailKind ? { standardProductId: String(standardOne), detailPageSize: 1 } : {}),
      sort: 'price', tags: [], limit: 20,
    });
    assert.equal(page.items[0]?.id, String(standardOne), 'ranks the 2.002 unit price ahead of 6.00, not the 10.01 total');
    const item = page.items[0]!;
    assert.equal(item.minPrice, '2.002');
    const offers = [...item.offers,
      ...(item.detail?.entries.map(entry => 'offer' in entry ? entry.offer : entry) ?? [])];
    assert.ok(offers.length > 0);
    for (const offer of offers) {
      assert.equal(offer.productId, String(productOne));
      assert.equal(offer.settlementQuantity, 5);
      assert.equal(offer.price, '2.002');
      assert.equal(offer.independentShop, true, 'self-built protocol shops carry the risk marker');
      assert.equal('settlementTotalAmount' in offer, false);
      assert.equal('settlement_total_amount' in offer, false);
    }
    if (query.detailKind) assert.equal(item.detail?.entries.length, 1);
    else assert.equal(page.items[1]?.offers[0]?.settlementQuantity, 1, 'legacy null quantity defaults to one');
    for (const [quantity, total, price, expected] of [[null, null, '1', '1.00'], [1, '1.50', '1.5', '1.50'],
      [5, '0.01', '0.002', '0.002'], [3, '1.00', '0.333333333333', '0.333333333333']] as const) {
      await sql`update offers set settlement_quantity = ${quantity}, settlement_total_amount = ${total}::numeric, settlement_price = ${price}::numeric
        where idempotency_key = 'one-new'`.execute(database);
      const formatted = (await repository.search({ ...query, standardProductId: String(standardOne), tags: [], limit: 20 })).items[0]!;
      assert.equal(formatted.minPrice, expected);
      for (const offer of [...formatted.offers,
        ...(formatted.detail?.entries.map(entry => 'offer' in entry ? entry.offer : entry) ?? [])]) {
        assert.equal(offer.price, expected);
        assert.equal(offer.settlementQuantity, quantity ?? 1);
      }
    }
    await database.updateTable('shops').set({ protocol: '16688' }).where('id', '=', shopOne).execute();
    const marketplace = await repository.search({ sort: 'price', tags: [], limit: 20 });
    assert.ok(marketplace.items[0]!.offers.every(offer => offer.independentShop === false), 'marketplace protocols drop the risk marker');
  });

  test('payment prices and listed-price estimates rank together and all filters use the payable amount', async () => {
    const a = await addSku(shopOne, 'settlement-a', '90.00');
    const shop = await database.insertInto('shops').values({ platform: 'alpha', url: 'https://settlement-b.invalid', name: 'B' }).returning('id').executeTakeFirstOrThrow();
    const b = await addSku(shop.id, 'settlement-b', '95.00');
    const c = await addSku(shop.id, 'settlement-c', '1.00');
    await database.updateTable('offers').set({ settlement_price: null, settlement_verified_at: null, settlement_payment_method: null }).where('product_id', '=', c).execute();
    await database.updateTable('offers').set({ stock_available: false }).where('product_id', '=', productOne).execute();
    const now = new Date();
    await database.updateTable('offers').set({ settlement_price: '98.00', settlement_verified_at: now, settlement_payment_method: 'alipay', captured_at: now }).where('product_id', '=', a).execute();
    await database.updateTable('offers').set({ settlement_price: '95.00', settlement_verified_at: now, settlement_payment_method: 'alipay', captured_at: now }).where('product_id', '=', b).execute();
    const page = await repository.search({ standardProductId: String(standardOne), detailKind: 'offers', detailPageSize: 50, tags: [], limit: 20 });
    assert.equal(page.items[0]?.minPrice, '1.00');
    assert.deepEqual(page.items[0]?.offers.map(offer => offer.productId), [c, a].map(String));
    assert.deepEqual(detailOffers(page.items[0]!).map(offer => offer.productId).slice(0, 3), [c, b, a].map(String));
    assert.equal(detailOffers(page.items[0]!).find(offer => offer.productId === String(c))?.price, '1.00');
    const offerA = detailOffers(page.items[0]!).find(offer => offer.productId === String(a));
    assert.equal(offerA?.listedPrice, '90.00');
    assert.equal(offerA?.priceStatus, 'verified');
    assert.equal(offerA?.paymentMethod, 'alipay');
    {
      const filtered = await repository.search({ standardProductId: String(standardOne), detailKind: 'offers', detailPageSize: 50, priceMin: '96', priceMax: '99', tags: [], limit: 20 });
      assert.equal(filtered.offerTotal, 1);
      assert.equal(filtered.items[0]?.minPrice, '98.00');
      assert.deepEqual(filtered.items[0]?.offers.map(offer => offer.productId), [String(a)]);
    }
    for (const detailKind of ['offers', 'shops'] as const) {
      const filtered = await repository.search({ standardProductId: String(standardOne), detailKind, detailPageSize: 50, priceMin: '96', priceMax: '99', tags: [], limit: 20 });
      assert.equal(filtered.items[0]?.detail?.total, 1);
      const entry = filtered.items[0]?.detail?.entries[0];
      assert.equal(entry && ('offer' in entry ? entry.offer.price : entry.price), '98.00');
    }
    await database.insertInto('product_tags').values({ product_id: a, name: 'delivery', value: 'redemption' }).execute();
    assert.ok((await repository.facets({ priceMin: '96', priceMax: '99', tags: [] })).tagFacets.some(tag => tag.name === 'delivery' && tag.value === 'redemption'));
    assert.deepEqual((await repository.facets({ priceMax: '94', tags: [] })).tagFacets, []);
  });

  test('quote expiry is independent of crawler scheduling', () => {
    assert.equal(defaultQuotePolicy({ CRAWLER_TARGET_INTERVAL_MS: '2500' }).ttlMs, 8_100_000);
    assert.equal(defaultQuotePolicy({ CATALOG_QUOTE_TTL_MS: '900000' }).ttlMs, 900000);
  });

  test('payment expiry retains estimates in every read path until inventory expiry', async context => {
    await database.updateTable('products').set({ spec: '独享' }).where('id', '=', productOne).execute();
    const earlier = new Date(Date.now() - quotePolicy.ttlMs + 1);
    await database.updateTable('offers').set({ captured_at: new Date(), settlement_verified_at: earlier }).where('idempotency_key', '=', 'one-new').execute();
    await database.updateTable('offers').set({ captured_at: earlier, settlement_verified_at: new Date() }).where('product_id', '=', productTwo).execute();
    const before = await repository.search({ tags: [], sort: 'price', limit: 1 });
    assert.equal(Date.parse(before.nextExpiryAt!), Date.now() + 1, 'expiry includes the quote on a different catalog page');
    assert.equal(Date.parse((await repository.facets({ tags: [] })).nextExpiryAt!), Date.now() + 1);
    assert.equal(before.items[0]?.minPrice, '6.00');
    context.mock.timers.tick(1);
    {
      const page = await repository.search({ sort: 'price', tags: [], limit: 20 });
      assert.equal(page.total, 1);
      assert.deepEqual(page.items.map(item => item.minPrice), ['10.00']);
      assert.ok(page.items.every(item => item.offers[0]?.priceStatus === 'expired'));
      assert.equal(Date.parse(page.nextExpiryAt!), Date.now() - 1 + quotePolicy.ttlMs);
      assert.equal(Date.parse(page.items[0]!.offers[0]!.inventoryExpiresAt!), Date.parse(page.nextExpiryAt!));
      assert.equal(Date.parse(page.items[0]!.offers[0]!.priceVerifiedAt!), earlier.getTime());
      assert.equal((await repository.search({ priceMin: '0', tags: [], limit: 20 })).total, 1);
    }
    for (const detailKind of ['offers', 'shops'] as const) {
      const page = await repository.search({ standardProductId: String(standardOne), detailKind, tags: [], limit: 20 });
      const entry = page.items[0]?.detail?.entries[0];
      assert.equal(entry && ('offer' in entry ? entry.offer.priceStatus : entry.priceStatus), 'expired');
      assert.equal(page.items[0]?.minPrice, '10.00');
      assert.equal(entry && ('offer' in entry ? entry.offer.price : entry.price), '10.00');
    }
    const facets = await repository.facets({ priceMin: '0', tags: [] });
    assert.ok(facets.tagFacets.some(tag => tag.name === 'access' && tag.value === 'dedicated'));
    assert.equal(Date.parse(facets.nextExpiryAt!), Date.now() - 1 + quotePolicy.ttlMs);
    const stored = await database.selectFrom('offers').select('settlement_verified_at').where('idempotency_key', '=', 'one-new').executeTakeFirstOrThrow();
    assert.equal(new Date(stored.settlement_verified_at!).getTime(), earlier.getTime());
    context.mock.timers.tick(quotePolicy.ttlMs - 1);
    const afterStock = await repository.search({ tags: [], limit: 20 });
    assert.deepEqual(afterStock.items, []);
    assert.equal(afterStock.nextExpiryAt, null);
    assert.deepEqual((await repository.facets({ priceMin: '0', tags: [] })).tagFacets, []);
  });

  test('missing payment prices use explicit listed-price estimates across catalog views, filters and cursors', async () => {
    await database.updateTable('offers').set({ settlement_price: null, settlement_verified_at: null, settlement_payment_method: null }).execute();
    const newer = await addSku(shopOne, 'newer-unknown', '1.00');
    await database.updateTable('offers').set({ settlement_price: null, settlement_verified_at: null, settlement_payment_method: null }).where('product_id', '=', newer).execute();
    const first = await repository.search({ sort: 'price', tags: [], limit: 1 });
    assert.equal(first.items[0]?.minPrice, '1.00');
    assert.equal(first.items[0]?.offers[0]?.productId, String(newer));
    assert.equal(first.items[0]?.offers[0]?.priceStatus, 'estimated');
    assert.equal(first.items[0]?.offers[0]?.paymentMethod, '支付价（预估：售价）');
    assert.equal(first.items[0]?.offers[0]?.priceVerifiedAt, null);
    assert.equal(first.items[0]?.offers[0]?.priceExpiresAt, first.items[0]?.offers[0]?.inventoryExpiresAt);
    assert.equal(decodeCatalogCursor(first.nextCursor!).sortValue, '1.00');
    const next = await repository.search({ sort: 'price', tags: [], limit: 1, cursor: first.nextCursor });
    assert.equal(next.items[0]?.id, String(standardTwo));
    assert.equal(next.nextCursor, undefined);
    await database.updateTable('offers').set({ settlement_price: '99.00', settlement_verified_at: new Date(), settlement_payment_method: 'alipay' }).where('product_id', '=', productTwo).execute();
    const verifiedFirst = await repository.search({ sort: 'price', tags: [], limit: 20 });
    assert.deepEqual(verifiedFirst.items.map(item => item.id), [standardOne, standardTwo].map(String));
    for (const query of [{}, { detailKind: 'offers' }, { detailKind: 'shops' }] as const) {
      const page = await repository.search({ ...query, standardProductId: String(standardOne), priceMax: '2', tags: [], limit: 20 });
      assert.equal(page.offerTotal, 1);
      assert.equal(page.items[0]?.minPrice, '1.00');
      assert.equal(page.items[0]?.offers[0]?.priceStatus, 'estimated');
    }
    assert.equal((await database.selectFrom('offers').select('settlement_price').where('product_id', '=', newer).executeTakeFirstOrThrow()).settlement_price, null);
  });

  test('inventory expiry removes unpriced listings from every catalog view and restores only fresh enabled stock', async context => {
    await database.updateTable('offers').set({ captured_at: new Date(Date.now() - quotePolicy.ttlMs + 1),
      settlement_price: null, settlement_verified_at: null, settlement_payment_method: null }).execute();
    const cache = createCache({ ttl: 30_000 });
    const service = new CatalogService(repository, cache);
    try {
      assert.equal((await service.getCatalog({})).total, 2);
      assert.equal(Date.parse((await service.getCatalog({})).nextExpiryAt!), Date.now() + 1);
      assert.equal(Date.parse((await service.getFacets({})).nextExpiryAt!), Date.now() + 1);
      context.mock.timers.tick(1);
      assert.equal((await service.getCatalog({})).total, 0);
      assert.deepEqual((await service.getFacets({})).tagFacets, []);
      for (const query of [{}, { search: 'Widget' },
        { standardProductId: String(standardOne), detailKind: 'offers' },
        { standardProductId: String(standardOne), detailKind: 'shops' }] as const) {
        assert.equal((await repository.search({ ...query, tags: [], limit: 20 })).total, 0);
      }
      await database.updateTable('shops').set({ enabled: false }).where('id', '=', shopOne).execute();
      await database.updateTable('offers').set({ captured_at: new Date() }).where('idempotency_key', '=', 'one-new').execute();
      assert.equal((await repository.search({ tags: [], limit: 20 })).total, 0);
      await database.updateTable('shops').set({ enabled: true }).where('id', '=', shopOne).execute();
      assert.deepEqual((await repository.search({ tags: [], limit: 20 })).items.map(item => item.id), [String(standardOne)]);
    } finally { await cache.disconnect(); }
  });

  test('default CNY excludes cheaper foreign quotes while explicit currency preserves their verified price', async () => {
    const dollars = await addSku(shopOne, 'cheap-usd', '0.01', [{ name: 'delivery', value: 'redemption' }]);
    await database.updateTable('offers').set({ currency: 'USD' }).where('product_id', '=', dollars).execute();
    const cny = await repository.search({ tags: [], limit: 20 });
    assert.equal(cny.items[0]?.minPrice, '10.00');
    assert.ok(!cny.items[0]?.offers.some(offer => offer.productId === String(dollars)));
    assert.equal((await repository.search({ currency: 'USD', tags: [], limit: 20 })).items[0]?.minPrice, '0.01');
    assert.ok(!(await repository.facets({ tags: [] })).tagFacets.some(tag => tag.name === 'delivery' && tag.value === 'redemption'));
    assert.ok((await repository.facets({ currency: 'USD', tags: [] })).tagFacets.some(tag => tag.name === 'delivery' && tag.value === 'redemption'));
  });

  test('temporary shop failures retain the last verified quote until expiry without extending it', async () => {
    const before = await repository.search({ tags: [], limit: 20 });
    await database.updateTable('shops').set({ last_error: 'temporary timeout', last_fetch_at: new Date() }).where('id', '=', shopOne).execute();
    assert.deepEqual(await repository.search({ tags: [], limit: 20 }), before);
  });

  test('expiry covers nonwinning SKUs and shops outside the bounded preview', async () => {
    const nonwinner = await addSku(shopOne, 'nonwinning-early-expiry', '999');
    let outsidePreview = 0n;
    await database.updateTable('offers').set({ settlement_verified_at: new Date(Date.now() - quotePolicy.ttlMs + 1000) }).where('product_id', '=', nonwinner).execute();
    for (let i = 0; i < 5; i += 1) {
      const shop = await database.insertInto('shops').values({ platform: 'alpha', url: `https://expiry-${i}.invalid`, name: `Expiry ${i}` }).returning('id').executeTakeFirstOrThrow();
      const sku = await addSku(shop.id, `expiry-${i}`, String(100 + i));
      if (i === 4) {
        outsidePreview = sku;
        await database.updateTable('offers').set({ settlement_verified_at: new Date(Date.now() - quotePolicy.ttlMs + 500) }).where('product_id', '=', sku).execute();
      }
    }
    const summary = await repository.search({ tags: [], limit: 1 });
    assert.equal(summary.items[0]?.offers.length, 4);
    assert.ok(!summary.items[0]?.offers.some(offer => offer.name.includes('expiry-4') || offer.productId === String(nonwinner)));
    assert.equal(Date.parse(summary.nextExpiryAt!), Date.now() + 3_600_000,
      'hidden payment labels cannot invalidate a bounded preview');
    assert.equal(Date.parse((await repository.facets({ tags: [] })).nextExpiryAt!), Date.now() + 3_600_000);
    assert.equal(Date.parse((await repository.search({ standardProductId: String(standardOne), detailKind: 'offers',
      shopId: String(shopOne), tags: [], limit: 1 })).nextExpiryAt!), Date.now() + 1000);
    await database.updateTable('offers').set({ captured_at: new Date(Date.now() - quotePolicy.ttlMs + 500) })
      .where('product_id', '=', outsidePreview).execute();
    assert.equal(Date.parse((await repository.search({ tags: [], limit: 1 })).nextExpiryAt!), Date.now() + 500,
      'hidden inventory still changes exact totals');
  });

  test('search deadlines exclude unrelated quotes and empty matches need no expiry retry', async () => {
    await database.updateTable('offers').set({
      captured_at: new Date(Date.now() - quotePolicy.ttlMs + 10),
      settlement_verified_at: new Date(Date.now() - quotePolicy.ttlMs + 5),
    }).where('product_id', '=', productTwo).execute();
    {
      const page = await repository.search({ search: 'One source', tags: [], limit: 20 });
      assert.deepEqual(page.items.map(item => item.id), [String(standardOne)]);
      assert.equal(Date.parse(page.nextExpiryAt!), Date.now() + 3_600_000);
      const empty = await repository.search({ search: 'no-such-product', tags: [], limit: 20 });
      assert.equal(empty.total, 0);
      assert.equal(empty.nextExpiryAt, null);
    }
    const facets = await repository.facets({ search: 'One source', tags: [] });
    assert.equal(Date.parse(facets.nextExpiryAt!), Date.now() + 3_600_000);
    assert.equal((await repository.facets({ search: 'no-such-product', tags: [] })).nextExpiryAt, null);
  });

  test('facet deadlines follow inventory while matching page prices still refresh on verification expiry', async () => {
    await database.updateTable('offers').set({
      captured_at: new Date(Date.now() - quotePolicy.ttlMs + 10),
      settlement_verified_at: new Date(Date.now() - quotePolicy.ttlMs + 5),
    }).where('product_id', '=', productTwo).execute();
    const input = { search: 'Two source', tags: [] };
    const page = await repository.search({ ...input, limit: 20 });
    assert.equal(Date.parse(page.nextExpiryAt!), Date.now() + 5);
    assert.equal(Date.parse((await repository.facets(input)).nextExpiryAt!), Date.now() + 10);
  });

  test('cursor lookahead prices cannot invalidate the current page in either catalog view', async () => {
    await database.updateTable('offers').set({
      settlement_verified_at: new Date(Date.now() - quotePolicy.ttlMs + 5),
    }).where('idempotency_key', '=', 'two-visible').execute();
    {
      const first = await repository.search({ tags: [], limit: 1 });
      assert.deepEqual(first.items.map(item => item.id), [String(standardOne)]);
      assert.equal(Date.parse(first.nextExpiryAt!), Date.now() + 3_600_000);
      assert.ok(first.nextCursor, 'metadata lookahead must still preserve pagination');
      const second = await repository.search({ tags: [], limit: 1, cursor: first.nextCursor });
      assert.deepEqual(second.items.map(item => item.id), [String(standardTwo)]);
      assert.equal(Date.parse(second.nextExpiryAt!), Date.now() + 5);
    }
  });

  test('platform navigation keeps inventory deadlines from other matching platforms', async () => {
    await database.updateTable('standard_products').set({ platform: 'openai' }).where('id', '=', standardOne).execute();
    await database.updateTable('standard_products').set({ platform: 'anthropic' }).where('id', '=', standardTwo).execute();
    await database.updateTable('offers').set({
      captured_at: new Date(Date.now() - quotePolicy.ttlMs + 10),
      settlement_verified_at: new Date(Date.now() - quotePolicy.ttlMs + 5),
    }).where('product_id', '=', productTwo).execute();
    for (const search of [undefined, 'source']) {
      const page = await repository.search({ platform: 'openai', search, tags: [], limit: 20 });
      assert.deepEqual(page.items.map(item => item.id), [String(standardOne)]);
      assert.ok(page.platformFacets.includes('anthropic'));
      assert.equal(Date.parse(page.nextExpiryAt!), Date.now() + 10);
      const facets = await repository.facets({ platform: 'openai', search, tags: [] });
      assert.equal(Date.parse(facets.nextExpiryAt!), Date.now() + 3_600_000);
    }
  });

  test('real SQL page counts and monetary facet options refresh on expiry with the same version', async context => {
    await database.updateTable('products').set({ spec: '独享' }).where('id', '=', productOne).execute();
    await database.updateTable('offers').set({ settlement_verified_at: new Date(Date.now() - quotePolicy.ttlMs + 1000) }).where('idempotency_key', '=', 'one-new').execute();
    const cache = createCache({ ttl: 30_000 });
    const service = new CatalogService(repository, cache);
    try {
      const input = { priceMin: '0' };
      const version = await versions.current();
      assert.equal((await service.getCatalog(input)).total, 2);
      assert.ok((await service.getFacets(input)).tagFacets.some(tag => tag.name === 'access' && tag.value === 'dedicated'));
      context.mock.timers.tick(1000);
      assert.equal(await versions.current(), version);
      const after = await service.getCatalog(input);
      assert.equal(after.total, 2);
      assert.equal(after.offerTotal, 2);
      assert.equal(after.items.find(item => item.id === String(standardOne))?.offers[0]?.priceStatus, 'expired');
      assert.ok(Date.parse(after.nextExpiryAt!) > Date.now());
      assert.ok((await service.getFacets(input)).tagFacets.some(tag => tag.name === 'access' && tag.value === 'dedicated'));
      context.mock.timers.tick(3_600_000 - 1000);
      const afterInventory = await service.getCatalog(input);
      assert.equal(afterInventory.total, 1);
      assert.equal(afterInventory.offerTotal, 1);
      assert.equal(afterInventory.items[0]?.id, String(standardTwo));
      assert.ok(!(await service.getFacets(input)).tagFacets.some(tag => tag.name === 'access' && tag.value === 'dedicated'));
    } finally { await cache.disconnect(); }
  });

  test('browsing uses one cursor snapshot and classifies each standard only once', async () => {
    await addRankingChoices();
    for (const sort of ['default', 'price', 'updated'] as const) {
      statements.length = 0;
      const page = await repository.search({ sort, tags: [], limit: 1 });
      assert.equal(page.items.length, 1);
      assert.equal(statements.filter(statement => statement.startsWith('declare ')).length, 1);
      assert.ok(statements.some(statement => statement.startsWith('fetch forward 64')));
      assert.ok(statements.some(statement => statement.startsWith('close ')));
    }
    const plan: any = await repository.explain({ tags: [], limit: 1 });
    const nodes: any[] = [];
    const visit = (node: any) => { nodes.push(node); for (const child of node.Plans ?? []) visit(child); };
    visit(plan[0].Plan);
    const standards = nodes.find(node => node['Subplan Name'] === 'CTE catalog_standards');
    assert.equal(standards?.['Actual Rows'], 2);
    assert.equal(standards?.['Actual Loops'], 1);
  });

  test('cold catalog searches and purchase filters read one prepared projection statement', async () => {
    for (const input of [
      {}, { search: 'Widget source' },
      { tags: [{ name: 'color', value: 'red' }] },
    ]) {
      statements.length = 0;
      const page = await repository.search({ tags: [], limit: 20, ...input });
      assert.equal(page.total, 2);
      const reads = statements.filter(statement => statement.startsWith('declare '));
      assert.equal(reads.length, 1, 'all catalog data comes from one statement snapshot');
      assert.match(reads[0]!, /catalog_read_offers/u);
      assert.doesNotMatch(reads[0]!, /from offers\b|join products\b/u);
    }
    statements.length = 0;
    await repository.facets({ search: 'Widget source', tags: [] });
    assert.equal(statements.length, 1);
    assert.match(statements[0]!, /catalog_read_offers/u);
    assert.doesNotMatch(statements[0]!, /from offers\b|join products\b/u);
  });

  test('dedicated facet options match eligible readable offer facts without pages or counts', async () => {
    await addPurchaseChoices();
    const service = new CatalogService(repository, createCache({ ttl: 30_000 }));
    for (const input of [
      {}, { platform: 'openai' }, { platform: 'chatgpt' }, { platform: 'other' },
      { q: 'Plus' }, { q: 'Plus covered' }, { q: 'definitely-no-match' },
      { tags: [{ name: 'region', value: 'us' }, { name: 'sms_verification', value: 'verified' }] },
      { warrantyDaysMin: 30 }, { tags: [{ name: 'region', value: 'missing-selected-option' }] },
      { tags: [{ name: 'warranty', value: 'unknown' }] },
    ]) {
      const query = normalizeCatalogQuery(input);
      const eligible = await repository.search({ platform: query.platform, search: query.search, tags: [], limit: 100 });
      const details = await Promise.all(eligible.items.map(item => repository.search({
        platform: query.platform, search: query.search, tags: [], limit: 1, standardProductId: item.id,
        detailKind: 'offers', detailPageSize: 50,
      })));
      const facts = details.flatMap(page => page.items.flatMap(item =>
        item.detail!.entries.flatMap(entry => ('offer' in entry ? entry.offer : entry).tags)));
      const readable = facts.filter(tag => PURCHASE_ATTRIBUTE_DEFINITIONS.some(d => d.name === tag.name && d.values.some(v => v.value === tag.value))
        || (tag.name === 'duration' && /^[1-9][0-9]{0,3} (months?|days)$/u.test(tag.value))
        || (tag.name === 'warranty_days' && /^[1-9][0-9]{0,4}$/u.test(tag.value)));
      const selectedDimensions = new Set(query.tags.map(tag => tag.name));
      const knownDimensions = new Set(readable.filter(tag => tag.value !== 'unknown').map(tag => tag.name));
      const expected = [...readable.filter(tag => tag.value !== 'unknown' || selectedDimensions.has(tag.name) || knownDimensions.has(tag.name)), ...query.tags];
      const keys = (tags: readonly { name: string; value: string }[]) => [...new Set(tags.map(tag => tag.name + ':' + tag.value))].sort();
      const result = await service.getFacets(input);
      assert.deepEqual(keys(result.tagFacets), keys(expected));
      assert.equal('tagFacets' in eligible, false);
      assert.ok(result.tagFacets.every(tag => Number.isInteger(tag.priority) && tag.priority >= 0 && !('count' in tag)));
      assert.deepEqual(Object.keys(result), ['tagFacets', 'nextExpiryAt']);
    }
  });

  test('multiword facet searches avoid JIT and restore the caller transaction setting', async () => {
    await database.transaction().execute(async tx => {
      await sql`set local jit = on`.execute(tx);
      await sql`set local jit_above_cost = 0`.execute(tx);
      const repo = new CatalogRepository(tx, quotePolicy);
      const plan = await repo.explainFacets({ search: 'widget source', tags: [] });
      assert.equal((plan as { JIT?: unknown }[])[0]?.JIT, undefined);
      assert.deepEqual((await sql<{ jit: string }>`show jit`.execute(tx)).rows[0], { jit: 'on' });
    });
  });

  test('stored facet projection preserves readable rules and updates inside the source transaction', async () => {
    const declared = PURCHASE_ATTRIBUTE_DEFINITIONS.flatMap(({ name, values }) => values.map(({ value }) => ({ name, value })));
    const numeric = [{ name: 'duration', value: '12 months' }, { name: 'duration', value: '30 days' }, { name: 'warranty_days', value: '365' }];
    const hidden = [{ name: 'warranty_detail', value: 'merchant-only text' }, { name: 'region', value: 'unsupported-region' },
      { name: 'access', value: 'unconfirmed' }, { name: 'duration', value: '0 days' }, { name: 'warranty_days', value: '0' }];
    const result = await sql<{ tags: { name: string; value: string }[] }>`
      select catalog_readable_facets(${JSON.stringify([...declared, ...numeric, ...hidden])}::jsonb) as tags
    `.execute(database);
    const keys = (tags: { name: string; value: string }[]) => tags.map(tag => `${tag.name}:${tag.value}`).sort();
    assert.deepEqual(keys(result.rows[0]!.tags), keys([...declared, ...numeric]));
    const before = await repository.facets({ tags: [] });
    await assert.rejects(database.transaction().execute(async tx => {
      await tx.updateTable('products').set({ spec: '独享成品账号' }).where('id', '=', productOne).execute();
      const changed = await new CatalogRepository(tx, quotePolicy).facets({ tags: [] });
      assert.ok(changed.tagFacets.some(tag => tag.name === 'access' && tag.value === 'dedicated'));
      throw new Error('rollback-facet-change');
    }), /rollback-facet-change/);
    assert.deepEqual(await repository.facets({ tags: [] }), before);
  });

  test('facet existence checks honor latest stock, visibility and shop health immediately', async () => {
    await database.updateTable('products').set({ spec: '独享成品账号' }).where('id', '=', productOne).execute();
    const hasDedicated = async (repo: CatalogRepository) => (await repo.facets({ tags: [] })).tagFacets
      .some(tag => tag.name === 'access' && tag.value === 'dedicated');
    assert.equal(await hasDedicated(repository), true);
    const changes = [
      (tx: Kysely<DatabaseSchema>) => tx.updateTable('offers').set({ stock_available: false }).where('idempotency_key', '=', 'one-new').execute(),
      (tx: Kysely<DatabaseSchema>) => tx.updateTable('offers').set({ is_stale: true }).where('idempotency_key', '=', 'one-new').execute(),
      (tx: Kysely<DatabaseSchema>) => tx.updateTable('products').set({ deleted_at: new Date() }).where('id', '=', productOne).execute(),
      (tx: Kysely<DatabaseSchema>) => tx.updateTable('standard_products').set({ hidden: true }).where('id', '=', standardOne).execute(),
      (tx: Kysely<DatabaseSchema>) => tx.updateTable('standard_products').set({ verification_state: 'quarantined' }).where('id', '=', standardOne).execute(),
      (tx: Kysely<DatabaseSchema>) => tx.updateTable('shops').set({ enabled: false }).where('id', '=', shopOne).execute(),
    ];
    for (const change of changes) {
      await assert.rejects(database.transaction().execute(async tx => {
        await change(tx);
        assert.equal(await hasDedicated(new CatalogRepository(tx, quotePolicy)), false);
        throw new Error('rollback-facet-eligibility');
      }), /rollback-facet-eligibility/);
      assert.equal(await hasDedicated(repository), true);
    }
    await addOfferHistory();
    const plan = await repository.explainFacets({ tags: [] });
    assertCatalogPlan(plan);
    assert.doesNotMatch(JSON.stringify(plan), /product_totals|ranked_shops|catalog_items|WindowAgg/);
  });

  async function addRankingChoices() {
    const shops = await database.insertInto('shops').values(['second', 'third'].map(name => ({
      platform: 'alpha', url: `https://${name}.invalid`, name, last_fetch_at: null, last_error: null, deleted_at: null,
    }))).returning('id').execute();
    const blue = await addSku(shopOne, 'blue', '2.00', [{ name: 'color', value: 'blue' }]);
    const second = await addSku(shops[0]!.id, 'second-red', '9.00', [{ name: 'color', value: 'red' }]);
    const tied = await addSku(shops[0]!.id, 'second-tied', '9.00', [{ name: 'color', value: 'red' }]);
    const third = await addSku(shops[1]!.id, 'third-red', '10.00', [{ name: 'color', value: 'red' }]);
    return { blue, second, tied, third };
  }

  test('pages quote and shop details before serialization with stable ties and exact totals', async () => {
    const { blue, second, tied, third } = await addRankingChoices();
    const extra: bigint[] = [];
    for (let index = 0; index < 4; index += 1) {
      const shop = await database.insertInto('shops').values({ platform: 'alpha', name: `Detail ${index}`, url: `https://detail-${index}.invalid` }).returning('id').executeTakeFirstOrThrow();
      extra.push(await addSku(shop.id, `detail-${index}-first`, '10.00', [{ name: 'color', value: 'red' }]));
      extra.push(await addSku(shop.id, `detail-${index}-tied`, '10.00', [{ name: 'color', value: 'red' }]));
    }
    const service = new CatalogService(repository, createCache({ ttl: 30_000 }));
    for (const detailKind of ['offers', 'shops'] as const) {
      const expected = (detailKind === 'offers' ? [blue, second, tied, productOne, third, ...extra] : [blue, second, third, extra[0]!, extra[2]!, extra[4]!, extra[6]!]).map(String);
      const actual: string[] = [];
      for (let detailPage = 0; detailPage <= Math.ceil(expected.length / 2); detailPage += 1) {
        const result = await service.getCatalog({ standardProductId: String(standardOne), detailKind, detailPage, detailPageSize: 2 });
        const item = result.items[0]!;
        assert.equal(result.items.length, 1);
        assert.equal(item.productCount, 13);
        assert.equal(item.shopCount, 7);
        assert.equal(item.offers.length, 4);
        assert.equal('allOffers' in item, false);
        assert.equal(item.detail?.kind, detailKind);
        assert.equal(item.detail?.page, detailPage);
        assert.equal(item.detail?.pageSize, 2);
        assert.equal(item.detail?.total, expected.length);
        const ids = item.detail!.entries.map(entry => 'offer' in entry ? entry.offer.productId : entry.productId);
        assert.deepEqual(ids, expected.slice(detailPage * 2, detailPage * 2 + 2));
        actual.push(...ids);
        if (item.detail?.kind === 'shops') for (const entry of item.detail.entries) {
          assert.equal(entry.key, entry.offer.shopId);
          assert.equal(entry.name, entry.offer.shop);
          assert.equal(entry.count, entry.offer.productId === String(third) ? 1 : 2);
        }
      }
      assert.deepEqual(actual, expected);
      assert.equal(new Set(actual).size, expected.length);
      const plan: any = await repository.explain({ standardProductId: String(standardOne), detailKind, detailPage: 1, detailPageSize: 2, tags: [], limit: 20 });
      const nodes: any[] = [];
      const visit = (node: any) => { nodes.push(node); for (const child of node.Plans ?? []) visit(child); };
      visit(plan[0].Plan);
      const details = nodes.find(node => node['Subplan Name'] === 'CTE detail_skus');
      assert.equal(details?.['Node Type'], 'Limit', 'detail rows must be limited before the JSON aggregation reads them');
      assert.equal(details?.['Actual Rows'], 2);
    }
    const summary = await service.getCatalog({ standardProductId: String(standardOne) });
    assert.equal(summary.items[0]?.offers.length, 4);
    assert.equal(summary.items[0]?.productCount, 13);
    assert.equal(summary.items[0]?.detail, undefined);
  });

  test('detail pages apply purchase and search filters before totals and shop winners', async () => {
    const { second, tied, third } = await addRankingChoices();
    const service = new CatalogService(repository, createCache({ ttl: 30_000 }));
    for (const detailKind of ['offers', 'shops'] as const) {
      const input = { standardProductId: String(standardOne), detailKind, detailPageSize: 2,
        platform: 'alpha', q: 'widget', tag: { name: 'color', value: 'red' } };
      const first = (await service.getCatalog(input)).items[0]!;
      const secondPage = (await service.getCatalog({ ...input, detailPage: 1 })).items[0]!;
      const entries = [...first.detail!.entries, ...secondPage.detail!.entries];
      assert.equal(first.productCount, 4);
      assert.equal(first.shopCount, 3);
      assert.deepEqual(entries.map(entry => 'offer' in entry ? entry.offer.productId : entry.productId),
        (detailKind === 'offers' ? [second, tied, productOne, third] : [second, productOne, third]).map(String));
      if (first.detail?.kind === 'shops') assert.equal(first.detail.entries[0]?.count, 2);
      const empty = await service.getCatalog({ ...input, tag: { name: 'color', value: 'missing' } });
      assert.deepEqual(empty.items, []);
      assert.equal(empty.total, 0);
      assert.equal(empty.offerTotal, 0);
    }
  });

  test('friendly service names are consistent in navigation, details, search and facets', async () => {
    await database.updateTable('standard_products').set({
      name: 'openai / chatgpt_card_binding_service / standard', platform: 'openai',
      canonical_family: 'openai', canonical_product: 'chatgpt_card_binding_service', canonical_tier: 'standard',
    }).where('id', '=', standardOne).execute();
    await database.insertInto('product_tags').values({ product_id: productOne, name: 'delivery', value: 'account' }).execute();
    const metadata = await repository.publicProduct(String(standardOne));
    assert.equal(metadata?.name, 'ChatGPT 绑卡服务');
    assert.equal(metadata?.kind, '其他');
    assert.equal((await repository.publicProducts()).items.find(item => item.id === String(standardOne))?.name, 'ChatGPT 绑卡服务');
    for (const search of ['ChatGPT 绑卡服务', 'chatgpt_card_binding_service']) {
      const page = await repository.search({ search, tags: [], limit: 20 });
      assert.deepEqual(page.items.map(item => [item.id, item.name]), [[String(standardOne), 'ChatGPT 绑卡服务']]);
      assert.ok((await repository.facets({ search, tags: [] })).tagFacets.some(tag => tag.name === 'delivery' && tag.value === 'account'));
    }
    assert.equal((await repository.search({ tags: [], limit: 20 })).items[0]?.name, 'ChatGPT 绑卡服务');
    assert.equal((await repository.search({ standardProductId: String(standardOne), detailKind: 'offers', tags: [], limit: 20 })).items[0]?.name, 'ChatGPT 绑卡服务');
    const stored = await database.selectFrom('standard_products').select(['name', 'canonical_product']).where('id', '=', standardOne).executeTakeFirstOrThrow();
    assert.deepEqual(stored, { name: 'openai / chatgpt_card_binding_service / standard', canonical_product: 'chatgpt_card_binding_service' });
  });

  test('humanized free, compound tier and SMS names remain searchable', async () => {
    await database.insertInto('product_tags').values({ product_id: productOne, name: 'delivery', value: 'account' }).execute();
    for (const [family, product, tier, name] of [
      ['edu', 'email', 'free', '教育 邮箱 免费版'],
      ['apple', 'itunes_gift_card', 'us_10_usd', 'Apple iTunes 礼品卡 美区 10 USD'],
      ['telecom', 'roaming_data_sim', '40gb_365_days', '电信 漫游流量卡 40gb 365 天'],
      ['cursor', 'cursor_sms', 'standard', 'Cursor 手机接码'],
    ]) {
      await database.updateTable('standard_products').set({
        name: `${family} / ${product} / ${tier}`, canonical_family: family, canonical_product: product, canonical_tier: tier,
      }).where('id', '=', standardOne).execute();
      const page = await repository.search({ search: name, tags: [], limit: 20 });
      assert.deepEqual(page.items.map(item => [item.id, item.name]), [[String(standardOne), name]]);
      assert.ok((await repository.facets({ search: name, tags: [] })).tagFacets.some(tag => tag.name === 'delivery' && tag.value === 'account'));
    }
  });

  test('a single search matches shop names, quote names and nonempty raw specifications', async () => {
    await database.updateTable('shops').set({ name: '星河代充' }).where('id', '=', shopOne).execute();
    await database.insertInto('product_tags').values({ product_id: productOne, name: 'delivery', value: 'account' }).execute();
    const other = await database.insertInto('shops').values({ name: '其他商铺', platform: 'alpha', url: 'https://other-shop.invalid', enabled: true }).returning('id').executeTakeFirstOrThrow();
    const matchingName = await addSku(other.id, 'name-match', '12');
    const specOnly = await addSku(other.id, 'spec-only', '13');
    await database.updateTable('products').set({ name: '星河账号', spec: '' }).where('id', '=', matchingName).execute();
    await database.updateTable('products').set({ name: '普通账号', spec: '星河' }).where('id', '=', specOnly).execute();
    for (const detailKind of ['offers', 'shops'] as const) {
      const page = await repository.search({ standardProductId: String(standardOne), detailKind, search: '星河', tags: [], limit: 20, detailPageSize: 50 });
      const item = page.items[0]!;
      const ids = item.detail!.entries.map(entry => 'offer' in entry ? entry.offer.productId : entry.productId);
      assert.ok(ids.includes(String(productOne)), 'shop name must match');
      assert.ok(ids.includes(String(matchingName)), 'quote name must match');
      if (detailKind === 'offers') assert.ok(ids.includes(String(specOnly)), 'nonempty raw spec must match');
      assert.equal(item.shopCount, 2);
    }
    const service = new CatalogService(repository, createCache());
    const literal = { standardProductId: String(standardOne), q: '星河代充', searchMode: 'literal', currency: 'CNY' };
    const matchingShop = (await service.getCatalog({ ...literal, detailKind: 'offers' })).items[0]!;
    assert.ok(matchingShop.detail!.entries.some(entry => 'productId' in entry && entry.productId === String(productOne)));
    const facets = await service.getFacets(literal);
    assert.ok(facets.tagFacets.some(tag => tag.name === 'delivery' && tag.value === 'account'));
  });

  test('shop and price filters precede detail totals, shop winners and every stable offer sort', async () => {
    const { second, tied, third } = await addRankingChoices();
    const secondShop = (await database.selectFrom('products').select('shop_id').where('id', '=', second).executeTakeFirstOrThrow()).shop_id;
    const thirdShop = (await database.selectFrom('products').select('shop_id').where('id', '=', third).executeTakeFirstOrThrow()).shop_id;
    await database.updateTable('shops').set({ name: 'ＳＨＯＰ％＿ first' }).where('id', '=', shopOne).execute();
    await database.updateTable('shops').set({ name: 'Shop%_ second' }).where('id', '=', secondShop).execute();
    await database.updateTable('shops').set({ name: 'ShopXX third' }).where('id', '=', thirdShop).execute();
    const middle = await addSku(shopOne, 'middle-red', '9.50', [{ name: 'color', value: 'red' }]);
    const dollars = await addSku(shopOne, 'dollars-red', '9.25', [{ name: 'color', value: 'red' }]);
    await database.updateTable('offers').set({ currency: 'USD' }).where('product_id', '=', dollars).execute();
    await database.updateTable('offers').set({ captured_at: new Date('2026-10-01T00:00:00Z') }).where('product_id', '=', middle).execute();
    await database.updateTable('offers').set({ captured_at: new Date('2026-09-10T00:30:00Z') }).where('product_id', 'in', [second, tied]).execute();
    const service = new CatalogService(repository, createCache({ ttl: 30_000 }));
    const input = { standardProductId: String(standardOne), platform: 'alpha', q: 'widget', tag: { name: 'color', value: 'red' },
      shopQuery: '  ＳＨＯＰ％＿ ', priceMin: '9', priceMax: '10' };
    const expectations = {
      price: { offers: [second, tied, middle, productOne], shops: [second, middle] },
      priceDesc: { offers: [productOne, middle, second, tied], shops: [middle, second] },
      updated: { offers: [middle, productOne, second, tied], shops: [middle, second] },
    };
    for (const detailKind of ['offers', 'shops'] as const) for (const offerSort of ['price', 'priceDesc', 'updated'] as const) {
      const expected = expectations[offerSort][detailKind].map(String);
      const actual: string[] = [];
      for (let detailPage = 0; detailPage <= expected.length; detailPage += 1) {
        const page = await service.getCatalog({ ...input, detailKind, offerSort, detailPage, detailPageSize: 1 });
        assert.equal(page.total, 1);
        assert.equal(page.offerTotal, 4);
        const item = page.items[0]!;
        assert.equal(item.productCount, 4);
        assert.equal(item.shopCount, 2);
        assert.equal(item.minPrice, '9.00');
        assert.deepEqual(item.offers.map(offer => offer.productId), [second, middle].map(String));
        assert.equal(item.detail?.total, expected.length);
        const ids = item.detail!.entries.map(entry => 'offer' in entry ? entry.offer.productId : entry.productId);
        assert.deepEqual(ids, expected.slice(detailPage, detailPage + 1));
        actual.push(...ids);
        if (item.detail?.kind === 'shops') for (const entry of item.detail.entries) assert.equal(entry.count, 2);
      }
      assert.deepEqual(actual, expected);
    }
    const oneShop = await service.getCatalog({ ...input, shopId: String(shopOne), detailKind: 'offers' });
    assert.equal(oneShop.offerTotal, 2);
    assert.equal(oneShop.items[0]?.shopCount, 1);
    const usd = await service.getCatalog({ ...input, currency: 'USD', detailKind: 'offers' });
    assert.deepEqual(usd.items[0]?.detail?.entries.map(entry => 'offer' in entry ? entry.offer.productId : entry.productId), [String(dollars)]);
    const summary = await service.getCatalog({ shopId: String(secondShop), priceMin: '9', priceMax: '9' });
    assert.equal(summary.offerTotal, 2);
    assert.deepEqual(summary.items[0]?.offers.map(offer => offer.productId), [String(second)]);
    assert.equal((await service.getCatalog({ ...input, shopQuery: 'ShopZZ' })).total, 0);
    assert.equal((await service.getCatalog({ ...input, priceMin: '10.01', priceMax: '11' })).total, 0);
  });

  test('facet options honor standard product, literal shop name, shop id, price and currency scope', async () => {
    await database.updateTable('products').set({ spec: '独享' }).where('id', '=', productOne).execute();
    await database.updateTable('products').set({ spec: '共享' }).where('id', '=', productTwo).execute();
    await database.updateTable('shops').set({ name: 'ＳＨＯＰ％＿' }).where('id', '=', shopOne).execute();
    const dollars = await addSku(shopOne, 'redemption-usd', '10.00', [{ name: 'delivery', value: 'redemption' }]);
    await database.updateTable('offers').set({ currency: 'USD' }).where('product_id', '=', dollars).execute();
    const service = new CatalogService(repository, createCache({ ttl: 30_000 }));
    const input = { standardProductId: String(standardOne), shopQuery: ' Shop%_ ', shopId: String(shopOne), q: 'widget', priceMin: '0', priceMax: '10' };
    const facets = await service.getFacets(input);
    assert.ok(facets.tagFacets.some(tag => tag.name === 'access' && tag.value === 'dedicated'));
    assert.ok(!facets.tagFacets.some(tag => tag.name === 'access' && tag.value === 'shared'));
    assert.ok(!facets.tagFacets.some(tag => tag.name === 'delivery' && tag.value === 'redemption'));
    const usd = await service.getFacets({ ...input, currency: 'USD' });
    assert.ok(usd.tagFacets.some(tag => tag.name === 'delivery' && tag.value === 'redemption'));
    for (const filter of [{ shopQuery: 'ShopXX' }, { shopId: '9223372036854775807' }, { priceMax: '9.99' }, { standardProductId: '9223372036854775807' }]) {
      assert.deepEqual((await service.getFacets({ ...input, ...filter })).tagFacets, []);
    }
  });

  test('groups unknown platforms into other before pagination without changing product identities', async () => {
    const first = await repository.search({ platform: 'other', tags: [], limit: 1 });
    assert.equal(first.total, 2);
    assert.deepEqual(first.platformFacets, ['other']);
    assert.equal(first.items[0]?.platform, 'Alpha');
    assert.ok(first.nextCursor);
    const next = await repository.search({ platform: 'other', tags: [], limit: 1, cursor: first.nextCursor });
    assert.deepEqual(next.items.map(item => item.id), [standardTwo.toString()]);
    assert.equal(next.nextCursor, undefined);
    const tagged = await repository.search({ platform: 'other', search: 'widget', tags: [{ name: 'size', value: 'large' }], limit: 20 });
    assert.deepEqual(tagged.items.map(item => item.id), [standardOne.toString()]);
  });

  test('summary pages bound quote payloads while keeping exact counts and full detail access', async () => {
    for (let i = 0; i < 7; i += 1) {
      const shop = await database.insertInto('shops').values({ platform: 'alpha', name: `Preview ${i}`, url: `https://preview-${i}.invalid` }).returning('id').executeTakeFirstOrThrow();
      await addSku(shop.id, `preview-${i}`, String(i + 1));
    }
    const service = new CatalogService(repository, createCache({ ttl: 30_000 }));
    const page = await service.getCatalog({ limit: 1 });
    assert.equal(page.total, 2);
    assert.equal(page.items[0]?.offers.length, 4);
    assert.equal(page.items[0]?.shopCount, 8);
    assert.equal(page.items[0]?.productCount, 8);
    assert.equal('allOffers' in page.items[0]!, false);
    assert.equal(page.items[0]?.minPrice, '1.00');
    assert.ok(page.nextCursor);
    const detail = await service.getCatalog({ standardProductId: String(standardOne), detailKind: 'offers', detailPageSize: 10 });
    assert.equal(detail.items.length, 1);
    assert.equal(detail.items[0]?.detail?.entries.length, 8);
    const filtered = await service.getCatalog({ standardProductId: String(standardOne), detailKind: 'offers', tag: { name: 'size', value: 'large' } });
    assert.deepEqual(filtered.items[0]?.detail?.entries.map(entry => (entry as { productId: string }).productId), [String(productOne)]);
  });

  test('filter endpoint includes readable conditions and preserves selected raw filters', async () => {
    const { covered30 } = await addPurchaseChoices();
    await database.insertInto('product_tags').values([
      { product_id: covered30, name: 'delivery', value: 'account_password_backup_email_2fa' },
      { product_id: covered30, name: 'duration', value: '100刀' },
      { product_id: covered30, name: 'access', value: '独享' },
    ]).execute();
    const full = await repository.search({ tags: [], limit: 20 });
    const summary = await repository.search({ tags: [], limit: 20 });
    assert.equal(summary.total, full.total);
    assert.equal(summary.offerTotal, full.offerTotal);
    assert.equal('tagFacets' in full, false);
    assert.equal('tagFacets' in summary, false);
    const options = await repository.facets({ tags: [] });
    assert.ok(options.tagFacets.some(tag => tag.name === 'region' && tag.value === 'us'));
    assert.ok(!options.tagFacets.some(tag => tag.value === '100刀' || tag.value === 'account_password_backup_email_2fa'));
    assert.ok(options.tagFacets.some(tag => tag.name === 'warranty_days' && tag.value === '30'));
    const filtered = await repository.search({ tags: [{ name: 'region', value: 'us' }], limit: 20 });
    assert.equal(filtered.offerTotal, 2);
    const selectedOptions = await repository.facets({ tags: [{ name: 'region', value: 'us' }] });
    assert.ok(selectedOptions.tagFacets.some(tag => tag.name === 'region' && tag.value === 'us'));
    assert.ok(!selectedOptions.tagFacets.some(tag => tag.name === 'region' && tag.value === 'philippines'));
    assert.deepEqual(filtered.items[0]?.offers[0]?.tags.find(tag => tag.name === 'region'), { name: 'region', value: 'us' });
  });

  test('empty catalog searches avoid the alias lookup entirely', async () => {
    const plan = await repository.explain({ tags: [], limit: 20 });
    assert.ok(!JSON.stringify(plan).includes('standard_product_aliases'));
  });

  test('catalog requests read prepared attributes instead of inferring every SKU again', async () => {
    await addPurchaseChoices();
    await addOfferHistory();
    for (const query of [
      { tags: [], limit: 1 },
      { tags: [{ name: 'warranty', value: 'covered' }], limit: 1 },
      { search: 'verified', tags: [], limit: 1 },
    ]) {
      const plan: any = await repository.explain(query);
      const nodes: any[] = [];
      const walk = (node: any) => { nodes.push(node); for (const child of node.Plans ?? []) walk(child); };
      walk(plan[0].Plan);
      assert.ok(!nodes.some(node => node['Subplan Name'] === 'CTE raw_tags'),
        'interactive reads must not parse merchant text and expand raw tags again');
      assert.ok(nodes.some(node => node['Relation Name'] === 'catalog_read_offers'),
        'catalog reads must use transactionally maintained purchase attributes');
      assertCatalogPlan(plan);
    }
  });

  test('prepared attributes follow product and tag edits atomically without recomputing for prices', async () => {
    const facts = async (id: bigint) => (await sql<{ tags: { name: string; value: string }[]; revision: string }>`
      select tags, xmin::text as revision from catalog_product_facts where product_id = ${id}
    `.execute(database)).rows[0]!;
    const access = async (id: bigint) => (await facts(id)).tags.filter(tag => tag.name === 'access');
    await database.updateTable('products').set({ spec: '独享 质保30天' }).where('id', '=', productOne).execute();
    assert.deepEqual(await access(productOne), [{ name: 'access', value: 'dedicated' }]);
    assert.ok((await facts(productOne)).tags.some(tag => tag.name === 'warranty_days' && tag.value === '30'));
    const beforePriceChange = await facts(productOne);
    await database.updateTable('offers').set({ price: '12.00' }).where('product_id', '=', productOne).execute();
    await database.updateTable('products').set({ url: 'https://catalog.invalid/new-link' }).where('id', '=', productOne).execute();
    assert.deepEqual(await facts(productOne), beforePriceChange, 'quote and metadata updates must reuse prepared attributes');
    await assert.rejects(database.transaction().execute(async tx => {
      await tx.updateTable('products').set({ spec: '共享 无质保' }).where('id', '=', productOne).execute();
      const inTransaction = (await sql<{ tags: { name: string; value: string }[] }>`
        select tags from catalog_product_facts where product_id = ${productOne}
      `.execute(tx)).rows[0]!;
      assert.ok(inTransaction.tags.some(tag => tag.name === 'access' && tag.value === 'shared'));
      throw new Error('rollback attribute edit');
    }), /rollback attribute edit/);
    assert.deepEqual(await facts(productOne), beforePriceChange);
    await database.updateTable('products').set({ spec: '' }).where('id', '=', productOne).execute();
    assert.deepEqual(await access(productOne), [{ name: 'access', value: 'unknown' }]);
    const tag = await database.insertInto('product_tags').values({ product_id: productOne, name: 'access', value: '独享' }).returning('id').executeTakeFirstOrThrow();
    assert.deepEqual(await access(productOne), [{ name: 'access', value: 'dedicated' }]);
    await database.updateTable('product_tags').set({ value: '共享' }).where('id', '=', tag.id).execute();
    assert.deepEqual(await access(productOne), [{ name: 'access', value: 'shared' }]);
    await database.updateTable('product_tags').set({ product_id: productTwo }).where('id', '=', tag.id).execute();
    assert.deepEqual(await access(productOne), [{ name: 'access', value: 'unknown' }]);
    assert.deepEqual(await access(productTwo), [{ name: 'access', value: 'shared' }]);
    await database.deleteFrom('product_tags').where('id', '=', tag.id).execute();
    assert.deepEqual(await access(productTwo), [{ name: 'access', value: 'unknown' }]);
  });


  test('concurrent evidence and tag writers cannot overwrite prepared facts with an older snapshot', async () => {
    let firstReady!: () => void;
    let releaseFirst!: () => void;
    let secondReady!: (pid: number) => void;
    const ready = new Promise<void>(resolve => { firstReady = resolve; });
    const release = new Promise<void>(resolve => { releaseFirst = resolve; });
    const secondPid = new Promise<number>(resolve => { secondReady = resolve; });
    const first = database.transaction().execute(async tx => {
      await tx.updateTable('products').set({ spec: '独享' }).where('id', '=', productOne).execute();
      firstReady();
      await release;
    });
    void first.catch(() => firstReady());
    await ready;
    const second = database.transaction().execute(async tx => {
      const pid = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(tx);
      secondReady(pid.rows[0]!.pid);
      await tx.insertInto('product_tags').values({ product_id: productOne, name: 'delivery', value: '兑换码' }).execute();
    });
    void second.catch(() => secondReady(-1));
    try {
      const pid = await secondPid;
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt += 1) {
        const result = await adminPool.query<{ blocked: boolean }>('select cardinality(pg_blocking_pids($1)) > 0 as blocked', [pid]);
        blocked = result.rows[0]!.blocked;
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(blocked, 'exercise an actual overlapping writer before releasing the first transaction');
    } finally {
      releaseFirst();
      await Promise.all([first, second]);
    }
    const tags = (await sql<{ tags: { name: string; value: string }[] }>`
      select tags from catalog_product_facts where product_id = ${productOne}
    `.execute(database)).rows[0]!.tags;
    assert.ok(tags.some(tag => tag.name === 'access' && tag.value === 'dedicated'));
    assert.ok(tags.some(tag => tag.name === 'delivery' && tag.value === 'redemption'));
  });

  test('purchase filters avoid nested rescans of materialized SKU facts', async () => {
    await database.updateTable('standard_products').set({ platform: 'openai' }).execute();
    await database.insertInto('product_tags').values({ product_id: productOne, name: 'delivery', value: 'top_up' }).execute();
    const query = normalizeCatalogQuery({ q: '', platform: 'openai', tag: JSON.stringify({ name: 'delivery', value: 'top_up' }),
      limit: 20, sort: 'default' });
    const page = await repository.search(query);
    assert.deepEqual(page.items.map(item => item.id), [String(standardOne)]);
    assert.equal(page.offerTotal, 1);
    assert.deepEqual(page.items[0]!.offers.map(offer => offer.productId), [String(productOne)]);
    const plan = await repository.explain(query);
    const walk = (node: any): void => {
      if (node['Node Type'] === 'Nested Loop' && /\bproduct_id\b/.test(node['Join Filter'] ?? '')) {
        assert.ok(!node.Plans?.some((child: any) => child['Parent Relationship'] === 'Inner'
          && child['Node Type'] === 'CTE Scan' && child['Actual Loops'] > 1
          && child['Actual Rows'] + (child['Rows Removed by Filter'] ?? 0) > 1),
        'joining facts by product ID must not repeatedly scan a multi-row materialization for every SKU');
      }
      for (const child of node.Plans ?? []) walk(child);
    };
    walk((plan as any[])[0].Plan);
  });

  test('platform facets compute attributes only for that platform while retaining global navigation', async () => {
    await database.updateTable('standard_products').set({ platform: 'cursor' }).where('id', '=', standardOne).execute();
    await database.updateTable('standard_products').set({ platform: 'openai' }).where('id', '=', standardTwo).execute();
    await database.insertInto('product_tags').values([
      { product_id: productOne, name: 'access', value: 'dedicated' },
      { product_id: productTwo, name: 'access', value: 'shared' },
    ]).execute();
    const query = { platform: 'cursor', tags: [], limit: 1 };
    const page = await repository.search(query);
    assert.deepEqual(page.items.map(item => item.id), [String(standardOne)]);
    assert.deepEqual(page.platformFacets, ['openai', 'xai']);
    const options = await repository.facets(query);
    assert.ok(options.tagFacets.some(tag => tag.name === 'access' && tag.value === 'dedicated'));
    assert.ok(!options.tagFacets.some(tag => tag.name === 'access' && tag.value === 'shared'));
    const filtered = await repository.search({ ...query, tags: [{ name: 'access', value: 'dedicated' }] });
    assert.deepEqual(filtered.items, page.items);
    assert.deepEqual(filtered.platformFacets, page.platformFacets);
    const searched = await repository.search({ ...query, search: 'shared' });
    assert.deepEqual(searched.items, []);
    assert.deepEqual(searched.platformFacets, ['openai']);
    const plan: any = await repository.explain(query);
    const nodes: any[] = [];
    const walk = (node: any) => { nodes.push(node); for (const child of node.Plans ?? []) walk(child); };
    walk(plan[0].Plan);
    const attributes = nodes.find(node => node['Subplan Name'] === 'CTE preview_skus');
    assert.equal(attributes?.['Actual Rows'], 1, 'only the selected platform needs quote payloads');
  });

  test('browsing reads only visible quote facts and agrees with paginated detail ranking', async () => {
    await addPurchaseChoices();
    await addRankingChoices();
    const compare = async (query: Parameters<CatalogRepository['search']>[0]) => {
      const summary = await repository.search(query);
      for (const item of summary.items) {
        const { cursor: _cursor, ...filters } = query;
        const detail = (await repository.search({ ...filters, standardProductId: item.id, detailKind: 'shops', detailPageSize: 4 })).items[0]!;
        assert.equal(item.minPrice, detail.minPrice);
        assert.equal(item.productCount, detail.productCount);
        assert.equal(item.shopCount, detail.shopCount);
        assert.deepEqual(item.offers, detail.detail!.entries.map(entry => 'offer' in entry ? entry.offer : entry));
      }
      assert.equal('tagFacets' in summary, false);
      return summary.nextCursor;
    };
    for (const sort of ['default', 'price', 'updated'] as const) {
      const query = { sort, tags: [], limit: 1 };
      const cursor = await compare(query);
      if (cursor) await compare({ ...query, cursor });
    }
    await compare({ tags: [{ name: 'warranty', value: 'covered' }], limit: 1 });
    await addOfferHistory();
    const plan: any = await repository.explain({ tags: [], limit: 1 });
    assertCatalogPlan(plan);
    assert.doesNotMatch(JSON.stringify(plan), /facet_counts|facet_sums|facet_options/);
    const nodes: any[] = [];
    const walk = (node: any) => { nodes.push(node); for (const child of node.Plans ?? []) walk(child); };
    walk(plan[0].Plan);
    const attributes = nodes.find(node => node['Subplan Name'] === 'CTE preview_skus');
    assert.ok(attributes && attributes['Actual Rows'] <= 8, 'only four shops per visible product plus cursor lookahead need attributes');
    for (const platform of ['openai', 'other', 'missing']) await compare({ platform, tags: [], limit: 1 });
    await database.updateTable('shops').set({ last_error: 'fetch failed' }).where('id', '=', shopOne).execute();
    await compare({ tags: [], limit: 1 });
  });

  test('sorts the whole catalog by price and newest SKU before cursor pagination', async () => {
    const low = await repository.search({ sort: 'price', tags: [], limit: 1 });
    assert.equal(low.items[0]?.id, String(standardTwo));
    const next = await repository.search({ sort: 'price', tags: [], limit: 1, cursor: low.nextCursor });
    assert.equal(next.items[0]?.id, String(standardOne));
    assert.equal(next.nextCursor, undefined);
    await assert.rejects(repository.search({ sort: 'updated', tags: [], limit: 1, cursor: low.nextCursor }), { code: 'INVALID_CURSOR' });
    const newest = await addSku(shopOne, 'newest-expensive', '100');
    await database.updateTable('offers').set({ captured_at: new Date('2026-09-25T12:00:00Z') }).where('product_id', '=', newest).execute();
    const recent = await repository.search({ sort: 'updated', tags: [], limit: 1 });
    assert.equal(recent.items[0]?.id, String(standardOne));
    assert.equal(recent.items[0]?.minPrice, '10.00');
    const older = await repository.search({ sort: 'updated', tags: [], limit: 1, cursor: recent.nextCursor });
    assert.equal(older.items[0]?.id, String(standardTwo));
  });

  test('keeps sorted cursors stable on tied prices and restores a caller transaction JIT setting', async () => {
    await database.updateTable('offers').set({ price: '6.00', settlement_price: '6.00' }).where('product_id', '=', productOne).execute();
    const first = await repository.search({ sort: 'price', tags: [], limit: 1 });
    const second = await repository.search({ sort: 'price', tags: [], limit: 1, cursor: first.nextCursor });
    assert.deepEqual([first.items[0]?.id, second.items[0]?.id], [String(standardOne), String(standardTwo)]);
    await database.transaction().execute(async transaction => {
      await sql`set local jit = on`.execute(transaction);
      const page = await new CatalogRepository(transaction, quotePolicy).search({ tags: [], limit: 1 });
      assert.equal(page.items.length, 1);
      const setting = await sql<{ jit: string }>`show jit`.execute(transaction);
      assert.equal(setting.rows[0]?.jit, 'on');
    });
  });

  test('combines known aliases and keeps platform choices available when a group is selected', async () => {
    await database.updateTable('standard_products').set({ platform: ' OpenAI ' }).where('id', '=', standardOne).execute();
    await database.updateTable('standard_products').set({ platform: 'CODEX' }).where('id', '=', standardTwo).execute();
    const known = await repository.search({ platform: 'openai', tags: [], limit: 20 });
    assert.equal(known.total, 2);
    assert.deepEqual(known.platformFacets, ['openai']);
    assert.deepEqual(known.items.map(item => item.platform), [' OpenAI ', 'CODEX']);
    assert.equal((await repository.search({ platform: 'other', tags: [], limit: 20 })).total, 0);

    await database.updateTable('standard_products').set({ platform: 'small-vendor' }).where('id', '=', standardTwo).execute();
    const selected = await repository.search({ platform: 'openai', tags: [], limit: 20 });
    assert.equal(selected.total, 1);
    assert.deepEqual(selected.platformFacets, ['openai', 'other']);
    const other = await repository.search({ platform: 'other', tags: [], limit: 20 });
    assert.deepEqual(other.items.map(item => item.id), [standardTwo.toString()]);
    assert.deepEqual((await repository.facets({ platform: 'other', tags: [] })).tagFacets, []);
    assert.deepEqual(other.platformFacets, ['openai', 'other']);
  });

  test('keeps mailbox products in email while preserving non-email vendor products', async () => {
    await database.updateTable('standard_products').set({ platform: 'google', canonical_product: 'gmail_account' }).where('id', '=', standardOne).execute();
    await database.updateTable('standard_products').set({ platform: 'microsoft', canonical_product: 'office_365' }).where('id', '=', standardTwo).execute();
    const mail = await repository.search({ platform: 'email', tags: [], limit: 20 });
    assert.deepEqual(mail.items.map(item => item.id), [standardOne.toString()]);
    assert.deepEqual(mail.platformFacets, ['email', 'other']);
    assert.equal((await repository.search({ platform: 'google', tags: [], limit: 20 })).total, 0);
    assert.equal((await repository.search({ platform: 'microsoft', tags: [], limit: 20 })).total, 1);

    await database.updateTable('standard_products').set({ platform: 'microsoft', canonical_product: 'outlook_oauth2_account' }).where('id', '=', standardTwo).execute();
    assert.equal((await repository.search({ platform: 'email', tags: [], limit: 20 })).total, 2);
    await database.updateTable('standard_products').set({ platform: 'Gmail', canonical_product: null }).where('id', '=', standardOne).execute();
    await database.updateTable('standard_products').set({ platform: 'Outlook', canonical_product: null }).where('id', '=', standardTwo).execute();
    const aliases = await repository.search({ platform: 'email', tags: [], limit: 20 });
    assert.equal(aliases.total, 2);
    assert.deepEqual(aliases.platformFacets, ['email']);

    await database.updateTable('standard_products').set({ platform: 'openai', canonical_product: 'chatgpt' }).where('id', '=', standardOne).execute();
    await database.insertInto('product_tags').values({ product_id: productOne, name: 'email_provider', value: 'gmail' }).execute();
    assert.deepEqual((await repository.search({ platform: 'email', tags: [], limit: 20 })).items.map(item => item.id), [standardTwo.toString()]);
    assert.equal((await repository.search({ platform: 'openai', tags: [], limit: 20 })).total, 1);
  });

  test('keeps mailbox toolkits and subscription bundles in other across catalog views', async () => {
    await database.updateTable('standard_products').set({ platform: 'software', canonical_family: 'software', canonical_product: 'icloud_hidden_mail_toolkit' }).where('id', '=', standardOne).execute();
    await database.updateTable('standard_products').set({ platform: 'bundle', canonical_family: 'bundle', canonical_product: 'gmail_and_subscription_bundle' }).where('id', '=', standardTwo).execute();
    await database.insertInto('product_tags').values({ product_id: productOne, name: 'access', value: 'dedicated' }).execute();
    {
      const other = await repository.search({ platform: 'other', tags: [], limit: 20 });
      assert.equal(other.total, 2);
      assert.deepEqual(other.platformFacets, ['other']);
      assert.equal((await repository.search({ platform: 'email', tags: [], limit: 20 })).total, 0);
    }
    assert.ok((await repository.facets({ platform: 'other', tags: [] })).tagFacets.some(tag => tag.name === 'access'));
    assert.deepEqual((await repository.facets({ platform: 'email', tags: [] })).tagFacets, []);
  });

  test('groups IP identities and aliases without treating account IP tags as IP products', async () => {
    await database.updateTable('standard_products').set({ platform: '其它', canonical_family: 'network', canonical_product: 'ip', canonical_tier: 'standard' }).where('id', '=', standardOne).execute();
    await database.updateTable('standard_products').set({ platform: 'openai', canonical_product: 'chatgpt' }).where('id', '=', standardTwo).execute();
    await database.insertInto('product_tags').values([
      { product_id: productOne, name: 'access', value: 'dedicated' },
      { product_id: productTwo, name: 'access', value: 'shared' },
      { product_id: productTwo, name: 'ip_type', value: 'residential' },
    ]).execute();
    const ip = await repository.search({ platform: 'ip', tags: [], limit: 20 });
    assert.deepEqual(ip.items.map(item => item.id), [standardOne.toString()]);
    assert.deepEqual(ip.platformFacets, ['openai', 'ip']);
    assert.equal(ip.items[0]?.platform, '其它');
    const browse = await repository.search({ platform: 'ip', tags: [], limit: 1 });
    assert.deepEqual(browse.items.map(item => item.id), [standardOne.toString()]);
    assert.deepEqual(browse.platformFacets, ['openai', 'ip']);
    assert.equal((await repository.search({ platform: 'other', tags: [], limit: 20 })).total, 0);
    assert.equal((await repository.search({ platform: 'openai', tags: [], limit: 20 })).total, 1);
    const facets = await repository.facets({ platform: 'ip', tags: [] });
    assert.ok(facets.tagFacets.some(tag => tag.name === 'access' && tag.value === 'dedicated'));
    assert.ok(!facets.tagFacets.some(tag => tag.name === 'access' && tag.value === 'shared'));

    await database.updateTable('standard_products').set({ platform: ' Proxy ', canonical_family: null, canonical_product: null, canonical_tier: null }).where('id', '=', standardOne).execute();
    assert.deepEqual((await repository.search({ platform: 'ip', tags: [], limit: 20 })).items.map(item => item.id), [standardOne.toString()]);
    assert.equal((await repository.search({ platform: 'other', tags: [], limit: 20 })).total, 0);
  });

  async function addPurchaseChoices() {
    await database.updateTable('standard_products').set({ name: 'ChatGPT Plus', platform: 'openai', canonical_family: 'openai', canonical_product: 'chatgpt', canonical_tier: 'plus' }).where('id', '=', standardOne).execute();
    const noWarranty = await addSku(shopOne, 'no-warranty', '1.00', [{ name: 'sms_verification', value: '未接码' }, { name: 'warranty', value: '无质保' }, { name: 'region', value: 'us' }]);
    const covered30 = await addSku(shopOne, 'covered-30', '30.00', [{ name: 'sms_verification', value: '已接码' }, { name: 'warranty', value: '30天' }, { name: 'region', value: 'us' }]);
    const covered7 = await addSku(shopOne, 'covered-7', '7.00', [{ name: 'sms_verification', value: 'verified' }, { name: 'warranty', value: '7 days' }, { name: 'region', value: 'philippines' }]);
    const firstLogin = await addSku(shopOne, 'first-login', '2.00', [{ name: 'sms_verification', value: 'verified' }, { name: 'warranty', value: 'first login' }]);
    return { noWarranty, covered30, covered7, firstLogin };
  }

  test('purchase intent filters the same SKU before calculating prices and counts', async () => {
    const { covered30 } = await addPurchaseChoices();
    const service = new CatalogService(repository, createCache({ ttl: 30_000 }));
    const result = await service.getCatalog({ standardProductId: String(standardOne), detailKind: 'offers', detailPageSize: 50, q: 'ChatGPT Plus 已接码 质保至少30天' });
    assert.equal(result.total, 1);
    assert.equal(result.offerTotal, 1);
    assert.equal(result.items[0]?.minPrice, '30.00');
    assert.deepEqual(detailOffers(result.items[0]!).map(offer => offer.productId), [String(covered30)]);
    assert.ok(result.items[0]?.offers[0]?.tags.some(tag => tag.name === 'warranty_days' && tag.value === '30'));
    assert.equal(result.appliedQuery?.warrantyDaysMin, 30);
    for (const detailKind of ['offers', 'shops'] as const) {
      const paged = await service.getCatalog({ standardProductId: String(standardOne), detailKind, detailPageSize: 50,
        q: 'ChatGPT Plus 已接码', warrantyDaysMin: 30, tag: { name: 'region', value: 'us' } });
      assert.equal(paged.items[0]?.detail?.total, 1);
      assert.equal(paged.items[0]?.minPrice, '30.00');
      assert.deepEqual(paged.items[0]?.detail?.entries.map(entry => 'offer' in entry ? entry.offer.productId : entry.productId), [String(covered30)]);
    }
  });

  test('purchase filters use OR within a dimension and AND across dimensions', async () => {
    const { covered30, covered7 } = await addPurchaseChoices();
    const result = await repository.search({ standardProductId: String(standardOne), detailKind: 'offers', detailPageSize: 50, tags: [{ name: 'region', value: 'us' }, { name: 'region', value: 'philippines' }, { name: 'sms_verification', value: 'verified' }], limit: 20 });
    assert.deepEqual(detailOffers(result.items[0]!).map(offer => offer.productId), [covered7, covered30].map(String));
    assert.equal(result.items[0]?.minPrice, '7.00');
    const impossible = await repository.search({ standardProductId: String(standardOne), detailKind: 'offers', detailPageSize: 50, tags: [{ name: 'sms_verification', value: 'unverified' }], warrantyDaysMin: 30, limit: 20 });
    assert.equal(impossible.total, 0);
  });

  test('warranty minimums include longer coverage and exclude first-login, unknown and insufficient coverage', async () => {
    const { covered30 } = await addPurchaseChoices();
    const covered90 = await addSku(shopOne, 'covered-90', '90.00', [{ name: 'warranty', value: '90 days' }]);
    await addSku(shopOne, 'unknown-coverage', '0.50', [{ name: 'warranty', value: 'covered' }]);
    const service = new CatalogService(repository, createCache({ ttl: 30_000 }));
    for (const input of [{ warrantyDaysMin: 30 }, { q: 'ChatGPT 质保至少30天' }]) {
      const page = await service.getCatalog({ standardProductId: String(standardOne), detailKind: 'offers', detailPageSize: 50, ...input });
      assert.deepEqual(detailOffers(page.items[0]!).map(offer => offer.productId), [covered30, covered90].map(String));
      assert.equal(page.items[0]?.minPrice, '30.00');
    }
    const overridden = await service.getCatalog({ standardProductId: String(standardOne), detailKind: 'offers', detailPageSize: 50, q: 'ChatGPT 质保至少30天', warrantyDaysMin: 90 });
    assert.deepEqual(detailOffers(overridden.items[0]!).map(offer => offer.productId), [String(covered90)]);
  });

  test('duration aliases match all equivalent quotes without conflating months with days', async () => {
    const month = await addSku(shopOne, 'duration-month', '10.00', [{ name: 'duration', value: '1 month' }]);
    const alias = await addSku(shopOne, 'duration-alias', '11.00', [{ name: 'duration', value: '1 months' }]);
    const days = await addSku(shopOne, 'duration-days', '12.00', [{ name: 'duration', value: '30 days' }]);
    const service = new CatalogService(repository, createCache({ ttl: 30_000 }));
    const months = await service.getCatalog({ standardProductId: String(standardOne), detailKind: 'offers', detailPageSize: 50, tag: [{ name: 'duration', value: '1个月' }] });
    assert.deepEqual(detailOffers(months.items[0]!).map(offer => offer.productId), [month, alias].map(String));
    const byDays = await service.getCatalog({ standardProductId: String(standardOne), detailKind: 'offers', detailPageSize: 50, tag: [{ name: 'duration', value: '30 days' }] });
    assert.deepEqual(detailOffers(byDays.items[0]!).map(offer => offer.productId), [String(days)]);
    const facets = await service.getFacets({});
    assert.deepEqual(facets.tagFacets.filter(tag => tag.name === 'duration').map(tag => tag.value).sort(), ['1 month', '30 days']);
  });

  test('unknown warranty remains distinct from explicit none and first-login coverage', async () => {
    const { noWarranty, firstLogin } = await addPurchaseChoices();
    const none = await repository.search({ standardProductId: String(standardOne), detailKind: 'offers', detailPageSize: 50, platform: 'openai', tags: [{ name: 'warranty', value: 'none' }], limit: 20 });
    assert.deepEqual(detailOffers(none.items[0]!).map(offer => offer.productId), [String(noWarranty)]);
    const unknown = await repository.search({ standardProductId: String(standardOne), detailKind: 'offers', detailPageSize: 50, platform: 'openai', tags: [{ name: 'warranty', value: 'unknown' }], limit: 20 });
    assert.deepEqual(detailOffers(unknown.items[0]!).map(offer => offer.productId), [String(productOne)]);
    const first = await repository.search({ standardProductId: String(standardOne), detailKind: 'offers', detailPageSize: 50, tags: [{ name: 'warranty_scope', value: 'first_login' }], limit: 20 });
    assert.deepEqual(detailOffers(first.items[0]!).map(offer => offer.productId), [String(firstLogin)]);
    assert.ok(!first.items[0]?.offers[0]?.tags.some(tag => tag.name === 'duration' || tag.name === 'warranty_days'));
  });

  test('explicit listing facts make historical untagged SKUs searchable without an AI rerun', async () => {
    await addPurchaseChoices();
    const product = await addSku(shopOne, 'historical', '19.00');
    await database.updateTable('products').set({ name: 'ChatGPT Plus 未接码 速刷 无质保', spec: '独享 兑换码' }).where('id', '=', product).execute();
    const service = new CatalogService(repository, createCache({ ttl: 30_000 }));
    const result = await service.getCatalog({ standardProductId: String(standardOne), detailKind: 'offers', detailPageSize: 50, q: 'plus 未接码 速刷 无质保' });
    assert.deepEqual(detailOffers(result.items[0]!).map(offer => offer.productId), [String(product)]);
    assert.ok(result.items[0]?.offers[0]?.tags.some(tag => tag.name === 'intended_use' && tag.value === 'rapid'));
    assert.ok(result.items[0]?.offers[0]?.tags.some(tag => tag.name === 'delivery' && tag.value === 'redemption'));
  });

  test('conflicting delivery claims stay unknown instead of promising a delivery method', async () => {
    await database.updateTable('products').set({ spec: '成品账号 兑换码' }).where('id', '=', productOne).execute();
    const page = await repository.search({ tags: [], limit: 20 });
    const tags = page.items.find(item => item.id === String(standardOne))!.offers[0]!.tags;
    assert.deepEqual(tags.filter(tag => tag.name === 'delivery'), [{ name: 'delivery', value: 'unknown' }]);
  });

  test('daily and rapid searches share SKU totals and facets without counting a quote twice', async () => {
    const daily = await addSku(shopOne, 'daily-source', '4', [{ name: 'intended_use', value: 'rapid' }]);
    await database.updateTable('products').set({ spec: '日抛号' }).where('id', '=', daily).execute();
    const rapid = await addSku(shopOne, 'rapid-tag', '5', [{ name: 'intended_use', value: 'rapid' }]);
    const both = await addSku(shopOne, 'both-words', '6', [{ name: 'intended_use', value: 'rapid' }]);
    await database.updateTable('products').set({ spec: '日抛 速刷' }).where('id', '=', both).execute();
    const named = await addSku(shopOne, 'source-only', '7');
    await database.updateTable('products').set({ name: '日抛号', spec: '商家原文' }).where('id', '=', named).execute();
    const service = new CatalogService(repository, createCache({ ttl: 30_000 }));
    for (const input of [{ q: '日抛' }, { q: '速刷' }, { tags: [{ name: 'intended_use', value: 'rapid' }] }]) {
      const result = await service.getCatalog({ standardProductId: String(standardOne), detailKind: 'offers', detailPageSize: 50, ...input });
      assert.equal(result.offerTotal, 4);
      assert.deepEqual(new Set(result.items.flatMap(item => detailOffers(item).map(offer => offer.productId))),
        new Set([daily, rapid, both, named].map(String)));
      for (const offer of result.items.flatMap(detailOffers)) {
        assert.deepEqual(offer.tags.filter(tag => tag.name === 'intended_use'), [{ name: 'intended_use', value: 'rapid' }]);
        assert.ok(!offer.tags.some(tag => tag.value === 'disposable'));
      }
    }
    const facets = await repository.facets({ tags: [] });
    assert.equal(facets.tagFacets.filter(tag => tag.name === 'intended_use' && tag.value === 'rapid').length, 1);
  });

  test('daily source changes refresh facts and never turn unknown or negative wording into rapid', async () => {
    await database.updateTable('products').set({ spec: '日抛号' }).where('id', '=', productOne).execute();
    const query = { tags: [{ name: 'intended_use', value: 'rapid' }], limit: 20 };
    assert.equal((await repository.search(query)).offerTotal, 1);
    for (const spec of ['普通账号', '非日抛号', '不支持日抛', '不适合速刷', '禁止速刷',
      '不提供日抛', '日抛不支持', '是否日抛未说明', '可能是日抛', '日抛状态未知']) {
      await database.updateTable('products').set({ spec }).where('id', '=', productOne).execute();
      assert.equal((await repository.search(query)).offerTotal, 0, spec);
      const facts = await database.selectFrom('catalog_product_facts').select('tags').where('product_id', '=', productOne).executeTakeFirstOrThrow();
      assert.ok((facts.tags as Array<{ name: string; value: string }>).some(tag => tag.name === 'intended_use' && tag.value === 'unknown'));
    }
  });

  test('conflicting listing and tag claims never satisfy verified or covered requirements', async () => {
    await addPurchaseChoices();
    const product = await addSku(shopOne, 'conflict', '0.50', [{ name: 'sms_verification', value: 'verified' }, { name: 'warranty', value: '30 days' }]);
    await database.updateTable('products').set({ name: '未接码 无质保', spec: '' }).where('id', '=', product).execute();
    const result = await repository.search({ standardProductId: String(standardOne), detailKind: 'offers', detailPageSize: 50, tags: [{ name: 'sms_verification', value: 'verified' }], warrantyDaysMin: 30, limit: 20 });
    assert.ok(result.items.every(item => detailOffers(item).every(offer => offer.productId !== String(product))));
  });

  test('options remain selectable across purchase filters while the list filters matching offers', async () => {
    await addPurchaseChoices();
    const query = { platform: 'openai', tags: [{ name: 'sms_verification', value: 'verified' }, { name: 'region', value: 'us' }], limit: 20 };
    const page = await repository.search(query);
    const options = await repository.facets(query);
    assert.ok(options.tagFacets.some(tag => tag.name === 'sms_verification' && tag.value === 'unverified'));
    assert.ok(options.tagFacets.some(tag => tag.name === 'region' && tag.value === 'us'));
    assert.ok(!options.tagFacets.some(tag => tag.name === 'region' && tag.value === 'philippines'));
    assert.equal(page.offerTotal, 1);
  });

  test('search matches separate words, source specs and unambiguous aliases literally', async () => {
    await database.updateTable('products').set({ spec: '罕见规格 100%_literal' }).where('id', '=', productOne).execute();
    assert.deepEqual((await repository.search({ search: 'source 罕见规格', tags: [], limit: 20 })).items.map(item => item.id), [String(standardOne)]);
    assert.equal((await repository.search({ search: '100%_literal', tags: [], limit: 20 })).total, 1);
    assert.equal((await repository.search({ search: '100%xliteral', tags: [], limit: 20 })).total, 0);
    await database.updateTable('standard_products').set({ aliases: ['小众别名'] }).where('id', '=', standardOne).execute();
    assert.deepEqual((await repository.search({ search: '小众别名', tags: [], limit: 20 })).items.map(item => item.id), [String(standardOne)]);
  });

  test('ranks one cheapest SKU per shop numerically with stable ties', async () => {
    const { blue, second, third } = await addRankingChoices();
    const page = await repository.search({ tags: [], limit: 20 });
    assert.deepEqual(page.items[0]?.offers.map(offer => offer.productId), [blue, second, third].map(String));
    assert.equal(page.items[0]?.minPrice, '2.00');
  });

  test('filters SKU tags before shop minimum and keeps unmatched selected options removable', async () => {
    const { second, third } = await addRankingChoices();
    const page = await repository.search({ tags: [{ name: 'color', value: 'red' }], limit: 20 });
    assert.deepEqual(page.items[0]?.offers.map(offer => offer.productId), [second, productOne, third].map(String));
    assert.equal(page.items[0]?.minPrice, '9.00');
    const selected = [{ name: 'color', value: 'missing' }];
    const empty = await repository.search({ tags: selected, limit: 1 });
    assert.deepEqual(empty.items, []);
    const options = await repository.facets({ tags: selected });
    assert.deepEqual(options.tagFacets, [{ name: 'color', value: 'missing', priority: 0 }]);
  });

  test('pages standard products without splitting or repeating a shop ranking', async () => {
    const { blue, second, third } = await addRankingChoices();
    const first = await repository.search({ tags: [], limit: 1 });
    assert.deepEqual(first.items.map(item => item.standardProductId), [standardOne.toString()]);
    assert.deepEqual(first.items[0]?.offers.map(offer => offer.productId), [blue, second, third].map(String));
    assert.ok(first.nextCursor);
    const next = await repository.search({ tags: [], cursor: first.nextCursor, limit: 1 });
    assert.deepEqual(next.items.map(item => item.standardProductId), [standardTwo.toString()]);
    assert.equal(next.nextCursor, undefined);
    assert.equal('tagFacets' in next, false);
  });

  test('reads indexed latest offers without scanning their full history', async () => {
    await addOfferHistory();
    assertCatalogPlan(await repository.explain({ tags: [], limit: 1 }));
  });

  test('excludes unpublished, deleted, disabled, stale, out-of-stock and nonfinite SKU choices before ranking and facets', async () => {
    const hidden = await addSku(shopOne, 'unpublished', '1.00', [{ name: 'access', value: 'dedicated' }]);
    await database.updateTable('standard_product_members').set({ publication_state: 'provisional' }).where('product_id', '=', hidden).execute();
    const deleted = await addSku(shopOne, 'deleted', '1.00', [{ name: 'access', value: 'dedicated' }]);
    await database.updateTable('products').set({ deleted_at: new Date() }).where('id', '=', deleted).execute();
    const stale = await addSku(shopOne, 'stale', '1.00', [{ name: 'access', value: 'dedicated' }]);
    await database.updateTable('offers').set({ is_stale: true }).where('product_id', '=', stale).execute();
    await database.insertInto('product_tags').values({ product_id: productThree, name: 'access', value: 'dedicated' }).execute();
    await addSku(shopOne, 'nonfinite', 'NaN', [{ name: 'access', value: 'dedicated' }]);
    for (const state of ['disabled', 'deleted']) {
      const shop = await database.insertInto('shops').values({
        platform: 'alpha', url: `https://${state}.invalid`, name: state, enabled: state !== 'disabled',
        last_fetch_at: null, last_error: state === 'fetch-failed' ? 'liandong goods API: 店铺链接不存在' : null, deleted_at: state === 'deleted' ? new Date() : null,
      }).returning('id').executeTakeFirstOrThrow();
      await addSku(shop.id, state, '1.00', [{ name: 'access', value: 'dedicated' }]);
    }
    const page = await repository.search({ tags: [], limit: 20 });
    assert.deepEqual(page.items[0]?.offers.map(offer => offer.productId), [productOne.toString()]);
    assert.deepEqual((await repository.facets({ tags: [] })).tagFacets, []);
    for (const detailKind of ['offers', 'shops'] as const) {
      const detail = await repository.search({ standardProductId: String(standardOne), detailKind, detailPage: 0, detailPageSize: 2, tags: [], limit: 20 });
      assert.equal(detail.items[0]?.productCount, 1);
      assert.equal(detail.items[0]?.shopCount, 1);
      assert.equal(detail.items[0]?.detail?.total, 1);
      assert.deepEqual(detail.items[0]?.detail?.entries.map(entry => 'offer' in entry ? entry.offer.productId : entry.productId), [String(productOne)]);
    }
  });

  test('quarantined standards contribute neither offers nor tag facets', async () => {
    await database.updateTable('products').set({ spec: '独享' }).where('id', '=', productOne).execute();
    await database.updateTable('standard_products').set({ verification_state: 'quarantined' }).where('id', '=', standardOne).execute();
    const page = await repository.search({ tags: [], limit: 20 });
    assert.deepEqual(page.items.map(item => item.standardProductId), [String(standardTwo)]);
    assert.deepEqual((await repository.facets({ tags: [] })).tagFacets, []);
  });

  test('provisional standards with published memberships do not enter rankings pagination or tag facets', async () => {
    await database.updateTable('products').set({ spec: '独享' }).where('id', '=', productOne).execute();
    await database.updateTable('standard_products').set({ verification_state: 'provisional' }).where('id', '=', standardOne).execute();
    const page = await repository.search({ tags: [], limit: 1 });
    assert.deepEqual(page.items.map(item => item.standardProductId), [String(standardTwo)]);
    assert.deepEqual(page.items[0]?.offers.map(offer => offer.productId), [String(productTwo)]);
    assert.equal(page.nextCursor, undefined);
    assert.deepEqual((await repository.facets({ tags: [] })).tagFacets, []);
    const filtered = await repository.search({ tags: [{ name: 'size', value: 'large' }], limit: 20 });
    assert.deepEqual(filtered.items, []);
    assert.deepEqual((await repository.facets({ tags: [{ name: 'size', value: 'large' }] })).tagFacets, [{ name: 'size', value: 'large', priority: 0 }]);
  });

  test('selects latest visible offer and excludes stale/out-of-stock products', async () => {
    const page = await repository.search({ tags: [], limit: 20 });
    assert.equal(page.items.length, 2);
    assert.equal(page.items[0]?.standardProductId, standardOne.toString());
    assert.deepEqual(page.items[0]?.offers.map((offer) => offer.price), ['10.00']);
  });

  test('requires every requested tag through SQL EXISTS intersection', async () => {
    const page = await repository.search({ tags: [{ name: 'color', value: 'red' }, { name: 'size', value: 'large' }], limit: 20 });
    assert.deepEqual(page.items.map((item) => item.name), ['Widget One']);
  });

  test('does not fall back to an older offer when the latest offer is stale', async () => {
    await database.updateTable('offers').set({ is_stale: true }).where('idempotency_key', '=', 'two-visible').execute();
    const page = await repository.search({ tags: [], limit: 20 });
    assert.deepEqual(page.items.map((item) => item.name), ['Widget One']);
  });

  test('does not fall back to an older offer when the latest offer is out of stock', async () => {
    const page = await repository.search({ tags: [], limit: 20 });
    const standard = page.items.find((item) => item.standardProductId === standardOne.toString());
    assert.deepEqual(standard?.offers.map((offer) => offer.productId), [productOne.toString()]);
  });

  test('applies platform/search filters and composite keyset cursor in SQL', async () => {
    const first = await repository.search({ platform: 'alpha', search: 'widget', tags: [], limit: 1 });
    assert.equal(first.items.length, 1);
    assert.ok(first.nextCursor);
    assert.deepEqual(decodeCatalogCursor(first.nextCursor!), { sortOrder: 1n, standardProductId: standardOne, catalogRank: 999 });
    const second = await repository.search({ platform: 'alpha', search: 'widget', tags: [], cursor: first.nextCursor, limit: 1 });
    assert.deepEqual(second.items.map((item) => item.name), ['Widget Two']);
  });

  test('live projection reads reflect transactional product updates without a response cache', async () => {
    const cache = createCache({ ttl: 30_000 });
    const service = new CatalogService(repository, cache);
    try {
      const first = await service.getCatalog({ tags: [], limit: 20 });
      assert.equal(first.items.flatMap(item => item.offers).find(offer => offer.productId === String(productOne))?.spec, 'large');
      const queryCount = statements.filter(statement => statement.startsWith('declare ')).length;
      const second = await service.getCatalog({ tags: [], limit: 20 });
      assert.deepEqual(second, first);
      assert.equal(statements.filter(statement => statement.startsWith('declare ')).length, queryCount + 1, 'each read opens a fresh snapshot');
      const products = new ProductsRepository(database);
      await products.update(productOne, { url: 'https://catalog.invalid/updated-one' });
      const updated = await service.getCatalog({ tags: [], limit: 20 });
      const updatedOffer = updated.items.flatMap(item => item.offers).find(offer => offer.productId === String(productOne));
      assert.equal(updatedOffer?.productUrl, 'https://catalog.invalid/updated-one');
      assert.notDeepEqual(updated, first);
      await products.update(productOne, { spec: 'changed cached product' });
      const unpublished = await service.getCatalog({ tags: [], limit: 20 });
      assert.ok(!unpublished.items.some(item => item.offers.some(offer => offer.productId === String(productOne))),
        'evidence changes withdraw the old classification and cannot reuse cached offers');
    } finally { await cache.disconnect(); }
  });

  test('catalog version increments in the same write transaction', async () => {
    const before = await versions.current();
    await new ProductsRepository(database).update(productOne, { spec: 'changed' });
    assert.equal(await versions.current(), before + 1n);
  });

  test('catalog version bumps coalesce inside the throttle window', async () => {
    const previous = process.env.CATALOG_VERSION_BUMP_MIN_INTERVAL_MS;
    process.env.CATALOG_VERSION_BUMP_MIN_INTERVAL_MS = '30000';
    const backdate = () => database.updateTable('catalog_cache_versions').set({ updated_at: new Date(0) }).where('id', '=', 1).execute();
    try {
      await backdate();
      const first = await bumpCatalogVersion(database);
      assert.ok(first !== null);
      assert.equal(await bumpCatalogVersion(database), null, 'a bump inside the window is skipped');
      await backdate();
      assert.equal(await bumpCatalogVersion(database), first + 1n, 'a bump after the window passes increments');
    } finally {
      process.env.CATALOG_VERSION_BUMP_MIN_INTERVAL_MS = previous ?? '0';
    }
  });

  test('cursor encoding is strict and composite', () => {
    const cursor = encodeCatalogCursor({ sortOrder: 2n, standardProductId: 42n });
    assert.deepEqual(decodeCatalogCursor(cursor), { sortOrder: 2n, standardProductId: 42n });
    const ranked = { sortOrder: -2n, standardProductId: 42n, catalogRank: 107 };
    assert.deepEqual(decodeCatalogCursor(encodeCatalogCursor(ranked)), ranked);
    for (const rank of [null, '107', 99, 1000, 107.5]) {
      assert.throws(() => decodeCatalogCursor(Buffer.from(JSON.stringify({ v: 4, s: '2', sp: '42', r: rank })).toString('base64url')), { code: 'INVALID_CURSOR' });
    }
    assert.throws(() => decodeCatalogCursor('invalid'), { code: 'INVALID_CURSOR' });
  });
});

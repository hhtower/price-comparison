import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Kysely, PostgresDialect, TableNode, sql, type QueryId } from 'kysely';
import { Pool } from 'pg';
import { jsonb, type DatabaseSchema } from '../src/database/types.js';
import { migrateToLatest } from '../scripts/migrate.js';
import { down as downgradeSettlementQuantity } from '../src/database/migrations/008_settlement_quantity_20261004.js';
import { ProductsRepository } from '../src/products/products.repository.js';
import { ShopsRepository } from '../src/shops/shops.repository.js';
import { JobsRepository, type ClaimedJob } from '../src/jobs/jobs.repository.js';
import { CatalogRepository } from '../src/catalog/catalog.repository.js';
import { CatalogService } from '../src/catalog/catalog.service.js';
import { CatalogVersionRepository } from '../src/catalog/catalog-version.repository.js';
import { createCache } from 'cache-manager';
import { Keyv } from 'keyv';
import { createHash } from 'node:crypto';
import { AdminRepository } from '../src/admin/admin.repository.js';
import { createCrawlerHandler } from '../src/workers/crawler.worker.js';
import { StandardizationRepository } from '../src/standardization/standardization.repository.js';
import { AiRepository } from '../src/ai/ai.repository.js';
import { settlementPayload } from '../src/crawler/settlement-retry.js';
import { readShopRating } from '../src/shops/shop-rating.js';
import { productContentFingerprint } from '../src/standardization/fingerprint.js';

describe('complete shop snapshot synchronization', () => {
  let database: Kysely<DatabaseSchema>, admin: Pool, schema: string, sequence = 0;
  const originalFetch = globalThis.fetch;
  before(async () => {
    if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
    schema = `crawl_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`create schema "${schema}"`);
    process.env.PG_SCHEMA = schema;
    database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path="${schema}",public`, max: 4 }) }) });
    await migrateToLatest(database);
  });
  after(async () => {
    globalThis.fetch = originalFetch;
    await database?.destroy();
    await admin?.query(`drop schema if exists "${schema}" cascade`);
    await admin?.end();
    delete process.env.PG_SCHEMA;
  });
  async function shop() {
    return database.insertInto('shops').values({ platform: '16688', url: `https://www.16688.com.cn/shop/test-${++sequence}`, name: `shop-${sequence}`, enabled: true }).returning('id').executeTakeFirstOrThrow();
  }
  function listing(id: string, name = 'ChatGPT Plus', price = 10) {
    return { goods_no: id, name, spec: 'monthly', price, stock_available_quantity: 1 };
  }
  async function claim(shopId: bigint) {
    const row = await database.insertInto('fetch_runs').values({ shop_id: shopId, status: 'queued', started_at: new Date(), error: null }).returning('id').executeTakeFirstOrThrow();
    const job = await new JobsRepository(database).claimNext('fetch_run', `crawler-${row.id}`, 120000);
    assert.equal(job?.id, row.id);
    return job!;
  }
  async function legacyConcurrentClaim(shopId: bigint): Promise<ClaimedJob> {
    // Simulate claims issued by the pre-fairness worker; new admission forbids this overlap.
    const row = await database.insertInto('fetch_runs').values({
      shop_id: shopId, status: 'running', started_at: new Date(), attempts: 1n,
      claimed_by: 'legacy-worker', claim_token: 'legacy-token', lease_until: new Date(Date.now() + 120000),
    }).returningAll().executeTakeFirstOrThrow();
    return { kind: 'fetch_run', id: row.id, attempts: row.attempts, claimed_by: row.claimed_by!, lease_until: row.lease_until!, row };
  }
  async function queueSupplement(shopId: bigint) {
    const source = await database.selectFrom('shops').selectAll().where('id', '=', shopId).executeTakeFirstOrThrow();
    const rows = await database.selectFrom('products as p').innerJoin('offers as o', 'o.product_id', 'p.id')
      .select(['p.id', 'p.content_version', 'p.content_fingerprint', 'o.price', 'o.captured_at', 'o.settlement_verified_at'])
      .where('p.shop_id', '=', shopId).execute();
    return database.insertInto('fetch_runs').values({ shop_id: shopId, task_type: 'settlement', status: 'queued',
      started_at: new Date(), settlement_payload: jsonb(settlementPayload(source, rows)) }).returningAll().executeTakeFirstOrThrow();
  }
  async function refresh(shopId: bigint, list: (ReturnType<typeof listing> & { image?: string })[], job?: ClaimedJob) {
    const previous = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 1, data: { list } }));
    try {
      await createCrawlerHandler(database, new ProductsRepository(database))(job ?? await claim(shopId), new AbortController().signal);
    } finally { globalThis.fetch = previous; }
  }
  async function publish(shopId: bigint, externalId: string, source: 'human' | 'ai' = 'ai') {
    const product = await database.selectFrom('products').selectAll().where('shop_id', '=', shopId).where('external_id', '=', externalId).executeTakeFirstOrThrow();
    const standard = await database.insertInto('standard_products').values({ name: `standard-${++sequence}`, platform: 'openai', verification_state: 'verified' }).returning('id').executeTakeFirstOrThrow();
    await database.insertInto('standard_product_members').values({ product_id: product.id, standard_product_id: standard.id, assignment_source: source, publication_state: 'published' }).execute();
    await database.insertInto('product_tags').values({ product_id: product.id, name: 'duration', value: 'monthly' }).execute();
    // A human assignment is a new decision revision. Crawler assertions must
    // start from the published state, not the row read before the review.
    return database.selectFrom('products').selectAll().where('id', '=', product.id).executeTakeFirstOrThrow();
  }
  const visibleProducts = async () => (await new CatalogRepository(database).search({ tags: [], limit: 100 })).items.flatMap(item => item.offers.map(offer => offer.productId));

  test('successful crawls atomically persist source-bound ratings and accept lower counts', async () => {
    const s = await shop();
    let volume = 1000;
    const fetchFactory = () => async (url: string) => Response.json({ code: 1, data: url.includes('/shop/detail')
      ? { merchant: { deposit_money: '100.00', sales_count_text: `${volume}人付款` } }
      : url.includes('/goods/list') ? { list: [listing('rated')] } : { list: [] } });
    const handler = createCrawlerHandler(database, new ProductsRepository(database), { fetchFactory });
    await handler(await claim(s.id));
    let saved = await database.selectFrom('shops').selectAll().where('id', '=', s.id).executeTakeFirstOrThrow();
    assert.equal(readShopRating(saved.shop_rating, saved, Date.now()).score, '33.75');
    await publish(s.id, 'rated');
    assert.equal((await new CatalogRepository(database).search({ shopId: String(s.id), tags: [], limit: 10 })).items[0]?.offers[0]?.shopScore, '33.75');
    volume = 0;
    await handler(await claim(s.id));
    saved = await database.selectFrom('shops').selectAll().where('id', '=', s.id).executeTakeFirstOrThrow();
    assert.equal(readShopRating(saved.shop_rating, saved, Date.now()).score, '18.75');
    assert.ok(JSON.stringify(saved.shop_rating).includes('public_display_unverified'));
    const previous = saved.shop_rating;
    const invalidList = createCrawlerHandler(database, new ProductsRepository(database), { fetchFactory: () => async (url: string) =>
      Response.json({ code: 1, data: url.includes('/shop/detail')
        ? { merchant: { deposit_money: '500.00', sales_count_text: '99999人付款' } } : { invalid: true } }) });
    await assert.rejects(invalidList(await claim(s.id)));
    assert.deepEqual((await database.selectFrom('shops').select('shop_rating').where('id', '=', s.id).executeTakeFirstOrThrow()).shop_rating, previous);
  });

  test('crawler preserves complete raw rating title and body without normalization or truncation on repeated fetches', async () => {
    const s = await shop();
    const name = '  ＧＰＴ · original source title\n';
    const description = '  <p>Full\n\nsource Ａ body\t</p>\n'.repeat(1000) + '\nTAIL: warranty terms remain here  ';
    const input = [{ ...listing('raw-rating', name), description }];
    const expected = { unitId: 'raw-rating', name, description,
      hash: createHash('sha256').update(JSON.stringify([name, description])).digest('hex') };
    await refresh(s.id, input);
    const first = await database.selectFrom('products').selectAll().where('shop_id', '=', s.id).executeTakeFirstOrThrow();
    assert.deepEqual((first.source_data as { ratingText?: unknown }).ratingText, expected);
    await refresh(s.id, input);
    const repeated = await database.selectFrom('products').selectAll().where('id', '=', first.id).executeTakeFirstOrThrow();
    assert.deepEqual((repeated.source_data as { ratingText?: unknown }).ratingText, expected);
    assert.equal(repeated.content_version, first.content_version);
    assert.equal(repeated.content_fingerprint, first.content_fingerprint);
    const saved = await database.selectFrom('shops').select('rating_manifest').where('id', '=', s.id).executeTakeFirstOrThrow();
    assert.deepEqual((saved.rating_manifest as { units: unknown }).units, [{ unitId: 'raw-rating', hash: expected.hash }]);
  });

  for (const source of ['ai', 'human'] as const) {
    test(`rating capture and worker recreation preserve ${source} assignments without new LLM work`, async () => {
      const s = await shop();
      const input = { ...listing(`rating-upgrade-${source}`), description: 'Includes 100 credits.' };
      await refresh(s.id, [input]);
      const product = await publish(s.id, input.goods_no, source);
      const state = async () => ({
        product: await database.selectFrom('products').select(['content_version', 'standardization_revision', 'content_changed_at'])
          .where('id', '=', product.id).executeTakeFirstOrThrow(),
        members: await database.selectFrom('standard_product_members').selectAll().where('product_id', '=', product.id).execute(),
        tags: await database.selectFrom('product_tags').selectAll().where('product_id', '=', product.id).execute(),
        decisions: await database.selectFrom('product_standardization_decisions').selectAll().where('product_id', '=', product.id).execute(),
        events: await database.selectFrom('product_change_events').selectAll().where('product_id', '=', product.id).orderBy('id').execute(),
        outbox: await database.selectFrom('standardization_outbox').selectAll().where('product_id', '=', product.id).orderBy('id').execute(),
      });
      const before = await state();
      await refresh(s.id, [input]);
      assert.deepEqual(await state(), before);
      const captured = await database.selectFrom('products').selectAll().where('id', '=', product.id).executeTakeFirstOrThrow();
      assert.ok((captured.source_data as { ratingText?: unknown }).ratingText);
      assert.equal(captured.content_fingerprint, productContentFingerprint({ name: input.name, description: input.description, spec: input.spec }));
      assert.equal(captured.source_name, input.name);
      assert.equal(captured.source_description, input.description);
      const metadataOnly = { ...input, sourceCategory: 'Changed category', price: 99, stock_available_quantity: 0 };
      await refresh(s.id, [metadataOnly]);
      await refresh(s.id, [metadataOnly]);
      assert.deepEqual(await state(), before);
      const repeated = await database.selectFrom('products').selectAll().where('id', '=', product.id).executeTakeFirstOrThrow();
      assert.equal(repeated.content_fingerprint, captured.content_fingerprint);
      assert.equal((repeated.source_data as { ratingText: { description: string } }).ratingText.description, input.description);

      await refresh(s.id, [{ ...input, description: 'Includes 200 credits.' }]);
      const changed = await state();
      assert.equal(changed.product.content_version, before.product.content_version + 1n);
      assert.equal(changed.product.standardization_revision, before.product.standardization_revision + 1n);
      assert.deepEqual(changed.members, []);
      assert.deepEqual(changed.tags, []);
      assert.equal(changed.events.length, before.events.length + 1);
      assert.equal(changed.outbox.length, before.outbox.length + 1);
    });
  }

  test('rating manifest includes sold-out, unpublished and unknown listings in the complete source denominator', async () => {
    const s = await shop();
    const rows = [
      { ...listing('published'), description: 'Published body' },
      { ...listing('sold-out'), description: 'Sold-out body', stock_available_quantity: 0 },
      listing('unknown'),
      { ...listing('empty-body'), description: '' },
    ];
    await refresh(s.id, rows);
    const published = await publish(s.id, 'published');
    const before = Date.now();
    await refresh(s.id, rows);
    const saved = await database.selectFrom('shops').selectAll().where('id', '=', s.id).executeTakeFirstOrThrow();
    const manifest = saved.rating_manifest as { observedAt: number; units: { unitId: string; hash: string | null }[] };
    const hash = (description: string) => createHash('sha256').update(JSON.stringify(['ChatGPT Plus', description])).digest('hex');
    assert.deepEqual(manifest, { sourceUrl: saved.url, sourceProtocol: saved.protocol, sourcePlatform: saved.platform,
      observedAt: manifest.observedAt, units: [
        { unitId: 'empty-body', hash: hash('') },
        { unitId: 'published', hash: hash('Published body') },
        { unitId: 'sold-out', hash: hash('Sold-out body') },
        { unitId: 'unknown', hash: null },
      ] });
    assert.ok(manifest.observedAt >= before && manifest.observedAt <= Date.now());
    const products = await database.selectFrom('products').select(['id', 'external_id', 'text_review'])
      .where('shop_id', '=', s.id).where('deleted_at', 'is', null).execute();
    assert.equal(products.length, 4);
    assert.ok(products.every(product => product.text_review === null));
    const memberships = await database.selectFrom('standard_product_members').select('product_id')
      .where('product_id', 'in', products.map(product => product.id)).execute();
    assert.deepEqual(memberships, [{ product_id: published.id }]);
    const soldOut = products.find(product => product.external_id === 'sold-out')!;
    assert.equal((await database.selectFrom('offers').select('stock_available').where('product_id', '=', soldOut.id)
      .orderBy('id', 'desc').executeTakeFirstOrThrow()).stock_available, false);
  });

  for (const actor of ['ai', 'human'] as const) test(`changed evidence withdraws ${actor} assignment and queues review before new quotes are visible`, async () => {
    const s = await shop();
    await refresh(s.id, [listing('changing')]);
    const original = await publish(s.id, 'changing', actor);
    assert.ok((await visibleProducts()).includes(String(original.id)));
    await refresh(s.id, [listing('changing', 'ChatGPT Pro', 20)]);
    assert.equal((await visibleProducts()).includes(String(original.id)), false);
    assert.deepEqual(await database.selectFrom('standard_product_members').select('product_id').where('product_id', '=', original.id).execute(), []);
    assert.deepEqual(await database.selectFrom('product_tags').select('product_id').where('product_id', '=', original.id).execute(), []);
    const updated = await database.selectFrom('products').selectAll().where('id', '=', original.id).executeTakeFirstOrThrow();
    assert.equal(updated.content_version, 2n);
    assert.equal(updated.standardization_revision, original.standardization_revision + 1n);
    assert.equal((await database.selectFrom('standardization_outbox').select('id').where('product_id', '=', original.id).where('fingerprint', '=', updated.content_fingerprint).execute()).length, 1);
    await refresh(s.id, [listing('changing', 'ChatGPT Pro', 25)]);
    assert.equal((await visibleProducts()).includes(String(original.id)), false);
  });

  test('quote-only refresh preserves identity, tags and decision revision without requeueing', async () => {
    const s = await shop();
    await refresh(s.id, [listing('price')]);
    const original = await publish(s.id, 'price', 'human');
    await refresh(s.id, [{ ...listing('price', 'ChatGPT Plus', 15), stock_available_quantity: 0 }]);
    const updated = await database.selectFrom('products').selectAll().where('id', '=', original.id).executeTakeFirstOrThrow();
    assert.equal(updated.standardization_revision, original.standardization_revision);
    assert.equal(updated.content_version, original.content_version);
    assert.equal(updated.deleted_at, null);
    assert.equal((await database.selectFrom('standardization_outbox').select('id').where('product_id', '=', original.id).execute()).length, 1);
    assert.equal((await database.selectFrom('product_tags').select('product_id').where('product_id', '=', original.id).execute()).length, 1);
    assert.equal((await visibleProducts()).includes(String(original.id)), false);
    await refresh(s.id, [listing('price', 'ChatGPT Plus', 15)]);
    assert.ok((await visibleProducts()).includes(String(original.id)));
    const offers = await database.selectFrom('offers').select(['price', 'is_stale', 'stock_available'])
      .where('product_id', '=', original.id).execute();
    assert.deepEqual(offers, [{ price: '15.00', is_stale: false, stock_available: true }]);
  });

  test('crawler stores real totals and estimates when an expired quote cannot be refreshed', async () => {
    const s = await shop();
    let quote: unknown = '98.00';
    const handler = createCrawlerHandler(database, new ProductsRepository(database), {
      fetchFactory: () => async (url, options) => {
        if (String(url).endsWith('/shopApi/goods/list')) return new Response(JSON.stringify({ code: 1, data: { list: [{ goods_no: 'settlement', name: 'Settlement', price: 90, stock_available_quantity: 1 }] } }));
        if (String(url).endsWith('/shopApi/payment/list')) return new Response(JSON.stringify({ code: 1, data: { list: [{ id: 11, show_name: '支付宝' }] } }));
        return new Response(JSON.stringify(quote === undefined ? { code: 0, data: null } : { code: 1, data: { total_amount: quote } }));
      },
    });
    await handler(await claim(s.id));
    await publish(s.id, 'settlement');
    await handler(await claim(s.id));
    const product = await database.selectFrom('products').select('id').where('shop_id', '=', s.id).executeTakeFirstOrThrow();
    let offer = await database.selectFrom('offers').select(['price', 'settlement_price', 'settlement_payment_method']).where('product_id', '=', product.id).executeTakeFirstOrThrow();
    assert.deepEqual(offer, { price: '90.00', settlement_price: '98.00', settlement_payment_method: '支付宝' });
    quote = undefined;
    await database.updateTable('offers').set({ settlement_verified_at: new Date(0) }).where('product_id', '=', product.id).execute();
    await handler(await claim(s.id));
    offer = await database.selectFrom('offers').select(['price', 'settlement_price', 'settlement_payment_method']).where('product_id', '=', product.id).executeTakeFirstOrThrow();
    assert.deepEqual(offer, { price: '90.00', settlement_price: '90.00', settlement_payment_method: '支付价（预估：售价）' });
  });

  test('fresh unchanged settlements skip payment requests without renewing verification', async () => {
    const s = await shop();
    await refresh(s.id, [listing('selected')]);
    const product = await publish(s.id, 'selected');
    let price = 10, stock = 1, name = 'ChatGPT Plus', calls = 0;
    const handler = createCrawlerHandler(database, new ProductsRepository(database), {
      fetchFactory: () => async (url, options) => {
        if (String(url).endsWith('/goods/list')) return Response.json({ code: 1, data: { list: [{ ...listing('selected', name, price), stock_available_quantity: stock }] } });
        if (String(url).endsWith('/shop/detail')) return Response.json({ code: 0 });
        calls++;
        if (String(url).endsWith('/payment/list')) return Response.json({ code: 1, data: { list: [{ id: 1, show_name: 'Alipay' }] } });
        return Response.json({ code: 1, data: { total_amount: '10.30' } });
      },
    });
    await handler(await claim(s.id));
    assert.equal(calls, 2);
    const first = await database.selectFrom('offers').selectAll().where('product_id', '=', product.id).executeTakeFirstOrThrow();
    const skipped = await claim(s.id);
    await handler(skipped);
    assert.equal(calls, 2);
    const retained = await database.selectFrom('offers').selectAll().where('product_id', '=', product.id).executeTakeFirstOrThrow();
    assert.equal(retained.settlement_price, '10.30');
    assert.deepEqual(retained.settlement_verified_at, first.settlement_verified_at);
    assert.equal(Reflect.get((await database.selectFrom('fetch_runs').select('settlement_report').where('id', '=', skipped.id).executeTakeFirstOrThrow()).settlement_report, 'reasons').recently_verified, 1);
    await database.updateTable('offers').set({ settlement_verified_at: new Date(0) }).where('product_id', '=', product.id).execute();
    await handler(await claim(s.id));
    assert.equal(calls, 4, 'expired quotes are refreshed');
    price = 12;
    await handler(await claim(s.id));
    assert.equal(calls, 6, 'listed-price changes invalidate the cached settlement');
    stock = 0;
    await handler(await claim(s.id));
    assert.equal(calls, 6, 'sold-out listings need no payment request');
    stock = 1;
    await handler(await claim(s.id));
    assert.equal(calls, 8, 'restocked listings require a fresh quote');
    const beforeEvidenceChange = await database.selectFrom('offers').selectAll().where('product_id', '=', product.id).executeTakeFirstOrThrow();
    name = 'ChatGPT Pro';
    await handler(await claim(s.id));
    assert.equal(calls, 8, 'ordinary evidence changes do not require a fresh quote');
    const changed = await database.selectFrom('offers').selectAll().where('product_id', '=', product.id).executeTakeFirstOrThrow();
    assert.equal(changed.settlement_price, '10.30', 'evidence changes must not clear the reused quote during persistence');
    assert.deepEqual(changed.settlement_verified_at, beforeEvidenceChange.settlement_verified_at);
    await handler(await claim(s.id));
    assert.equal(calls, 8, 'a product awaiting reclassification must not request settlement');
    const pending = await database.selectFrom('offers').selectAll().where('product_id', '=', product.id).executeTakeFirstOrThrow();
    assert.equal(pending.settlement_price, '10.30', 'an unpublished unchanged-price product retains its quote for later reuse');
    assert.deepEqual(pending.settlement_verified_at, beforeEvidenceChange.settlement_verified_at);
  });

  test('multi-unit quotes persist total and quantity, reuse unchanged prices, and invalidate changed purchase minimums', async () => {
    const s = await shop();
    const productData = () => ({ ...listing('bulk', 'ChatGPT Plus'), limit_quantity: quantity, stock_available_quantity: 100 });
    let quantity = 5, total = '51.50';
    await refresh(s.id, [productData()]);
    const product = await publish(s.id, 'bulk', 'human');
    const requested: number[] = [];
    const handler = createCrawlerHandler(database, new ProductsRepository(database), {
      fetchFactory: () => async (url, init) => {
        if (String(url).endsWith('/goods/list')) return Response.json({ code: 1, data: { list: [productData()] } });
        if (String(url).endsWith('/shop/detail')) return Response.json({ code: 0 });
        if (String(url).endsWith('/payment/list')) return Response.json({ code: 1, data: { list: [{ id: 1, show_name: 'Alipay' }] } });
        requested.push(JSON.parse(init.body).quantity);
        return Response.json({ code: 1, data: { total_amount: total, quantity } });
      },
    });
    await handler(await claim(s.id));
    const original = await database.selectFrom('offers').selectAll().where('product_id', '=', product.id).executeTakeFirstOrThrow();
    assert.equal(original.settlement_price, '10.30');
    assert.equal(original.settlement_total_amount, '51.50');
    assert.equal(original.settlement_quantity, 5);
    await handler(await claim(s.id));
    assert.deepEqual(requested, [5]);
    const reused = await database.selectFrom('offers').selectAll().where('product_id', '=', product.id).executeTakeFirstOrThrow();
    assert.deepEqual(reused.settlement_verified_at, original.settlement_verified_at);
    assert.equal(reused.settlement_quantity, 5);
    quantity = 10; total = '100.00';
    await handler(await claim(s.id));
    assert.deepEqual(requested, [5, 10]);
    const updated = await database.selectFrom('offers').selectAll().where('product_id', '=', product.id).executeTakeFirstOrThrow();
    assert.equal(updated.settlement_price, '10.00');
    assert.equal(updated.settlement_total_amount, '100.00');
    assert.equal(updated.settlement_quantity, 10);
  });

  test('a failed changed-quantity quote cannot retain the old unit price', async () => {
    const s = await shop();
    await refresh(s.id, [listing('bulk-failure')]);
    const product = await publish(s.id, 'bulk-failure');
    await database.updateTable('offers').set({
      settlement_price: '10.30', settlement_verified_at: new Date(), settlement_payment_method: 'Alipay',
      settlement_quantity: 1, settlement_total_amount: '10.30',
    }).where('product_id', '=', product.id).execute();
    const handler = createCrawlerHandler(database, new ProductsRepository(database), {
      fetchFactory: () => async url => {
        if (String(url).endsWith('/goods/list')) return Response.json({ code: 1, data: { list: [
          { ...listing('bulk-failure'), limit_quantity: 5, stock_available_quantity: 10 },
        ] } });
        if (String(url).endsWith('/payment/list')) return Response.json({ code: 1, data: { list: [{ id: 1, show_name: 'Alipay' }] } });
        throw new Error('crawler request timed out');
      },
    });
    await handler(await claim(s.id));
    const offer = await database.selectFrom('offers').selectAll().where('product_id', '=', product.id).executeTakeFirstOrThrow();
    assert.equal(offer.settlement_price, '10.00');
    assert.equal(offer.settlement_quantity, 5);
    assert.equal(offer.settlement_total_amount, '50.00');
    assert.match(offer.settlement_payment_method!, /预估/);
  });

  test('settlement failures replace expired quotes with labeled estimates and persist separate crawl results', async () => {
    const s = await shop();
    await refresh(s.id, [listing('retry'), listing('private')]);
    const published = await publish(s.id, 'retry');
    let fail = false, price = 10;
    const quoted: string[] = [];
    const handler = createCrawlerHandler(database, new ProductsRepository(database), {
      fetchFactory: () => async (url, options) => {
        if (String(url).endsWith('/goods/list')) return Response.json({ code: 1, data: { list: [listing('retry', 'ChatGPT Plus', price), listing('private')] } });
        if (String(url).endsWith('/shop/detail')) return Response.json({ code: 0 });
        if (String(url).endsWith('/payment/list')) return Response.json({ code: 1, data: { list: [{ id: 1, show_name: 'Alipay' }] } });
        quoted.push(JSON.parse(options.body).goods_no);
        if (fail) throw new Error('crawler request timed out');
        return Response.json({ code: 1, data: { total_amount: '10.30' } });
      },
    });
    const first = await claim(s.id);
    await handler(first);
    assert.deepEqual(quoted, ['retry']);
    await database.updateTable('offers').set({ settlement_verified_at: new Date(0) }).where('product_id', '=', published.id).execute();
    fail = true;
    const retry = await claim(s.id);
    await handler(retry);
    const retained = await database.selectFrom('offers').selectAll().where('product_id', '=', published.id).executeTakeFirstOrThrow();
    assert.equal(retained.settlement_price, '10.00');
    assert.ok(retained.settlement_verified_at!.getTime() > 0);
    assert.match(retained.settlement_payment_method!, /预估/);
    const row = await database.selectFrom('fetch_runs').selectAll().where('id', '=', retry.id).executeTakeFirstOrThrow();
    assert.equal(row.status, 'succeeded', 'settlement failure must not retry the shop list');
    assert.equal(row.item_count, 2n, 'the complete goods snapshot is already committed');
    const report = Reflect.get(row, 'settlement_report');
    assert.equal(report.listStatus, 'succeeded');
    assert.equal(report.failed, 0);
    assert.equal(report.retryable, 0);
    assert.equal(report.reasons.estimated, 1);
    assert.equal(report.skipped, 1);
    assert.equal(row.error, null);
    assert.deepEqual(await database.selectFrom('fetch_runs').select('id').where('source_fetch_run_id', '=', retry.id).execute(), []);
    price = 12;
    const changed = await claim(s.id);
    await handler(changed);
    assert.equal((await database.selectFrom('offers').select('settlement_price').where('product_id', '=', published.id).executeTakeFirstOrThrow()).settlement_price, '12.00');
  });

  test('business settlement failures keep listing success without enqueuing a retry', async () => {
    const s = await shop();
    await refresh(s.id, [listing('no-channel')]);
    await publish(s.id, 'no-channel');
    const job = await claim(s.id);
    await createCrawlerHandler(database, new ProductsRepository(database), {
      fetchFactory: () => async url => Response.json({ code: 1, data: { list: String(url).endsWith('/goods/list') ? [listing('no-channel')] : [] } }),
    })(job);
    const row = await database.selectFrom('fetch_runs').selectAll().where('id', '=', job.id).executeTakeFirstOrThrow();
    assert.equal(row.status, 'succeeded');
    assert.equal(Reflect.get(row, 'settlement_report').reasons.estimated, 1);
    assert.equal(row.error, null);
    const page = await new AdminRepository(database).listRunHistory({ shopId: s.id, limit: 100 });
    assert.equal(Reflect.get(page.items.find(item => item.id === job.id)!, 'settlement_report').failed, 0);
    const supplements = await database.selectFrom('fetch_runs').select('id').where('source_fetch_run_id', '=', job.id).execute();
    assert.deepEqual(supplements, [], 'terminal failures must not burn quota in the 5s retry queue');
  });

  test('a still-valid prior price needs no scheduled recheck and is not renewed', async () => {
    const s = await shop();
    await refresh(s.id, [listing('fresh-failure')]);
    const product = await publish(s.id, 'fresh-failure');
    const verifiedAt = new Date(Date.now() - 2000);
    await database.updateTable('offers').set({ settlement_price: '10.30', settlement_verified_at: verifiedAt, settlement_payment_method: 'Alipay' })
      .where('product_id', '=', product.id).execute();
    await createCrawlerHandler(database, new ProductsRepository(database), {
      fetchFactory: () => async url => {
        assert.ok(String(url).endsWith('/goods/list'), 'a valid cached price must not request a payment channel');
        return Response.json({ code: 1, data: { list: [listing('fresh-failure')] } });
      },
    })(await claim(s.id));
    const retained = await database.selectFrom('offers').select(['settlement_price', 'settlement_verified_at']).where('product_id', '=', product.id).executeTakeFirstOrThrow();
    assert.equal(retained.settlement_price, '10.30');
    assert.deepEqual(retained.settlement_verified_at, verifiedAt);
  });

  test('proxy authentication failure preserves the full listing without enqueuing a supplement', async () => {
    const s = await shop();
    await refresh(s.id, [listing('auth')]);
    await publish(s.id, 'auth');
    const auth = Object.assign(new Error('proxy authentication failed'), { name: 'ProxyAuthenticationError', retryClass: 'configuration', retryable: false });
    const handler = createCrawlerHandler(database, new ProductsRepository(database), {
      fetchFactory: () => async url => {
        if (String(url).endsWith('/goods/list')) return Response.json({ code: 1, data: { list: [listing('auth')] } });
        throw auth;
      },
    });
    const run = await claim(s.id);
    await handler(run);
    const completed = await database.selectFrom('fetch_runs').selectAll().where('id', '=', run.id).executeTakeFirstOrThrow();
    assert.equal(completed.status, 'succeeded');
    assert.equal((completed.settlement_report as any).reasons.estimated, 1);
    assert.equal((completed.settlement_report as any).retryable, 0);
    const supplements = await database.selectFrom('fetch_runs').select('id').where('source_fetch_run_id', '=', run.id).execute();
    assert.deepEqual(supplements, []);
  });

  test('mixed actual and estimated prices avoid retries and real quotes replace estimates on refresh', async () => {
    const s = await shop();
    const listings = [listing('ok'), listing('retry-one'), listing('retry-two')];
    await refresh(s.id, listings);
    for (const item of listings) await publish(s.id, item.goods_no);
    let phase = 0, listCalls = 0;
    const quoted: string[][] = [[], [], []];
    const handler = createCrawlerHandler(database, new ProductsRepository(database), {
      fetchFactory: () => async (url, init) => {
        if (String(url).endsWith('/goods/list')) { listCalls++; return Response.json({ code: 1, data: { list: listings } }); }
        if (String(url).endsWith('/shop/detail')) return Response.json({ code: 0 });
        if (String(url).endsWith('/payment/list')) return Response.json({ code: 1, data: { list: [{ id: 1, show_name: 'Alipay' }] } });
        const id = JSON.parse(init.body).goods_no;
        quoted[phase]!.push(id);
        if ((phase === 0 && id !== 'ok') || (phase === 1 && id === 'retry-one')) throw new Error('network unavailable');
        return Response.json({ code: 1, data: { total_amount: '10.30' } });
      },
    });
    const listJob = await claim(s.id);
    await handler(listJob);
    assert.deepEqual(await database.selectFrom('fetch_runs').select('id').where('source_fetch_run_id', '=', listJob.id).execute(), []);
    const initialOffers = await database.selectFrom('offers').selectAll().where('product_id', 'in',
      database.selectFrom('products').select('id').where('shop_id', '=', s.id)).execute();
    assert.equal(initialOffers.filter(row => row.settlement_payment_method!.includes('预估')).length, 2);
    const queue = await queueSupplement(s.id);
    const jobs = new JobsRepository(database);
    phase = 2;
    const retry = (await jobs.claimNext('fetch_run', 'settlement-test', 120000))!;
    assert.equal(retry.id, queue.id);
    await handler(retry);
    assert.equal(listCalls, 1, 'supplements must never refetch the list');
    assert.deepEqual(quoted, [['ok', 'retry-one', 'retry-two'], [], ['ok', 'retry-one', 'retry-two']]);
    const row = await database.selectFrom('fetch_runs').selectAll().where('id', '=', queue.id).executeTakeFirstOrThrow();
    assert.equal(row.status, 'succeeded');
    assert.equal((row.crawl_metrics as any).attempts, 1);
    assert.equal((row.crawl_metrics as any).listSucceeded, 0);
    assert.deepEqual((row.settlement_payload as any).products, []);
    assert.ok((await database.selectFrom('offers').select('settlement_payment_method').where('product_id', 'in',
      database.selectFrom('products').select('id').where('shop_id', '=', s.id)).execute()).every(row => row.settlement_payment_method === 'Alipay'));
  });

  test('multi-unit settlement retry uses the original minimum and persists sub-cent unit prices atomically', async () => {
    const s = await shop();
    const item = { ...listing('bulk-retry'), limit_quantity: 5, stock_available_quantity: 100 };
    await refresh(s.id, [item]);
    const product = await publish(s.id, item.goods_no);
    let failing = true, listCalls = 0;
    const quantities: number[] = [];
    const handler = createCrawlerHandler(database, new ProductsRepository(database), {
      fetchFactory: () => async (url, init) => {
        if (String(url).endsWith('/goods/list')) { listCalls++; return Response.json({ code: 1, data: { list: [item] } }); }
        if (String(url).endsWith('/shop/detail')) return Response.json({ code: 0 });
        if (String(url).endsWith('/payment/list')) return Response.json({ code: 1, data: { list: [{ id: 1, show_name: 'Alipay' }] } });
        quantities.push(JSON.parse(init.body).quantity);
        if (failing) throw new Error('network unavailable');
        return Response.json({ code: 1, data: { total_amount: '0.01', quantity: 5 } });
      },
    });
    const initial = await claim(s.id);
    await handler(initial);
    const estimate = await database.selectFrom('offers').selectAll().where('product_id', '=', product.id).executeTakeFirstOrThrow();
    assert.equal(estimate.settlement_quantity, 5);
    assert.equal(estimate.settlement_total_amount, '50.00');
    const queued = await queueSupplement(s.id);
    failing = false;
    const retry = (await new JobsRepository(database).claimNext('fetch_run', 'bulk-retry', 120000))!;
    assert.equal(retry.id, queued.id);
    await handler(retry);
    assert.equal(listCalls, 1);
    assert.deepEqual(quantities, [5, 5]);
    const offer = await database.selectFrom('offers').selectAll().where('product_id', '=', product.id).executeTakeFirstOrThrow();
    assert.equal(offer.settlement_price, '0.002');
    assert.equal(offer.settlement_quantity, 5);
    assert.equal(offer.settlement_total_amount, '0.01');
    assert.equal((await database.selectFrom('fetch_runs').select('status').where('id', '=', queued.id).executeTakeFirstOrThrow()).status, 'succeeded');
  });

  test('missing ACG goods are retired by supplemental quotes and restore only after a complete live snapshot', async () => {
    const s = await shop();
    await database.updateTable('shops').set({ url: 'https://apiciyuan.top/', protocol: 'acg-faka' }).where('id', '=', s.id).execute();
    let missing = false, missingAtPayment = false;
    const fetchImpl: typeof fetch = async input => {
      const url = new URL(String(input));
      const json = (data: unknown) => Response.json({ code: 200, data });
      if (url.pathname.endsWith('/commodity')) return Response.json({ code: 200, total: 1, data: [{ id: 220, name: 'Plus', status: 1 }] });
      if (url.pathname.endsWith('/commodityDetail')) return missing ? Response.json({ code: 0, msg: '商品不存在' })
        : json({ id: 220, name: 'Plus', status: 1, inventory_hidden: 0, minimum: 1, maximum: 0,
          draft_status: 0, only_user: 0, purchase_count: 0, config: [] });
      if (url.pathname.endsWith('/stock')) return json({ stock: 1, stock_state: 1 });
      if (url.pathname.endsWith('/valuation')) return json({ price: '10.00' });
      if (url.pathname.endsWith('/pay')) return missingAtPayment && url.searchParams.has('itemId')
        ? Response.json({ code: 0, msg: '商品已下架' }) : json([{ id: 1, name: '支付宝 5% 手续费', handle: 'Epay' }]);
      throw new Error('unexpected endpoint');
    };
    const handler = createCrawlerHandler(database, new ProductsRepository(database), {
      publicFetchFactory: async () => ({ fetch: fetchImpl, close: async () => {} }),
    });
    await handler(await claim(s.id));
    const product = await publish(s.id, '220');
    assert.ok((await visibleProducts()).includes(String(product.id)));
    const queued = await queueSupplement(s.id);
    missing = true;
    const retry = (await new JobsRepository(database).claimNext('fetch_run', 'missing-retry', 120000))!;
    assert.equal(retry.id, queued.id);
    await handler(retry);
    const retired = await database.selectFrom('products').selectAll().where('id', '=', product.id).executeTakeFirstOrThrow();
    assert.equal(retired.deletion_source, 'crawler_missing');
    assert.ok(retired.deleted_at);
    assert.ok(!(await visibleProducts()).includes(String(product.id)));
    await handler(await claim(s.id));
    assert.ok(!(await visibleProducts()).includes(String(product.id)));
    missing = false;
    await handler(await claim(s.id));
    assert.equal((await database.selectFrom('products').select('deleted_at').where('id', '=', product.id).executeTakeFirstOrThrow()).deleted_at, null);
    assert.ok((await visibleProducts()).includes(String(product.id)));
    missingAtPayment = true;
    await database.updateTable('offers').set({ settlement_price: '10.50', settlement_verified_at: new Date(0),
      settlement_payment_method: '支付宝 5% 手续费', settlement_quantity: 1, settlement_total_amount: '10.50' })
      .where('product_id', '=', product.id).execute();
    await handler(await claim(s.id));
    const removedDuringPayment = await database.selectFrom('products').selectAll().where('id', '=', product.id).executeTakeFirstOrThrow();
    assert.ok(removedDuringPayment.deleted_at);
    assert.equal(removedDuringPayment.deletion_source, 'crawler_missing');
    assert.ok(!(await visibleProducts()).includes(String(product.id)));
  });

  test('settlement retry drops changed source and product snapshots without issuing quote requests', async () => {
    for (const change of ['source', 'product', 'newer-quote']) {
      const s = await shop();
      await refresh(s.id, [listing('retry')]);
      const product = await publish(s.id, 'retry');
      let phase = 'list', calls = 0;
      const handler = createCrawlerHandler(database, new ProductsRepository(database), {
        fetchFactory: () => async url => {
          if (String(url).endsWith('/shop/detail')) return Response.json({ code: 0 });
          calls++;
          assert.equal(phase, 'list', 'a superseded retry must not use the network');
          if (String(url).endsWith('/goods/list')) return Response.json({ code: 1, data: { list: [listing('retry')] } });
          throw new Error('network unavailable');
        },
      });
      const listJob = await claim(s.id);
      await handler(listJob);
      const queue = await queueSupplement(s.id);
      if (change === 'source') await database.updateTable('shops').set({ url: 'https://www.16688.com.cn/shop/changed' }).where('id', '=', s.id).execute();
      if (change === 'product') await database.updateTable('products').set({ content_version: sql`content_version + 1` }).where('id', '=', product.id).execute();
      if (change === 'newer-quote') await database.updateTable('offers').set({ settlement_price: '9.99', settlement_total_amount: '9.99', settlement_verified_at: new Date(), settlement_payment_method: 'Alipay' }).where('product_id', '=', product.id).execute();
      phase = 'retry';
      await database.updateTable('fetch_runs').set({ available_at: new Date(0) }).where('id', '=', queue.id).execute();
      const retry = (await new JobsRepository(database).claimNext('fetch_run', 'retry-test', 120000))!;
      await handler(retry);
      assert.equal(calls, 2);
      assert.equal((await database.selectFrom('fetch_runs').select('status').where('id', '=', queue.id).executeTakeFirstOrThrow()).status, 'succeeded');
    }
  });

  test('invalid and network quotes both estimate, and later valid quotes replace both', async () => {
    const s = await shop();
    const listings = [listing('invalid'), listing('recover')];
    await refresh(s.id, listings);
    for (const item of listings) await publish(s.id, item.goods_no);
    let phase = 0;
    const handler = createCrawlerHandler(database, new ProductsRepository(database), {
      fetchFactory: () => async (url, init) => {
        if (String(url).endsWith('/goods/list')) return Response.json({ code: 1, data: { list: listings } });
        if (String(url).endsWith('/payment/list')) return Response.json({ code: 1, data: { list: [{ id: 1, show_name: 'Alipay' }] } });
        if (phase === 0 || (phase === 1 && JSON.parse(init.body).goods_no === 'recover')) throw new Error('network unavailable');
        return Response.json({ code: 1, data: { total_amount: phase === 1 ? 'invalid' : '10.30' } });
      },
    });
    const initial = await claim(s.id);
    await handler(initial);
    let queued = await queueSupplement(s.id);
    const jobs = new JobsRepository(database);
    await database.updateTable('fetch_runs').set({ available_at: new Date(0) }).where('id', '=', queued.id).execute();
    phase = 1;
    const retry = (await jobs.claimNext('fetch_run', 'retry', 120000))!;
    await handler(retry);
    const estimated = await database.selectFrom('fetch_runs').selectAll().where('id', '=', queued.id).executeTakeFirstOrThrow();
    assert.equal((estimated.settlement_report as any).reasons.estimated, 2);
    assert.equal(estimated.status, 'succeeded');
    queued = await queueSupplement(s.id);
    phase = 2;
    await handler((await jobs.claimNext('fetch_run', 'retry', 120000))!);
    const final = await database.selectFrom('fetch_runs').selectAll().where('id', '=', queued.id).executeTakeFirstOrThrow();
    assert.equal(final.status, 'succeeded');
    assert.equal((final.settlement_report as any).failed, 0);
    assert.equal((final.settlement_report as any).verified, 2);
  });

  test('crawler transaction allows a concurrent heartbeat and fences a replacement claim before commit', async () => {
    for (const reclaim of [false, true]) {
      const s = await shop();
      const job = await claim(s.id);
      const repository = new ProductsRepository(database);
      const upsert = repository.upsertFetchedProducts.bind(repository);
      repository.upsertFetchedProducts = async (tx, rows) => {
        const result = await upsert(tx, rows);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            new JobsRepository(database).heartbeat('fetch_run', job.id, job.claimed_by, 120000),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('heartbeat blocked by crawler transaction')), 1000); }),
          ]);
        } finally { clearTimeout(timer); }
        if (reclaim) await database.updateTable('fetch_runs').set({ claim_token: 'replacement', attempts: job.attempts + 1n }).where('id', '=', job.id).execute();
        return result;
      };
      const handler = createCrawlerHandler(database, repository, {
        fetchFactory: () => async () => Response.json({ code: 1, data: { list: [listing('row')] } }),
      });
      if (reclaim) {
        await assert.rejects(handler(job), /lease expired/);
        assert.equal((await database.selectFrom('products').select('id').where('shop_id', '=', s.id).execute()).length, 0);
        await database.updateTable('fetch_runs').set({ status: 'cancelled' }).where('id', '=', job.id).execute();
      } else await handler(job);
    }
  });

  test('reclaiming an expired crawl lease persists a lease failure for the next worker', async () => {
    const s = await shop();
    const old = await claim(s.id);
    await database.updateTable('fetch_runs').set({ lease_until: new Date(0) }).where('id', '=', old.id).execute();
    const replacement = (await new JobsRepository(database).claimNext('fetch_run', 'replacement', 120000))!;
    assert.equal((replacement.row.crawl_metrics as any)?.leaseFailures, 1);
  });

  test('cancelled settlement attempts retain elapsed phase time for lists and supplements', async () => {
    const s = await shop();
    await refresh(s.id, [listing('cancel-timing')]);
    await publish(s.id, 'cancel-timing');
    for (const supplement of [false, true]) {
      const controller = new AbortController();
      const handler = createCrawlerHandler(database, new ProductsRepository(database), {
        fetchFactory: () => async url => {
          if (String(url).endsWith('/goods/list')) return Response.json({ code: 1, data: { list: [listing('cancel-timing')] } });
          await new Promise(resolve => setTimeout(resolve, 25));
          controller.abort(new Error('cancelled during settlement'));
          throw controller.signal.reason;
        },
      });
      let job: ClaimedJob;
      if (!supplement) job = await claim(s.id);
      else {
        await queueSupplement(s.id);
        job = (await new JobsRepository(database).claimNext('fetch_run', 'timing', 120000))!;
      }
      await assert.rejects(handler(job, controller.signal), /cancelled during settlement/);
      const row = await database.selectFrom('fetch_runs').select('crawl_metrics').where('id', '=', job.id).executeTakeFirstOrThrow();
      assert.ok((row.crawl_metrics as any).durations.settlement >= 20, 'failed settlement still consumed time');
      await database.updateTable('fetch_runs').set({ status: 'cancelled' }).where('id', '=', job.id).execute();
    }
  });

  test('settlement schema rejects special numeric values and partial verification fields', async () => {
    const s = await shop();
    await refresh(s.id, [listing('settlement-schema')]);
    const product = await database.selectFrom('products').select('id').where('shop_id', '=', s.id).executeTakeFirstOrThrow();
    for (const price of ['NaN', 'Infinity', '-Infinity', '-1', '1000000000000']) {
      await assert.rejects(database.updateTable('offers').set({
        settlement_price: price, settlement_verified_at: new Date(), settlement_payment_method: 'Alipay',
      }).where('product_id', '=', product.id).execute(), error => ['23514', '22003'].includes((error as { code: string }).code));
    }
    await assert.rejects(database.updateTable('offers').set({ settlement_price: '98.00' })
      .where('product_id', '=', product.id).execute(), error => (error as { code: string }).code === '23514');
    await database.updateTable('offers').set({ settlement_price: '999999999999.99', settlement_verified_at: new Date(), settlement_payment_method: 'Alipay' })
      .where('product_id', '=', product.id).execute();
    assert.equal((await database.selectFrom('offers').select('settlement_price').where('product_id', '=', product.id).executeTakeFirstOrThrow()).settlement_price, '999999999999.99');
  });

  test('settlement quantity metadata rejects partial, inconsistent and nonfinite totals', async () => {
    const s = await shop();
    await refresh(s.id, [listing('bulk-schema')]);
    const product = await database.selectFrom('products').select('id').where('shop_id', '=', s.id).executeTakeFirstOrThrow();
    for (const [quantity, total, price] of [[null, '51.50', '10.30'], [5, null, '10.30'],
      [0, '0.00', '0.00'], [-1, '51.50', '10.30'], [5, '51.50', '51.50'],
      [5, 'NaN', '10.30'], [5, 'Infinity', '10.30']] as const) {
      await assert.rejects(database.updateTable('offers').set({
        settlement_price: price, settlement_quantity: quantity, settlement_total_amount: total,
        settlement_verified_at: new Date(), settlement_payment_method: 'Alipay',
      }).where('product_id', '=', product.id).execute());
    }
    await database.updateTable('offers').set({
      settlement_price: '0.002', settlement_quantity: 5, settlement_total_amount: '0.01',
      settlement_verified_at: new Date(), settlement_payment_method: 'Alipay',
    }).where('product_id', '=', product.id).execute();
    await assert.rejects(database.updateTable('offers').set({
      settlement_price: null, settlement_verified_at: null, settlement_payment_method: null,
    }).where('product_id', '=', product.id).execute(), 'clearing only part of a bulk quote must fail');
    await database.updateTable('offers').set({
      settlement_price: '142857142857.141428571429', settlement_quantity: 7, settlement_total_amount: '999999999999.99',
    }).where('product_id', '=', product.id).execute();
    assert.equal((await database.selectFrom('offers').select('settlement_price').where('product_id', '=', product.id).executeTakeFirstOrThrow()).settlement_price,
      '142857142857.141428571429');
    await database.updateTable('offers').set({
      settlement_price: '2427184466.019393203883', settlement_quantity: 412, settlement_total_amount: '999999999999.99',
    }).where('product_id', '=', product.id).execute();
  });

  test('migration rollback refuses to reinterpret bulk unit prices as single-purchase quotes', async () => {
    const s = await shop();
    await refresh(s.id, [listing('bulk-rollback')]);
    const product = await database.selectFrom('products').select('id').where('shop_id', '=', s.id).executeTakeFirstOrThrow();
    await database.updateTable('offers').set({
      settlement_price: '10.30', settlement_quantity: 5, settlement_total_amount: '51.50',
      settlement_verified_at: new Date(), settlement_payment_method: 'Alipay',
    }).where('product_id', '=', product.id).execute();
    // Roll back even an unexpectedly successful downgrade so other tests retain their schema.
    const probe = database.transaction().execute(async tx => {
      await downgradeSettlementQuantity(tx as unknown as Kysely<unknown>);
      throw new Error('unsafe downgrade succeeded');
    });
    await assert.rejects(probe, /multi-unit settlements prevent automatic downgrade/);
    const row = await database.selectFrom('offers').selectAll().where('product_id', '=', product.id).executeTakeFirstOrThrow();
    assert.equal(row.settlement_quantity, 5);
    assert.equal(row.settlement_total_amount, '51.50');
  });

  for (const scenario of [
    { platform: '16688', legacy: false },
    { platform: 'liandong', legacy: false },
  ]) test(`${scenario.platform}${scenario.legacy ? ' historical evidence' : ''} stock refresh hides cached quotes and restores restocked listings without reclassification`, async () => {
    const name = `Stock regression ${++sequence}`;
    const s = await database.insertInto('shops').values({
      platform: scenario.platform, name, enabled: true,
      url: scenario.platform === '16688' ? `https://www.16688.com.cn/shop/stock-${sequence}` : `https://wzyp.cn/shop/stock-${sequence}`,
    }).returning('id').executeTakeFirstOrThrow();
    const refreshStock = async (quantity: number | string | undefined) => {
      const item = scenario.platform === '16688'
        ? { goods_no: 'stock', name, price: 10, stock_available_quantity: quantity, stock_available_status: Number(quantity) === 0 ? 'out' : '' }
        : { goods_key: 'stock', link: 'https://wzyp.cn/item/stock', name, price: 10, extend: { stock_count: quantity, show_stock_type: 0 } };
      const handler = createCrawlerHandler(database, new ProductsRepository(database), {
        fetchFactory: () => async (_url, options) => new Response(JSON.stringify({
          code: 1, data: { list: JSON.parse(options.body).current > 1 ? [] : [item] },
        })),
      });
      await handler(await claim(s.id));
    };
    await refreshStock(5);
    const original = await publish(s.id, 'stock', 'human');
    const values = new Map<string, unknown>();
    const service = new CatalogService(new CatalogRepository(database), createCache({ stores: [new Keyv({ store: values })], ttl: 30_000 }));
    const query = { search: name, tags: [], limit: 100 };
    const initial = await service.getCatalog(query);
    assert.deepEqual(initial.items.flatMap(item => item.offers.map(offer => offer.productId)), [String(original.id)]);
    assert.deepEqual(await service.getCatalog(query), initial);
    assert.equal(values.size, 0, 'live catalog reads do not store quote responses');

    await refreshStock('0');
    const offer = await database.selectFrom('offers').select(['stock_available', 'is_stale']).where('product_id', '=', original.id).executeTakeFirstOrThrow();
    assert.deepEqual(offer, { stock_available: false, is_stale: false });
    const unavailable = await service.getCatalog(query);
    assert.deepEqual(unavailable.items, []);
    assert.equal(unavailable.total, 0);
    assert.deepEqual(await service.getFacets(query), { tagFacets: [], nextExpiryAt: null });
    assert.deepEqual(unavailable.platformFacets, []);
    const unchanged = await database.selectFrom('products').selectAll().where('id', '=', original.id).executeTakeFirstOrThrow();
    assert.equal(unchanged.deleted_at, null);
    assert.equal(unchanged.content_version, original.content_version);
    assert.equal(unchanged.standardization_revision, original.standardization_revision);

    await refreshStock(undefined);
    assert.deepEqual((await service.getCatalog(query)).items, []);
    assert.equal((await database.selectFrom('offers').select('stock_available').where('product_id', '=', original.id).executeTakeFirstOrThrow()).stock_available, false);

    await refreshStock('7');
    const restocked = await service.getCatalog(query);
    assert.deepEqual(restocked.items.flatMap(item => item.offers.map(offer => offer.productId)), [String(original.id)]);
    assert.equal(restocked.items[0]?.offers[0]?.inStock, true);
    assert.deepEqual(restocked.items[0]?.offers[0]?.tags, initial.items[0]?.offers[0]?.tags);
    assert.deepEqual(restocked.items[0]?.offers[0]?.tags.filter(tag => tag.name === 'duration'), [{ name: 'duration', value: '1 month' }]);
    assert.equal((await database.selectFrom('standardization_outbox').select('id').where('product_id', '=', original.id).execute()).length, 1);
  });
  beforeEach(async () => {
    // Names such as ChatGPT Plus repeat across fixtures. Deletion is now global
    // by name, so each independent scenario needs its own product history.
    await sql`truncate shops, standard_products, ai_jobs, product_standardization_decisions restart identity cascade`.execute(database);
  });

  test('four sold-out leaders leave cached rankings, minimum prices, counts and facets before restocking', async () => {
    const name = `Stock ranking ${++sequence}`;
    const standard = await database.insertInto('standard_products').values({ name, platform: 'openai', verification_state: 'verified' }).returning('id').executeTakeFirstOrThrow();
    const refreshes: ((stock: number) => Promise<void>)[] = [];
    const productIds: string[] = [];
    const prices = [1, 1.4, 3.19, 3.19, 5, 6];
    for (const [index, price] of prices.entries()) {
      const s = await database.insertInto('shops').values({ platform: 'liandong', name: `${name}-${index}`, url: `https://wzyp.cn/shop/ranking-${sequence}-${index}`, enabled: true }).returning('id').executeTakeFirstOrThrow();
      const refresh = async (stock: number) => {
        const handler = createCrawlerHandler(database, new ProductsRepository(database), {
          fetchFactory: () => async (url, options) => new Response(JSON.stringify(String(url).endsWith('/getUserChannel')
            ? { code: 1, data: [{ id: 11, show_name: '支付宝', status: 1, custom_status: 1 }] }
            : String(url).endsWith('/getGoodsPrice') ? { code: 1, data: { total_amount: String(price) } }
              : { code: 1, data: { list: JSON.parse(options.body).current > 1 ? [] : [{ goods_key: 'stock', name, price, link: `https://wzyp.cn/item/ranking-${index}`, extend: { stock_count: stock } }] } })),
        });
        await handler(await claim(s.id));
      };
      refreshes.push(refresh);
      await refresh(5);
      const product = await database.selectFrom('products').select('id').where('shop_id', '=', s.id).executeTakeFirstOrThrow();
      productIds.push(String(product.id));
      await database.insertInto('standard_product_members').values({ product_id: product.id, standard_product_id: standard.id, publication_state: 'published' }).execute();
      await database.insertInto('product_tags').values({ product_id: product.id, name: 'access', value: index < 4 ? 'dedicated' : 'shared' }).execute();
      // Only published products are eligible for settlement verification.
      await refresh(5);
    }
    const values = new Map<string, unknown>();
    const service = new CatalogService(new CatalogRepository(database), createCache({ stores: [new Keyv({ store: values })], ttl: 30_000 }));
    const query = { search: name, tags: [], limit: 100 };
    const initial = await service.getCatalog(query);
    assert.deepEqual(initial.items[0]?.offers.slice(0, 4).map(offer => offer.productId), productIds.slice(0, 4));
    assert.equal(initial.items[0]?.minPrice, '1.00');

    for (const refresh of refreshes.slice(0, 4)) await refresh(0);
    const available = await service.getCatalog(query);
    assert.deepEqual(available.items[0]?.offers.map(offer => offer.productId), productIds.slice(4));
    assert.deepEqual(available.items[0]?.allOffers.map(offer => offer.productId), productIds.slice(4));
    assert.equal(available.items[0]?.minPrice, '5.00');
    assert.equal(available.items[0]?.shopCount, 2);
    assert.equal(available.items[0]?.productCount, 2);
    assert.deepEqual((await service.getFacets(query)).tagFacets.filter(tag => tag.name === 'access').map(({ name, value }) => ({ name, value })), [{ name: 'access', value: 'shared' }]);

    await refreshes[1]!(2);
    const restocked = await service.getCatalog(query);
    assert.deepEqual(restocked.items[0]?.offers.map(offer => offer.productId), [productIds[1], ...productIds.slice(4)]);
    assert.equal(restocked.items[0]?.minPrice, '1.40');
    assert.equal(restocked.items[0]?.shopCount, 3);
  });

  test('image changes refresh display metadata without invalidating identity or scheduling AI', async () => {
    const s = await shop();
    await refresh(s.id, [{ ...listing('image'), image: 'https://example.test/old.png' }]);
    const original = await publish(s.id, 'image');
    await refresh(s.id, [{ ...listing('image'), image: 'https://example.test/new.png' }]);
    const updated = await database.selectFrom('products').selectAll().where('id', '=', original.id).executeTakeFirstOrThrow();
    assert.equal(updated.image_url, 'https://example.test/new.png');
    assert.equal(updated.standardization_revision, original.standardization_revision);
    assert.equal((await database.selectFrom('standardization_outbox').select('id').where('product_id', '=', original.id).execute()).length, 1);
    assert.ok((await visibleProducts()).includes(String(original.id)));
  });

  test('crawler restores missing listings but keeps manually linked deletions deleted', async () => {
    const s = await shop(), other = await shop();
    await refresh(s.id, [listing('keep', 'Crawler restore candidate'), listing('linked', 'Intentional linked deletion')]);
    await refresh(other.id, [listing('peer', 'Peer placeholder')]);
    const keep = await publish(s.id, 'keep');
    const linked = await database.selectFrom('products').selectAll().where('shop_id', '=', s.id).where('external_id', '=', 'linked').executeTakeFirstOrThrow();
    const peer = await database.selectFrom('products').selectAll().where('shop_id', '=', other.id).where('external_id', '=', 'peer').executeTakeFirstOrThrow();
    await database.updateTable('products').set({ name: linked.name, normalized_key: linked.normalized_key }).where('id', '=', peer.id).execute();
    await new ProductsRepository(database).softDelete(linked.id);
    await refresh(s.id, []);
    assert.ok((await database.selectFrom('products').select('deleted_at').where('id', '=', keep.id).executeTakeFirstOrThrow()).deleted_at);
    await refresh(s.id, [listing('keep', 'Crawler restore candidate'), listing('linked', 'Intentional linked deletion')]);
    assert.equal((await database.selectFrom('products').select('deleted_at').where('id', '=', keep.id).executeTakeFirstOrThrow()).deleted_at, null);
    assert.ok((await database.selectFrom('products').select('deleted_at').where('id', '=', linked.id).executeTakeFirstOrThrow()).deleted_at);
    assert.ok((await database.selectFrom('products').select('deleted_at').where('id', '=', peer.id).executeTakeFirstOrThrow()).deleted_at);
    assert.ok((await visibleProducts()).includes(String(keep.id)));
    assert.equal((await visibleProducts()).includes(String(linked.id)), false);
  });

  for (const changed of [false, true]) {
    test(`crawler restoration ${changed ? 'queues changed fingerprints' : 'reuses unchanged identity and tags'}`, async () => {
      const s = await shop();
      const input = listing('restore-fingerprint', `ChatGPT Plus restore fingerprint ${changed}`);
      await refresh(s.id, [input]);
      const before = await publish(s.id, input.goods_no);
      const tags = await new ProductsRepository(database).listTags(before.id);
      const members = await database.selectFrom('standard_product_members').selectAll().where('product_id', '=', before.id).execute();
      await refresh(s.id, []);
      assert.equal(await new ProductsRepository(database).findById(before.id), undefined);
      await refresh(s.id, [{ ...input, spec: changed ? 'annual' : input.spec }]);
      const restored = (await new ProductsRepository(database).findById(before.id))!;
      assert.equal(restored.content_version, before.content_version + (changed ? 1n : 0n));
      assert.equal(restored.standardization_revision, before.standardization_revision + (changed ? 1n : 0n));
      assert.equal(restored.content_fingerprint === before.content_fingerprint, !changed);
      assert.deepEqual(await new ProductsRepository(database).listTags(before.id), changed ? [] : tags);
      assert.deepEqual(await database.selectFrom('standard_product_members').selectAll().where('product_id', '=', before.id).execute(), changed ? [] : members);
      const events = await database.selectFrom('product_change_events').select(['event_type', 'fingerprint'])
        .where('product_id', '=', before.id).orderBy('id').execute();
      assert.deepEqual(events.map(event => event.event_type), changed ? ['created', 'evidence_changed'] : ['created']);
      const pending = await database.selectFrom('standardization_outbox').select('fingerprint')
        .where('product_id', '=', before.id).where('status', '=', 'queued').execute();
      assert.deepEqual(pending, changed ? [{ fingerprint: restored.content_fingerprint }] : []);
    });
  }

  for (const state of ['sold-out', 'missing', 'closed'] as const) {
    test(`${state} listings never retire or hide same-name products in another shop`, async () => {
      const firstShop = await shop(), peerShop = await shop();
      const name = `ChatGPT Plus 跨店库存 ${state}`;
      await refresh(firstShop.id, [listing('first', name)]);
      await refresh(peerShop.id, [listing('peer', name)]);
      const first = await publish(firstShop.id, 'first');
      const peer = await publish(peerShop.id, 'peer');
      if (state === 'missing') await refresh(firstShop.id, []);
      else if (state === 'sold-out') await refresh(firstShop.id, [{ ...listing('first', name), stock_available_quantity: 0 }]);
      else {
        const handler = createCrawlerHandler(database, new ProductsRepository(database), {
          fetchFactory: () => async () => new Response(JSON.stringify({ code: 0, msg: '商家已注销，有疑问请联系平台客服' })),
        });
        await assert.rejects(handler(await claim(firstShop.id)), /商家已注销/);
        assert.equal((await database.selectFrom('shops').select('enabled').where('id', '=', firstShop.id).executeTakeFirstOrThrow()).enabled, false);
      }
      const saved = await database.selectFrom('products').selectAll().where('id', '=', peer.id).executeTakeFirstOrThrow();
      assert.equal(saved.deleted_at, null);
      assert.equal(saved.standardization_revision, peer.standardization_revision);
      assert.ok((await visibleProducts()).includes(String(peer.id)));
      assert.equal((await visibleProducts()).includes(String(first.id)), false);
      await refresh(peerShop.id, [listing('peer', name)]);
      assert.ok((await visibleProducts()).includes(String(peer.id)), 'a later peer crawl must not inherit a crawler tombstone');
      if (state !== 'closed') {
        await refresh(firstShop.id, [listing('first', name)]);
        const restored = await database.selectFrom('products').select('deleted_at').where('id', '=', first.id).executeTakeFirstOrThrow();
        assert.equal(restored.deleted_at, null);
        assert.ok((await visibleProducts()).includes(String(first.id)));
        assert.ok((await visibleProducts()).includes(String(peer.id)));
      }
    });
  }

  test('successful empty snapshot soft-deletes all shop products and invalidates catalog cache', async () => {
    const s = await shop();
    await refresh(s.id, [listing('empty')]);
    const product = await publish(s.id, 'empty');
    const beforeVersion = await database.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow();
    await refresh(s.id, []);
    assert.equal((await visibleProducts()).includes(String(product.id)), false);
    assert.ok((await database.selectFrom('products').select('deleted_at').where('id', '=', product.id).executeTakeFirstOrThrow()).deleted_at);
    assert.ok((await database.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow()).version > beforeVersion.version);
  });

  test('failed or invalid snapshots preserve stored quotes and their public merchant entries', async () => {
    const s = await shop();
    await refresh(s.id, [listing('existing')]);
    const product = await publish(s.id, 'existing');
    const revision = product.standardization_revision;
    const beforeManifest = (await database.selectFrom('shops').select('rating_manifest').where('id', '=', s.id).executeTakeFirstOrThrow()).rating_manifest;
    await assert.rejects(refresh(s.id, [listing('existing', 'ChatGPT Pro'), listing('invalid', 'Invalid', -1)]));
    assert.deepEqual((await database.selectFrom('shops').select('rating_manifest').where('id', '=', s.id).executeTakeFirstOrThrow()).rating_manifest, beforeManifest);
    const current = await database.selectFrom('products').selectAll().where('id', '=', product.id).executeTakeFirstOrThrow();
    assert.equal(current.name, 'ChatGPT Plus');
    assert.equal(current.standardization_revision, revision);
    assert.equal(current.deleted_at, null);
    assert.equal((await visibleProducts()).includes(String(product.id)), true);
    assert.deepEqual(await database.selectFrom('offers').select(['price', 'is_stale']).where('product_id', '=', product.id).execute(), [{ price: '10.00', is_stale: false }]);
    assert.equal((await database.selectFrom('products').select('id').where('shop_id', '=', s.id).execute()).length, 1);
    await database.updateTable('fetch_runs').set({ status: 'failed' }).where('shop_id', '=', s.id).where('status', '=', 'running').execute();
    await refresh(s.id, [listing('existing')]);
    assert.ok((await visibleProducts()).includes(String(product.id)));
  });

  test('incomplete liandong totals preserve published products and quotes until a complete snapshot succeeds', async () => {
    const s = await shop();
    await refresh(s.id, [listing('existing')]);
    const product = await publish(s.id, 'existing');
    await database.updateTable('shops').set({ platform: 'liandong', url: `https://wzyp.cn/shop/total-${s.id}` }).where('id', '=', s.id).execute();
    const beforeOffers = await database.selectFrom('offers').selectAll().where('product_id', '=', product.id).execute();
    const item = { goods_key: 'existing', link: 'https://wzyp.cn/item/existing', name: 'ChatGPT Plus', price: 12, stock_num: 1, category: { name: 'Subscription' } };
    const job = await claim(s.id);
    const handler = createCrawlerHandler(database, new ProductsRepository(database), { fetchFactory: () => async (_url, options) => {
      const current = JSON.parse(String(options?.body)).current;
      return Response.json({ code: 1, data: { total: 2, list: current === 1 ? [item] : [] } });
    } });
    await assert.rejects(handler(job), /incomplete snapshot/);
    assert.deepEqual(await database.selectFrom('offers').selectAll().where('product_id', '=', product.id).execute(), beforeOffers);
    const preserved = await database.selectFrom('products').selectAll().where('id', '=', product.id).executeTakeFirstOrThrow();
    assert.equal(preserved.deleted_at, null);
    assert.equal(preserved.standardization_revision, product.standardization_revision);
    assert.ok((await visibleProducts()).includes(String(product.id)));
    assert.equal((await database.selectFrom('shops').select('enabled').where('id', '=', s.id).executeTakeFirstOrThrow()).enabled, true);
    await database.updateTable('fetch_runs').set({ status: 'failed' }).where('id', '=', job.id).execute();

    const recovery = createCrawlerHandler(database, new ProductsRepository(database), { fetchFactory: () => async url =>
      String(url).endsWith('/goodsList') ? Response.json({ code: 1, data: { total: 1, list: [item] } }) : Response.json({ code: 0 }),
    });
    await recovery(await claim(s.id));
    assert.equal((await database.selectFrom('products').select('source_category').where('id', '=', product.id).executeTakeFirstOrThrow()).source_category, 'Subscription');
    assert.equal((await database.selectFrom('offers').select('price').where('product_id', '=', product.id).orderBy('id', 'desc').executeTakeFirstOrThrow()).price, '12.00');
  });

  for (const message of ['店铺链接不存在', '商家已被关闭交易，有疑问请联系平台客服', '该商家已被封禁，有疑问请联系平台客服', '商家已注销，有疑问请联系平台客服']) {
    test(`explicitly unavailable shops stop scheduling: ${message}`, async () => {
      const s = await shop();
      await database.updateTable('shops').set({ platform: 'liandong', url: `https://wzyp.cn/shop/invalid-${s.id}` }).where('id', '=', s.id).execute();
      const shops = new ShopsRepository(database);
      const job = await claim(s.id);
      const handler = createCrawlerHandler(database, new ProductsRepository(database), { shops, fetchFactory: () => async () => new Response(JSON.stringify({ code: 0, msg: message })) });
      await assert.rejects(handler(job), /liandong goods API/);
      const row = await database.selectFrom('shops').selectAll().where('id', '=', s.id).executeTakeFirstOrThrow();
      assert.equal(row.enabled, false);
      assert.match(row.last_error ?? '', /liandong goods API/);
      await database.updateTable('shops').set({ next_fetch_at: new Date(0), scheduler_lease_until: null }).where('id', '=', s.id).execute();
      assert.equal((await shops.claimDueShops('regression-scheduler', 10000)).some(candidate => candidate.id === s.id), false);
      assert.equal(await shops.enqueueFetchRun(s.id, 'scheduler'), null);
      await database.updateTable('fetch_runs').set({ status: 'failed' }).where('id', '=', job.id).execute();
    });
  }

  test('failed list retains the cached quote and changed-price recovery exposes a labeled estimate', async () => {
    const s = await shop();
    await refresh(s.id, [listing('cached-failure')]);
    const product = await publish(s.id, 'cached-failure');
    await database.updateTable('offers').set({ settlement_price: '10.00', settlement_verified_at: new Date(), settlement_payment_method: 'alipay' }).where('product_id', '=', product.id).execute();
    const values = new Map<string, unknown>();
    const service = new CatalogService(new CatalogRepository(database), createCache({ stores: [new Keyv({ store: values })], ttl: 30_000 }));
    const query = { search: `standard-${sequence}`, limit: 100 };
    const initial = await service.getCatalog(query);
    assert.equal(initial.items.length, 1);
    assert.equal(initial.items[0]?.minPrice, '10.00');
    const job = await claim(s.id);
    const handler = createCrawlerHandler(database, new ProductsRepository(database), { fetchFactory: () => async () => new Response('temporary', { status: 500 }) });
    await assert.rejects(handler(job), /HTTP 500/);
    const retained = await service.getCatalog(query);
    assert.deepEqual(retained, initial);
    assert.equal(retained.items[0]?.offers[0]?.priceStatus, 'verified');
    assert.equal((await database.selectFrom('shops').select('enabled').where('id', '=', s.id).executeTakeFirstOrThrow()).enabled, true);
    await database.updateTable('fetch_runs').set({ status: 'failed' }).where('id', '=', job.id).execute();
    await refresh(s.id, [listing('cached-failure', 'ChatGPT Plus', 12)]);
    const recovered = await service.getCatalog(query);
    assert.equal(recovered.items[0]?.offers[0]?.productId, String(product.id));
    assert.equal(recovered.items[0]?.offers[0]?.price, '12.00');
    assert.equal(recovered.items[0]?.offers[0]?.listedPrice, '12.00');
    assert.equal(recovered.items[0]?.offers[0]?.priceStatus, 'verified');
    assert.match(recovered.items[0]?.offers[0]?.paymentMethod!, /预估/);
  });

  test('queued runs for disabled shops never contact the upstream', async () => {
    const s = await shop();
    const job = await claim(s.id);
    await database.updateTable('shops').set({ enabled: false }).where('id', '=', s.id).execute();
    let requests = 0;
    const handler = createCrawlerHandler(database, new ProductsRepository(database), { fetchFactory: () => async () => { requests += 1; return new Response(JSON.stringify({ code: 1, data: { list: [] } })); } });
    await assert.rejects(handler(job), /shop is unavailable/);
    assert.equal(requests, 0);
    const attempt = await database.selectFrom('fetch_runs').select('crawl_metrics').where('id', '=', job.id).executeTakeFirstOrThrow();
    assert.equal((attempt.crawl_metrics as any)?.attempts, 1);
    await database.updateTable('fetch_runs').set({ status: 'failed' }).where('id', '=', job.id).execute();
  });

  for (const obsolete of ['newer-success', 'changed-source', 'expired-lease', 'reclaimed']) {
    test(`obsolete upstream failures cannot disable shops or hide current quotes: ${obsolete}`, async () => {
      const s = await shop();
      await refresh(s.id, [listing('healthy')]);
      const product = await publish(s.id, 'healthy');
      const old = await claim(s.id);
      const handler = createCrawlerHandler(database, new ProductsRepository(database), { fetchFactory: () => async () => {
        if (obsolete === 'newer-success') await refresh(s.id, [listing('healthy', 'ChatGPT Plus', 25)], await legacyConcurrentClaim(s.id));
        if (obsolete === 'changed-source') await database.updateTable('shops').set({ url: `https://www.16688.com.cn/shop/changed-${s.id}` }).where('id', '=', s.id).execute();
        if (obsolete === 'expired-lease') await database.updateTable('fetch_runs').set({ lease_until: new Date(0) }).where('id', '=', old.id).execute();
        if (obsolete === 'reclaimed') await database.updateTable('fetch_runs').set({ claim_token: 'replacement', attempts: old.attempts + 1n }).where('id', '=', old.id).execute();
        return new Response(JSON.stringify({ code: 0, msg: '店铺链接不存在' }));
      } });
      await assert.rejects(handler(old), /店铺链接不存在/);
      const row = await database.selectFrom('shops').select(['enabled', 'last_error', 'fetch_backoff_level']).where('id', '=', s.id).executeTakeFirstOrThrow();
      assert.deepEqual(row, { enabled: true, last_error: null, fetch_backoff_level: 0 });
      assert.ok((await visibleProducts()).includes(String(product.id)));
      await database.updateTable('fetch_runs').set({ status: 'failed' }).where('id', '=', old.id).execute();
    });
  }

  test('an older success cannot clear a newer failed fetch before its runtime transition', async () => {
    const s = await shop();
    await refresh(s.id, [listing('newer-failure')]);
    const product = await publish(s.id, 'newer-failure');
    const older = await claim(s.id);
    const newer = await legacyConcurrentClaim(s.id);
    const handler = createCrawlerHandler(database, new ProductsRepository(database), { fetchFactory: () => async () => new Response('temporary failure', { status: 500 }) });
    await assert.rejects(handler(newer), /HTTP 500/);
    await assert.rejects(refresh(s.id, [listing('newer-failure', 'ChatGPT Plus', 25)], older), /superseded/);
    assert.match((await database.selectFrom('shops').select('last_error').where('id', '=', s.id).executeTakeFirstOrThrow()).last_error ?? '', /HTTP 500/);
    assert.equal((await visibleProducts()).includes(String(product.id)), true);
    assert.equal(Number((await database.selectFrom('offers').select('price').where('product_id', '=', product.id).executeTakeFirstOrThrow()).price), 10);
    await database.updateTable('fetch_runs').set({ status: 'failed' }).where('shop_id', '=', s.id).where('status', '=', 'running').execute();
  });

  test('failure persistence rolls back shop health and cache version if the lease expires before commit', async () => {
    const s = await shop();
    const job = await claim(s.id);
    const version = await new CatalogVersionRepository(database).current();
    class ExpiringFailureRepository extends ShopsRepository {
      override async markFetchFailed(...args: Parameters<ShopsRepository['markFetchFailed']>) {
        await super.markFetchFailed(...args);
        await args[4]!.updateTable('fetch_runs').set({ lease_until: new Date(0) }).where('id', '=', job.id).execute();
      }
    }
    const handler = createCrawlerHandler(database, new ProductsRepository(database), { shops: new ExpiringFailureRepository(database), fetchFactory: () => async () => new Response(JSON.stringify({ code: 0, msg: '店铺链接不存在' })) });
    await assert.rejects(handler(job), /店铺链接不存在/);
    const row = await database.selectFrom('shops').select(['enabled', 'last_error', 'fetch_backoff_level']).where('id', '=', s.id).executeTakeFirstOrThrow();
    assert.deepEqual(row, { enabled: true, last_error: null, fetch_backoff_level: 0 });
    assert.equal(await new CatalogVersionRepository(database).current(), version);
    await database.updateTable('fetch_runs').set({ status: 'failed' }).where('id', '=', job.id).execute();
  });


  test('reclaimed crawler responses cannot expire or overwrite quotes', async () => {
    const s = await shop();
    await refresh(s.id, [listing('current')]);
    const product = await publish(s.id, 'current');
    const old = await claim(s.id);
    await database.updateTable('fetch_runs').set({ claim_token: 'new-claim', attempts: old.attempts + 1n, claimed_by: 'replacement' }).where('id', '=', old.id).execute();
    await assert.rejects(refresh(s.id, [listing('current', 'ChatGPT Pro', 20)], old), /lease|claim|expired/i);
    assert.equal((await database.selectFrom('products').select('name').where('id', '=', product.id).executeTakeFirstOrThrow()).name, 'ChatGPT Plus');
    assert.ok((await visibleProducts()).includes(String(product.id)));
    await database.updateTable('fetch_runs').set({ status: 'failed' }).where('id', '=', old.id).execute();
  });

  test('a response from a changed shop URL cannot replace the current snapshot', async () => {
    const s = await shop();
    await refresh(s.id, [listing('url')]);
    const product = await publish(s.id, 'url');
    const job = await claim(s.id);
    globalThis.fetch = async () => {
      await database.updateTable('shops').set({ url: `https://www.16688.com.cn/shop/replaced-${s.id}` }).where('id', '=', s.id).execute();
      return new Response(JSON.stringify({ code: 1, data: { list: [] } }));
    };
    try {
      await assert.rejects(createCrawlerHandler(database, new ProductsRepository(database))(job), /shop.*changed/i);
      assert.ok((await visibleProducts()).includes(String(product.id)));
    } finally {
      globalThis.fetch = originalFetch;
      await database.updateTable('fetch_runs').set({ status: 'failed' }).where('id', '=', job.id).execute();
    }
  });

  test('an older completed response cannot supersede a newer successful snapshot', async () => {
    const s = await shop();
    await refresh(s.id, [listing('order')]);
    const product = await publish(s.id, 'order');
    const old = await claim(s.id);
    const newer = await legacyConcurrentClaim(s.id);
    await refresh(s.id, [listing('order', 'ChatGPT Plus', 25)], newer);
    await assert.rejects(refresh(s.id, [], old), /superseded/i);
    assert.equal(Number((await database.selectFrom('offers').select('price').where('product_id', '=', product.id).executeTakeFirstOrThrow()).price), 25);
    assert.ok((await visibleProducts()).includes(String(product.id)));
    await database.updateTable('fetch_runs').set({ status: 'failed' }).where('id', '=', old.id).execute();
  });

  test('cancellation during the transaction rolls back products, events and quotes', async () => {
    const s = await shop();
    await refresh(s.id, [listing('cancel')]);
    const product = await publish(s.id, 'cancel');
    const job = await claim(s.id), controller = new AbortController();
    class CancellingProducts extends ProductsRepository {
      override async upsertFetchedProducts(...args: Parameters<ProductsRepository['upsertFetchedProducts']>) {
        const changes = await super.upsertFetchedProducts(...args);
        controller.abort(new Error('cancelled before commit'));
        return changes;
      }
    }
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 1, data: { list: [listing('cancel', 'ChatGPT Pro', 30)] } }));
    try {
      await assert.rejects(createCrawlerHandler(database, new CancellingProducts(database))(job, controller.signal), /cancelled/);
      assert.equal((await database.selectFrom('products').select('name').where('id', '=', product.id).executeTakeFirstOrThrow()).name, 'ChatGPT Plus');
      assert.ok((await visibleProducts()).includes(String(product.id)));
      assert.equal((await database.selectFrom('product_change_events').select('id').where('product_id', '=', product.id).execute()).length, 1);
    } finally {
      globalThis.fetch = originalFetch;
      await database.updateTable('fetch_runs').set({ status: 'failed' }).where('id', '=', job.id).execute();
    }
  });

  test('cancellation while completing the fetch run rolls back the entire snapshot', async () => {
    const s = await shop();
    await refresh(s.id, [listing('cancel-completion'), listing('delist-on-cancel')]);
    const product = await publish(s.id, 'cancel-completion');
    const missing = await publish(s.id, 'delist-on-cancel');
    const beforeManifest = (await database.selectFrom('shops').select('rating_manifest').where('id', '=', s.id).executeTakeFirstOrThrow()).rating_manifest;
    const job = await claim(s.id), controller = new AbortController();
    const completionQueries = new Set<QueryId>();
    const cancellingDatabase = database.withPlugin({
      transformQuery({ node, queryId }) {
        if (node.kind === 'UpdateQueryNode' && node.table && TableNode.is(node.table)
          && node.table.table.identifier.name === 'fetch_runs') completionQueries.add(queryId);
        return node;
      },
      async transformResult({ queryId, result }) {
        if (completionQueries.delete(queryId)) controller.abort(new Error('cancelled during completion'));
        return result;
      },
    });
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 1, data: { list: [listing('cancel-completion', 'ChatGPT Pro', 30)] } }));
    try {
      await assert.rejects(createCrawlerHandler(cancellingDatabase, new ProductsRepository(database))(job, controller.signal), /cancelled during completion/);
      assert.deepEqual((await database.selectFrom('shops').select('rating_manifest').where('id', '=', s.id).executeTakeFirstOrThrow()).rating_manifest, beforeManifest);
      const current = await database.selectFrom('products').selectAll().where('id', '=', product.id).executeTakeFirstOrThrow();
      assert.equal(current.name, 'ChatGPT Plus');
      assert.equal(current.standardization_revision, product.standardization_revision);
      assert.equal((await database.selectFrom('products').select('deleted_at').where('id', '=', missing.id).executeTakeFirstOrThrow()).deleted_at, null);
      assert.ok((await visibleProducts()).includes(String(missing.id)));
      assert.equal(Number((await database.selectFrom('offers').select('price').where('product_id', '=', product.id).executeTakeFirstOrThrow()).price), 10);
      assert.ok((await visibleProducts()).includes(String(product.id)));
      assert.equal((await database.selectFrom('product_change_events').select('id').where('product_id', '=', product.id).execute()).length, 1);
      assert.equal((await database.selectFrom('standardization_outbox').select('id').where('product_id', '=', product.id).execute()).length, 1);
      assert.equal((await database.selectFrom('fetch_runs').select('status').where('id', '=', job.id).executeTakeFirstOrThrow()).status, 'running');
    } finally {
      globalThis.fetch = originalFetch;
      await database.updateTable('fetch_runs').set({ status: 'failed' }).where('id', '=', job.id).execute();
    }
  });

  test('crawler updates remain compatible with AI input foreign key locks', async () => {
    const s = await shop();
    await refresh(s.id, [listing('foreign-key')]);
    const product = await publish(s.id, 'foreign-key');
    let unlock!: () => void, locked!: () => void;
    const release = new Promise<void>(resolve => { unlock = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const snapshot = database.transaction().execute(async tx => {
      await tx.selectFrom('products').select('id').where('id', '=', product.id).forKeyShare().execute();
      locked();
      await release;
    });
    await acquired;
    const crawl = refresh(s.id, [listing('foreign-key', 'ChatGPT Pro')]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([crawl, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('crawler blocked on AI input foreign key lock')), 3000); })]);
    } finally {
      clearTimeout(timer);
      unlock();
      await snapshot;
      await crawl;
    }
    assert.equal((await database.selectFrom('products').select('name').where('id', '=', product.id).executeTakeFirstOrThrow()).name, 'ChatGPT Pro');
  });

  test('concurrent crawler and API first imports share one product and one review event', async () => {
    const s = await shop();
    const source = await database.selectFrom('shops').select('url').where('id', '=', s.id).executeTakeFirstOrThrow();
    const repository = new ProductsRepository(database);
    await Promise.all([
      refresh(s.id, [listing('first-import')]),
      repository.upsertBatch([{ shopId: s.id, externalId: 'first-import', name: 'ChatGPT Plus', spec: 'monthly', normalizedKey: 'chatgpt plus', url: source.url }]),
    ]);
    const products = await database.selectFrom('products').selectAll().where('shop_id', '=', s.id).where('external_id', '=', 'first-import').execute();
    assert.equal(products.length, 1);
    assert.equal(products[0]!.content_version, 1n);
    assert.equal((await database.selectFrom('product_change_events').select('id').where('product_id', '=', products[0]!.id).execute()).length, 1);
    assert.equal((await database.selectFrom('standardization_outbox').select('id').where('product_id', '=', products[0]!.id).execute()).length, 1);
    assert.equal((await database.selectFrom('offers').select('is_stale').where('product_id', '=', products[0]!.id).executeTakeFirstOrThrow()).is_stale, false);
  });

  test('one crawl creates one normalization job even when more than 32 products change', async () => {
    const previousModel = process.env.AI_MODEL;
    process.env.AI_MODEL = 'integration-mock';
    await database.updateTable('standardization_outbox').set({ status: 'succeeded' }).where('status', 'in', ['queued', 'running']).execute();
    try {
      const firstShop = await shop();
      const firstRun = await claim(firstShop.id);
      await refresh(firstShop.id, Array.from({ length: 97 }, (_, index) => listing(`batch-${index}`, `Product ${index}`)), firstRun);
      const secondShop = await shop();
      const secondRun = await claim(secondShop.id);
      await refresh(secondShop.id, [listing('separate-crawl')], secondRun);
      const repository = new StandardizationRepository(database, new AiRepository(database));
      const claimed = await repository.claimOutbox('batch-worker');
      assert.equal(claimed.length, 97, 'one complete crawl must remain one user-visible job before AI batching');
      const concurrent = await repository.claimOutbox('other-worker');
      assert.equal(concurrent.length, 1, 'another worker must claim the other crawl, not split the first');
      assert.ok(!concurrent.some(row => claimed.some(first => first.id === row.id)));
      const created = await repository.createIncrementalJob({ outbox: claimed, workerId: 'batch-worker', priority: 50 });
      assert.ok(created);
      const job = await database.selectFrom('ai_jobs').selectAll().where('id', '=', created.id).executeTakeFirstOrThrow();
      assert.equal(job.total, 97n);
      assert.equal(job.scope_shop_id, firstShop.id);
      assert.equal(job.source_fetch_run_id, firstRun.id);
      assert.ok((await database.selectFrom('ai_job_batches').select('id').where('job_id', '=', created.id).execute()).length > 1);
      const other = await repository.createIncrementalJob({ outbox: concurrent, workerId: 'other-worker', priority: 50 });
      assert.ok(other && other.id !== created.id);
      assert.deepEqual(await repository.claimOutbox('third-worker'), []);
    } finally {
      if (previousModel === undefined) delete process.env.AI_MODEL; else process.env.AI_MODEL = previousModel;
    }
  });

  test('a partially leased or delayed crawl cannot block another shop or be split between workers', async () => {
    for (const blocked of ['leased', 'delayed']) {
      await database.updateTable('standardization_outbox').set({ status: 'succeeded' }).where('status', 'in', ['queued', 'running']).execute();
      const first = await shop();
      await refresh(first.id, [listing('a'), listing('b'), listing('c')]);
      const second = await shop();
      await refresh(second.id, [listing('other')]);
      const firstRow = await database.selectFrom('standardization_outbox as o').innerJoin('products as p', 'p.id', 'o.product_id')
        .select('o.id').where('p.shop_id', '=', first.id).orderBy('o.id').executeTakeFirstOrThrow();
      await database.updateTable('standardization_outbox').set(blocked === 'leased'
        ? { status: 'running', claimed_by: 'old-worker', lease_until: new Date(Date.now() + 60000) }
        : { available_at: new Date(Date.now() + 60000) }).where('id', '=', firstRow.id).execute();
      const repository = new StandardizationRepository(database, new AiRepository(database));
      const other = await repository.claimOutbox('new-worker');
      assert.equal(other.length, 1, blocked + ': an incomplete group must not starve another shop');
      await database.updateTable('standardization_outbox').set({ available_at: new Date(0), lease_until: new Date(0) }).where('id', '=', firstRow.id).execute();
      const claims = await Promise.all([repository.claimOutbox('concurrent-a'), repository.claimOutbox('concurrent-b')]);
      assert.deepEqual(claims.map(rows => rows.length).sort(), [0, 3]);
    }
  });

  test('crawler content versions remain traceable through outbox events and terminal executions', async () => {
    const previousModel = process.env.AI_MODEL;
    process.env.AI_MODEL = 'integration-mock';
    await database.updateTable('standardization_outbox').set({ status: 'succeeded' }).where('status', 'in', ['queued', 'running']).execute();
    const standardization = new StandardizationRepository(database, new AiRepository(database));
    const consume = async (owner: string) => {
      const rows = await standardization.claimOutbox(owner);
      assert.ok(rows.length > 0);
      return standardization.createIncrementalJob({ outbox: rows, workerId: owner, priority: 50 });
    };
    try {
      const s = await shop();
      await refresh(s.id, [listing('trace')]);
      const product = await database.selectFrom('products').selectAll().where('shop_id', '=', s.id).where('external_id', '=', 'trace').executeTakeFirstOrThrow();
      const firstEvent = await database.selectFrom('product_change_events').selectAll().where('product_id', '=', product.id).executeTakeFirstOrThrow();
      const firstJob = await consume('trace-v1');
      assert.ok(firstJob);
      assert.deepEqual(await database.selectFrom('ai_standardization_executions')
        .select(['product_id', 'content_version', 'fingerprint', 'event_id', 'status']).where('job_id', '=', firstJob.id).executeTakeFirstOrThrow(), {
        product_id: product.id, content_version: 1n, fingerprint: firstEvent.fingerprint, event_id: firstEvent.id, status: 'registered',
      });

      await refresh(s.id, [listing('trace', 'ChatGPT Plus', 20)]);
      assert.equal((await database.selectFrom('product_change_events').select('id').where('product_id', '=', product.id).execute()).length, 1);

      await refresh(s.id, [listing('trace', 'ChatGPT Pro', 20)]);
      const secondEvent = await database.selectFrom('product_change_events').selectAll().where('product_id', '=', product.id).where('content_version', '=', 2n).executeTakeFirstOrThrow();
      const secondJob = await consume('trace-v2');
      assert.ok(secondJob);
      const executions = await database.selectFrom('ai_standardization_executions')
        .select(['content_version', 'fingerprint', 'event_id', 'status']).where('product_id', '=', product.id).orderBy('content_version').execute();
      assert.deepEqual(executions, [
        { content_version: 1n, fingerprint: firstEvent.fingerprint, event_id: firstEvent.id, status: 'superseded' },
        { content_version: 2n, fingerprint: secondEvent.fingerprint, event_id: secondEvent.id, status: 'registered' },
      ]);
      await new AiRepository(database).cancelJob(secondJob.id);
      assert.equal((await database.selectFrom('ai_standardization_executions').select('status')
        .where('job_id', '=', secondJob.id).executeTakeFirstOrThrow()).status, 'cancelled');

      await refresh(s.id, []);
      assert.equal((await database.selectFrom('product_change_events').select('id').where('product_id', '=', product.id).execute()).length, 2);
      assert.equal((await database.selectFrom('ai_standardization_executions').select('id').where('product_id', '=', product.id).execute()).length, 2);

      const nonSaleShop = await shop();
      await refresh(nonSaleShop.id, [{ ...listing('not-for-sale'), stock_available_quantity: 0 }]);
      const nonSale = await database.selectFrom('products').select('id').where('shop_id', '=', nonSaleShop.id).executeTakeFirstOrThrow();
      const nonSaleJob = await consume('trace-non-sale');
      assert.ok(nonSaleJob);
      await new AiRepository(database).cancelJob(nonSaleJob.id);
      assert.equal((await database.selectFrom('ai_standardization_executions').select('status')
        .where('product_id', '=', nonSale.id).executeTakeFirstOrThrow()).status, 'cancelled');
    } finally {
      if (previousModel === undefined) delete process.env.AI_MODEL;
      else process.env.AI_MODEL = previousModel;
    }
  });


  for (const { label, bounds, delays } of [
    { label: 'default', bounds: {}, delays: [2_700_000, 3_150_000, 3_600_000] },
    { label: 'configured upper', bounds: { targetIntervalMs: 3_600_000 }, delays: [2_700_000, 3_150_000, 3_600_000] },
    { label: 'explicit 10-45 minute', bounds: { minIntervalMs: 600_000, targetIntervalMs: 2_700_000 }, delays: [600_000, 1_650_000, 2_700_000] },
  ]) test('successful crawl redraws an interval with ' + label + ' bounds', async (context) => {
    const s = await shop();
    const shops = new ShopsRepository(database);
    await database.updateTable('shops').set({ fetch_backoff_level: 2 }).where('id', '=', s.id).execute();
    const random = context.mock.method(Math, 'random', () => 0);
    const handler = createCrawlerHandler(database, new ProductsRepository(database), {
      shops,
      ...bounds,
      fetchFactory: () => async () => new Response(JSON.stringify({ code: 1, data: { list: [listing('schedule')] } })),
    });
    for (const [index, sample] of [0, 0.5, 1 - Number.EPSILON].entries()) {
      const expectedDelayMs = delays[index]!;
      random.mock.mockImplementation(() => sample);
      const job = await claim(s.id);
      await handler(job, new AbortController().signal);
      const completedAt = Date.now();
      const row = await database.selectFrom('shops').select(['next_fetch_at', 'last_success_at', 'fetch_backoff_level', 'last_error']).where('id', '=', s.id).executeTakeFirstOrThrow();
      assert.ok(row.last_success_at);
      assert.ok(row.next_fetch_at.getTime() >= row.last_success_at.getTime() + expectedDelayMs);
      assert.ok(row.next_fetch_at.getTime() <= completedAt + expectedDelayMs);
      assert.equal(row.fetch_backoff_level, 0);
      assert.equal(row.last_error, null);
    }
  });

  test('failing crawl records backoff and last_error', async () => {
    const s = await shop();
    const shops = new ShopsRepository(database);
    const previous = globalThis.fetch;
    globalThis.fetch = async () => new Response('oops', { status: 500 });
    try {
      await assert.rejects(createCrawlerHandler(database, new ProductsRepository(database), { shops })(await claim(s.id), new AbortController().signal), /HTTP 500/);
    } finally { globalThis.fetch = previous; }
    const row = await database.selectFrom('shops').select(['next_fetch_at', 'fetch_backoff_level', 'last_error']).where('id', '=', s.id).executeTakeFirstOrThrow();
    assert.ok(row.next_fetch_at.getTime() - Date.now() >= 29_000, 'expected >= 30s backoff');
    assert.equal(row.fetch_backoff_level, 1);
    assert.match(row.last_error ?? '', /16688 goods API HTTP 500/);
    await database.updateTable('fetch_runs').set({ status: 'failed' }).where('shop_id', '=', s.id).where('status', '=', 'running').execute();
  });
});

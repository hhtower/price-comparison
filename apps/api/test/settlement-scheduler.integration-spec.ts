import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { migrateToLatest } from '../scripts/migrate.js';
import { jsonb, type DatabaseSchema } from '../src/database/types.js';
import { enqueueDueSettlements } from '../src/crawler/settlement-scheduler.js';
import { JobsRepository } from '../src/jobs/jobs.repository.js';
import { createCrawlerHandler } from '../src/workers/crawler.worker.js';
import { ProductsRepository } from '../src/products/products.repository.js';
import { productContentFingerprint } from '../src/standardization/fingerprint.js';

describe('independent settlement expiry scheduling', () => {
  let db: Kysely<DatabaseSchema>, admin: Pool, schema: string;
  const now = new Date(), ttlMs = 8_100_000;
  before(async () => {
    if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
    schema = `settlement_schedule_${Date.now()}`;
    admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`create schema "${schema}"`);
    process.env.PG_SCHEMA = schema;
    db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({
      connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path="${schema}",public`, max: 4,
    }) }) });
    await migrateToLatest(db);
  });
  after(async () => {
    await db?.destroy();
    await admin?.query(`drop schema if exists "${schema}" cascade`);
    await admin?.end();
    delete process.env.PG_SCHEMA;
  });
  beforeEach(async () => { await sql`truncate shops, standard_products restart identity cascade`.execute(db); });

  async function fixture(count = 1) {
    const shop = await db.insertInto('shops').values({ url: 'https://www.16688.com.cn/shop/expiry',
      platform: '16688', name: 'Expiry', enabled: true, next_fetch_at: new Date(now.getTime() + 3_600_000) }).returningAll().executeTakeFirstOrThrow();
    const standard = await db.insertInto('standard_products').values({ name: 'Plus', platform: 'openai', verification_state: 'verified' }).returning('id').executeTakeFirstOrThrow();
    for (let i = 0; i < count; i++) {
      const product = await db.insertInto('products').values({ shop_id: shop.id, external_id: String(i),
        name: 'Plus', normalized_key: `plus-${i}`, url: shop.url, image_url: null,
        source_name: 'Plus', source_description: '',
        content_fingerprint: productContentFingerprint({ name: 'Plus', description: '', spec: '' }),
      }).returning('id').executeTakeFirstOrThrow();
      await db.insertInto('standard_product_members').values({
        product_id: product.id, standard_product_id: standard.id, publication_state: 'published',
      }).execute();
      await db.insertInto('offers').values({ product_id: product.id, idempotency_key: `${shop.id}:${i}`,
        price: '10.00', settlement_price: '10.30', settlement_verified_at: new Date(now.getTime() - ttlMs - 1000),
        settlement_payment_method: 'Alipay', captured_at: now, settlement_refresh_at: now,
      }).execute();
    }
    return shop;
  }

  test('expiry creates a bounded independent task and re-verifies without list requests or inventory renewal', async () => {
    const shop = await fixture(125);
    assert.equal(await enqueueDueSettlements(db, 32, now, ttlMs), 1);
    const run = await db.selectFrom('fetch_runs').selectAll().executeTakeFirstOrThrow();
    assert.equal(run.task_type, 'settlement');
    assert.equal(run.source_fetch_run_id, null);
    assert.equal((run.settlement_payload as any).products.length, 100);
    assert.equal(await enqueueDueSettlements(db, 32, now, ttlMs), 0);
    const requests: string[] = [];
    const handler = createCrawlerHandler(db, new ProductsRepository(db), {
      fetchFactory: () => async (url, init) => {
        assert.doesNotMatch(String(url), /goods\/list/);
        if (String(url).endsWith('/payment/list')) return Response.json({ code: 1, data: { list: [{ id: 1, show_name: 'Alipay' }] } });
        requests.push(JSON.parse(init.body).goods_no);
        return Response.json({ code: 1, data: { total_amount: '11.30' } });
      },
    });
    await handler((await new JobsRepository(db).claimNext('fetch_run', 'expiry', 120000))!);
    assert.equal(requests.length, 100);
    const offers = await db.selectFrom('offers').selectAll().execute();
    assert.equal(offers.filter(row => row.settlement_price === '11.30').length, 100);
    assert.ok(offers.every(row => row.captured_at.getTime() === now.getTime()));
    assert.ok(offers.filter(row => row.settlement_price === '11.30').every(row =>
      row.settlement_refresh_at!.getTime() === row.settlement_verified_at!.getTime() + ttlMs));
    assert.equal(await enqueueDueSettlements(db, 32, now, ttlMs), 1, 'remaining due products get the next small task');
    assert.equal((await db.selectFrom('shops').select('next_fetch_at').where('id', '=', shop.id).executeTakeFirstOrThrow()).next_fetch_at.getTime(),
      shop.next_fetch_at.getTime());
  });

  test('large SaaS shops recover one hundred prices per queue turn while custom storefront batches stay small', async () => {
    const shop = await fixture(125);
    await enqueueDueSettlements(db, 32, now, ttlMs);
    let run = await db.selectFrom('fetch_runs').selectAll().executeTakeFirstOrThrow();
    assert.equal((run.settlement_payload as any).products.length, 100);
    let quotes = 0;
    await createCrawlerHandler(db, new ProductsRepository(db), { fetchFactory: () => async url => {
      if (String(url).endsWith('/payment/list')) return Response.json({ code: 1, data: { list: [{ id: 1, show_name: 'Alipay' }] } });
      quotes++; return Response.json({ code: 1, data: { total_amount: '11.30' } });
    } })((await new JobsRepository(db).claimNext('fetch_run', 'large-shop', 120000))!);
    assert.equal(quotes, 100);
    assert.equal(await enqueueDueSettlements(db), 1);
    run = await db.selectFrom('fetch_runs').selectAll().where('status', '=', 'queued').executeTakeFirstOrThrow();
    assert.equal((run.settlement_payload as any).products.length, 25);
    await db.deleteFrom('fetch_runs').execute();
    await db.updateTable('shops').set({ protocol: 'public-products-v1', url: 'https://suqiai.cc/' }).where('id', '=', shop.id).execute();
    await db.updateTable('offers').set({ settlement_refresh_at: now }).where('settlement_verified_at', '<', now).execute();
    assert.equal(await enqueueDueSettlements(db), 1);
    run = await db.selectFrom('fetch_runs').selectAll().where('status', '=', 'queued').executeTakeFirstOrThrow();
    assert.equal((run.settlement_payload as any).products.length, 10);
  });

  for (const [protocol, url] of [
    ['public-products-v1', 'https://suqiai.cc/'],
    ['acg-faka', 'https://douyiner.cn/'],
    ['dujiaoka', 'https://ouvg.top/'],
  ]) test(`custom ${protocol} storefronts receive missing-price and expiry supplements`, async () => {
    const shop = await fixture();
    await db.updateTable('shops').set({ protocol, url, platform: '独立站' }).where('id', '=', shop.id).execute();
    await db.updateTable('offers').set({ settlement_price: null, settlement_verified_at: null,
      settlement_payment_method: null }).execute();
    assert.equal(await enqueueDueSettlements(db, 32, now, ttlMs), 1);
    const run = await db.selectFrom('fetch_runs').selectAll().executeTakeFirstOrThrow();
    assert.equal(run.task_type, 'settlement');
    assert.equal((run.settlement_payload as any).source.protocol, protocol);
    assert.equal((run.settlement_payload as any).products.length, 1);
    assert.equal(await enqueueDueSettlements(db, 32, now, ttlMs), 0);
  });

  test('list-only custom storefronts receive estimates without remote requests', async () => {
    const shop = await fixture();
    await db.updateTable('shops').set({ protocol: 'orion-key', url: 'https://chong.nerver.cc/', platform: '自研' })
      .where('id', '=', shop.id).execute();
    assert.equal(await enqueueDueSettlements(db, 32, now, ttlMs), 1);
    await createCrawlerHandler(db, new ProductsRepository(db), { fetchFactory: () => async () => {
      throw new Error('list-only estimate must not request the network');
    } })((await new JobsRepository(db).claimNext('fetch_run', 'estimate', 120000))!);
    const offer = await db.selectFrom('offers').selectAll().executeTakeFirstOrThrow();
    assert.equal(offer.settlement_price, '10.00');
    assert.match(offer.settlement_payment_method!, /预估/);
  });

  test('future, fresh, stale, sold-out and unpublished quotes do not generate requests', async () => {
    await fixture(5);
    const rows = await db.selectFrom('offers').selectAll().orderBy('id').execute();
    await db.updateTable('offers').set({ settlement_refresh_at: new Date(now.getTime() + 1000) }).where('id', '=', rows[0]!.id).execute();
    await db.updateTable('offers').set({ settlement_verified_at: now }).where('id', '=', rows[1]!.id).execute();
    await db.updateTable('offers').set({ captured_at: new Date(now.getTime() - ttlMs) }).where('id', '=', rows[2]!.id).execute();
    await db.updateTable('offers').set({ stock_available: false }).where('id', '=', rows[3]!.id).execute();
    await db.updateTable('standard_product_members').set({ publication_state: 'provisional' }).where('product_id', '=', rows[4]!.product_id).execute();
    assert.equal(await enqueueDueSettlements(db, 32, now, ttlMs), 0);
  });

  test('a large list bounds native requests and estimates remaining prices in the same snapshot', async () => {
    const shop = await fixture(25);
    await db.insertInto('fetch_runs').values({ shop_id: shop.id, task_type: 'list', status: 'queued', started_at: now }).execute();
    let quotes = 0, observations = 0;
    await createCrawlerHandler(db, new ProductsRepository(db), { fetchFactory: () => async url => {
      if (String(url).endsWith('/goods/list')) return Response.json({ code: 1, data: { list: Array.from({ length: 25 }, (_, i) => ({
        goods_no: String(i), name: 'Plus', price: 10, stock_available_quantity: 10,
      })) } });
      if (String(url).endsWith('/payment/list')) return Response.json({ code: 1, data: { list: [{ id: 1, show_name: 'Alipay' }] } });
      if (String(url).endsWith('/shop/detail')) {
        observations++;
        return Response.json({ code: 1, data: { merchant: {} } });
      }
      assert.ok(String(url).endsWith('/payment/quotePrice'));
      quotes++; return Response.json({ code: 1, data: { total_amount: '11.30' } });
    } })((await new JobsRepository(db).claimNext('fetch_run', 'bounded-list', 120000))!);
    assert.equal(quotes, 5);
    assert.equal(observations, 1);
    const run = await db.selectFrom('fetch_runs').selectAll().executeTakeFirstOrThrow();
    assert.equal(run.status, 'succeeded');
    assert.equal(run.item_count, 25n);
    assert.equal((run.settlement_report as any).reasons.estimated, 20);
    assert.equal((run.settlement_report as any).failed, 0);
    const rows = await db.selectFrom('offers').selectAll().execute();
    assert.equal(rows.filter(row => row.settlement_price === '11.30').length, 5);
    assert.equal(rows.filter(row => row.settlement_price === '10.00' && row.settlement_payment_method!.includes('预估')).length, 20);
    assert.ok(rows.every(row => row.settlement_refresh_at! > new Date()));
    assert.equal(await enqueueDueSettlements(db), 0);
  });

  test('concurrent schedulers create one task per shop and queued lists do not prevent expiry admission', async () => {
    const shop = await fixture();
    await db.insertInto('fetch_runs').values({ shop_id: shop.id, task_type: 'list', status: 'queued', started_at: now }).execute();
    const counts = await Promise.all([enqueueDueSettlements(db, 32, now, ttlMs), enqueueDueSettlements(db, 32, now, ttlMs)]);
    assert.equal(counts.reduce((a, b) => a + b), 1);
    assert.equal((await db.selectFrom('fetch_runs').select('id').where('task_type', '=', 'settlement').execute()).length, 1);
  });

  test('an unavailable payment channel falls back to an estimate without retry amplification', async () => {
    await fixture();
    await enqueueDueSettlements(db, 32, now, ttlMs);
    const handler = createCrawlerHandler(db, new ProductsRepository(db), { fetchFactory: () => async () => Response.json({ code: 1, data: { list: [] } }) });
    await handler((await new JobsRepository(db).claimNext('fetch_run', 'expiry', 120000))!);
    const run = await db.selectFrom('fetch_runs').selectAll().executeTakeFirstOrThrow();
    assert.equal(run.status, 'succeeded');
    assert.equal((run.settlement_report as any).reasons.estimated, 1);
    assert.equal(await enqueueDueSettlements(db, 32, now, ttlMs), 0);
  });

  test('newly published missing quotes are scheduled without waiting for another list', async () => {
    const shop = await fixture();
    await db.updateTable('standard_product_members').set({ publication_state: 'provisional' }).execute();
    await db.updateTable('offers').set({ settlement_price: null, settlement_verified_at: null, settlement_payment_method: null,
      settlement_refresh_at: null }).execute();
    await db.insertInto('fetch_runs').values({ shop_id: shop.id, task_type: 'list', status: 'queued', started_at: now }).execute();
    await createCrawlerHandler(db, new ProductsRepository(db), { fetchFactory: () => async url => {
      assert.ok(String(url).endsWith('/goods/list'));
      return Response.json({ code: 1, data: { list: [{ goods_no: '0', name: 'Plus', price: 10, stock_available_quantity: 5 }] } });
    } })((await new JobsRepository(db).claimNext('fetch_run', 'list', 120000))!);
    assert.equal(await enqueueDueSettlements(db), 0, 'unpublished products stay gated');
    await db.updateTable('standard_product_members').set({ publication_state: 'published' }).execute();
    assert.equal(await enqueueDueSettlements(db), 1, 'publishing makes missing quotes eligible immediately');
  });

  test('changed minimum on an unpublished product schedules missing price now, not at its old expiry', async () => {
    const shop = await fixture();
    await db.updateTable('standard_product_members').set({ publication_state: 'provisional' }).execute();
    await db.updateTable('offers').set({ settlement_verified_at: now }).execute();
    const member = await db.selectFrom('standard_product_members').selectAll().executeTakeFirstOrThrow();
    await db.insertInto('fetch_runs').values({ shop_id: shop.id, task_type: 'list', status: 'queued', started_at: now }).execute();
    await createCrawlerHandler(db, new ProductsRepository(db), { fetchFactory: () => async url => {
      assert.ok(String(url).endsWith('/goods/list'));
      return Response.json({ code: 1, data: { list: [{ goods_no: '0', name: 'Plus', price: 10, stock_available_quantity: 5, limit_quantity: 5 }] } });
    } })((await new JobsRepository(db).claimNext('fetch_run', 'list', 120000))!);
    assert.equal((await db.selectFrom('offers').select('settlement_price').executeTakeFirstOrThrow()).settlement_price, null);
    await db.insertInto('standard_product_members').values({
      product_id: member.product_id, standard_product_id: member.standard_product_id, publication_state: 'published',
    }).onConflict(c => c.column('product_id').doUpdateSet({ publication_state: 'published' })).execute();
    assert.equal(await enqueueDueSettlements(db), 1);
  });

  test('losing publication before any request preserves scheduling eligibility when publication returns', async () => {
    await fixture();
    await enqueueDueSettlements(db, 32, now, ttlMs);
    await db.updateTable('standard_product_members').set({ publication_state: 'provisional' }).execute();
    await createCrawlerHandler(db, new ProductsRepository(db), { fetchFactory: () => async () => {
      throw new Error('unpublished quote must not use network');
    } })((await new JobsRepository(db).claimNext('fetch_run', 'unpublished', 120000))!);
    assert.equal(await enqueueDueSettlements(db), 0);
    await db.updateTable('standard_product_members').set({ publication_state: 'published' }).execute();
    assert.equal(await enqueueDueSettlements(db), 1);
  });

  test('inventory that expires while queued is not renewed by an independent quote', async () => {
    await fixture();
    await enqueueDueSettlements(db, 32, now, ttlMs);
    await db.updateTable('offers').set({ captured_at: new Date(now.getTime() - ttlMs - 1000) }).execute();
    const handler = createCrawlerHandler(db, new ProductsRepository(db), {
      fetchFactory: () => async () => { throw new Error('stale inventory must not trigger requests'); },
    });
    await handler((await new JobsRepository(db).claimNext('fetch_run', 'expired-in-queue', 120000))!);
    const row = await db.selectFrom('fetch_runs').selectAll().executeTakeFirstOrThrow();
    assert.equal(row.status, 'succeeded');
    assert.equal((row.settlement_report as any).reasons.superseded, 1);
    assert.equal(await enqueueDueSettlements(db, 32, now, ttlMs), 0);
  });

  for (const losePublication of [false, true]) test(`network failures estimate once and respect publication (lost: ${losePublication})`, async () => {
    await fixture();
    await enqueueDueSettlements(db, 32, now, ttlMs);
    const jobs = new JobsRepository(db);
    const original = await db.selectFrom('fetch_runs').select('id').executeTakeFirstOrThrow();
    let requests = 0;
    const handler = createCrawlerHandler(db, new ProductsRepository(db), {
      fetchFactory: () => async () => { requests++; throw new Error('network unavailable'); },
    });
    if (losePublication) await db.updateTable('standard_product_members').set({ publication_state: 'provisional' }).execute();
    await handler((await jobs.claimNext('fetch_run', 'network-estimate', 120000))!);
    const row = await db.selectFrom('fetch_runs').selectAll().executeTakeFirstOrThrow();
    assert.equal(row.id, original.id);
    assert.equal(row.attempts, 1n);
    assert.equal(row.status, 'succeeded');
    assert.equal(requests, losePublication ? 0 : 1);
    assert.equal(await enqueueDueSettlements(db, 32, new Date(), ttlMs), 0);
    if (losePublication) await db.updateTable('standard_product_members').set({ publication_state: 'published' }).execute();
    assert.equal(await enqueueDueSettlements(db, 32, new Date(), ttlMs), losePublication ? 1 : 0);
  });

  test('legacy oversized supplement bounds real quotes and estimates the remaining prices', async () => {
    const shop = await fixture(125);
    await enqueueDueSettlements(db, 32, now, ttlMs);
    const candidates = await db.selectFrom('products as p').innerJoin('offers as o', 'o.product_id', 'p.id')
      .select(['p.id', 'p.content_version', 'p.content_fingerprint', 'o.price', 'o.captured_at', 'o.settlement_verified_at']).execute();
    const run = await db.selectFrom('fetch_runs').selectAll().executeTakeFirstOrThrow();
    await db.updateTable('offers').set({ settlement_refresh_at: null }).execute();
    await db.updateTable('fetch_runs').set({ settlement_payload: jsonb({
      source: { url: shop.url, platform: shop.platform, protocol: shop.protocol },
      products: candidates.map(row => ({ productId: String(row.id), contentVersion: String(row.content_version),
        fingerprint: row.content_fingerprint, price: row.price, capturedAt: row.captured_at.toISOString(),
        verifiedAt: row.settlement_verified_at!.toISOString() })),
    }) }).where('id', '=', run.id).execute();
    let quotes = 0;
    await createCrawlerHandler(db, new ProductsRepository(db), { fetchFactory: () => async url => {
      if (String(url).endsWith('/payment/list')) return Response.json({ code: 1, data: { list: [{ id: 1, show_name: 'Alipay' }] } });
      quotes++; return Response.json({ code: 1, data: { total_amount: '11.30' } });
    } })((await new JobsRepository(db).claimNext('fetch_run', 'legacy', 120000))!);
    assert.equal(quotes, 100);
    const due = await db.selectFrom('offers').select('id').where('settlement_refresh_at', '<=', new Date()).execute();
    assert.equal(due.length, 0);
    assert.equal((await db.selectFrom('offers').select('id').where('settlement_payment_method', 'like', '%预估%').execute()).length, 25);
  });
});

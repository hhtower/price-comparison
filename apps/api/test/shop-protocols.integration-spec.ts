import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import type { DatabaseSchema } from '../src/database/types.js';
import { migrateToLatest } from '../scripts/migrate.js';
import { ShopsRepository } from '../src/shops/shops.repository.js';
import { ShopsService } from '../src/shops/shops.service.js';
import { ShopSubmissionsRepository } from '../src/shop-submissions/shop-submissions.repository.js';
import { ShopSubmissionsService } from '../src/shop-submissions/shop-submissions.service.js';
import { ShopSubmissionsController } from '../src/shop-submissions/shop-submissions.controller.js';
import { ProtocolDetectionService } from '../src/platforms/protocol-detection.service.js';
import { ProductsRepository } from '../src/products/products.repository.js';
import { JobsRepository } from '../src/jobs/jobs.repository.js';
import { createCrawlerHandler } from '../src/workers/crawler.worker.js';
import { createRunFetchFactory } from '../src/crawler/fetch-client.js';

const source = { id: 5, slug: 'pro', title: { 'zh-CN': 'Pro 月卡' }, skus: [{ id: 6, is_active: true, spec_values: {}, price_amount: '650.00', stock_status: 'out_of_stock', is_sold_out: true }] };
const fetchProducts: typeof fetch = async input => String(input).includes('shopApi') ? new Response(null, { status: 404 })
  : Response.json({ status_code: 0, data: String(input).includes('?') ? [source] : source, pagination: { page: 1, page_size: 12, total: 1, total_page: 1 } });

describe('shop protocol approval and complete snapshots', () => {
  let database: Kysely<DatabaseSchema>, admin: Pool, schema: string;
  let shops: ShopsRepository, submissions: ShopSubmissionsRepository;
  before(async () => {
    if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
    schema = `protocol_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await sql.raw(`create schema ${schema}`).execute(new Kysely({ dialect: new PostgresDialect({ pool: admin }) }));
    process.env.PG_SCHEMA = schema;
    database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public`, max: 4 }) }) });
    await migrateToLatest(database);
    shops = new ShopsRepository(database); submissions = new ShopSubmissionsRepository(database);
  });
  beforeEach(async () => { await sql`truncate shops, shop_submissions cascade`.execute(database); });
  after(async () => {
    await database?.destroy();
    if (schema) await admin?.query(`drop schema if exists ${schema} cascade`);
    await admin?.end(); delete process.env.PG_SCHEMA;
  });
  const detector = () => new ProtocolDetectionService({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], fetchImpl: fetchProducts });
  const seedSubmission = (input: { name: string; url: string; platform: string }) => database.insertInto('shop_submissions')
    .values({ ...input, status: 'pending', reviewed_at: null, reviewer: null, shop_id: null }).returningAll().executeTakeFirstOrThrow();

  test('submitting equivalent shop URLs creates only one canonical submission', async () => {
    const service = new ShopSubmissionsService(submissions, shops, detector());
    const first = await service.create({ name: '新店', url: 'http://wzyp.cn/shop/NEW/?ref=friend' });
    assert.equal(first.url, 'https://wzyp.cn/shop/new');
    await assert.rejects(service.create({ name: '重复', url: 'https://wzyp.cn/shop/new' }), { code: 'SHOP_SUBMISSION_EXISTS' });
    assert.equal((await database.selectFrom('shop_submissions').selectAll().execute()).length, 1);
  });

  test('submissions preserve every existing review status when a URL variant is resubmitted', async () => {
    const service = new ShopSubmissionsService(submissions, shops, detector());
    for (const status of ['pending', 'approved', 'rejected'] as const) {
      const row = await seedSubmission({ name: status, platform: '', url: `https://wzyp.cn/shop/${status.toUpperCase()}/?ref=old` });
      if (status !== 'pending') await submissions.review(row.id, status, 'admin', null);
    }
    const before = await database.selectFrom('shop_submissions').selectAll().orderBy('id').execute();
    for (const status of ['pending', 'approved', 'rejected']) {
      await assert.rejects(service.create({ name: '重复', url: `https://wzyp.cn/shop/${status}` }), { code: 'SHOP_SUBMISSION_EXISTS' });
    }
    assert.deepEqual(await database.selectFrom('shop_submissions').selectAll().orderBy('id').execute(), before);
  });

  test('submissions reject existing active, disabled and deleted shops without changing them', async () => {
    const service = new ShopSubmissionsService(submissions, shops, detector());
    for (const token of ['ACTIVE', 'DISABLED', 'DELETED']) {
      const shop = await shops.upsert({ name: token, platform: 'liandong', url: `https://wzyp.cn/shop/${token}`, enabled: token !== 'DISABLED' });
      if (token === 'DELETED') await shops.softDelete(shop.id);
    }
    const before = await database.selectFrom('shops').selectAll().orderBy('id').execute();
    for (const token of ['active', 'disabled', 'deleted']) {
      await assert.rejects(service.create({ name: '重复', url: `https://pay.ldxp.cn/shop/${token}?ref=again` }), { code: 'SHOP_EXISTS' });
    }
    assert.deepEqual(await database.selectFrom('shops').selectAll().orderBy('id').execute(), before);
    assert.deepEqual(await database.selectFrom('shop_submissions').selectAll().execute(), []);
  });

  test('concurrent equivalent submissions create one row and leave unrelated tenants separate', async () => {
    const service = new ShopSubmissionsService(submissions, shops, detector());
    const outcomes = await Promise.allSettled(['http://wzyp.cn/shop/NEW/?ref=one', 'https://wzyp.cn/shop/new']
      .map(url => service.create({ name: '新店', url })));
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(result => result.status === 'rejected' && result.reason.code === 'SHOP_SUBMISSION_EXISTS').length, 1);
    await service.create({ name: '甲', url: 'https://store.example/?tenant=one' });
    await service.create({ name: '乙', url: 'https://store.example/?tenant=two' });
    assert.equal((await database.selectFrom('shop_submissions').selectAll().execute()).length, 3);
  });

  test('public submission endpoint returns stable success and duplicate responses', async () => {
    const service = new ShopSubmissionsService(submissions, shops, detector());
    const module = await Test.createTestingModule({
      controllers: [ShopSubmissionsController],
      providers: [{ provide: ShopSubmissionsService, useValue: service }],
    }).compile();
    const app = module.createNestApplication(new FastifyAdapter(), { logger: false });
    app.enableVersioning({ type: VersioningType.URI });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const submit = (url: string) => app.getHttpAdapter().getInstance().inject({
      method: 'POST', url: '/v1/shop-submissions', payload: { name: '新店', url },
    });
    try {
      const first = await submit('https://wzyp.cn/shop/NEW?ref=friend');
      assert.equal(first.statusCode, 201);
      assert.match(first.json().id, /^[1-9]\d*$/);
      assert.equal(first.json().status, 'pending');
      const duplicate = await submit('https://wzyp.cn/shop/new');
      assert.equal(duplicate.statusCode, 409);
      assert.equal(duplicate.json().error.code, 'SHOP_SUBMISSION_EXISTS');
      const existing = await shops.upsert({ name: '已有', platform: 'liandong', url: 'https://wzyp.cn/shop/EXISTING', enabled: true });
      await shops.softDelete(existing.id);
      const removed = await submit('https://wzyp.cn/shop/existing');
      assert.equal(removed.statusCode, 409);
      assert.equal(removed.json().error.code, 'SHOP_EXISTS');
    } finally { await app.close(); }
  });

  test('approval atomically binds a protocol and concurrent review creates only one shop', async () => {
    const pending = await seedSubmission({ name: '速启AI', platform: '用户填写的平台名', url: 'https://new-shop.example/' });
    const service = new ShopSubmissionsService(submissions, shops, detector());
    const outcomes = await Promise.allSettled([service.review(pending.id, 'approve', 'admin'), service.review(pending.id, 'approve', 'other')]);
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    const rows = await database.selectFrom('shops').selectAll().execute();
    assert.equal(rows.length, 1); assert.equal(rows[0].protocol, 'public-products-v1');
    assert.equal(rows[0].platform, '用户填写的平台名');
    assert.equal((await submissions.findById(pending.id))?.shop_id, rows[0].id);
    assert.equal((await database.selectFrom('fetch_runs').selectAll().execute()).length, 1);
  });

  test('failed detection leaves a submission pending without any shop or fetch task', async () => {
    const pending = await seedSubmission({ name: '未知店', platform: '', url: 'https://unknown.example/' });
    const unavailable = new ProtocolDetectionService({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], fetchImpl: async () => new Response(null, { status: 503 }) });
    await assert.rejects(new ShopSubmissionsService(submissions, shops, unavailable).review(pending.id, 'approve', 'admin'), { code: 'SHOP_PROTOCOL_UNVERIFIED' });
    assert.equal((await submissions.findById(pending.id))?.status, 'pending');
    assert.equal((await database.selectFrom('shops').selectAll().execute()).length, 0);
    assert.equal((await database.selectFrom('fetch_runs').selectAll().execute()).length, 0);
  });

  test('listing auto-approves pending submissions matching a shop with an existing protocol', async () => {
    const service = new ShopSubmissionsService(submissions, shops, detector());
    const shop = await shops.upsert({ name: '已有协议店', platform: '链动小铺', protocol: 'liandong', url: 'https://wzyp.cn/shop/AUTO', enabled: true });
    await shops.upsert({ name: '无协议店', platform: '独立站', url: 'https://plain.example/', enabled: true });
    const duplicate = await seedSubmission({ name: '重复提交', platform: '用户平台', url: 'https://wzyp.cn/shop/AUTO/?ref=again' });
    const plain = await seedSubmission({ name: '无协议店提交', platform: '', url: 'https://plain.example/?utm_source=x' });
    const unknown = await seedSubmission({ name: '未知店', platform: '', url: 'https://unknown.example/' });
    const list = await service.listPending(1, 100);
    const duplicateRow = await submissions.findById(duplicate.id);
    assert.equal(duplicateRow?.status, 'approved');
    assert.equal(duplicateRow?.shop_id, shop.id);
    assert.equal(duplicateRow?.reviewer, null);
    assert.deepEqual(new Set(list.items.map(row => row.id)), new Set([plain.id, unknown.id]));
    assert.equal((await service.listPending(1, 100)).total, 2);
  });

  test('listing auto-approves new shops on registered protocol hosts without network probes', async () => {
    const service = new ShopSubmissionsService(submissions, shops, new ProtocolDetectionService({ lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      fetchImpl: async () => assert.fail('registered protocol hosts do not need a network probe'),
    }));
    const supported = [
      ['https://wzyp.cn/shop/NEW', 'liandong'],
      ['https://catfk.com/shop/New', 'liandong'],
      ['https://www.16688.com.cn/shop/New', '16688'],
      ['https://suqiai.cc/', 'public-products-v1'],
      ['https://cccrad.uk/', 'public-products-v1'],
      ['https://xxxyan.cc/', 'public-products-v1'],
      ['https://douyiner.cn/', 'acg-faka'],
      ['https://www.aixiamo.com/', 'acg-faka'],
      ['https://chong.nerver.cc/', 'orion-key'],
      ['https://ouvg.top/', 'dujiaoka'],
      ['https://geminipro.vip/', 'emshop'],
      ['https://catcard.uk/', 'catcard'],
      ['https://lemon-watermelon.com/', 'acg-faka-v5'],
      ['https://pay.ldxp.cn/shop/LEGACY?ref=old', 'liandong'],
    ];
    for (const [url, protocol] of supported) {
      await seedSubmission({ name: protocol, platform: '用户展示名', url });
    }
    const unknown = await seedSubmission({ name: '未知店', platform: 'liandong', url: 'https://unknown.example/' });
    const invalid = await seedSubmission({ name: '无店铺路径', platform: 'liandong', url: 'https://catfk.com/' });
    const rejected = await seedSubmission({ name: '已拒绝', platform: '', url: 'https://wzyp.cn/shop/rejected' });
    await submissions.review(rejected.id, 'rejected', 'admin', null);
    const [first, second] = await Promise.all([service.listPending(1, 1), service.listPending(2, 1)]);
    assert.equal(first.total, 2); assert.equal(second.total, 2);
    assert.deepEqual(new Set([...first.items, ...second.items].map(row => row.id)), new Set([unknown.id, invalid.id]));
    const approved = await database.selectFrom('shop_submissions').selectAll().where('status', '=', 'approved').execute();
    assert.equal(approved.length, supported.length);
    for (const row of approved) {
      const shop = await shops.findById(row.shop_id!);
      assert.ok(shop);
      assert.equal(shop.protocol, supported.find(([url]) => url === row.url)?.[1]);
      assert.equal(shop.platform, row.platform); assert.equal(shop.name, row.name);
      assert.equal(shop.enabled, true); assert.equal(row.reviewer, null); assert.ok(row.reviewed_at);
      assert.ok(!shop.url.includes('pay.ldxp.cn'));
    }
    const before = await database.selectFrom('shops').selectAll().orderBy('id').execute();
    assert.equal((await service.listPending(1, 100)).total, 2);
    assert.deepEqual(await database.selectFrom('shops').selectAll().orderBy('id').execute(), before);
    assert.equal((await submissions.findById(rejected.id))?.status, 'rejected');
    assert.equal((await database.selectFrom('fetch_runs').selectAll().execute()).length, 0);
  });

  test('automatic approval reuses canonical shops and preserves disabled and deleted records', async () => {
    const service = new ShopSubmissionsService(submissions, shops, detector());
    const disabled = await shops.upsert({ name: '停用店', platform: '原平台', protocol: 'liandong', url: 'https://wzyp.cn/shop/DISABLED', enabled: false });
    const deleted = await shops.upsert({ name: '删除店', platform: '原平台', protocol: 'liandong', url: 'https://wzyp.cn/shop/DELETED', enabled: true });
    await shops.softDelete(deleted.id);
    const before = await database.selectFrom('shops').selectAll().orderBy('id').execute();
    const duplicate = await seedSubmission({ name: '不同名称', platform: '', url: 'https://wzyp.cn/shop/disabled/?ref=x' });
    const removed = await seedSubmission({ name: '不同名称', platform: '', url: 'https://wzyp.cn/shop/deleted/?ref=x' });
    const variants = await Promise.all(['https://catfk.com/shop/SAME', 'https://catfk.com/shop/SAME/?ref=again']
      .map(url => seedSubmission({ name: '新店', platform: '', url })));
    assert.equal((await service.listPending(1, 100)).total, 1);
    assert.equal((await submissions.findById(duplicate.id))?.shop_id, disabled.id);
    assert.equal((await submissions.findById(removed.id))?.status, 'pending');
    assert.deepEqual((await database.selectFrom('shops').selectAll().orderBy('id').execute()).slice(0, 2), before);
    assert.equal((await submissions.findById(variants[0].id))?.shop_id, (await submissions.findById(variants[1].id))?.shop_id);
    assert.equal((await database.selectFrom('shops').selectAll().execute()).length, 3);
  });

  test('automatic approval rolls back shop creation when updating the submission fails', async () => {
    const pending = await seedSubmission({ name: '回滚店', platform: '', url: 'https://catfk.com/shop/ROLLBACK' });
    await sql`alter table shop_submissions add constraint test_auto_approval check (status <> 'approved')`.execute(database);
    try {
      await assert.rejects(new ShopSubmissionsService(submissions, shops, detector()).listPending(1, 100));
      assert.equal((await submissions.findById(pending.id))?.status, 'pending');
      assert.equal((await database.selectFrom('shops').selectAll().execute()).length, 0);
    } finally { await sql`alter table shop_submissions drop constraint test_auto_approval`.execute(database); }
  });

  test('automatic approval does not block a submission being manually reviewed', async () => {
    const pending = await seedSubmission({ name: '审核中', platform: '', url: 'https://catfk.com/shop/LOCKED' });
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const manual = submissions.approve(pending.id, 'admin', async (row, transaction) => {
      locked(); await gate;
      return shops.upsert({ name: row.name, platform: row.platform, url: row.url, protocol: 'liandong', enabled: true }, transaction);
    });
    await ready;
    try {
      assert.equal((await new ShopSubmissionsService(submissions, shops, detector()).listPending(1, 100)).total, 1);
    } finally { release(); await manual; }
    assert.equal((await submissions.findById(pending.id))?.reviewer, 'admin');
    assert.equal((await database.selectFrom('shops').selectAll().execute()).length, 1);
  });

  test('automatic approval binds an existing unbound HTTP shop without changing its identity or disabled state', async () => {
    const shop = await shops.upsert({ name: '保留名称', platform: '保留平台', url: 'http://wzyp.cn/shop/HTTP/?ref=old', enabled: false });
    const pending = await seedSubmission({ name: '提交名称', platform: '提交平台', url: 'https://wzyp.cn/shop/http' });
    assert.equal((await new ShopSubmissionsService(submissions, shops, detector()).listPending(1, 100)).total, 0);
    const current = await shops.findById(shop.id);
    assert.ok(current);
    assert.equal(current.url, 'https://wzyp.cn/shop/http');
    assert.equal(current.protocol, 'liandong'); assert.equal(current.enabled, false);
    assert.equal(current.name, shop.name); assert.equal(current.platform, shop.platform);
    assert.equal((await submissions.findById(pending.id))?.shop_id, shop.id);
    assert.equal((await database.selectFrom('shops').selectAll().execute()).length, 1);
  });

  test('automatic approval prefers an existing canonical shop over an earlier unbound URL variant', async () => {
    const service = new ShopSubmissionsService(submissions, shops, detector());
    for (const state of ['disabled', 'deleted']) {
      await shops.upsert({ name: '历史变体', platform: '旧平台', url: `http://wzyp.cn/shop/${state.toUpperCase()}/?ref=old`, enabled: true });
      const canonical = await shops.upsert({ name: '规范店', platform: '原平台', url: `https://wzyp.cn/shop/${state}`, protocol: 'liandong', enabled: false });
      if (state === 'deleted') await shops.softDelete(canonical.id);
      const before = await database.selectFrom('shops').selectAll().orderBy('id').execute();
      const pending = await seedSubmission({ name: '提交名称', platform: '', url: `${canonical.url}?ref=again` });
      await service.listPending(1, 100);
      const reviewed = await submissions.findById(pending.id);
      assert.equal(reviewed?.status, state === 'deleted' ? 'pending' : 'approved');
      assert.equal(reviewed?.shop_id, state === 'deleted' ? null : canonical.id);
      assert.deepEqual(await database.selectFrom('shops').selectAll().orderBy('id').execute(), before);
    }
  });

  test('a concurrent source edit cannot apply a protocol validated against the old URL', async () => {
    const shop = await shops.upsert({ name: 'Race', platform: 'Public', protocol: 'public-products-v1', url: 'https://old.example/', enabled: true });
    const protocols = { requireMatch: async () => {
      await shops.update(shop.id, { url: 'https://replacement.example/', protocol: '16688' });
      return 'public-products-v1';
    } };
    await assert.rejects(new ShopsService(shops, protocols as any).update(shop.id, { protocol: 'public-products-v1' }), { code: 'SHOP_SOURCE_CHANGED' });
    const current = await shops.findById(shop.id);
    assert.equal(current?.url, 'https://replacement.example/');
    assert.equal(current?.protocol, '16688');
  });

  async function crawlBoundShop(fetchImpl: typeof fetch = fetchProducts, protocol = 'public-products-v1', url = 'https://new-shop.example/') {
    const shop = await shops.upsert({ name: 'Public', platform: '任意展示名', protocol, url, enabled: true });
    await shops.enqueueRefresh([shop.id]);
    const job = await new JobsRepository(database).claimNext('fetch_run', 'protocol-test', 120000);
    assert.ok(job);
    const handler = createCrawlerHandler(database, new ProductsRepository(database), {
      fetchFactory: createRunFetchFactory({
        limiter: { acquire: async () => {}, pause: async () => {} } as any,
        pool: { acquire: async (_signal: AbortSignal, _preferred: unknown, admit: () => Promise<void>) => {
          await admit();
          return { proxyUrl: null, release() {}, reportSuccess() {}, reportFailure() {} };
        } } as any,
        fetchImpl: fetchImpl as any,
      }),
      publicFetchFactory: async (_proxy: unknown, options: any) => ({ fetch: options.fetchImpl, close: async () => {} }),
    } as any);
    await handler(job);
    return shop;
  }

  test('crawler uses the saved protocol on a new host and persists SKU price and sold-out state', async () => {
    const shop = await crawlBoundShop();
    const product = await database.selectFrom('products').selectAll().where('shop_id', '=', shop.id).executeTakeFirstOrThrow();
    assert.equal(product.external_id, '5:6');
    const offer = await database.selectFrom('offers').selectAll().where('product_id', '=', product.id).executeTakeFirstOrThrow();
    assert.equal(Number(offer.price), 650); assert.equal(offer.stock_available, false);
  });

  test('partial detail failure does not delete previous products', async () => {
    const shop = await crawlBoundShop();
    await assert.rejects(crawlBoundShop(async input => String(input).includes('?') ? fetchProducts(input) : new Response(null, { status: 503 })));
    const products = await database.selectFrom('products').selectAll().where('shop_id', '=', shop.id).execute();
    assert.equal(products.length, 1); assert.equal(products[0].deleted_at, null);
  });

  test('new acg protocol persists actual variant quotes and rolls back partial stock failures', async () => {
    const product = { id: 17, name: 'GPT月卡', status: 1, inventory_hidden: 0, minimum: 0, draft_status: 0,
      config: { category: { 月卡: 5, 年卡: 50 } } };
    const api: typeof fetch = async input => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/commodity')) return Response.json({ code: 200, total: 1, data: [product] });
      if (path.endsWith('/commodityDetail')) return Response.json({ code: 200, data: product });
      if (path.endsWith('/stock')) return Response.json({ code: 200, data: { stock: 0, stock_state: 0 } });
      assert.ok(path.endsWith('/valuation'));
      return Response.json({ code: 200, data: { price: '6.25' } });
    };
    const shop = await crawlBoundShop(api, 'acg-faka', 'https://douyiner.cn/');
    const before = await database.selectFrom('products').selectAll().where('shop_id', '=', shop.id).orderBy('id').execute();
    assert.equal(before.length, 2);
    const offers = await database.selectFrom('offers').selectAll().where('product_id', 'in', before.map(row => row.id)).execute();
    assert.ok(offers.every(row => Number(row.price) === 6.25 && row.stock_available === false));
    await assert.rejects(crawlBoundShop(async (input, init) => String(input).endsWith('/stock')
      ? new Response(null, { status: 503 }) : api(input, init), 'acg-faka', shop.url));
    assert.deepEqual(await database.selectFrom('products').selectAll().where('shop_id', '=', shop.id).orderBy('id').execute(), before);
  });

  test('classic HTML protocol passes the production transport and persists detail-backed SKU stock', async () => {
    const root = '<html><link href="/assets/unicorn/css/index.css"><div id="goodsTabContent"><div id="group-all"><a href="/buy/252">商品</a></div><div id="group-1"><a href="/buy/252">商品</a></div></div></html>';
    const detail = '<html><h3 class="card-title">GPT Plus</h3><input name="gid" value="252"><label class="formal-sku-btn" data-sku-id="9" data-sku-price="130.00" data-sku-stock="16">月卡</label></html>';
    const shop = await crawlBoundShop(async input => new Response(new URL(String(input)).pathname === '/' ? root : detail,
      { headers: { 'content-type': 'text/html' } }), 'dujiaoka', 'https://ouvg.top/');
    const row = await database.selectFrom('products').selectAll().where('shop_id', '=', shop.id).executeTakeFirstOrThrow();
    assert.equal(row.external_id, '252:9');
    const offer = await database.selectFrom('offers').selectAll().where('product_id', '=', row.id).executeTakeFirstOrThrow();
    assert.equal(Number(offer.price), 130); assert.equal(offer.stock_available, true);
  });

  test('changing a protocol during a fetch rejects the obsolete snapshot', async () => {
    await assert.rejects(crawlBoundShop(async input => {
      if (!String(input).includes('?')) await database.updateTable('shops').set({ protocol: '16688' }).execute();
      return fetchProducts(input);
    }), /source changed/);
    assert.equal((await database.selectFrom('products').selectAll().execute()).length, 0);
  });

});

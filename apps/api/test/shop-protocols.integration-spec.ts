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

  test('pending pages never load or approve the complete submission and shop collections', async () => {
    await sql`insert into shops(platform, url, name, rating_manifest)
      select 'audit', 'https://audit-shop-' || n || '.example/', 'Shop ' || n,
        jsonb_build_object('units', jsonb_build_array(jsonb_build_object('unitId', n::text, 'hash', repeat('a', 64))))
      from generate_series(1, 30) n`.execute(database);
    await sql`insert into shop_submissions(platform, url, name, status)
      select 'audit', 'https://audit-submission-' || n || '.example/', 'Submission ' || n, 'pending'
      from generate_series(1, 200) n`.execute(database);
    const before = await database.selectFrom('shop_submissions').selectAll().orderBy('id').execute();
    const beforeShops = await database.selectFrom('shops').selectAll().orderBy('id').execute();
    const pendingBatches: number[] = [];
    const shopBatches: number[] = [];
    const measured = database.withPlugin({
      transformQuery: args => args.node,
      async transformResult(args) {
        const rows = args.result.rows;
        if (rows[0] && 'status' in rows[0] && 'url' in rows[0]) pendingBatches.push(rows.length);
        if (rows[0] && 'rating_manifest' in rows[0]) shopBatches.push(rows.length);
        return args.result;
      },
    });
    const service = new ShopSubmissionsService(new ShopSubmissionsRepository(measured), new ShopsRepository(measured), detector());
    const first = await service.listPending(1, 1);
    const second = await service.listPending(2, 1);
    assert.ok(pendingBatches.every(size => size <= 1), `page limit must bound submission reads: ${pendingBatches}`);
    assert.deepEqual(shopBatches, [], 'reading pending pages must not load shop payloads');
    assert.equal(first.total, 200);
    assert.equal(second.total, 200);
    assert.equal(first.items.length, 1);
    assert.equal(second.items.length, 1);
    assert.notEqual(first.items[0]!.id, second.items[0]!.id);
    assert.deepEqual(await database.selectFrom('shop_submissions').selectAll().orderBy('id').execute(), before);
    assert.deepEqual(await database.selectFrom('shops').selectAll().orderBy('id').execute(), beforeShops);
  });

  test('registered hosts are approved at creation while unrelated URL checks stay bounded', async () => {
    await sql`insert into shops(platform, url, name)
      select 'audit', 'https://create-shop-' || n || '.example/', 'Shop ' || n
      from generate_series(1, 200) n`.execute(database);
    await sql`insert into shop_submissions(platform, url, name, status)
      select 'audit', 'https://create-submission-' || n || '.example/', 'Submission ' || n, 'pending'
      from generate_series(1, 200) n`.execute(database);
    const reads: number[] = [];
    const measured = database.withPlugin({
      transformQuery: args => args.node,
      async transformResult(args) {
        const rows = args.result.rows;
        if (rows[0] && 'url' in rows[0]) reads.push(rows.length);
        return args.result;
      },
    });
    const service = new ShopSubmissionsService(new ShopSubmissionsRepository(measured), new ShopsRepository(measured),
      new ProtocolDetectionService({ fetchImpl: async () => assert.fail('registered hosts do not need probing') }));
    const created = await service.create({ name: 'Auto-approved shop', url: 'https://catfk.com/shop/CREATED', platform: 'User platform' });
    assert.equal(created.status, 'approved');
    assert.ok(created.shop_id);
    assert.ok(created.reviewed_at);
    assert.equal(created.reviewer, null);
    assert.ok(reads.every(size => size <= 100), `creation must not retain entire URL collections: ${reads}`);
    const shop = await shops.findById(created.shop_id);
    assert.equal(shop?.protocol, 'liandong');
    assert.equal(shop?.name, 'Auto-approved shop');
    assert.equal(shop?.platform, 'User platform');
    assert.equal((await service.listPending(1, 1)).total, 200);
    assert.equal((await database.selectFrom('fetch_runs').selectAll().execute()).length, 0);
    await assert.rejects(service.create({ name: 'Missing tenant', url: 'https://catfk.com/' }), { code: 'INVALID_URL' });
    const unknown = await service.create({ name: 'Unknown', url: 'https://not-registered.example/' });
    assert.equal(unknown.status, 'pending');
  });

  test('creation rolls back both submission and shop when automatic approval fails', async () => {
    const service = new ShopSubmissionsService(submissions, shops, detector());
    await sql`alter table shop_submissions add constraint test_create_approval check (status <> 'approved')`.execute(database);
    try {
      await assert.rejects(service.create({ name: 'Rollback', url: 'https://catfk.com/shop/CREATE-ROLLBACK' }));
      assert.deepEqual(await database.selectFrom('shops').selectAll().execute(), []);
      assert.deepEqual(await database.selectFrom('shop_submissions').selectAll().execute(), []);
    } finally { await sql`alter table shop_submissions drop constraint test_create_approval`.execute(database); }
  });

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

  test('an uncommitted unrelated shop write does not block submission creation', async () => {
    const existing = await shops.upsert({ name: 'Crawler shop', platform: '', url: 'https://crawler.example/', enabled: true });
    const writer = await admin.connect();
    try {
      await writer.query('begin');
      await writer.query(`update "${schema}".shops set last_error = 'uncommitted crawler write' where id = $1`, [existing.id]);
      const service = new ShopSubmissionsService(submissions, shops, detector());
      const created = await service.create({ name: 'Independent', url: 'https://catfk.com/shop/independent' });
      assert.equal(created.status, 'approved');
      assert.ok(created.shop_id);
      assert.equal((await shops.findById(existing.id))?.last_error, null);
    } finally {
      await writer.query('rollback');
      writer.release();
    }
  });

  test('a transaction creating one URL does not block another URL', async () => {
    const url = 'https://first-concurrent.example/';
    let release!: () => void, inserted!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { inserted = resolve; });
    const held = database.withPlugin({
      transformQuery: args => args.node,
      async transformResult(args) {
        if (args.result.rows.some(row => row.url === url && row.status === 'pending')) {
          inserted();
          await gate;
        }
        return args.result;
      },
    });
    const first = new ShopSubmissionsService(new ShopSubmissionsRepository(held), shops, detector())
      .create({ name: 'First', url });
    try {
      await Promise.race([ready, first.then(() => assert.fail('first transaction must remain open'))]);
      const second = await new ShopSubmissionsService(submissions, shops, detector())
        .create({ name: 'Second', url: 'https://second-concurrent.example/' });
      assert.equal(second.status, 'pending');
    } finally {
      release();
      await first;
    }
    assert.equal((await database.selectFrom('shop_submissions').select('id').execute()).length, 2);
  });

  test('a concurrent administrator insert cannot be overwritten by automatic approval', async () => {
    const url = 'https://wzyp.cn/shop/admin-race';
    const writer = await admin.connect();
    let release!: () => void, checked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { checked = resolve; });
    const paused = database.withPlugin({
      transformQuery: args => args.node,
      async transformResult(args) {
        if (args.result.rows.some(row => row.url === url && row.status === 'pending')) {
          checked();
          await gate;
        }
        return args.result;
      },
    });
    const creation = new ShopSubmissionsService(new ShopSubmissionsRepository(paused), shops, detector())
      .create({ name: 'Submitted name', url });
    try {
      await Promise.race([ready, creation.then(() => assert.fail('creation must wait after checking existing URLs'))]);
      await writer.query(`insert into "${schema}".shops (url, name, platform, enabled)
        values ($1, 'Administrator name', 'Administrator platform', false)`, [url]);
    } finally {
      release();
      writer.release();
    }
    await assert.rejects(creation, { code: 'SHOP_EXISTS' });
    const existing = await database.selectFrom('shops').select(['name', 'platform', 'enabled']).where('url', '=', url).executeTakeFirstOrThrow();
    assert.deepEqual(existing, { name: 'Administrator name', platform: 'Administrator platform', enabled: false });
    assert.deepEqual(await database.selectFrom('shop_submissions').selectAll().execute(), []);
  });

  test('equivalent URLs wait on the same advisory lock and return BUSY without leaving writes', async () => {
    const holder = await admin.connect();
    const service = new ShopSubmissionsService(submissions, shops, detector());
    const module = await Test.createTestingModule({
      controllers: [ShopSubmissionsController],
      providers: [{ provide: ShopSubmissionsService, useValue: service }],
    }).compile();
    const app = module.createNestApplication(new FastifyAdapter(), { logger: false });
    try {
      await holder.query('begin');
      await holder.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", ['shop-submission:https://wzyp.cn/shop/locked']);
      app.enableVersioning({ type: VersioningType.URI });
      await app.init();
      const http = app.getHttpAdapter().getInstance();
      await http.ready();
      const response = await http.inject({
        method: 'POST', url: '/v1/shop-submissions',
        payload: { name: 'Locked', url: 'http://wzyp.cn/shop/LOCKED/?ref=friend' },
      });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error.code, 'SHOP_SUBMISSION_BUSY');
      assert.ok(response.json().error.message);
      assert.deepEqual(await database.selectFrom('shop_submissions').selectAll().execute(), []);
      assert.deepEqual(await database.selectFrom('shops').selectAll().execute(), []);
      await holder.query('rollback');
      const created = await service.create({ name: 'Released', url: 'https://wzyp.cn/shop/locked' });
      assert.equal(created.status, 'approved');
    } finally {
      await holder.query('rollback');
      holder.release();
      await app.close();
    }
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
      assert.equal(first.json().status, 'approved');
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

  test('known protocol hosts never enter pending pages', async () => {
    const service = new ShopSubmissionsService(submissions, shops, new ProtocolDetectionService({
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
      ['https://pay.ldxp.cn/shop/ALIAS?ref=tracking', 'liandong'],
    ];
    for (const [url, protocol] of supported) {
      const created = await service.create({ name: protocol!, platform: 'Display platform', url: url! });
      assert.equal(created.status, 'approved');
      const shop = await shops.findById(created.shop_id!);
      assert.equal(shop?.protocol, protocol);
      assert.equal(shop?.url, created.url);
      assert.equal(shop?.enabled, true);
    }
    const firstUnknown = await service.create({ name: 'Unknown one', url: 'https://unknown-one.example/' });
    const secondUnknown = await service.create({ name: 'Unknown two', url: 'https://unknown-two.example/' });
    const rejected = await service.create({ name: 'Rejected', url: 'https://rejected.example/' });
    await submissions.review(rejected.id, 'rejected', 'admin', null);
    const before = await database.selectFrom('shops').selectAll().orderBy('id').execute();
    const [first, second] = await Promise.all([service.listPending(1, 1), service.listPending(2, 1)]);
    assert.equal(first.total, 2);
    assert.equal(second.total, 2);
    assert.deepEqual(new Set([...first.items, ...second.items].map(row => row.id)), new Set([firstUnknown.id, secondUnknown.id]));
    assert.deepEqual(await database.selectFrom('shops').selectAll().orderBy('id').execute(), before);
    assert.equal((await submissions.findById(rejected.id))?.status, 'rejected');
  });

  test('pending pages do not lock submissions under manual review', async () => {
    const pending = await seedSubmission({ name: 'Under review', platform: '', url: 'https://manual-review.example/' });
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const manual = submissions.approve(pending.id, 'admin', async (row, transaction) => {
      locked(); await gate;
      return shops.upsert({ name: row.name, platform: row.platform, url: row.url, protocol: 'public-products-v1', enabled: true }, transaction);
    });
    await ready;
    try {
      assert.equal((await new ShopSubmissionsService(submissions, shops, detector()).listPending(1, 100)).total, 1);
    } finally { release(); await manual; }
    assert.equal((await submissions.findById(pending.id))?.reviewer, 'admin');
    assert.equal((await database.selectFrom('shops').selectAll().execute()).length, 1);
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
      if (path.endsWith('/data')) return Response.json({ code: 200, data: [] });
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

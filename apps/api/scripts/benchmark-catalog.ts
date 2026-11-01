import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { migrateToLatest } from './migrate.js';
import type { DatabaseSchema } from '../src/database/types.js';
import { CatalogRepository } from '../src/catalog/catalog.repository.js';
import { CatalogService } from '../src/catalog/catalog.service.js';
import { CatalogController } from '../src/catalog/catalog.controller.js';
import { createCache } from '../src/cache/cache.js';
import { publishNextCatalogChange } from '../src/catalog/catalog-projection.js';
import { TEXT_REVIEW_VERSION } from '../src/shops/shop-text-review.js';

// Synthetic, isolated HTTP benchmark; never read deployment credentials or data.
const connectionString = process.env.TEST_DATABASE_URL;
assert.ok(connectionString, 'Set TEST_DATABASE_URL to a dedicated local PostgreSQL instance');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname));
const count = Number(process.env.CATALOG_BENCHMARK_OFFERS ?? 20_000);
assert.ok(Number.isSafeInteger(count) && count >= 1000 && count <= 1_000_000);
const schema = `catalog_bench_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString });
await admin.query(`create schema "${schema}"`);
process.env.PG_SCHEMA = schema;
const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: new Pool({
  connectionString, options: `-c search_path=${schema},public -c jit=off`,
}) }) });
const cache = createCache();
const repository = new CatalogRepository(database);
const service = new CatalogService(repository, cache);
class BenchmarkModule {}
const app = await NestFactory.create({ module: BenchmarkModule, controllers: [CatalogController],
  providers: [{ provide: CatalogService, useValue: service }] }, new FastifyAdapter(), { logger: false });
try {
  await migrateToLatest(database);
  await sql`insert into shops (name, platform, protocol, url, rating_manifest)
    select 'Merchant ' || n, 'alpha', 'dujiaoka', 'https://bench-' || n || '.invalid',
      jsonb_build_object('sourceUrl', 'https://bench-' || n || '.invalid', 'sourceProtocol', 'dujiaoka',
        'sourcePlatform', 'alpha', 'observedAt', (extract(epoch from now()) * 1000)::bigint,
        'units', (select jsonb_agg(jsonb_build_object('unitId', u::text, 'hash', md5(u::text) || md5((u+1)::text)))
          from generate_series(1, 2000) u))
    from generate_series(1, 200) n`.execute(database);
  await sql`insert into standard_products (name, platform, verification_state)
    select 'Plan ' || n, case when n % 2 = 0 then 'openai' else 'anthropic' end, 'verified'
    from generate_series(1, 100) n`.execute(database);
  await sql`insert into products (shop_id, external_id, name, normalized_key, url, spec)
    select (n-1) % 200 + 1, n::text, 'Package ' || n, n::text, 'https://bench.invalid/' || n,
      case when n % 3 = 0 then '独享 质保30天' else '共享 质保7天' end
    from generate_series(1, ${count}::int) n`.execute(database);
  await sql`insert into standard_product_members (product_id, standard_product_id)
    select id, (id / 200) % 100 + 1 from products`.execute(database);
  await sql`insert into product_tags (product_id, name, value)
    select id, 'warranty_days', case when id % 3 = 0 then '30' else '7' end from products`.execute(database);
  await sql`insert into offers (idempotency_key, product_id, price, currency, captured_at,
      settlement_price, settlement_verified_at, settlement_payment_method)
    select 'bench-' || id, id, (id * 71) % 997 + 1, 'CNY', now() - interval '2 days',
      (id * 71) % 997 + 1, now() - interval '2 days', 'alipay' from products`.execute(database);
  const review = {
    answers: Object.fromEntries(['L1','L2','L3','R1','R2','R3','A1','A2'].map(key => [key,
      { value: true, reason: 'Explicit', evidence: [{ field: 'name', quote: 'Plan' }] }])),
    consistency: Object.fromEntries(['C1','C2','C3','C4','C5','C6'].map(key => [key,
      { value: false, reason: 'Consistent', evidence: [] }])),
  };
  await sql`update products p set source_data = jsonb_build_object('ratingText', jsonb_build_object(
      'unitId', ((p.id-1)/200+1)::text, 'name', 'Plan', 'description', repeat('Complete body ', 100),
      'hash', md5(((p.id-1)/200+1)::text) || md5(((p.id-1)/200+2)::text))),
    text_review = jsonb_build_object('version', ${TEXT_REVIEW_VERSION}::text, 'contentVersion', p.content_version::text,
      'fingerprint', p.content_fingerprint, 'source', jsonb_build_object('url', s.url, 'protocol', s.protocol, 'platform', s.platform),
      'textHash', md5(((p.id-1)/200+1)::text) || md5(((p.id-1)/200+2)::text), 'review', ${JSON.stringify(review)}::jsonb)
    from shops s where p.shop_id = s.id and p.id <= 4000`.execute(database);
  const reviewed = await sql<{ count: number }>`select count(*)::int as count from products where text_review_key is not null`.execute(database);
  assert.equal(reviewed.rows[0]!.count, Math.min(count, 4000));
  while (await publishNextCatalogChange(database)) {}
  await sql`analyze`.execute(database);
  const starts = new WeakMap<object, number>();
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onRequest', async (request: object) => { starts.set(request, performance.now()); });
  fastify.addHook('onSend', async (request: object, reply: { header(name: string, value: string): void }, payload: unknown) => {
    reply.header('server-timing', `catalog;dur=${(performance.now() - starts.get(request)!).toFixed(3)}`);
    return payload;
  });
  const serverDuration = (response: Response) => {
    const duration = Number(response.headers.get('server-timing')?.split('dur=')[1]);
    assert.ok(Number.isFinite(duration) && duration > 0);
    return duration;
  };
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const cases = [
    ['homepage', 'limit=20'], ['platform', 'platform=openai&limit=20'],
    ['first-search', 'q=Package%201234&limit=20'], ['broad-search', 'q=Package&limit=20'],
    ['filter', 'warrantyDaysMin=30&limit=20'], ['price-sort', 'sort=price&limit=20'],
    ['detail', 'standardProductId=1&detailKind=offers&detailPage=1&limit=20'],
  ];
  const coldStart = performance.now();
  const coldResponse = await fetch(`${base}/api/catalog?limit=20`);
  assert.equal(coldResponse.status, 200);
  const first = await coldResponse.json() as Awaited<ReturnType<CatalogService['getCatalog']>>;
  const fullyColdMs = +(performance.now() - coldStart).toFixed(1);
  assert.ok(first.nextCursor);
  cases.push(['pagination', 'limit=20&cursor=' + first.nextCursor]);
  const results = [];
  for (const [name, query] of cases) {
    const samples = [];
    const serverSamples = [];
    for (let n = 0; n < 25; n++) {
      await Promise.all(cache.stores.map(store => store.clear()));
      const start = performance.now();
      const response = await fetch(`${base}/api/catalog?${query}`);
      assert.equal(response.status, 200);
      const page = await response.json() as { items: unknown[] };
      assert.ok(page.items.length, `${name} must exercise a nonempty result`);
      samples.push(performance.now() - start);
      serverSamples.push(serverDuration(response));
    }
    samples.sort((a, b) => a - b);
    serverSamples.sort((a, b) => a - b);
    results.push({ case: name, serverP95Ms: +serverSamples[23]!.toFixed(1), p50Ms: +samples[12]!.toFixed(1), p95Ms: +samples[23]!.toFixed(1), maxMs: +samples[24]!.toFixed(1) });
  }
  const concurrent = [];
  const concurrentServer = [];
  for (let round = 0; round < 10; round++) {
    await Promise.all(cache.stores.map(store => store.clear()));
    concurrent.push(...await Promise.all(cases.slice(0, 4).map(async ([, query]) => {
      const start = performance.now();
      const response = await fetch(`${base}/api/catalog?${query}`);
      assert.equal(response.status, 200);
      await response.json();
      concurrentServer.push(serverDuration(response));
      return performance.now() - start;
    })));
  }
  concurrent.sort((a, b) => a - b);
  concurrentServer.sort((a, b) => a - b);
  console.log(JSON.stringify({ concurrency4ServerP95Ms: +concurrentServer[Math.ceil(concurrentServer.length * 0.95) - 1]!.toFixed(1), concurrency4P95Ms: +concurrent[Math.ceil(concurrent.length * 0.95) - 1]!.toFixed(1), offers: count, shops: 200, standards: 100, reviewedProducts: reviewed.rows[0]!.count, fullyColdMs, responseCache: 'cleared before every request', results }, null, 2));
  if (process.env.CATALOG_BENCHMARK_EXPLAIN) console.log(JSON.stringify(await repository.explain({ search: 'Package', tags: [], limit: 20 }), null, 2));
} finally {
  await app.close();
  await cache.disconnect();
  await database.destroy();
  await admin.query(`drop schema "${schema}" cascade`);
  await admin.end();
}

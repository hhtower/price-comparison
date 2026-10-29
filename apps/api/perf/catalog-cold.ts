import 'reflect-metadata';
import '../src/config/env.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { VersioningType, type INestApplication } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { createCache } from 'cache-manager';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { catalogCacheOptions } from '../src/cache/cache.module.js';
import { CatalogController } from '../src/catalog/catalog.controller.js';
import { CatalogRepository } from '../src/catalog/catalog.repository.js';
import { CatalogService, normalizeCatalogQuery } from '../src/catalog/catalog.service.js';
import { createPostgresPool, DATABASE } from '../src/database/database.providers.js';
import type { DatabaseSchema } from '../src/database/types.js';
import { up } from '../src/database/migrations/016_catalog_read_offers_20261023.js';
import { up as upFacetCounts } from '../src/database/migrations/017_catalog_facet_counts_20261023.js';
import { up as rebuildProjection } from '../src/database/migrations/019_catalog_projection_rebuild_20261023.js';

const SAMPLES = 30;
const BUDGET_MS = 100;
const SNAPSHOT_COLUMNS = {
  products: 'id, shop_id, name, url, spec, normalized_key, deleted_at',
  shops: 'id, name, enabled, deleted_at',
  standard_products: 'id, name, platform, sort_order, canonical_family, canonical_product, canonical_tier, aliases, hidden, merged_into_id, verification_state',
  standard_product_members: 'product_id, standard_product_id, publication_state',
  offers: 'id, product_id, price, currency, captured_at, is_stale, stock_available, settlement_price, settlement_verified_at, settlement_payment_method, settlement_quantity',
  catalog_product_facts: 'product_id, tags, tag_text, facet_tags',
  catalog_cache_versions: 'id, version',
};

function percentile(samples: readonly number[], quantile: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return Math.round(sorted[Math.ceil(sorted.length * quantile) - 1]! * 100) / 100;
}

async function main(): Promise<void> {
  const schema = 'catalog_cold_' + randomUUID().replaceAll('-', '');
  const source = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: createPostgresPool() }) });
  let sqlReads = 0;
  let sqlMs = 0;
  const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({
    pool: createPostgresPool({ ...process.env, PG_SCHEMA: schema }),
  }), log: event => {
    if (event.level === 'query') { sqlReads += 1; sqlMs += event.queryDurationMillis; }
  } });
  const cache = createCache(catalogCacheOptions({}));
  let created = false;
  let app: INestApplication | undefined;
  try {
    const sourceSchema = (await sql<{ name: string }>`select current_schema() as name`.execute(source)).rows[0]!.name;
    assert.notEqual(sourceSchema, schema);
    // Clone only the columns needed by this migration; business tables stay read-only.
    console.info(JSON.stringify({ phase: 'snapshot' }));
    await source.transaction().setIsolationLevel('repeatable read').execute(async transaction => {
      await sql`create schema ${sql.id(schema)}`.execute(transaction);
      for (const [table, columns] of Object.entries(SNAPSHOT_COLUMNS)) {
        await sql`create table ${sql.id(schema, table)} as
          select ${sql.raw(columns)} from ${sql.id(sourceSchema, table)}`.execute(transaction);
        const key = ['catalog_product_facts', 'standard_product_members'].includes(table) ? 'product_id' : 'id';
        await sql`alter table ${sql.id(schema, table)} add primary key (${sql.id(key)})`.execute(transaction);
      }
      await sql`create index on ${sql.id(schema, 'offers')} (product_id, captured_at desc, id desc)`.execute(transaction);
    });
    created = true;
    for (const table of Object.keys(SNAPSHOT_COLUMNS)) await sql`analyze ${sql.id(table)}`.execute(database);
    console.info(JSON.stringify({ phase: 'projection-migration' }));
    await up(database);
    await upFacetCounts(database);
    await rebuildProjection(database);
    const module = await Test.createTestingModule({
      controllers: [CatalogController],
      providers: [CatalogRepository, CatalogService,
        { provide: DATABASE, useValue: database }, { provide: CACHE_MANAGER, useValue: cache }],
    }).compile();
    const server = module.createNestApplication(new FastifyAdapter(), { logger: false });
    app = server;
    server.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await server.init();
    const http = server.getHttpAdapter().getInstance();
    await http.ready();
    const base = { view: 'summary', limit: '20' };
    const cases: { name: string; path?: string; params: Record<string, string> }[] = [
      { name: 'browse', params: base },
      { name: 'platform', params: { ...base, platform: 'openai' } },
      ...['Plus', 'Claude', 'ChatGPT Plus', '手机接码', 'no-such-catalog-quote'].map(q => ({ name: 'search:' + q, params: { ...base, q } })),
      { name: 'purchase-filter', params: { ...base, tag: JSON.stringify({ name: 'access', value: 'dedicated' }) } },
      { name: 'warranty-minimum', params: { ...base, warrantyDaysMin: '30' } },
      { name: 'price-order', params: { ...base, sort: 'price' } },
      { name: 'updated-order', params: { ...base, sort: 'updated' } },
      { name: 'facets', path: '/v1/catalog/facets', params: {} },
      { name: 'search-facets', path: '/v1/catalog/facets', params: { q: 'Plus' } },
      { name: 'product-metadata', path: '/v1/catalog/products', params: {} },
      { name: 'coverage', path: '/v1/catalog/coverage', params: {} },
    ];
    const initial = await http.inject({ method: 'GET', url: '/v1/catalog?' + new URLSearchParams(base) });
    assert.equal(initial.statusCode, 200);
    const first = initial.json();
    assert.ok(first.items.length, 'a real populated catalog is required');
    if (first.nextCursor) cases.push({ name: 'next-page', params: { ...base, cursor: first.nextCursor } });
    for (const detailKind of ['offers', 'shops']) {
      cases.push({ name: detailKind + '-detail', params: {
        standardProductId: first.items[0].id, detailKind, detailPage: '0', detailPageSize: '12',
      } });
    }
    const counts = await sql<{ offers: number; standards: number }>`select
      (select count(*)::int from catalog_read_offers) as offers,
      (select count(distinct standard_product_id)::int from catalog_read_offers) as standards`.execute(database);
    console.info(JSON.stringify({ samples: SAMPLES, budgetMs: BUDGET_MS, cache: 'forced memory miss before each HTTP request',
      sourceSchema, snapshot: counts.rows[0], scope: 'in-process Fastify HTTP response including live projection SQL and JSON serialization' }));
    let worst = 0;
    for (const scenario of cases) {
      const samples: number[] = [];
      const reads: number[] = [];
      const queryTimes: number[] = [];
      const url = (scenario.path ?? '/v1/catalog') + '?' + new URLSearchParams(scenario.params);
      for (let index = 0; index < SAMPLES; index += 1) {
        await cache.clear();
        sqlReads = 0;
        sqlMs = 0;
        const start = performance.now();
        const response = await http.inject({ method: 'GET', url });
        samples.push(performance.now() - start);
        reads.push(sqlReads);
        queryTimes.push(sqlMs);
        assert.equal(response.statusCode, 200, response.body.slice(0, 300));
        assert.ok(sqlReads >= 1, 'every cold request must execute database SQL');
        assert.ok(response.json());
      }
      const p95Ms = percentile(samples, 0.95);
      worst = Math.max(worst, p95Ms);
      console.info(JSON.stringify({ scenario: scenario.name, p50Ms: percentile(samples, 0.5), p95Ms,
        maxMs: percentile(samples, 1), p95PgMs: percentile(queryTimes, 0.95),
        sqlReadCounts: Object.fromEntries([...new Set(reads)].map(count => [count, reads.filter(value => value === count).length])),
        pass: p95Ms <= BUDGET_MS }));
      if (p95Ms > BUDGET_MS && (!scenario.path || scenario.path.endsWith('/facets'))) {
        const query = normalizeCatalogQuery({ ...scenario.params, limit: Number(scenario.params.limit ?? 20),
          warrantyDaysMin: scenario.params.warrantyDaysMin ? Number(scenario.params.warrantyDaysMin) : undefined });
        const repository = module.get(CatalogRepository);
        const plan = (scenario.path ? await repository.explainFacets(query) : await repository.explain(query)) as Record<string, unknown>[];
        console.info(JSON.stringify({ scenario: scenario.name, serverMs: plan[0]!['Execution Time'],
          planningMs: plan[0]!['Planning Time'], jit: plan[0]!.JIT }));
      }
    }
    assert.ok(worst <= BUDGET_MS, `cold HTTP P95 ${worst}ms exceeds ${BUDGET_MS}ms`);
  } finally {
    await app?.close();
    await cache.disconnect();
    await database.destroy();
    if (created) {
      assert.match(schema, /^catalog_cold_[a-f0-9]{32}$/u);
      await sql`drop schema ${sql.id(schema)} cascade`.execute(source);
    }
    await source.destroy();
  }
}

void main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });

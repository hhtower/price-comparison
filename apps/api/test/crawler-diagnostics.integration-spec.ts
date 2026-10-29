import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { migrateToLatest } from '../scripts/migrate.js';
import { DiagnosticsRepository } from '../src/crawler/diagnostics.repository.js';
import type { DatabaseSchema } from '../src/database/types.js';

describe('crawler diagnostics over PostgreSQL', () => {
  let admin: Pool;
  let database: Kysely<DatabaseSchema>;
  let schema: string;

  before(async () => {
    if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
    schema = `crawler_diagnostics_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    process.env.PG_SCHEMA = schema;
    admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`create schema "${schema}"`);
    database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({
      pool: new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path="${schema}",public`, max: 4 }),
    }) });
    await migrateToLatest(database);
  });

  after(async () => {
    await database?.destroy();
    if (admin && schema) {
      await admin.query(`drop schema if exists "${schema}" cascade`);
      await admin.end();
    }
    delete process.env.PG_SCHEMA;
  });

  test('empty history reports unknown metrics and no sampled budget', async () => {
    await database.insertInto('shops').values({ platform: 'unknown', url: 'https://unknown.example', name: 'Unknown', last_error: null }).execute();
    const diagnostics = await new DiagnosticsRepository(database).snapshot();
    assert.equal(diagnostics.windowRuns, 0);
    assert.deepEqual(diagnostics.instances, { queued: 0, running: 0, failedRecent: 0 });
    assert.deepEqual(diagnostics.coverage, { eligible: 0, verified: 0 });
    assert.deepEqual(diagnostics.budgets, [{
      host: 'unknown.example', shops: 1, sampledShops: 0, requests: 0, retries: 0,
      list: 0, channel: 0, settlement: 0, estimatedMs: null, recommendedIntervalMs: null,
    }]);
  });

  test('separates runnable queue and deferred work, counts only recent list outcomes', async () => {
    const shop = await database.insertInto('shops').values({ platform: 'test', url: 'https://example.com', name: 'Test', last_error: null }).returning('id').executeTakeFirstOrThrow();
    const now = new Date();
    const old = new Date(now.getTime() - 90 * 60_000);
    const fresh = new Date(now.getTime() - 10 * 60_000);
    const later = new Date(now.getTime() + 10 * 60_000);
    await database.insertInto('fetch_runs').values([
      { shop_id: shop.id, started_at: old, finished_at: old, status: 'failed', error: null, task_type: 'list' },
      { shop_id: shop.id, started_at: fresh, finished_at: fresh, status: 'succeeded', error: null, task_type: 'list', crawl_metrics: JSON.stringify({ version: 1, attempts: 1, listSucceeded: 1, listFailed: 0, leaseFailures: 1, requests: 3, retries: 1, durations: { list: 100, settlement: 80, transaction: 50, rate_wait: 20, proxy_wait: 10, network: 60, total: 300 }, hosts: { 'example.com': { requests: 3, retries: 1, list: 1, channel: 1, settlement: 1, connection: 0, rate_limited: 0, blocked: 0, timeout: 0, networkMs: 60 } } }) },
      { shop_id: shop.id, started_at: fresh, finished_at: fresh, status: 'failed', error: null, task_type: 'list' },
      { shop_id: shop.id, started_at: fresh, finished_at: fresh, status: 'failed', error: null, task_type: 'settlement' },
      { shop_id: shop.id, started_at: fresh, status: 'queued', error: null, task_type: 'list', available_at: fresh },
      { shop_id: shop.id, started_at: fresh, status: 'queued', error: null, task_type: 'settlement', available_at: later },
    ]).execute();

    const diagnostics = await new DiagnosticsRepository(database).snapshot();
    assert.equal(diagnostics.windowRuns, 2);
    assert.equal(diagnostics.listSucceeded, 1);
    assert.equal(diagnostics.listFailed, 1);
    assert.equal(diagnostics.instances.queued, 1);
    assert.equal(diagnostics.instances.failedRecent, 2);
    assert.equal(diagnostics.deferred, 1);
    assert.ok(diagnostics.oldestQueuedMs !== null && diagnostics.oldestQueuedMs >= 9 * 60_000);
    assert.deepEqual(diagnostics.settlementQueue, { queued: 0, running: 0, deferred: 1, failedRecent: 1 });
  });

  test('coverage uses the latest offer and original verification expiry for published in-stock products', async () => {
    const shop = await database.insertInto('shops').values({ platform: 'test', url: 'https://coverage.example', name: 'Coverage', last_error: null }).returning('id').executeTakeFirstOrThrow();
    const standard = await database.insertInto('standard_products').values({ name: 'Coverage', platform: 'test', standard_key: null, canonical_platform: null, canonical_vendor: null, canonical_family: null, canonical_product: null, canonical_tier: null, verification_run_id: null, verification_state: 'verified' }).returning('id').executeTakeFirstOrThrow();
    const now = Date.now();
    for (const [index, ageMs, stock, published] of [[1, 10_000, true, true], [2, 9_000_000, true, true], [3, 10_000, false, true], [4, 10_000, true, false]] as const) {
      const product = await database.insertInto('products').values({ shop_id: shop.id, external_id: String(index), name: `Product ${index}`, normalized_key: String(index), url: 'https://coverage.example/item', image_url: null }).returning('id').executeTakeFirstOrThrow();
      await database.insertInto('standard_product_members').values({ standard_product_id: standard.id, product_id: product.id, publication_state: published ? 'published' : 'provisional' }).execute();
      await database.insertInto('offers').values({ product_id: product.id, idempotency_key: `coverage-${index}`, price: '10', stock_available: stock, settlement_price: '9', settlement_verified_at: new Date(now - ageMs), settlement_payment_method: 'Alipay', captured_at: new Date(now - ageMs) }).execute();
    }
    const diagnostics = await new DiagnosticsRepository(database).snapshot();
    assert.deepEqual(diagnostics.coverage, { eligible: 2, verified: 1 });
  });

  test('host budget includes targeted retry requests and scales only matching shop hosts', async () => {
    const shops = await database.insertInto('shops').values([
      { platform: 'budget', url: 'https://budget.example/a', name: 'Budget A', last_error: null },
      { platform: 'budget', url: 'https://budget.example/b', name: 'Budget B', last_error: null },
    ]).returning('id').execute();
    const list = await database.insertInto('fetch_runs').values({
      shop_id: shops[0]!.id, started_at: new Date(), finished_at: new Date(), status: 'succeeded', error: null, task_type: 'list',
      crawl_metrics: JSON.stringify({ version: 1, attempts: 1, listSucceeded: 1, listFailed: 0, leaseFailures: 0, requests: 4, retries: 1, durations: {}, hosts: { 'budget.example': { requests: 4, retries: 1, list: 2, channel: 1, settlement: 1, networkMs: 100 } } }),
    }).returning('id').executeTakeFirstOrThrow();
    await database.insertInto('fetch_runs').values({
      shop_id: shops[0]!.id, started_at: new Date(), finished_at: new Date(), status: 'failed', error: null, task_type: 'settlement', source_fetch_run_id: list.id,
      crawl_metrics: JSON.stringify({ version: 1, attempts: 1, listSucceeded: 0, listFailed: 0, leaseFailures: 0, requests: 2, retries: 1, durations: {}, hosts: { 'budget.example': { requests: 2, retries: 1, list: 0, channel: 1, settlement: 1, networkMs: 50 } } }),
    }).execute();
    const diagnostics = await new DiagnosticsRepository(database).snapshot();
    assert.deepEqual(diagnostics.budgets.find(budget => budget.host === 'budget.example'), {
      host: 'budget.example', shops: 2, sampledShops: 1, requests: 6, retries: 2,
      list: 2, channel: 2, settlement: 2, estimatedMs: 15000, recommendedIntervalMs: 15000,
    });
    assert.equal(diagnostics.budgets.find(budget => budget.host === 'example.com')?.shops, 1);
  });

  test('samples the latest successful run per shop without rescanning history for every shop', async () => {
    await sql`
      insert into shops (platform, url, name)
      select 'scale', 'https://scale.example/' || n, 'Scale ' || n
      from generate_series(1, 1200) n`.execute(database);
    await sql`
      insert into fetch_runs (shop_id, status, task_type, started_at, finished_at, crawl_metrics)
      select sh.id, 'succeeded', 'list', now() - interval '2 hours',
        now() - interval '2 hours' + n * interval '1 second',
        jsonb_build_object('version', 1, 'hosts', jsonb_build_object('scale.example',
          jsonb_build_object('requests', n, 'list', n, 'networkMs', n)))
      from shops sh cross join generate_series(1, 50) n
      where sh.platform = 'scale'`.execute(database);
    await sql`analyze shops`.execute(database);
    await sql`analyze fetch_runs`.execute(database);
    await database.connection().execute(async connection => {
      await sql`set statement_timeout = '2s'`.execute(connection);
      try {
        const diagnostics = await new DiagnosticsRepository(connection).snapshot();
        const budget = diagnostics.budgets.find(item => item.host === 'scale.example');
        assert.equal(budget?.sampledShops, 1200);
        assert.equal(budget?.requests, 60000);
      } finally {
        await sql`reset statement_timeout`.execute(connection);
      }
    });
  });
});

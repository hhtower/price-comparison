import 'reflect-metadata';
import '../src/config/env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { migrationProvider } from '../scripts/migrate.js';
import { AnalyticsRepository } from '../src/analytics/analytics.repository.js';
import { AnalyticsNetworkService, analyticsCacheOptions } from '../src/analytics/analytics-network.js';
import { analyticsPeriod } from '../src/analytics/analytics-input.js';
import type { AnalyticsCollection } from '../src/analytics/analytics-contract.js';
import { createCache } from 'cache-manager';

const connectionString = process.env.TEST_DATABASE_URL;
test('visitor analytics migration, atomic writes, deduplication and reports over isolated PostgreSQL', { skip: !connectionString }, async t => {
  const schema = 'analytics_test_' + randomBytes(6).toString('hex');
  const admin = new Pool({ connectionString, connectionTimeoutMillis: 5000 });
  let database: Kysely<unknown> | undefined;
  try {
    await admin.query('create schema ' + schema);
    const pool = new Pool({ connectionString, options: '-c search_path=' + schema, connectionTimeoutMillis: 5000, max: 4 });
    database = new Kysely({ dialect: new PostgresDialect({ pool }) });
    const { error } = await new Migrator({ db: database, provider: migrationProvider, migrationTableSchema: schema }).migrateToLatest();
    if (error) throw error;
    await pool.query('truncate analytics_visits cascade');
    const repository = new AnalyticsRepository(pool);
    assert.deepEqual((await repository.excludedIps()).sort(), ['127.0.0.1', '::1'].sort());
    await repository.addExcludedIp('192.0.2.6');
    const query = { days: 7, page: 1, limit: 20 };
    const payload: AnalyticsCollection = { visitId: randomUUID(), visitorId: randomUUID(), sessionId: randomUUID(), page: 'catalog', device: 'desktop', browser: 'chrome', source: 'direct', activeMs: 0, actions: [] };

    await t.test('reports exclude own IPs from historical visits and actions without deleting raw records', async t => {
      t.after(async () => { await pool.query('truncate analytics_visits cascade'); });
      const includedIds: string[] = [];
      const excludedIps = ['127.0.0.1', '192.0.2.6', '::1', '::ffff:127.0.0.1', '::ffff:192.0.2.6'];
      const includedIps = ['8.8.8.8', '192.0.2.60', '2001:4860:4860::8888', null];
      const reference = { appId: '6448311069', planId: '["6744120541","subscription","P1M"]' };
      for (const ip of [...excludedIps, ...includedIps]) {
        const visitId = randomUUID();
        if (includedIps.includes(ip)) includedIds.push(visitId);
        await repository.collect({ ...payload, visitId, visitorId: randomUUID(), sessionId: randomUUID(), actions: [
          { id: randomUUID(), name: 'search' },
          { id: randomUUID(), name: 'reference_open' },
          { id: randomUUID(), name: 'reference_product', reference: { appId: reference.appId } },
          { id: randomUUID(), name: 'reference_plan_select', reference },
        ] }, { ip, countryCode: null, country: null, region: null, city: null, isp: null, geoStatus: 'unknown' });
      }
      await pool.query('update analytics_visits set active_ms = case when id = any($1::uuid[]) then 1000 else 8000 end', [includedIds]);
      const report = await repository.summary(query);
      assert.deepEqual(report.overview, { pageViews: 4, visitors: 4, sessions: 4, avgActiveMs: 1000, actions: 16 });
      assert.equal(report.trend.reduce((sum: number, row: any) => sum + row.pageViews, 0), 4);
      assert.equal(report.trend.reduce((sum: number, row: any) => sum + row.visitors, 0), 4);
      for (const dimension of ['pages', 'devices', 'browsers', 'sources', 'countries', 'regions', 'cities', 'isps']) {
        assert.equal(report[dimension].reduce((sum: number, row: any) => sum + row.count, 0), 4, dimension);
      }
      assert.equal(report.visitorRanking.length, 4);
      assert.ok(report.visitorRanking.every((row: any) => row.actions === 4 && row.pageViews === 1));
      assert.equal(report.actions.length, 4);
      assert.ok(report.actions.every((row: any) => row.count === 4 && row.visitors === 4));
      assert.deepEqual(report.reference, {
        opens: 4, visitors: 4,
        products: [{ key: reference.appId, count: 4, visitors: 4 }],
        plans: [{ ...reference, count: 4, visitors: 4 }],
      });
      const first = await repository.visits({ ...query, limit: 3 });
      const second = await repository.visits({ ...query, limit: 3, page: 2 });
      assert.equal(first.total, 4);
      assert.equal(second.total, 4);
      assert.equal(first.items.length, 3);
      assert.equal(second.items.length, 1);
      assert.deepEqual([...first.items, ...second.items].map(row => row.id).sort(), includedIds.sort());
      assert.equal((await pool.query('select count(*)::integer as count from analytics_visits')).rows[0].count, 9);
      assert.equal((await pool.query('select count(*)::integer as count from analytics_actions')).rows[0].count, 36);

      await pool.query("update analytics_visits set started_at = now() - interval '2 days'");
      const today = await repository.summary({ ...query, days: 1 });
      assert.equal(today.overview.pageViews, 0);
      assert.equal(today.overview.actions, 16, 'filter actions by original IP without changing their occurrence-date scope');
      assert.equal(today.reference.visitors, 4);
      assert.equal(today.visitorRanking.length, 4);
    });

    await t.test('editable exclusions persist, apply to existing records and restore statistics when removed', async t => {
      t.after(async () => {
        await pool.query('truncate analytics_visits cascade');
        await pool.query('truncate analytics_excluded_ips');
        await pool.query("insert into analytics_excluded_ips (ip) values ('127.0.0.1'), ('192.0.2.6'), ('::1')");
      });
      assert.deepEqual((await repository.excludedIps()).sort(), ['127.0.0.1', '192.0.2.6', '::1'].sort());
      for (const ip of ['8.8.8.8', '::ffff:8.8.8.8', '2001:db8::1', '192.0.2.6', '::ffff:192.0.2.6', null]) {
        await repository.collect({ ...payload, visitId: randomUUID(), actions: [{ id: randomUUID(), name: 'search' }] },
          { ip, countryCode: null, country: null, region: null, city: null, isp: null, geoStatus: 'unknown' });
      }
      assert.equal((await repository.summary(query)).overview.pageViews, 4);
      await Promise.all([repository.addExcludedIp('8.8.8.8'), repository.addExcludedIp('8.8.8.8')]);
      await repository.addExcludedIp('2001:db8::1');
      const reloaded = new AnalyticsRepository(pool);
      assert.equal((await reloaded.excludedIps()).length, 5, 'duplicates are idempotent and another instance reads the same rules');
      const filtered = await reloaded.summary(query);
      assert.equal(filtered.overview.pageViews, 1);
      assert.equal(filtered.overview.visitors, 1, 'other visits from the same visitor stay included');
      assert.equal(filtered.overview.actions, 1);
      assert.equal((await reloaded.visits(query)).total, 1);
      assert.equal((await reloaded.visits(query)).items[0].ip, null);
      await reloaded.removeExcludedIp('8.8.8.8');
      await reloaded.removeExcludedIp('8.8.8.8');
      await reloaded.removeExcludedIp('2001:db8::1');
      await reloaded.removeExcludedIp('192.0.2.6');
      const restored = await repository.summary(query);
      assert.equal(restored.overview.pageViews, 6);
      assert.equal(restored.overview.actions, 6);
      assert.equal((await repository.visits(query)).total, 6);
      assert.equal((await pool.query('select count(*)::integer as count from analytics_visits')).rows[0].count, 6);
      await assert.rejects(pool.query("insert into analytics_excluded_ips (ip) values ('8.8.8.0/24')"), /check constraint/);
    });

    await t.test('Redis cache supplements missing geography without a database cache table or historical rewrites', async t => {
      t.after(async () => { await pool.query('truncate analytics_visits cascade'); });
      const cache = createCache(analyticsCacheOptions({}));
      t.after(() => cache.disconnect());
      let calls = 0;
      const network = new AnalyticsNetworkService({ environment: {}, cache, fetchImpl: async () => {
        calls++;
        return Response.json({ success: true, ip: '8.8.8.8', country_code: 'US', country: 'United States', region: 'California', city: 'Mountain View', connection: { isp: 'Google LLC' } });
      } });
      const reportRepository = new AnalyticsRepository(pool, network);
      const failedId = randomUUID();
      await repository.collect({ ...payload, visitId: failedId }, { ip: '8.8.8.8', countryCode: null, country: null, region: null, city: null, isp: null, geoStatus: 'unavailable' });
      await repository.collect(payload);
      const known = await network.lookup('8.8.8.8');
      await repository.collect({ ...payload, visitId: randomUUID() }, { ...known, city: 'Original city' });
      const list = await reportRepository.visits(query);
      const enriched = list.items.find((row: any) => row.id === failedId);
      assert.equal(enriched.city, 'Mountain View'); assert.equal(enriched.isp, 'Google LLC'); assert.equal(enriched.geoFromCache, true);
      assert.equal(list.items.find((row: any) => row.id === payload.visitId).ip, null, 'never infer a historical IP');
      assert.ok(list.items.some((row: any) => row.city === 'Original city' && !row.geoFromCache));
      assert.deepEqual((await reportRepository.summary(query)).countries, [{ key: 'United States', count: 2 }, { key: '未知', count: 1 }]);
      assert.equal((await pool.query('select geo_status from analytics_visits where id=$1', [failedId])).rows[0].geo_status, 'unavailable');
      assert.equal((await pool.query('select count(*)::integer as count from information_schema.tables where table_schema=$1 and table_name=$2', [schema, 'analytics_ip_cache'])).rows[0].count, 0);
      await cache.del('ip:8.8.8.8');
      assert.equal((await reportRepository.visits(query)).items.find((row: any) => row.id === failedId).geoStatus, 'unavailable');
      assert.deepEqual((await reportRepository.summary(query)).countries, [{ key: '未知', count: 2 }, { key: 'United States', count: 1 }]);
      assert.equal(calls, 1, 'admin queries only read the cache');
    });

    await t.test('empty statistics return zeroes and seven Shanghai calendar days', async () => {
      const report = await repository.summary(query);
      assert.deepEqual(report.overview, { pageViews: 0, visitors: 0, sessions: 0, avgActiveMs: 0, actions: 0 });
      assert.equal(report.trend.length, 7); assert.ok(report.trend.every((row: any) => row.pageViews === 0));
      assert.deepEqual((await repository.visits(query)).items, []);
      assert.deepEqual(report.reference, { opens: 0, visitors: 0, products: [], plans: [] });
      assert.deepEqual(report.visitorRanking, []);
    });
    await t.test('concurrent duplicate deliveries are idempotent and duration never decreases', async () => {
      await repository.collect(payload);
      await pool.query("update analytics_visits set started_at = now() - interval '2 minutes'");
      const action = { id: randomUUID(), name: 'search' as const };
      await Promise.all([repository.collect({ ...payload, activeMs: 15000, actions: [action] }), repository.collect({ ...payload, activeMs: 5000, actions: [action] })]);
      await repository.collect({ ...payload, visitorId: randomUUID(), activeMs: 80000, actions: [{ id: randomUUID(), name: 'search' }] });
      const report = await repository.summary(query);
      assert.deepEqual(report.overview, { pageViews: 1, visitors: 1, sessions: 1, avgActiveMs: 15000, actions: 1 });
      await repository.collect({ ...payload, activeMs: 86400000 });
      const row = (await repository.visits(query)).items[0];
      assert.ok(row.activeMs >= 120000 && row.activeMs < 125000, 'client cannot claim more time than the visit has existed');
    });
    await t.test('failed action persistence rolls back its page view', async () => {
      const visitId = randomUUID();
      await assert.rejects(repository.collect({ ...payload, visitId, actions: [{ id: randomUUID(), name: 'invalid' as any }] }));
      assert.equal(Number((await pool.query('select count(*) from analytics_visits where id=$1', [visitId])).rows[0].count), 0);
    });
    await t.test('reference events retain SKU identity and count unique users across host pages by event date', async () => {
      await pool.query('truncate analytics_visits cascade');
      const app = { appId: '6448311069' };
      const monthly = { ...app, planId: '["6744120541","subscription","P1M"]' };
      const yearly = { ...app, planId: '["6744120541","subscription","P1Y"]' };
      const actions: AnalyticsCollection['actions'] = [
        { id: randomUUID(), name: 'reference_open' },
        { id: randomUUID(), name: 'reference_product', reference: app },
        { id: randomUUID(), name: 'reference_plans_open', reference: app },
        { id: randomUUID(), name: 'reference_plan_select', reference: monthly },
      ];
      await Promise.all([repository.collect({ ...payload, actions }), repository.collect({ ...payload, actions })]);
      await repository.collect({ ...payload, visitId: randomUUID(), page: 'tools_ai', actions: [
        { id: randomUUID(), name: 'reference_open' },
        { id: randomUUID(), name: 'reference_plan_select', reference: yearly },
      ] });
      await repository.collect({ ...payload, visitId: randomUUID(), visitorId: randomUUID(), page: 'tools_ip', actions: [
        { id: randomUUID(), name: 'reference_open' },
        { id: randomUUID(), name: 'reference_plan_select', reference: monthly },
        { id: randomUUID(), name: 'reference_plan_select', reference: yearly },
      ] });
      await pool.query("update analytics_visits set started_at = now() - interval '2 days'");
      const report = await repository.summary({ ...query, days: 1 });
      assert.equal(report.overview.pageViews, 0);
      assert.equal(report.reference.opens, 3);
      assert.equal(report.reference.visitors, 2);
      assert.deepEqual(report.reference.products, [{ key: app.appId, count: 1, visitors: 1 }]);
      assert.equal(report.reference.plans.length, 2);
      for (const plan of [monthly, yearly]) assert.deepEqual(report.reference.plans.find((row: any) => row.planId === plan.planId), { ...plan, count: 2, visitors: 2 });
      assert.deepEqual(report.actions.find((row: any) => row.key === 'reference_open'), { key: 'reference_open', count: 3, visitors: 2 });
      await pool.query("update analytics_actions set created_at = now() - interval '2 days' where name = 'reference_plan_select'");
      assert.deepEqual((await repository.summary({ ...query, days: 1 })).reference.plans, []);
      const stored = (await pool.query('select reference_app_id, reference_plan_id from analytics_actions where id=$1', [actions[3].id])).rows[0];
      assert.deepEqual(stored, { reference_app_id: app.appId, reference_plan_id: monthly.planId });
    });
    await t.test('range-level UV is distinct, daily buckets are zero-filled and records paginate consistently', async () => {
      await pool.query('truncate analytics_visits cascade');
      const period = analyticsPeriod(7); const firstDay = new Date(new Date(period.start).getTime() + 3600000);
      const lastDay = new Date(new Date(period.end).getTime() - 3600000);
      const second = { ...payload, visitId: randomUUID(), page: 'tools_ai' as const, device: 'mobile' as const };
      const third = { ...payload, visitId: randomUUID(), visitorId: randomUUID(), sessionId: randomUUID() };
      const outside = { ...payload, visitId: randomUUID() };
      for (const row of [payload, second, third, outside]) await repository.collect(row);
      await pool.query('update analytics_visits set started_at=$2, active_ms=1000 where id=$1', [payload.visitId, firstDay]);
      await pool.query('update analytics_visits set started_at=$2, active_ms=3000 where id=$1', [second.visitId, lastDay]);
      await pool.query('update analytics_visits set started_at=$2, active_ms=2000 where id=$1', [third.visitId, lastDay]);
      await pool.query('update analytics_visits set started_at=$2 where id=$1', [outside.visitId, period.end]);
      const report = await repository.summary(query);
      assert.deepEqual(report.overview, { pageViews: 3, visitors: 2, sessions: 2, avgActiveMs: 2000, actions: 0 });
      assert.equal(report.trend[0].pageViews, 1); assert.equal(report.trend[6].pageViews, 2);
      assert.equal(report.trend[0].visitors + report.trend[6].visitors, 3);
      assert.ok(report.trend.slice(1, 6).every((row: any) => row.pageViews === 0));
      assert.deepEqual(report.devices, [{ key: 'desktop', count: 2 }, { key: 'mobile', count: 1 }]);
      assert.equal(report.pages.find((row: any) => row.key === 'catalog').count, 2);
      const page1 = await repository.visits({ ...query, limit: 2 });
      const page2 = await repository.visits({ ...query, limit: 2, page: 2 });
      assert.equal(page1.total, 3); assert.equal(page2.items.length, 1); assert.equal(page2.items[0].id, payload.visitId);
      assert.equal(new Set([...page1.items, ...page2.items].map(row => row.id)).size, 3);
      assert.deepEqual((await repository.visits({ ...query, page: 100 })).items, []);
    });
    await t.test('actions use their own occurrence date when the page was opened before the selected range', async () => {
      await pool.query('truncate analytics_visits cascade');
      const event = { id: randomUUID(), name: 'search' as const };
      await repository.collect({ ...payload, actions: [event] });
      await pool.query("update analytics_visits set started_at = now() - interval '2 days'");
      const report = await repository.summary({ ...query, days: 1 });
      assert.equal(report.overview.pageViews, 0);
      assert.equal(report.overview.actions, 1);
      assert.deepEqual(report.actions, [{ key: 'search', count: 1, visitors: 1 }]);
      assert.equal(report.visitorRanking[0].visitorId, payload.visitorId);
      assert.equal(report.visitorRanking[0].actions, 1);
      assert.equal(report.visitorRanking[0].pageViews, 0);
    });
    await t.test('visitor ranking deduplicates across sessions, separates visitors sharing an IP and limits results', async () => {
      await pool.query('truncate analytics_visits cascade');
      const network = { ip: '8.8.8.8', countryCode: null, country: null, region: null, city: null, isp: null, geoStatus: 'unavailable' as const };
      const repeated = { id: randomUUID(), name: 'search' as const };
      await repository.collect({ ...payload, actions: [repeated] }, network);
      await repository.collect({ ...payload, actions: [repeated] }, network);
      await repository.collect({ ...payload, visitId: randomUUID(), sessionId: randomUUID(), actions: [{ id: randomUUID(), name: 'search' }] }, network);
      const frequent = randomUUID();
      await repository.collect({ ...payload, visitId: randomUUID(), visitorId: frequent, actions: Array.from({ length: 3 }, () => ({ id: randomUUID(), name: 'search' as const })) }, network);
      for (let i = 0; i < 22; i++) await repository.collect({ ...payload, visitId: randomUUID(), visitorId: randomUUID() }, network);
      const report = await repository.summary(query);
      assert.equal(report.visitorRanking.length, 20);
      assert.equal(report.visitorRanking[0].visitorId, frequent);
      assert.equal(report.visitorRanking[0].actions, 3);
      assert.equal(report.visitorRanking[0].pageViews, 1);
      assert.equal(report.visitorRanking[1].visitorId, payload.visitorId);
      assert.equal(report.visitorRanking[1].actions, 2);
      assert.equal(report.visitorRanking[1].pageViews, 2);
      assert.deepEqual(report.actions, [{ key: 'search', count: 5, visitors: 2 }]);
      assert.ok(report.visitorRanking.every((row: any) => typeof row.activeMs === 'number' && Number.isFinite(Date.parse(row.lastSeenAt))));
    });
    await t.test('network snapshots stay attached to the original visit and reports include geography and unknowns', async () => {
      await pool.query('truncate analytics_visits cascade');
      const network = { ip: '8.8.8.8', countryCode: 'CN', country: '中国', region: '广东省', city: '深圳市', isp: '中国电信', geoStatus: 'resolved' as const };
      await repository.collect(payload, network);
      await repository.collect({ ...payload, activeMs: 500 }, { ...network, ip: '1.1.1.1', city: '广州市' });
      await repository.collect({ ...payload, visitId: randomUUID() }, { ...network, ip: '2001:4860:4860::8888' });
      await repository.collect({ ...payload, visitId: randomUUID() });
      const list = await repository.visits(query);
      const first = list.items.find((row: any) => row.id === payload.visitId);
      assert.equal(first.ip, '8.8.8.8'); assert.equal(first.countryCode, 'CN'); assert.equal(first.city, '深圳市'); assert.equal(first.isp, '中国电信'); assert.equal(first.geoStatus, 'resolved');
      assert.ok(list.items.some((row: any) => row.ip === '2001:4860:4860::8888'));
      const report = await repository.summary(query);
      assert.deepEqual(report.countries, [{ key: '中国', count: 2 }, { key: '未知', count: 1 }]);
      assert.deepEqual(report.regions, [{ key: '中国 / 广东省', count: 2 }, { key: '未知', count: 1 }]);
      assert.deepEqual(report.cities, [{ key: '中国 / 广东省 / 深圳市', count: 2 }, { key: '未知', count: 1 }]);
      assert.deepEqual(report.isps, [{ key: '中国电信', count: 2 }, { key: '未知', count: 1 }]);
    });
    await t.test('high cardinality location charts retain totals using a final other bucket', async () => {
      await pool.query('truncate analytics_visits cascade');
      for (let i = 0; i < 12; i++) await repository.collect({ ...payload, visitId: randomUUID() }, { ip: '8.8.8.8', countryCode: 'US', country: 'US', region: 'State ' + i, city: 'City ' + i, isp: 'ISP ' + i, geoStatus: 'resolved' });
      const report = await repository.summary(query);
      assert.equal(report.regions.length, 10);
      assert.equal(report.regions.reduce((sum: number, row: any) => sum + row.count, 0), 12);
      assert.equal(report.regions.find((row: any) => row.key === '其他').count, 3);
    });
  } finally {
    await database?.destroy();
    await admin.query('drop schema if exists ' + schema + ' cascade');
    await admin.end();
  }
});

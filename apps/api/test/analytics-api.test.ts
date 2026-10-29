import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Test } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AnalyticsController, AdminAnalyticsController } from '../src/analytics/analytics.controller.js';
import { AnalyticsRepository } from '../src/analytics/analytics.repository.js';
import { AuthService } from '../src/auth/auth.service.js';
import { AnalyticsNetworkService } from '../src/analytics/analytics-network.js';

test('collection rejects invalid payloads while analytics reads require an administrator', async t => {
  const previousTrust = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = 'false';
  t.after(() => { if (previousTrust === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = previousTrust; });
  const stored: any[] = [];
  const module = await Test.createTestingModule({ controllers: [AnalyticsController, AdminAnalyticsController], providers: [
    { provide: AnalyticsNetworkService, useValue: new AnalyticsNetworkService({ environment: { ANALYTICS_GEO_URL: '' } }) },
    { provide: AnalyticsRepository, useValue: { visitNetwork: async () => undefined, collect: async (input: unknown, network: unknown) => { stored.push({ input, network }); }, summary: async () => ({ overview: { pageViews: 1 } }), visits: async () => ({ items: [], total: 0 }) } },
    { provide: AuthService, useValue: { validate: async (token: string) => token === 'admin-token' ? { id: 1 } : null } },
  ] }).compile();
  const app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.enableVersioning({ type: VersioningType.URI }); await app.init(); await app.getHttpAdapter().getInstance().ready();
  t.after(() => app.close());
  const http = app.getHttpAdapter().getInstance();
  const payload = { visitId: '11111111-1111-4111-8111-111111111111', visitorId: '22222222-2222-4222-8222-222222222222', sessionId: '33333333-3333-4333-8333-333333333333', page: 'catalog', device: 'desktop', browser: 'chrome', source: 'direct', activeMs: 0, actions: [] };
  const collected = await http.inject({ method: 'POST', url: '/v1/analytics/collect', payload, headers: { 'x-forwarded-for': '8.8.8.8' } });
  assert.equal(collected.statusCode, 204); assert.equal(collected.body, ''); assert.equal(collected.headers['cache-control'], 'no-store');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].network?.ip, '127.0.0.1', 'the server records the transport address separately from browser data');
  const bad = await http.inject({ method: 'POST', url: '/v1/analytics/collect', payload: { ...payload, apiKey: 'secret-value' } });
  assert.equal(bad.statusCode, 400); assert.ok(!bad.body.includes('secret-value'));
  assert.equal(stored.length, 1);
  for (const endpoint of ['summary', 'visits']) {
    assert.equal((await http.inject({ method: 'GET', url: '/v1/admin/analytics/' + endpoint })).statusCode, 401);
    const accepted = await http.inject({ method: 'GET', url: '/v1/admin/analytics/' + endpoint, headers: { cookie: 'admin_session=admin-token' } });
    assert.equal(accepted.statusCode, 200); assert.equal(accepted.headers['cache-control'], 'no-store');
    assert.equal((await http.inject({ method: 'GET', url: '/v1/admin/analytics/' + endpoint + '?days=9999', headers: { cookie: 'admin_session=admin-token' } })).statusCode, 400);
  }
  for (const supplied of [{ ip: '1.1.1.1' }, { country: 'Forged Country' }, { geoStatus: 'resolved' }]) {
    const rejected = await http.inject({ method: 'POST', url: '/v1/analytics/collect', payload: { ...payload, ...supplied } });
    assert.equal(rejected.statusCode, 400); assert.equal(stored.length, 1);
  }
  process.env.TRUST_PROXY = 'true';
  const forwarded = await http.inject({ method: 'POST', url: '/v1/analytics/collect', payload, headers: { 'x-forwarded-for': '8.8.8.8, 10.0.0.1' } });
  assert.equal(forwarded.statusCode, 204); assert.equal(forwarded.body, '');
  assert.equal(stored[1].network.ip, '8.8.8.8'); assert.equal(stored[1].network.geoStatus, 'disabled');
  assert.equal((await http.inject({ method: 'POST', url: '/v1/analytics/collect', payload, headers: { 'x-forwarded-for': 'forged' } })).statusCode, 204);
  assert.equal(stored[2].network.ip, '127.0.0.1');
  for (const page of ['catalog', 'tools_ai', 'tools_ip']) {
    const actions = [
      { id: payload.visitId, name: 'reference_open' },
      { id: payload.visitId, name: 'reference_product', reference: { appId: '6448311069' } },
      { id: payload.visitId, name: 'reference_plans_open', reference: { appId: '6448311069' } },
      { id: payload.visitId, name: 'reference_plan_select', reference: { appId: '6448311069', planId: '["6744120541","subscription","P1M"]' } },
    ];
    for (const action of actions) {
      const response = await http.inject({ method: 'POST', url: '/v1/analytics/collect', payload: { ...payload, page, actions: [action] } });
      assert.equal(response.statusCode, 204);
      assert.deepEqual(stored.at(-1).input.actions, [action]);
    }
  }
  const beforeRejected = stored.length;
  const rejectedContext = await http.inject({ method: 'POST', url: '/v1/analytics/collect', payload: { ...payload, actions: [{ id: payload.visitId, name: 'reference_plan_select', reference: { appId: '6448311069', planId: 'https://private.example/token' } }] } });
  assert.equal(rejectedContext.statusCode, 400);
  assert.ok(!rejectedContext.body.includes('private.example'));
  assert.equal(stored.length, beforeRejected);
});

test('heartbeats skip resolved snapshots and retry only the originally observed IP for missing geography', async () => {
  const original = { ip: '8.8.8.8', countryCode: 'US', country: 'United States', region: null, city: null, isp: 'Google LLC', geoStatus: 'resolved' };
  let snapshot: any = original; const lookedUp: any[] = [];
  const controller = new AnalyticsController({ visitNetwork: async () => snapshot, collect: async () => {} } as any,
    { lookup: async (ip: string) => { lookedUp.push(ip); return original; } } as any);
  const input = { visitId: '11111111-1111-4111-8111-111111111111', visitorId: '22222222-2222-4222-8222-222222222222', sessionId: '33333333-3333-4333-8333-333333333333', page: 'catalog', device: 'desktop', browser: 'chrome', source: 'direct', activeMs: 0, actions: [] };
  const request = { ip: '1.1.1.1' } as any;
  await controller.collect(input, request);
  assert.deepEqual(lookedUp, [], 'completed snapshots do not need another lookup');
  snapshot = { ...original, geoStatus: 'unavailable' };
  await controller.collect(input, request);
  assert.deepEqual(lookedUp, ['8.8.8.8'], 'network changes must not replace the original visit IP');
  snapshot = { ...original, ip: null, geoStatus: 'unknown' };
  await controller.collect(input, request);
  assert.deepEqual(lookedUp, ['8.8.8.8'], 'historical missing IPs stay missing');
  snapshot = undefined;
  await controller.collect(input, request);
  assert.deepEqual(lookedUp, ['8.8.8.8', '1.1.1.1']);
});

test('only admins can manage normalized IP exclusions and current IP follows the trusted proxy contract', async t => {
  const previousTrust = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = 'false';
  t.after(() => { if (previousTrust === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = previousTrust; });
  const ips = new Set(['127.0.0.1']);
  const module = await Test.createTestingModule({ controllers: [AdminAnalyticsController], providers: [
    { provide: AnalyticsRepository, useValue: {
      excludedIps: async () => [...ips],
      addExcludedIp: async (ip: string) => { ips.add(ip); },
      removeExcludedIp: async (ip: string) => { ips.delete(ip); },
    } },
    { provide: AuthService, useValue: { validate: async (token: string) => token === 'admin-token' ? { id: 1 } : null } },
  ] }).compile();
  const app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.enableVersioning({ type: VersioningType.URI }); await app.init(); await app.getHttpAdapter().getInstance().ready();
  t.after(() => app.close());
  const http = app.getHttpAdapter().getInstance();
  const url = '/v1/admin/analytics/excluded-ips';
  const headers = { cookie: 'admin_session=admin-token', 'x-forwarded-for': '8.8.8.8' };
  for (const request of [
    { method: 'GET' as const, url },
    { method: 'POST' as const, url, payload: { ip: '8.8.8.8' } },
    { method: 'POST' as const, url: url + '/current' },
    { method: 'DELETE' as const, url: url + '/127.0.0.1' },
  ]) assert.equal((await http.inject(request)).statusCode, 401);

  let response = await http.inject({ method: 'GET', url, headers });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(response.json(), { ips: ['127.0.0.1'], currentIp: '127.0.0.1' });
  for (const ip of [' 8.8.8.8 ', '::ffff:8.8.8.8', '0:0:0:0:0:ffff:808:808', '2001:0DB8:0:0:0:0:0:1']) {
    response = await http.inject({ method: 'POST', url, headers, payload: { ip } });
    assert.equal(response.statusCode, 204);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.deepEqual((await http.inject({ method: 'GET', url, headers })).json().ips, ['127.0.0.1', '8.8.8.8', '2001:db8::1']);
  for (const payload of [null, [], {}, { ip: 123 }, { ip: '' }, { ip: 'x'.repeat(65) }, { ip: '8.8.8.8/24' },
    { ip: 'http://8.8.8.8' }, { ip: '8.8.8.8:80' }, { ip: 'fe80::1%eth0' }, { ip: 'invalid' }, { ip: '8.8.8.8', extra: true }]) {
    assert.equal((await http.inject({ method: 'POST', url, headers, payload })).statusCode, 400);
  }
  assert.equal((await http.inject({ method: 'DELETE', url: url + '/invalid', headers })).statusCode, 400);
  response = await http.inject({ method: 'DELETE', url: url + '/' + encodeURIComponent('::ffff:8.8.8.8'), headers });
  assert.equal(response.statusCode, 204);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.ok(!(await http.inject({ method: 'GET', url, headers })).json().ips.includes('8.8.8.8'));

  assert.equal((await http.inject({ method: 'POST', url: url + '/current', headers })).statusCode, 204);
  assert.ok(!ips.has('8.8.8.8'), 'untrusted forwarding cannot choose the current IP');
  process.env.TRUST_PROXY = 'true';
  assert.equal((await http.inject({ method: 'GET', url, headers })).json().currentIp, '8.8.8.8');
  assert.equal((await http.inject({ method: 'POST', url: url + '/current', headers })).statusCode, 204);
  assert.ok(ips.has('8.8.8.8'));
  assert.equal((await http.inject({ method: 'GET', url, headers: { ...headers, 'x-forwarded-for': 'invalid, 1.1.1.1' } })).json().currentIp, '127.0.0.1');
  const controller = new AdminAnalyticsController({ addExcludedIp: async () => assert.fail('missing IP must not be persisted') } as any);
  await assert.rejects(() => controller.excludeCurrentIp({ ip: 'invalid' } as any), /无法识别当前 IP/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createCache } from 'cache-manager';
import { AnalyticsNetworkService, analyticsCacheOptions, analyticsClientIp } from '../src/analytics/analytics-network.js';

const identity = { success: true, ip: '8.8.8.8', country_code: 'US', country: 'United States', region: 'California', city: 'Mountain View', connection: { isp: 'Google LLC' } };
const request = (ip: string, forwarded?: string) => ({ ip, headers: forwarded ? { 'x-forwarded-for': forwarded } : {} });
test('client IP uses transport by default, trusts only explicitly enabled forwarding, and normalizes IPv4/IPv6', () => {
  assert.equal(analyticsClientIp(request('127.0.0.1', '8.8.8.8'), false), '127.0.0.1');
  assert.equal(analyticsClientIp(request('127.0.0.1', '8.8.8.8, 10.0.0.2'), true), '8.8.8.8');
  assert.equal(analyticsClientIp(request('::ffff:8.8.8.8')), '8.8.8.8');
  assert.equal(analyticsClientIp(request('::ffff:808:808')), '8.8.8.8');
  assert.equal(analyticsClientIp(request('2001:4860:4860:0:0:0:0:8888')), '2001:4860:4860::8888');
  assert.equal(analyticsClientIp(request('127.0.0.1', 'malformed, 8.8.8.8'), true), '127.0.0.1');
  assert.equal(analyticsClientIp(request('not-an-ip')), null);
});
test('public lookup validates addresses, coalesces requests and expires success after 30 days without extending on reads', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  let calls = 0;
  const service = new AnalyticsNetworkService({ environment: {}, fetchImpl: async (url, init) => {
    calls++; assert.ok(String(url).includes('8.8.8.8')); assert.equal(init?.redirect, 'error');
    return Response.json(identity);
  } });
  const [a, b] = await Promise.all([service.lookup('8.8.8.8'), service.lookup('8.8.8.8')]);
  assert.deepEqual(a, { ip: '8.8.8.8', countryCode: 'US', country: 'United States', region: 'California', city: 'Mountain View', isp: 'Google LLC', geoStatus: 'resolved' });
  assert.deepEqual(a, b); assert.equal(calls, 1);
  t.mock.timers.tick(29 * 86400000); await service.lookup('8.8.8.8'); assert.equal(calls, 1);
  t.mock.timers.tick(2 * 86400000); await service.lookup('8.8.8.8'); assert.equal(calls, 2);
});
test('private, loopback, reserved and invalid addresses never leave the server', async () => {
  const service = new AnalyticsNetworkService({ environment: {}, fetchImpl: async () => { assert.fail('must not call provider'); } });
  for (const ip of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '::1', 'fc00::1', '169.254.1.1', '203.0.113.1']) {
    const result = await service.lookup(ip); assert.equal(result.ip, ip); assert.equal(result.geoStatus, 'local'); assert.equal(result.country, null);
  }
  const invalid = await service.lookup('not-an-ip'); assert.equal(invalid.ip, null); assert.equal(invalid.geoStatus, 'unknown');
});
test('timeouts, rejected providers, bad JSON, mismatched IPs and oversized bodies keep IP with unknown geography', async () => {
  const sources: Array<typeof fetch> = [
    async () => { throw new Error('private provider failure'); },
    async () => new Response('rate limited', { status: 429 }),
    async () => new Response('not JSON'),
    async () => Response.json({ ...identity, ip: '1.1.1.1' }),
    async () => Response.json({ ...identity, success: false }),
    async () => Response.json({ ...identity, country: '<script>fake</script>' }),
    async () => Response.json({ ...identity, region: 'x'.repeat(500) }),
    async () => new Response('x'.repeat(40000)),
    async (_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
    async (_url, init) => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); init!.signal!.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true }); } })),
  ];
  for (const fetchImpl of sources) {
    const service = new AnalyticsNetworkService({ environment: {}, fetchImpl, timeoutMs: 25 });
    const result = await service.lookup('8.8.8.8');
    assert.equal(result.ip, '8.8.8.8'); assert.equal(result.geoStatus, 'unavailable'); assert.equal(result.country, null);
  }
});
test('failed lookup is briefly cached; endpoint can be disabled or explicitly replaced', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  let calls = 0;
  const service = new AnalyticsNetworkService({ environment: { ANALYTICS_GEO_URL: 'https://geo.example/lookup/{ip}' }, fetchImpl: async url => { calls++; assert.equal(String(url), 'https://geo.example/lookup/8.8.8.8'); return new Response(null, { status: 503 }); } });
  await service.lookup('8.8.8.8'); await service.lookup('8.8.8.8'); assert.equal(calls, 1);
  t.mock.timers.tick(6 * 60000); await service.lookup('8.8.8.8'); assert.equal(calls, 2);
  const disabled = new AnalyticsNetworkService({ environment: { ANALYTICS_GEO_URL: '' }, fetchImpl: async () => assert.fail('disabled') });
  assert.equal((await disabled.lookup('8.8.8.8')).geoStatus, 'disabled');
});

test('reports deduplicate normalized addresses and only read unexpired successful cache entries', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  let calls = 0;
  const service = new AnalyticsNetworkService({ environment: {}, fetchImpl: async () => { calls++; return Response.json(identity); } });
  const known = await service.lookup('8.8.8.8');
  assert.deepEqual(await service.cached(['8.8.8.8', '::ffff:8.8.8.8', '1.1.1.1', 'invalid']), [known]);
  t.mock.timers.tick(31 * 86400000);
  assert.deepEqual(await service.cached(['8.8.8.8']), []);
  assert.equal(calls, 1, 'opening reports never invokes the provider');
});

test('a delayed failure in another instance cannot overwrite successful geography', async t => {
  const config = analyticsCacheOptions({});
  const firstCache = createCache(config); const secondCache = createCache(config);
  t.after(async () => { await firstCache.disconnect(); await secondCache.disconnect(); });
  const started = Promise.withResolvers<void>(); const response = Promise.withResolvers<Response>();
  const failed = new AnalyticsNetworkService({ environment: {}, cache: firstCache, fetchImpl: async () => { started.resolve(); return response.promise; } });
  const successful = new AnalyticsNetworkService({ environment: {}, cache: secondCache, fetchImpl: async () => Response.json(identity) });
  const pending = failed.lookup('8.8.8.8');
  await started.promise;
  const known = await successful.lookup('8.8.8.8');
  response.resolve(new Response(null, { status: 503 }));
  assert.deepEqual(await pending, known);
  assert.deepEqual(await failed.lookup('8.8.8.8'), known);
  assert.deepEqual(await failed.cached(['8.8.8.8']), [known]);
});

test('an unavailable Redis retains successful lookups in the bounded local fallback', async t => {
  const cache = createCache(analyticsCacheOptions({ REDIS_URL: 'redis://127.0.0.1:1' }));
  t.after(() => cache.disconnect());
  let calls = 0;
  const service = new AnalyticsNetworkService({ environment: {}, cache, fetchImpl: async () => { calls++; return Response.json(identity); } });
  const known = await service.lookup('8.8.8.8');
  assert.equal(known.geoStatus, 'resolved');
  assert.deepEqual(await service.lookup('8.8.8.8'), known);
  assert.equal(calls, 1);
});

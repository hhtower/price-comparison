import '../src/config/env.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createCache } from 'cache-manager';
import { analyticsCacheOptions, AnalyticsNetworkService } from '../src/analytics/analytics-network.js';

const url = process.env.TEST_REDIS_URL?.trim();

test('Redis shares successful lookups for 30 days and failures for 5 minutes across fresh API instances', { skip: !url }, async () => {
  const namespace = 'analytics-test-' + randomUUID();
  const config = () => {
    const options = analyticsCacheOptions({ REDIS_URL: url });
    for (const store of options.stores) store.namespace = namespace;
    return options;
  };
  const firstCache = createCache(config()); const secondCache = createCache(config());
  let calls = 0;
  const first = new AnalyticsNetworkService({ environment: {}, cache: firstCache, fetchImpl: async address => {
    calls++;
    return String(address).includes('8.8.8.8')
      ? Response.json({ success: true, ip: '8.8.8.8', country_code: 'US', country: 'United States', connection: { isp: 'Google LLC' } })
      : new Response(null, { status: 429 });
  } });
  const second = new AnalyticsNetworkService({ environment: {}, cache: secondCache, fetchImpl: async () => { assert.fail('must reuse Redis without a provider request'); } });
  const keys = ['ip:8.8.8.8', 'lookup:8.8.8.8', 'lookup:1.1.1.1'];
  try {
    const known = await first.lookup('8.8.8.8');
    assert.equal(known.geoStatus, 'resolved');
    const stored = await firstCache.stores[1]!.getRaw('ip:8.8.8.8');
    assert.deepEqual(stored?.value, known, 'success must exist in Redis, not just process memory');
    const remaining = stored!.expires! - Date.now();
    assert.ok(remaining > 29 * 86400000 && remaining <= 30 * 86400000);
    assert.deepEqual(await second.lookup('::ffff:808:808'), known);
    assert.deepEqual(await second.cached(['8.8.8.8', '::ffff:8.8.8.8']), [known]);
    assert.equal((await first.lookup('1.1.1.1')).geoStatus, 'unavailable');
    assert.equal((await second.lookup('1.1.1.1')).geoStatus, 'unavailable');
    const failed = await firstCache.stores[1]!.getRaw('lookup:1.1.1.1');
    const cooldown = failed!.expires! - Date.now();
    assert.ok(cooldown > 4 * 60000 && cooldown <= 5 * 60000);
    assert.equal(await firstCache.stores[1]!.get('ip:1.1.1.1'), undefined);
    assert.equal(calls, 2);
  } finally {
    await firstCache.mdel(keys);
    await firstCache.disconnect(); await secondCache.disconnect();
  }
});

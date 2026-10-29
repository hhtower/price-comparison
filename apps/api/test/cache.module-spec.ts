import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import test from 'node:test';
import { Test } from '@nestjs/testing';
import { CACHE, createCache, type Cache } from '../src/cache/cache.js';
import type KeyvRedis from '@keyv/redis';
import { CatalogCacheModule, catalogCacheOptions, CATALOG_CACHE_TTL_MS, CATALOG_MEMORY_CACHE_ENTRIES } from '../src/cache/cache.module.js';

test('Nest cache provider exposes CACHE and bounds the memory tier with LRU', async () => {
  const cache = createCache(catalogCacheOptions({}));
  try {
    assert.equal(cache.stores.length, 1);
    await cache.set('oldest', { value: 'old' });
    for (let i = 0; i < CATALOG_MEMORY_CACHE_ENTRIES; i += 1) await cache.set('entry-' + i, i);
    assert.equal(await cache.get('oldest'), undefined);
    assert.equal(await cache.get('entry-' + (CATALOG_MEMORY_CACHE_ENTRIES - 1)), CATALOG_MEMORY_CACHE_ENTRIES - 1);
    const remaining = (await cache.ttl('entry-0'))! - Date.now();
    assert.ok(remaining > 0 && remaining <= CATALOG_CACHE_TTL_MS, 'configured TTL is 30 seconds in milliseconds');
  } finally { await cache.disconnect(); }
});

test('framework memory entries expire without serving stale data', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const cache = createCache(catalogCacheOptions({}));
  try {
    await cache.set('expiry', { value: 1 });
    context.mock.timers.tick(CATALOG_CACHE_TTL_MS - 1);
    assert.deepEqual(await cache.get('expiry'), { value: 1 });
    context.mock.timers.tick(2);
    assert.equal(await cache.get('expiry'), undefined);
  } finally { await cache.disconnect(); }
});

test('oversized catalog responses stay successful without becoming memory or Redis hits', async () => {
  const url = process.env.TEST_REDIS_URL?.trim();
  const cache = createCache(catalogCacheOptions(url ? { REDIS_URL: url } : {}));
  const key = 'framework-oversized:' + randomUUID();
  const large = { text: 'x'.repeat(512 * 1024) };
  let reads = 0;
  const load = async () => { reads += 1; return large; };
  try {
    assert.deepEqual(await cache.wrap(key, load), large);
    assert.equal(await cache.get(key), undefined);
    assert.deepEqual(await cache.wrap(key, load), large);
    assert.equal(reads, 2, 'neither tier retains the oversized payload');
    await cache.set(key, { value: 'small' });
    assert.deepEqual(await cache.get(key), { value: 'small' });
  } finally { await cache.del(key); await cache.disconnect(); }
});

test('Redis read metrics count payload hits rather than short-lived admission markers', async context => {
  const outcomes: boolean[] = [];
  const cache = createCache(catalogCacheOptions({ REDIS_URL: 'redis://127.0.0.1:1' }, { recordRedisResult: hit => outcomes.push(hit) }));
  const redis = cache.stores[1]!;
  let value: unknown = undefined;
  context.mock.method(redis.store, 'get', async () => JSON.stringify({ value, expires: Date.now() + 60_000 }));
  try {
    await redis.getRaw('marker');
    await redis.get('marker');
    assert.deepEqual(outcomes, [false, false]);
    value = { item: 'present' };
    await redis.getRaw('value');
    await redis.get('value');
    assert.deepEqual(outcomes, [false, false, true, true]);
  } finally { await cache.disconnect(); }
});

test('Redis adapter failure preserves framework memory hits and successful loaders', async () => {
  const cache = createCache(catalogCacheOptions({ REDIS_URL: 'redis://127.0.0.1:1' }));
  try {
    let reads = 0;
    const load = async () => ({ value: ++reads });
    assert.deepEqual(await cache.wrap('redis-unavailable', load), { value: 1 });
    assert.deepEqual(await cache.wrap('redis-unavailable', load), { value: 1 });
    assert.equal(reads, 1);
  } finally { await cache.disconnect(); }
});

test('real Redis serves a second cache instance and then promotes the value to its memory tier', async context => {
  const url = process.env.TEST_REDIS_URL?.trim();
  if (!url) { context.skip('TEST_REDIS_URL is not configured'); return; }
  const outcomes: boolean[] = [];
  const first = createCache(catalogCacheOptions({ REDIS_URL: url }));
  const second = createCache(catalogCacheOptions({ REDIS_URL: url }, { recordRedisResult: hit => outcomes.push(hit) }));
  const key = 'framework-test:' + randomUUID();
  const expected = { items: [{ id: '42', price: '1.23' }] };
  try {
    assert.deepEqual(await first.wrap(key, async () => expected), expected);
    const stored = await first.stores[1]!.getRaw(key);
    assert.deepEqual(stored?.value, expected);
    assert.ok(stored?.expires && stored.expires - Date.now() <= CATALOG_CACHE_TTL_MS);
    const unexpectedLoad = async () => { assert.fail('the second instance must reuse Redis'); };
    assert.deepEqual(await second.wrap(key, unexpectedLoad), expected);
    assert.deepEqual(outcomes, [true]);
    assert.deepEqual(await second.wrap(key, unexpectedLoad), expected);
    assert.deepEqual(outcomes, [true], 'memory hits must not count as Redis reads');
  } finally {
    await first.del(key);
    await first.disconnect(); await second.disconnect();
  }
});

for (const stalledCommand of ['GET', 'SET']) {
  test(`an established Redis connection that stops answering ${stalledCommand} cannot hang catalog loads`, { timeout: 5_000 }, async context => {
    let stall = false;
    let stalled = 0;
    const sockets = new Set<Socket>();
    const server = createServer(socket => {
      sockets.add(socket);
      let pending = Buffer.alloc(0);
      socket.on('close', () => sockets.delete(socket));
      socket.on('data', chunk => {
        pending = Buffer.concat([pending, chunk]);
        for (;;) {
          const headerEnd = pending.indexOf('\r\n');
          if (headerEnd < 0) return;
          const count = Number(pending.subarray(1, headerEnd).toString());
          const args: string[] = [];
          let offset = headerEnd + 2;
          for (let i = 0; i < count; i += 1) {
            const end = pending.indexOf('\r\n', offset);
            if (end < 0) return;
            const length = Number(pending.subarray(offset + 1, end).toString());
            if (pending.length < end + length + 4) return;
            args.push(pending.subarray(end + 2, end + length + 2).toString());
            offset = end + length + 4;
          }
          pending = pending.subarray(offset);
          const command = args[0]?.toUpperCase();
          if (stall && command === stalledCommand) { stalled += 1; continue; }
          socket.write(command === 'GET' ? '$-1\r\n' : '+OK\r\n');
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const cache = createCache(catalogCacheOptions({ REDIS_URL: `redis://127.0.0.1:${address.port}` }));
    const deadline = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 3_000);
    context.after(async () => {
      clearTimeout(deadline);
      for (const socket of sockets) socket.destroy();
      await cache.disconnect();
      await new Promise<void>(resolve => server.close(() => resolve()));
    });
    await cache.set('handshake', 'ready');
    stall = true;
    let reads = 0;
    const load = async () => ({ value: ++reads });
    const started = performance.now();
    assert.deepEqual(await cache.wrap('stalled-command', load), { value: 1 });
    assert.ok(performance.now() - started < 2_500, 'native socket timeout releases the request before test cleanup');
    assert.ok(stalled > 0, 'the socket was established and actually received the stalled command');
    assert.deepEqual(await cache.wrap('stalled-command', load), { value: 1 });
    assert.equal(reads, 1, 'the successful loader remains in the memory tier');
  });
}

test('Nest owns the configured cache provider and closes the Redis adapter on shutdown', async () => {
  const module = await Test.createTestingModule({ imports: [CatalogCacheModule] }).compile();
  const cache = module.get<Cache>(CACHE);
  const key = 'framework-lifecycle:' + randomUUID();
  const redis = cache.stores[1]?.store as KeyvRedis | undefined;
  try {
    await cache.set(key, 'ready');
    assert.equal(await cache.get(key), 'ready');
    await cache.del(key);
  } finally { await module.close(); }
  assert.equal(redis?.client.isOpen ?? false, false);
});

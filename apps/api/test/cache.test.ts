import assert from 'node:assert/strict';
import test from 'node:test';
import { Keyv } from 'keyv';
import { createCache, createMemoryStore } from '../src/cache/cache.js';

test('Keyv 6 entries are reused by wrap, including false, zero, empty strings and null', async () => {
  const cache = createCache({ stores: [new Keyv()], ttl: 1000 });
  try {
    for (const value of [false, 0, '', null, { present: true }]) {
      await cache.set('entry', value);
      assert.deepEqual(await cache.wrap('entry', () => { assert.fail('cached entries must not invoke the loader'); }), value);
    }
  } finally { await cache.disconnect(); }
});

test('memory values are isolated from mutations to the input and returned objects', async () => {
  const cache = createCache({ stores: [createMemoryStore(1000)] });
  try {
    const input = { nested: { value: 1 } };
    await cache.set('entry', input);
    input.nested.value = 2;
    const first = (await cache.get<typeof input>('entry'))!;
    assert.equal(first.nested.value, 1);
    first.nested.value = 3;
    assert.deepEqual(await cache.get('entry'), { nested: { value: 1 } });
  } finally { await cache.disconnect(); }
});

test('promotion from a secondary store preserves its original expiry', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const memory = new Keyv(), secondary = new Keyv();
  const cache = createCache({ stores: [memory, secondary], ttl: 5000 });
  try {
    await secondary.set('shared', { value: 1 }, 100);
    assert.deepEqual(await cache.wrap('shared', () => { assert.fail('must reuse the secondary store'); }), { value: 1 });
    assert.deepEqual(await memory.get('shared'), { value: 1 });
    t.mock.timers.tick(101);
    assert.equal(await cache.get('shared'), undefined);
    assert.deepEqual(await cache.wrap('shared', () => ({ value: 2 })), { value: 2 });
  } finally { await cache.disconnect(); }
});

test('concurrent cache misses share one loader and rejected loaders can be retried', async () => {
  const cache = createCache({ stores: [new Keyv()], ttl: 1000 });
  const started = Promise.withResolvers<void>(), result = Promise.withResolvers<number>();
  let calls = 0;
  const load = () => { calls++; started.resolve(); return result.promise; };
  try {
    const requests = Array.from({ length: 8 }, () => cache.wrap('shared', load));
    await started.promise;
    assert.equal(calls, 1);
    result.resolve(42);
    assert.deepEqual(await Promise.all(requests), Array(8).fill(42));
    assert.equal(await cache.wrap('shared', load), 42);
    assert.equal(calls, 1);
    const failure = new Error('loader failed');
    await assert.rejects(cache.wrap('failure', () => { throw failure; }), error => error === failure);
    assert.equal(await cache.wrap('failure', () => 7), 7);
  } finally { await cache.disconnect(); }
});

test('an oversized replacement invalidates both tiers while returning the uncached value', async () => {
  const stores = [new Keyv(), new Keyv()];
  const cache = createCache({ stores, maxBytes: 32 });
  try {
    await cache.set('bounded', { small: true });
    const oversized = { text: '\u4e2d'.repeat(20) };
    assert.deepEqual(await cache.set('bounded', oversized), oversized);
    assert.equal(await stores[0]!.get('bounded'), undefined);
    assert.equal(await stores[1]!.get('bounded'), undefined);
    let loads = 0;
    for (let i = 0; i < 2; i++) assert.deepEqual(await cache.wrap('bounded', () => { loads++; return oversized; }), oversized);
    assert.equal(loads, 2);
  } finally { await cache.disconnect(); }
});

test('failed cache stores do not hide working stores or successful loaders', async t => {
  const failed = new Keyv(), memory = new Keyv();
  const cache = createCache({ stores: [failed, memory], ttl: 1000 });
  for (const method of ['get', 'getRaw', 'getMany', 'set', 'delete'] as const)
    t.mock.method(failed, method, async () => { throw new Error('cache unavailable'); });
  try {
    assert.equal(await cache.wrap('available', () => 'ready'), 'ready');
    assert.equal(await cache.get('available'), 'ready');
    assert.deepEqual(await cache.mget(['missing', 'available', 'available']), [undefined, 'ready', 'ready']);
    await cache.mdel(['available']);
    assert.equal(await memory.get('available'), undefined);
  } finally { await cache.disconnect(); }
});

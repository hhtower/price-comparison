import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSharedHostRateLimiter } from '../src/crawler/rate-limiter.js';

function sharedHarness() {
  let clock = 0;
  const nextStarts = new Map<string, number>();
  const starts: Array<{ key: string; at: number }> = [];
  const delays: number[] = [];
  const redis = {
    async eval(script: string, keyCount: number, key: string, interval: string) {
      assert.equal(keyCount, 1);
      assert.match(script, /redis.call\('TIME'\)/);
      const delay = (nextStarts.get(key) ?? 0) - clock;
      if (delay > 0) return delay;
      starts.push({ key, at: clock });
      nextStarts.set(key, clock + Number(interval));
      return 0;
    },
  };
  const wait = async (ms: number) => { delays.push(ms); clock += ms; };
  const intervals = new Map([['wzyp.cn', 1000], ['other.example', 1000]]);
  return { redis, starts, delays, limiter: () => createSharedHostRateLimiter(intervals, redis, wait) };
}

test('product crawlers share the same host budget across limiter instances', async () => {
  const harness = sharedHarness();
  const crawler = harness.limiter();
  const otherCrawler = harness.limiter();
  await crawler.acquire('wzyp.cn');
  await otherCrawler.acquire('wzyp.cn');
  await crawler.acquire('wzyp.cn');
  assert.deepEqual(harness.starts.map(start => start.at), [0, 1000, 2000]);
  assert.deepEqual(harness.delays, [1000, 1000]);
  assert.ok(harness.starts.every(start => start.key === 'crawler:host-rate:v1:wzyp.cn'));
});

test('different shop domains retain independent budgets in the shared pool', async () => {
  const harness = sharedHarness();
  await harness.limiter().acquire('wzyp.cn');
  await harness.limiter().acquire('other.example');
  assert.deepEqual(harness.delays, []);
});

test('unlisted domains share the default budget across independent workers', async () => {
  const harness = sharedHarness();
  await harness.limiter().acquire('custom.example');
  await harness.limiter().acquire('other.example');
  await harness.limiter().acquire('custom.example');
  assert.deepEqual(harness.starts.map(start => [start.key, start.at]), [
    ['crawler:host-rate:v1:custom.example', 0],
    ['crawler:host-rate:v1:other.example', 0],
    ['crawler:host-rate:v1:custom.example', 1000],
  ]);
});

test('concurrent limiter instances recheck admission after waiting rather than reuse the same slot', async () => {
  const harness = sharedHarness();
  await Promise.all([harness.limiter().acquire('wzyp.cn'), harness.limiter().acquire('wzyp.cn'), harness.limiter().acquire('wzyp.cn')]);
  assert.equal(harness.starts.length, 3);
  for (let index = 1; index < harness.starts.length; index++) {
    assert.ok(harness.starts[index]!.at - harness.starts[index - 1]!.at >= 1000);
  }
});

test('a configured shared pool fails closed when Redis is unavailable or returns invalid data', async () => {
  const intervals = new Map([['wzyp.cn', 1000]]);
  const offline = createSharedHostRateLimiter(intervals, { eval: async () => { throw new Error('redis unavailable'); } });
  await assert.rejects(offline.acquire('wzyp.cn'), /redis unavailable/);
  for (const value of [null, -1, NaN, '0', [], 0.5]) {
    const malformed = createSharedHostRateLimiter(intervals, { eval: async () => value });
    await assert.rejects(malformed.acquire('wzyp.cn'), /invalid.*delay/i);
  }
});

test('cancellation stops admission before a Redis command or another slot is claimed', async () => {
  const harness = sharedHarness();
  await harness.limiter().acquire('wzyp.cn');
  const controller = new AbortController();
  const reason = new Error('crawler cancelled');
  const cancelled = createSharedHostRateLimiter(new Map([['wzyp.cn', 1000]]), harness.redis, async () => {
    controller.abort(reason);
    throw reason;
  });
  await assert.rejects(cancelled.acquire('wzyp.cn', controller.signal), error => error === reason);
  await assert.rejects(harness.limiter().acquire('wzyp.cn', controller.signal), error => error === reason);
  assert.equal(harness.starts.length, 1);
});

test('shared host pause takes the maximum deadline across workers and admits other hosts', async () => {
  let clock = 0;
  const next = new Map<string, number>();
  const waits: number[] = [];
  const redis = { async eval(script: string, _keys: number, key: string, value: string) {
    const current = next.get(key) ?? 0;
    if (script.includes('until_at')) {
      next.set(key, Math.max(current, clock + Number(value)));
      return next.get(key)!;
    }
    const delay = Math.max(0, current - clock);
    if (delay) return delay;
    next.set(key, clock + Number(value));
    return 0;
  } };
  const create = () => createSharedHostRateLimiter(new Map([['wzyp.cn', 100], ['other.example', 100]]), redis,
    async ms => { waits.push(ms); clock += ms; });
  await create().pause('wzyp.cn', 2000);
  await create().pause('wzyp.cn', 500);
  await create().acquire('other.example');
  await create().acquire('wzyp.cn');
  assert.deepEqual(waits, [2000]);
});

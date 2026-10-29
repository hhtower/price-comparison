import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MetricsRegistry } from '../src/observability/metrics.js';
import {
  CRAWLER_METRICS_KEY_PREFIX,
  CRAWLER_METRICS_TTL_SECONDS,
  publishCrawlerMetrics,
  readCrawlerMetrics,
  startCrawlerMetricsPublisher,
  streamCrawlerMetrics,
} from '../src/crawler/metrics-store.js';
import { ProxyPool } from '../src/crawler/proxy-pool.js';

test('publisher includes live pool outage duration without summing concurrent waiters', async () => {
  let now = 0;
  const pool = new ProxyPool(['http://proxy.test'], { now: () => now, dispatcherFactory: () => ({}) as never });
  const leases = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire()]);
  leases.forEach(lease => lease.reportFailure('connection'));
  now = 4000;
  const redis = createFakeRedis();
  const publisher = startCrawlerMetricsPublisher({ metrics: new MetricsRegistry(), proxyPool: pool, redis, workerId: 'probe-test' });
  publisher.stop();
  await new Promise(resolve => setImmediate(resolve));
  const report = await readCrawlerMetrics(redis);
  assert.equal(report.counters.proxy_cooldown_count, 1);
  assert.equal(report.counters.proxy_unavailable_ms, 4000);
});

function createFakeRedis() {
  const hashes = new Map<string, Record<string, string>>();
  const workers = new Map<string, number>();
  const expirations = new Map<string, number>();
  return {
    hashes,
    workers,
    expirations,
    serverNow: 9000,
    async time(): Promise<number[]> { return [Math.floor(this.serverNow / 1000), this.serverNow % 1000 * 1000]; },
    async hset(key: string, fields: Record<string, string | number>) {
      const current = hashes.get(key) ?? {};
      for (const [name, value] of Object.entries(fields)) current[name] = String(value);
      hashes.set(key, current);
    },
    async hgetall(key: string) { return { ...(hashes.get(key) ?? {}) }; },
    async expire(key: string, ttl: number) { expirations.set(key, ttl); },
    async scanKeys(pattern: string) {
      const prefix = pattern.replace(/\*$/u, '');
      return [...hashes.keys()].filter(key => key.startsWith(prefix));
    },
    async zadd(_key: string, score: number, member: string) { workers.set(member, score); },
    async zrange() { return [...workers.keys()]; },
    async zremrangebyscore(_key: string, _min: string, max: number) {
      for (const [member, score] of workers) if (score <= max) workers.delete(member);
    },
  };
}

test('publishCrawlerMetrics 写入计数器与时间戳并设置过期', async () => {
  const redis = createFakeRedis();
  await publishCrawlerMetrics(redis, 'crawler-a', { proxy_request: 3, response_blocked: 1 }, 1_000, 9_876);
  assert.deepEqual(redis.hashes.get(`${CRAWLER_METRICS_KEY_PREFIX}crawler-a`), {
    proxy_request: '3', response_blocked: '1', started_at: '1000', updated_at: '9876',
  });
  assert.equal(redis.expirations.get(`${CRAWLER_METRICS_KEY_PREFIX}crawler-a`), CRAWLER_METRICS_TTL_SECONDS);
});

test('readCrawlerMetrics 汇总多 worker 计数器并取最近上报时间', async () => {
  const redis = createFakeRedis();
  await publishCrawlerMetrics(redis, 'crawler-a', { proxy_request: 3, response_blocked: 1 }, 1_000, 9_000);
  await publishCrawlerMetrics(redis, 'crawler-b', { proxy_request: 4, direct_request: 2 }, 2_000, 9_500);
  redis.hashes.get(`${CRAWLER_METRICS_KEY_PREFIX}crawler-b`)!.junk = 'not-a-number';
  assert.deepEqual(await readCrawlerMetrics(redis), {
    counters: { proxy_request: 7, direct_request: 2, response_blocked: 1 },
    workerCount: 2,
    lastReportAt: 9_500,
  });
});

test('readCrawlerMetrics 在无 Redis 或读取失败时返回离线报告', async () => {
  assert.deepEqual(await readCrawlerMetrics(undefined), { counters: {}, workerCount: 0, lastReportAt: null });
  const broken = { ...createFakeRedis(), hgetall: async () => { throw new Error('redis down'); } };
  assert.deepEqual(await readCrawlerMetrics(broken), { counters: {}, workerCount: 0, lastReportAt: null });
});

test('heartbeat reads only the worker registry and ignores expired worker hashes without scanning Redis', async () => {
  const redis = createFakeRedis();
  redis.scanKeys = async () => { throw new Error('must not scan Redis'); };
  await publishCrawlerMetrics(redis, 'active', { proxy_request: 3 }, 1000, 9000);
  redis.workers.set(`${CRAWLER_METRICS_KEY_PREFIX}expired`, 8000);
  assert.deepEqual(await readCrawlerMetrics(redis), {
    counters: { proxy_request: 3 }, workerCount: 1, lastReportAt: 9000,
  });
  assert.deepEqual([...redis.workers.keys()], [`${CRAWLER_METRICS_KEY_PREFIX}active`, `${CRAWLER_METRICS_KEY_PREFIX}expired`]);
});

test('publishing a heartbeat prunes workers beyond the heartbeat TTL', async () => {
  const redis = createFakeRedis();
  redis.workers.set('stale', 1000);
  redis.serverNow = 1000 + CRAWLER_METRICS_TTL_SECONDS * 1000;
  await publishCrawlerMetrics(redis, 'active', {}, 1000, 1000 + CRAWLER_METRICS_TTL_SECONDS * 1000);
  assert.deepEqual([...redis.workers.keys()], [`${CRAWLER_METRICS_KEY_PREFIX}active`]);
});

test('worker clock skew cannot prune another live worker from the shared registry', async () => {
  const redis = createFakeRedis();
  redis.serverNow = 100000;
  await publishCrawlerMetrics(redis, 'a', {}, 1000, 100000);
  redis.serverNow++;
  await publishCrawlerMetrics(redis, 'b', {}, 1000, 131000);
  assert.equal((await readCrawlerMetrics(redis)).workerCount, 2);
  assert.deepEqual([...redis.workers.values()], [100000, 100001]);
});
test('streamCrawlerMetrics 首推快照，仅在上报或深度变化后再推，可中止', async () => {
  const redis = createFakeRedis();
  await publishCrawlerMetrics(redis, 'crawler-a', { proxy_request: 1 }, 1_000, 9_000);
  const controller = new AbortController();
  const events: Array<{ lastReportAt: number | null; fetchQueueDepth?: number }> = [];
  let depth = 4;
  const done = (async () => {
    for await (const report of streamCrawlerMetrics(redis, {
      signal: controller.signal,
      intervalMs: 5,
      readExtras: async () => ({ fetchQueueDepth: depth }),
    })) {
      events.push(report);
      if (events.length >= 3) controller.abort();
    }
  })();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(events.length, 1, '数据未变化时不重复推送');
  depth = 5;
  await publishCrawlerMetrics(redis, 'crawler-a', { proxy_request: 2 }, 1_000, 9_100);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(events.length, 2, '上报时间或队列深度变化时推送');
  depth = 6;
  await done;
  assert.deepEqual(events.map(event => event.lastReportAt), [9_000, 9_100, 9_100]);
  assert.deepEqual(events.map(event => event.fetchQueueDepth), [4, 5, 6]);
});

test('streamCrawlerMetrics 与 since 相同时不重推初始快照', async () => {
  const redis = createFakeRedis();
  await publishCrawlerMetrics(redis, 'crawler-a', { proxy_request: 1 }, 1_000, 9_000);
  const controller = new AbortController();
  const pending = streamCrawlerMetrics(redis, { signal: controller.signal, intervalMs: 5, since: 9_000 }).next();
  setTimeout(() => controller.abort(), 10);
  const result = await pending;
  assert.equal(result.done, true);
});

test('streamCrawlerMetrics surfaces failed extras instead of publishing an incomplete snapshot', async () => {
  const redis = createFakeRedis();
  await publishCrawlerMetrics(redis, 'crawler-a', { proxy_request: 3 }, 1000, 9000);
  const stream = streamCrawlerMetrics(redis, {
    readExtras: async () => { throw new Error('diagnostics timeout'); },
  });
  try {
    await assert.rejects(stream.next(), /diagnostics timeout/);
  } finally {
    await stream.return(undefined);
  }
});

test('startCrawlerMetricsPublisher 周期发布注册表计数并在停止后冻结', async () => {
  const registry = new MetricsRegistry();
  registry.incrementCrawlerCounter('proxy_request');
  registry.incrementCrawlerCounter('response_blocked');
  const redis = createFakeRedis();
  const publisher = startCrawlerMetricsPublisher({ metrics: registry, redis, workerId: 'crawler-a', intervalMs: 5 });
  await new Promise(resolve => setTimeout(resolve, 12));
  const published = redis.hashes.get(`${CRAWLER_METRICS_KEY_PREFIX}crawler-a`)!;
  assert.equal(published.proxy_request, '1');
  assert.equal(published.response_blocked, '1');
  assert.ok(Number(published.started_at) > 0);
  assert.ok(Number(published.updated_at) > 0);
  registry.incrementCrawlerCounter('proxy_request');
  publisher.stop();
  await new Promise(resolve => setTimeout(resolve, 12));
  assert.equal(redis.hashes.get(`${CRAWLER_METRICS_KEY_PREFIX}crawler-a`)!.proxy_request, '1', '停止后不再发布');
  assert.doesNotThrow(() => publisher.stop());
});

test('startCrawlerMetricsPublisher 无 Redis 时为空操作', async () => {
  const registry = new MetricsRegistry();
  const publisher = startCrawlerMetricsPublisher({ metrics: registry, redis: undefined, workerId: 'crawler-a', intervalMs: 5 });
  await new Promise(resolve => setTimeout(resolve, 12));
  publisher.stop();
});

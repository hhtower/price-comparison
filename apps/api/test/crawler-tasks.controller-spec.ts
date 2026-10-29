import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CrawlerTasksController } from '../src/admin/crawler-tasks.controller.js';
import { publishCrawlerMetrics, CRAWLER_METRICS_KEY_PREFIX } from '../src/crawler/metrics-store.js';

function createFakeRedis() {
  const hashes = new Map<string, Record<string, string>>();
  const workers = new Map<string, number>();
  const expirations = new Map<string, number>();
  return {
    hashes,
    expirations,
    async hset(key: string, fields: Record<string, string | number>) {
      const current = hashes.get(key) ?? {};
      for (const [name, value] of Object.entries(fields)) current[name] = String(value);
      hashes.set(key, current);
    },
    async hgetall(key: string) { return { ...(hashes.get(key) ?? {}) }; },
    async expire(key: string, ttl: number) { expirations.set(key, ttl); },
    async time(): Promise<number[]> { return [9, 0]; },
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

const jobs = { fetchRunCounts: async () => ({ queued: 2, running: 1, failedRecent: 0 }) };

function createFakeReply() {
  const headers: Record<string, string> = {};
  const listeners: Record<string, () => void> = {};
  const written: string[] = [];
  const raw = {
    setHeader: (name: string, value: string) => { headers[name.toLowerCase()] = value; },
    flushHeaders: () => undefined,
    on: (event: string, handler: () => void) => { listeners[event] = handler; },
    write: (chunk: string) => { written.push(chunk); return true; },
    writableEnded: false,
    end: () => { raw.writableEnded = true; },
  };
  return { headers, listeners, written, raw, reply: { hijack: () => undefined, raw } };
}

test('status 合并 Redis 计数器与实例统计', async () => {
  const redis = createFakeRedis();
  await publishCrawlerMetrics(redis, 'crawler-a', { proxy_request: 3, response_blocked: 1 }, 1_000, 9_000);
  const controller = new CrawlerTasksController(redis as never, jobs as never);
  assert.deepEqual(await controller.status(), {
    counters: { proxy_request: 3, response_blocked: 1 },
    workerCount: 1,
    lastReportAt: 9_000,
    instances: { queued: 2, running: 1, failedRecent: 0 },
  });
});

test('status 在无 Redis 时仍返回实例统计与离线标记', async () => {
  const controller = new CrawlerTasksController(undefined, jobs as never);
  assert.deepEqual(await controller.status(), {
    counters: {},
    workerCount: 0,
    lastReportAt: null,
    instances: { queued: 2, running: 1, failedRecent: 0 },
  });
});

test('status 和 events 均携带持久化诊断', async () => {
  const diagnostics = { snapshot: async () => ({ windowRuns: 2, listSucceeded: 1, listFailed: 1 }) };
  const controller = new CrawlerTasksController(undefined, jobs as never, diagnostics as never);
  controller.streamIntervalMs = 5;
  assert.deepEqual((await controller.status()).diagnostics, await diagnostics.snapshot());
  const { written, listeners, reply } = createFakeReply();
  const finished = controller.events(undefined as never, reply as never);
  await waitFor(() => written.length >= 1);
  assert.deepEqual(JSON.parse(parseFrame(written[0]!).data).diagnostics, await diagnostics.snapshot());
  listeners.close!();
  await finished;
});

test('events 以 progress 事件推送快照，变化时续推，连接关闭即结束', async () => {
  const redis = createFakeRedis();
  await publishCrawlerMetrics(redis, 'crawler-a', { proxy_request: 1 }, 1_000, 9_000);
  const controller = new CrawlerTasksController(redis as never, jobs as never);
  controller.streamIntervalMs = 5;
  const { headers, listeners, written, raw, reply } = createFakeReply();
  const finished = controller.events(undefined as never, reply as never);
  await waitFor(() => written.length >= 1);
  assert.equal(headers['content-type'], 'text/event-stream');
  const first = parseFrame(written[0]!);
  assert.equal(first.event, 'progress');
  assert.equal(first.id, '9000');
  assert.deepEqual(JSON.parse(first.data), {
    counters: { proxy_request: 1 }, workerCount: 1, lastReportAt: 9_000,
    instances: { queued: 2, running: 1, failedRecent: 0 },
  });
  await publishCrawlerMetrics(redis, 'crawler-a', { proxy_request: 2 }, 1_000, 9_100);
  await waitFor(() => written.length >= 2);
  assert.equal(JSON.parse(parseFrame(written[1]!).data).lastReportAt, 9_100);
  listeners.close!();
  await finished;
  assert.equal(raw.writableEnded, true);
});

test('events 拒绝非数字 since', async () => {
  const controller = new CrawlerTasksController(undefined, jobs as never);
  await assert.rejects(
    () => controller.events('abc' as never, createFakeReply().reply as never),
    (error: { code?: string }) => error.code === 'INVALID_VERSION',
  );
});

test('concurrent status and stream reads share one complete database snapshot until the refresh interval expires', async () => {
  let reads = 0;
  let finish: (value: unknown) => void = () => {};
  const snapshot = { instances: { queued: 3, running: 1, failedRecent: 0 }, windowRuns: 1 };
  const diagnostics = { snapshot: () => { reads++; return new Promise(resolve => { finish = resolve; }); } };
  const controller = new CrawlerTasksController(undefined, {
    fetchRunCounts: async () => { throw new Error('queue already included in diagnostics'); },
  } as never, diagnostics as never);
  controller.streamIntervalMs = 20;
  const first = controller.status();
  const second = controller.status();
  const reply = createFakeReply();
  const stream = controller.events(undefined, reply.reply);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  finish(snapshot);
  const results = await Promise.all([first, second]);
  assert.deepEqual(results[0]!.instances, snapshot.instances);
  await waitFor(() => reply.written.length > 0);
  reply.listeners.close!();
  await stream;
  await controller.status();
  assert.equal(reads, 1);
  await new Promise(resolve => setTimeout(resolve, 25));
  const next = controller.status();
  assert.equal(reads, 2);
  finish(snapshot);
  await next;
});

test('a failed shared snapshot is not cached and the next request can recover', async () => {
  let reads = 0;
  const controller = new CrawlerTasksController(undefined, jobs as never, { snapshot: async () => {
    if (++reads === 1) throw new Error('database unavailable');
    return { instances: { queued: 1, running: 0, failedRecent: 0 } };
  } } as never);
  await assert.rejects(controller.status(), /database unavailable/);
  assert.equal((await controller.status()).instances.queued, 1);
  assert.equal(reads, 2);
});
function parseFrame(frame: string): { id: string; event: string; data: string } {
  const lines = frame.split('\n');
  const parsed: Record<string, string> = {};
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator > 0) parsed[line.slice(0, separator)] = line.slice(separator + 1).trimStart();
  }
  return parsed as never;
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor 超时');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

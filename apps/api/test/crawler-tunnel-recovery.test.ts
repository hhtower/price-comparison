import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProxyPool } from '../src/crawler/proxy-pool.js';
import { createRunFetchFactory, CrawlerBlockedError } from '../src/crawler/fetch-client.js';
import { HostRateLimiter } from '../src/crawler/rate-limiter.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ProxyAgent } from 'undici';

function clockPool() {
  let now = 0;
  const waits: number[] = [];
  const pool = new ProxyPool(['http://key:secret@proxy.test:8000'], {
    now: () => now, dispatcherFactory: () => ({}) as never,
    sleep: async ms => { waits.push(ms); now += ms; },
  });
  return { pool, waits, advance: (ms: number) => { now += ms; } };
}

test('connection recovery uses short capped delays and counts each failed generation once', async () => {
  const { pool, waits } = clockPool();
  const peers = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire()]);
  peers.forEach(lease => lease.reportFailure('connection'));
  peers[0]!.reportFailure('connection');
  for (let i = 0; i < 6; i++) (await pool.acquire()).reportFailure('connection');
  const recovered = await pool.acquire();
  assert.deepEqual(waits, [5000, 10000, 20000, 40000, 60000, 60000, 60000]);
  recovered.reportSuccess();
  (await pool.acquire()).reportFailure('connection');
  (await pool.acquire()).reportSuccess();
  assert.equal(waits.at(-1), 5000);
});

test('only one recovery lease is admitted; success releases peers and outage time is not multiplied', async () => {
  const { pool, advance } = clockPool();
  const peers = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire()]);
  peers[0]!.reportFailure('connection');
  const probe = await pool.acquire();
  let admitted = false;
  const pending = pool.acquire(AbortSignal.timeout(1000)).then(lease => { admitted = true; return lease; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(admitted, false);
  advance(200);
  assert.equal(pool.snapshot().proxy_unavailable_ms, 5200);
  probe.reportSuccess();
  (await pending).release();
  advance(1000);
  assert.equal(pool.snapshot().proxy_unavailable_ms, 5200);
  assert.equal(pool.snapshot().proxy_cooldown_count, 1);
  assert.equal(pool.snapshot().proxy_recovery_probe, 1);
  assert.equal(pool.snapshot().proxy_recovery_success, 1);
});

test('cancelled recovery owner releases the probe without a new failure', async () => {
  const { pool, waits } = clockPool();
  (await pool.acquire()).reportFailure('connection');
  const controller = new AbortController();
  const probe = await pool.acquire(controller.signal);
  const next = pool.acquire(AbortSignal.timeout(1000));
  controller.abort(new Error('cancelled'));
  probe.reportFailure('connection');
  (await next).reportSuccess();
  assert.deepEqual(waits, [5000]);
  assert.equal(pool.snapshot().proxy_recovery_failure, 0);
});

test('cancelling a waiter does not take ownership away from the recovery probe', async () => {
  const { pool } = clockPool();
  (await pool.acquire()).reportFailure('connection');
  const probe = await pool.acquire();
  const controller = new AbortController();
  const waiting = pool.acquire(controller.signal);
  const reason = new Error('cancel waiting');
  controller.abort(reason);
  await assert.rejects(waiting, error => error === reason);
  assert.equal(probe.isHealthy(), true);
  probe.reportSuccess();
  (await pool.acquire()).release();
});

test('a failed probe wakes waiters into the next cooldown', async () => {
  const { pool, waits } = clockPool();
  (await pool.acquire()).reportFailure('connection');
  const probe = await pool.acquire();
  const next = pool.acquire(AbortSignal.timeout(1000));
  probe.reportFailure('connection');
  (await next).reportSuccess();
  assert.deepEqual(waits, [5000, 10000]);
  assert.equal(pool.snapshot().proxy_recovery_failure, 1);
});

test('one cooling entry does not count as a whole-pool outage when another is healthy', async () => {
  let now = 0;
  const pool = new ProxyPool(['http://a', 'http://b'], { now: () => now, dispatcherFactory: () => ({}) as never });
  (await pool.acquire()).reportFailure('connection');
  now = 5000;
  assert.equal(pool.snapshot().proxy_unavailable_ms, 0);
  assert.equal((await pool.acquire()).proxyUrl, 'http://b');
});

for (const status of [403, 429, 503]) test(`origin blocking ${status} pauses only its host, not the shared proxy`, async () => {
  const { pool, waits } = clockPool();
  let now = 0, calls = 0;
  const limiter = new HostRateLimiter(new Map(), () => now, async ms => { now += ms; });
  const factory = createRunFetchFactory({ pool, limiter, fetchImpl: (async () => ++calls === 1
    ? new Response('', { status, headers: { 'retry-after': '2', ...(status === 503 ? { 'cf-mitigated': 'challenge' } : {}) } })
    : Response.json({ code: 1 })) as never });
  await assert.rejects(factory(new AbortController().signal)('https://first.test/list'), CrawlerBlockedError);
  await factory(new AbortController().signal)('https://other.test/list');
  assert.deepEqual(waits, []);
  assert.equal(now, 0);
  await limiter.acquire('first.test');
  assert.equal(now, 2000);
});

test('CONNECT authentication failure is terminal, disables the entry and never leaks credentials', async () => {
  const { pool, waits } = clockPool();
  let calls = 0;
  const logs: unknown[] = [];
  const error = new TypeError('fetch failed http://key:secret@proxy.test', {
    cause: Object.assign(new Error('Proxy response (407) !== 200 when HTTP Tunneling'), { code: 'UND_ERR_ABORTED' }),
  });
  const factory = createRunFetchFactory({ pool, limiter: new HostRateLimiter(new Map()),
    logger: { warn: (...args) => { logs.push(args); } },
    fetchImpl: (async () => { calls++; throw error; }) as never });
  for (let i = 0; i < 2; i++) await assert.rejects(factory(new AbortController().signal)('https://shop.test/list?token=private'), e =>
    e instanceof Error && Reflect.get(e, 'retryable') === false && Reflect.get(e, 'retryClass') === 'configuration');
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
  assert.doesNotMatch(JSON.stringify(logs), /secret|private|key:/);
  assert.match(JSON.stringify(logs), /407/);
  assert.equal(pool.snapshot().proxy_auth_failure, 1);
});

test('CONNECT 429 is a proxy failure, not a source-domain pause', async () => {
  const { pool, waits } = clockPool();
  const pauses: number[] = [];
  let calls = 0;
  const factory = createRunFetchFactory({ pool,
    limiter: { acquire: async () => {}, pause: async (_host: string, ms: number) => { pauses.push(ms); } } as never,
    fetchImpl: (async () => {
      if (++calls === 1) throw new TypeError('fetch failed', { cause: new Error('Proxy response (429) !== 200 when HTTP Tunneling') });
      return Response.json({});
    }) as never });
  await factory(new AbortController().signal)('https://shop.test/list');
  assert.deepEqual(waits, [5000]);
  assert.deepEqual(pauses, []);
  assert.equal(pool.snapshot().proxy_recovery_success, 1);
});

test('transport logs contain safe cause codes and stage, not arbitrary error messages', async () => {
  const { pool } = clockPool();
  const logs: unknown[] = [];
  let calls = 0;
  const factory = createRunFetchFactory({ pool, limiter: new HostRateLimiter(new Map()),
    logger: { warn: (...args) => { logs.push(args); } },
    fetchImpl: (async () => {
      if (++calls === 1) throw new TypeError('secret-password', {
        cause: Object.assign(new Error('token=private'), { code: 'ECONNRESET' }),
      });
      return Response.json({});
    }) as never });
  await factory(new AbortController().signal)('https://shop.test/list?token=private');
  const text = JSON.stringify(logs);
  assert.match(text, /ECONNRESET/);
  assert.match(text, /connect/);
  assert.doesNotMatch(text, /secret-password|private/);
});

test('a cancelled admission cannot strand a half-open entry', async () => {
  const { pool } = clockPool();
  (await pool.acquire()).reportFailure('connection');
  const controller = new AbortController();
  const factory = createRunFetchFactory({ pool,
    limiter: { acquire: async () => { controller.abort(new Error('cancelled during admission')); } } as never,
    fetchImpl: (async () => { throw new Error('must not send'); }) as never });
  await assert.rejects(factory(controller.signal)('https://shop.test/list'), /cancelled during admission/);
  (await pool.acquire(AbortSignal.timeout(1000))).reportSuccess();
});

test('a non-network body rejection releases a probe for the next task', async () => {
  const { pool, waits } = clockPool();
  (await pool.acquire()).reportFailure('connection');
  const factory = createRunFetchFactory({ pool, limiter: new HostRateLimiter(new Map()), maxResponseBytes: 1,
    fetchImpl: (async () => Response.json({ too: 'large' })) as never });
  await assert.rejects(factory(new AbortController().signal)('https://shop.test/list'), /大小限制/);
  (await pool.acquire(AbortSignal.timeout(1000))).reportSuccess();
  assert.deepEqual(waits, [5000]);
});

test('real undici CONNECT 407 is recognized without reaching the target', async () => {
  const server = createServer();
  let connections = 0;
  server.on('connect', (_req, socket) => {
    connections++;
    socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const dispatcher = new ProxyAgent(url);
  try {
    const pool = new ProxyPool([url], { dispatcherFactory: () => dispatcher });
    const factory = createRunFetchFactory({ pool, limiter: new HostRateLimiter(new Map()) });
    await assert.rejects(factory(AbortSignal.timeout(2000))('https://never-contact.invalid/'), error =>
      error instanceof Error && error.name === 'ProxyAuthenticationError');
    assert.equal(connections, 1);
    assert.equal(pool.snapshot().proxy_auth_failure, 1);
  } finally {
    await dispatcher.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('request leases preserve run affinity but independent runs rotate', async () => {
  const dispatchers = new Map(['http://a', 'http://b'].map(url => [url, { url }]));
  const pool = new ProxyPool([...dispatchers.keys()], { dispatcherFactory: url => dispatchers.get(url) as never });
  const seen: unknown[] = [];
  const factory = createRunFetchFactory({ pool, limiter: new HostRateLimiter(new Map()),
    fetchImpl: (async (_url: unknown, init: any) => { seen.push(init.dispatcher); return Response.json({}); }) as never });
  const first = factory(new AbortController().signal);
  await first('https://shop.test/list');
  await first('https://shop.test/quotePrice');
  await factory(new AbortController().signal)('https://shop.test/list');
  assert.deepEqual(seen, [dispatchers.get('http://a'), dispatchers.get('http://a'), dispatchers.get('http://b')]);
});

test('a timed-out recovery request releases the probe and does not retry the request locally', async () => {
  const { pool } = clockPool();
  (await pool.acquire()).reportFailure('connection');
  let calls = 0;
  const factory = createRunFetchFactory({ pool, limiter: new HostRateLimiter(new Map()), requestTimeoutMs: 10,
    fetchImpl: (async (_url: unknown, init: RequestInit) => {
      calls++;
      return new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
    }) as never });
  await assert.rejects(factory(new AbortController().signal)('https://shop.test/list'), /timed out/);
  assert.equal(calls, 1);
  (await pool.acquire(AbortSignal.timeout(1000))).reportSuccess();
});

test('a host waiting for admission cannot monopolize the recovery probe', async () => {
  const { pool } = clockPool();
  (await pool.acquire()).reportFailure('connection');
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const factory = createRunFetchFactory({ pool,
    limiter: { acquire: async (host: string) => { if (host === 'paused.test') { entered(); await gate; } } } as never,
    fetchImpl: (async (url: string) => { calls.push(url); return Response.json({}); }) as never });
  const controller = new AbortController();
  const slow = factory(controller.signal)('https://paused.test/list');
  try {
    await waiting;
    const fast = factory(AbortSignal.timeout(1000))('https://other.test/list');
    await fast;
    assert.deepEqual(calls, ['https://other.test/list']);
  } finally {
    release();
    await slow;
  }
});

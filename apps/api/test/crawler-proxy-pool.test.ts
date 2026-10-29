import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProxyPool } from '../src/crawler/proxy-pool.js';

function harness(urls: string[], cooldownBaseMs = 50, cooldownMaxMs = 400) {
  let clock = 0;
  const sleeps: number[] = [];
  const dispatchers = new Map(urls.map(u => [u, { dispatcher: u }]));
  const pool = new ProxyPool(urls, {
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    cooldownBaseMs, cooldownMaxMs,
    dispatcherFactory: url => dispatchers.get(url) as never,
  });
  return { pool, sleeps, clock: () => clock };
}

test('acquire round-robins healthy entries per crawl run', async () => {
  const { pool } = harness(['http://a', 'http://b']);
  assert.equal((await pool.acquire()).proxyUrl, 'http://a');
  assert.equal((await pool.acquire()).proxyUrl, 'http://b');
  assert.equal((await pool.acquire()).proxyUrl, 'http://a');
});

test('empty pool yields a direct lease that ignores health reports', async () => {
  const { pool } = harness([]);
  const lease = await pool.acquire();
  assert.equal(lease.proxyUrl, null);
  assert.equal(lease.dispatcher, undefined);
  lease.reportFailure('blocked');
  assert.equal((await pool.acquire()).proxyUrl, null);
});

test('blocked lease cools down and rotation skips it', async () => {
  const { pool } = harness(['http://a', 'http://b']);
  const a = await pool.acquire();          // http://a
  a.reportFailure('blocked');
  assert.equal((await pool.acquire()).proxyUrl, 'http://b');
  assert.equal((await pool.acquire()).proxyUrl, 'http://b'); // a 仍冷却
});

test('cooldown escalates on repeated failures and success resets it', async () => {
  const { pool, sleeps } = harness(['http://a']);
  const first = await pool.acquire();
  first.reportFailure('blocked');          // 50ms 冷却（注入的 base）
  const second = await pool.acquire();     // 等待解冻
  assert.deepEqual(sleeps, [50]);
  second.reportFailure('blocked');         // 翻倍 → 100ms
  const third = await pool.acquire();
  assert.deepEqual(sleeps, [50, 100]);
  third.reportSuccess();
  const fourth = await pool.acquire();     // 立即，无新 sleep
  assert.deepEqual(sleeps, [50, 100]);
  fourth.reportFailure('blocked');
  await pool.acquire();
  assert.deepEqual(sleeps, [50, 100, 50]); // 成功已重置 → 回到 base
});

test('cooldown escalation is capped', async () => {
  const { pool } = harness(['http://a'], 50, 80);
  for (let round = 0; round < 4; round += 1) (await pool.acquire()).reportFailure('blocked');
  const lease = await pool.acquire();
  lease.reportFailure('blocked');
  const wait = await pool.acquire();   // 冷却 80ms 封顶而非 400ms
  assert.ok(wait.proxyUrl === 'http://a');
});

test('acquire waits for the earliest cooldown when all entries are cooling', async () => {
  const { pool, sleeps } = harness(['http://a', 'http://b']);
  (await pool.acquire()).reportFailure('blocked');
  (await pool.acquire()).reportFailure('blocked');
  const lease = await pool.acquire();
  assert.equal(lease.proxyUrl, 'http://a');
  assert.deepEqual(sleeps, [50]);
});

test('default cooldown wait stops on cancellation and preserves the abort reason', async () => {
  const pool = new ProxyPool(['http://proxy.invalid'], {
    cooldownBaseMs: 50, dispatcherFactory: () => ({}) as never,
  });
  (await pool.acquire()).reportFailure('blocked');
  const controller = new AbortController();
  const reason = new Error('crawl cancelled');
  const waiting = pool.acquire(controller.signal);
  controller.abort(reason);
  await assert.rejects(waiting, error => error === reason);
});

test('an older successful lease cannot clear a newer failure or reuse the cooled proxy', async () => {
  const { pool, sleeps } = harness(['http://a']);
  const old = await pool.acquire();
  const failing = await pool.acquire();
  failing.reportFailure('blocked');
  old.reportSuccess();
  assert.equal(old.isHealthy(), false);
  await pool.acquire();
  assert.deepEqual(sleeps, [50]);
});

test('route-restricted acquisition waits for SOCKS recovery instead of using a healthy HTTP proxy', async () => {
  const { pool, sleeps } = harness(['http://domestic', 'socks5://overseas']);
  const onlySocks = (url: string) => url.startsWith('socks5://');
  const first = await pool.acquire(undefined, undefined, undefined, onlySocks);
  assert.equal(first.proxyUrl, 'socks5://overseas');
  first.reportFailure('connection');
  const recovered = await pool.acquire(undefined, 'http://domestic', undefined, onlySocks);
  assert.equal(recovered.proxyUrl, 'socks5://overseas');
  assert.deepEqual(sleeps, [50]);
  recovered.reportSuccess();
  assert.equal((await pool.acquire()).proxyUrl, 'http://domestic');
});

test('route-restricted acquisition fails closed when no eligible proxies exist', async () => {
  for (const urls of [[], ['http://domestic']]) {
    const { pool } = harness(urls);
    await assert.rejects(pool.acquire(undefined, undefined, undefined, url => url.startsWith('socks5://')));
  }
});

test('authentication failure of all eligible SOCKS proxies cannot fall back to HTTP', async () => {
  const { pool } = harness(['http://domestic', 'socks5://overseas']);
  const onlySocks = (url: string) => url.startsWith('socks5://');
  (await pool.acquire(undefined, undefined, undefined, onlySocks)).reportFailure('authentication');
  await assert.rejects(pool.acquire(undefined, undefined, undefined, onlySocks), { name: 'ProxyAuthenticationError' });
});

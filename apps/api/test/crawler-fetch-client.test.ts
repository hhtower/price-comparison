import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CrawlerBlockedError, createRunFetchFactory, DEFAULT_CRAWLER_UA, mergeDefaultHeaders, type CrawlerRequestEvent } from '../src/crawler/fetch-client.js';
import { platformForUrl } from '../src/platforms/index.js';
import { ProxyPool, type ProxyLease } from '../src/crawler/proxy-pool.js';
import { HostRateLimiter } from '../src/crawler/rate-limiter.js';

function fakeLease(url: string | null) {
  const events: string[] = [];
  const lease: ProxyLease = {
    proxyUrl: url, dispatcher: undefined,
    reportSuccess: () => events.push('success'),
    reportFailure: kind => events.push(`failure:${kind}`),
    release: () => {},
    isHealthy: () => true,
  };
  return { lease, events };
}

function harness(responses: Array<() => Response | Error>) {
  const leases = [fakeLease('http://a'), fakeLease('http://b')];
  let acquireCount = 0;
  const pool = { acquire: async (_signal: AbortSignal, preferred?: string, admit?: () => Promise<void>) => {
    await admit?.();
    return (leases.find(item => item.lease.proxyUrl === preferred) ?? leases[Math.min(acquireCount++, leases.length - 1)]!).lease;
  } } as never;
  const rateAcquisitions: string[] = [];
  const limiter = { acquire: async (host: string) => { rateAcquisitions.push(host); }, pause: async () => {} } as never;
  const counters: Record<string, number> = {};
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let call = 0;
  const fetchImpl = (async (_url: string | URL, init?: RequestInit & { headers?: Record<string, string> }) => {
    calls.push({ url: String(_url), headers: init?.headers ?? {} });
    const outcome = responses[call++]!();
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }) as never;
  const factory = createRunFetchFactory({ limiter, pool, metrics: { incrementCrawlerCounter: key => { counters[key] = (counters[key] ?? 0) + 1; } }, fetchImpl });
  return { factory, leases, counters, calls, rateAcquisitions };
}

const jsonOk = () => new Response('{"code":1}', { headers: { 'content-type': 'application/json' } });

test('preserves a validated public-address dispatcher instead of replacing it with a proxy', async () => {
  const pinned = {} as any;
  const proxy = fakeLease('http://proxy');
  proxy.lease.dispatcher = {} as any;
  const counters: string[] = [];
  const factory = createRunFetchFactory({
    limiter: { acquire: async () => {} } as any, pool: { acquire: async (_signal: AbortSignal, _preferred: unknown, admit?: () => Promise<void>) => { await admit?.(); return proxy.lease; } } as any,
    metrics: { incrementCrawlerCounter: key => { counters.push(key); } },
    fetchImpl: (async (_url: unknown, init: any) => { assert.equal(init.dispatcher, pinned); return jsonOk(); }) as any,
  });
  await factory(new AbortController().signal)('https://shop.example/api', { dispatcher: pinned } as any);
  assert.ok(counters.includes('direct_request'));
});

test('bounds public HTML bodies before inspecting anti-bot content', async () => {
  const factory = createRunFetchFactory({ limiter: { acquire: async () => {} } as any, pool: {} as any,
    fetchImpl: (async () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'text/html' } })) as any });
  await assert.rejects(factory(new AbortController().signal)('https://shop.example/', { dispatcher: {} } as any), /大小限制/);
});

test('run binds one proxy and injects default browser headers', async () => {
  const { factory, leases, calls } = harness([jsonOk, jsonOk]);
  const fetch = factory(new AbortController().signal);
  await fetch('https://wzyp.cn/shopApi/Shop/goodsList', { method: 'POST', headers: { 'content-type': 'application/json' } });
  await fetch('https://wzyp.cn/shopApi/Shop/goodsList', { method: 'POST' });
  assert.equal(leases.filter(l => l.events.includes('success')).length, 1); // 全轮只用 http://a
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.headers['user-agent'], DEFAULT_CRAWLER_UA);
  assert.equal(calls[0]!.headers['accept-language'], 'zh-CN,zh;q=0.9');
  assert.equal(calls[0]!.headers['content-type'], 'application/json'); // 调用方头保留
});

test('Yunmao crawling uses the configured Qingguo proxy and shares its domain admission', async () => {
  const routes: unknown[] = [], counters: string[] = [], admissions: string[] = [];
  const pool = new ProxyPool(['http://domestic.example:24976'], {
    dispatcherFactory: () => ({}) as never,
  });
  const factory = createRunFetchFactory({
    pool, limiter: { acquire: async (host: string) => { admissions.push(host); } } as never,
    metrics: { incrementCrawlerCounter: key => { counters.push(key); } },
    fetchImpl: (async (_input: unknown, init: any) => {
      routes.push(init.dispatcher);
      assert.equal(init.proxyUrl, undefined);
      assert.match(init.headers.visitorid, /^[a-f0-9]{24}$/);
      return jsonOk();
    }) as never,
  });
  for (const host of ['catfk.com', 'catfk.com.']) {
    await factory(new AbortController().signal)(`https://${host}/shopApi/Shop/goodsList`);
  }
  assert.ok(routes[0]);
  assert.equal(routes[0], routes[1]);
  assert.deepEqual(admissions, ['catfk.com', 'catfk.com']);
  assert.deepEqual(counters, ['proxy_request', 'proxy_request']);
});

test('Yunmao proxy failure never falls back to a direct request', async () => {
  const routes: unknown[] = [];
  let clock = 0;
  const factory = createRunFetchFactory({
    pool: new ProxyPool(['http://domestic.example:24976'], { dispatcherFactory: () => ({}) as never,
      sleep: async ms => { clock += ms; }, now: () => clock }),
    limiter: new HostRateLimiter(new Map()),
    fetchImpl: (async (_input: unknown, init: any) => { routes.push(init.dispatcher); throw new Error('proxy offline'); }) as never,
  });
  await assert.rejects(factory(new AbortController().signal)('https://catfk.com/shopApi/Shop/goodsList'));
  assert.equal(routes.length, 2);
  assert.ok(routes[0]);
  assert.equal(routes[0], routes[1]);
});

test('a public-address-pinned Qingguo request is counted as proxy traffic', async () => {
  const pinned = {} as any;
  const counters: string[] = [];
  const factory = createRunFetchFactory({
    publicProxyUrl: 'http://domestic.example:24976',
    limiter: { acquire: async () => {} } as any,
    pool: new ProxyPool(['http://domestic.example:24976'], { dispatcherFactory: () => ({}) as never }),
    metrics: { incrementCrawlerCounter: key => { counters.push(key); } },
    fetchImpl: (async (_url: unknown, init: any) => { assert.equal(init.dispatcher, pinned); return jsonOk(); }) as any,
  });
  await factory(new AbortController().signal)('https://shop.example/api', { dispatcher: pinned } as any);
  assert.deepEqual(counters, ['proxy_request']);
});

test('pinned Qingguo requests share proxy authentication health and never select a different exit', async () => {
  const url = 'http://domestic.example:24976';
  const pool = new ProxyPool([url, 'http://other.example:24976'], { dispatcherFactory: () => ({}) as never });
  let sent = 0;
  const factory = createRunFetchFactory({ publicProxyUrl: url, pool,
    limiter: { acquire: async () => {} } as never,
    fetchImpl: (async () => { sent++; return new Response(null, { status: 407 }); }) as never,
  });
  await assert.rejects(factory(new AbortController().signal)('https://custom.example/api', { dispatcher: {} } as never), { name: 'ProxyAuthenticationError' });
  assert.equal(pool.snapshot().proxy_auth_failure, 1);
  await assert.rejects(factory(new AbortController().signal)('https://custom.example/api', { dispatcher: {} } as never), { name: 'ProxyAuthenticationError' });
  assert.equal(sent, 1);
});

test('Yunmao Node transport preserves a public-address-pinned dispatcher', async () => {
  let sent = 0;
  const pinned = {} as any;
  const factory = createRunFetchFactory({
    pool: new ProxyPool(['socks5://overseas.example:1080'], { dispatcherFactory: () => ({}) as never }),
    limiter: new HostRateLimiter(new Map()),
    fetchImpl: (async (_url: unknown, init: any) => { sent++; assert.equal(init.dispatcher, pinned); return jsonOk(); }) as never,
  });
  await factory(new AbortController().signal)('https://catfk.com/api', { dispatcher: pinned } as never);
  assert.equal(sent, 1);
});

test('Yunmao headers preserve caller values and do not affect other domains', () => {
  const caller = { 'User-Agent': 'custom', 'Accept-Language': 'en', VisitorId: 'existing' };
  assert.deepEqual(mergeDefaultHeaders(caller, 'https://catfk.com/api'), caller);
  assert.equal(mergeDefaultHeaders({}, 'https://catfk.com.evil.example/api').visitorid, undefined);
  assert.equal(mergeDefaultHeaders({}, 'https://wzyp.cn/api')['user-agent'], DEFAULT_CRAWLER_UA);
});

test('Yunmao listing, payment channels and quotes all use the same Node request profile', async () => {
  const shop = { url: 'https://catfk.com/shop/abc' };
  const product = { goods_key: 'G1', name: 'Product A', price: '12.00', link: 'https://catfk.com/item/G1', extend: { stock_count: 2 } };
  const paths: string[] = [], visitors = new Set<string>();
  const factory = createRunFetchFactory({
    pool: new ProxyPool(['http://domestic.example:24976'], { dispatcherFactory: () => ({}) as never }),
    limiter: { acquire: async () => {} } as never,
    fetchImpl: (async (url: string, init: any) => {
      assert.ok(init.dispatcher);
      assert.equal(init.proxyUrl, undefined);
      assert.match(init.headers['user-agent'], /Macintosh.*Chrome\/124/);
      assert.match(init.headers.visitorid, /^[a-f0-9]{24}$/);
      visitors.add(init.headers.visitorid);
      const path = new URL(url).pathname;
      paths.push(path);
      const payload = path.endsWith('/goodsList') ? { code: 1, data: { list: [product], total: 1 } }
        : path.endsWith('/getUserChannel') ? { code: 1, data: [{ id: 7, status: 1, custom_status: 1, show_name: 'Card' }] }
          : { code: 1, data: { quantity: 1, total_amount: '13.00' } };
      return Response.json(payload);
    }) as never,
  });
  const [item] = await platformForUrl(shop.url).crawl(null, shop, factory(new AbortController().signal) as typeof fetch);
  assert.equal(item?.settlement?.price, '13.00');
  assert.deepEqual(paths, ['/shopApi/Shop/goodsList', '/shopApi/Shop/getUserChannel', '/shopApi/Shop/getGoodsPrice']);
  assert.equal(visitors.size, 3);
});

test('403 proves transport health but throws CrawlerBlockedError without retry', async () => {
  const { factory, leases, counters } = harness([() => new Response('forbidden', { status: 403 })]);
  const fetch = factory(new AbortController().signal);
  await assert.rejects(fetch('https://wzyp.cn/x'), CrawlerBlockedError);
  assert.deepEqual(leases[0]!.events, ['success']);
  assert.equal(counters['response_blocked'], 1);
});

test('cf-mitigated 503 counts as blocked', async () => {
  const { factory, leases } = harness([() => new Response('', { status: 503, headers: { 'cf-mitigated': 'challenge' } })]);
  await assert.rejects(factory(new AbortController().signal)('https://wzyp.cn/x'), CrawlerBlockedError);
  assert.deepEqual(leases[0]!.events, ['success']);
});

test('html body with challenge markers is blocked', async () => {
  const html = () => new Response('<html><title>Just a moment...</title></html>', { headers: { 'content-type': 'text/html' } });
  const { factory, leases } = harness([html]);
  await assert.rejects(factory(new AbortController().signal)('https://wzyp.cn/x'), CrawlerBlockedError);
  assert.deepEqual(leases[0]!.events, ['success']);
});

test('explicit HTML storefront requests pass bounded HTML through the shared transport but still block challenges', async () => {
  const valid = '<html><body>商品目录</body></html>';
  const { factory, rateAcquisitions, counters } = harness([() => new Response(valid, { headers: { 'content-type': 'text/html' } })]);
  const response = await factory(new AbortController().signal)('https://ouvg.top/', { headers: { accept: 'text/html' } });
  assert.equal(await response.text(), valid);
  assert.deepEqual(rateAcquisitions, ['ouvg.top']);
  assert.equal(counters.response_blocked, undefined);
  for (const body of ['<html><title>Just a moment...</title></html>', '<html><script>window._cf_chl_opt = {};</script></html>']) {
    const blocked = harness([() => new Response(body, { headers: { 'content-type': 'text/html' } })]);
    await assert.rejects(blocked.factory(new AbortController().signal)('https://ouvg.top/', { headers: { accept: 'text/html' } }), CrawlerBlockedError);
    assert.equal(blocked.counters.response_blocked, 1);
  }
});

test('plain html without markers is blocked and pauses the host', async () => {
  const pauses: Array<{ host: string; ms: number }> = [];
  const html = () => new Response('<html>maintenance</html>', { headers: { 'content-type': 'text/html' } });
  const proxy = fakeLease(null);
  const counters: Record<string, number> = {};
  const factory = createRunFetchFactory({
    limiter: { acquire: async () => {}, pause: async (host: string, ms: number) => { pauses.push({ host, ms }); } } as never,
    pool: { acquire: async (_signal: AbortSignal, _preferred: unknown, admit?: () => Promise<void>) => { await admit?.(); return proxy.lease; } } as never,
    metrics: { incrementCrawlerCounter: key => { counters[key] = (counters[key] ?? 0) + 1; } },
    fetchImpl: html as never,
  });
  await assert.rejects(factory(new AbortController().signal)('https://wzyp.cn/x'), CrawlerBlockedError);
  assert.deepEqual(pauses, [{ host: 'wzyp.cn', ms: 60_000 }]); // 无 Retry-After 时回退 60s 暂停
  assert.equal(counters.response_blocked, 1);
  assert.deepEqual(proxy.events, ['success']); // Transport success is not API success.
});

test('opt-in body limit rejects proxy HTML before unbounded challenge scanning', async () => {
  const proxy = fakeLease('http://proxy');
  let cancelled = false;
  const factory = createRunFetchFactory({
    pool: { acquire: async (_signal: AbortSignal, _preferred: unknown, admit?: () => Promise<void>) => { await admit?.(); return proxy.lease; } } as never,
    limiter: { acquire: async () => {} } as never,
    maxResponseBytes: 1024,
    fetchImpl: (async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(800)); }, cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'text/html' } })) as never,
  });
  await assert.rejects(factory(new AbortController().signal)('https://apps.apple.com/api/apps'), /大小限制/);
  assert.equal(cancelled, true);
  assert.deepEqual(proxy.events, []);
});

test('connection failure retries once on the next lease and switches the run', async () => {
  const { factory, leases, calls, rateAcquisitions } = harness([() => new TypeError('fetch failed'), jsonOk, jsonOk]);
  const fetch = factory(new AbortController().signal);
  const first = await fetch('https://wzyp.cn/x');
  assert.equal(first.status, 200);
  assert.deepEqual(leases[0]!.events, ['failure:connection']);
  assert.deepEqual(leases[1]!.events, ['success']);
  await fetch('https://wzyp.cn/y'); // 本轮后续请求直接用 lease b，不再 acquire
  assert.equal(calls.length, 3);
  assert.deepEqual(rateAcquisitions, ['wzyp.cn', 'wzyp.cn', 'wzyp.cn']);
});

test('a connection retry cannot bypass an unavailable shared host budget', async () => {
  let admissions = 0, requests = 0;
  const proxy = fakeLease(null);
  const factory = createRunFetchFactory({
    limiter: { acquire: async () => { if (++admissions === 2) throw new Error('shared host budget unavailable'); } } as never,
    pool: { acquire: async (_signal: AbortSignal, _preferred: unknown, admit?: () => Promise<void>) => { await admit?.(); return proxy.lease; } } as never,
    fetchImpl: (async () => { if (++requests === 1) throw new TypeError('fetch failed'); return jsonOk(); }) as never,
  });
  await assert.rejects(factory(new AbortController().signal)('https://wzyp.cn/x'), /shared host budget unavailable/);
  assert.equal(requests, 1);
});

test('both failed connection attempts are counted and observed', async () => {
  const { factory, counters } = harness([() => new TypeError('first'), () => new TypeError('second')]);
  const events: CrawlerRequestEvent[] = [];
  await assert.rejects(factory(new AbortController().signal, event => events.push(event))('https://wzyp.cn/quotePrice'));
  assert.equal((counters.proxy_request ?? 0) + (counters.direct_request ?? 0), 2);
  assert.deepEqual(events.filter(event => event.type === 'request').map(event => [event.stage, event.retry]), [['settlement', false], ['settlement', true]]);
  assert.equal(events.filter(event => event.type === 'failure' && event.reason === 'connection').length, 2);
  assert.equal(events.filter(event => event.type === 'duration' && event.phase === 'network').length, 2);
});

test('a cached proxy is reacquired after another request puts it in cooldown', async () => {
  const dispatchers = new Map(['http://a', 'http://b'].map(url => [url, { url }]));
  const pool = new ProxyPool(['http://a', 'http://b'], { dispatcherFactory: url => dispatchers.get(url) as never });
  const calls: unknown[] = [];
  const factory = createRunFetchFactory({ pool, limiter: { acquire: async () => {}, pause: async () => {} } as never,
    fetchImpl: (async (_url: unknown, init: any) => { calls.push(init.dispatcher); return jsonOk(); }) as never });
  const first = factory(new AbortController().signal);
  await first('https://wzyp.cn/a');
  await pool.acquire(); // b
  (await pool.acquire()).reportFailure('blocked');
  await first('https://wzyp.cn/b');
  assert.deepEqual(calls, [dispatchers.get('http://a'), dispatchers.get('http://b')]);
});

test('requests released from proxy cooldown reserve host slots immediately before transmission', async () => {
  let clock = 0;
  let release!: () => void;
  let bothWaiting!: () => void;
  let waiters = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { bothWaiting = resolve; });
  const pool = new ProxyPool(['http://a'], {
    now: () => clock, cooldownBaseMs: 100, dispatcherFactory: () => ({}) as never,
    sleep: async () => { if (++waiters === 2) bothWaiting(); await gate; },
  });
  (await pool.acquire()).reportFailure('blocked');
  const limiter = new HostRateLimiter(new Map([['wzyp.cn', 20]]), () => clock, async ms => { clock += ms; });
  const starts: number[] = [];
  const factory = createRunFetchFactory({ pool, limiter, fetchImpl: (async () => { starts.push(clock); return jsonOk(); }) as never });
  const first = factory(new AbortController().signal)('https://wzyp.cn/a');
  const second = factory(new AbortController().signal)('https://wzyp.cn/b');
  await waiting;
  clock = 100;
  release();
  await Promise.all([first, second]);
  assert.equal(starts.length, 2);
  assert.ok(starts[1]! - starts[0]! >= 20, `request starts were ${starts.join(', ')}`);
});

test('a proxy cooled during host admission is replaced before transmission', async () => {
  const dispatchers = new Map(['http://a', 'http://b'].map(url => [url, { url }]));
  const pool = new ProxyPool(['http://a', 'http://b'], { dispatcherFactory: url => dispatchers.get(url) as never });
  let release!: () => void;
  let waiting!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { waiting = resolve; });
  let admissions = 0;
  const limiter = { acquire: async () => { if (++admissions === 2) { waiting(); await gate; } } } as never;
  const used: unknown[] = [];
  const factory = createRunFetchFactory({ pool, limiter,
    fetchImpl: (async (_url: unknown, init: any) => { used.push(init.dispatcher); return jsonOk(); }) as never });
  const fetch = factory(new AbortController().signal);
  await fetch('https://wzyp.cn/a');
  const pending = fetch('https://wzyp.cn/b');
  await entered;
  await pool.acquire(); // b
  (await pool.acquire()).reportFailure('blocked'); // a
  release();
  await pending;
  assert.deepEqual(used, [dispatchers.get('http://a'), dispatchers.get('http://b')]);
  assert.equal(admissions, 3);
});

test('429 pauses only the origin and leaves its proxy usable for another host', async () => {
  let clock = 0;
  const proxyWaits: number[] = [];
  const pool = new ProxyPool(['http://a'], { now: () => clock, cooldownBaseMs: 500,
    sleep: async ms => { proxyWaits.push(ms); clock += ms; }, dispatcherFactory: () => ({}) as never });
  const limiter = new HostRateLimiter(new Map(), () => clock, async ms => { clock += ms; });
  const counters: Record<string, number> = {};
  let calls = 0;
  const factory = createRunFetchFactory({ pool, limiter,
    metrics: { incrementCrawlerCounter: key => { counters[key] = (counters[key] ?? 0) + 1; } },
    fetchImpl: (async () => ++calls === 1
      ? new Response('', { status: 429, headers: { 'retry-after': '1' } }) : jsonOk()) as never });
  await assert.rejects(factory(new AbortController().signal)('https://wzyp.cn/a'), CrawlerBlockedError);
  assert.equal((await factory(new AbortController().signal)('https://other.example.com/a')).status, 200);
  assert.deepEqual(proxyWaits, []);
  assert.equal(clock, 0);
  assert.equal(counters.response_rate_limited, 1);
  assert.equal(counters.response_blocked ?? 0, 0);
});

test('429 pauses its host using Retry-After seconds while another host stays available', async () => {
  let clock = 0;
  const delays: number[] = [];
  const { HostRateLimiter } = await import('../src/crawler/rate-limiter.js');
  const limiter = new HostRateLimiter(new Map(), () => clock, async ms => { delays.push(ms); clock += ms; });
  const pool = { acquire: async (_signal: AbortSignal, _preferred: unknown, admit?: () => Promise<void>) => { await admit?.(); return fakeLease(null).lease; } } as never;
  const factory = createRunFetchFactory({ limiter, pool, fetchImpl: (async () => new Response('', { status: 429, headers: { 'retry-after': '2' } })) as never });
  await assert.rejects(factory(new AbortController().signal)('https://wzyp.cn/a'), CrawlerBlockedError);
  await limiter.acquire('other.example.com');
  await limiter.acquire('wzyp.cn');
  assert.deepEqual(delays, [2000]);
});

test('Retry-After HTTP date sets the host pause duration', async () => {
  const pauses: number[] = [];
  const retryAt = new Date(Date.now() + 120_000).toUTCString();
  const factory = createRunFetchFactory({
    limiter: { acquire: async () => {}, pause: async (_host: string, ms: number) => { pauses.push(ms); } } as never,
    pool: { acquire: async (_signal: AbortSignal, _preferred: unknown, admit?: () => Promise<void>) => { await admit?.(); return fakeLease(null).lease; } } as never,
    fetchImpl: (async () => new Response('', { status: 429, headers: { 'retry-after': retryAt } })) as never,
  });
  await assert.rejects(factory(new AbortController().signal)('https://wzyp.cn/a'), CrawlerBlockedError);
  assert.ok(pauses[0]! >= 118_000 && pauses[0]! <= 120_000);
});

test('an expired Retry-After still applies a fallback host pause', async () => {
  const pauses: number[] = [];
  const factory = createRunFetchFactory({
    limiter: { acquire: async () => {}, pause: async (_host: string, ms: number) => { pauses.push(ms); } } as never,
    pool: { acquire: async (_signal: AbortSignal, _preferred: unknown, admit?: () => Promise<void>) => { await admit?.(); return fakeLease(null).lease; } } as never,
    fetchImpl: (async () => new Response('', { status: 429, headers: { 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' } })) as never,
  });
  await assert.rejects(factory(new AbortController().signal)('https://wzyp.cn/a'), CrawlerBlockedError);
  assert.deepEqual(pauses, [60_000]);
});

test('a slow host pause after 429 does not become a network timeout', async () => {
  const factory = createRunFetchFactory({
    limiter: { acquire: async () => {}, pause: async () => { await new Promise(resolve => setTimeout(resolve, 25)); } } as never,
    pool: { acquire: async (_signal: AbortSignal, _preferred: unknown, admit?: () => Promise<void>) => { await admit?.(); return fakeLease(null).lease; } } as never,
    requestTimeoutMs: 10,
    fetchImpl: (async () => new Response('', { status: 429 })) as never,
  });
  await assert.rejects(factory(new AbortController().signal)('https://wzyp.cn/a'), CrawlerBlockedError);
});

test('request timeout starts after rate and proxy waits', async () => {
  const slowFactory = createRunFetchFactory({
    limiter: { acquire: async () => { await new Promise(resolve => setTimeout(resolve, 25)); } } as never,
    pool: { acquire: async (_signal: AbortSignal, _preferred: unknown, admit?: () => Promise<void>) => { await new Promise(resolve => setTimeout(resolve, 25)); await admit?.(); return fakeLease(null).lease; } } as never,
    requestTimeoutMs: 10,
    fetchImpl: (async () => jsonOk()) as never,
  });
  assert.equal((await slowFactory(new AbortController().signal)('https://wzyp.cn/a')).status, 200);
});

test('server_error passes through for the adapter to raise', async () => {
  const { factory, leases } = harness([() => new Response('oops', { status: 500 })]);
  const response = await factory(new AbortController().signal)('https://wzyp.cn/x');
  assert.equal(response.status, 500);
  assert.deepEqual(leases[0]!.events, ['success']); // Source failure, not proxy failure.
});

for (const phase of ['connection', 'body']) test(`request timeout cancels a hanging ${phase} without retrying`, { timeout: 1000 }, async () => {
  let requests = 0, cancelled = false;
  const proxy = fakeLease('http://proxy');
  const factory = createRunFetchFactory({
    pool: { acquire: async (_signal: AbortSignal, _preferred: unknown, admit?: () => Promise<void>) => { await admit?.(); return proxy.lease; } } as never,
    limiter: { acquire: async () => {} } as never,
    requestTimeoutMs: 20,
    fetchImpl: (async (_url: unknown, init: RequestInit) => {
      requests++;
      if (phase === 'body') return new Response(new ReadableStream({
        cancel() { cancelled = true; },
      }));
      return new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => {
        cancelled = true;
        reject(init.signal!.reason);
      }, { once: true }));
    }) as never,
  });
  await assert.rejects(factory(new AbortController().signal)('https://wzyp.cn/shopApi/Shop/getGoodsPrice'), /timed out/);
  assert.equal(requests, 1);
  assert.equal(cancelled, true);
  assert.deepEqual(proxy.events, []);
});

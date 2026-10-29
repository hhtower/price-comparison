import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectionProxyOptions } from '../src/platforms/platforms.module.js';
import { ProtocolDetectionService } from '../src/platforms/protocol-detection.service.js';
import { createSharedHostRateLimiter } from '../src/crawler/rate-limiter.js';
import { readCrawlerConfig } from '../src/config/env.js';
import { platforms } from '../src/platforms/index.js';
const publicLookup = async () => [{ address: '8.8.8.8', family: 4 }];

test('public protocol detection rejects private addresses and revalidates DNS before every detail request', async () => {
  let sent = 0;
  const detector = new ProtocolDetectionService({ lookup: publicLookup, fetchImpl: async () => { sent++; return feed(); } });
  for (const host of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '[::1]']) {
    assert.equal((await detector.detect(`https://${host}/`, 'public-products-v1')).status, 'failed');
  }
  assert.equal(sent, 0);
  let resolutions = 0;
  const rebound = new ProtocolDetectionService({ lookup: publicLookup,
    lookup: async () => [{ address: ++resolutions === 1 ? '8.8.8.8' : '192.168.1.1', family: 4 }],
    fetchImpl: async (_input, init) => { sent++; assert.ok((init as any).dispatcher); return feed(); },
  });
  assert.equal((await rebound.detect('https://rebound.example/', 'public-products-v1')).status, 'failed');
  assert.equal(sent, 1);
});

const item = { id: 5, slug: 'pro', title: { 'zh-CN': 'Pro' }, skus: [{ id: 6, is_active: true, spec_values: {}, price_amount: '650.00', stock_status: 'in_stock' }] };
const feed = () => Response.json({ status_code: 0, data: [item], pagination: { page: 1, page_size: 12, total: 1, total_page: 1 } });

test('detects the public protocol by schema on an unfamiliar public domain and returns a preview', async () => {
  let requests = 0;
  const detector = new ProtocolDetectionService({ lookup: publicLookup, fetchImpl: async (input, init) => {
    requests++;
    assert.equal(new URL(String(input)).hostname, 'new-shop.example');
    assert.equal(init?.redirect, 'manual');
    if (String(input).includes('shopApi')) return new Response(null, { status: 404 });
    return String(input).includes('?') ? feed() : Response.json({ status_code: 0, data: item });
  } });
  const result = await detector.detect('https://new-shop.example/');
  assert.equal(result.status, 'matched');
  assert.equal(result.protocol, 'public-products-v1');
  assert.equal(result.products[0]?.price, '650.00');
  assert.ok(requests <= platforms.length + 1);
});

test('distinguishes unsupported APIs, temporary failures, and ambiguous compatible protocols', async () => {
  const unknown = new ProtocolDetectionService({ lookup: publicLookup, fetchImpl: async () => new Response(null, { status: 404 }) });
  assert.equal((await unknown.detect('https://shop.example/')).status, 'unknown');
  const failed = new ProtocolDetectionService({ lookup: publicLookup, fetchImpl: async () => new Response(null, { status: 503 }) });
  assert.equal((await failed.detect('https://shop.example/')).status, 'failed');
  const ambiguous = new ProtocolDetectionService({ lookup: publicLookup, fetchImpl: async input => String(input).includes('shopApi') ? Response.json({ code: 1, data: { list: [] } }) : new Response(null, { status: 404 }) });
  const result = await ambiguous.detect('https://shop.example/shop/abc');
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.protocol, null);
  assert.equal(result.candidates.length, 2);
  assert.equal((await ambiguous.detect('https://shop.example/shop/abc', '16688')).protocol, '16688');
});

test('rejects invalid manual selections and malformed shop URLs before requests', async () => {
  let sent = 0;
  const detector = new ProtocolDetectionService({ lookup: publicLookup, fetchImpl: async () => { sent++; return feed(); } });
  await assert.rejects(detector.detect('https://shop.example', 'invented'), { code: 'INVALID_SHOP_PROTOCOL' });
  await assert.rejects(detector.detect('https://user:password@shop.example/'));
  assert.equal(sent, 0);
});

test('refuses redirect responses', async () => {
  const detector = new ProtocolDetectionService({ lookup: publicLookup, fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }) });
  const result = await detector.detect('https://shop.example/', 'public-products-v1');
  assert.equal(result.status, 'failed');
  assert.equal(result.attempts[0]?.reason, '接口发生重定向，无法验证');
});

test('times out a slow response body and rejects oversized payloads', async () => {
  const slow = new ProtocolDetectionService({ lookup: publicLookup, timeoutMs: 30, fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }), { headers: { 'content-type': 'application/json' } }) });
  const result = await slow.detect('https://shop.example/', 'public-products-v1');
  assert.equal(result.status, 'failed');
  const large = new ProtocolDetectionService({ lookup: publicLookup, maxResponseBytes: 12, fetchImpl: async () => feed() });
  assert.equal((await large.detect('https://shop.example/', 'public-products-v1')).status, 'failed');
});

test('detection options carry the crawler proxy egresses in order', () => {
  assert.deepEqual(detectionProxyOptions({}), {});
  assert.deepEqual(detectionProxyOptions({ CRAWLER_PROXIES: 'http://127.0.0.1:7890' }).egresses, [{ proxyUrl: 'http://127.0.0.1:7890' }]);
  assert.deepEqual(detectionProxyOptions({ CRAWLER_PROXIES: 'http://127.0.0.1:7890,socks5://user:pass@127.0.0.1:1080' }).egresses?.map(egress => egress.proxyUrl),
    ['http://127.0.0.1:7890', 'socks5://user:pass@127.0.0.1:1080']);
  // 自建站出口排在 CRAWLER_PROXIES 之后，作为探测回退；出口侧 DNS 解析（proxyDns）。
  assert.deepEqual(detectionProxyOptions({ CRAWLER_PROXIES: 'http://127.0.0.1:7890', CRAWLER_SELFHOSTED_PROXY_URL: 'http://172.17.0.1:12795' }).egresses,
    [{ proxyUrl: 'http://127.0.0.1:7890' }, { proxyUrl: 'http://172.17.0.1:12795', proxyDns: true }]);
  assert.deepEqual(detectionProxyOptions({ CRAWLER_SELFHOSTED_PROXY_URL: 'http://172.17.0.1:12795' }).egresses, [{ proxyUrl: 'http://172.17.0.1:12795', proxyDns: true }]);
});

test('detection falls through a blocked egress to the next configured egress', async () => {
  let calls = 0;
  const detector = new ProtocolDetectionService({ lookup: publicLookup,
    egresses: [{}, {}],
    fetchImpl: async (input: any) => {
      calls += 1;
      if (calls === 1) return new Response(null, { status: 503 });
      return String(input).includes('?') ? feed() : Response.json({ status_code: 0, data: item });
    },
  });
  const result = await detector.detect('https://shop.example/', 'public-products-v1');
  assert.equal(result.status, 'matched');
  assert.equal(result.protocol, 'public-products-v1');
  assert.ok(calls >= 2, 'the blocked egress must be tried before the working one');
});

test('detection reports failure when every egress is blocked', async () => {
  const detector = new ProtocolDetectionService({ lookup: publicLookup, egresses: [{}, {}], fetchImpl: async () => new Response(null, { status: 503 }) });
  const result = await detector.detect('https://shop.example/', 'public-products-v1');
  assert.equal(result.status, 'failed');
  assert.equal(result.attempts.length, 1);
});

test('Yunmao approval uses a Node proxy dispatcher and browser request headers', async () => {
  const routes: unknown[] = [];
  const detector = new ProtocolDetectionService({ lookup: publicLookup,
    egresses: [{ proxyUrl: 'http://domestic.example:24976' }],
    fetchImpl: async (input, init) => {
      routes.push((init as any)?.dispatcher);
      assert.equal((init as any)?.proxyUrl, undefined);
      const headers = new Headers(init?.headers);
      assert.match(headers.get('visitorid') ?? '', /^[a-f0-9]{24}$/);
      assert.match(headers.get('user-agent') ?? '', /Macintosh.*Chrome\/124/);
      assert.equal(headers.get('accept-language'), 'zh-CN,zh;q=0.9,en;q=0.6');
      const path = new URL(String(input)).pathname;
      return ['/shopApi/Shop/info', '/shopApi/Shop/categoryList'].includes(path)
        ? Response.json({ code: 1, data: path.endsWith('/info') ? {} : [] })
        : path === '/shopApi/Shop/goodsList' ? Response.json({ code: 1, data: { list: [] } }) : new Response(null, { status: 404 });
    },
  });
  assert.equal(await detector.requireMatch('https://catfk.com/shop/abc'), 'liandong');
  assert.ok(routes.length > 0);
  assert.ok(routes.every(route => route != null && route === routes[0]));
});

test('approval rejects trailing-dot shop addresses before they can be persisted for crawling', async () => {
  let sent = 0;
  const detector = new ProtocolDetectionService({ lookup: publicLookup, egresses: [{ proxyUrl: 'socks5://overseas.example:1080' }],
    fetchImpl: async () => { sent++; return Response.json({ code: 1, data: { list: [] } }); } });
  await assert.rejects(detector.requireMatch('https://catfk.com./shop/abc', 'liandong'), { code: 'INVALID_SHOP_URL' });
  assert.equal(sent, 0);
});

test('Yunmao detection does not fall back to direct requests after configured proxy failure', async () => {
  const routes: unknown[] = [];
  const detector = new ProtocolDetectionService({ lookup: publicLookup,
    egresses: [{ proxyUrl: 'http://domestic.example:24976' }],
    fetchImpl: async (_input, init) => { routes.push((init as any)?.dispatcher); return new Response(null, { status: 503 }); },
  });
  assert.equal((await detector.detect('https://catfk.com/shop/abc', 'liandong')).status, 'failed');
  assert.equal(routes.length, 1);
  assert.ok(routes[0]);
});

test('Yunmao approval re-admits a disconnected goods request through the shared domain limit', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let clock = 0;
  const next = new Map<string, number>();
  const starts: number[] = [];
  const redis = { async eval(_script: string, _count: number, key: string, interval: string) {
    const delay = Math.max(0, (next.get(key) ?? 0) - clock);
    if (delay) return delay;
    next.set(key, clock + Number(interval));
    return 0;
  } };
  const limiter = () => createSharedHostRateLimiter(readCrawlerConfig({}).hostMinIntervalMs, redis, async ms => {
    clock += ms;
    context.mock.timers.tick(ms);
  });
  await limiter().acquire('catfk.com'); // Existing crawler request consumed this slot.
  const detector = new ProtocolDetectionService({ lookup: publicLookup, limiter: limiter(), egresses: [{ proxyUrl: 'http://domestic.example:24976' }],
    fetchImpl: async (input, init) => {
      starts.push(clock);
      assert.equal(new URL(String(input)).pathname, '/shopApi/Shop/goodsList');
      assert.ok((init as any)?.dispatcher);
      if (starts.length === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' }) });
      return Response.json({ code: 1, data: { list: [] } });
    },
  });
  assert.equal(await detector.requireMatch('https://catfk.com/shop/abc', 'liandong'), 'liandong');
  assert.deepEqual(starts, [10000, 20000]);
});

test('detects a later acg-faka candidate on an unfamiliar host without exhausting the shared request budget', async () => {
  let requests = 0;
  const product = { id: 17, name: '月卡', status: 1, inventory_hidden: 0, minimum: 0, draft_status: 0,
    config: { category: { 月卡: 5, 年卡: 50 } } };
  const detector = new ProtocolDetectionService({ lookup: publicLookup, fetchImpl: async input => {
    requests++;
    const path = new URL(String(input)).pathname;
    if (path === '/user/api/index/commodity') return Response.json({ code: 200, total: 1, data: [product] });
    if (path === '/user/api/index/commodityDetail') return Response.json({ code: 200, data: product });
    if (path === '/user/api/index/stock') return Response.json({ code: 200, data: { stock: 3, stock_state: 1 } });
    if (path === '/user/api/index/valuation') return Response.json({ code: 200, data: { price: '5.00' } });
    return new Response(null, { status: 404 });
  } });
  const result = await detector.detect('https://unfamiliar.example/');
  assert.equal(result.status, 'matched'); assert.equal(result.protocol, 'acg-faka');
  assert.equal(result.products.length, 2); assert.ok(requests <= platforms.length * 6);
});

test('protocol detection allows HTML only for HTML adapters and binds detail-backed classic Dujiaoka', async () => {
  const detector = new ProtocolDetectionService({ lookup: publicLookup, fetchImpl: async input => {
    const root = '<html><link href="/assets/unicorn/css/index.css"><div id="goodsTabContent"><div id="group-all"><a href="/buy/252">月卡</a></div><div id="group-1"><a href="/buy/252">月卡</a></div></div></html>';
    const detail = '<html><h3 class="card-title">月卡</h3><input name="gid" value="252"><h6 id="display_price">价格：￥ 130.00</h6><small id="stock_tips">库存：3</small></html>';
    return new Response(new URL(String(input)).pathname === '/' ? root : detail, { headers: { 'content-type': 'text/html' } });
  } });
  const result = await detector.detect('https://ouvg.top/', 'dujiaoka');
  assert.equal(result.status, 'matched'); assert.equal(result.protocol, 'dujiaoka');
  assert.equal(result.products[0]?.price, '130.00');
  assert.equal((await detector.detect('https://ouvg.top/', 'public-products-v1')).status, 'unknown');
});

test('Yunmao approval recovers once from a Node socket disconnect', async () => {
  let sent = 0;
  const detector = new ProtocolDetectionService({ lookup: publicLookup, fetchImpl: async () => {
    if (++sent === 1) throw Object.assign(new Error('receive failed'), { code: 'ECONNRESET' });
    return Response.json({ code: 1, data: { list: [
      { goods_key: 'G1', name: 'Product A', price: 12, link: 'https://catfk.com/item/G1' },
    ] } });
  } });
  const result = await detector.detect('https://catfk.com/shop/abc', 'liandong');
  assert.equal(result.status, 'matched');
  assert.equal(result.products[0]?.externalId, 'G1');
  assert.equal(sent, 2);
});

test('Yunmao approval bounds retries and reports transport failures without provider messages', async () => {
  let sent = 0;
  const detector = new ProtocolDetectionService({ lookup: publicLookup, fetchImpl: async () => {
    sent++;
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('http://user:secret@proxy.example:24976'), { code: 'UND_ERR_SOCKET' }) });
  } });
  const result = await detector.detect('https://catfk.com/shop/abc');
  assert.equal(result.status, 'failed');
  assert.equal(sent, platforms.length * 2);
  assert.ok(result.attempts.every(attempt => attempt.reason === '接口连接失败，请检查代理出口或稍后重试'));
});

test('Yunmao approval does not retry HTTP, schema, or certificate failures', async () => {
  for (const [send, reason] of [
    [() => new Response(null, { status: 403 }), '接口请求失败'],
    [() => new Response(null, { status: 429 }), '接口请求失败'],
    [() => Response.json({ code: 0, data: {} }), '接口返回内容不符合协议'],
    [() => new Response('{', { headers: { 'content-type': 'application/json' } }), '接口返回内容不符合协议'],
    [() => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('certificate failed'), { code: 'CERT_HAS_EXPIRED' }) }); }, '接口连接失败，请检查代理出口或稍后重试'],
  ] as const) {
    let sent = 0;
    const detector = new ProtocolDetectionService({ lookup: publicLookup, fetchImpl: async () => { sent++; return send(); } });
    const result = await detector.detect('https://catfk.com/shop/abc', 'liandong');
    assert.equal(result.status, 'failed');
    assert.equal(result.attempts[0]?.reason, reason);
    assert.equal(sent, 1);
  }
});

test('Yunmao transport retry cannot outlive the overall detection deadline', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'], now: 0 });
  let slots = 0, sent = 0;
  const limiter = createSharedHostRateLimiter(new Map(), { eval: async () => ++slots === 1 ? 0 : 1000 }, async ms => { context.mock.timers.tick(ms); });
  const detector = new ProtocolDetectionService({ lookup: publicLookup, timeoutMs: 30, limiter, fetchImpl: async () => {
    sent++;
    throw Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' });
  } });
  const result = await detector.detect('https://catfk.com/shop/abc', 'liandong');
  assert.equal(result.attempts[0]?.reason, '接口请求超时，请稍后重试');
  assert.equal(sent, 1);
});

test('cancelling Yunmao approval while waiting to retry prevents the second request', async () => {
  const controller = new AbortController(), reason = new Error('cancel retry');
  let slots = 0, sent = 0;
  const limiter = createSharedHostRateLimiter(new Map(), { eval: async () => ++slots === 1 ? 0 : 1000 }, async () => {
    controller.abort(reason);
    throw reason;
  });
  const detector = new ProtocolDetectionService({ lookup: publicLookup, limiter, fetchImpl: async () => {
    sent++;
    throw Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' });
  } });
  await assert.rejects(detector.detect('https://catfk.com/shop/abc', 'liandong', controller.signal), error => error === reason);
  assert.equal(sent, 1);
});

test('protocol detection retains its overall deadline while waiting for a busy domain', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'], now: 0 });
  const limiter = createSharedHostRateLimiter(new Map(), { eval: async () => 1000 }, async ms => { context.mock.timers.tick(ms); });
  let sent = 0;
  const detector = new ProtocolDetectionService({ lookup: publicLookup, limiter, fetchImpl: async () => { sent++; return feed(); } });
  const result = await detector.detect('https://shop.example/', 'public-products-v1');
  assert.equal(result.status, 'failed');
  assert.equal(result.attempts[0]?.reason, '接口请求超时，请稍后重试');
  assert.equal(sent, 0);
});

test('cancelling detection during domain admission prevents sending a request', async () => {
  const controller = new AbortController();
  const reason = new Error('cancel admission');
  const limiter = createSharedHostRateLimiter(new Map(), { eval: async () => 1000 }, async () => {
    controller.abort(reason);
    throw reason;
  });
  let sent = 0;
  const detector = new ProtocolDetectionService({ lookup: publicLookup, limiter, fetchImpl: async () => { sent++; return feed(); } });
  await assert.rejects(detector.detect('https://shop.example/', 'public-products-v1', controller.signal), error => error === reason);
  assert.equal(sent, 0);
});

import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test, { type TestContext } from 'node:test';
import { HttpException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { CatalogService } from '../src/catalog/catalog.service.js';
import type { CatalogQuery } from '../src/catalog/catalog.repository.js';
import { McpAccess } from '../src/mcp/mcp-access.js';
import { registerMcpEndpoint } from '../src/mcp/mcp-server.js';

const { McpServer } = createRequire(import.meta.url)('@modelcontextprotocol/server') as typeof import('@modelcontextprotocol/server');

const product = { id: '1', name: 'Example monthly plan', platform: 'Example', kind: 'subscription',
  platformGroup: 'internal-group', identityNames: ['private-alias'] };
const offer = { shopId: '10', productId: '11', name: 'Monthly plan', shop: 'Example shop',
  price: '19.90', listedPrice: '9.95', settlementQuantity: 2, currency: 'CNY',
  priceStatus: 'verified', priceVerifiedAt: '2026-11-04T00:00:00.000Z', priceExpiresAt: '2026-11-05T00:00:00.000Z',
  inventoryExpiresAt: '2026-11-05T00:00:00.000Z', paymentMethod: 'card',
  productUrl: 'https://shop.example/products/11', spec: '30 days', tags: [{ name: 'duration', value: '30 days' }],
  capturedAt: '2026-11-04T00:00:00.000Z', stale: false, inStock: true };
const point = { date: '2026-11-04', price: '19.90', verifiedAt: offer.priceVerifiedAt, productId: '11',
  shop: offer.shop, name: offer.name, spec: offer.spec, quantity: 2, contentVersion: '3', paymentMethod: 'card' };
const history = { currency: 'CNY', days: 30 as const, startDate: '2026-10-06', endDate: '2026-11-04', points: [point] };
const headers = { authorization: 'Bearer valid-key', accept: 'application/json, text/event-stream' };
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } } };

async function harness(t: TestContext, siteUrl: string | null = 'https://prices.example') {
  const previous = process.env.PUBLIC_SITE_URL;
  if (siteUrl === null) delete process.env.PUBLIC_SITE_URL;
  else process.env.PUBLIC_SITE_URL = siteUrl;
  t.after(() => { if (previous === undefined) delete process.env.PUBLIC_SITE_URL; else process.env.PUBLIC_SITE_URL = previous; });
  const queries: CatalogQuery[] = [];
  const historyQueries: unknown[][] = [];
  let failure: Error | undefined;
  let oversizedOutput = false;
  let limitStatus: number | undefined;
  let admitted = 0;
  const repository = {
    publicProducts: () => assert.fail('MCP must use paginated catalog queries'),
    publicProduct: async (id: string) => id === '1' ? product : null,
    search: async (query: CatalogQuery) => {
      if (failure) throw failure;
      queries.push(query);
      return { items: [{ ...product, ...(oversizedOutput ? { name: 'x'.repeat(140_000) } : {}),
        standardProductId: '1', shopCount: 60, productCount: 61,
        offers: [{ ...offer, name: 'preview-only' }], minPrice: '19.90', latestCapturedAt: offer.capturedAt,
        ...(query.detailKind ? { detail: { kind: 'offers', page: query.detailPage, pageSize: query.detailPageSize,
          total: 61, entries: [{ ...offer, name: `Full offer page ${query.detailPage}` }] } } : {}) }],
        total: 1, platformFacets: ['Example'], nextCursor: 'next-page', nextExpiryAt: offer.priceExpiresAt };
    },
    priceHistory: async (...args: unknown[]) => { historyQueries.push(args); if (failure) throw failure; return history; },
  };
  const catalog = new CatalogService(repository as never, { wrap: (_key: string, loader: () => unknown) => loader() } as never);
  const access = {
    beforeApplicationShutdown: async () => {},
    authenticate: async (authorization?: string) => {
      if (authorization !== 'Bearer valid-key') throw new UnauthorizedException('private credential diagnostics');
      return { id: 'key-id', requestsPerMinute: 7 };
    },
    admitKey: async (id: string, requestsPerMinute: number, reply?: { header(name: string, value: string): unknown }) => {
      assert.equal(id, 'key-id'); assert.equal(requestsPerMinute, 7);
      admitted++;
      if (limitStatus === 429) reply?.header('Retry-After', '60');
      if (limitStatus) throw new HttpException('redis://private-internals', limitStatus);
    },
  };
  const module = await Test.createTestingModule({ providers: [
    { provide: CatalogService, useValue: catalog }, { provide: McpAccess, useValue: access },
  ] }).compile();
  const logs: string[] = [];
  const app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter({
    logger: { stream: { write: (line: string) => { logs.push(line); } } },
  }));
  registerMcpEndpoint(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  t.after(() => app.close());
  const http = app.getHttpAdapter().getInstance();
  const rpc = (method: string, args?: unknown) => http.inject({ method: 'POST', url: '/v1/mcp', headers,
    payload: { jsonrpc: '2.0', id: 2, method, ...(args === undefined ? {} : { params: args }) } });
  const call = async (name: string, args: unknown = {}) => {
    const response = await rpc('tools/call', { name, arguments: args });
    assert.equal(response.statusCode, 200);
    return response;
  };
  return { app, http, catalog, logs, rpc, call, queries, historyQueries, admissions: () => admitted,
    oversize: () => { oversizedOutput = true; },
    fail: (error: Error) => { failure = error; }, limit: (status?: number) => { limitStatus = status; } };
}

test('stateless HTTP initializes and lists only the three read-only tools', async t => {
  const { http, rpc, admissions } = await harness(t);
  const response = await http.inject({ method: 'POST', url: '/v1/mcp', headers, payload: initialize });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().result.protocolVersion, '2025-11-25');
  assert.equal(response.headers['mcp-session-id'], undefined);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['set-cookie'], undefined);
  const listed = await rpc('tools/list');
  assert.equal(listed.statusCode, 200);
  const tools = listed.json().result.tools;
  assert.deepEqual(tools.map((tool: { name: string }) => tool.name).sort(),
    ['get_price_history', 'get_product_offers', 'search_products']);
  for (const tool of tools) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.match(tool.description, /currency/i);
    assert.match(tool.description, /duration/i);
    assert.match(tool.description, /snapshot/i);
  }
  const notified = await http.inject({ method: 'POST', url: '/v1/mcp', headers,
    payload: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  assert.equal(notified.statusCode, 202);
  assert.equal(admissions(), 3);
});

test('all protocol requests require an application key and fail closed on limiter errors', async t => {
  const { http, limit, logs } = await harness(t);
  for (const authorization of [undefined, 'Bearer bad-key', 'Bearer expired-key']) {
    for (const method of ['initialize', 'tools/list', 'tools/call']) {
      const response = await http.inject({ method: 'POST', url: '/v1/mcp',
        headers: { accept: headers.accept, ...(authorization ? { authorization } : {}), cookie: 'admin_session=valid-key' },
        payload: { ...initialize, method } });
      assert.equal(response.statusCode, 401);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['set-cookie'], undefined);
      assert.ok(!response.body.includes('private credential'));
    }
  }
  for (const status of [429, 503]) {
    limit(status);
    const response = await http.inject({ method: 'POST', url: '/v1/mcp', headers, payload: initialize });
    assert.equal(response.statusCode, status);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.ok(!response.body.includes('private-internals'));
    if (status === 429) assert.equal(response.headers['retry-after'], '60');
  }
  assert.ok(!logs.join('').includes('valid-key'));
  assert.ok(!logs.join('').includes('bad-key'));
  assert.ok(!logs.join('').includes('admin_session'));
});

test('browser origins must exactly match the configured HTTPS origin', async t => {
  const { http } = await harness(t);
  for (const origin of ['https://evil.example', 'https://prices.example.evil', 'http://prices.example',
    'https://prices.example:444', 'https://prices.example/path', 'null', 'invalid', 'https://user@prices.example']) {
    const response = await http.inject({ method: 'POST', url: '/v1/mcp', headers: { ...headers, origin }, payload: initialize });
    assert.equal(response.statusCode, 403, origin);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.ok(!response.json().error.message.includes(origin));
  }
  assert.equal((await http.inject({ method: 'POST', url: '/v1/mcp',
    headers: { ...headers, origin: 'https://prices.example' }, payload: initialize })).statusCode, 200);
});

test('missing or invalid site configuration denies browser origins while allowing external clients', async t => {
  for (const siteUrl of [null, 'invalid', 'http://prices.example', 'https://prices.example/path', 'https://user@prices.example']) {
    await t.test(String(siteUrl), async child => {
      const { http } = await harness(child, siteUrl);
      const browser = await http.inject({ method: 'POST', url: '/v1/mcp',
        headers: { ...headers, origin: 'https://prices.example' }, payload: initialize });
      assert.equal(browser.statusCode, 403);
      const external = await http.inject({ method: 'POST', url: '/v1/mcp', headers, payload: initialize });
      assert.equal(external.statusCode, 200);
    });
  }
});

test('search uses bounded cursor pagination and excludes internal product identity metadata', async t => {
  const { call, queries } = await harness(t);
  const response = await call('search_products', { q: 'monthly', cursor: 'previous', limit: 2 });
  assert.equal(response.statusCode, 200);
  const result = response.json().result;
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.nextCursor, 'next-page');
  assert.equal(result.structuredContent.total, 1);
  assert.equal(result.structuredContent.items[0].standardProductId, '1');
  assert.equal(result.structuredContent.items[0].latestCapturedAt, offer.capturedAt);
  assert.ok(!response.body.includes('private-alias'));
  assert.ok(!response.body.includes('internal-group'));
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.equal(queries[0].search, 'monthly');
  assert.equal(queries[0].cursor, 'previous');
  assert.equal(queries[0].limit, 2);
});

test('offers use public product visibility and full detail pagination with quote filters', async t => {
  const { call, queries } = await harness(t);
  const args = { standardProductId: '1', detailPage: 1, pageSize: 50, currency: 'CNY', priceMin: '10.00',
    priceMax: '99.99', tags: [{ name: 'duration', value: '30 days' }], warrantyDaysMin: 7, offerSort: 'updated' };
  const response = await call('get_product_offers', args);
  assert.equal(response.statusCode, 200);
  const result = response.json().result;
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent.product, { id: '1', name: product.name, platform: 'Example', kind: 'subscription' });
  assert.deepEqual(result.structuredContent.offers, [{ ...offer, name: 'Full offer page 1' }]);
  assert.equal(result.structuredContent.page, 1);
  assert.equal(result.structuredContent.pageSize, 50);
  assert.equal(result.structuredContent.total, 61);
  assert.equal(result.structuredContent.nextPage, null);
  assert.ok(!response.body.includes('preview-only'));
  assert.ok(!response.body.includes('private-alias'));
  assert.equal(queries[0].detailKind, 'offers');
  assert.equal(queries[0].detailPage, 1);
  assert.equal(queries[0].detailPageSize, 50);
  assert.equal(queries[0].standardProductId, '1');
  assert.equal(queries[0].currency, 'CNY');
  assert.equal(queries[0].priceMin, '10.00');
  assert.equal(queries[0].priceMax, '99.99');
  assert.deepEqual(queries[0].tags, [{ name: 'duration', value: '30 days' }]);
  assert.equal(queries[0].warrantyDaysMin, 7);
  assert.equal(queries[0].offerSort, 'updated');
  const hidden = await call('get_product_offers', { standardProductId: '999' });
  assert.equal(hidden.json().result.isError, true);
  assert.equal(queries.length, 1, 'unavailable products must not query offers');
});

test('price history keeps decimal prices, capture times and purchase quantities', async t => {
  const { call, historyQueries } = await harness(t);
  const response = await call('get_price_history', { standardProductId: '1', productId: '11', currency: 'CNY' });
  const result = response.json().result;
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.currency, 'CNY');
  assert.deepEqual(result.structuredContent.points, [point]);
  assert.deepEqual(historyQueries, [['1', '11', 'CNY']]);
  assert.equal((await call('get_price_history', { standardProductId: '999' })).json().result.isError, true);
});

test('invalid or excessive arguments never reach catalog queries', async t => {
  const { call, queries, historyQueries } = await harness(t);
  for (const [name, args] of [
    ['search_products', { limit: 51 }], ['search_products', { q: 'x'.repeat(501) }],
    ['search_products', { cursor: 'x'.repeat(2049) }], ['search_products', { unexpected: true }],
    ['get_product_offers', { standardProductId: '0' }],
    ['get_product_offers', { standardProductId: '9223372036854775808' }],
    ['get_product_offers', { standardProductId: '1', pageSize: 51 }],
    ['get_product_offers', { standardProductId: '1', detailPage: -1 }],
    ['get_product_offers', { standardProductId: '1', detailPage: 1001 }],
    ['get_product_offers', { standardProductId: '1', priceMin: 1.99 }],
    ['get_product_offers', { standardProductId: '1', priceMin: '99.00', priceMax: '1.00' }],
    ['get_product_offers', { standardProductId: '1', currency: 'cny' }],
    ['get_product_offers', { standardProductId: '1', tags: Array(51).fill({ name: 'a', value: 'b' }) }],
    ['get_product_offers', { standardProductId: '1', warrantyDaysMin: 0 }],
    ['get_price_history', { standardProductId: '1', productId: '1;drop table' }],
    ['get_price_history', { standardProductId: '1', currency: 'usd' }],
  ] as const) {
    const response = await call(name, args);
    assert.ok(response.json().result?.isError || response.json().error, `${name}: ${JSON.stringify(args)}`);
  }
  assert.equal(queries.length, 0);
  assert.equal(historyQueries.length, 0);
});

test('tool failures return safe errors without database details', async t => {
  const { call, fail } = await harness(t);
  fail(new ServiceUnavailableException('select secret from credentials; postgres://password'));
  for (const [name, args] of [
    ['search_products', {}], ['get_product_offers', { standardProductId: '1' }],
    ['get_price_history', { standardProductId: '1' }],
  ] as const) {
    const response = await call(name, args);
    assert.equal(response.json().result.isError, true);
    assert.ok(!response.body.includes('postgres'));
    assert.ok(!response.body.includes('select secret'));
  }
});

test('oversized results return a bounded error instead of silently truncating quotes', async t => {
  const { call, oversize } = await harness(t);
  oversize();
  const response = await call('search_products');
  assert.equal(response.json().result.isError, true);
  assert.ok(response.body.length < 1000);
  assert.match(response.json().result.content[0].text, /too large/i);
});

test('malformed HTTP and unsupported methods are bounded, authenticated and non-cacheable', async t => {
  const { http } = await harness(t);
  for (const method of ['GET', 'DELETE', 'OPTIONS', 'HEAD'] as const) {
    assert.equal((await http.inject({ method, url: '/v1/mcp' })).statusCode, 401);
    const response = await http.inject({ method, url: '/v1/mcp', headers });
    assert.equal(response.statusCode, 405);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  for (const payload of ['{"secret":"do-not-echo",', JSON.stringify({ jsonrpc: 'wrong', id: 1, method: 'tools/list' }),
    JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }])]) {
    const response = await http.inject({ method: 'POST', url: '/v1/mcp',
      headers: { ...headers, 'content-type': 'application/json' }, payload });
    assert.equal(response.statusCode, 400);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.ok(!response.body.includes('do-not-echo'));
  }
  const oversized = await http.inject({ method: 'POST', url: '/v1/mcp', headers,
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', padding: 'x'.repeat(70_000) } });
  assert.equal(oversized.statusCode, 413);
  assert.equal(oversized.headers['cache-control'], 'no-store');
});

test('completed stateless requests release their server and are not retained for shutdown', async t => {
  const close = t.mock.method(McpServer.prototype, 'close');
  const { app, rpc } = await harness(t);
  for (let index = 0; index < 5; index++) {
    assert.equal((await rpc('tools/list')).statusCode, 200);
  }
  assert.equal(close.mock.callCount(), 5);
  await app.close();
  assert.equal(close.mock.callCount(), 5);
});

test('shutdown closes an in-flight HTTP connection and its protocol server', { timeout: 5000 }, async t => {
  const { app, catalog } = await harness(t);
  const close = t.mock.method(McpServer.prototype, 'close');
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(catalog, 'getCatalog', async () => {
    entered();
    await pending;
    return { items: [], total: 0, platformFacets: [] };
  });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  assert.ok(address && typeof address === 'object');
  const response = fetch(`http://127.0.0.1:${address.port}/v1/mcp`, { method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_products', arguments: {} } }),
  }).catch(error => error);
  try {
    await started;
    await app.close();
    assert.ok(await response instanceof Error);
    assert.ok(close.mock.callCount() >= 1);
  } finally { release(); }
});

test('shutdown performs a final mail drain after the initial lifecycle snapshot', { timeout: 5000 }, async t => {
  const { app } = await harness(t);
  const access = app.get(McpAccess);
  let releaseMail!: () => void;
  let drainEntered!: () => void;
  const mailGate = new Promise<void>(resolve => { releaseMail = resolve; });
  const finalDrain = new Promise<void>(resolve => { drainEntered = resolve; });
  let queued = false;
  Object.assign(access, {
    beforeApplicationShutdown: async () => {
      if (!queued) queueMicrotask(() => { queued = true; });
      else { drainEntered(); await mailGate; }
    },
  });
  const closing = app.close();
  try {
    const drainedBeforeShutdown = await Promise.race([finalDrain.then(() => true), closing.then(() => false)]);
    assert.equal(drainedBeforeShutdown, true, 'the final drain must precede database shutdown');
  } finally {
    releaseMail();
    await closing;
  }
});

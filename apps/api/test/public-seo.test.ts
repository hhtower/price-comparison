import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { JSDOM } from 'jsdom';
import { registerPublicPages } from '../src/seo/public-pages.js';
import type { CatalogPage } from '../src/catalog/catalog.repository.js';

const page: CatalogPage = { total: 1, platformFacets: ['openai'], items: [{
  id: '42', standardProductId: '42', name: 'ChatGPT Plus', platform: 'openai',
  shopCount: 1, productCount: 1, minPrice: '12.50', latestCapturedAt: '2026-09-27T00:00:00Z',
  offers: [{ shopId: '7', productId: '9', name: 'Plus 月付', shop: '示例商铺', price: '12.50', settlementQuantity: 1, independentShop: true,
    currency: 'CNY', priceStatus: 'verified', priceExpiresAt: '2099-01-01T00:00:00Z', productUrl: 'https://shop.example/product/9', spec: '一个月', tags: [],
    capturedAt: '2026-09-27T00:00:00Z', stale: false, inStock: true }],
}] };
const template = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
function setup(t: { after: (fn: () => Promise<void>) => void }, overrides = {}) {
  const adapter = new FastifyAdapter();
  const server = adapter.getInstance();
  server.get('/metrics', async () => 'metrics');
  registerPublicPages(adapter, { template, siteUrl: 'https://price.yufu.pub/', getCatalog: async () => page,
    getProducts: async () => ({ items: [{ id: '42', name: 'ChatGPT Plus', platform: 'openai', kind: '账号与订阅' }] }),
    getProduct: async (id: string) => id === '42' ? { id, name: 'ChatGPT Plus', platform: 'openai', kind: '账号与订阅' } : null,
    ...overrides });
  server.get('/v1/example', async () => ({ ok: true }));
  t.after(() => server.close());
  return server;
}

test('robots allows public crawling and advertises the canonical sitemap', async t => {
  const response = await setup(t).inject('/robots.txt');
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type']!, /text\/plain/);
  assert.match(response.body, /User-agent: \*/);
  assert.match(response.body, /Allow: \/\n/);
  for (const path of ['/api/', '/v1/', '/metrics', '/ready', '/health']) assert.ok(response.body.includes('Disallow: ' + path));
  assert.match(response.body, /Sitemap: https:\/\/price\.yufu\.pub\/sitemap\.xml/);
  assert.doesNotMatch(response.body, /Disallow: \/\s*$/m);
});

test('sitemap lists only public canonical pages without invented modification dates', async t => {
  const response = await setup(t).inject('/sitemap.xml');
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type']!, /application\/xml/);
  const document = new JSDOM(response.body, { contentType: 'application/xml' }).window.document;
  assert.deepEqual([...document.querySelectorAll('loc')].map(node => node.textContent), ['https://price.yufu.pub/', 'https://price.yufu.pub/tools', 'https://price.yufu.pub/guide', 'https://price.yufu.pub/products/42']);
  assert.equal(document.querySelectorAll('lastmod').length, 0);
});

test('home exposes real quotes, source links and timestamps before JavaScript executes', async t => {
  const response = await setup(t).inject('/');
  assert.equal(response.statusCode, 200);
  const document = new JSDOM(response.body).window.document;
  assert.match(document.querySelector('h1')!.textContent!, /商品|比价|价格/);
  for (const text of ['ChatGPT Plus', '示例商铺（自建站）', '12.50', 'CNY', '一个月']) assert.ok(document.querySelector('#root')!.textContent!.includes(text));
  assert.ok(document.querySelector('a[href="https://shop.example/product/9"]'));
  assert.ok(document.querySelector('a[href="/tools"]'));
  assert.equal(document.querySelectorAll('a[href="/guide"]').length, 1);
  assert.match(document.querySelector('.purchase-guide-brief')!.textContent!, /第一次购买？.*查看选购说明/);
  assert.equal(document.querySelector('.purchase-guide-brief ol'), null);
  assert.equal(document.querySelector('time')!.getAttribute('datetime'), '2026-09-27T00:00:00.000Z');
  assert.ok(document.querySelector('script[type="module"]'));
  const data = JSON.parse(document.querySelector('script[type="application/ld+json"]')!.textContent!);
  assert.equal(data['@context'], 'https://schema.org');
  assert.ok(data['@graph'].some((entry: Record<string, unknown>) => entry['@type'] === 'WebSite'));
  assert.doesNotMatch(JSON.stringify(data), /AggregateOffer|aggregateRating|priceValidUntil/);
});

test('canonical metadata uses configured origin and ignores tracking and forged host headers', async t => {
  const response = await setup(t).inject({ url: '/?utm_source=test', headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' } });
  const document = new JSDOM(response.body).window.document;
  assert.equal(document.querySelector('link[rel="canonical"]')!.getAttribute('href'), 'https://price.yufu.pub/');
  assert.equal(document.querySelector('meta[property="og:url"]')!.getAttribute('content'), 'https://price.yufu.pub/');
  assert.equal(document.querySelectorAll('meta[name="description"]').length, 1);
  assert.equal(document.querySelectorAll('title').length, 1);
  assert.doesNotMatch(response.body, /evil\.example|utm_source/);
});

test('tools serves distinct readable metadata without a catalog dependency', async t => {
  const response = await setup(t, { getCatalog: async () => { throw new Error('must not query'); } }).inject('/tools');
  assert.equal(response.statusCode, 200);
  const document = new JSDOM(response.body).window.document;
  assert.match(document.title, /AI.*IP/);
  assert.match(document.querySelector('#root')!.textContent!, /AI.*IP/s);
  assert.equal(document.querySelector('link[rel="canonical"]')!.getAttribute('href'), 'https://price.yufu.pub/tools');
});

test('admin and API responses opt out of indexing', async t => {
  const server = setup(t);
  for (const path of ['/admin', '/v1/example', '/metrics']) {
    const response = await server.inject(path);
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers['x-robots-tag']), /noindex/);
    if (path === '/admin') {
      const document = new JSDOM(response.body).window.document;
      assert.match(document.querySelector('meta[name="robots"]')!.getAttribute('content')!, /noindex/);
      assert.equal(document.querySelector('script[type="application/ld+json"]'), null);
    }
  }
});

test('trailing slashes redirect and unknown URLs retain real 404 status', async t => {
  const server = setup(t);
  for (const path of ['/tools/', '/admin/']) {
    const response = await server.inject(path + '?utm_source=test');
    assert.equal(response.statusCode, 308);
    assert.equal(response.headers.location, path.slice(0, -1) + '?utm_source=test');
  }
  assert.equal((await server.inject('/missing-page')).statusCode, 404);
});

test('catalog failure returns retryable 503 instead of an indexable empty success', async t => {
  const response = await setup(t, { getCatalog: async () => { throw new Error('private database credentials'); } }).inject('/');
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['retry-after'], '60');
  assert.match(String(response.headers['x-robots-tag']), /noindex/);
  assert.doesNotMatch(response.body, /private database credentials/);
  assert.match(response.body, /type="module"/);
});

test('merchant text is escaped and unsafe purchase URLs are not links', async t => {
  const unsafe: CatalogPage = { ...page, items: [{ ...page.items[0]!, name: '</h2><script>alert(1)</script>',
    offers: [{ ...page.items[0]!.offers[0]!, name: '<img src=x onerror=alert(1)>', productUrl: 'javascript:alert(1)', shop: 'A & B' }] }] };
  const response = await setup(t, { getCatalog: async () => unsafe }).inject('/');
  const document = new JSDOM(response.body).window.document;
  assert.equal(document.querySelectorAll('#root script, #root img, #root [onerror]').length, 0);
  assert.equal(document.querySelector('a[href^="javascript:"]'), null);
  assert.match(document.querySelector('#root')!.textContent!, /A & B/);
  assert.match(document.querySelector('h2')!.textContent!, /<script>/);
});

test('site URL rejects credentials and non-origins and supports a custom HTTPS origin', async t => {
  for (const siteUrl of ['javascript:alert(1)', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?x=1', 'https://example.com/#hash']) {
    const adapter = new FastifyAdapter();
    assert.throws(() => registerPublicPages(adapter, { template, siteUrl, getCatalog: async () => page, getProducts: async () => ({ items: [] }), getProduct: async () => null }), /PUBLIC_SITE_URL/);
    await adapter.getInstance().close();
  }
  const response = await setup(t, { siteUrl: 'https://comparison.example/' }).inject('/sitemap.xml');
  assert.match(response.body, /https:\/\/comparison\.example\/tools/);
  assert.doesNotMatch(response.body, /price\.yufu\.pub/);
});

test('search crawlers receive the same public content as ordinary visitors', async t => {
  const server = setup(t);
  const ordinary = await server.inject('/');
  for (const agent of ['Googlebot', 'bingbot', 'Baiduspider', 'OAI-SearchBot', 'PerplexityBot']) {
    const response = await server.inject({ url: '/', headers: { 'user-agent': agent } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, ordinary.body);
  }
});

test('product HTML has canonical metadata, paginated real quotes and verified structured offers', async t => {
  let query: unknown;
  const response = await setup(t, { getCatalog: async (input: unknown) => { query = input; return { ...page, items: [{ ...page.items[0]!, offers: [{ ...page.items[0]!.offers[0]!, priceStatus: 'verified' }] }] }; } }).inject('/products/42?utm_source=test');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(query, { standardProductId: '42', detailKind: 'offers', detailPage: 0, detailPageSize: 20, currency: 'CNY', offerSort: 'price' });
  const document = new JSDOM(response.body).window.document;
  assert.match(document.title, /ChatGPT Plus/);
  assert.equal(document.querySelector('h1')?.textContent, 'ChatGPT Plus');
  for (const selector of ['link[rel="canonical"]', 'meta[property="og:url"]']) assert.equal(document.querySelector(selector)?.getAttribute(selector.startsWith('link') ? 'href' : 'content'), 'https://price.yufu.pub/products/42');
  assert.match(document.querySelector('#root')!.textContent!, /12.50.*CNY/s);
  const schema = JSON.parse(document.querySelector('#page-structured-data')!.textContent!);
  assert.equal(schema['@type'], 'Product');
  assert.equal(schema.offers[0].price, '12.50');
});

for (const path of ['/', '/products/42']) test(`SSR shows the exact unit price and database minimum quantity on ${path}`, async t => {
  const offer = { ...page.items[0]!.offers[0]!, price: '0.002', settlementQuantity: 5,
    tags: [{ name: 'minimum_quantity', value: '10' }, { name: 'minimum_quantity', value: '5' }] };
  const response = await setup(t, { getCatalog: async () => ({ ...page, items: [{ ...page.items[0]!,
    offers: [offer], detail: { kind: 'offers', entries: [offer], total: 1, page: 0, pageSize: 20 } }] }) }).inject(path);
  assert.equal(response.statusCode, 200);
  const document = new JSDOM(response.body).window.document;
  const content = document.querySelector('#root')!.textContent!;
  assert.match(content, /0\.002 CNY/);
  assert.equal(content.match(/5件起购/gu)?.length, 1);
  assert.doesNotMatch(content, /10件起购|1件起购|0\.01 CNY/);
});

test('multi-unit quotes keep Product metadata but never emit bare unit-price structured Offers', async t => {
  const single = page.items[0]!.offers[0]!;
  const multi = { ...single, productId: '10', price: '0.333333333333', settlementQuantity: 3 };
  for (const offers of [[multi], [multi, single], [multi, { ...single, settlementQuantity: undefined }]]) {
    const response = await setup(t, { getCatalog: async () => ({ ...page, items: [{ ...page.items[0]!, offers }] }) }).inject('/products/42');
    assert.equal(response.statusCode, 200);
    const document = new JSDOM(response.body).window.document;
    const schema = JSON.parse(document.querySelector('#page-structured-data')!.textContent!);
    assert.equal(schema['@type'], 'Product');
    assert.equal(schema.name, 'ChatGPT Plus');
    assert.deepEqual(schema.offers?.map((offer: { price: string }) => offer.price), offers.length === 1 ? undefined : ['12.50']);
    assert.match(document.querySelector('#root')!.textContent!, /0\.333333333333 CNY/);
    assert.doesNotMatch(document.querySelector('#root')!.textContent!, /1件起购|1\.00 CNY/);
  }
});

for (const status of ['expired', 'estimated'] as const) for (const path of ['/', '/products/42']) test(`${status} quotes render as estimates on ${path} without structured Offers`, async t => {
  const offer = { ...page.items[0]!.offers[0]!, priceStatus: status };
  const response = await setup(t, { getCatalog: async () => ({ ...page, items: [{ ...page.items[0]!, offers: [offer] }] }) }).inject(path);
  const document = new JSDOM(response.body).window.document;
  assert.match(document.querySelector('#root')!.textContent!, /12\.50 CNY.*预估/);
  if (path !== '/') assert.equal(JSON.parse(document.querySelector('#page-structured-data')!.textContent!).offers, undefined);
});

test('public product without a valid price keeps its page and never emits a false offer', async t => {
  const response = await setup(t, { getCatalog: async () => ({ ...page, items: [{ ...page.items[0]!, minPrice: null, offers: [{ ...page.items[0]!.offers[0]!, price: null, listedPrice: '9.00', priceStatus: 'expired' }] }] }) }).inject('/products/42');
  assert.equal(response.statusCode, 200);
  const document = new JSDOM(response.body).window.document;
  assert.match(document.querySelector('#root')!.textContent!, /—/);
  assert.doesNotMatch(document.querySelector('#root')!.textContent!, /标价|9\.00|待更新|待核验/);
  assert.equal(JSON.parse(document.querySelector('#page-structured-data')!.textContent!).offers, undefined);
  const empty = await setup(t, { getCatalog: async () => ({ items: [], total: 0, platformFacets: [] }) }).inject('/products/42');
  assert.equal(empty.statusCode, 200);
  assert.match(empty.body, /暂无可用报价/);
});

test('product pages distinguish missing, merged and unavailable products; sitemap failure is retryable', async t => {
  assert.equal((await setup(t).inject('/products/404')).statusCode, 404);
  const merged = await setup(t, { getProduct: async () => ({ id: '41', name: 'old', platform: 'openai', kind: '其他', mergedIntoId: '42' }) }).inject('/products/41');
  assert.equal(merged.statusCode, 308);
  assert.equal(merged.headers.location, '/products/42');
  for (const override of [{ getProduct: async () => { throw Error('secret'); } }, { getCatalog: async () => { throw Error('secret'); } }]) {
    const response = await setup(t, override).inject('/products/42');
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers['retry-after'], '60');
    assert.doesNotMatch(response.body, /secret/);
  }
  assert.equal((await setup(t, { getProducts: async () => { throw Error('over limit'); } }).inject('/sitemap.xml')).statusCode, 503);
});

test('guide is static and complete before JavaScript, with canonical navigation', async t => {
  const server = setup(t, { getCatalog: async () => { throw new Error('no database'); } });
  const response = await server.inject('/guide?from=offer');
  assert.equal(response.statusCode, 200);
  const document = new JSDOM(response.body).window.document;
  assert.equal(document.querySelector('h1')!.textContent, '新手选购指南');
  assert.equal(document.querySelector('link[rel="canonical"]')!.getAttribute('href'), 'https://price.yufu.pub/guide');
  assert.equal(document.querySelectorAll('nav[aria-label="按购买需求阅读"] a').length, 2);
  assert.equal(document.querySelectorAll('details').length, 6);
  assert.equal(document.querySelectorAll('details[open]').length, 0);
  assert.equal(document.getElementById('guide-scenarios')!.tagName, 'H2');
  assert.ok(document.getElementById('duration')!.closest('details')!.querySelector('summary'));
  const { PURCHASE_GUIDE_FIELDS, PURCHASE_GUIDE_CONTENT } = await import('@price-comparison/catalog/purchase-guide-content');
  for (const [name, field] of Object.entries(PURCHASE_GUIDE_FIELDS)) {
    assert.ok(document.getElementById(name)!.textContent!.includes(field.explanation));
  }
  for (const scenario of PURCHASE_GUIDE_CONTENT.scenarios) {
    assert.ok(document.getElementById(scenario.id)!.textContent!.includes(scenario.question));
    assert.ok(document.querySelector(`a[href="#${scenario.id}"]`));
  }
  assert.ok(document.querySelector('table caption')!.textContent!.includes(PURCHASE_GUIDE_CONTENT.comparison.title));
  for (const item of PURCHASE_GUIDE_CONTENT.checklist) assert.ok(document.body.textContent!.includes(item.text));
  assert.ok(document.querySelector('a[href="/"]'));
  const redirect = await server.inject('/guide/?from=offer&x=1');
  assert.equal(redirect.statusCode, 308);
  assert.equal(redirect.headers.location, '/guide?from=offer&x=1');
});

test('guide escapes shared display text instead of treating it as HTML', async t => {
  const { PURCHASE_GUIDE_FIELDS } = await import('@price-comparison/catalog/purchase-guide-content');
  const field = PURCHASE_GUIDE_FIELDS.delivery;
  const original = field.explanation;
  try {
    field.explanation = '<img src=x onerror=alert(1)> & "条件"';
    const response = await setup(t).inject('/guide');
    const document = new JSDOM(response.body).window.document;
    assert.equal(document.querySelector('#delivery dd')!.textContent, field.explanation);
    assert.equal(document.querySelector('#delivery img'), null);
    assert.ok(response.body.includes('&lt;img'));
  } finally { field.explanation = original; }
});

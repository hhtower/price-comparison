import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { JSDOM } from 'jsdom';
import { SITE_NAME } from '@price-comparison/catalog/site-brand';
import { registerPublicPages } from '../src/seo/public-pages.js';
import type { CatalogPage } from '../src/catalog/catalog.repository.js';
import { encodeCatalogCursor } from '../src/catalog/catalog.repository.js';
import { productPagePath, productPageMetadata, productPageSchema } from '../src/seo/page-metadata.js';
import type { MembershipKind } from '@price-comparison/catalog/membership-policy';
import type { CatalogQueryInput } from '../src/catalog/catalog.service.js';

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

function schemaNode(document: Document, type: string): Record<string, any> {
  const data = JSON.parse(document.querySelector('#page-structured-data')!.textContent!);
  return data['@type'] === type ? data : data['@graph'].find((node: Record<string, any>) => node['@type'] === type);
}

test('shared metadata keeps feature paths and labels in paginated schema without changing standard URLs', () => {
  const product = { id: '42', name: 'ChatGPT Plus' };
  assert.equal(productPagePath('42'), '/products/42');
  assert.equal(productPageMetadata(product, 2).path, '/products/42?page=2');
  for (const [kind, label] of [['account', '成品号'], ['top_up', '代充'], ['rental', '租号'], ['short_term', '短期']] as const) {
    const path = `/products/42/features/${kind}`;
    assert.equal(productPagePath('42', 1, kind), path);
    const metadata = productPageMetadata(product, 2, kind);
    assert.equal(metadata.path, path + '?page=2');
    assert.equal(metadata.title, `ChatGPT Plus · ${label}价格比较（第2页） - ${SITE_NAME}`);
    assert.ok(metadata.description.includes(label));
    const graph = productPageSchema(product, 'https://comparison.example', 2, kind)['@graph'] as Record<string, any>[];
    assert.equal(graph.find(item => item['@type'] === 'CollectionPage')?.url, 'https://comparison.example' + path + '?page=2');
    assert.equal(graph.find(item => item['@type'] === 'BreadcrumbList')?.itemListElement.at(-1).item, 'https://comparison.example' + path);
    assert.equal(graph.find(item => item['@type'] === 'BreadcrumbList')?.itemListElement.at(-1).name, `ChatGPT Plus · ${label}`);
  }
});

test('feature SSR pins its filter and preserves canonical, title and pagination across all kinds', async t => {
  const queries: CatalogQueryInput[] = [];
  const server = setup(t, {
    getProduct: async (id: string) => ({ id, name: 'ChatGPT Plus', platform: 'openai', kind: '账号与订阅', isAiMembership: true }),
    getCatalog: async (input: CatalogQueryInput) => {
      queries.push(input);
      const offer = { ...page.items[0]!.offers[0]!, name: '仅选中特性报价' };
      return { ...page, items: [{ ...page.items[0]!, detail: { kind: 'offers', entries: [offer], total: 30, page: input.detailPage, pageSize: 12 } }] };
    },
  });
  for (const [kind, label] of [['account', '成品号'], ['top_up', '代充'], ['rental', '租号'], ['short_term', '短期']] as const) {
    const path = `/products/42/features/${kind}`;
    const response = await server.inject(path + '?page=2&membershipKind=rental&membershipKinds=short_term&newcomer=true&utm_source=test');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(queries.at(-1), { standardProductId: '42', detailKind: 'offers', detailPage: 1,
      detailPageSize: 12, currency: 'CNY', offerSort: 'price', membershipKinds: [kind] });
    const document = new JSDOM(response.body).window.document;
    assert.equal(document.querySelector('h1')!.textContent, `ChatGPT Plus · ${label}`);
    assert.ok(document.title.includes(label));
    assert.equal(document.querySelector('link[rel="canonical"]')!.getAttribute('href'), 'https://price.yufu.pub' + path + '?page=2');
    assert.equal(document.querySelector('meta[property="og:url"]')!.getAttribute('content'), 'https://price.yufu.pub' + path + '?page=2');
    assert.equal(schemaNode(document, 'CollectionPage').url, 'https://price.yufu.pub' + path + '?page=2');
    assert.equal(document.querySelector('a[rel="prev"]')!.getAttribute('href'), path);
    assert.equal(document.querySelector('a[rel="next"]')!.getAttribute('href'), path + '?page=3');
    assert.equal(document.querySelector('a[href="/products/42"]'), null);
    assert.match(document.body.textContent!, /仅选中特性报价/);
    assert.equal((await server.inject(path + '?page=4')).statusCode, 404);
  }
});

test('feature SSR rejects invalid kinds, non-AI products and invalid pages, and preserves merged feature URLs', async t => {
  const queries: string[] = [];
  const server = setup(t, {
    getProduct: async (id: string) => { queries.push(id); return { id, name: 'ChatGPT Plus', platform: 'openai', kind: '账号与订阅', isAiMembership: true }; },
  });
  for (const path of ['/products/42/features/unknown', '/products/42/features/ACCOUNT', '/products/0/features/account',
    '/products/42/features/account?page=0', '/products/42/features/account?page=2&page=3']) {
    const response = await server.inject(path);
    assert.equal(response.statusCode, 404, path);
    assert.equal(response.headers['x-robots-tag'], 'noindex, nofollow');
  }
  assert.deepEqual(queries, []);
  const nonAi = setup(t, { getProduct: async () => ({ id: '42', name: '邮箱', platform: 'google', kind: '其他', isAiMembership: false }),
    getCatalog: async () => assert.fail('non-AI features must not query offers') });
  assert.equal((await nonAi.inject('/products/42/features/account')).statusCode, 404);
  assert.equal((await setup(t).inject('/products/404/features/account')).statusCode, 404);
  for (const isAiMembership of [true, false, undefined]) {
    const merged = setup(t, { getProduct: async () => ({ id: '41', name: 'old', platform: 'openai', kind: '账号与订阅', isAiMembership, mergedIntoId: '42' }),
      getCatalog: async () => assert.fail('merged products redirect before querying offers') });
    const response = await merged.inject('/products/41/features/rental?page=2');
    assert.equal(response.statusCode, 308, `source isAiMembership=${isAiMembership}`);
    assert.equal(response.headers.location, '/products/42/features/rental?page=2');
    assert.equal((await nonAi.inject(response.headers.location!)).statusCode, 404);
  }
  const unavailable = await setup(t, { getProduct: async () => { throw Error('private'); } }).inject('/products/42/features/account');
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.headers['x-robots-tag'], 'noindex, nofollow');
});

test('SSR home links nonempty AI feature groups to their own details and keeps non-AI standard links', async t => {
  const offer = page.items[0]!.offers[0]!;
  const groups = (['account', 'rental', 'short_term', 'top_up'] as MembershipKind[]).map(kind => ({
    kind, shopCount: kind === 'top_up' ? 0 : 1, productCount: kind === 'top_up' ? 0 : 1,
    minPrice: '12.50', maxPrice: '12.50', latestCapturedAt: offer.capturedAt,
    offers: kind === 'top_up' ? [] : [{ ...offer, name: `${kind}报价` }],
  }));
  const response = await setup(t, { getCatalog: async () => ({ ...page, items: [
    { ...page.items[0]!, isAiMembership: true, membershipGroups: groups },
    { ...page.items[0]!, id: '43', isAiMembership: false, name: '邮箱' },
    { ...page.items[0]!, id: '44', isAiMembership: true, membershipGroups: [] },
  ] }) }).inject('/');
  const document = new JSDOM(response.body).window.document;
  assert.deepEqual([...document.querySelectorAll('article h3 a')].map(link => link.getAttribute('href')),
    ['/products/42/features/account', '/products/42/features/rental', '/products/42/features/short_term', '/products/43']);
  assert.equal(document.querySelector('a[href="/products/42"]'), null);
  assert.equal(document.querySelector('a[href="/products/44"]'), null);
  assert.equal(document.querySelector('a[href="/products/42/features/top_up"]'), null);
  assert.equal(document.querySelector('a[href="/products/42/features/rental"]')!.textContent, 'ChatGPT Plus · 租号');
});

test('public schema uses the configured origin and only marks visible FAQ answers', async t => {
  const origin = 'https://comparison.example';
  const server = setup(t, { siteUrl: origin });
  for (const path of ['/', '/guide', '/tools', '/products/42']) {
    const response = await server.inject(path);
    const document = new JSDOM(response.body).window.document;
    const graph = JSON.parse(document.querySelector('#page-structured-data')!.textContent!);
    assert.doesNotMatch(JSON.stringify(graph), /price\.yufu\.pub/);
    assert.equal(schemaNode(document, 'Organization')['@id'], origin + '/#organization');
    const faq = schemaNode(document, 'FAQPage');
    const visible = [...document.querySelectorAll('.seo-faq > div')].map(element => ({
      question: element.querySelector('h3')!.textContent,
      answer: element.querySelector('p')!.textContent,
    }));
    assert.deepEqual(faq?.mainEntity.map((item: Record<string, any>) => ({
      question: item.name, answer: item.acceptedAnswer.text,
    })) ?? [], visible);
    if (path !== '/') {
      assert.deepEqual(schemaNode(document, 'BreadcrumbList').itemListElement
        .map((item: Record<string, any>) => [item.position, item.item]), [[1, origin + '/'], [2, origin + path]]);
    }
  }
});

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
  assert.match(document.querySelector('.seo-fact')!.textContent!, /5 项购买条件.*查看选购说明/);
  assert.equal(document.querySelector('time')!.getAttribute('datetime'), '2026-09-27T00:00:00.000Z');
  assert.ok(document.querySelector('script[type="module"]'));
  const data = JSON.parse(document.querySelector('script[type="application/ld+json"]')!.textContent!);
  assert.equal(data['@context'], 'https://schema.org');
  assert.ok(data['@graph'].some((entry: Record<string, unknown>) => entry['@type'] === 'WebSite'));
  assert.equal(schemaNode(document, 'Organization').name, SITE_NAME);
  assert.equal(schemaNode(document, 'FAQPage').mainEntity.length, 4);
  assert.equal(data['@graph'].some((entry: Record<string, unknown>) => entry['@type'] === 'BreadcrumbList'), false);
  assert.doesNotMatch(JSON.stringify(data), /AggregateOffer|aggregateRating|priceValidUntil/);
});

for (const path of ['/', '/products/42']) test(`SEO answers and purchase facts are readable without JavaScript on ${path}`, async t => {
  const response = await setup(t).inject(path);
  const document = new JSDOM(response.body).window.document;
  const answer = document.querySelector('.seo-answer');
  assert.ok(answer, 'lead with a complete answer');
  assert.equal(document.querySelectorAll('main h1').length, 1);
  assert.equal(document.querySelectorAll('.catalog-seo-intro').length, 1);
  if (path === '/') {
    const panel = document.querySelector('.catalog-seo-panel');
    assert.ok(panel);
    assert.ok(panel.contains(document.querySelector('.catalog-seo-intro')));
    assert.ok(panel.contains(document.querySelector('.seo-faq')));
  }
  assert.equal(document.querySelectorAll('.seo-answer').length, 1);
  if (path === '/') {
    const lastProduct = [...document.querySelectorAll('main article')].at(-1)!;
    assert.ok(lastProduct.compareDocumentPosition(answer) & document.defaultView!.Node.DOCUMENT_POSITION_FOLLOWING,
      'home buying notes follow the product list');
    assert.ok(answer.closest('.catalog-seo-intro')!.contains(document.querySelector('main h1')),
      'the homepage title moves with its buying notes');
  } else {
    assert.equal(document.querySelector('main p'), answer);
  }
  assert.ok([...answer.textContent!].length <= 50);
  const facts = [...document.querySelectorAll('.seo-fact')];
  assert.equal(facts.length, 3);
  for (const fact of facts) {
    assert.ok(fact.querySelector('h2'));
    assert.match(fact.textContent!, /\d/u);
    assert.ok(fact.querySelector('a[href]'), 'facts link to their verification context');
  }
  const faq = document.querySelector('.seo-faq');
  assert.ok(faq);
  assert.ok(faq.querySelectorAll('h3').length >= 3);
  for (const answer of faq.querySelectorAll('p')) assert.ok([...answer.textContent!].length <= 80);
  assert.ok(document.querySelector('a[href="https://shop.example/product/9"]'));
  assert.equal(document.querySelector('main')!.lastElementChild, path === '/' ? document.querySelector('.catalog-seo-panel') : faq);
  assert.doesNotMatch(document.body.textContent!, /PriceAI|OpenPrice|AICheap|AIDeal|谷歌前三|保证收录/u);
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
  assert.ok(schemaNode(document, 'BreadcrumbList').itemListElement.some((item: Record<string, any>) => item.name === 'AI 与 IP 检测工具'));
  assert.equal(schemaNode(document, 'WebSite').publisher['@id'], 'https://price.yufu.pub/#organization');
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

test('assistant direct refresh is private, independent from catalog and excluded from sitemap', async t => {
  const server = setup(t, { getCatalog: async () => { throw new Error('must not query'); } });
  const response = await server.inject('/assistant');
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.match(String(response.headers['x-robots-tag']), /noindex/);
  const document = new JSDOM(response.body).window.document;
  assert.match(document.title, /导购助手/);
  assert.match(document.querySelector('meta[name="robots"]')!.getAttribute('content')!, /noindex/);
  assert.equal(document.querySelector('link[rel="canonical"]')!.getAttribute('href'), 'https://price.yufu.pub/assistant');
  assert.equal(document.querySelector('script[type="application/ld+json"]'), null);
  assert.ok(document.querySelector('a[href="/guide"]'));
  assert.doesNotMatch((await server.inject('/sitemap.xml')).body, /\/assistant/);
  const redirect = await server.inject('/assistant/?utm_source=test');
  assert.equal(redirect.statusCode, 308);
  assert.equal(redirect.headers.location, '/assistant?utm_source=test');
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
  assert.match(document.querySelector('article h3')!.textContent!, /<script>/);
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

test('comparison HTML keeps visible quotes and describes a collection instead of a merchant product', async t => {
  let query: unknown;
  const response = await setup(t, { getCatalog: async (input: unknown) => { query = input; return { ...page, items: [{ ...page.items[0]!, offers: [{ ...page.items[0]!.offers[0]!, priceStatus: 'verified' }] }] }; } }).inject('/products/42?utm_source=test');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(query, { standardProductId: '42', detailKind: 'offers', detailPage: 0, detailPageSize: 12, currency: 'CNY', offerSort: 'price' });
  const document = new JSDOM(response.body).window.document;
  assert.match(document.title, /ChatGPT Plus/);
  assert.equal(document.querySelector('h1')?.textContent, 'ChatGPT Plus');
  for (const selector of ['link[rel="canonical"]', 'meta[property="og:url"]']) assert.equal(document.querySelector(selector)?.getAttribute(selector.startsWith('link') ? 'href' : 'content'), 'https://price.yufu.pub/products/42');
  assert.match(document.querySelector('#root')!.textContent!, /12.50.*CNY/s);
  const schema = schemaNode(document, 'CollectionPage');
  assert.ok(schema);
  assert.equal(schema.url, 'https://price.yufu.pub/products/42');
  assert.equal(schema.description, document.querySelector('meta[name="description"]')!.getAttribute('content'));
  assert.equal(schema.mainEntity, undefined);
  assert.doesNotMatch(document.querySelector('#page-structured-data')!.textContent!, /"(?:Product|Offer|AggregateOffer)"/);
  assert.equal(schemaNode(document, 'BreadcrumbList').itemListElement.at(-1).name, 'ChatGPT Plus');
  assert.equal(schemaNode(document, 'FAQPage').mainEntity.length, 5);
  assert.equal(schemaNode(document, 'Organization').url, 'https://price.yufu.pub/');
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

test('multi-unit quotes never emit bare unit-price Offers or an incomplete Product', async t => {
  const single = page.items[0]!.offers[0]!;
  const multi = { ...single, productId: '10', price: '0.333333333333', settlementQuantity: 3 };
  for (const offers of [[multi], [multi, single], [multi, { ...single, settlementQuantity: undefined }]]) {
    const response = await setup(t, { getCatalog: async () => ({ ...page, items: [{ ...page.items[0]!, offers }] }) }).inject('/products/42');
    assert.equal(response.statusCode, 200);
    const document = new JSDOM(response.body).window.document;
    assert.equal(schemaNode(document, 'Product'), undefined);
    assert.ok(schemaNode(document, 'CollectionPage'));
    assert.match(document.querySelector('#root')!.textContent!, /0\.333333333333 CNY/);
    assert.doesNotMatch(document.querySelector('#root')!.textContent!, /1件起购|1\.00 CNY/);
  }
});

for (const status of ['expired', 'estimated'] as const) for (const path of ['/', '/products/42']) test(`${status} quotes render as estimates on ${path} without structured Offers`, async t => {
  const offer = { ...page.items[0]!.offers[0]!, priceStatus: status };
  const response = await setup(t, { getCatalog: async () => ({ ...page, items: [{ ...page.items[0]!, offers: [offer] }] }) }).inject(path);
  const document = new JSDOM(response.body).window.document;
  assert.match(document.querySelector('#root')!.textContent!, /12\.50 CNY.*预估/);
  if (path !== '/') assert.equal(schemaNode(document, 'Product'), undefined);
});

test('public product without a valid price keeps its page and never emits a false offer', async t => {
  const response = await setup(t, { getCatalog: async () => ({ ...page, items: [{ ...page.items[0]!, minPrice: null, offers: [{ ...page.items[0]!.offers[0]!, price: null, listedPrice: '9.00', priceStatus: 'expired' }] }] }) }).inject('/products/42');
  assert.equal(response.statusCode, 200);
  const document = new JSDOM(response.body).window.document;
  assert.match(document.querySelector('#root')!.textContent!, /—/);
  assert.doesNotMatch(document.querySelector('main ul')!.textContent!, /标价|9\.00|待更新|待核验/);
  assert.equal(schemaNode(document, 'Product'), undefined);
  const empty = await setup(t, { getCatalog: async () => ({ items: [], total: 0, platformFacets: [] }) }).inject('/products/42');
  assert.equal(empty.statusCode, 200);
  assert.match(empty.body, /暂无可用报价/);
  const emptyDocument = new JSDOM(empty.body).window.document;
  assert.equal(schemaNode(emptyDocument, 'Product'), undefined);
  assert.equal(schemaNode(emptyDocument, 'CollectionPage').mainEntity, undefined);
  assert.ok(schemaNode(emptyDocument, 'BreadcrumbList'));
  assert.ok(schemaNode(emptyDocument, 'FAQPage'));
});

test('payment-method estimates and unavailable prices never become structured offers', async t => {
  const single = page.items[0]!.offers[0]!;
  for (const change of [
    { paymentMethod: '支付价（预估：售价）' }, { stale: true }, { inStock: false }, { inStock: undefined },
    { price: '' }, { price: ' ' }, { price: '-1' }, { price: 'NaN' }, { productUrl: 'javascript:alert(1)' },
    { priceExpiresAt: '2000-01-01T00:00:00Z' },
    { inventoryExpiresAt: '2000-01-01T00:00:00Z' },
  ]) {
    const response = await setup(t, { getCatalog: async () => ({ ...page, items: [{ ...page.items[0]!, offers: [{ ...single, ...change }] }] }) }).inject('/products/42');
    const document = new JSDOM(response.body).window.document;
    assert.equal(schemaNode(document, 'Product'), undefined, JSON.stringify(change));
  }
});

test('product quote pages have unique canonicals and crawlable previous and next links', async t => {
  let query: any;
  const server = setup(t, { getCatalog: async (input: any) => {
    query = input;
    const offer = { ...page.items[0]!.offers[0]!, name: '报价页' + input.detailPage };
    return { ...page, items: [{ ...page.items[0]!, detail: { kind: 'offers', entries: [offer], page: input.detailPage, pageSize: 12, total: 30 } }] };
  } });
  for (const [path, current, previous, next] of [
    ['/products/42', 0, null, '/products/42?page=2'],
    ['/products/42?page=2&utm_source=test', 1, '/products/42', '/products/42?page=3'],
    ['/products/42?page=3', 2, '/products/42?page=2', null],
  ] as const) {
    const response = await server.inject(path);
    assert.equal(response.statusCode, 200);
    assert.equal(query.detailPage, current);
    const document = new JSDOM(response.body).window.document;
    assert.equal(document.querySelector('link[rel="canonical"]')!.getAttribute('href'), 'https://price.yufu.pub/products/42' + (current ? '?page=' + (current + 1) : ''));
    assert.equal(schemaNode(document, 'CollectionPage').url, document.querySelector('link[rel="canonical"]')!.getAttribute('href'));
    assert.match(document.querySelector('main')!.textContent!, new RegExp('报价页' + current));
    assert.equal(document.querySelector('a[rel="prev"]')?.getAttribute('href') ?? null, previous);
    assert.equal(document.querySelector('a[rel="next"]')?.getAttribute('href') ?? null, next);
  }
  assert.equal((await server.inject('/products/42?page=4')).statusCode, 404);
  for (const value of ['0', '-1', 'abc', '1.5', '99999999999999999', '2&page=3']) {
    assert.equal((await server.inject('/products/42?page=' + value)).statusCode, 404, value);
  }
});

test('home cursor pages expose subsequent products with their own canonical and next link', async t => {
  const cursor = encodeCatalogCursor({ sortOrder: 0n, standardProductId: 42n });
  let query: any;
  const server = setup(t, { getCatalog: async (input: any) => {
    query = input;
    return input?.cursor ? { ...page, items: [{ ...page.items[0]!, id: '43', name: '下一页商品' }] } : { ...page, nextCursor: cursor };
  } });
  const first = new JSDOM((await server.inject('/')).body).window.document;
  const next = first.querySelector('a[rel="next"]')!.getAttribute('href')!;
  assert.equal(next, '/?cursor=' + cursor);
  const response = await server.inject(next + '&utm_source=test');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(query, { cursor, limit: 20 });
  const document = new JSDOM(response.body).window.document;
  assert.equal(document.querySelector('link[rel="canonical"]')!.getAttribute('href'), 'https://price.yufu.pub' + next);
  assert.ok(document.querySelector('a[href="/products/43"]'));
  assert.equal(document.querySelector('a[rel="next"]'), null);
  assert.equal((await server.inject('/?cursor=invalid')).statusCode, 404);
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

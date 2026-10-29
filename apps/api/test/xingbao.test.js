import test from 'node:test';
import assert from 'node:assert/strict';
const origin = 'https://xingbao-ai.shop';
const shop = { url: origin + '/' };
const sitemap = (slugs = ['chatgpt-plus-cover', 'claude-pro-ni']) =>
  `<?xml version="1.0"?>\n<urlset>${['', ...slugs].map(s => `<url><loc>${origin}${s ? `/products/${s}` : '/'}</loc></url>`).join('')}</urlset>`;
const product = (slug, changes = {}) => `<html><head><script type="application/ld+json">${JSON.stringify([{
  '@context': 'https://schema.org', '@type': 'Product', name: `商品 ${slug}`, sku: slug,
  description: '官方渠道卡密自动发货', category: 'ChatGPT', image: ['https://xingbao-ai.shop/api/product-images/a.webp'],
  offers: { '@type': 'Offer', price: '138.00', priceCurrency: 'CNY', availability: 'https://schema.org/InStock', ...changes },
}])}</script></head></html>`;
function network({ slugs = ['chatgpt-plus-cover', 'claude-pro-ni'], pages = {}, home = product('chatgpt-plus-cover') } = {}) {
  const calls = [];
  const byPath = { '/sitemap.xml': sitemap(slugs), '/': home, ...pages };
  return { calls, fetch: async (url, init) => {
    calls.push({ url: String(url), init });
    const path = new URL(String(url)).pathname;
    const body = byPath[path] ?? pages[path.slice('/products/'.length) && path.startsWith('/products/') ? path.slice('/products/'.length) : path] ?? product(path.slice('/products/'.length));
    assert.ok(path === '/sitemap.xml' || path === '/' || /^\/products\/[A-Za-z0-9_-]+$/.test(path), `unexpected URL ${url}`);
    return new Response(body, { headers: { 'content-type': path === '/sitemap.xml' ? 'application/xml' : 'text/html' } });
  } };
}

test('xingbao crawls the sitemap and parses ld+json products', async () => {
  const { crawl, probe } = await import('../src/platforms/xingbao.js');
  const net = network({ pages: { 'claude-pro-ni': product('claude-pro-ni', { price: '152', availability: 'https://schema.org/OutOfStock' }) } });
  let completed = 0;
  const products = await crawl(null, shop, net.fetch, { onListComplete: () => completed++ });
  assert.deepEqual(products.map(p => [p.externalId, p.price, p.inStock, p.sourceCategory]), [['chatgpt-plus-cover', '138.00', true, 'ChatGPT'], ['claude-pro-ni', '152', false, 'ChatGPT']]);
  assert.equal(products[0].url, origin + '/products/chatgpt-plus-cover');
  assert.equal(products[0].imageUrl, origin + '/api/product-images/a.webp');
  assert.match(products[0].sourceData.evidence, /官方渠道卡密/);
  assert.equal(completed, 1);
  assert.ok(net.calls.every(c => c.init.redirect === 'error' && c.init.headers.accept === 'text/html'));
  const preview = await probe(shop, network({ home: `<html><body><a href="/products/claude-pro-ni">买</a></body></html>` }).fetch);
  assert.equal(preview[0].externalId, 'claude-pro-ni');
});

test('xingbao rejects sitemaps without usable product URLs', async () => {
  const { crawl } = await import('../src/platforms/xingbao.js');
  for (const slugs of [[], ['x', 'x']]) await assert.rejects(crawl(null, shop, network({ slugs }).fetch), /xingbao catalog:/);
  await assert.rejects(crawl(null, shop, network({ slugs: ['x'] , pages: { x: `<html><script type="application/ld+json">{"@type":"Organization"}</script></html>` } }).fetch), /missing product data/);
});

test('xingbao rejects invalid ld+json shapes', async () => {
  const { crawl } = await import('../src/platforms/xingbao.js');
  const invalid = [
    { price: '13.8.1' }, { price: '0.00' }, { price: '138.555' }, { price: '-5' }, { price: undefined }, { priceCurrency: 'USD' },
    { availability: 'https://schema.org/PreOrder' },
  ];
  for (const offers of invalid) {
    await assert.rejects(crawl(null, shop, network({ slugs: ['x'], pages: { x: product('x', offers) } }).fetch), /xingbao catalog:/);
  }
  await assert.rejects(crawl(null, shop, network({ slugs: ['x'], pages: { x: product('x').replace('"@type":"Product"', '"@type":"Service"') } }).fetch), /missing product data/);
  await assert.rejects(crawl(null, shop, network({ slugs: ['x'], pages: { x: product('y') } }).fetch), /invalid product/); // sku mismatch
  await assert.rejects(crawl(null, shop, network({ slugs: ['x'], pages: { x: product('x').replace('{"@context"', 'broken{"@context"') } }).fetch), /invalid ld\+json/);
  await assert.rejects(crawl(null, shop, network({ slugs: ['x'], pages: { x: product('x') + product('x') } }).fetch), /duplicate product block/);
});

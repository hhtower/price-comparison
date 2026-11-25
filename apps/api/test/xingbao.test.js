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
const checkout = (slug = 'chatgpt-pro-5x-warranty') => `<html><body>
  <form action="" method="POST">
    <input type="hidden" name="$ACTION_REF_1">
    <input type="hidden" name="$ACTION_1:0" value="{&quot;id&quot;:&quot;action-id&quot;,&quot;bound&quot;:&quot;$@1&quot;}">
    <input type="hidden" name="$ACTION_1:1" value="[&quot;${slug}&quot;]">
    <input type="hidden" name="quantity" value="1">
    <input type="hidden" name="couponCode" value="">
    <button type="submit" name="paymentIntent" value="online:alipay">
      <span>支付宝 2%手续费</span><small>¥698.70<!-- --> · 含手续费 ¥13.70</small>
    </button>
    <button type="submit" name="paymentIntent" value="online:usdt.polygon">
      <span>USDT(Polygon)</span><small>¥685.00 · 免手续费</small>
    </button>
  </form></body></html>`;
function network({ slugs = ['chatgpt-plus-cover', 'claude-pro-ni'], pages = {}, home = product('chatgpt-plus-cover') } = {}) {
  const calls = [];
  const byPath = { '/sitemap.xml': sitemap(slugs), '/': home, ...pages };
  return { calls, fetch: async (url, init) => {
    calls.push({ url: String(url), init });
    const path = new URL(String(url)).pathname;
    assert.ok(!init.method || init.method === 'GET');
    assert.equal(init.body, undefined);
    const body = byPath[path] ?? (path.startsWith('/checkout/') ? checkout(path.slice('/checkout/'.length))
      : pages[path.slice('/products/'.length)] ?? product(path.slice('/products/'.length)));
    assert.ok(path === '/sitemap.xml' || path === '/' || /^\/(?:products|checkout)\/[A-Za-z0-9_-]+$/.test(path), `unexpected URL ${url}`);
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
  assert.equal(products[0].settlement?.totalAmount, '698.70');
  assert.equal(products[1].settlement, undefined);
  assert.ok(net.calls.every(c => c.init.redirect === 'error' && c.init.headers.accept === 'text/html'));
  const preview = await probe(shop, network({ home: `<html><body><a href="/products/claude-pro-ni">买</a></body></html>` }).fetch);
  assert.equal(preview[0].externalId, 'claude-pro-ni');
});

const candidate = () => ({ externalId: 'chatgpt-pro-5x-warranty', spec: '', price: '685.00',
  url: origin + '/products/chatgpt-pro-5x-warranty', inStock: true });
const checkoutNetwork = (html = checkout(), details = product('chatgpt-pro-5x-warranty', { price: '685.00' })) =>
  async url => new Response(new URL(url).pathname.startsWith('/products/') ? details : html);

test('xingbao supplemental quotes reject changed prices or evidence under the same slug', async () => {
  const { settle } = await import('../src/platforms/xingbao.js');
  for (const change of [{ price: '100.00' }, { name: 'Old annual package' },
    { sourceData: { evidence: 'Old warranty terms' } }]) {
    const calls = [];
    const [row] = await settle(shop, [{ ...candidate(), ...change }], async url => {
      calls.push(String(url));
      return checkoutNetwork()(url);
    });
    assert.equal(row.settlement, undefined, JSON.stringify(change));
    assert.ok(calls.every(url => !url.includes('/checkout/')));
  }
});

test('xingbao rejects external form controls and non-input quantity or coupon conflicts', async () => {
  const { settle } = await import('../src/platforms/xingbao.js');
  for (const html of [
    checkout().replace('<form ', '<input form="checkout" type="hidden" name="quantity" value="2"><form id="checkout" '),
    checkout().replace('</form>', '<select name="quantity"><option selected value="2">2</option></select></form>'),
    checkout().replace('</form>', '<textarea name="couponCode">PRIVATE</textarea></form>'),
    checkout().replace('</form>', '<input name="paymentIntent" type="hidden" value="wallet"></form>'),
    checkout().replace('value="online:alipay"', 'value="online:alipay" formaction="/another-product"'),
  ]) {
    const [row] = await settle(shop, [candidate()], checkoutNetwork(html));
    assert.equal(row.settlement, undefined, html);
  }
});

test('xingbao verifies the bound single-unit CNY checkout amount, excluding cheaper crypto', async () => {
  const { settle } = await import('../src/platforms/xingbao.js');
  const results = [], calls = [];
  const [row] = await settle(shop, [candidate()], async (url, init) => {
    calls.push(String(url));
    assert.ok(!init.method || init.method === 'GET');
    assert.equal(init.body, undefined);
    assert.equal(init.redirect, 'error');
    if (url === origin + '/products/chatgpt-pro-5x-warranty') return new Response(product('chatgpt-pro-5x-warranty', { price: '685.00' }));
    assert.equal(url, origin + '/checkout/chatgpt-pro-5x-warranty');
    return new Response(checkout());
  }, { onSettlementResult: result => results.push(result) });
  assert.equal(row.price, '685.00');
  assert.equal(row.settlement.totalAmount, '698.70');
  assert.equal(row.settlement.quantity, 1);
  assert.equal(row.settlement.paymentMethod, '支付宝');
  assert.equal(row.settlement.kind, 'verified');
  assert.equal(results[0].status, 'verified');
  assert.equal(calls.length, 2);
});

test('xingbao selects the cheapest enabled fiat quote and parses grouped CNY amounts', async () => {
  const { settle } = await import('../src/platforms/xingbao.js');
  const html = checkout().replace('¥698.70', '¥1,020.00').replace('¥13.70', '¥20.00')
    .replace('</form>', `<button type="submit" name="paymentIntent" value="online:wxpay">
      <small>¥1,010.00 · 含手续费 ¥10.00</small></button>
      <button type="submit" name="paymentIntent" value="wallet"><small>¥1.00 · 含手续费 ¥0.00</small></button></form>`);
  const [row] = await settle(shop, [candidate()], checkoutNetwork(html));
  assert.equal(row.settlement.totalAmount, '1010.00');
  assert.equal(row.settlement.paymentMethod, '微信支付');
  const { platformForUrl } = await import('../src/platforms/index.js');
  const adapter = platformForUrl(shop.url, 'xingbao');
  assert.equal(adapter.canVerifySettlement, true);
  const [wrapped] = await adapter.settle(shop, [candidate()], checkoutNetwork());
  assert.equal(wrapped.settlement.kind, 'verified');
  assert.equal(wrapped.settlement.totalAmount, '698.70');
});

test('xingbao refuses ambiguous identities, quantities, coupons, currencies and truncated checkout', async () => {
  const { settle } = await import('../src/platforms/xingbao.js');
  const html = checkout();
  const invalid = [
    checkout('another-product'),
    html.replace('name="quantity" value="1"', 'name="quantity" value="2"'),
    html.replace('name="quantity" value="1"', 'name="quantity" value="1"><input name="quantity" value="1"'),
    html.replace('name="couponCode" value=""', 'name="couponCode" value="PRIVATE"'),
    html.replace('name="quantity"', 'disabled name="quantity"'),
    html.replace('online:alipay', 'online:usdt.bep20'),
    html.replace('value="online:alipay"', 'disabled value="online:alipay"'),
    html.replace('¥698.70', '$698.70'),
    html.replace('¥698.70', '¥698.701'),
    html.replace('¥698.70', '¥0.00'),
    html.replace('¥13.70', '¥999.00'),
    html.replace('name="$ACTION_REF_1"', 'name="unbound"'),
    html.replace('$@1', '$@2'),
    html.replace('value="online:usdt.polygon"', 'value="online:alipay"'),
    html.replace('<form action="" method="POST">', '<form action="" method="POST"><fieldset disabled>').replace('</form>', '</fieldset></form>'),
    html.replace('</form>', '</form><form method="POST"></form>'),
    html.slice(0, -7),
    product('chatgpt-pro-5x-warranty'),
  ];
  for (const body of invalid) {
    const results = [];
    const [row] = await settle(shop, [candidate()], checkoutNetwork(body),
      { onSettlementResult: result => results.push(result) });
    assert.equal(row.settlement, undefined, body);
    assert.equal(results[0].status, 'failed');
  }
  for (const changes of [{ spec: 'other SKU' }, { externalId: '../orders' }, { url: origin + '/products/other' }]) {
    const [row] = await settle(shop, [{ ...candidate(), ...changes }], async () => assert.fail('invalid identity must not fetch'));
    assert.equal(row.settlement, undefined);
  }
});

test('xingbao checkout honors selection, budgets, failures and cancellation during body reads', async () => {
  const { settle } = await import('../src/platforms/xingbao.js');
  for (const options of [{ settlementProductIds: new Set() }, { needsSettlement: () => false }]) {
    const [row] = await settle(shop, [candidate()], async () => assert.fail('skipped product must not fetch'), options);
    assert.equal(row.settlement, undefined);
  }
  let calls = 0;
  await settle(shop, [candidate(), candidate()], async url => { calls++; return checkoutNetwork()(url); }, { maxSettlementProducts: 1 });
  assert.equal(calls, 2);
  const [unavailable] = await settle(shop, [{ ...candidate(), inStock: false }],
    async () => assert.fail('out of stock must not fetch'));
  assert.equal(unavailable.settlement, undefined);
  for (const response of [new Response('blocked', { status: 403 }), new Response('busy', { status: 429 })]) {
    const results = [];
    const [row] = await settle(shop, [candidate()], async () => response, { onSettlementResult: r => results.push(r) });
    assert.equal(row.settlement, undefined);
    assert.equal(results[0].reason, 'blocked');
  }
  for (const phase of ['products', 'checkout']) {
    const controller = new AbortController();
    await assert.rejects(settle(shop, [candidate()], async (url, init) => {
      assert.equal(init.signal, controller.signal);
      if (!new URL(url).pathname.startsWith(`/${phase}/`)) return checkoutNetwork()(url);
      return { ok: true, text: async () => { controller.abort(new Error('cancelled')); return checkout(); } };
    }, { signal: controller.signal }), /cancelled/);
  }
  const results = [];
  const [row] = await settle(shop, [candidate()], async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); },
    { onSettlementResult: r => results.push(r) });
  assert.equal(row.settlement, undefined);
  assert.equal(results[0].retryable, true);
  assert.equal(results[0].reason, 'request_timeout');
});

test('xingbao supplemental quotes mark newly sold-out products unavailable without opening checkout', async () => {
  const { settle } = await import('../src/platforms/xingbao.js');
  const reports = [], calls = [];
  const [row] = await settle(shop, [candidate()], async url => {
    calls.push(String(url));
    return new Response(product('chatgpt-pro-5x-warranty', { price: '685.00', availability: 'https://schema.org/OutOfStock' }));
  }, { onSettlementResult: result => reports.push(result) });
  assert.equal(row.inStock, false);
  assert.equal(row.settlement, undefined);
  assert.equal(reports[0].reason, 'out_of_stock');
  assert.equal(calls.length, 1);
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

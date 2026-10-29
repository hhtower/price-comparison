import test from 'node:test';
import assert from 'node:assert/strict';
import { projectShopText } from '../src/shops/shop-text-review.js';
const shop = { url: 'https://geminipro.vip/' };
const currency = '<script>window.EMSHOP_CURRENCY = {code:"CNY",symbol:"\\u00a5",rate:1};</script>';
const wrap = body => `<html><head>${currency}</head><body>${body}</body></html>`;
const card = id => `<a class="card goods-card" href="/post-${id}.html"><div class="card-title">商品${id}</div><span class="price">¥9999</span></a>`;
const referral = '<a class="card goods-card" href="https://tg.19cm.tech/" target="_blank" rel="nofollow noopener"><span class="price">¥3.00</span></a>';
const catalog = (cards = card(1) + referral, count = 2) => wrap(`<div id="main" data-nav-id="goods" data-nav-current-path="/post-list.html"><div class="category-tabs"><a class="category-tab active" href="/post-list.html"><span class="category-tab-count">${count}</span></a></div><div class="goods-grid">${cards}</div></div>`);
const specs = () => [{ id: 1, name: '默认规格', price: 114, market_price: 9999, stock: 38, min_buy: 1, max_buy: 0, is_default: 1, value_ids: [], tags: [] }, { id: 8, name: '月卡 [新]', price: 650, stock: 0, min_buy: 1, max_buy: 0, value_ids: [] }];
const detail = (rows = specs(), id = 1) => wrap(`<div id="main" data-nav-id="goods" data-nav-current-path="/post-${id}.html"><div class="detail-name">GPT菲区卡充</div><div class="detail-img"><img src="/cover.png"></div><div class="detail-body">官方渠道<p>30天质保</p></div><button id="buyNowBtn" data-goods-id="${id}">购买</button><script>GoodsDetail.init({specs:${JSON.stringify(rows)},currencySymbol:"\\u00a5",discountRules:[]});</script></div>`);
function network(list = catalog(), product = detail(), hook) {
  const calls = [];
  return { calls, fetch: async (url, init) => { calls.push({ url, init }); hook?.(url, init); const path = new URL(url).pathname; assert.ok(['/post-list.html', '/post-1.html'].includes(path), `unexpected URL ${url}`); return new Response(path === '/post-list.html' ? list : product); } };
}

test('EMShop normalizes selected labels while preserving purchase limits', async () => {
  const { crawl } = await import('../src/platforms/emshop.js');
  const rows = specs();
  rows[0].name = ' Ｍｏｎｔｈｌｙ \n account ';
  rows[0].min_buy = 2;
  const [product] = await crawl(null, shop, network(undefined, detail(rows)).fetch);
  assert.equal(product.spec, 'Monthly account');
  assert.equal(product.externalId, '1:1');
  assert.equal(product.sourceData.min_buy, 2);
  for (const key of ['sku', 'selectedOptions', 'specification', 'spec']) assert.equal(key in product.sourceData, false);
});

test('EMShop rating evidence preserves escaped text and paragraph boundaries', async () => {
  const { crawl } = await import('../src/platforms/emshop.js');
  const html = detail().replace('GPT菲区卡充', '&lt;b&gt;套餐&lt;/b&gt;')
    .replace('官方渠道<p>30天质保</p>', '<p>交付&lt;code&gt;兑换码&lt;/code&gt;</p><p>30天质保</p>');
  const [product] = await crawl(null, shop, network(undefined, html).fetch);
  const projected = projectShopText({ ratingText: product.ratingText });
  assert.equal(projected.name, '<b>套餐</b>');
  assert.equal(projected.description, '交付<code>兑换码</code>\n30天质保');
});

test('EMShop crawls only internal detail-backed SKU quotes without following referral cards or executing scripts', async () => {
  const { crawl, probe } = await import('../src/platforms/emshop.js');
  const net = network(undefined, detail().replace('</script></div>', '</script><script>throw new Error("Never execute")</script></div>'));
  let completed = 0;
  const products = await crawl(null, shop, net.fetch, { onListComplete: () => completed++ });
  assert.deepEqual(products.map(p => [p.externalId, p.price, p.inStock]), [['1:1', '114', true], ['1:8', '650', false]]);
  assert.equal(products[0].url, 'https://geminipro.vip/post-1.html');
  assert.equal(products[0].imageUrl, 'https://geminipro.vip/cover.png');
  assert.match(products[0].sourceData.evidence, /30天质保/);
  assert.equal(completed, 1);
  assert.equal(net.calls.length, 2);
  assert.ok(net.calls.every(c => new URL(c.url).origin === 'https://geminipro.vip' && !c.init.body && !c.init.method && c.init.redirect === 'error'));
  assert.equal((await probe(shop, network().fetch)).length, 2);
});

test('EMShop requires a complete counted unpaginated catalog and unique internal product IDs', async () => {
  const { crawl } = await import('../src/platforms/emshop.js');
  for (const list of [catalog(card(1), 2), catalog(card(1) + card(1)), catalog().replace('category-tab-count', 'unknown-count'), catalog().replace('</body>', '<nav class="pagination"><a href="/post-list.html?page=2">2</a></nav></body>'), catalog().replace('/post-1.html', '/unknown.html'), catalog().replace('</html>', '')]) {
    await assert.rejects(crawl(null, shop, network(list).fetch), /emshop goods HTML:/);
  }
  assert.deepEqual(await crawl(null, shop, network(catalog('', 0)).fetch), []);
});

test('EMShop rejects missing, duplicate, foreign or mismatched detail identity and currency', async () => {
  const { crawl } = await import('../src/platforms/emshop.js');
  const invalid = [detail(undefined, 2), detail().replace('data-goods-id="1"', 'data-goods-id="2"'), detail().replace('data-goods-id="1"', ''), detail().replace('</body>', '<button id="buyNowBtn" data-goods-id="1"></button></body>'), detail().replace('"CNY"', '"USD"'), detail().replace('rate:1', 'rate:7'), detail().replace('detail-name', 'unknown-name'), detail().replace('</html>', '')];
  for (const html of invalid) await assert.rejects(crawl(null, shop, network(undefined, html).fetch), /emshop goods HTML:/);
});

test('EMShop safely parses only JSON specs and rejects missing, repeated or malformed price and stock', async () => {
  const { crawl } = await import('../src/platforms/emshop.js');
  const mutations = [r => r.splice(0), r => r.push({ ...r[0] }), r => delete r[0].id, r => r[0].name = '', r => delete r[0].price, r => r[0].price = '', r => r[0].price = -1, r => delete r[0].stock, r => r[0].stock = -1, r => r[0].stock = '38', r => r[0].price = true];
  for (const mutate of mutations) { const rows = specs(); mutate(rows); await assert.rejects(crawl(null, shop, network(undefined, detail(rows)).fetch), /emshop goods HTML:/); }
  for (const html of [detail().replace('specs:[', 'specs:evil(['), detail().replace('GoodsDetail.init', 'Missing.init'), detail().replace('specs:', 'specs:/* injection */'), detail().replace('currencySymbol:', 'otherSymbol:'), detail().replace('],currencySymbol:', ']||[],currencySymbol:')]) await assert.rejects(crawl(null, shop, network(undefined, html).fetch));
});

test('EMShop propagates failed/truncated/interrupted reads and cancellation without reporting complete', async () => {
  const { crawl } = await import('../src/platforms/emshop.js');
  await assert.rejects(crawl(null, shop, async () => new Response('blocked', { status: 403 })));
  await assert.rejects(crawl(null, shop, async () => { throw new Error('interrupted'); }), /interrupted/);
  const controller = new AbortController(); let completed = false;
  const net = network(undefined, undefined, (_url, init) => { assert.equal(init.signal, controller.signal); controller.abort(new Error('cancelled')); });
  await assert.rejects(crawl(null, shop, net.fetch, { signal: controller.signal, onListComplete: () => completed = true }), /cancelled/);
  assert.equal(completed, false); assert.equal(net.calls.length, 1);
});

test('EMShop honors the minimum purchase stock and refuses unsupported discounts and quantity metadata', async () => {
  const { crawl } = await import('../src/platforms/emshop.js');
  const rows = specs(); rows[0].min_buy = 39;
  assert.equal((await crawl(null, shop, network(undefined, detail(rows)).fetch))[0].inStock, false);
  for (const mutate of [r => delete r[0].min_buy, r => r[0].min_buy = 0, r => r[0].max_buy = '3', r => r[0].max_buy = -1, r => { r[0].min_buy = 3; r[0].max_buy = 2; }]) {
    const changed = specs(); mutate(changed);
    await assert.rejects(crawl(null, shop, network(undefined, detail(changed)).fetch));
  }
  await assert.rejects(crawl(null, shop, network(undefined, detail().replace('discountRules:[]', 'discountRules:[{"threshold":1,"discount":1}]')).fetch));
});

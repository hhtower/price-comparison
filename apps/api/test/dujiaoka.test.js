import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProductEvidence } from '../src/standardization/fingerprint.js';
import { projectShopText } from '../src/shops/shop-text-review.js';

const shop = { url: 'https://ouvg.top/' };
const listing = ids => `<html><head><link href="/assets/unicorn/css/index.css"></head><body><div id="goodsTabContent"><div id="group-all">${ids.map(id => `<a href="/buy/${id}">商品</a>`).join('')}</div><div id="group-1">${ids.map(id => `<a href="/buy/${id}">商品</a>`).join('')}</div></div></body></html>`;
const detail = (id = '252') => `<html><body><h3 class="card-title">GPT Plus</h3><input name="gid" value="${id}"><input name="_token" value="do-not-save"><div class="card"><div class="card-header">商品描述</div><div class="card-body">30天质保</div></div><label class="formal-sku-btn" data-sku-id="9" data-sku-price="130.00" data-sku-stock="16">官方月卡 (￥130.00) / 库存 16</label><label class="formal-sku-btn disabled" data-sku-id="162" data-sku-price="125.00" data-sku-stock="0">卡充月卡 (￥125.00) / 库存 0</label></body></html>`;
const fetcher = (root = listing(['252']), item = detail()) => async (url, init) => {
  assert.ok(!init.body && !init.method); assert.equal(init.redirect, 'error');
  return new Response(new URL(url).pathname === '/' ? root : item, { headers: { 'content-type': 'text/html' } });
};

test('Dujiaoka normalizes selected labels without deriving specs from the product title', async () => {
  const { crawl } = await import('../src/platforms/dujiaoka.js');
  const html = detail().replace('官方月卡', ' Ｍｏｎｔｈｌｙ \n account ');
  const [product] = await crawl(null, shop, fetcher(undefined, html), { settlementProductIds: new Set() });
  assert.equal(product.spec, 'Monthly account');
  assert.equal(product.externalId, '252:9');
  for (const key of ['sku', 'selectedOptions', 'specification', 'spec']) assert.equal(key in product.sourceData, false);
});

test('Dujiaoka rating evidence preserves escaped text and paragraph boundaries', async () => {
  const { crawl } = await import('../src/platforms/dujiaoka.js');
  const html = detail().replace('GPT Plus', '&lt;b&gt;套餐&lt;/b&gt;')
    .replace('30天质保', '<p>交付&lt;code&gt;兑换码&lt;/code&gt;</p><p>30天质保</p>');
  const [product] = await crawl(null, shop, fetcher(undefined, html), { settlementProductIds: new Set() });
  const projected = projectShopText({ ratingText: product.ratingText });
  assert.equal(projected.name, '<b>套餐</b>');
  assert.equal(projected.description, '交付<code>兑换码</code>\n30天质保');
});

test('Ma men uses the user-confirmed zero-fee SKU price as its payment amount', async () => {
  const { crawl, settle } = await import('../src/platforms/dujiaoka.js');
  const products = await crawl(null, shop, fetcher());
  assert.equal(products[0].settlement?.totalAmount, '130.00');
  assert.equal(products[0].settlement?.price, '130.00');
  assert.equal(products[0].settlement?.quantity, 1);
  assert.equal(products[1].settlement, undefined);
  const baseline = { ...products[0] }; delete baseline.settlement;
  await settle(shop, [baseline], fetcher());
  assert.equal(baseline.settlement?.price, '130.00');
});

test('Ma men settlement rejects changed details, prices, purchase minimums and unrelated hosts', async () => {
  const { crawl, settle } = await import('../src/platforms/dujiaoka.js');
  const [sample] = await crawl(null, shop, fetcher(), { settlementProductIds: new Set() });
  for (const html of [detail().replace('130.00', '140.00'), detail().replace('30天质保', '7天质保'),
    detail().replace('data-sku-stock="16"', 'data-sku-stock="0"'),
    detail().replace('</body>', '<input name="by_amount" min="2"></body>')]) {
    const product = { ...sample };
    await settle(shop, [product], fetcher(undefined, html));
    assert.equal(product.settlement, undefined);
  }
  for (const url of ['https://other.example/', 'https://ouvg.top.evil.example/']) {
    const product = { ...sample };
    await settle({ url }, [product], async () => { throw new Error('unconfirmed host must not fetch'); });
    assert.equal(product.settlement, undefined);
  }
});

test('classic storefront estimates retain the HTML minimum and reject insufficient stock', async () => {
  const { platformForUrl } = await import('../src/platforms/index.js');
  const adapter = platformForUrl(shop.url, 'dujiaoka');
  const html = detail().replace('</body>', '<input name="by_amount" min="5"></body>');
  const [item] = await adapter.crawl(null, shop, fetcher(undefined, html));
  assert.equal(item.sourceData.minimum, 5);
  assert.equal(item.settlement.quantity, 5);
  assert.equal(item.settlement.totalAmount, '650.00');
  assert.match(item.settlement.paymentMethod, /预估/);
  const [insufficient] = await adapter.crawl(null, shop, fetcher(undefined, html.replace('data-sku-stock="16"', 'data-sku-stock="4"')));
  assert.equal(insufficient.inStock, false);
  assert.equal(insufficient.settlement, undefined);
  await assert.rejects(adapter.crawl(null, shop, fetcher(undefined, html.replace('min="5"', 'min="0"'))), /minimum/);
});

test('Ma men settlement refresh compares the normalized evidence persisted by the repository', async () => {
  const { crawl, settle } = await import('../src/platforms/dujiaoka.js');
  const html = detail().replace('GPT Plus', 'ＧＰＴ（官方）')
    .replace('30天质保', '服务地址: https://api.example.com/v1?token=private 首登质保');
  const [fresh] = await crawl(null, shop, fetcher(undefined, html), { settlementProductIds: new Set() });
  const persisted = { ...fresh, ...normalizeProductEvidence(fresh) };
  assert.notDeepEqual(persisted.sourceData, fresh.sourceData);
  await settle(shop, [persisted], fetcher(undefined, html));
  assert.equal(persisted.settlement?.totalAmount, '130.00');
  const changed = { ...fresh, ...normalizeProductEvidence(fresh) };
  await settle(shop, [changed], fetcher(undefined, html.replace('首登质保', '不提供质保')));
  assert.equal(changed.settlement, undefined);
});

test('Ma men settlement respects selection, cached prices, batch bounds and cancellation', async () => {
  const { crawl, settle } = await import('../src/platforms/dujiaoka.js');
  const [sample] = await crawl(null, shop, fetcher(), { settlementProductIds: new Set() });
  for (const options of [{ settlementProductIds: new Set() }, { needsSettlement: () => false }]) {
    await settle(shop, [{ ...sample }], async () => { throw new Error('must not fetch'); }, options);
  }
  const products = [{ ...sample }, { ...sample, externalId: '253:9', url: 'https://ouvg.top/buy/253' }], outcomes = [];
  await settle(shop, products, fetcher(), { maxSettlementProducts: 1, onSettlementResult: row => outcomes.push(row) });
  assert.equal(products[0].settlement?.price, '130.00');
  assert.equal(outcomes[1].reason, 'deferred');
  const controller = new AbortController();
  await assert.rejects(settle(shop, [{ ...sample }], async (_url, init) => {
    assert.equal(init.signal, controller.signal); controller.abort(); throw controller.signal.reason;
  }, { signal: controller.signal }), { name: 'AbortError' });
});

test('classic Dujiaoka reads the full catalog and real HTML SKU price and stock without posting orders', async () => {
  const { crawl, probe } = await import('../src/platforms/dujiaoka.js');
  const products = await crawl(null, shop, fetcher());
  assert.deepEqual(products.map(p => [p.externalId, p.price, p.inStock, p.spec]), [['252:9', '130.00', true, '官方月卡'], ['252:162', '125.00', false, '卡充月卡']]);
  assert.equal(products[0].url, 'https://ouvg.top/buy/252');
  assert.equal(products[0].sourceData.evidence, '30天质保');
  assert.ok(!JSON.stringify(products).includes('do-not-save'));
  assert.equal((await probe(shop, fetcher())).length, 2);
  assert.deepEqual(await crawl(null, shop, fetcher(listing([]))), []);
});

test('classic Dujiaoka uses single-product HTML price and stock including explicit unlimited SKU stock', async () => {
  const { crawl } = await import('../src/platforms/dujiaoka.js');
  const single = '<html><h3 class="card-title">GPT Plus</h3><input name="gid" value="252"><h6 id="display_price">价格：￥ 100.00</h6><small id="stock_tips">库存：0</small></html>';
  assert.equal((await crawl(null, shop, fetcher(undefined, single)))[0].inStock, false);
  const unlimited = detail().replace('data-sku-stock="16"', 'data-sku-stock=""');
  assert.equal((await crawl(null, shop, fetcher(undefined, unlimited)))[0].inStock, true);
});

test('classic Dujiaoka rejects incomplete catalogs, identity mismatch and malformed money or inventory', async () => {
  const { crawl } = await import('../src/platforms/dujiaoka.js');
  for (const root of [listing(['252']).replace('</html>', ''), listing(['252', '252']), listing(['252']).replace('<div id="group-1">', '<div id="group-1"><a href="/buy/9">缺失</a>'), listing(['252']).replace('/buy/252', 'https://elsewhere.example/buy/252'), '<html>挑战页面</html>', listing(['252']).replace('</body>', '<nav class="pagination"><a href="/?page=2">下一页</a></nav></body>')]) {
    await assert.rejects(crawl(null, shop, fetcher(root)));
  }
  for (const item of [detail('99'), detail().replace('data-sku-price="130.00"', 'data-sku-price=""'), detail().replace('data-sku-stock="16"', 'data-sku-stock="unknown"'), detail().replace('data-sku-id="162"', 'data-sku-id="9"')]) {
    await assert.rejects(crawl(null, shop, fetcher(undefined, item)));
  }
  await assert.rejects(crawl(null, shop, async () => new Response('', { status: 503 })));
});

test('classic Dujiaoka propagates cancellation and never reports a partial list complete', async () => {
  const { crawl } = await import('../src/platforms/dujiaoka.js');
  const controller = new AbortController(); let count = 0, complete = false;
  await assert.rejects(crawl(null, shop, async (url, init) => {
    assert.equal(init.signal, controller.signal);
    if (++count === 2) controller.abort(new Error('cancelled'));
    return fetcher()(url, init);
  }, { signal: controller.signal, onListComplete: () => complete = true }), /cancelled/);
  assert.equal(complete, false);
});

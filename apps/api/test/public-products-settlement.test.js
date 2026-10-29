import test from 'node:test';
import assert from 'node:assert/strict';
import platform from '../src/platforms/public-products-v1.js';
import { normalizeProductEvidence } from '../src/standardization/fingerprint.js';
import { withSettlementEstimates } from '../src/platforms/settlement-estimate.js';
import { buildRatingManifest, captureRatingText } from '../src/platforms/source-evidence.js';

const shop = { url: 'https://next.example' };
function fixture({ total = '111.00', rate = '2.95', fixed = '0.00', quantity = 1, version = 'v1.5.0', currency = 'CNY', channels, detail = {}, preview = {}, url = shop.url } = {}) {
  const fixtureShop = { url };
  const calls = [], reports = [];
  const product = { id: 1, slug: 'plus', title: { 'zh-CN': 'Plus' }, purchase_type: 'guest',
    min_purchase_quantity: quantity, max_purchase_quantity: 10, payment_channel_ids: [3], stock_status: 'in_stock',
    skus: [{ id: 2, is_active: true, price_amount: '111.00', stock_status: 'in_stock', spec_values: {} }], ...detail };
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    assert.equal(init.redirect, 'error');
    const path = new URL(url).pathname;
    if (path === '/api/v1/public/config') return Response.json({ status_code: 0, data: { app_version: version, currency, payment_channels: channels ?? [
      { id: 3, name: '支付宝', provider_type: 'official', channel_type: 'alipay', fee_policy: 'customer_surcharge', fee_rate: rate, fixed_fee: fixed, min_amount: '0.00', max_amount: '0.00' },
    ] } });
    if (path === '/api/v1/public/products/plus') return Response.json({ status_code: 0, data: product });
    if (path === '/api/v1/public/products') return Response.json({ status_code: 0, data: [product], pagination: { page: 1, page_size: 12, total: 1, total_page: 1 } });
    assert.equal(path, '/api/v1/guest/orders/preview');
    const body = JSON.parse(init.body);
    assert.equal(body.email, 'price-preview@example.invalid');
    assert.deepEqual(body.items, [{ product_id: 1, sku_id: 2, quantity }]);
    return Response.json({ status_code: 0, data: { currency, total_amount: total,
      items: [{ product_id: 1, sku_id: 2, quantity }], ...preview } });
  };
  const products = [{ externalId: '1:2', price: '111.00', url: `${fixtureShop.url}/products/plus`, inStock: true }];
  return { products, calls, reports, fetchImpl, run: (options = {}) => platform.settle(fixtureShop, products, fetchImpl, { onSettlementResult: row => reports.push(row), ...options }) };
}

test('Next binds all SKUs to raw localized parent title and complete bodies, preserving explicit emptiness', async () => {
  const { captureRatingText } = await import('../src/platforms/source-evidence.js');
  for (const content of [' <p>Full\n\nbody</p> ', '', undefined]) {
    const detail = { title: { 'zh-CN': '  Ｐａｒｅｎｔ · original  ' }, description: { 'zh-CN': ' Summary\n' },
      content: content === undefined ? undefined : { 'zh-CN': content },
      skus: [2, 3].map(id => ({ id, is_active: true, price_amount: '111.00', stock_status: 'in_stock', spec_values: { 'zh-CN': `sku${id}` } })) };
    const f = fixture({ detail });
    const rows = await platform.crawl(null, shop, f.fetchImpl, {
      maxSettlementProducts: 1, settlementProductIds: new Set(),
    });
    assert.equal(rows.length, 2);
    const expected = captureRatingText('1', detail.title['zh-CN'], detail.description['zh-CN'], content);
    assert.deepEqual(rows.map(row => row.ratingText), [expected, expected]);
    assert.ok(rows.every(row => row.name.includes(' · sku')));
    assert.ok(f.calls.every(call => !String(call.url).includes('/orders/preview')));
  }
});

test('Next retains public parents with only inactive SKUs in the complete rating denominator', async () => {
  const source = { ...shop, protocol: 'public-products-v1', platform: 'test' };
  const parents = [1, 2, 3].map(id => ({
    id, slug: `parent-${id}`, title: ` Parent ${id} `, description: '', ...(id === 3 ? {} : { content: ' Full body\n' }),
    skus: [1, 2].map(sku => ({ id: id * 10 + sku, is_active: id === 1, price_amount: '1.00',
      stock_status: 'in_stock', spec_values: {} })),
  }));
  const fetchImpl = async url => {
    const path = new URL(url).pathname;
    if (path === '/api/v1/public/products') return Response.json({ status_code: 0, data: parents,
      pagination: { page: 1, page_size: 12, total: parents.length, total_page: 1 } });
    const parent = parents.find(item => path === `/api/v1/public/products/${item.slug}`);
    assert.ok(parent, `unexpected request: ${path}`);
    return Response.json({ status_code: 0, data: parent });
  };
  const rows = await withSettlementEstimates(platform).crawl(null, source, fetchImpl, { settlementProductIds: new Set() });
  assert.ok(Array.isArray(rows));
  assert.deepEqual(rows.map(row => row.externalId), ['1:11', '1:12']);
  assert.equal(JSON.parse(JSON.stringify(rows)).length, 2);
  assert.deepEqual(buildRatingManifest(source, platform.id, rows, 1).units, [
    ...parents.slice(0, 2).map(parent => ({ unitId: String(parent.id),
      hash: captureRatingText(parent.id, parent.title, parent.description, parent.content).hash })),
    { unitId: '3', hash: null },
  ]);
});

test('Next distinguishes no active SKUs from a complete empty source catalog', async () => {
  const source = { ...shop, protocol: platform.id, platform: 'test' };
  const f = fixture({ detail: { description: '', content: '', skus: [{ id: 2, is_active: false }] } });
  const rows = await platform.crawl(null, source, f.fetchImpl);
  assert.deepEqual(rows, []);
  assert.deepEqual(buildRatingManifest(source, platform.id, rows, 1).units,
    [{ unitId: '1', hash: captureRatingText(1, 'Plus', '', '').hash }]);
  const empty = await platform.crawl(null, source, async () => Response.json({ status_code: 0, data: [],
    pagination: { page: 1, page_size: 12, total: 0, total_page: 0 } }));
  assert.deepEqual(buildRatingManifest(source, platform.id, empty, 1).units, []);
});

test('Next reconstructs a payment from live preview plus explicit source fees', async () => {
  const f = fixture();
  const [product] = await f.run();
  assert.equal(product.price, '111.00');
  assert.equal(product.settlement.totalAmount, '114.27');
  assert.equal(product.settlement.price, '114.27');
  assert.equal(product.settlement.paymentMethod, '支付宝');
  assert.equal(f.reports[0].status, 'verified');
});

test('Next accepts only exact Epay configurations whose unpaid checkouts confirmed final CNY amounts', async () => {
  for (const [url, version, channel, total, expected] of [
    ['https://kkfaka.xyz', 'v1.5.0', { id: 4, name: '支付宝', provider_type: 'epay', channel_type: 'alipay', fee_policy: 'customer_surcharge', fee_rate: '5.00', fixed_fee: '0.00', min_amount: '0.00', max_amount: '0.00' }, '4.00', '4.20'],
  ]) {
    const options = { url, version, channels: [channel], total, detail: { payment_channel_ids: [channel.id] } };
    assert.equal((await fixture(options).run())[0].settlement?.totalAmount, expected, url);
    for (const changes of [{ id: 99 }, { channel_type: 'wechat' }, { fee_rate: '8.00' }, { fixed_fee: '1.00' }, { fee_policy: 'none' }]) {
      const changed = { ...channel, ...changes };
      const f = fixture({ ...options, channels: [changed], detail: { payment_channel_ids: [changed.id] } });
      assert.equal((await f.run())[0].settlement, undefined, `${url} ${JSON.stringify(changes)}`);
    }
    assert.equal((await fixture({ ...options, version: 'v1.4.9' }).run())[0].settlement, undefined);
    assert.equal((await fixture({ ...options, url: url.replace('https://', 'https://fake.') }).run())[0].settlement, undefined);
  }
});

test('Next estimates the user-authorized shops from fresh public prices without login or delivery fields', async () => {
  for (const [host, listed, quantity, expected] of [
    ['morimm.com', '1.00', 1, '1.04'], ['morimm.com', '499.99', 1, '519.99'],
    ['morimm.com', '500.00', 1, '520.00'], ['morimm.com', '500.01', 1, '500.01'],
    ['morimm.com', '250.00', 2, '520.00'], ['morimm.com', '250.01', 2, '500.02'],
    ['blog.esfine.chat', '111.00', 1, '112.78'], ['tghaopifa.cc', '111.00', 1, '115.44'],
    ['ultra.makelove.cloud', '111.00', 1, '112.67'], ['kapay.shop', '111.00', 1, '111.00'],
  ]) {
    const f = fixture({ url: `https://${host}`, quantity,
      version: host === 'ultra.makelove.cloud' ? 'v1.4.3-fastguard-defense-mailgw-gateway-20261017' : 'v1.5.0',
      detail: { purchase_type: 'member', fulfillment_type: 'manual', skus: [{ id: 2, is_active: true,
        price_amount: listed, stock_status: 'in_stock', spec_values: {} }] } });
    f.products[0].price = listed;
    const [product] = await f.run();
    assert.equal(product.settlement?.totalAmount, expected, `${host} ${listed} x ${quantity}`);
    assert.equal(product.settlement?.quantity, quantity);
    assert.match(product.settlement?.paymentMethod ?? '', /预估/);
    assert.equal(f.calls.some(call => call.init.method === 'POST'), false);
  }
});

test('Next shop estimates retain origin, CNY, identity, quantity and stock fences', async () => {
  for (const options of [
    { url: 'https://fake.kapay.shop' }, { url: 'http://kapay.shop' },
    { currency: 'USD' }, { detail: { max_purchase_quantity: 0.5 } },
    { detail: { stock_status: 'out_of_stock' } }, { detail: { purchase_type: 'unknown' } },
  ]) {
    const f = fixture({ url: 'https://kapay.shop', detail: { purchase_type: 'member' }, ...options });
    assert.equal((await f.run())[0].settlement, undefined, JSON.stringify(options));
  }
  const f = fixture({ url: 'https://kapay.shop', detail: { purchase_type: 'member' } });
  f.products[0].price = '112.00';
  assert.equal((await f.run())[0].settlement, undefined);
  const small = fixture({ url: 'https://morimm.com', detail: { purchase_type: 'member',
    skus: [{ id: 2, is_active: true, price_amount: '0.99', stock_status: 'in_stock', spec_values: {} }] } });
  small.products[0].price = '0.99';
  assert.equal((await small.run())[0].settlement, undefined);
});

test('Next shop estimates work in full crawls and honor cache, selection, batches and aborts', async () => {
  const f = fixture({ url: 'https://kapay.shop', detail: { purchase_type: 'member' } });
  const [product] = await platform.crawl(null, { url: 'https://kapay.shop' }, f.fetchImpl);
  assert.equal(product.settlement?.totalAmount, '111.00');
  for (const options of [{ settlementProductIds: new Set() }, { needsSettlement: () => false }]) {
    const cached = fixture({ url: 'https://kapay.shop' });
    await cached.run(options);
    assert.equal(cached.calls.length, 0);
  }
  const limited = fixture({ url: 'https://kapay.shop' });
  limited.products.push({ ...limited.products[0], externalId: '1:3' });
  await limited.run({ maxSettlementProducts: 1 });
  assert.equal(limited.reports.find(row => row.externalId === '1:3').reason, 'deferred');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.run({ signal: controller.signal }), { name: 'AbortError' });
});

test('registered Next estimates filter live product channel restrictions before selecting public fees', async () => {
  const f = fixture({ url: 'https://morimm.com', detail: { purchase_type: 'member', payment_channel_ids: [2] }, channels: [
    { id: 1, name: '零费渠道', channel_type: 'alipay', fee_rate: '0' },
    { id: 2, name: '商品可用渠道', channel_type: 'alipay', fee_rate: '6' },
  ] });
  const [product] = await withSettlementEstimates(platform).crawl(null, { url: 'https://morimm.com' }, f.fetchImpl);
  assert.equal(product.settlement.totalAmount, '117.66');
  assert.match(product.settlement.paymentMethod, /商品可用渠道 6%/);
});

test('Next does not extrapolate a tiny zero-fee checkout to a site with no public fee rules', async () => {
  const f = fixture({ url: 'https://shop.huashengg.com', version: 'v1.0.0', total: '150.00',
    channels: [{ id: 1, name: '支付宝', provider_type: 'epay', channel_type: 'alipay', min_amount: '0.00', max_amount: '0.00' }],
    detail: { payment_channel_ids: [1] } });
  assert.equal((await f.run())[0].settlement, undefined);
});

test('Next rejects changed listing prices without changing the persisted baseline', async () => {
  const f = fixture(); f.products[0].price = '99.00';
  const [product] = await f.run();
  assert.equal(product.price, '99.00');
  assert.equal(product.settlement, undefined);
  assert.equal(f.calls.some(call => call.url.endsWith('/preview')), false);
});

test('Next retry compares fresh evidence with the canonical database representation', async () => {
  const f = fixture({ detail: { title: { 'zh-CN': 'Ｐｌｕｓ' },
    content: { 'zh-CN': '服务地址：https://api.example/v1?api_key=private&tenant=one#section' } } });
  const [fresh] = await platform.crawl(null, shop, f.fetchImpl);
  const persisted = { ...fresh, ...normalizeProductEvidence(fresh), price: '111.000000000000' };
  delete persisted.settlement;
  assert.deepEqual(persisted.sourceData.serviceEvidence.endpoints, ['https://api.example/v1?tenant=one']);
  assert.doesNotMatch(JSON.stringify(persisted.sourceData), /private/);
  f.products.splice(0, 1, persisted);
  const [retried] = await f.run();
  assert.equal(retried.settlement.totalAmount, '114.27');
  persisted.sourceData.content = '实际商品内容已变更';
  delete persisted.settlement;
  await f.run();
  assert.equal(persisted.settlement, undefined);
});

for (const [total, rate, fixed, quantity, expected] of [
  ['1.00', '0.50', '0.10', 1, '1.11'], ['10.00', '2.95', '0.20', 3, '10.50'], ['0.50', '1.00', '0.00', 1, '0.51'],
]) test(`Next rounds fees once in integer cents (${total}, ${rate}%, ${fixed})`, async () => {
  const f = fixture({ total, rate, fixed, quantity });
  const [product] = await f.run();
  assert.equal(product.settlement.totalAmount, expected);
  assert.equal(product.settlement.quantity, quantity);
});

for (const options of [
  { rate: '-1' }, { rate: '100.01' }, { fixed: 'NaN' }, { version: 'v9.0.0' }, { currency: 'USD' },
  { preview: { currency: 'USD' } }, { preview: { items: [{ product_id: 9, sku_id: 2, quantity: 1 }] } },
  { detail: { payment_channel_ids: [9] } }, { detail: { purchase_type: 'member' } },
  { channels: [{ id: 3, name: 'USDT', provider_type: 'bepusdt', channel_type: 'bepusdt', fee_rate: '0.00', fixed_fee: '0.00' }] },
]) test(`Next rejects unproven fees, identities, eligibility or currency ${JSON.stringify(options)}`, async () => {
  const f = fixture(options);
  const [product] = await f.run();
  assert.equal(product.settlement, undefined);
});

test('Next honors selection, cached results, batch limits and cancellation before requesting', async () => {
  for (const options of [{ settlementProductIds: new Set() }, { needsSettlement: () => false }]) {
    const f = fixture(); await f.run(options); assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.run({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.calls.length, 0);
  const b = fixture(); b.products.push({ ...b.products[0], externalId: '1:3' });
  await b.run({ maxSettlementProducts: 1 });
  assert.equal(b.calls.filter(call => call.url.endsWith('/preview')).length, 1);
  assert.equal(b.reports.find(row => row.externalId === '1:3').reason, 'deferred');
});

test('Next crawl completes listing and adds source-derived payment totals', async () => {
  const f = fixture(); let completed = false;
  const [product] = await platform.crawl(null, shop, f.fetchImpl, { onListComplete: () => { completed = true; } });
  assert.equal(completed, true);
  assert.equal(product.settlement.totalAmount, '114.27');
});

test('Next supports the audited legacy fee contract without fee_policy', async () => {
  const f = fixture({ version: 'v1.0.0', channels: [{ id: 3, name: '支付宝', provider_type: 'official', channel_type: 'alipay',
    fee_rate: '2.95', fixed_fee: '0.20', min_amount: '0.00', max_amount: '0.00' }] });
  const [product] = await f.run();
  assert.equal(product.settlement.totalAmount, '114.47');
});

test('Next treats an explicit zero purchase minimum as one item', async () => {
  const f = fixture({ detail: { min_purchase_quantity: 0 } });
  const [product] = await f.run();
  assert.equal(product.settlement.quantity, 1);
});

test('Next modern public channels omit fee fields when the merchant absorbs the fee', async () => {
  const f = fixture({ channels: [{ id: 3, name: '支付宝', provider_type: 'official', channel_type: 'alipay', min_amount: '0.00', max_amount: '0.00' }] });
  const [product] = await f.run();
  assert.equal(product.settlement.totalAmount, '111.00');
});

for (const detail of [{ is_sold_out: true }, { min_purchase_quantity: 3, max_purchase_quantity: 2 }, { min_purchase_quantity: -1 }]) {
  test(`Next rejects unavailable live stock or invalid purchase bounds ${JSON.stringify(detail)}`, async () => {
    const f = fixture({ detail });
    const [product] = await f.run();
    assert.equal(product.settlement, undefined);
    assert.equal(f.calls.some(call => call.url.endsWith('/preview')), false);
  });
}

for (const phase of ['products/plus', 'orders/preview']) test(`Next propagates cancellation during ${phase}`, async () => {
  const f = fixture(), controller = new AbortController();
  const fetchImpl = async (url, init) => {
    if (url.endsWith(phase)) {
      assert.equal(init.signal, controller.signal);
      controller.abort(); throw controller.signal.reason;
    }
    return f.fetchImpl(url, init);
  };
  await assert.rejects(platform.settle(shop, f.products, fetchImpl, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.products[0].settlement, undefined);
});

test('Next respects payment channel amount and product restrictions', async () => {
  const channels = [
    { id: 7, name: '不可用低费率', provider_type: 'epay', channel_type: 'alipay', fee_policy: 'customer_surcharge', fee_rate: '0', fixed_fee: '0', min_amount: '0', max_amount: '0' },
    { id: 3, name: '支付宝', provider_type: 'epay', channel_type: 'alipay', fee_policy: 'customer_surcharge', fee_rate: '2.95', fixed_fee: '0', min_amount: '112', max_amount: '0' },
  ];
  const f = fixture({ channels });
  const [product] = await f.run();
  assert.equal(product.settlement, undefined);
});

test('Next rejects epay whose private gateway configuration can change the currency and amount', async () => {
  const f = fixture({ channels: [{ id: 3, name: '支付宝', provider_type: 'epay', channel_type: 'alipay',
    fee_policy: 'customer_surcharge', fee_rate: '2.95', fixed_fee: '0.00', min_amount: '0.00', max_amount: '0.00' }] });
  const [product] = await f.run();
  assert.equal(product.settlement, undefined);
});

const ccChannel = { id: 3, name: '支付宝', provider_type: 'epay', channel_type: 'alipay',
  fee_policy: 'customer_surcharge', fee_rate: '2.95', fixed_fee: '0.00', min_amount: '0.00', max_amount: '0.00' };

for (const [total, quantity, expected] of [['111.00', 1, '114.27'], ['10.00', 1, '10.30'], ['20.00', 1, '20.59'], ['333.00', 3, '342.82']]) {
  test(`CC applies the user-confirmed 2.95 percent to the source preview (${total}, quantity ${quantity})`, async () => {
    const f = fixture({ url: 'https://cccrad.uk', channels: [ccChannel], total, quantity });
    const [product] = await f.run();
    assert.equal(product.settlement.totalAmount, expected);
    assert.equal(product.settlement.quantity, quantity);
    if (quantity === 3) assert.equal(product.settlement.price, '114.273333333333');
  });
}

for (const options of [
  { url: 'https://cccrad.uk.evil.example' }, { url: 'https://www.cccrad.uk' }, { url: 'https://cccrad.uk.' },
  { url: 'https://shop.cccrad.uk' }, { url: 'http://cccrad.uk' }, { url: 'https://cccrad.uk:8443' },
  { channels: [{ ...ccChannel, fee_rate: '3.00' }] }, { channels: [{ ...ccChannel, fixed_fee: '0.01' }] },
  { channels: [{ ...ccChannel, fee_policy: undefined }] }, { channels: [{ ...ccChannel, channel_type: 'wechat' }] },
  { currency: 'USD' }, { preview: { currency: 'USD' } },
  { preview: { items: [{ product_id: 1, sku_id: 2, quantity: 2 }] } },
]) test(`CC refuses anything outside the confirmed domain and fee contract ${JSON.stringify(options)}`, async () => {
  const f = fixture({ url: 'https://cccrad.uk', channels: [ccChannel], ...options });
  const [product] = await f.run();
  assert.equal(product.settlement, undefined);
  assert.equal(f.reports.some(row => row.status === 'verified'), false);
});

const gogoChannel = { id: 2, name: '支付宝1', provider_type: 'official', channel_type: 'alipay',
  min_amount: '0.00', max_amount: '0.00' };

test('Next official v1.4.6 omits customer fees when merchant absorbs them', async () => {
  const f = fixture({ version: 'v1.4.6', channels: [{ ...gogoChannel, id: 3 }] });
  const [product] = await f.run();
  assert.equal(product.settlement.totalAmount, '111.00');
});

test('Next official v1.4.6 adds published customer surcharges', async () => {
  const f = fixture({ version: 'v1.4.6' });
  const [product] = await f.run();
  assert.equal(product.settlement.totalAmount, '114.27');
});

test('Next supports official 1.4.8 source fee policy', async () => {
  const f = fixture({ version: 'v1.4.8' });
  const [product] = await f.run();
  assert.equal(product.settlement.totalAmount, '114.27');
});

test('Gogo exact deployed build uses the native zero-fee channel verified against one unpaid checkout', async () => {
  const f = fixture({ url: 'https://pay.gogo77.top', version: 'v1.4.8-open-alipay-1', channels: [gogoChannel],
    detail: { payment_channel_ids: [2] }, total: '2.50' });
  const [product] = await f.run();
  assert.equal(product.settlement.totalAmount, '2.50');
  assert.equal(product.settlement.paymentMethod, '支付宝1');
  assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 1);
  assert.equal(f.calls.find(call => call.init.method === 'POST').url.endsWith('/orders/preview'), true);
});

for (const options of [
  { url: 'https://other.example' }, { url: 'https://pay.gogo77.top.evil.example' }, { url: 'https://www.pay.gogo77.top' },
  { url: 'http://pay.gogo77.top' }, { version: 'v1.4.8-open-alipay-2' },
  { channels: [{ ...gogoChannel, id: 3 }] }, { channels: [{ ...gogoChannel, channel_type: 'wechat' }] },
  { channels: [{ ...gogoChannel, provider_type: 'epay' }] },
  { channels: [{ ...gogoChannel, fee_policy: 'customer_surcharge', fee_rate: '1.00', fixed_fee: '0.00' }] },
  { currency: 'USD' },
]) test(`Gogo custom build refuses unverified domains, builds and fee changes ${JSON.stringify(options)}`, async () => {
  const f = fixture({ url: 'https://pay.gogo77.top', version: 'v1.4.8-open-alipay-1', channels: [gogoChannel],
    detail: { payment_channel_ids: [2, 3] }, ...options });
  const [product] = await f.run();
  assert.equal(product.settlement, undefined);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { crawl, probe } from '../src/platforms/acg-faka.js';
import * as acg from '../src/platforms/acg-faka.js';
import { normalizeProductEvidence } from '../src/standardization/fingerprint.js';

const shop = { url: 'https://douyiner.cn/' };
const listing = (id = 17) => ({ id, name: 'GPT成品账号免费版', cover: '/cover.png', status: 1,
  delivery_way: 0, price: 5, user_price: 4, inventory_hidden: 0, category_id: 1,
  stock: 170, order_sold: 91, category: { id: 1, name: 'Gemini' }, stock_state: 4 });
const detail = (changes = {}) => ({ ...listing(), description: '<p>质保首登</p>', minimum: 0, maximum: 0,
  only_user: 0, purchase_count: 0, draft_status: 0, inventory_hidden: 0, config: [], ...changes });
const json = data => Response.json({ code: 200, msg: 'success', data });
function api({ pages = [[listing()]], total = 1, product = detail(), stock = { stock: 170, stock_state: 4 }, price = '5.00', channels = [], intercept } = {}) {
  return async (input, init = {}) => {
    const url = new URL(input), body = new URLSearchParams(init.body);
    const changed = await intercept?.(url, body, init);
    if (changed) return changed;
    if (url.pathname === '/user/api/index/data') return json([]);
    if (url.pathname === '/user/api/index/commodity') return Response.json({ code: 200, msg: 'success', total, data: pages[Number(url.searchParams.get('page')) - 1] ?? [] });
    if (url.pathname === '/user/api/index/commodityDetail') return json({ ...product, id: Number(url.searchParams.get('commodityId')) });
    if (url.pathname === '/user/api/index/stock') return json(stock);
    if (url.pathname === '/user/api/index/valuation') return json({ price });
    if (url.pathname === '/user/api/index/pay') return json(channels);
    throw new Error(`Unexpected or unsafe endpoint ${url.pathname}`);
  };
}
const run = fetchImpl => crawl(null, shop, fetchImpl);

test('explicitly missing or delisted ACG details retire only that listing, while ambiguous errors reject the snapshot', async () => {
  for (const response of [{ code: 0, msg: '商品不存在' }, { code: 200, data: detail({ status: 0 }) },
    { code: 200, data: detail({ draft_status: 1 }) }]) {
    const products = await run(api({ pages: [[listing(), listing(18)]], total: 2, intercept: url =>
      url.pathname.endsWith('/commodityDetail') && url.searchParams.get('commodityId') === '17' ? Response.json(response) : undefined }));
    assert.deepEqual(products.map(p => p.externalId), ['18']);
  }
  await assert.rejects(run(api({ intercept: url => url.pathname.endsWith('/commodityDetail')
    ? Response.json({ code: 0, msg: '服务器繁忙' }) : undefined })), /invalid response/);
  assert.deepEqual(await run(api({ pages: [[{ ...listing(), status: 0 }]] })), []);
  assert.deepEqual(await run(api({ intercept: url => url.pathname.endsWith('/stock')
    ? Response.json({ code: 0, msg: '商品不存在' }) : undefined })), []);
});

test('a missing ACG detail during supplemental quotes clears stock and cannot be estimated back into stock', async () => {
  const { withSettlementEstimates } = await import('../src/platforms/settlement-estimate.js');
  const [product] = await run(api());
  const events = [];
  await withSettlementEstimates(acg.default).settle(shop, [product], api({
    channels: [{ id: 1, name: '支付宝 5% 手续费', handle: 'Epay' }],
    intercept: url => url.pathname.endsWith('/commodityDetail') ? Response.json({ code: 0, msg: '商品不存在' }) : undefined,
  }), { onSettlementResult: event => events.push(event) });
  assert.equal(product.inStock, false);
  assert.equal(product.settlement, undefined);
  assert.equal(events[0]?.reason, 'product_unavailable');
  assert.equal(events[0]?.retryable, false);
});

test('an ACG item removed between detail and payment lookup is never estimated', async () => {
  const { withSettlementEstimates } = await import('../src/platforms/settlement-estimate.js');
  const [product] = await run(api());
  await withSettlementEstimates(acg.default).settle(shop, [product], api({
    channels: [{ id: 1, name: '支付宝 5% 手续费', handle: 'Epay' }],
    intercept: url => url.pathname.endsWith('/pay') && url.searchParams.has('itemId')
      ? Response.json({ code: 0, msg: '商品不存在' }) : undefined,
  }));
  assert.equal(product.inStock, false);
  assert.equal(product.settlement, undefined);
});

test('acg-faka uses the public quote and stock, preserving safe evidence', async () => {
  const [result] = await run(api({ price: '6.25', stock: { stock: 0, stock_state: 0 } }));
  assert.equal(result.externalId, '17');
  assert.equal(result.price, '6.25');
  assert.equal(result.inStock, false);
  assert.equal(result.sourceCategory, 'Gemini');
  assert.equal(result.url, 'https://douyiner.cn/item/17');
  assert.equal(result.imageUrl, 'https://douyiner.cn/cover.png');
  assert.match(result.sourceData.evidence, /质保首登/);
  assert.equal(result.sourceData.minimum, 0);
  assert.ok(!JSON.stringify(result.sourceData).includes('170'));
});

test('acg-faka adds public payment fees to the server total without placing an order', async () => {
  const [result] = await run(api({ price: '5.99', channels: [{ id: 11, name: '支付宝 6% 手续费', handle: 'Epay' }] }));
  assert.equal(result.settlement?.totalAmount, '6.34');
  assert.equal(result.settlement?.price, '6.34');
  assert.equal(result.settlement?.paymentMethod, '支付宝 6% 手续费');
  assert.equal(typeof acg.settle, 'function');
});

test('ACG user-confirmed fees are limited to the exact origin and observed payment channel', async () => {
  for (const [host, channel, listed, total] of [
    ['yufenggpt.com', { id: 7, name: '支付宝', handle: 'Epay' }, '5.00', '5.00'],
    ['shopcardai.click', { id: 2, name: '支付宝', handle: 'Epay' }, '110.00', '116.60'],
    ['nikoers.com', { id: 2, name: '支付宝', handle: 'Epay' }, '3.00', '3.12'],
    ['fk.gptcz.cc', { id: 10, name: '支付宝', handle: 'Alipay' }, '50.00', '51.80'],
  ]) {
    const [product] = await crawl(null, { url: `https://${host}/` }, api({ price: listed, channels: [channel] }));
    assert.equal(product.settlement?.totalAmount, total, host);
    for (const changes of [{ id: 99 }, { name: '微信支付' }, { handle: 'Other' }, { currency: 'USD' }, { status: 0 }, { cost: '-1', cost_type: 1 }]) {
      const [rejected] = await crawl(null, { url: `https://${host}/` }, api({ channels: [{ ...channel, ...changes }] }));
      assert.equal(rejected.settlement, undefined, `${host} ${JSON.stringify(changes)}`);
    }
    const [otherHost] = await crawl(null, { url: `https://fake.${host}/` }, api({ channels: [channel] }));
    assert.equal(otherHost.settlement, undefined);
  }
});

test('confirmed ACG percentages follow source cent truncation and yield to fresh explicit public fees', async () => {
  const confirmedShop = { url: 'https://nikoers.com/' }, channel = { id: 2, name: '支付宝', handle: 'Epay' };
  const [fraction] = await crawl(null, confirmedShop, api({ price: '3.13', channels: [channel] }));
  assert.equal(fraction.settlement?.totalAmount, '3.25');
  const [updated] = await crawl(null, confirmedShop, api({ price: '3.00', channels: [{ ...channel, cost_type: 1, cost: '0.05' }] }));
  assert.equal(updated.settlement?.totalAmount, '3.15');
});

test('shopcardai estimates member goods from guest valuation while other ACG shops still require eligibility', async () => {
  const channels = [{ id: 2, name: '支付宝', handle: 'Epay' }];
  const fetchImpl = api({ product: detail({ only_user: 1 }), price: '110.00', channels });
  const [product] = await crawl(null, { url: 'https://shopcardai.click/' }, fetchImpl);
  assert.equal(product.settlement?.totalAmount, '116.60');
  assert.match(product.settlement?.paymentMethod ?? '', /游客价预估/);
  const persisted = { ...product, ...normalizeProductEvidence(product) };
  delete persisted.settlement;
  await acg.settle({ url: 'https://shopcardai.click/' }, [persisted], fetchImpl);
  assert.equal(persisted.settlement?.totalAmount, '116.60');
  for (const url of ['https://fake.shopcardai.click/', 'https://nikoers.com/']) {
    const [other] = await crawl(null, { url }, fetchImpl);
    assert.equal(other.settlement, undefined);
  }
});

test('acg-faka uses the minimum quantity and selected SKU, choosing the lowest supported channel total', async () => {
  const product = detail({ minimum: 3, config: { category: { 月卡: 5 }, sku: { 地区: { 港区: 2 } } } });
  const calls = [];
  const [result] = await run(api({ product, channels: [
    { id: 11, name: '支付宝 6% 手续费', handle: 'Epay' },
    { id: 12, name: '微信支付', handle: 'Epay', cost_type: 0, cost: '0.50' },
  ], intercept: (url, body) => {
    if (url.pathname.endsWith('/valuation')) {
      calls.push(Object.fromEntries(body));
      return json({ price: body.get('num') === '3' ? '20.00' : '7.00' });
    }
  } }));
  assert.equal(result.settlement?.totalAmount, '20.50');
  assert.equal(result.settlement?.quantity, 3);
  assert.equal(result.settlement?.price, '6.833333333333');
  assert.equal(result.settlement?.paymentMethod, '微信支付');
  assert.deepEqual(calls.at(-1), { item_id: '17', num: '3', race: '月卡', 'sku[地区]': '港区' });
});

test('acg-faka accepts explicit zero fees and structured rates, refusing unknown or promotional fee text', async () => {
  for (const channel of [
    { id: 2, name: '支付宝-无手续费', handle: 'Epay' },
    { id: 2, name: '支付宝', handle: 'Epay', cost_type: 1, cost: '0.000' },
  ]) assert.equal((await run(api({ channels: [channel] })))[0].settlement?.totalAmount, '5.00');
  assert.equal((await run(api({ channels: [{ id: 2, name: '支付宝2%', handle: 'Epay', cost_type: 1, cost: '0.020' }] })))[0].settlement?.totalAmount, '5.10');
  for (const name of ['支付宝', '支付宝 6%返现', '支付宝手续费最高6%', '支付宝 手续费6%+1元', 'BEP-U(+0.01)推荐']) {
    const events = [];
    const [result] = await crawl(null, shop, api({ channels: [{ id: 2, name, handle: 'Epay' }] }), { onSettlementResult: event => events.push(event) });
    assert.equal(result.settlement, undefined, name);
    assert.equal(events[0].reason, 'no_payment_channel');
  }
});

test('ACG reads an exact bracketed percentage beside the payment name as a fee declaration', async () => {
  for (const name of ['支付宝【6%】', '微信【6%】', '支付宝（6%）', '微信支付(6%)']) {
    const [product] = await run(api({ price: '3.00', channels: [{ id: 2, name, handle: 'Epay2' }] }));
    assert.equal(product.settlement?.totalAmount, '3.18', name);
  }
  for (const name of ['支付宝【6%返现】', '支付宝【最高6%】', '支付宝【6%】返现', '支付宝【6%+1元】']) {
    const [product] = await run(api({ channels: [{ id: 2, name, handle: 'Epay2' }] }));
    assert.equal(product.settlement, undefined, name);
  }
});

test('ACG respects the item-specific checkout channels instead of a cheaper global-only channel', async () => {
  const cheap = { id: 2, name: '支付宝-无手续费', handle: 'Epay' };
  const allowed = { id: 3, name: '微信【6%】', handle: 'Epay' };
  for (const [channels, expected] of [[[allowed], '5.30'], [[{ ...cheap, name: '支付宝【6%】' }], '5.30'],
    [[], undefined], [[{ ...allowed, cost: '-1', cost_type: 1 }], undefined]]) {
    const [product] = await run(api({ price: '5.00', channels: [cheap, allowed], intercept: url => {
      if (url.pathname.endsWith('/pay') && url.searchParams.get('itemId') === '17') return json(channels);
    } }));
    assert.equal(product.settlement?.totalAmount, expected);
  }
});

test('acg-faka settlement respects selection, cache, limits, failed quotes and cancellation', async () => {
  assert.equal(typeof acg.settle, 'function');
  const [base] = await probe(shop, api());
  const products = [1, 2, 3, 4, 5].map(externalId => ({ ...structuredClone(base), externalId: String(externalId), inStock: externalId !== 5 }));
  const reports = [], calls = [];
  await acg.settle(shop, products, api({ channels: [{ id: 2, name: '支付宝（手续费2%）', handle: 'Epay' }], intercept: (url, body) => { calls.push(url.pathname); } }), {
    settlementProductIds: new Set(['2', '3', '4']), needsSettlement: product => product.externalId !== '2', maxSettlementProducts: 1,
    onSettlementResult: report => reports.push(report),
  });
  assert.equal(products[2].settlement?.totalAmount, '5.10');
  assert.equal(calls.filter(path => path.endsWith('/valuation')).length, 1);
  assert.deepEqual(reports.map(r => [r.externalId, r.reason ?? r.status]), [['1', 'not_selected'], ['2', 'recently_verified'], ['5', 'out_of_stock'], ['3', 'verified'], ['4', 'deferred']]);
  const controller = new AbortController();
  await assert.rejects(acg.settle(shop, [products[0]], api({ channels: [{ id: 2, name: '支付宝-无手续费', handle: 'Epay' }], intercept: url => { if (url.pathname.endsWith('/valuation')) controller.abort(); } }), { signal: controller.signal }), { name: 'AbortError' });
  const [invalid] = await acg.settle(shop, [products[0]], api({ channels: [{ id: 2, name: '支付宝-无手续费', handle: 'Epay' }], price: 'NaN' }));
  assert.equal(invalid.settlement, undefined);
});

test('acg-faka settlement rejects changed prices and unknown fees without changing persisted baseline evidence', async () => {
  const [product] = await probe(shop, api());
  const snapshot = structuredClone(product), reports = [];
  await acg.settle(shop, [product], api({ price: '6.00', channels: [{ id: 2, name: '支付宝-无手续费', handle: 'Epay' }] }), { onSettlementResult: event => reports.push(event) });
  assert.deepEqual(product, snapshot);
  assert.equal(reports[0].reason, 'invalid_quote');
  for (const channel of [
    { id: 2, name: '支付宝', cost_type: 1, cost: '-0.01' },
    { id: 2, name: '支付宝', cost: '0.01' },
    { id: 2, name: '支付宝-无手续费', status: 0 },
    { id: 2, name: '支付宝-无手续费', currency: 'USD' },
    { id: 2, name: '支付宝-无手续费', min_amount: '10' },
    { id: 2, name: '支付宝-无手续费', max_amount: '4' },
  ]) {
    const [result] = await acg.settle(shop, [structuredClone(snapshot)], api({ channels: [channel] }));
    assert.equal(result.settlement, undefined);
  }
});

test('acg-faka settlement reports HTTP blocking and refuses malformed totals without losing the list', async () => {
  const reports = [];
  const [result] = await crawl(null, shop, api({ intercept: url => url.pathname.endsWith('/pay') ? new Response('', { status: 403 }) : undefined }), { onSettlementResult: event => reports.push(event) });
  assert.equal(result.price, '5.00');
  assert.equal(result.settlement, undefined);
  assert.deepEqual(reports[0], { externalId: '17', status: 'failed', reason: 'blocked', retryable: true });
  assert.equal(acg.purchaseQuantity({ sourceData: { minimum: 0, only_user: 1 } }), undefined);
});

test('acg-faka settlement refresh rejects changed identities, rules and stock even when the price matches', async () => {
  const [baseline] = await probe(shop, api());
  for (const changes of [
    { product: detail({ name: '不同商品' }) },
    { product: detail({ description: '已改为另一种账号' }) },
    { product: detail({ minimum: 3 }) },
    { product: detail({ maximum: 1 }) },
    { product: detail({ only_user: 1 }) },
    { product: detail({ config: { category: { 月卡: 5 } } }) },
    { stock: { stock: 0, stock_state: 0 } },
  ]) {
    const product = structuredClone(baseline), reports = [];
    await acg.settle(shop, [product], api({ ...changes, channels: [{ id: 2, name: '支付宝-无手续费', handle: 'Epay' }] }), { onSettlementResult: event => reports.push(event) });
    const unavailable = changes.stock || changes.product?.only_user === 1 || changes.product?.config?.category;
    assert.deepEqual(product, unavailable ? { ...baseline, inStock: false } : baseline);
    assert.notEqual(reports[0]?.status, 'verified');
  }
});

test('ACG supplemental estimates retire a removed SKU instead of renewing its price', async () => {
  const { withSettlementEstimates } = await import('../src/platforms/settlement-estimate.js');
  const wrapped = withSettlementEstimates(acg);
  const [product] = await wrapped.crawl(null, shop, api({ product: detail({ config: { category: { old: 5 } } }) }));
  delete product.settlement;
  const reports = [];
  await wrapped.settle(shop, [product], api({ product: detail({ config: { category: { replacement: 5 } } }),
    channels: [{ id: 2, name: '支付宝-无手续费', handle: 'Epay' }] }),
    { onSettlementResult: event => reports.push(event) });
  assert.equal(product.inStock, false);
  assert.equal(product.settlement, undefined);
  assert.equal(reports[0]?.reason, 'product_unavailable');
});

test('acg-faka refresh compares the same sanitized evidence stored by the product repository', async () => {
  const source = detail({ description: '服务地址: https://api.example.com/v1?token=private\n使用说明，首登质保', name: 'ＧＰＴ（官方）' });
  const [fresh] = await probe(shop, api({ product: source }));
  const persisted = { ...fresh, ...normalizeProductEvidence(fresh) };
  assert.notDeepEqual(persisted.sourceData, fresh.sourceData);
  await acg.settle(shop, [persisted], api({ product: source, channels: [{ id: 2, name: '支付宝-无手续费', handle: 'Epay' }] }));
  assert.equal(persisted.settlement?.totalAmount, '5.00');
});

test('acg-faka refresh sends original variant labels rather than normalized database display text', async () => {
  const source = detail({ minimum: 3, config: { category: { '（月卡）': 5 } } });
  const [fresh] = await probe(shop, api({ product: source }));
  const persisted = { ...fresh, ...normalizeProductEvidence(fresh) };
  await acg.settle(shop, [persisted], api({ product: source, channels: [{ id: 2, name: '支付宝-无手续费', handle: 'Epay' }], intercept: (url, body) => {
    if (url.pathname.endsWith('/valuation') && body.get('num') === '3') return json({ price: body.get('race') === '（月卡）' ? '15.00' : '100.00' });
  } }));
  assert.equal(persisted.settlement?.totalAmount, '15.00');
});

test('acg-faka follows total through short and empty permission-filtered pages', async () => {
  const products = await run(api({ total: 25, pages: [[], [listing(18)], [listing(19)]] }));
  assert.deepEqual(products.map(x => x.externalId), ['18', '19']);
  assert.deepEqual(await run(api({ total: 0, pages: [[]] })), []);
});

test('acg-faka rejects moving pagination, duplicate identities, and partial failures', async () => {
  for (const intercept of [
    url => url.searchParams.get('page') === '2' ? Response.json({ code: 200, total: 14, data: [] }) : undefined,
    url => url.searchParams.get('page') === '2' ? Response.json({ code: 200, total: 13, data: [listing()] }) : undefined,
    url => url.searchParams.get('page') === '2' ? new Response('', { status: 503 }) : undefined,
    url => url.pathname.endsWith('commodityDetail') ? json(detail({ id: 99 })) : undefined,
  ]) await assert.rejects(run(api({ total: 13, intercept })));
  for (const payload of [{ code: 200, data: [] }, { code: 200, total: -1, data: [] }, { code: 200, total: 1, data: [listing(), listing()] }]) {
    await assert.rejects(run(api({ intercept: url => url.pathname.endsWith('/commodity') ? Response.json(payload) : undefined })));
  }
});

test('acg-faka bounds flat pagination by the stable total and preserves list statistics', async () => {
  const requests = [], reports = [];
  const products = await crawl(null, shop, api({ total: 25, pages: [[listing()], [], [listing(19)]],
    intercept: url => {
      if (url.pathname.endsWith('/commodity')) requests.push(Number(url.searchParams.get('page')));
    },
  }), { onListStats: stats => reports.push(stats) });
  assert.deepEqual(products.map(product => product.externalId), ['17', '19']);
  assert.deepEqual(requests, [1, 2, 3]);
  assert.deepEqual(reports, [{ unique: 2, duplicates: 0, categories: 0, categoryClaims: 0, flatTotal: 25 }]);
});

test('acg-faka rejects invalid totals and aggregate overflow without completing a list', async () => {
  for (const total of [null, '1', -1, 1.5, Infinity, 12001]) {
    await assert.rejects(run(api({ total })), /invalid pagination/);
  }
  let completed = false;
  await assert.rejects(crawl(null, shop, api({ total: 13,
    pages: [Array.from({ length: 12 }, (_, index) => listing(index + 1)), [listing(13), listing(14)]],
  }), { onListComplete: () => { completed = true; } }), /invalid pagination/);
  assert.equal(completed, false);
});

test('acg-faka propagates cancellation while discovering categories or later list pages', async () => {
  for (const during of ['/user/api/index/data', '/user/api/index/commodity']) {
    const controller = new AbortController();
    let completed = false;
    await assert.rejects(crawl(null, shop, api({ total: 13, intercept: url => {
      if (url.pathname === during && (during.endsWith('/data') || url.searchParams.get('page') === '2')) {
        controller.abort();
        controller.signal.throwIfAborted();
      }
    } }), { signal: controller.signal, onListComplete: () => { completed = true; } }), { name: 'AbortError' });
    assert.equal(completed, false);
  }
});

test('acg-faka quotes every race and SKU combination with its own stock', async () => {
  const product = detail({ config: { category: { 月卡: '5', 年卡: '50' }, sku: { 地区: { 美区: 0, 港区: 2 } } } });
  const products = await run(api({ product, intercept: (url, body) => {
    const race = body.get('race'), region = body.get('sku[地区]');
    if (url.pathname.endsWith('/valuation')) return json({ price: race === '年卡' ? (region === '港区' ? '52.00' : '50.00') : (region === '港区' ? '7.00' : '5.00') });
    if (url.pathname.endsWith('/stock')) return json({ stock: region === '港区' ? 0 : 3, stock_state: region === '港区' ? 0 : 1 });
  } }));
  assert.equal(products.length, 4);
  assert.equal(new Set(products.map(x => x.externalId)).size, 4);
  assert.deepEqual(products.map(x => [x.spec, x.price, x.inStock]), [
    ['类型: 月卡 / 规格.地区: 港区', '7.00', false], ['类型: 月卡 / 规格.地区: 美区', '5.00', true],
    ['类型: 年卡 / 规格.地区: 港区', '52.00', false], ['类型: 年卡 / 规格.地区: 美区', '50.00', true],
  ]);
  assert.equal('selectedOptions' in products[0].sourceData, false);
  assert.equal(products[0].externalId, `17:${encodeURIComponent(JSON.stringify({ race: '月卡', sku: { 地区: '港区' } }))}`);
});

for (const value of ['月卡', '独享']) {
  test(`acg-faka keeps category and same-named SKU separate with ${value === '月卡' ? 'equal' : 'different'} values`, async () => {
    const product = detail({ config: { category: { 月卡: 5 }, sku: { 类型: { [value]: 0 } } } });
    const calls = [];
    const [result] = await run(api({ product, intercept: (url, body) => {
      if (initIsQuote(url)) calls.push(Object.fromEntries(body));
    } }));
    assert.equal(result.spec, `类型: 月卡 / 规格.类型: ${value}`);
    assert.equal(result.externalId, `17:${encodeURIComponent(JSON.stringify({ race: '月卡', sku: { 类型: value } }))}`);
    assert.deepEqual(calls, Array(2).fill({ item_id: '17', num: '1', race: '月卡', 'sku[类型]': value }));
  });
}
const initIsQuote = url => ['/user/api/index/stock', '/user/api/index/valuation'].includes(url.pathname);

test('acg-faka probe previews at most two complete combinations within six requests', async () => {
  let count = 0;
  const send = api({ product: detail({ config: { category: { 一: 1, 二: 2, 三: 3 } } }), intercept: (url, body, init) => {
    count++;
    if (initIsQuote(url)) {
      assert.equal(init.method, 'POST');
      assert.equal(body.get('num'), '1');
      assert.equal(body.get('item_id'), '17');
      assert.ok(body.get('race'));
    }
  } });
  const preview = await probe(shop, send);
  assert.equal(preview.length, 2);
  assert.equal(count, 6);
});

test('acg-faka accepts hidden stock only with explicit stock state', async () => {
  const [result] = await run(api({ product: detail({ inventory_hidden: 1 }), stock: { stock: '非常多', stock_state: 4 } }));
  assert.equal(result.inStock, true);
  for (const stock of [{ stock: '充足' }, { stock: null, stock_state: 4 }, { stock: 0, stock_state: 4 }, { stock: 3, stock_state: 0 }, { stock: 1, stock_state: 5 }]) {
    await assert.rejects(run(api({ stock })), /stock/i);
  }
  for (const value of ['1.5', 'Infinity']) await assert.rejects(run(api({ product: detail({ inventory_hidden: 1 }), stock: { stock: value, stock_state: 1 } })), /stock/i);
});

test('acg-faka treats a hidden-inventory numeric count as decorative and trusts the public band', async () => {
  const [decorative] = await run(api({ product: detail({ inventory_hidden: 1 }), stock: { stock: 9999767, stock_state: 1 } }));
  assert.equal(decorative.inStock, true);
  const [soldOut] = await run(api({ product: detail({ inventory_hidden: 1 }), stock: { stock: 9999767, stock_state: 0 } }));
  assert.equal(soldOut.inStock, false);
});

test('acg-faka refuses an unknown hidden quantity at the minimum purchase boundary', async () => {
  const product = detail({ inventory_hidden: 1, minimum: 10 });
  await assert.rejects(run(api({ product, stock: { stock: '一般', stock_state: 2 } })), /stock/i);
  const [sold] = await run(api({ product, stock: { stock: '即将售罄', stock_state: 1 } }));
  assert.equal(sold.inStock, false);
  const [available] = await run(api({ product, stock: { stock: '充足', stock_state: 3 } }));
  assert.equal(available.inStock, true);
});

test('acg-faka rejects incomplete configuration, quote, inventory and variant reads', async () => {
  for (const product of [detail({ config: null }), detail({ config: { sku: { 地区: [] } } }), detail({ config: { category: { 月卡: null } } })]) {
    await assert.rejects(run(api({ product })));
  }
  for (const price of [null, '', -1, 'NaN']) await assert.rejects(run(api({ price })), /price/i);
  await assert.rejects(run(api({ product: detail({ config: { category: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`规格${i}`, 1])) } }) })), /combination/i);
  await assert.rejects(run(api({ product: detail({ config: { category: { 月卡: 1, 年卡: 2 } } }), intercept: (url, body) =>
    url.pathname.endsWith('/stock') && body.get('race') === '月卡' ? new Response('', { status: 503 }) : undefined })));
});

test('acg-faka propagates aborts and never emits a partial snapshot', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(crawl(null, shop, api(), { signal: controller.signal }), { name: 'AbortError' });
  const duringQuote = new AbortController();
  await assert.rejects(crawl(null, shop, api({ intercept: url => {
    if (url.pathname.endsWith('/valuation')) duringQuote.abort();
  } }), { signal: duringQuote.signal }), { name: 'AbortError' });
});

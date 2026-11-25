import test from 'node:test';
import assert from 'node:assert/strict';
import * as estimates from '../src/platforms/settlement-estimate.js';
import { readSettlementFees as publicFees } from '../src/platforms/public-products-v1.js';
import { readSettlementFees as acgFees, settlementFeeKey as acgFeeKey } from '../src/platforms/acg-faka.js';
import { platformForUrl } from '../src/platforms/index.js';
import { collectSettlements, isEstimatedSettlement } from '../src/platforms/settlement.js';

const product = (overrides = {}) => ({ externalId: '1', name: 'Plus', url: 'https://example.com/item/1', price: '100.00', inStock: true, ...overrides });
const shop = { url: 'https://example.com/' };
const publicFeeConfig = { settlementFeePath: '/api/v1/public/config', readSettlementFees: publicFees, preferPublicSettlementFees: true,
  settlementPaymentChannelIds: product => product.sourceData?.payment_channel_ids };

test('an adapter owns fee parsing and product keys for an unrelated protocol', async () => {
  const items = [product({ externalId: 'sku/a' }), product({ externalId: 'sku/b' })];
  const adapter = estimates.withSettlementEstimates({
    id: 'unrelated', hosts: [], settlementFeePath: '/fees',
    settlementFeeKey: item => String(item.externalId),
    readSettlementFees: (payload, url) => ({ key: url.searchParams.get('sku'),
      fees: [{ min: 0n, max: 0n, cost: () => BigInt(payload.surcharge), label: 'Custom' }] }),
    async settle(_shop, products, fetch) {
      for (const item of products) await fetch(`https://example.com/fees?sku=${encodeURIComponent(item.externalId)}`);
    },
  });
  await adapter.settle(shop, items, async url => Response.json({
    surcharge: new URL(url).searchParams.get('sku') === 'sku/a' ? '100' : '250',
  }));
  assert.deepEqual(items.map(item => item.settlement.price), ['101.00', '102.50']);
});

test('unknown payment costs fall back to the listed price with exact cent arithmetic', () => {
  const quote = estimates.estimateSettlement(shop, product({ price: '0.05' }), 10);
  assert.equal(quote.totalAmount, '0.50');
  assert.equal(quote.price, '0.05');
  assert.equal(quote.quantity, 10);
  assert.match(quote.paymentMethod, /预估.*售价/);
  for (const price of ['-1', 'NaN', '1e3', '1.001', '1000000000000.00']) {
    assert.equal(estimates.estimateSettlement(shop, product({ price }), 1), undefined, price);
  }
  for (const quantity of [undefined, 0, -1, 1.1, '1', 2147483648]) {
    assert.equal(estimates.estimateSettlement(shop, product(), quantity), undefined);
  }
});

test('confirmed and published rates override the default and morimm uses the order total boundary', () => {
  for (const [host, price, quantity, total] of [
    ['kapay.shop', '100', 1, '100.00'], ['shop.txyxt.dpdns.org', '100', 1, '100.00'],
    ['gpthub.ciyuanapi.ai', '100', 1, '100.00'], ['shop.aictk.shop', '100', 1, '100.00'],
    ['shop.callai.one', '100', 1, '101.60'], ['tehuio.com', '100', 1, '105.00'],
    ['fk.10886.xyz', '100', 1, '106.00'], ['cccrad.uk', '100', 1, '102.95'],
    ['morimm.com', '250', 2, '520.00'], ['morimm.com', '250.01', 2, '500.02'],
    ['ultra.makelove.cloud', '100', 1, '101.50'], ['shopcardai.click', '110', 1, '116.60'],
  ]) {
    const quote = estimates.estimateSettlement({ url: `https://${host}/` }, product({ price }), quantity);
    assert.equal(quote?.totalAmount, total, host);
    assert.match(quote.paymentMethod, /预估/);
  }
  assert.equal(estimates.estimateSettlement({ url: 'https://kapay.shop.evil/' }, product(), 1).price, '100.00');
});

test('runtime retries prefer real quotes and estimate failed or deferred prices without extra requests', async () => {
  const items = ['real', 'failed', 'deferred', 'private', 'sold', 'cached'].map(externalId => product({ externalId, inStock: externalId !== 'sold' }));
  const native = { id: 'fixture', hosts: [], purchaseQuantity: () => 1, async settle(_shop, products, _fetch, options) {
    products[0].settlement = { price: '109.00', paymentMethod: '支付宝' };
    for (const [externalId, status, reason] of [['real', 'verified'], ['failed', 'failed', 'request_failed'],
      ['deferred', 'skipped', 'deferred'], ['private', 'skipped', 'not_selected'], ['sold', 'skipped', 'out_of_stock'], ['cached', 'skipped', 'recently_verified']]) {
      options.onSettlementResult({ externalId, status, reason, retryable: status === 'failed' });
    }
    return products;
  } };
  const outcomes = [];
  const adapter = estimates.withSettlementEstimates(native);
  await adapter.settle(shop, items, () => { throw Error('no extra requests'); }, {
    maxSettlementProducts: 2, settlementProductIds: new Set(['real', 'failed', 'deferred', 'cached']),
    needsSettlement: p => p.externalId !== 'cached', onSettlementResult: r => outcomes.push(r),
  });
  assert.equal(items[0].settlement.price, '109.00');
  assert.equal(items[1].settlement.price, '100.00');
  assert.equal(items[2].settlement.price, '100.00');
  assert.ok(items.slice(3).every(p => !p.settlement));
  assert.equal(outcomes.filter(r => r.status === 'verified').length, 1);
  assert.deepEqual(outcomes.find(r => r.externalId === 'failed'), {
    externalId: 'failed', status: 'failed', reason: 'request_failed', retryable: true, estimated: true,
  });
  assert.deepEqual(outcomes.find(r => r.externalId === 'deferred'), {
    externalId: 'deferred', status: 'skipped', reason: 'deferred', retryable: false, estimated: true,
  });
});

test('list-only protocols get estimates in both full crawls and independent retries', async () => {
  const native = { id: 'acg-faka-v5', hosts: [],
    purchaseQuantity: product => Number(product.sourceData?.quantityRestriction?.min) || 1,
    crawl: async () => [product({sourceData: { quantityRestriction: { min: 5 } }})] };
  const adapter = estimates.withSettlementEstimates(native);
  assert.equal(adapter.canVerifySettlement, false);
  const outcomes = [], options = { onSettlementResult: result => outcomes.push(result) };
  const [listed] = await adapter.crawl(null, shop, undefined, options);
  assert.equal(listed.settlement.totalAmount, '500.00');
  assert.equal(listed.settlement.quantity, 5);
  const [retried] = await adapter.settle(shop, [product()], undefined, options);
  assert.equal(retried.settlement.price, '100.00');
  assert.deepEqual(outcomes, [
    { externalId: '1', status: 'estimated', reason: 'verification_unsupported', retryable: false, estimated: true },
    { externalId: '1', status: 'estimated', reason: 'verification_unsupported', retryable: false, estimated: true },
  ]);
  for (const protocol of ['catcard', 'acg-faka-v5', 'orion-key', 'dujiaoka', 'emshop']) {
    assert.equal(typeof platformForUrl(shop.url, protocol).settle, 'function', protocol);
  }
});

test('estimated fallback preserves terminal fee diagnostics without scheduling retries', async () => {
  const { SettlementUnavailableError, collectSettlements } = await import('../src/platforms/settlement.js');
  const adapter = estimates.withSettlementEstimates({ id: 'fixture', hosts: [], settle(_shop, products, _fetch, options) {
    return collectSettlements(products, { quantity: () => 1,
      channel: async () => { throw new SettlementUnavailableError('payment_fee_unknown'); },
      quote: async () => assert.fail('missing fees must not request a quote'),
    }, options);
  } });
  const outcomes = [], products = [product()];
  await adapter.settle(shop, products, () => assert.fail('no fallback network requests'), {
    onSettlementResult: row => outcomes.push(row),
  });
  assert.equal(products[0].settlement.kind, 'estimated');
  assert.deepEqual(outcomes, [{ externalId: '1', status: 'failed', reason: 'payment_fee_unknown', retryable: false, estimated: true }]);
});

test('verification capability reflects the native adapter and preserves an explicit opt-out', () => {
  const native = { id: 'fixture', hosts: [], async settle(_shop, products) { return products; } };
  assert.equal(estimates.withSettlementEstimates(native).canVerifySettlement, true);
  const disabled = estimates.withSettlementEstimates({ ...native, canVerifySettlement: false });
  assert.equal(disabled.canVerifySettlement, false);
  assert.equal(typeof disabled.settle, 'function');
  assert.equal(estimates.withSettlementEstimates(disabled).canVerifySettlement, false);
  for (const protocol of ['catcard', 'acg-faka-v5', 'orion-key', 'emshop']) {
    assert.equal(platformForUrl(shop.url, protocol).canVerifySettlement, false, protocol);
  }
  assert.equal(platformForUrl(shop.url, 'public-products-v1').canVerifySettlement, true);
});

test('adapter estimate configuration supplies quantity, fee endpoint and allowed channels without platform IDs', async () => {
  const calls = [], item = product({ sourceData: { quantity: 3, channels: [2] } });
  const adapter = estimates.withSettlementEstimates({ id: 'custom-adapter', hosts: [],
    purchaseQuantity: product => product.sourceData.quantity,
    settlementFeePath: '/fees', readSettlementFees: publicFees, preferPublicSettlementFees: true,
    settlementPaymentChannelIds: product => product.sourceData.channels,
  });
  await adapter.settle(shop, [item], async url => {
    calls.push(new URL(url).pathname);
    return Response.json({ status_code: 0, data: { currency: 'CNY', payment_channels: [
      { id: 1, name: 'Alipay zero', channel_type: 'alipay', fee_rate: '0' },
      { id: 2, name: 'Alipay fee', channel_type: 'alipay', fee_rate: '2.50' },
    ] } });
  });
  assert.deepEqual(calls, ['/fees']);
  assert.equal(item.settlement.quantity, 3);
  assert.equal(item.settlement.totalAmount, '307.50');
});

test('an estimated quote with a plain payment label reports an estimate', async () => {
  const item = product(), outcomes = [];
  const adapter = estimates.withSettlementEstimates({
    id: 'fixture', hosts: [], async settle(_shop, products, _fetch, options) {
      products[0].settlement = { price: '104.00', totalAmount: '104.00', quantity: 1,
        verifiedAt: new Date().toISOString(), paymentMethod: '支付宝', kind: 'estimated' };
      options.onSettlementResult({ externalId: '1', status: 'estimated', reason: 'estimated', retryable: false });
      return products;
    },
  });
  await adapter.settle(shop, [item], () => { throw Error('network forbidden'); }, {
    onSettlementResult: result => outcomes.push(result),
  });
  assert.equal(item.settlement.kind, 'estimated');
  assert.equal(isEstimatedSettlement(item.settlement), true);
  assert.equal(outcomes[0].status, 'estimated');
});

test('Prism has no verification capability but still computes estimates during list crawls', async () => {
  const shop = { url: 'https://shop.558686.xyz/' }, outcomes = [], calls = [];
  const adapter = platformForUrl(shop.url);
  assert.equal(adapter.canVerifySettlement, false);
  assert.equal(typeof adapter.settle, 'function');
  const [item] = await adapter.crawl(null, shop, async url => {
    calls.push(String(url));
    assert.equal(String(url), 'https://shop.558686.xyz/api/catalog');
    return Response.json({ products: [{ id: 3, name: 'Plus', price: 680000, stock: 25 }] });
  }, { cnyPerUsd: '0.1400', onSettlementResult: result => outcomes.push(result) });
  assert.deepEqual(calls, ['https://shop.558686.xyz/api/catalog']);
  assert.equal(item.settlement.price, '4.86');
  assert.equal(item.settlement.paymentMethod, 'USDT 汇率折算（预估）');
  assert.deepEqual(outcomes, [
    { externalId: '3', status: 'estimated', reason: 'verification_unsupported', retryable: false, estimated: true },
  ]);
});

for (const entry of ['crawl', 'settle']) test(`${entry} preserves deferred outcomes after five actual quotes while displaying estimates`, async () => {
  const items = Array.from({ length: 7 }, (_, index) => product({ externalId: String(index) }));
  const requested = [], outcomes = [];
  const settle = (_shop, products, _fetch, options) => collectSettlements(products, {
    quantity: () => 1,
    channel: async () => ({ show_name: 'Alipay' }),
    quote: async item => {
      requested.push(item.externalId);
      return { code: 1, data: { total_amount: '1.00' } };
    },
  }, options);
  const adapter = estimates.withSettlementEstimates({ id: 'fixture', hosts: [], settle,
    crawl: (_page, shop, fetchImpl, options) => settle(shop, items, fetchImpl, options) });
  const options = { maxSettlementProducts: 5, onSettlementResult: result => outcomes.push(result) };
  const fetchImpl = () => { throw Error('no network'); };
  const result = entry === 'crawl' ? await adapter.crawl(null, shop, fetchImpl, options)
    : await adapter.settle(shop, items, fetchImpl, options);
  assert.equal(result.length, 7);
  assert.deepEqual(requested, ['0', '1', '2', '3', '4']);
  assert.equal(outcomes.filter(r => r.status === 'verified').length, 5);
  assert.ok(result.slice(0, 5).every(item => item.settlement.price === '1.00'));
  assert.deepEqual(outcomes.slice(5), [
    { externalId: '5', status: 'skipped', reason: 'deferred', retryable: false, estimated: true },
    { externalId: '6', status: 'skipped', reason: 'deferred', retryable: false, estimated: true },
  ]);
  assert.ok(result.slice(5).every(item => item.settlement.price === '100.00'));
});

for (const phase of ['channel', 'quote']) test(`fallback preserves native ${phase} request failures and their retry policy`, async () => {
  for (const [name, reason, retryable] of [
    ['Error', 'request_failed', true],
    ['CrawlerBlockedError', 'blocked', true],
    ['ProxyAuthenticationError', 'proxy_authentication', false],
  ]) {
    const items = [product()], outcomes = [];
    const adapter = platformForUrl('https://wzyp.cn/shop/test');
    await adapter.settle({ url: 'https://wzyp.cn/shop/test' }, items, async url => {
      if (phase === 'quote' && String(url).includes('getUserChannel')) {
        return Response.json({ code: 1, data: [{ id: 1, status: 1, custom_status: 1, show_name: 'Alipay' }] });
      }
      throw Object.assign(new Error('request failure'), { name });
    }, { onSettlementResult: result => outcomes.push(result) });
    assert.equal(items[0].settlement.price, '100.00');
    assert.deepEqual(outcomes, [{ externalId: '1', status: 'failed', reason, retryable, estimated: true }]);
  }
});

for (const reason of ['blocked', 'proxy_authentication']) test(`Next detail ${reason} stops fallback configuration requests`, async () => {
  const shop = { url: 'https://morimm.com' }, calls = [], outcomes = [];
  const items = ['1', '2'].map(id => product({ externalId: `${id}:1`, url: `${shop.url}/products/plus-${id}` }));
  await platformForUrl(shop.url, 'public-products-v1').settle(shop, items, async url => {
    calls.push(new URL(url).pathname);
    if (reason === 'blocked') return new Response('', { status: 403 });
    throw Object.assign(new Error('proxy credentials rejected'), { name: 'ProxyAuthenticationError' });
  }, { onSettlementResult: result => outcomes.push(result) });
  assert.deepEqual(calls, ['/api/v1/public/products/plus-1']);
  assert.ok(items.every(item => item.settlement?.totalAmount === '104.00'));
  assert.deepEqual(outcomes, items.map(item => ({
    externalId: item.externalId, status: 'failed', reason,
    retryable: reason === 'blocked', estimated: true,
  })));
});

test('failed attempts do not trigger fallback fee reads, while deferred attempts may still read public fees', async () => {
  for (const [status, reason, expectedCalls, expectedPrice] of [
    ['failed', 'request_failed', 0, '100.00'],
    ['skipped', 'deferred', 1, '102.50'],
  ]) {
    const item = product(), calls = [], outcomes = [];
    const adapter = estimates.withSettlementEstimates({ ...publicFeeConfig, id: 'public-products-v1', hosts: [],
      async settle(_shop, _items, _fetch, options) {
        options.onSettlementResult({ externalId: '1', status, reason, retryable: status === 'failed' });
      } });
    await adapter.settle(shop, [item], async url => {
      calls.push(new URL(url).pathname);
      return Response.json({ status_code: 0, data: { currency: 'CNY', payment_channels: [
        { name: 'Alipay', channel_type: 'alipay', fee_rate: '2.50' },
      ] } });
    }, { onSettlementResult: result => outcomes.push(result) });
    assert.deepEqual(calls, expectedCalls ? ['/api/v1/public/config'] : []);
    assert.equal(item.settlement.price, expectedPrice);
    assert.deepEqual(outcomes, [{ externalId: '1', status, reason, retryable: status === 'failed', estimated: true }]);
  }
});

test('fallback after a failed quote retains already captured public fees without refetching', async () => {
  const item = product(), calls = [], outcomes = [];
  const adapter = estimates.withSettlementEstimates({ ...publicFeeConfig, id: 'public-products-v1', hosts: [],
    async settle(shop, _items, fetchImpl, options) {
      await fetchImpl(new URL('/api/v1/public/config', shop.url));
      options.onSettlementResult({ externalId: '1', status: 'failed', reason: 'request_failed', retryable: true });
    } });
  await adapter.settle(shop, [item], async url => {
    calls.push(new URL(url).pathname);
    return Response.json({ status_code: 0, data: { currency: 'CNY', payment_channels: [
      { name: 'Alipay', channel_type: 'alipay', fee_rate: '2.50' },
    ] } });
  }, { onSettlementResult: result => outcomes.push(result) });
  assert.deepEqual(calls, ['/api/v1/public/config']);
  assert.equal(item.settlement.price, '102.50');
  assert.deepEqual(outcomes, [
    { externalId: '1', status: 'failed', reason: 'request_failed', retryable: true, estimated: true },
  ]);
});

test('native method-marked estimates are never reported as verified or replace actual discounted quotes', async () => {
  for (const entry of ['crawl', 'settle']) {
    const items = [product(), product({ externalId: '2' })], outcomes = [];
    const quotes = [
      { price: '107.00', totalAmount: '107.00', quantity: 1, verifiedAt: '2026-11-24T00:00:00.000Z', paymentMethod: '游客价（预估）', kind: 'estimated' },
      { price: '1.00', totalAmount: '1.00', quantity: 1, verifiedAt: '2026-11-24T00:00:00.000Z', paymentMethod: 'Alipay' },
    ];
    const settle = async (_shop, products, _fetch, options) => {
      products.forEach((item, index) => {
        item.settlement = quotes[index];
        options.onSettlementResult({ externalId: item.externalId, status: 'verified', retryable: false });
      });
      return products;
    };
    const adapter = estimates.withSettlementEstimates({ id: 'fixture', hosts: [], settle,
      crawl: (_page, shop, fetchImpl, options) => settle(shop, items, fetchImpl, options) });
    const options = { onSettlementResult: result => outcomes.push(result) };
    if (entry === 'crawl') await adapter.crawl(null, shop, undefined, options);
    else await adapter.settle(shop, items, undefined, options);
    assert.deepEqual(items.map(item => item.settlement), quotes);
    assert.deepEqual(outcomes, [
      { externalId: '1', status: 'estimated', reason: 'estimated', retryable: false, estimated: true },
      { externalId: '2', status: 'verified', retryable: false },
    ]);
  }
});

test('unavailable outcomes cannot gain fallback prices even if a native adapter leaves stock unchanged', async () => {
  for (const [status, reason] of [['skipped', 'out_of_stock'], ['failed', 'product_unavailable']]) {
    const items = [product()], outcomes = [];
    const adapter = estimates.withSettlementEstimates({ id: 'fixture', hosts: [], async settle(_shop, _items, _fetch, options) {
      options.onSettlementResult({ externalId: '1', status, reason, retryable: false });
    } });
    await adapter.settle(shop, items, () => { throw Error('no network'); },
      { onSettlementResult: result => outcomes.push(result) });
    assert.equal(items[0].settlement, undefined);
    assert.deepEqual(outcomes, [{ externalId: '1', status, reason, retryable: false }]);
  }
});

test('estimates keep quantity validation, eligibility, cancellation and list errors', async () => {
  const adapter = estimates.withSettlementEstimates({ id: 'fixture', hosts: [], purchaseQuantity: p => p.sourceData?.quantity,
    crawl: async () => { throw Error('partial list'); } });
  const items = [product({sourceData:{quantity:5}}), product({externalId:'bad',sourceData:{quantity:0}}), product({externalId:'sold',inStock:false,sourceData:{quantity:1}})];
  await adapter.settle(shop, items);
  assert.equal(items[0].settlement.quantity, 5);
  assert.ok(items.slice(1).every(p => !p.settlement));
  await assert.rejects(adapter.crawl(null, shop), /partial list/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(adapter.settle(shop, [product()], undefined, {signal:controller.signal}), {name:'AbortError'});
});

test('EMShop minimums and Orion purchase steps are retained in estimated totals', async () => {
  for (const [id, sourceData, url] of [
    ['emshop', { min_buy: 5 }, 'https://geminipro.vip/'],
    ['orion-key', { quantity_step: 5 }, 'https://gpt.ybkjs.top/'],
    ['dujiaoka', { minimum: 5 }, 'https://ouvg.top/'],
  ]) {
    const item = product({ sourceData });
    await platformForUrl(url, id).settle({ url }, [item]);
    assert.equal(item.settlement.quantity, 5);
    assert.equal(item.settlement.totalAmount, '500.00');
  }
});

test('real settlement can replace a previous estimate on the next refresh', async () => {
  const items = [product()];
  const adapter = platformForUrl('https://wzyp.cn/shop/test');
  await adapter.settle({url:'https://wzyp.cn/shop/test'}, items, async () => Response.json({code:1,data:[]}));
  assert.match(items[0].settlement.paymentMethod, /预估/);
  await adapter.settle({url:'https://wzyp.cn/shop/test'}, items, async url => /getUserChannel/.test(url)
    ? Response.json({code:1,data:[{id:1,status:1,custom_status:1,show_name:'支付宝'}]})
    : Response.json({code:1,data:{total_amount:'104.00'}}));
  assert.equal(items[0].settlement.price, '104.00');
  assert.equal(items[0].settlement.paymentMethod, '支付宝');
});

test('member-only ACG goods use the published minimum for estimates without requesting member access', async () => {
  const item=product({ externalId:'10', sourceData:{only_user:1,minimum:5} });
  await platformForUrl('https://fk.10886.xyz/', 'acg-faka').settle({url:'https://fk.10886.xyz/'}, [item],
    () => { throw Error('member checkout must not be requested'); });
  assert.equal(item.settlement?.quantity,5);
  assert.equal(item.settlement?.totalAmount,'530.00');
  assert.match(item.settlement.paymentMethod,/预估/);
});

test('live public fee fields override cached store rules when final CNY checkout is unavailable', async () => {
  const native = { ...publicFeeConfig, id:'public-products-v1', hosts:[], async settle(shop, items, fetchImpl) {
    await fetchImpl(new URL('/api/v1/public/config',shop.url));
    return items;
  } };
  const item=product();
  await estimates.withSettlementEstimates(native).settle({url:'https://shop.callai.one/'},[item],async () => Response.json({status_code:0,data:{currency:'CNY',payment_channels:[
    {id:1,name:'支付宝',provider_type:'epay',channel_type:'alipay',fee_policy:'customer_surcharge',fee_rate:'2.50',fixed_fee:'0.30'},
    {id:2,name:'USDT',channel_type:'usdt-trc20',fee_rate:'0.00',fixed_fee:'0.00'},
  ]}}));
  assert.equal(item.settlement.price,'102.80');
  assert.match(item.settlement.paymentMethod,/网页.*2.5%.*0.30/);
});

test('public ACG item-specific fee labels override global channels and unknown names do not imply zero fees', async () => {
  const native = {id:'acg-faka',hosts:[],settlementFeePath:'/user/api/index/pay',readSettlementFees:acgFees,settlementFeeKey:acgFeeKey,async settle(shop,items,fetchImpl){
    await fetchImpl(new URL('/user/api/index/pay',shop.url));
    await fetchImpl(new URL('/user/api/index/pay?itemId=1',shop.url));
    return items;
  }};
  const items=[product({price:'3.19',sourceData:{minimum:1}}),product({externalId:'2',price:'3.19',sourceData:{minimum:1}})];
  await estimates.withSettlementEstimates(native).settle(shop,items,async url=>Response.json({code:200,data:[
    {id:1,name:String(url).includes('itemId')?'支付宝【6%】':'支付宝',handle:'Epay'},
  ]}));
  assert.equal(items[0].settlement.price,'3.38');
  assert.match(items[0].settlement.paymentMethod,/网页/);
  assert.equal(items[1].settlement.price,'3.19');
  assert.match(items[1].settlement.paymentMethod,/预估.*售价/);
});

test('live fees replace old rule estimates, but never a real checkout result', async () => {
  for (const [method, expected] of [['店铺规则（预估）', '102.50'], ['支付宝', '104.00']]) {
    const native = { ...publicFeeConfig, id: 'public-products-v1', hosts: [], async settle(shop, items, fetchImpl) {
      await fetchImpl(new URL('/api/v1/public/config', shop.url));
      items[0].settlement = { price: '104.00', paymentMethod: method, kind: method.includes('预估') ? 'estimated' : 'verified' };
    } };
    const item = product();
    await estimates.withSettlementEstimates(native).settle(shop, [item], async () => Response.json({ status_code: 0,
      data: { currency: 'CNY', payment_channels: [{ name: '支付宝', channel_type: 'alipay', fee_rate: '2.50' }] } }));
    assert.equal(item.settlement.price, expected);
  }
});

test('public fee estimates reject disabled, invalid, foreign-currency and out-of-range channels', async () => {
  const adapter = estimates.withSettlementEstimates({ ...publicFeeConfig, id: 'public-products-v1', hosts: [] });
  const channels = [
    { status: 0 }, { currency: 'USD' }, { fee_rate: 'NaN' }, { fee_rate: '101' }, { fixed_fee: '-1' },
    { min_amount: '101' }, { max_amount: '99' }, { fee_policy: 'merchant_absorb' },
  ].map(fields => ({ name: '支付宝', channel_type: 'alipay', fee_rate: '0', ...fields }));
  const item = product();
  await adapter.settle(shop, [item], async () => Response.json({ status_code: 0, data: { currency: 'CNY', payment_channels: channels } }));
  assert.equal(item.settlement.price, '100.00');
  assert.match(item.settlement.paymentMethod, /预估.*售价/);
  const controller = new AbortController();
  await assert.rejects(adapter.settle(shop, [product()], async () => {
    controller.abort(); throw controller.signal.reason;
  }, { signal: controller.signal }), { name: 'AbortError' });
});

test('Next public fee estimates honor the product allowed-channel list', async () => {
  const adapter = estimates.withSettlementEstimates({ ...publicFeeConfig, id: 'public-products-v1', hosts: [] });
  for (const [allowed, expected] of [[[2], '106.00'], [[], '100.00'], [['2'], '100.00']]) {
    const item = product({ sourceData: { payment_channel_ids: allowed } });
    await adapter.settle(shop, [item], async () => Response.json({ status_code: 0, data: { currency: 'CNY', payment_channels: [
      { id: 1, name: '支付宝零费率', channel_type: 'alipay', fee_rate: '0' },
      { id: 2, name: '支付宝六费率', channel_type: 'alipay', fee_rate: '6' },
    ] } }));
    assert.equal(item.settlement.price, expected);
  }
});

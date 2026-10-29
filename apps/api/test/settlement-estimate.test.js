import test from 'node:test';
import assert from 'node:assert/strict';
import * as estimates from '../src/platforms/settlement-estimate.js';
import { platformForUrl } from '../src/platforms/index.js';

const product = (overrides = {}) => ({ externalId: '1', name: 'Plus', url: 'https://example.com/item/1', price: '100.00', inStock: true, ...overrides });
const shop = { url: 'https://example.com/' };

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
  assert.equal(outcomes.filter(r => r.status === 'verified').length, 3);
  assert.ok(outcomes.filter(r => r.reason === 'estimated').every(r => !r.retryable));
});

test('list-only protocols get estimates in both full crawls and independent retries', async () => {
  const native = { id: 'acg-faka-v5', hosts: [], crawl: async () => [product({sourceData: { quantityRestriction: { min: 5 } }})] };
  const adapter = estimates.withSettlementEstimates(native);
  const [listed] = await adapter.crawl(null, shop);
  assert.equal(listed.settlement.totalAmount, '500.00');
  assert.equal(listed.settlement.quantity, 5);
  const [retried] = await adapter.settle(shop, [product()]);
  assert.equal(retried.settlement.price, '100.00');
  for (const protocol of ['catcard', 'acg-faka-v5', 'orion-key', 'dujiaoka', 'emshop']) {
    assert.equal(typeof platformForUrl(shop.url, protocol).settle, 'function', protocol);
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
  for (const [id, sourceData] of [['emshop', { min_buy: 5 }], ['orion-key', { quantity_step: 5 }], ['dujiaoka', { minimum: 5 }]]) {
    const item = product({ sourceData });
    await estimates.withSettlementEstimates({ id, hosts: [] }).settle(shop, [item]);
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
  const native = { id:'public-products-v1', hosts:[], async settle(shop, items, fetchImpl) {
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
  const native = {id:'acg-faka',hosts:[],async settle(shop,items,fetchImpl){
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
    const native = { id: 'public-products-v1', hosts: [], async settle(shop, items, fetchImpl) {
      await fetchImpl(new URL('/api/v1/public/config', shop.url));
      items[0].settlement = { price: '104.00', paymentMethod: method };
    } };
    const item = product();
    await estimates.withSettlementEstimates(native).settle(shop, [item], async () => Response.json({ status_code: 0,
      data: { currency: 'CNY', payment_channels: [{ name: '支付宝', channel_type: 'alipay', fee_rate: '2.50' }] } }));
    assert.equal(item.settlement.price, expected);
  }
});

test('public fee estimates reject disabled, invalid, foreign-currency and out-of-range channels', async () => {
  const adapter = estimates.withSettlementEstimates({ id: 'public-products-v1', hosts: [] });
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
  const adapter = estimates.withSettlementEstimates({ id: 'public-products-v1', hosts: [] });
  for (const [allowed, expected] of [[[2], '106.00'], [[], '100.00'], [['2'], '100.00']]) {
    const item = product({ sourceData: { payment_channel_ids: allowed } });
    await adapter.settle(shop, [item], async () => Response.json({ status_code: 0, data: { currency: 'CNY', payment_channels: [
      { id: 1, name: '支付宝零费率', channel_type: 'alipay', fee_rate: '0' },
      { id: 2, name: '支付宝六费率', channel_type: 'alipay', fee_rate: '6' },
    ] } }));
    assert.equal(item.settlement.price, expected);
  }
});

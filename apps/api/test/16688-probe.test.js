import test from 'node:test';
import assert from 'node:assert/strict';
import { crawl, probe } from '../src/platforms/16688.js';

const shop = { url: 'https://mock.example/shop/S1' };
const listings = () => Array.from({ length: 100 }, (_, index) => ({
  goods_no: `G${index + 1}`, name: `Product ${index + 1}`, description: '<p>Full body</p>',
  price: '10.00', stock_available_quantity: 5, limit_quantity: 1,
}));

function fixture(items) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const path = new URL(input).pathname, body = JSON.parse(init.body);
    calls.push({ path, body });
    if (path === '/shopApi/goods/list') return Response.json({ code: 1, data: { list: items } });
    if (path === '/shopApi/shop/detail') return Response.json({ code: 1, data: {
      shop_no: 'S1', merchant: { deposit_money: '100.00', sales_count_text: '10\u4eba\u4ed8\u6b3e' },
    } });
    if (path === '/shopApi/payment/list') return Response.json({ code: 1, data: { list: [
      { id: 1, show_name: 'Disabled', status: 0 }, { id: 2, show_name: 'MockPay', status: 1 },
    ] } });
    assert.equal(path, '/shopApi/payment/quotePrice');
    return Response.json({ code: 1, data: { total_amount: String(body.quantity * 11.5), quantity: body.quantity } });
  };
  return { calls, fetchImpl, quotes: () => calls.filter(call => call.path.endsWith('/quotePrice')) };
}

test('16688 probe selects three listings before settlement and never observes a complete shop', async () => {
  const f = fixture(listings());
  const products = await probe(shop, f.fetchImpl);
  assert.deepEqual(products.map(product => product.externalId), ['G1', 'G2', 'G3']);
  assert.deepEqual(f.quotes().map(call => call.body.goods_no), ['G1', 'G2', 'G3']);
  assert.equal(f.calls.length, 5);
  assert.equal(f.calls.filter(call => call.path === '/shopApi/goods/list').length, 1);
  assert.equal(f.calls.some(call => call.path === '/shopApi/shop/detail'), false);
  assert.ok(products.every(product => product.settlement?.price === '11.50'));
});

for (const [label, tail, error] of [
  ['invalid identity', { goods_no: 'G100', name: '', price: '10.00' }, /invalid product/],
  ['duplicate identity', { goods_no: 'G1', name: 'Duplicate', price: '10.00' }, /duplicate product ID/],
  ['invalid original text', { goods_no: 'G100', name: 'Tail', price: '10.00', description: {} }, /invalid original/],
]) {
  test(`16688 probe ignores ${label} beyond its preview while full crawl rejects it`, async () => {
    const items = listings();
    items[3] = tail;
    const products = await probe(shop, fixture(items).fetchImpl);
    assert.deepEqual(products.map(product => product.externalId), ['G1', 'G2', 'G3']);
    const f = fixture(items);
    let completed = false, observed = false;
    await assert.rejects(crawl(null, shop, f.fetchImpl, {
      onListComplete: () => { completed = true; },
      onShopObservation: () => { observed = true; },
    }), error);
    assert.equal(completed, false);
    assert.equal(observed, false);
    assert.equal(f.calls.length, 1);
  });
}

test('16688 full crawl still processes all listings and preserves completion, observation and rating evidence', async () => {
  const f = fixture(listings()), callbacks = [];
  const products = await crawl(null, shop, f.fetchImpl, {
    onListComplete: () => {
      callbacks.push('complete');
      assert.equal(f.calls.length, 1);
    },
    onShopObservation: observation => {
      callbacks.push('observation');
      assert.equal(observation.volume, 10);
      assert.equal(f.quotes().length, 0);
    },
  });
  assert.equal(products.length, 100);
  assert.equal(f.quotes().length, 100);
  assert.deepEqual(callbacks, ['complete', 'observation']);
  assert.equal(products[99].sourceName, 'Product 100');
  assert.equal(products[99].description, '<p>Full body</p>');
  assert.equal(products[99].ratingText?.unitId, 'G100');
  assert.equal(products[99].settlement?.price, '11.50');
});

test('16688 preview preserves stock, minimum quantities, channel eligibility and quoted fees', async () => {
  const items = listings();
  items[0].stock_available_quantity = 0;
  items[1].limit_quantity = 2;
  items[2].limit_quantity = 'unknown';
  const f = fixture(items), products = await probe(shop, f.fetchImpl);
  assert.deepEqual(products.map(product => product.inStock), [false, true, true]);
  assert.deepEqual(f.quotes().map(call => [call.body.goods_no, call.body.quantity, call.body.channel_id]), [['G2', 2, 2]]);
  assert.equal(products[0].settlement, undefined);
  assert.equal(products[2].settlement, undefined);
  assert.equal(products[1].settlement?.totalAmount, '23.00');
  assert.equal(products[1].settlement?.quantity, 2);
  assert.equal(products[1].settlement?.price, '11.50');
});

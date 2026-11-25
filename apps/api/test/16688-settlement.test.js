import test from 'node:test';
import assert from 'node:assert/strict';
import { settle } from '../src/platforms/16688.js';
import platform from '../src/platforms/16688.js';
import { withSettlementEstimates } from '../src/platforms/settlement-estimate.js';

const shop = { url: 'https://www.16688.com.cn/shop/AIDP' };
const products = () => [{ externalId: 'G35841576', price: '10.00', inStock: true }];

test('16688 resolves a storefront alias to its canonical shop number for channels and quotes', async () => {
  const calls = [], reports = [];
  const result = await settle(shop, products(), async (url, init) => {
    const path = new URL(url).pathname, body = JSON.parse(init.body);
    calls.push([path, body]);
    if (path === '/shopApi/shop/detail') return Response.json({ code: 1, data: { shop_no: 'S209643', shop_alias: 'AIDP' } });
    if (path === '/shopApi/payment/list') return Response.json(body.shop_no === 'AIDP'
      ? { code: 0, msg: '店铺不存在或已关闭', data: null }
      : { code: 1, data: { list: [{ id: 11, show_name: '支付宝' }] } });
    assert.equal(path, '/shopApi/payment/quotePrice');
    assert.equal(body.shop_no, 'S209643');
    return Response.json({ code: 1, data: { total_amount: '10.30', quantity: 1 } });
  }, { onSettlementResult: report => reports.push(report) });
  assert.equal(result[0].settlement?.price, '10.30');
  assert.deepEqual(calls.map(([path, body]) => [path, body.shop_no]), [
    ['/shopApi/payment/list', 'AIDP'], ['/shopApi/shop/detail', 'AIDP'],
    ['/shopApi/payment/list', 'S209643'], ['/shopApi/payment/quotePrice', 'S209643'],
  ]);
  assert.equal(reports[0].status, 'verified');
});

test('16688 refuses unrelated alias mappings without turning a payment failure into a missing shop', async () => {
  for (const data of [{ shop_no: 'S209643', shop_alias: 'OTHER' }, { shop_no: '', shop_alias: 'AIDP' }, null]) {
    const reports = [], result = products();
    await settle(shop, result, async url => {
      const path = new URL(url).pathname;
      if (path === '/shopApi/payment/list') return Response.json({ code: 0, msg: '店铺不存在或已关闭' });
      assert.equal(path, '/shopApi/shop/detail');
      return Response.json({ code: 1, data });
    }, { onSettlementResult: report => reports.push(report) });
    assert.equal(result[0].settlement, undefined);
    assert.equal(reports[0].reason, 'no_payment_channel');
  }
});

test('16688 cancels alias resolution before issuing another payment request', async () => {
  const controller = new AbortController(), calls = [];
  await assert.rejects(settle(shop, products(), async (url, init) => {
    assert.equal(init.signal, controller.signal);
    const path = new URL(url).pathname; calls.push(path);
    if (path === '/shopApi/payment/list') return Response.json({ code: 0, msg: '店铺不存在或已关闭' });
    controller.abort(new Error('lease lost'));
    return Response.json({ code: 1, data: { shop_no: 'S209643', shop_alias: 'AIDP' } });
  }, { signal: controller.signal }), /lease lost/);
  assert.deepEqual(calls, ['/shopApi/payment/list', '/shopApi/shop/detail']);
});

for (const [message, reason, status] of [
  ['商品不存在或已下架', 'product_unavailable', 'failed'],
  ['商品已售罄', 'out_of_stock', 'skipped'],
]) test(`16688 quote evidence ${message} clears availability and prevents estimate fallback`, async () => {
  const items = products(), reports = [];
  items[0].settlement = { kind: 'estimated', price: '10.00', totalAmount: '10.00', quantity: 1,
    verifiedAt: new Date().toISOString(), paymentMethod: 'estimated' };
  await withSettlementEstimates(platform).settle(shop, items, async url => Response.json(
    String(url).endsWith('/payment/list') ? { code: 1, data: { list: [{ id: 1, show_name: 'Alipay' }] } }
      : { code: 0, msg: message, data: null }), { onSettlementResult: row => reports.push(row) });
  assert.equal(items[0].inStock, false);
  assert.equal(items[0].settlement, undefined);
  assert.deepEqual(reports, [{ externalId: 'G35841576', status, reason, retryable: false }]);
});

test('16688 does not retire goods on transient or unrelated quote errors', async () => {
  for (const msg of ['系统繁忙', '订单金额不满足支付渠道要求', '店铺不存在或已关闭']) {
    const items = products(), reports = [];
    await settle(shop, items, async url => Response.json(
      String(url).endsWith('/payment/list') ? { code: 1, data: { list: [{ id: 1, show_name: 'Alipay' }] } }
        : { code: 0, msg }), { onSettlementResult: row => reports.push(row) });
    assert.equal(items[0].inStock, true);
    assert.equal(reports[0].reason, 'invalid_quote');
  }
});

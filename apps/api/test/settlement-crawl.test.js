import test from 'node:test';
import assert from 'node:assert/strict';
import { crawl as liandong } from '../src/platforms/liandong.js';
import { crawl as platform16688 } from '../src/platforms/16688.js';
import { platformForUrl } from '../src/platforms/index.js';
import { collectSettlements } from '../src/platforms/settlement.js';

test('per-product settlement channels retain the channel whose fees were quoted', async () => {
  const products = [{ externalId: 'one', inStock: true }, { externalId: 'two', inStock: true }];
  await collectSettlements(products, {
    quantity: () => 1,
    channel: async () => ({ show_name: 'default' }),
    quote: async product => ({ code: 1, data: { total_amount: '10.60' },
      paymentMethod: product.externalId === 'one' ? 'Alipay 6%' : 'WeChat 6%' }),
  });
  assert.deepEqual(products.map(product => product.settlement?.paymentMethod), ['Alipay 6%', 'WeChat 6%']);
});

test('an explicitly invalid per-product payment method cannot fall back to another channel', async () => {
  for (const paymentMethod of ['', ' ', null, true, {}]) {
    const products = [{ externalId: 'one', inStock: true }], outcomes = [];
    await collectSettlements(products, {
      quantity: () => 1,
      channel: async () => ({ show_name: 'default' }),
      quote: async () => ({ code: 1, data: { total_amount: '10.60' }, paymentMethod }),
    }, { onSettlementResult: outcome => outcomes.push(outcome) });
    assert.equal(products[0].settlement, undefined);
    assert.equal(outcomes[0].reason, 'invalid_quote');
  }
});

test('bounded settlement work defers untouched candidates without losing the complete list or reporting failures', async () => {
  const products = Array.from({ length: 25 }, (_, index) => ({ externalId: String(index), inStock: true }));
  const requested = [], outcomes = [];
  const result = await collectSettlements(products, {
    quantity: () => 1,
    channel: async () => ({ id: 1, show_name: 'Alipay' }),
    quote: async product => { requested.push(product.externalId); return { code: 1, data: { total_amount: '1.00' } }; },
  }, { maxSettlementProducts: 5, onSettlementResult: outcome => outcomes.push(outcome) });
  assert.equal(result.length, 25);
  assert.deepEqual(requested, ['0', '1', '2', '3', '4']);
  assert.equal(outcomes.filter(row => row.status === 'verified').length, 5);
  assert.equal(outcomes.filter(row => row.reason === 'deferred' && row.status === 'skipped' && !row.retryable).length, 20);
  assert.equal(outcomes.filter(row => row.status === 'failed').length, 0);
});

test('a channel business failure applies to every candidate instead of deferring the same failure in batches', async () => {
  const outcomes = [];
  await collectSettlements(Array.from({ length: 25 }, (_, index) => ({ externalId: String(index), inStock: true })), {
    quantity: () => 1, channel: async () => undefined,
    quote: async () => { throw new Error('must not quote without a channel'); },
  }, { maxSettlementProducts: 5, onSettlementResult: outcome => outcomes.push(outcome) });
  assert.equal(outcomes.filter(row => row.reason === 'no_payment_channel').length, 25);
});

for (const phase of ['channel', 'quote']) test(`proxy authentication failure during ${phase} stops all further settlement requests`, async () => {
  const outcomes = [];
  let quotes = 0;
  const error = Object.assign(new Error('proxy authentication failed'), { name: 'ProxyAuthenticationError', retryable: false, retryClass: 'configuration' });
  const products = ['one', 'two'].map(externalId => ({ externalId, inStock: true }));
  await collectSettlements(products, {
    quantity: () => 1,
    channel: async () => { if (phase === 'channel') throw error; return { id: 1 }; },
    quote: async () => { quotes++; throw error; },
  }, { onSettlementResult: outcome => outcomes.push(outcome) });
  assert.equal(quotes, phase === 'quote' ? 1 : 0);
  assert.deepEqual(outcomes.map(({ reason, retryable }) => ({ reason, retryable })), [
    { reason: 'proxy_authentication', retryable: false }, { reason: 'proxy_authentication', retryable: false },
  ]);
});

for (const url of ['https://wzyp.cn/shop/test', 'https://catfk.com/shop/test', 'https://www.16688.com.cn/shop/test']) {
  test(`targeted retry never fetches a list at ${url}`, async () => {
    const quoted = [];
    const result = await platformForUrl(url).settle({ url }, [{ externalId: 'failed', name: 'Plus', price: 10, inStock: true, url }], async (endpoint, init) => {
      assert.doesNotMatch(String(endpoint), /goods\/list|goodsList/);
      if (/payment\/list|getUserChannel/.test(String(endpoint))) {
        const channels = [{ id: 1, status: 1, custom_status: 1, show_name: 'Alipay' }];
        return Response.json({ code: 1, data: url.includes('16688') ? { list: channels } : channels });
      }
      const body = JSON.parse(init.body);
      quoted.push(body.goods_no ?? body.goods_key);
      return Response.json({ code: 1, data: { total_amount: '10.30' } });
    });
    assert.deepEqual(quoted, ['failed']);
    assert.equal(result[0].settlement.price, '10.30');
  });
}

for (const [name, crawl] of [['liandong', liandong], ['16688', platform16688]]) {
  function fixture({ limit = 1, stock = 10, quoteQuantity = limit || 1, total = '6.59', failure, channelFailure, signal } = {}) {
    const results = [], quoted = [];
    let channelCalls = 0;
    const items = ['public', 'private', 'sold-out'].map(id => name === 'liandong'
      ? { goods_key: id, link: `https://wzyp.cn/item/${id}`, name: id, price: 6.4, extend: { limit_count: limit, stock_count: id === 'sold-out' ? 0 : stock } }
      : { goods_no: id, name: id, price: 6.4, limit_quantity: limit, stock_available_quantity: id === 'sold-out' ? 0 : stock });
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      if (/goodsList|goods\/list$/.test(url)) return Response.json({ code: 1, data: { list: body.current > 1 ? [] : items } });
      if (/getUserChannel|payment\/list$/.test(url)) {
        channelCalls++;
        if (channelFailure) throw channelFailure;
        const channels = [{ id: 1, show_name: 'Alipay', status: 1, custom_status: 1 }];
        return Response.json({ code: 1, data: name === 'liandong' ? channels : { list: channels } });
      }
      quoted.push(body.goods_key ?? body.goods_no);
      assert.equal(body.quantity, limit || 1);
      if (failure) throw failure;
      return Response.json({ code: 1, data: { total_amount: total, ...(quoteQuantity === undefined ? {} : { quantity: quoteQuantity }) } });
    };
    const run = (selected = new Set(['public']), extra = {}) => crawl(null,
      { url: name === 'liandong' ? 'https://wzyp.cn/shop/test' : 'https://www.16688.com.cn/shop/test' },
      fetchImpl, { settlementProductIds: selected, onSettlementResult: result => results.push(result), signal, ...extra });
    return { run, results, quoted, channelCalls: () => channelCalls };
  }

  test(`${name} preserves complete listings but only quotes selected in-stock products`, async () => {
    const f = fixture();
    const products = await f.run();
    assert.equal(products.length, 3);
    assert.deepEqual(f.quoted, ['public']);
    assert.equal(products[0].settlement?.price, '6.59');
    assert.equal(products[1].settlement, undefined);
    assert.deepEqual(f.results.map(({ externalId, status, reason }) => [externalId, status, reason]), [
      ['private', 'skipped', 'not_selected'], ['sold-out', 'skipped', 'out_of_stock'], ['public', 'verified', undefined],
    ]);
  });

  test(`${name} avoids payment requests entirely when nothing needs quoting`, async () => {
    const f = fixture();
    assert.equal((await f.run(new Set())).length, 3);
    assert.equal(f.channelCalls(), 0);
  });

  test(`${name} skips payment requests for recently verified products`, async () => {
    const f = fixture();
    assert.equal((await f.run(new Set(['public']), { needsSettlement: () => false })).length, 3);
    assert.equal(f.channelCalls(), 0);
    assert.deepEqual(f.quoted, []);
    assert.equal(f.results.find(result => result.externalId === 'public')?.reason, 'recently_verified');
  });

  test(`${name} reports transport failure instead of silently losing the quote`, async () => {
    const f = fixture({ failure: new Error('crawler request timed out') });
    const products = await f.run();
    assert.equal(products[0].settlement, undefined);
    const result = f.results.find(row => row.externalId === 'public');
    assert.equal(result.status, 'failed');
    assert.equal(result.retryable, true);
    assert.equal(result.reason, 'request_failed');
  });

  test(`${name} stops further quote requests after a block and reports all affected products`, async () => {
    const failure = Object.assign(new Error('HTTP 403'), { name: 'CrawlerBlockedError' });
    const f = fixture({ failure });
    await f.run(new Set(['public', 'private']));
    assert.deepEqual(f.quoted, ['public']);
    assert.equal(f.results.filter(row => row.status === 'failed' && row.reason === 'blocked').length, 2);
  });

  test(`${name} reports payment-channel transport failure for all candidates`, async () => {
    const f = fixture({ channelFailure: new Error('fetch failed') });
    await f.run();
    assert.equal(f.results.find(row => row.externalId === 'public')?.retryable, true);
    assert.deepEqual(f.quoted, []);
  });

  test(`${name} quotes the minimum purchase quantity and returns a unit price`, async () => {
    const f = fixture({ limit: 5, total: '51.50' });
    const [product] = await f.run();
    assert.equal(product.settlement?.price, '10.30');
    assert.equal(product.settlement?.totalAmount, '51.50');
    assert.equal(product.settlement?.quantity, 5);
    assert.deepEqual(f.quoted, ['public']);
  });

  test(`${name} does not request a quote when stock is below the purchase minimum`, async () => {
    const f = fixture({ limit: 5, stock: 4 });
    const [product] = await f.run();
    assert.equal(product.inStock, false);
    assert.equal(product.settlement, undefined);
    assert.equal(f.channelCalls(), 0);
  });

  test(`${name} rejects a quote for a different quantity without retrying a business failure`, async () => {
    const f = fixture({ limit: 5, quoteQuantity: 1 });
    const [product] = await f.run();
    assert.equal(product.settlement, undefined);
    const result = f.results.find(row => row.externalId === 'public');
    assert.equal(result.reason, 'invalid_quote');
    assert.equal(result.retryable, false);
  });

  test(`${name} propagates cancellation even when the signal reason is an ordinary Error`, async () => {
    const controller = new AbortController();
    controller.abort(new Error('lease lost'));
    const f = fixture({ signal: controller.signal });
    await assert.rejects(f.run(), /lease lost/);
  });

  if (name === 'liandong') test('liandong requests a real single-unit quote for zero minimum quantity', async () => {
    const f = fixture({ limit: 0 });
    assert.equal((await f.run())[0].settlement?.price, '6.59');
    assert.deepEqual(f.quoted, ['public']);
  });
}

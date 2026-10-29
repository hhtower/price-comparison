import test from 'node:test';
import assert from 'node:assert/strict';
import liandong from '../src/platforms/liandong.js';
import platform16688 from '../src/platforms/16688.js';

const cases = [
  { adapter: liandong, key: 'token', identity: 'sample', path: '/shopApi/Shop/info',
    data: { token: 'sample', deposit_money: '100.29', sell_count: '10642', params: { show_deposit_money: 0, show_sell_count: 0 } } },
  { adapter: platform16688, key: 'shop_no', identity: 'S974686', path: '/shopApi/shop/detail',
    data: { shop_no: 'S974686', shop_alias: 'sample', merchant: { deposit_money: '100.29', sales_count_text: '5742人付款' } } },
];

function fixture(config, metadata = () => Response.json({ code: 1, data: config.data })) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    requests.push({ url, options });
    if (path === config.path) return metadata(options);
    if (path.endsWith('/goodsList') || path.endsWith('/goods/list')) {
      return Response.json({ code: 1, data: { list: [], total: 0 } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  return { requests, fetchImpl, shop: { url: `https://shop.example/shop/${config.identity}` } };
}

for (const config of cases) {
  test(`${config.adapter.id}: metadata is opt-in and probe does not request it`, async () => {
    const f = fixture(config);
    await config.adapter.crawl(null, f.shop, f.fetchImpl);
    await config.adapter.probe(f.shop, f.fetchImpl);
    assert.equal(f.requests.some(r => new URL(r.url).pathname === config.path), false);
  });

  test(`${config.adapter.id}: reports exact cents and the protocol-specific count`, async () => {
    const f = fixture(config);
    const observations = [];
    await config.adapter.crawl(null, f.shop, f.fetchImpl, { onShopObservation: value => observations.push(value) });
    assert.equal(observations.length, 1);
    const [value] = observations;
    assert.deepEqual(value.deposit, { amountMinor: 10029, currency: 'CNY', purpose: null });
    assert.equal(value.volume, config.adapter.id === 'liandong' ? 10642 : 5742);
    assert.match(value.counterDefinition, config.adapter.id === 'liandong' ? /sell_count/ : /sales_count_text/);
    assert.equal(new Date(value.observedAt).toISOString(), value.observedAt);
    const request = f.requests.find(r => new URL(r.url).pathname === config.path);
    assert.equal(new URL(request.url).origin, 'https://shop.example');
    assert.deepEqual(JSON.parse(request.options.body), { [config.key]: config.identity });
  });

  test(`${config.adapter.id}: missing identity is request scoped and missing fields stay null`, async () => {
    const f = fixture(config, () => Response.json({ code: 1, data: {} }));
    let observed;
    await config.adapter.crawl(null, f.shop, f.fetchImpl, { onShopObservation: value => { observed = value; } });
    assert.equal(observed.deposit, null);
    assert.equal(observed.volume, null);
    assert.match(observed.counterDefinition, /request_scoped/);
  });

  test(`${config.adapter.id}: rejects conflicting identity without failing the list`, async () => {
    const data = { ...config.data, [config.key]: 'other' };
    const f = fixture(config, () => Response.json({ code: 1, data }));
    let calls = 0;
    assert.deepEqual(await config.adapter.crawl(null, f.shop, f.fetchImpl, { onShopObservation: () => { calls++; } }), []);
    assert.equal(calls, 0);
  });

  for (const failure of [
    () => { throw new Error('network unavailable'); },
    () => new Response('', { status: 503 }),
    () => new Response('not JSON'),
    () => Response.json({ code: 0, msg: 'unavailable' }),
    () => Response.json({ code: 1, data: null }),
  ]) {
    test(`${config.adapter.id}: metadata failure leaves list completion intact (${failure.toString()})`, async () => {
      const f = fixture(config, failure);
      let calls = 0, completed = false;
      assert.deepEqual(await config.adapter.crawl(null, f.shop, f.fetchImpl, {
        onShopObservation: () => { calls++; }, onListComplete: () => { completed = true; },
      }), []);
      assert.equal(completed, true);
      assert.equal(calls, 0);
    });
  }

  test(`${config.adapter.id}: forwards signal and propagates cancellation during metadata`, async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const f = fixture(config, options => {
      assert.equal(options.signal, controller.signal);
      controller.abort(reason);
      throw new Error('transport failure after cancellation');
    });
    await assert.rejects(config.adapter.crawl(null, f.shop, f.fetchImpl, {
      signal: controller.signal, onShopObservation: () => assert.fail('cancelled observation'),
    }), error => error === reason);
  });

  test(`${config.adapter.id}: metadata-only AbortError leaves the valid goods list intact`, async () => {
    const f = fixture(config, () => { throw new DOMException('aborted', 'AbortError'); });
    let completed = false;
    const products = await config.adapter.crawl(null, f.shop, f.fetchImpl, { onShopObservation() {
      assert.fail('aborted metadata must not be observed');
    }, onListComplete() { completed = true; } });
    assert.deepEqual(products, []);
    assert.equal(completed, true);
  });

  test(`${config.adapter.id}: does not publish a response redirected to a different scope`, async () => {
    const f = fixture(config, () => {
      const response = Response.json({ code: 1, data: config.data });
      Object.defineProperty(response, 'url', { value: `https://other.example${config.path}` });
      return response;
    });
    let calls = 0;
    await config.adapter.crawl(null, f.shop, f.fetchImpl, { onShopObservation: () => { calls++; } });
    assert.equal(calls, 0);
  });

  test(`${config.adapter.id}: cancellation after JSON parsing cannot emit an observation`, async () => {
    const controller = new AbortController();
    const f = fixture(config, () => ({ ok: true, json: async () => {
      controller.abort();
      return { code: 1, data: config.data };
    } }));
    await assert.rejects(config.adapter.crawl(null, f.shop, f.fetchImpl, {
      signal: controller.signal, onShopObservation: () => assert.fail('cancelled observation'),
    }), { name: 'AbortError' });
  });

  test(`${config.adapter.id}: failed metadata preserves goods and existing settlement behavior`, async () => {
    const item = config.adapter.id === 'liandong'
      ? { goods_key: 'G1', link: 'https://shop.example/item/G1', name: '商品', price: 10, stock_num: 1 }
      : { goods_no: 'G1', name: '商品', price: 10, stock_available_quantity: 1 };
    const run = async (metadataEnabled) => {
      let completed = false;
      const products = await config.adapter.crawl(null, { url: `https://shop.example/shop/${config.identity}` }, async (url, options) => {
        const path = new URL(url).pathname;
        if (path === config.path) throw new Error('metadata unavailable');
        if (path.endsWith('/goodsList') || path.endsWith('/goods/list')) return Response.json({
          code: 1, data: { list: !JSON.parse(options.body).current || JSON.parse(options.body).current === 1 ? [item] : [], total: 1 },
        });
        if (path.endsWith('/getUserChannel')) return Response.json({ code: 1, data: [] });
        if (path.endsWith('/payment/list')) return Response.json({ code: 1, data: { list: [] } });
        throw new Error(`Unexpected request: ${url}`);
      }, { onListComplete: () => { completed = true; },
        ...(metadataEnabled ? { onShopObservation: () => assert.fail('failed metadata') } : {}) });
      assert.equal(completed, true);
      assert.equal(products.length, 1);
      return products;
    };
    assert.deepEqual(await run(true), await run(false));
  });
}

test('16688 accepts an alias only when the echoed alias agrees', async () => {
  const config = { ...cases[1], identity: 'sample' };
  for (const [alias, expected] of [['sample', 1], ['other', 0], [null, 0]]) {
    const data = { ...config.data, ...(alias === null ? {} : { shop_alias: alias }) };
    if (alias === null) delete data.shop_alias;
    const f = fixture(config, () => Response.json({ code: 1, data }));
    let calls = 0;
    await config.adapter.crawl(null, f.shop, f.fetchImpl, { onShopObservation: () => { calls++; } });
    assert.equal(calls, expected);
  }
});

test('liandong never trusts hidden flags or coerces malformed amounts/counts', async () => {
  for (const [amount, count, deposit, volume] of [
    [0, 0, { amountMinor: 0, currency: 'CNY', purpose: null }, 0],
    [0.29, '9007199254740991', { amountMinor: 29, currency: 'CNY', purpose: null }, 9007199254740991],
    ['90071992547409.91', 1, { amountMinor: 9007199254740991, currency: 'CNY', purpose: null }, 1],
    ['90071992547409.92', '9007199254740992', null, null],
    ['1.001', '1.2', null, null],
    [-1, -1, null, null],
    [true, true, null, null],
    ['', '', null, null],
    ['1e2', '1e2', null, null],
    ['1,000', '1,000', null, null],
    [null, null, null, null],
  ]) {
    const config = cases[0];
    const f = fixture(config, () => Response.json({ code: 1, data: { token: config.identity, deposit_money: amount, sell_count: count } }));
    let observed;
    await config.adapter.crawl(null, f.shop, f.fetchImpl, { onShopObservation: value => { observed = value; } });
    assert.deepEqual(observed.deposit, deposit, `deposit ${amount}`);
    assert.equal(observed.volume, volume, `count ${count}`);
  }
});

test('16688 parses only exact person-payment text, not abbreviated or alternate counters', async () => {
  for (const [text, expected] of [['0人付款', 0], ['5742人付款', 5742], ['1.2万人付款', null],
    ['5742', null], [5742, null], ['5742笔订单', null], ['9007199254740992人付款', null]]) {
    const config = cases[1];
    const f = fixture(config, () => Response.json({ code: 1, data: { ...config.data, merchant: { sales_count_text: text } } }));
    let observed;
    await config.adapter.crawl(null, f.shop, f.fetchImpl, { onShopObservation: value => { observed = value; } });
    assert.equal(observed.volume, expected);
    assert.equal(observed.deposit, null);
  }
});

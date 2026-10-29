import test from 'node:test';
import assert from 'node:assert/strict';
const shop = { url: 'https://shop.558686.xyz/' };
const item = (id, price, stock = 25) => ({ id, name: `商品${id}`, description: '说明', price, stock });
const catalog = (products = [item(3, 680000), item(2, 1500000, 0)]) => JSON.stringify({ name: '棱镜货源', payment_ready: true, products });
const fx = (usd = '0.1400') => JSON.stringify({ date: '2026-10-24', cny: { usd, eur: '0.13' } });
function network({ products = catalog(), rate = fx(), fxCalls = 0 } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('jsdelivr')) {
      if (!rate) throw new Error('fx down');
      return new Response(rate, { headers: { 'content-type': 'application/json' } });
    }
    assert.equal(String(url), 'https://shop.558686.xyz/api/catalog');
    return new Response(products, { headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetch };
}

test('prism converts micro-USDT to CNY estimates and attaches rate-based settlements', async () => {
  const { crawl, settle } = await import('../src/platforms/prism.js');
  const net = network();
  let completed = 0;
  const products = await crawl(null, shop, net.fetch, { onListComplete: () => completed++ });
  assert.equal(completed, 1);
  assert.deepEqual(products.map(p => [p.externalId, p.price, p.inStock]), [['3', '4.86', true], ['2', '10.71', false]]);
  assert.equal(products[0].settlement.totalAmount, '4.86');
  assert.equal(products[0].settlement.paymentMethod, 'USDT 汇率折算（预估）');
  assert.equal(products[1].settlement, undefined);
  assert.ok(net.calls.every(c => c.init.redirect === 'error'));
  // settlement refresh re-quotes from the stored micro price
  const [fresh] = await settle(shop, [{ externalId: '3', price: '4.85', inStock: true, sourceData: { microPrice: 680000 } }], network().fetch);
  assert.equal(fresh.settlement.totalAmount, '4.86');
});

test('prism probe previews raw USDT prices without the cross-origin FX fetch', async () => {
  const { probe } = await import('../src/platforms/prism.js');
  const net = network();
  const products = await probe(shop, net.fetch);
  assert.deepEqual(products.map(p => p.price), ['0.68', '1.50']);
  assert.ok(net.calls.every(c => !String(c.url).includes('jsdelivr')));
});

test('prism rejects malformed catalogs and exchange rates', async () => {
  const { crawl } = await import('../src/platforms/prism.js');
  for (const products of ['{}', JSON.stringify({ products: [item(0, 1)] }), JSON.stringify({ products: [item(1.5, 1)] }),
    JSON.stringify({ products: [item(1, -1)] }), JSON.stringify({ products: [item(1, 1, -1)] }), JSON.stringify({ products: [{ ...item(1, 1), name: ' ' }] }),
    JSON.stringify({ products: [item(1, 1), item(1, 1)] })]) {
    await assert.rejects(crawl(null, shop, network({ products }).fetch), /prism goods API:/);
  }
  for (const rate of [fx('0'), fx('abc'), fx('-1'), fx('0.0000000000001'), JSON.stringify({ cny: {} })]) {
    await assert.rejects(crawl(null, shop, network({ rate }).fetch), /prism goods API:/);
  }
  await assert.rejects(crawl(null, shop, network({ rate: null }).fetch), /fx down/);
});

test('prism uses the injected official-reference rate without touching the FX feed', async () => {
  const { crawl } = await import('../src/platforms/prism.js');
  const net = network({ rate: null });
  const products = await crawl(null, shop, async (url, init) => {
    assert.ok(!String(url).includes('jsdelivr'), 'FX feed must not be requested');
    return net.fetch(url, init);
  }, { cnyPerUsd: '0.1400' });
  assert.deepEqual(products.map(p => p.price), ['4.86', '10.71']);
  assert.equal(products[0].settlement.totalAmount, '4.86');
  const { latestCnyPerUsd } = await import('../src/platforms/prism.js');
  const fxDb = usd => ({
    selectFrom: () => ({
      select: () => ({
        where: () => ({
          orderBy: () => ({
            executeTakeFirst: async () => ({ snapshot: { cny: { usd } } }),
          }),
        }),
      }),
    }),
  });
  assert.equal(await latestCnyPerUsd(fxDb(0.1403)), '0.1403');
  assert.equal(await latestCnyPerUsd(fxDb(0)), undefined);
  assert.equal(await latestCnyPerUsd(fxDb(undefined)), undefined);
});

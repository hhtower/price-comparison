import test from 'node:test';
import assert from 'node:assert/strict';

test('Orion Key refuses discounts and requires enough stock for its public purchase step', async () => {
  const { crawl } = await import('../src/platforms/orion-key.js');
  const item = { id: 'p', title: '月卡', currency: 'CNY', has_specs: true, spec_enabled: true, quantity_step: 30,
    stock_available: 50, specs: [{ id: 's', name: '规格', price: 10, stock_available: 20 }] };
  const send = async input => Response.json({ code: 0, data: String(input).includes('?')
    ? { list: [item], pagination: { page: 1, page_size: 100, total: 1 } } : item });
  assert.equal((await crawl(null, { url: 'https://shop.example/' }, send))[0].inStock, false);
  for (const quantity_step of [0, -1, '30', 1.5]) {
    item.quantity_step = quantity_step;
    await assert.rejects(crawl(null, { url: 'https://shop.example/' }, send));
  }
  item.quantity_step = 1;
  item.discounted_price = 9;
  await assert.rejects(crawl(null, { url: 'https://shop.example/' }, send));
  delete item.discounted_price;
  item.specs[0].discounted_price = 9;
  await assert.rejects(crawl(null, { url: 'https://shop.example/' }, send));
});

const shop = { url: 'https://chong.nerver.cc/' };
const firstId = 'fa976f55-a031-4c83-842a-71c9d2c14e26';
const secondId = 'a7278570-d74b-4378-b2c3-cfd668264af4';
const listing = (id = firstId, hasSpecs = true) => ({ id, title: '蒸馏专用二号站', base_price: 1000, currency: 'CNY', stock_available: 20, has_specs: hasSpecs });
const detail = (id = firstId, hasSpecs = true) => ({ ...listing(id, hasSpecs), detail_md: '官方渠道，30天质保', spec_enabled: hasSpecs, wholesale_enabled: false, wholesale_rules: [], specs: hasSpecs ? [
  { id: '8228a5ef-26f6-42d6-9414-34523fb75a08', name: '1000', price: 1000, stock_available: 20, fulfillment_type: 'finished_account' },
  { id: '0a09360b-4dc6-4ec0-8844-3b6f7915ce44', name: '月卡', price: 30.5, stock_available: 0 },
] : [] });

test('Orion Key normalizes only the selected label', async () => {
  const { crawl } = await import('../src/platforms/orion-key.js');
  const item = detail();
  item.specs[0].name = ' Ｍｏｎｔｈｌｙ \n account ';
  const [product] = await crawl(null, shop, network(undefined, { [firstId]: item }).fetch);
  assert.equal(product.spec, 'Monthly account');
  assert.equal(product.externalId, `${firstId}:${item.specs[0].id}`);
  assert.equal(product.sourceData.fulfillment_type, 'finished_account');
  for (const key of ['sku', 'selectedOptions', 'specification', 'spec']) assert.equal(key in product.sourceData, false);
});
const page = (items, number = 1, size = 100, total = items.length) => ({ list: items, pagination: { page: number, page_size: size, total } });
function network(pages = [page([listing()])], details = { [firstId]: detail() }, hook) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    hook?.(url, init);
    const parsed = new URL(url);
    const data = parsed.pathname === '/api/products' ? pages[Number(parsed.searchParams.get('page')) - 1] : details[decodeURIComponent(parsed.pathname.split('/').pop())];
    assert.ok(data, `unexpected request: ${url}`);
    return new Response(JSON.stringify({ code: 0, message: 'Success', data }), { headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetch };
}

test('Orion Key reads complete pages and uses detail SKU price, stock and stable IDs', async () => {
  const { crawl } = await import('../src/platforms/orion-key.js');
  const single = { ...detail(secondId, false), title: 'GPT Plus', base_price: 30, stock_available: 0 };
  const net = network([page([listing()], 1, 1, 2), page([listing(secondId, false)], 2, 1, 2)], { [firstId]: detail(), [secondId]: single });
  let completed = 0;
  const products = await crawl(null, shop, net.fetch, { onListComplete: () => completed++ });
  assert.deepEqual(products.map(p => [p.externalId, p.price, p.inStock, p.spec]), [
    [`${firstId}:8228a5ef-26f6-42d6-9414-34523fb75a08`, '1000', true, '1000'],
    [`${firstId}:0a09360b-4dc6-4ec0-8844-3b6f7915ce44`, '30.5', false, '月卡'],
    [secondId, '30', false, ''],
  ]);
  assert.equal(products[0].url, `${shop.url}product/${firstId}`);
  assert.equal(products[0].sourceData.content, '官方渠道,30天质保');
  assert.equal(products[0].sourceData.fulfillment_type, 'finished_account');
  assert.equal('sku' in products[0].sourceData, false);
  assert.equal(completed, 1);
  assert.equal(net.calls.length, 4);
  assert.ok(net.calls.every(c => c.init.redirect === 'error' && !c.init.body && !c.init.method));
});

test('Orion Key probe is a detail-backed preview and empty catalog completes', async () => {
  const { probe, crawl } = await import('../src/platforms/orion-key.js');
  const net = network([page([listing()], 1, 1, 2)]);
  assert.equal((await probe(shop, net.fetch)).length, 2);
  assert.equal(net.calls.length, 2);
  assert.deepEqual(await crawl(null, shop, network([page([])]).fetch), []);
});

test('Orion Key rejects duplicate, missing, changing or incomplete pagination', async () => {
  const { crawl } = await import('../src/platforms/orion-key.js');
  const cases = [
    [page([listing(), listing()])],
    [{ list: [listing()] }],
    [page([listing()], 2)],
    [page([listing()], 1, 0)],
    [page([listing()], 1, 2, 2)],
    [page([listing()], 1, 1, 2), page([listing(secondId)], 2, 1, 3)],
    [page([listing()], 1, 1, 2), page([listing()], 2, 1, 2)],
  ];
  for (const pages of cases) {
    let completed = false;
    await assert.rejects(crawl(null, shop, network(pages).fetch, { onListComplete: () => completed = true }), /orion-key goods API:/);
    assert.equal(completed, false);
  }
});

test('Orion Key rejects detail identity mismatch and unavailable price, stock, specs or currency', async () => {
  const { crawl } = await import('../src/platforms/orion-key.js');
  const mutations = [
    d => d.id = secondId,
    d => delete d.specs,
    d => d.specs = [],
    d => d.specs.push({ ...d.specs[0] }),
    d => delete d.specs[0].price,
    d => d.specs[0].price = '',
    d => d.specs[0].price = -1,
    d => d.specs[0].price = true,
    d => delete d.specs[0].stock_available,
    d => d.specs[0].stock_available = -1,
    d => d.specs[0].name = '',
    d => d.currency = 'USD',
    d => d.spec_enabled = false,
    d => delete d.stock_available,
  ];
  for (const mutate of mutations) {
    const value = detail(); mutate(value);
    await assert.rejects(crawl(null, shop, network(undefined, { [firstId]: value }).fetch), /orion-key goods API:/);
  }
});

test('Orion Key does not substitute listing price for malformed no-spec detail', async () => {
  const { crawl } = await import('../src/platforms/orion-key.js');
  const value = detail(firstId, false); delete value.base_price;
  await assert.rejects(crawl(null, shop, network([page([listing(firstId, false)])], { [firstId]: value }).fetch), /orion-key goods API:/);
});

test('Orion Key rejects HTTP errors, invalid JSON/envelopes and interrupted reads', async () => {
  const { crawl } = await import('../src/platforms/orion-key.js');
  for (const response of [new Response('blocked', { status: 403 }), new Response('{"code":0,'), new Response('{"code":1,"data":{}}')]) {
    await assert.rejects(crawl(null, shop, async () => response));
  }
  await assert.rejects(crawl(null, shop, async () => { throw new Error('interrupted'); }), /interrupted/);
});

test('Orion Key propagates cancellation and never reports a partial catalog complete', async () => {
  const { crawl } = await import('../src/platforms/orion-key.js');
  const controller = new AbortController();
  let completed = false;
  const net = network(undefined, undefined, (_url, init) => {
    assert.equal(init.signal, controller.signal);
    controller.abort(new Error('cancelled'));
  });
  await assert.rejects(crawl(null, shop, net.fetch, { signal: controller.signal, onListComplete: () => completed = true }), /cancelled/);
  assert.equal(completed, false);
  assert.equal(net.calls.length, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { crawl, probe } from '../src/platforms/catcard.js';

const shop = { url: 'https://catcard.uk/' };
const product = (id = 44, changes = {}) => ({ id, name: '【人机邮箱】普号22-24年', description: '无质保，会玩的可以买',
  price: 1.5, image_url: '/uploads/email.png', catalog_type: 'product', group_id: 11,
  stock: 715, sales_count: 386, volume_pricing: [], max_per_user: 0, require_login: false,
  supply_paused: false, usage_guide: '<p>首次登录操作说明</p>', warranty_info: '无质保',
  tags: [{ text: 'Google', bgColor: '#fff', textColor: '#000' }], spec_group: null, ...changes });
const spec = (id, label, changes = {}) => ({ product_id: id, spec_name: label,
  product_name: `【中转站额度】${label}`, price: id === 62 ? 1 : 10, image_url: '', stock: 80,
  supply_paused: false, sales_count: 0, sort_order: id, ...changes });
const group = (changes = {}) => ({ id: 2, name: '猫猫中转站', group_id: 16, display_title: '【中转站额度】',
  image_url: '', display_price: 1, total_stock: 90, total_sales: 1193,
  specs: [spec(62, '1刀'), spec(61, '10刀', { stock: 10 })], ...changes });
const grouped = (changes = {}) => product(62, { name: '【中转站额度】', catalog_type: 'spec_group', price: 1,
  group_id: 16, stock: 90, spec_group: group(), ...changes });
const groupedDetail = (id, changes = {}) => product(id, { name: `【中转站额度】${id === 62 ? '1刀' : '10刀'}`,
  group_id: 16, price: id === 62 ? 1 : 10, stock: id === 62 ? 80 : 10, spec_group: group(), ...changes });
const groups = [{ id: 11, name: 'Gmail邮箱', icon: '', sort_order: 70 }, { id: 16, name: 'API 中转站', icon: '', sort_order: 60 }];
function api({ catalog = [product()], details = new Map([[44, product()]]), categories = groups, intercept } = {}) {
  return async (input, init) => {
    const url = new URL(input);
    assert.ok(!init?.method || init.method === 'GET');
    assert.equal(url.search, '');
    const changed = await intercept?.(url, init);
    if (changed) return changed;
    if (url.pathname === '/api/products') return Response.json(catalog);
    if (url.pathname === '/api/products/groups') return Response.json(categories);
    const match = url.pathname.match(/^\/api\/products\/(\d+)$/);
    if (!match || !details.has(Number(match[1]))) throw new Error(`Unexpected or unsafe endpoint ${url.pathname}`);
    return Response.json(details.get(Number(match[1])));
  };
}
const run = (fetchImpl, options) => crawl(null, shop, fetchImpl, options);

test('catcard uses actual product detail and keeps stable guide, category and purchase evidence', async () => {
  let complete = 0;
  const [result] = await run(api({ details: new Map([[44, product(44, { price: '2.25', stock: 0 })]]) }), { onListComplete: () => { complete++; } });
  assert.equal(result.externalId, '44');
  assert.equal(result.name, '【人机邮箱】普号22-24年');
  assert.equal(result.spec, '');
  assert.equal(result.sourceCategory, 'Gmail邮箱');
  assert.equal(result.price, '2.25');
  assert.equal(result.inStock, false);
  assert.equal(result.url, 'https://catcard.uk/');
  assert.equal(result.imageUrl, 'https://catcard.uk/uploads/email.png');
  assert.match(result.sourceData.evidence, /无质保/);
  assert.match(result.sourceData.usage_guide, /首次登录/);
  assert.equal(result.sourceData.require_login, false);
  assert.deepEqual(result.sourceData.tags, ['Google']);
  assert.ok(!JSON.stringify(result.sourceData).includes('715'));
  assert.equal(complete, 1);
});

test('catcard expands every spec product and never copies aggregated display price or stock', async () => {
  const [a, b] = await run(api({ catalog: [grouped()], details: new Map([
    [62, groupedDetail(62, { stock: 0 })],
    [61, groupedDetail(61, { price: 11, supply_paused: true })],
  ]) }));
  assert.deepEqual([a, b].map(x => [x.externalId, x.spec, x.price, x.inStock]), [['62', '猫猫中转站: 1刀', '1', false], ['61', '猫猫中转站: 10刀', '11', false]]);
  assert.equal(b.sourceCategory, 'API 中转站');
  assert.equal('specification' in b.sourceData, false);
  assert.ok(!JSON.stringify(b.sourceData).includes('1193'));
});

test('catcard groups specification details by their raw catalog parent and rejects conflicting evidence', async () => {
  const { captureRatingText, buildRatingManifest } = await import('../src/platforms/source-evidence.js');
  const title = '  【中转站额度】\n', body = ' <p>Full\n\nbody</p> ';
  const rows = await run(api({ catalog: [grouped({ name: title })], details: new Map([
    [62, groupedDetail(62, { description: body })], [61, groupedDetail(61, { description: body })],
  ]) }));
  const expected = captureRatingText('62', title, body, product().usage_guide, product().warranty_info);
  assert.deepEqual(rows.map(row => row.ratingText), [expected, expected]);
  const source = { ...shop, protocol: 'catcard', platform: 'custom' };
  assert.deepEqual(buildRatingManifest(source, 'catcard', rows, 1).units, [{ unitId: '62', hash: expected.hash }]);
  const unavailable = await run(api({ catalog: [grouped({ name: title })], details: new Map([
    [62, groupedDetail(62, { description: body })], [61, groupedDetail(61, { warranty_info: undefined })],
  ]) }));
  assert.equal(unavailable[1].ratingText, undefined);
  assert.deepEqual(buildRatingManifest(source, 'catcard', unavailable, 1).units, [{ unitId: '62', hash: null }]);
  const conflicting = await run(api({ catalog: [grouped({ name: title })], details: new Map([
    [62, groupedDetail(62, { description: body })], [61, groupedDetail(61, { description: 'Different' })],
  ]) }));
  assert.deepEqual(buildRatingManifest(source, 'catcard', conflicting, 1).units, [{ unitId: '62', hash: null }]);
});

test('catcard computes only the quantity-one price from applicable volume tiers', async () => {
  const item = product(44, { volume_pricing: [{ min_quantity: 10, price: 0.8 }, { min_quantity: 1, price: 1.2 }] });
  const [result] = await run(api({ details: new Map([[44, item]]) }));
  assert.equal(result.price, '1.2');
  assert.deepEqual(result.sourceData.wholesale_minimums, [10, 1]);
});

test('catcard rejects wrapped, duplicate, externally typed or structurally incomplete catalogs', async () => {
  for (const catalog of [
    { data: [product()] }, [product(), product()], [product(44, { catalog_type: 'external' })],
    [product(44, { catalog_type: undefined })], [grouped({ spec_group: null })],
    [grouped({ spec_group: group({ specs: [] }) })], [grouped({ spec_group: group({ specs: [spec(61, '10刀')] }) })],
    [grouped(), product(61)], [product(44, { spec_group: group() })],
    [grouped({ spec_group: group({ specs: [spec(62, '1刀'), spec(62, '重复')] }) })],
  ]) await assert.rejects(run(api({ catalog })));
  assert.deepEqual(await run(api({ catalog: [], categories: [] })), []);
});

test('catcard rejects swapped detail identities and changing specification membership', async () => {
  for (const item of [product(99), product(44, { catalog_type: 'spec_group' }), product(44, { group_id: 16 }), product(44, { spec_group: group() })]) {
    await assert.rejects(run(api({ details: new Map([[44, item]]) })));
  }
  for (const spec_group of [null, group({ id: 99 }), group({ specs: [spec(62, '1刀')] }), group({ specs: [spec(62, '1刀'), spec(61, '变更标签')] })]) {
    await assert.rejects(run(api({ catalog: [grouped()], details: new Map([[62, groupedDetail(62, { spec_group })], [61, groupedDetail(61)]]) })));
  }
});

test('catcard rejects uncertain stock, pause and prices instead of publishing sold-out defaults', async () => {
  for (const changes of [{ stock: null }, { stock: -1 }, { stock: '715' }, { stock: 1.2 }, { supply_paused: undefined }, { supply_paused: 'false' }, { price: '' }, { price: null }, { price: -1 }, { volume_pricing: null }, { volume_pricing: [{ min_quantity: 0, price: 1 }] }]) {
    await assert.rejects(run(api({ details: new Map([[44, product(44, changes)]]) })));
  }
  await assert.rejects(run(api({ catalog: [grouped({ spec_group: group({ specs: [spec(62, '1刀', { stock: null }), spec(61, '10刀')] }) })] })));
});

test('catcard rejects a failed later detail and never marks a partial snapshot complete', async () => {
  let complete = 0;
  await assert.rejects(run(api({ catalog: [product(), product(45)], details: new Map([[44, product()], [45, product(45)]]),
    intercept: url => url.pathname === '/api/products/45' ? new Response('', { status: 503 }) : undefined }), { onListComplete: () => { complete++; } }));
  assert.equal(complete, 0);
  for (const categories of [{ data: groups }, [{ id: 11, name: '' }], [...groups, groups[0]], []]) await assert.rejects(run(api({ categories })));
});

test('catcard propagates cancellation before and during its final detail read', async () => {
  const before = new AbortController(); before.abort();
  await assert.rejects(run(api(), { signal: before.signal }), { name: 'AbortError' });
  const during = new AbortController();
  await assert.rejects(run(api({ intercept: url => { if (url.pathname === '/api/products/44') during.abort(); } }), { signal: during.signal }), { name: 'AbortError' });
});

test('catcard probe reads at most three independently confirmed products within five requests', async () => {
  const specs = [spec(62, '1刀'), spec(61, '10刀'), spec(82, '50刀'), spec(66, '100刀'), spec(74, '1000刀')];
  const spec_group = group({ specs });
  let requests = 0;
  const products = await probe(shop, api({ catalog: [grouped({ spec_group })],
    details: new Map(specs.map(sku => [sku.product_id, product(sku.product_id, { name: sku.product_name, group_id: 16, spec_group })])),
    intercept: () => { requests++; } }));
  assert.deepEqual(products.map(x => x.externalId), ['62', '61', '82']);
  assert.equal(requests, 5);
});

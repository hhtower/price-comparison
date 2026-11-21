import test from 'node:test';
import assert from 'node:assert/strict';
import { crawl, probe } from '../src/platforms/public-products-v1.js';
import { buildSourceEvidence, captureRatingText } from '../src/platforms/source-evidence.js';

test('product links follow the storefront route while API detail paths stay unchanged', async () => {
  const item = { id: 1, slug: 'claude pro/30', title: 'Claude Pro',
    skus: [{ id: 2, is_active: true, stock_status: 'in_stock', price_amount: '5', spec_values: {} }] };
  for (const [host, prefix] of [
    ['gpthub.ciyuanapi.ai', '/item/'], ['cccrad.uk', '/products/'],
    ['gpthub.ciyuanapi.ai.example.test', '/products/'],
  ]) {
    const shop = { url: `https://${host}/` }, calls = [];
    const fetchImpl = async input => {
      const url = new URL(input);
      calls.push(url.pathname);
      return Response.json({ status_code: 0, data: url.search ? [item] : item,
        pagination: { page: 1, page_size: 12, total: 1, total_page: 1 } });
    };
    for (const run of [() => probe(shop, fetchImpl),
      () => crawl(null, shop, fetchImpl, { settlementProductIds: new Set() })]) {
      assert.equal((await run())[0].url, `${shop.url.slice(0, -1)}${prefix}claude%20pro%2F30`);
    }
    assert.deepEqual(calls, Array(2).fill(['/api/v1/public/products', '/api/v1/public/products/claude%20pro%2F30']).flat());
  }
});

test('probe accepts missing list SKUs only with a verified product detail', async () => {
  const summary = { id: 1, slug: 'one', title: 'One' };
  const skus = [{ id: 2, is_active: true, stock_status: 'in_stock', price_amount: '5', spec_values: {} }];
  const run = detail => probe({ url: 'https://example.test' }, async input => Response.json({
    status_code: 0, data: new URL(input).search ? [summary] : detail,
    pagination: { page: 1, page_size: 12, total: 1, total_page: 1 },
  }));
  assert.deepEqual((await run({ ...summary, skus })).map(row => row.externalId), ['1:2']);
  await assert.rejects(run(summary), /invalid product/);
  await assert.rejects(run({ ...summary, skus, id: 3 }), /identity mismatch/);
});

test('missing SKU summaries use verified details and skip only confirmed omissions in partial sync', async () => {
  const parents = [1, 2].map(id => ({ id, slug: `item-${id}`, title: `Item ${id}` }));
  const sku = { id: 7, is_active: true, stock_status: 'in_stock', price_amount: '10', spec_values: {} };
  const run = (details, options) => crawl(null, { url: 'https://example.test' }, async input => {
    const url = new URL(input);
    const data = url.search ? parents : details.find(item => url.pathname.endsWith(`/${item.slug}`));
    return Response.json({ status_code: 0, data, pagination: { page: 1, page_size: 12, total: 2, total_page: 1 } });
  }, { settlementProductIds: new Set(), ...options });
  const complete = parents.map(parent => ({ ...parent, skus: [sku] }));
  const mixed = [parents[0], complete[1]];
  let partial = 0, stats;
  const options = { onPartialList: () => partial++, onListStats: value => { stats = value; } };
  assert.equal((await run(complete, options)).length, 2);
  assert.equal(partial, 0);
  assert.deepEqual((await run(mixed, options)).map(product => product.externalId), ['2:7']);
  assert.equal(partial, 1);
  assert.equal(stats.missingSkuProducts, 1);
  await assert.rejects(run(mixed, {}), /invalid product/);
  await assert.rejects(run(parents, options), /incomplete snapshot/);
  await assert.rejects(run([{ ...parents[0], id: 3 }, complete[1]], options), /identity mismatch/);
  await assert.rejects(run([{ ...parents[0], skus: {} }, complete[1]], options), /invalid product/);
  assert.equal(partial, 1);
});

test('source evidence removes root spec aliases including inherited aliases', () => {
  assert.deepEqual(buildSourceEvidence({
    spec: { term: 'month' }, selectedOptions: 'month', sku: { code: 'opaque' },
    specification: 'month', sourceData: { selected_options: 'month', SKU: {}, minimum: 2 },
    description: 'body',
  }), { minimum: 2, evidence: 'body' });
});

test('public products localizes selected specs and never uses SKU codes as semantic evidence', async () => {
  const item = {
    id: 1, slug: 'account', title: { 'zh-CN': '  Original title  ' },
    description: { 'zh-CN': ' Raw\nbody ' }, content: { 'zh-CN': '' },
    min_purchase_quantity: 2,
    skus: [
      { id: 2, spec_values: { term: { 'en-US': 'month', 'zh-CN': ' Ａ　月 ' }, access: { 'zh-CN': '独享' } } },
      { id: 3, spec_values: { 'en-US': 'year', 'zh-CN': ' 年卡 ' } },
      { id: 4, spec_values: {}, sku_code: 'opaque-code' },
    ].map(sku => ({ is_active: true, stock_status: 'in_stock', price_amount: '10', ...sku })),
  };
  const products = await probe({ url: 'https://example.test' }, async input => {
    const path = new URL(input).pathname;
    return Response.json({ status_code: 0, data: path.endsWith('/account') ? item : [item],
      pagination: { page: 1, page_size: 12, total: 1, total_page: 1 } });
  });
  assert.deepEqual(products.map(p => [p.externalId, p.spec]), [
    ['1:2', 'access: 独享 / term: A 月'], ['1:3', '年卡'], ['1:4', ''],
  ]);
  assert.equal(products[2].name, 'Original title');
  for (const product of products) {
    for (const key of ['selectedOptions', 'sku', 'specification', 'spec']) assert.equal(key in product.sourceData, false);
    assert.equal(product.sourceData.min_purchase_quantity, 2);
    assert.deepEqual(product.ratingText, captureRatingText(1, '  Original title  ', ' Raw\nbody ', ''));
    assert.equal(product.sourceName, '  Original title  ');
  }
});

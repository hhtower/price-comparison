import test from 'node:test';
import assert from 'node:assert/strict';
import { probe } from '../src/platforms/public-products-v1.js';
import { buildSourceEvidence, captureRatingText } from '../src/platforms/source-evidence.js';

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

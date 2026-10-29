import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeProductEvidence,
  productContentFingerprint,
} from '../src/standardization/fingerprint.js';

test('shop metadata does not split identical goods while category meaning and selected options remain evidence', () => {
  const listing = (id: number) => ({
    name: 'gro普号(库存)', spec: 'duration: 1 month',
    sourceData: {
      category: { id, name: 'grok' }, user: { nickname: `商家${id}`, avatar: `https://shop.invalid/${id}` },
      create_time: id, contact_format: 'any', coupon_status: id, discount: id,
      extend: { limit_count: 1, send_order: id, show_stock_type: id, query_password_status: id },
      evidence: '清库存，有一些可用build，有的只能console和web',
    },
  });
  assert.equal(productContentFingerprint(listing(1)), productContentFingerprint(listing(2)));
  const normalized = normalizeProductEvidence(listing(1));
  assert.deepEqual(normalized.sourceData.category, { name: 'grok' });
  assert.equal(normalized.sourceData.user, undefined);
  assert.equal(normalized.sourceData.create_time, undefined);
  const changed = listing(1);
  changed.sourceData.category.name = 'SuperGrok';
  assert.notDeepEqual(normalizeProductEvidence(listing(1)), normalizeProductEvidence(changed));
  changed.sourceData.category.name = 'grok';
  changed.spec = 'duration: 12 months';
  assert.notDeepEqual(normalizeProductEvidence(listing(1)), normalizeProductEvidence(changed));
});
test('price and stock do not change the product fingerprint', () => {
  const base = {
    name: '显卡 RTX 5090', spec: '32GB', sourceCategory: 'GPU',
    sourceData: { vendor: 'A', evidence: 'x', price: 9999, stock: true, stock_available_status: '', extend: { stock_count: 3 } },
  };
  const quoteOnly = { ...base, sourceData: { ...base.sourceData, price: 8888, stock: false, stock_available_status: 'out', extend: { stock_count: 0 } } };
  assert.equal(productContentFingerprint(base), productContentFingerprint(quoteOnly));
});

test('normalization preserves complete fact evidence and ordered options while excluding quote fields', () => {
  const normalized = normalizeProductEvidence({
    name: '  Foo   Bar ',
    spec: '  16 GB  ',
    sourceCategory: ' GPU ',
    sourceData: {
      vendor: ' Acme ', price: 100, stock: true,
      evidence: `${'x'.repeat(9000)} tail-conflict`, family: ['z', 'a'],
      nested: { product: ' ChatGPT ', tier: ' Plus ' },
    },
  });
  assert.equal(normalized.name, 'Foo Bar');
  assert.equal(normalized.spec, '16 GB');
  assert.equal(normalized.sourceCategory, 'GPU');
  assert.equal(normalized.sourceData.vendor, 'Acme');
  assert.equal(normalized.sourceData.price, undefined);
  assert.equal(normalized.sourceData.stock, undefined);
  assert.deepEqual(normalized.sourceData.family, ['z', 'a']);
  assert.deepEqual(normalized.sourceData.nested, { product: 'ChatGPT', tier: 'Plus' });
  assert.match(String(normalized.sourceData.evidence), /tail-conflict$/);
  assert.equal(normalizeProductEvidence({ name: `${'a'.repeat(600)} tail`, spec: `${'b'.repeat(1200)} annual`, sourceCategory: '', sourceData: {} }).name.endsWith('tail'), true);
});

test('duplicate specification fields are excluded from downstream evidence', () => {
  const result = normalizeProductEvidence({ name: 'Account', spec: 'monthly', sourceData: {
    selectedOptions: 'annual', sku: { code: 'internal-123', specification: 'annual' },
    specification: 'annual', spec: 'annual', evidence: 'Original body',
  } });
  assert.equal(result.spec, 'monthly');
  assert.deepEqual(result.sourceData, { evidence: 'Original body' });
});

test('ordered source options and evidence tails remain available to business processing', () => {
  const base = { name: 'Account', spec: 'plan', sourceData: { options: ['1 month', 'shared'], evidence: `${'x'.repeat(9000)} Plus` } };
  assert.notDeepEqual(normalizeProductEvidence(base), normalizeProductEvidence({ ...base, sourceData: { ...base.sourceData, options: [...base.sourceData.options].reverse() } }));
  assert.notDeepEqual(normalizeProductEvidence(base), normalizeProductEvidence({ ...base, sourceData: { ...base.sourceData, evidence: `${'x'.repeat(9000)} Pro` } }));
});

test('evidence changes produce a different fingerprint while quote fields remain ignored', () => {
  const original = { name: 'Phone X', spec: '128GB', sourceCategory: 'phone', sourceData: { brand: 'A', evidence: 'listing-1', price: 1 } };
  const renamed = { ...original, name: 'Phone X Pro' };
  const quote = { ...original, sourceData: { ...original.sourceData, price: 2, stock: false } };
  assert.notEqual(productContentFingerprint(original), productContentFingerprint(renamed));
  assert.equal(productContentFingerprint(original), productContentFingerprint(quote));
});

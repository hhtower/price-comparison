import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { productContentFingerprint } from '../src/standardization/fingerprint.js';

test('content fingerprint hashes original name, description and canonical spec', () => {
  const source = { name: '  ＣｈａｔＧＰＴ Plus\n', description: '<p>Full  body</p>\n' };
  assert.equal(productContentFingerprint(source),
    createHash('sha256').update(JSON.stringify([source.name, source.description, ''])).digest('hex'));
  for (const changed of [
    { ...source, name: 'ChatGPT Plus' },
    { ...source, description: '<p>Full body</p>\n' },
    { ...source, description: '<p>Different body</p>\n' },
  ]) assert.notEqual(productContentFingerprint(changed), productContentFingerprint(source));
});

test('prices, stock, categories and derived data cannot change content fingerprints', () => {
  const source = { name: 'ChatGPT Plus', description: 'Original source body.' };
  for (const extra of [
    { sourceCategory: 'Other category' },
    { sourceData: { evidence: 'Processed body.', price: 123, stock: 5 } },
    { sourceData: { serviceEvidence: { brands: ['OpenAI'], endpoints: ['https://api.invalid'] } } },
    { sourceData: { ratingText: { name: 'Derived name', description: 'Derived body', hash: 'different' } } },
  ]) assert.equal(productContentFingerprint({ ...source, ...extra }), productContentFingerprint(source));
});

test('spec changes invalidate content but formatting and option order do not', () => {
  const source = { name: 'Account', description: 'Original body', spec: '期限: 1个月 / 地区: 美区' };
  assert.equal(productContentFingerprint(source), productContentFingerprint({ ...source, spec: '地区：美区 / 期限: 1个月' }));
  assert.notEqual(productContentFingerprint(source), productContentFingerprint({ ...source, spec: '期限: 1年 / 地区: 美区' }));
  assert.equal(productContentFingerprint({ name: 'Account' }), productContentFingerprint({ name: 'Account', spec: '' }));
});

test('absent and explicitly empty source descriptions use the same empty description', () => {
  assert.equal(productContentFingerprint({ name: 'Listing' }),
    productContentFingerprint({ name: 'Listing', description: '' }));
  assert.notEqual(productContentFingerprint({ name: 'Listing', description: '' }),
    productContentFingerprint({ name: 'Listing', description: ' ' }));
});

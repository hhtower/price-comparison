import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProductTag } from '@price-comparison/catalog/product-tag-policy';
import { parseCatalogSearch, normalizePurchaseTag, purchaseTagLabel, purchaseWarrantyLabel, tagValueKey } from '@price-comparison/catalog/purchase-attributes';

test('warranty displays the complete scoped promise and never a legacy positive placeholder', () => {
  const text = '购买后1小时内仅保首登；自行改密不保';
  assert.equal(purchaseWarrantyLabel([{ name: 'warranty', value: text }]), text);
  for (const value of ['none', 'unknown', 'covered', '无售后', '有质保']) assert.equal(purchaseWarrantyLabel([{ name: 'warranty', value }]), '');
  assert.equal(purchaseWarrantyLabel([{ name: 'warranty_days', value: '30' }]), '');
});

test('normalization only accepts current fields and explicit negative override', () => {
  assert.deepEqual(normalizePurchaseTag({ name: 'subscription_override', value: '无' }), [{ name: 'subscription_override', value: '无' }]);
  assert.deepEqual(normalizePurchaseTag({ name: 'subscription_override', value: '有' }), []);
  assert.equal(normalizeProductTag({ name: 'delivery', value: 'account' }), undefined);
  assert.deepEqual(normalizeProductTag({ name: 'supported_client', value: 'Sub2API' }), [{ name: 'supported_client', value: 'sub2api' }]);
  assert.deepEqual(normalizeProductTag({ name: 'region', value: '菲律宾' }), [{ name: 'region', value: 'ph' }]);
});

test('search keeps warranty, age, redemption and qualified periods out of exact duration filters', () => {
  for (const query of ['质保30天', '30天质保', '30天内兑换', '号龄2年', '至少1个月', '约1个月', '1-3个月', '1个月以上', 'Plus 30天以内', 'Plus at least 30 days', 'Plus up to 30 days', 'Plus about 30 days']) {
    assert.equal(parseCatalogSearch(query).tags.some(tag => tag.name === 'duration' && typeof tag.value === 'number'), false, query);
  }
  assert.deepEqual(parseCatalogSearch('Plus 未接码 1个月'), { text: 'plus', tags: [
    { name: 'sms_verification', value: 'unverified' }, { name: 'duration', value: 30 },
  ] });
});

test('removed classification terms stay available to the independent membership search parser', () => {
  for (const query of ['成品号', '代充', '共享', '租号', '短期', '非日抛', '速刷']) {
    assert.deepEqual(parseCatalogSearch(query), { text: query, tags: [] });
  }
});

test('typed duration equality is independent of object key order and keeps distinct qualifiers', () => {
  assert.equal(tagValueKey({ kind: 'range', min: 7, max: 30 }), tagValueKey({ max: 30, min: 7, kind: 'range' }));
  assert.notEqual(tagValueKey(30), tagValueKey({ kind: 'min', days: 30 }));
  assert.equal(purchaseTagLabel({ name: 'duration', value: { kind: 'range', min: 30, max: 90 } }), '1-3个月');
  assert.equal(purchaseTagLabel({ name: 'duration', value: { kind: 'approx', days: 365 } }), '约1年');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { PRODUCT_TAG_RULES, isCanonicalProductTag, normalizeProductTag } from '@price-comparison/catalog/product-tag-policy';
import { normalizePurchaseTag, parseCatalogSearch, purchaseTagLabel } from '@price-comparison/catalog/purchase-attributes';
import * as attributes from '@price-comparison/catalog/purchase-attributes';

test('buying dimensions use only current keys without supporting terms', () => {
  assert.deepEqual(Object.keys(PRODUCT_TAG_RULES).sort(), [
    'sms_verification', 'region', 'duration', 'access_channel', 'supported_client',
    'subscription_override', 'bulk_purchase', 'subscription_warranty', 'usage_warranty',
  ].sort());
  for (const name of ['access', 'delivery', 'payment_region', 'warranty_days', 'warranty_terms', '2fa', 'renewable']) {
    assert.deepEqual(normalizePurchaseTag({ name, value: '有' }), []);
  }
  assert.equal(isCanonicalProductTag({ name: 'subscription_override', value: '有' }), false);
  assert.equal(isCanonicalProductTag({ name: 'subscription_override', value: '无' }), true);
});

test('duration is numeric days and preserves qualifiers without accepting legacy strings', () => {
  for (const value of [30, 90, 365, 360, 0.5]) {
    assert.equal(isCanonicalProductTag({ name: 'duration', value }), true);
  }
  for (const value of [0, -1, Infinity, NaN, '30', '1 month', { kind: 'range', min: 30, max: 7 }, { kind: ['min'], days: 30 }]) {
    assert.equal(isCanonicalProductTag({ name: 'duration', value }), false);
  }
  assert.equal(isCanonicalProductTag({ name: 'duration', value: { kind: 'min', days: 30 } }), true);
  assert.equal(isCanonicalProductTag({ name: 'duration', value: { kind: 'range', min: 7, max: 30 } }), true);
  assert.equal(isCanonicalProductTag({ name: 'duration', value: { kind: 'permanent' } }), true);
  assert.equal(isCanonicalProductTag({ name: 'duration', value: { kind: 'permanent', days: 30 } }), false);
});

test('fixed month/year conversions are shared with every display', () => {
  assert.equal(typeof attributes.durationToDays, 'function');
  assert.equal(attributes.durationToDays(1, 'month'), 30);
  assert.equal(attributes.durationToDays(12, 'month'), 360);
  assert.equal(attributes.durationToDays(1, 'year'), 365);
  assert.equal(attributes.durationToDays(12, 'hour'), 0.5);
  for (const [value, label] of [[30, '1个月'], [90, '3个月'], [365, '1年'], [360, '12个月'], [31, '31天'], [0.5, '12小时']] as const) {
    assert.equal(purchaseTagLabel({ name: 'duration', value }), label);
  }
  assert.equal(purchaseTagLabel({ name: 'duration', value: { kind: 'min', days: 30 } }), '至少1个月');
});

test('region, bulk and warranty normalize without recreating retired fields', () => {
  assert.deepEqual(normalizeProductTag({ name: 'region', value: '美区' }), [{ name: 'region', value: 'us' }]);
  assert.equal(purchaseTagLabel({ name: 'region', value: 'us' }), '美区');
  assert.equal(purchaseTagLabel({ name: 'bulk_purchase', value: 'supported' }), '支持批量购买');
  assert.equal(purchaseTagLabel({ name: 'bulk_purchase', value: 'required' }), '需批量购买');
  assert.equal(purchaseTagLabel({ name: 'bulk_purchase', value: 'bundle' }), '打包出售');
  assert.equal(purchaseTagLabel({ name: 'usage_warranty', value: '首登' }), '首登');
  assert.equal(isCanonicalProductTag({ name: 'warranty_terms', value: '仅保首登1小时，后续无售后' }), false);
  assert.equal(isCanonicalProductTag({ name: 'usage_warranty', value: '质保30天，质保到期后不再免费换货' }), false);
});

test('warranty formats are single-value and validated mechanically without interpreting wording', () => {
  for (const name of ['subscription_warranty', 'usage_warranty']) {
    assert.notEqual(PRODUCT_TAG_RULES[name].multiple, true);
    for (const value of ['质保 48 小时', '质保 0.125 小时', '质保 1.3333 天', '质保 1e+21 天', '质保（期限未注明）']) {
      const fact = { name, value };
      assert.equal(isCanonicalProductTag(fact), true, value);
      assert.deepEqual(normalizeProductTag(fact), [fact]);
      assert.equal(purchaseTagLabel(fact), value);
    }
    for (const value of [
      '', ' ', '质保30天', '首登保障', 'unknown', 'covered', '无售后', '有质保', '质保 0 天',
      '质保 -1 天', '质保 1e309 天', '质保 Infinity 天', '质保 NaN 天', '质保 60 分钟',
      '质保 1 月', ' 质保 1 天', '质保 1 天 ', '质保 1 天；封号不保', 'x'.repeat(251), 30, true, null, {},
    ]) assert.equal(isCanonicalProductTag({ name, value }), false, JSON.stringify(value));
  }
  assert.equal(isCanonicalProductTag({ name: 'usage_warranty', value: '首登' }), true);
  assert.equal(isCanonicalProductTag({ name: 'subscription_warranty', value: '首登' }), false);
  assert.equal('purchaseWarrantyTerms' in attributes, false);
});

test('search uses numeric durations without treating warranty or redemption deadlines as use periods', () => {
  assert.deepEqual(parseCatalogSearch('Plus 1个月 未接码').tags, [
    { name: 'sms_verification', value: 'unverified' }, { name: 'duration', value: 30 },
  ]);
  assert.equal(parseCatalogSearch('质保30天').tags.some(tag => tag.name === 'duration'), false);
  assert.equal(parseCatalogSearch('30天内兑换').tags.some(tag => tag.name === 'duration'), false);
  assert.equal(parseCatalogSearch('至少1个月').tags.some(tag => tag.name === 'duration' && tag.value === 30), false);
  assert.deepEqual(parseCatalogSearch('不可覆盖订阅').tags, [{ name: 'subscription_override', value: '无' }]);
});

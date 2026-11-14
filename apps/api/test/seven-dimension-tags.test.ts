import assert from 'node:assert/strict';
import test from 'node:test';
import { PRODUCT_TAG_RULES, isCanonicalProductTag, normalizeProductTag } from '@price-comparison/catalog/product-tag-policy';
import { normalizePurchaseTag, parseCatalogSearch, purchaseTagLabel, purchaseWarrantyLabel } from '@price-comparison/catalog/purchase-attributes';
import * as attributes from '@price-comparison/catalog/purchase-attributes';

test('only the eight keys of seven buying dimensions are accepted', () => {
  assert.deepEqual(Object.keys(PRODUCT_TAG_RULES).sort(), [
    'sms_verification', 'region', 'duration', 'access_channel', 'supported_client',
    'subscription_override', 'bulk_purchase', 'warranty',
  ].sort());
  for (const name of ['access', 'delivery', 'payment_region', 'warranty_days', '2fa', 'renewable']) {
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
  assert.equal(purchaseWarrantyLabel([{ name: 'warranty', value: '购买后1小时内仅保首登；封号不保' }]), '购买后1小时内仅保首登；封号不保');
  assert.equal(isCanonicalProductTag({ name: 'warranty', value: '仅保首登1小时，后续无售后' }), true);
  assert.equal(isCanonicalProductTag({ name: 'warranty', value: '质保30天，质保到期后不再免费换货' }), true);
});

test('text tags are validated structurally and displayed without guessing their meaning', () => {
  for (const value of [
    '到手1小时内无法使用可联系处理；超过1小时不售后；登录后封禁不退款不换号',
    '密码或2FA错误可联系处理；账号被封禁不处理',
    '一个月内掉订阅但账号未封可按天售后',
    '卡密一次性，不退不换', '不享受质保', '质保已过期', 'unknown',
    'El vendedor ayuda si no funciona al recibirlo.',
  ]) {
    const fact = { name: 'warranty', value };
    assert.equal(isCanonicalProductTag(fact), true, value);
    assert.deepEqual(normalizeProductTag(fact), [fact]);
    assert.equal(purchaseWarrantyLabel([fact]), value);
  }
  for (const value of ['', ' ', ' leading', 'trailing ', 'x'.repeat(251), 30, true, null, {}]) {
    assert.equal(isCanonicalProductTag({ name: 'warranty', value }), false);
  }
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

import { expect, test } from 'vitest';
import { displayPurchaseTagText, displayPurchaseTagValue } from './purchase-tag-values.js';

test.each([
  [30, '1个月'], [90, '3个月'], [365, '1年'], [360, '12个月'], [31, '31天'], [0.5, '12小时'],
  [{ kind: 'min', days: 30 }, '至少1个月'], [{ kind: 'max', days: 90 }, '最多3个月'],
  [{ kind: 'approx', days: 365 }, '约1年'], [{ kind: 'permanent' }, '永久'],
])('formats numeric duration %j without parsing units', (value, label) => {
  expect(displayPurchaseTagValue({ name: 'duration', value })).toBe(label);
  expect(displayPurchaseTagText({ name: 'duration', value })).toBe(label);
});

test('retains both range endpoints', () => {
  const text = displayPurchaseTagText({ name: 'duration', value: { kind: 'range', min: 30, max: 365 } });
  expect(text).toBe('30-365天');
});

test.each([
  ['sms_verification', 'verified', '已接码'], ['sms_verification', 'unverified', '未接码'],
  ['region', 'us', '美区'], ['region', 'jp', '日区'],
  ['subscription_override', '无', '不可覆盖订阅'], ['bulk_purchase', 'supported', '支持批量'],
])('formats %s without expanding its meaning', (name, value, text) => {
  expect(displayPurchaseTagText({ name, value })).toContain(text);
});

test('keeps bulk meanings distinct and rejects retired warranty conditions', () => {
  const labels = ['supported', 'required', 'bundle'].map(value => displayPurchaseTagText({ name: 'bulk_purchase', value }));
  expect(new Set(labels).size).toBe(3);
  const value = '购买后1小时内仅保首登，封号不保';
  expect(displayPurchaseTagValue({ name: 'warranty_terms', value })).toBe('');
});

test.each([
  ['subscription_warranty', '质保 12 天', '订阅质保12天'],
  ['subscription_warranty', '质保 2.5 小时', '订阅质保2.5小时'],
  ['subscription_warranty', '质保（期限未注明）', '订阅质保'],
  ['usage_warranty', '质保 12 天', '使用质保12天'],
  ['usage_warranty', '质保 2.5 小时', '使用质保2.5小时'],
  ['usage_warranty', '首登', '首登'],
  ['usage_warranty', '质保（期限未注明）', '使用质保'],
])('identifies the coverage of %s:%s without changing its value', (name, value, text) => {
  expect(displayPurchaseTagValue({ name, value })).toBe(value);
  expect(displayPurchaseTagText({ name, value })).toBe(text);
  expect(displayPurchaseTagText({ name, value }, value)).toBe(text);
});

test.each([
  ['duration', '1 month'], ['warranty_days', '30'], ['delivery', 'account'],
  ['warranty', ''], ['warranty', 'x'.repeat(251)], ['subscription_override', '有'],
  ['subscription_warranty', ''], ['usage_warranty', '无售后'], ['subscription_warranty', '首登'],
])('does not display obsolete or invalid %s:%s', (name, value) => {
  expect(displayPurchaseTagText({ name, value })).toBe('');
});

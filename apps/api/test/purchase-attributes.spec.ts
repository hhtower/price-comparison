import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProductTag } from '@price-comparison/catalog/product-tag-policy';
import {
  parseCatalogSearch,
  normalizePurchaseTag,
  purchaseTagLabel,
  PURCHASE_ATTRIBUTE_DEFINITIONS,
  PURCHASE_NAME_ALIASES,
  consumeRapidSearchTerms,
  purchaseWarrantyLabel,
} from '@price-comparison/catalog/purchase-attributes';

test('qualified warranty labels expose the starting event and additional reviewed terms', () => {
  assert.equal(purchaseWarrantyLabel([
    { name: 'warranty', value: 'covered' }, { name: 'warranty_scope', value: 'first_login' },
    { name: 'warranty_window', value: '60 minutes' }, { name: 'warranty_trigger', value: 'purchase' },
    { name: 'warranty_terms', value: '修改2fa导致登录失败不售后' },
  ]), '仅保首登（60分钟内）（购买起算；附售后条款）');
});

test('shared policy normalizes reviewed recall aliases and w counts without accepting qualified values', () => {
  for (const value of ['2.4w积分', '2.4W积分', '2.4万积分', '24k积分'])
    assert.deepEqual(normalizeProductTag({ name: 'credits', value }), [{ name: 'credits', value: '24000' }]);
  assert.deepEqual(normalizeProductTag({ name: 'delivery', value: '人工手动充值' }), [{ name: 'delivery_mode', value: 'manual' }]);
  assert.deepEqual(normalizeProductTag({ name: 'subscription_override', value: '不可覆盖订阅' }), [{ name: 'subscription_override', value: '无' }]);
  assert.deepEqual(normalizeProductTag({ name: 'subscription_override', value: '可覆盖' }), [{ name: 'subscription_override', value: '有' }]);
  for (const value of ['最多2.4w积分', '可能2.4w积分', '2.4w元', '-2.4w积分'])
    assert.equal(normalizeProductTag({ name: 'credits', value }), undefined);
  assert.equal(normalizeProductTag({ name: 'delivery', value: '不支持人工手动充值' })?.some(tag => tag.name === 'delivery_mode'), false);
  assert.equal(normalizeProductTag({ name: 'subscription_override', value: '可能不可覆盖订阅' }), undefined);
});

test('warranty labels show explicit time without widening limited coverage or converting months', () => {
  for (const [tags, expected] of [
    [[{ name: 'warranty_scope', value: 'subscription' }, { name: 'warranty_window', value: '30 days' }], '质保30天（仅保掉订阅）'],
    [[{ name: 'warranty_scope', value: 'period' }, { name: 'warranty_window', value: '24 hours' }], '质保24小时'],
    [[{ name: 'warranty_scope', value: 'period' }, { name: 'warranty_detail', value: '1 month' }], '质保1个月'],
    [[{ name: 'warranty_scope', value: 'first_login' }, { name: 'warranty_window', value: '1 hour' }], '仅保首登（1小时内）'],
    [[{ name: 'warranty_scope', value: 'first_login' }, { name: 'warranty_days', value: '1' }], '仅保首登'],
    [[{ name: 'warranty', value: 'none' }, { name: 'warranty_days', value: '30' }], '无质保'],
    [[{ name: 'warranty_scope', value: 'unspecified' }], ''],
  ] as const) assert.equal(purchaseWarrantyLabel([...tags]), expected);
});

test('parses product text, verified SMS and a minimum warranty period', () => {
  assert.deepEqual(parseCatalogSearch('ChatGPT Plus 已接码 质保至少30天'), {
    text: 'chatgpt plus',
    tags: [
      { name: 'sms_verification', value: 'verified' },
      { name: 'warranty', value: 'covered' },
      { name: 'warranty_scope', value: 'period' },
      { name: 'warranty_days', value: '30' },
    ],
    warrantyDaysMin: 30,
  });
});

test('keeps negative purchase conditions from satisfying a positive state', () => {
  const parsed = parseCatalogSearch('未接码 无质保');
  assert.deepEqual(parsed.tags, [
    { name: 'sms_verification', value: 'unverified' },
    { name: 'warranty', value: 'none' },
  ]);
  assert.equal(parsed.tags.some((tag) => tag.value === 'verified'), false);
  assert.equal(parsed.tags.some((tag) => tag.value === 'covered'), false);
});

test('parses first-login warranty without creating a subscription duration', () => {
  const parsed = parseCatalogSearch('质保首登');
  assert.deepEqual(parsed.tags, [
    { name: 'warranty', value: 'covered' },
    { name: 'warranty_scope', value: 'first_login' },
  ]);
  assert.equal(parsed.tags.some((tag) => tag.name === 'duration'), false);
});

test('keeps a warranty month separate from subscription duration', () => {
  assert.deepEqual(parseCatalogSearch('质保1个月'), {
    text: '',
    tags: [
      { name: 'warranty', value: 'covered' },
      { name: 'warranty_scope', value: 'period' },
      { name: 'warranty_detail', value: '1 month' },
    ],
  });
});

test('preserves ordinary unknown words and unsupported negative rapid intent', () => {
  assert.deepEqual(parseCatalogSearch('Claude 不要速刷 特殊版'), {
    text: 'claude 不要速刷 特殊版',
    tags: [],
  });
});

test('daily search synonyms share one rapid purchase condition without inventing a duration', () => {
  for (const query of ['Claude 日抛', 'Claude 日抛号', 'Claude 速刷', 'Claude 日抛 速刷']) {
    assert.deepEqual(parseCatalogSearch(query), { text: 'claude', tags: [{ name: 'intended_use', value: 'rapid' }] });
  }
  for (const value of ['日抛', '日抛号', '速刷', 'rapid']) {
    assert.deepEqual(normalizePurchaseTag({ name: 'intended_use', value }), [{ name: 'intended_use', value: 'rapid' }]);
  }
  assert.deepEqual(normalizePurchaseTag({ name: 'duration', value: '1 day' }), [{ name: 'duration', value: '1 day' }]);
  assert.deepEqual(normalizePurchaseTag({ name: 'intended_use', value: 'unknown' }), [{ name: 'intended_use', value: 'unknown' }]);
});

test('negative daily or rapid searches do not become positive purchase facts', () => {
  for (const query of ['不要日抛', '非日抛号', '不支持日抛', '不适合速刷', '禁止速刷',
    '不提供日抛', '日抛不支持', '是否日抛未说明', '可能是日抛', '日抛状态未知',
    '不要rapid delivery', '不支持rapid refresh', 'rapid delivery未说明']) {
    assert.deepEqual(parseCatalogSearch(query), { text: query, tags: [] });
  }
  assert.equal(consumeRapidSearchTerms('Claude 非日抛 速刷 日抛号'), 'Claude 非日抛 速刷 日抛号');
});

test('normalizes existing Chinese and English purchase values, including expanded warranty facts', () => {
  assert.deepEqual(normalizePurchaseTag({ name: '短信验证', value: '已接码' }), [
    { name: 'sms_verification', value: 'verified' },
  ]);
  assert.deepEqual(normalizePurchaseTag({ name: 'warranty', value: '30天质保' }), [
    { name: 'warranty', value: 'covered' },
    { name: 'warranty_scope', value: 'period' },
    { name: 'warranty_days', value: '30' },
  ]);
  assert.deepEqual(normalizePurchaseTag({ name: 'duration', value: '1个月' }), [
    { name: 'duration', value: '1 month' },
  ]);
  assert.deepEqual(normalizePurchaseTag({ name: 'warranty', value: 'first login only' }), [
    { name: 'warranty', value: 'covered' },
    { name: 'warranty_scope', value: 'first_login' },
  ]);
  assert.deepEqual(normalizePurchaseTag({ name: 'warranty', value: '1 month' }), [
    { name: 'warranty', value: 'covered' },
    { name: 'warranty_scope', value: 'period' },
    { name: 'warranty_detail', value: '1 month' },
  ]);
  assert.deepEqual(normalizePurchaseTag({ name: 'warranty', value: 'covered unknown' }), [
    { name: 'warranty_detail', value: 'covered unknown' },
  ]);
  assert.deepEqual(normalizePurchaseTag({ name: 'Custom Label', value: 'Mixed Value' }), [
    { name: 'custom label', value: 'mixed value' },
  ]);
});

test('recognizes access, delivery and subscription duration while preserving invalid periods', () => {
  assert.deepEqual(parseCatalogSearch('独享 成品账号 代充 1个月'), {
    text: '',
    tags: [
      { name: 'access', value: 'dedicated' },
      { name: 'delivery', value: 'account' },
      { name: 'delivery', value: 'top_up' },
      { name: 'duration', value: '1 month' },
    ],
  });

  const invalid = parseCatalogSearch('质保至少0天');
  assert.equal(invalid.warrantyDaysMin, undefined);
  assert.match(invalid.text, /0天/);
  assert.match(parseCatalogSearch('质保-1天').text, /-1天/);
  assert.match(parseCatalogSearch('质保20-30天').text, /20-30天/);
});

test('provides consumer labels and reusable normalization contracts', () => {
  assert.equal(purchaseTagLabel({ name: 'sms_verification', value: 'verified' }), '已接码');
  assert.equal(purchaseTagLabel({ name: 'warranty', value: 'unknown' }), '质保未说明');
  assert.equal(purchaseTagLabel({ name: 'intended_use', value: 'rapid' }), '速刷');
  assert.equal(purchaseTagLabel({ name: 'warranty_days', value: '30' }), '质保30天');
  assert.ok(PURCHASE_ATTRIBUTE_DEFINITIONS.some((definition) => definition.name === 'sms_verification' && definition.quick));
  assert.equal(PURCHASE_NAME_ALIASES['短信验证'], 'sms_verification');
  assert.deepEqual(normalizePurchaseTag({ name: 'warranty', value: '有质保' }), [{ name: 'warranty', value: 'covered' }]);
});

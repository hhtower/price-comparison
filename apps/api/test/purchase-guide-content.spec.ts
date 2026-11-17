import assert from 'node:assert/strict';
import test from 'node:test';
import { PRODUCT_TAG_RULES } from '@price-comparison/catalog/product-tag-policy';
import { PURCHASE_GUIDE_FIELDS, PURCHASE_GUIDE_GROUPS } from '@price-comparison/catalog/purchase-guide-content';

test('every canonical field has explicit consumer content and shares validation vocabulary', () => {
  assert.deepEqual(Object.keys(PURCHASE_GUIDE_FIELDS).sort(), Object.keys(PRODUCT_TAG_RULES).sort());
  for (const [name, rule] of Object.entries(PRODUCT_TAG_RULES)) {
    const field = PURCHASE_GUIDE_FIELDS[name];
    assert.match(field.label, /[\u4e00-\u9fff]/u, name);
    assert.ok(field.explanation.length > 5, name);
    assert.ok(PURCHASE_GUIDE_GROUPS.some(group => group.id === field.displayGroup), name);
    assert.ok(field.appliesTo && field.collectionGroup && field.valueType, name);
    assert.ok(Number.isFinite(field.summaryPriority), name);
    assert.equal(field.rule, rule, name);
    assert.equal(field.unknownHandling, 'omit', name);
  }
});

test('consumer descriptions distinguish product region from network advice and explain fixed days', () => {
  assert.match(PURCHASE_GUIDE_FIELDS.region.explanation, /IP商品/u);
  assert.match(PURCHASE_GUIDE_FIELDS.region.explanation, /不是账号地区/u);
  assert.match(PURCHASE_GUIDE_FIELDS.duration.explanation, /30天.*365天/u);
  assert.match(PURCHASE_GUIDE_FIELDS.bulk_purchase.explanation, /不代替实际结算数量/u);
  assert.equal(PURCHASE_GUIDE_FIELDS.warranty_terms, undefined);
  for (const name of ['subscription_warranty', 'usage_warranty']) {
    assert.equal(PURCHASE_GUIDE_FIELDS[name].appliesTo, 'AI 会员商品');
    assert.match(PURCHASE_GUIDE_FIELDS[name].explanation, /质保 X 小时.*质保 X 天.*质保（期限未注明）/u);
    assert.match(PURCHASE_GUIDE_FIELDS[name].explanation, /未明确保障时省略/u);
    assert.match(PURCHASE_GUIDE_FIELDS[name].explanation, /无条件/u);
    assert.match(PURCHASE_GUIDE_FIELDS[name].explanation, /商家说明/u);
  }
  assert.match(PURCHASE_GUIDE_FIELDS.usage_warranty.explanation, /首登仅指首次登录/u);
  assert.equal(PURCHASE_GUIDE_FIELDS.access_channel.displayGroup, PURCHASE_GUIDE_FIELDS.supported_client.displayGroup);
  assert.equal(PURCHASE_GUIDE_GROUPS.length, 8);
});

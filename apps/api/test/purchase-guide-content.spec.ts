import assert from 'node:assert/strict';
import test from 'node:test';
import { PRODUCT_TAG_RULES } from '@price-comparison/catalog/product-tag-policy';
import { PURCHASE_GUIDE_FIELDS, PURCHASE_GUIDE_GROUPS } from '@price-comparison/catalog/purchase-guide-content';
import { standardizationFlowControls } from './fixtures/standardization-flow-controls-20261008.ts';

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
  assert.match(PURCHASE_GUIDE_FIELDS.warranty.explanation, /免责/u);
  assert.equal(PURCHASE_GUIDE_FIELDS.access_channel.displayGroup, PURCHASE_GUIDE_FIELDS.supported_client.displayGroup);
  assert.equal(PURCHASE_GUIDE_GROUPS.length, 7);
});

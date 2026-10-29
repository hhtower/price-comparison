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

test('distinct evidence scopes remain distinct in explanations and summary order', () => {
  assert.match(PURCHASE_GUIDE_FIELDS.duration.explanation, /订阅|使用期限/u);
  assert.match(PURCHASE_GUIDE_FIELDS.token_validity.explanation, /令牌/u);
  assert.match(PURCHASE_GUIDE_FIELDS.warranty_scope.explanation, /首登|保障范围/u);
  assert.match(PURCHASE_GUIDE_FIELDS.recommended_ip_region.explanation, /建议/u);
  assert.match(PURCHASE_GUIDE_FIELDS.usage_restriction.explanation, /限制/u);
  assert.ok(PURCHASE_GUIDE_FIELDS.usage_restriction.summaryPriority < PURCHASE_GUIDE_FIELDS.color.summaryPriority);
});

test('reviewed product evidence has distinct content for format, software and prohibitions', () => {
  for (const id of ['team-json-software', 'team-ban-not-capability']) {
    const fixture = standardizationFlowControls.find(item => item.id === id)!;
    assert.ok(fixture.body);
    for (const name of Object.keys(fixture.expectedTags ?? {})) assert.ok(PURCHASE_GUIDE_FIELDS[name], name);
  }
  assert.notEqual(PURCHASE_GUIDE_FIELDS.delivery_format.explanation, PURCHASE_GUIDE_FIELDS.supported_client.explanation);
  assert.notEqual(PURCHASE_GUIDE_FIELDS.access.explanation, PURCHASE_GUIDE_FIELDS.access_channel.explanation);
});

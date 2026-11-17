import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePurchaseTag, PURCHASE_ATTRIBUTE_DEFINITIONS } from '@price-comparison/catalog/purchase-attributes';
import { validateProductTags } from '../src/products/product-tags.js';
import { normalizeCatalogQuery } from '../src/catalog/catalog.service.js';
import { validateReviewedTagExtractionDecision, buildTagExtractionOutcome, resolveTagExtractionFacts } from '../src/ai/tag-extraction-result.js';
import type { WarrantyLabels } from '../src/ai/tag-warranty-request.js';

const warrantyLabels: WarrantyLabels = {
  subscription_warranty: 30, subscription_warranty_t: 'day',
  usage_warranty: null, usage_warranty_t: 'first_login',
};
const tags = [
  { name: 'subscription_warranty', value: '质保 30 天' },
  { name: 'usage_warranty', value: '首登' },
];

test('dedicated warranty labels publish public values alongside general facts without narrative terms', () => {
  const general = validateReviewedTagExtractionDecision(1n, [
    { name: 'duration', value: 30, evidence: [], proposalIndex: 0 },
  ], [], {}, [true], true);
  const decision = { ...general, warrantyLabels };
  const outcome = buildTagExtractionOutcome(decision, []);
  assert.deepEqual(outcome.after, [{ name: 'duration', value: 30 }, ...tags]);
  assert.deepEqual(resolveTagExtractionFacts(decision), outcome.after);
  assert.deepEqual(outcome.warrantyLabels, warrantyLabels);
  assert.equal(outcome.successfulCount, 3);
  assert.equal(outcome.failedCount, 0);
  assert.equal(outcome.outcome, 'updated');
  assert.deepEqual(outcome.review, { mode: 'per_tag_binary', decisions: [true] });
});

test('public warranty values survive editing, display normalization and exact catalog filters', () => {
  for (const name of ['subscription_warranty', 'usage_warranty']) {
    for (const value of ['质保 30 天', '质保 1.5 小时', '质保（期限未注明）', ...(name === 'usage_warranty' ? ['首登'] : [])]) {
      const tag = { name, value };
      assert.deepEqual(validateProductTags([tag]), [tag]);
      assert.deepEqual(normalizePurchaseTag(tag), [tag]);
      assert.deepEqual(normalizeCatalogQuery({ tags: [tag] }).tags, [tag]);
    }
    assert.ok(PURCHASE_ATTRIBUTE_DEFINITIONS.some(field => field.name === name));
  }
});

test('retired warranty names and narrative values cannot be edited or used as filters', () => {
  for (const tag of [
    { name: 'warranty', value: '质保 30 天' },
    { name: 'warranty_terms', value: '质保 30 天' },
    { name: 'subscription_warranty', value: '首登' },
    { name: 'usage_warranty', value: '封号保障7天' },
    { name: 'usage_warranty', value: '质保 0 天' },
  ]) {
    assert.throws(() => validateProductTags([tag]));
    assert.throws(() => normalizeCatalogQuery({ tags: [tag] }));
    assert.deepEqual(normalizePurchaseTag(tag), []);
  }
  assert.ok(!PURCHASE_ATTRIBUTE_DEFINITIONS.some(field => ['warranty', 'warranty_terms'].includes(field.name)));
});

test('general rejection cannot replace dedicated warranty labels or prevent their publication', () => {
  const general = validateReviewedTagExtractionDecision(1n, [
    { name: 'subscription_warranty', value: '质保 7 天', evidence: [], proposalIndex: 0 },
  ], [], {}, [true], false);
  assert.deepEqual(general.tags, []);
  assert.equal(general.rejectedTags[0]!.reasonCode, 'tag_name_unknown');
  const outcome = buildTagExtractionOutcome({ ...general, warrantyLabels }, []);
  assert.deepEqual(outcome.after, tags);
  assert.deepEqual(outcome.warrantyLabels, warrantyLabels);
  assert.equal(outcome.outcome, 'partial_success');
  assert.equal(outcome.successfulCount, 2);
  assert.equal(outcome.failedCount, 1);
  assert.equal(outcome.complete, false);
});

test('current dedicated labels replace old values and absent labels clear old warranty facts', () => {
  const general = validateReviewedTagExtractionDecision(1n, [], [], {}, [], true);
  const onlyUsage: WarrantyLabels = {
    subscription_warranty: null, subscription_warranty_t: null,
    usage_warranty: 6, usage_warranty_t: 'hour',
  };
  const replacement = buildTagExtractionOutcome({ ...general, warrantyLabels: onlyUsage }, tags);
  assert.deepEqual(replacement.after, [{ name: 'usage_warranty', value: '质保 6 小时' }]);
  assert.equal(replacement.outcome, 'updated');
  const absent: WarrantyLabels = { ...onlyUsage, usage_warranty: null, usage_warranty_t: null };
  const cleared = buildTagExtractionOutcome({ ...general, warrantyLabels: absent }, tags);
  assert.deepEqual(cleared.after, []);
  assert.equal(cleared.outcome, 'empty');
  for (const outcome of ['failed', 'cancelled', 'skipped'] as const) {
    const terminal = buildTagExtractionOutcome({ ...general, warrantyLabels: absent }, tags, { outcome, reasonCode: 'terminal' });
    assert.deepEqual(terminal.after, tags);
    assert.deepEqual(terminal.diff, []);
  }
});

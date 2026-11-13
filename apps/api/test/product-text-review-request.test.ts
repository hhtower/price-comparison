import assert from 'node:assert/strict';
import test from 'node:test';
import { CONSISTENCY_KEYS, DISCLOSURE_KEYS } from '../src/shops/shop-text-review.js';

const textReview = {
  answers: Object.fromEntries(DISCLOSURE_KEYS.map(key => [key, { value: null, reason: 'Scope unclear', evidence: [] }])),
  consistency: Object.fromEntries(CONSISTENCY_KEYS.map(key => [key, { value: false, reason: 'No conflict', evidence: [] }])),
};

test('independent text request preserves full frozen text and excludes tag and task inputs', async () => {
  const { buildProductTextReviewRequest } = await import('../src/ai/product-text-review-request.js');
  const shopText = { unitId: '1', name: 'Full title', description: 'full body\n'.repeat(5000), hash: 'a'.repeat(64) };
  const inputs = [{ id: '1', name: 'Normalized title', spec: 'unused', shopText, taskId: 'unused' }];
  const built = buildProductTextReviewRequest(inputs, 'frozen');
  assert.deepEqual(JSON.parse(built.messages[1]!.content), [{ id: '1', shopText }]);
  assert.deepEqual(built.responseFormat, { type: 'json_object' });
  assert.equal(built.model, 'frozen');
});

test('text response requires exactly fourteen complete judgments and no tag votes', async () => {
  const { parseProductTextReviewResponse } = await import('../src/ai/product-text-review-request.js');
  const response = { items: [{ id: '1', textReview }, { id: '2', textReview: null }] };
  assert.deepEqual(parseProductTextReviewResponse(JSON.stringify(response)), response);
  for (const invalid of [
    { items: [{ id: '1' }] }, { items: [{ id: '1', textReview, accepted: [] }] },
    { items: [{ id: '1', textReview: { ...textReview, answers: {} } }] },
    { items: [{ id: '1', textReview: { ...textReview, answers: { ...textReview.answers, L1: { value: 'yes', reason: 'x', evidence: [] } } } }] },
    { items: [{ id: '1', textReview: { ...textReview, consistency: { ...textReview.consistency, C1: { value: false, reason: '', evidence: [] } } } }] },
    { items: [response.items[0], response.items[0]] }, { items: [], extra: true },
  ]) assert.throws(() => parseProductTextReviewResponse(JSON.stringify(invalid)));
});

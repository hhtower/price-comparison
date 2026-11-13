import assert from 'node:assert/strict';
import test from 'node:test';
import { planTagReviewRequests } from '../src/ai/tag-review-planner.js';
import { estimateStandardizationRequest, readStandardizationRequestLimits } from '../src/ai/standardization-request.js';
import { buildTagReviewRequest } from '../src/ai/tag-review-request.js';
import { buildProductTextReviewRequest } from '../src/ai/product-text-review-request.js';

function fixture(count: number, withText = true) {
  const inputs = Array.from({ length: count }, (_, index) => ({ id: String(index + 1), name: 'Parent',
    ...(withText ? { shopText: { unitId: String(index + 1), name: 'Parent', description: '', hash: 'a'.repeat(64) } } : {}) }));
  return { model: 'mock', inputs, proposals: { items: inputs.map(input => ({ id: input.id, tags: [] })) } };
}
const limits = readStandardizationRequestLimits({});

test('tag reviews no longer reserve fourteen text judgments per product', () => {
  const request = fixture(32);
  const before = JSON.stringify(request);
  const inputEstimate = estimateStandardizationRequest(buildTagReviewRequest(request.inputs, request.proposals, request.model), limits);
  assert.ok(inputEstimate.requestBytes < limits.maxRequestBytes);
  assert.ok(inputEstimate.estimatedTotalTokens < limits.maxContextTokens);
  const groups = planTagReviewRequests(request, limits);
  assert.equal(groups.length, 1);
  assert.ok(groups.every(group => !group.oversized));
  assert.deepEqual(groups.flatMap(group => group.request.inputs.map(input => input.id)), request.inputs.map(input => input.id));
  for (const group of groups) assert.deepEqual(group.request.proposals.items.map(item => item.id), group.request.inputs.map(input => input.id));
  assert.equal(JSON.stringify(request), before);
});

test('shop text does not affect tag-only output budgeting', () => {
  const request = fixture(12);
  const small = planTagReviewRequests(request, { ...limits, outputReserveTokens: 8192 });
  const normal = planTagReviewRequests(request, limits);
  assert.equal(small.length, normal.length);
  assert.equal(planTagReviewRequests(fixture(32, false), limits).length, 1);
});

test('independent text review splits output-heavy products while preserving full frozen text and exact request estimates', () => {
  const request = { ...fixture(2), textReview: true, proposals: { items: [] } };
  for (const input of request.inputs) input.shopText!.description = 'Original body with all conditions.\n'.repeat(400);
  const before = structuredClone(request);
  const budget = { ...limits, outputReserveTokens: 8192 };
  const combined = estimateStandardizationRequest(buildProductTextReviewRequest(request.inputs, request.model), budget);
  assert.ok(combined.requestBytes < budget.maxRequestBytes);
  assert.ok(combined.estimatedTotalTokens < budget.maxContextTokens);
  const groups = planTagReviewRequests(request, budget);
  assert.deepEqual(groups.map(group => group.request.inputs.map(input => input.id)), [['1'], ['2']]);
  assert.ok(groups.every(group => !group.oversized));
  for (const group of groups) {
    assert.deepEqual(group.request.proposals, { items: [] });
    const built = buildProductTextReviewRequest(group.request.inputs, group.request.model);
    assert.deepEqual(group.estimate, estimateStandardizationRequest(built, budget));
  }
  assert.deepEqual(groups.flatMap(group => group.request.inputs), request.inputs);
  assert.deepEqual(request, before);
  assert.equal(planTagReviewRequests({ ...request, textReview: false }, budget).length, 1);
});

test('text review uses the fourteen-question allowance and isolates oversized whole inputs', () => {
  const request = { ...fixture(9), textReview: true, proposals: { items: [] } };
  assert.deepEqual(planTagReviewRequests(request, limits).map(group => group.request.inputs.length), [4, 4, 1]);
  const large = { ...fixture(2), textReview: true, proposals: { items: [] } };
  large.inputs[0]!.shopText!.description = 'x'.repeat(200000);
  const groups = planTagReviewRequests(large, limits);
  assert.deepEqual(groups.map(group => group.oversized), [true, false]);
  assert.equal((groups[0]!.request.inputs[0] as typeof large.inputs[number]).shopText!.description.length, 200000);
  const singleton = planTagReviewRequests({ ...fixture(1), textReview: true }, { ...limits, outputReserveTokens: 1024 });
  assert.equal(singleton.length, 1);
  assert.equal(singleton[0]!.oversized, false);
});

test('output planning preserves the indivisible singleton and existing input-too-large isolation', () => {
  const request = fixture(2);
  request.inputs[0]!.name = 'x'.repeat(200000);
  const groups = planTagReviewRequests(request, limits);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]!.oversized, true);
  assert.equal(groups[1]!.oversized, false);
  const singleton = planTagReviewRequests(fixture(1), { ...limits, outputReserveTokens: 1024 });
  assert.equal(singleton.length, 1);
  assert.equal(singleton[0]!.oversized, false);
});

test('boolean vectors still split when the response budget is exhausted', () => {
  const inputs = [{ id: '1000000000000001', name: '商品' }, { id: '1000000000000002', name: '商品' }];
  const proposals = { items: inputs.map(input => ({ id: input.id, tags: Array.from({ length: 100 }, (_, index) =>
    ({ name: 'supported_client', value: `client${index}`, path: 'name', quote: '商品' })) })) };
  const groups = planTagReviewRequests({ model: 'mock', inputs, proposals }, { ...limits, outputReserveTokens: 256 });
  assert.equal(groups.length, 2);
  assert.ok(groups.every(group => !group.oversized));
  assert.equal(groups.flatMap(group => group.request.proposals.items.flatMap(item => item.tags)).length, 200);
});


test('review grouping filters previous accepted context by the grouped product IDs', () => {
  const request = fixture(3);
  const previousDecisions = request.inputs.map(input => ({ productId: BigInt(input.id),
    tags: [{ name: 'duration', value: 30, evidence: [] }], rejectedTags: [], complete: false }));
  const groups = planTagReviewRequests({ ...request, previousDecisions }, { ...limits, outputReserveTokens: 64 });
  assert.equal(groups.length, 3);
  for (const group of groups) {
    assert.deepEqual(group.request.previousDecisions?.map(item => String(item.productId)), group.request.inputs.map(input => input.id));
    const built = buildTagReviewRequest(group.request.inputs, group.request.proposals, 'mock', group.request.previousDecisions);
    assert.equal(group.estimate.requestBytes, estimateStandardizationRequest(built, { ...limits, outputReserveTokens: 64 }).requestBytes);
  }
});

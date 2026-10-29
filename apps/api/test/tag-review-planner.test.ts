import assert from 'node:assert/strict';
import test from 'node:test';
import { planTagReviewRequests } from '../src/ai/tag-review-planner.js';
import { estimateStandardizationRequest, readStandardizationRequestLimits } from '../src/ai/standardization-request.js';
import { buildTagReviewRequest } from '../src/ai/tag-review-request.js';

function fixture(count: number, withText = true) {
  const inputs = Array.from({ length: count }, (_, index) => ({ id: String(index + 1), name: 'Parent',
    ...(withText ? { shopText: { unitId: String(index + 1), name: 'Parent', description: '', hash: 'a'.repeat(64) } } : {}) }));
  return { model: 'mock', inputs, proposals: { items: inputs.map(input => ({ id: input.id, tags: [] })) } };
}
const limits = readStandardizationRequestLimits({});

test('fourteen-question output splits short inputs that fit the input and context budgets', () => {
  const request = fixture(32);
  const before = JSON.stringify(request);
  const inputEstimate = estimateStandardizationRequest(buildTagReviewRequest(request.inputs, request.proposals, request.model), limits);
  assert.ok(inputEstimate.requestBytes < limits.maxRequestBytes);
  assert.ok(inputEstimate.estimatedTotalTokens < limits.maxContextTokens);
  const groups = planTagReviewRequests(request, limits);
  assert.ok(groups.length > 1, 'output capacity must split even when every input fits');
  assert.ok(groups.every(group => !group.oversized));
  assert.deepEqual(groups.flatMap(group => group.request.inputs.map(input => input.id)), request.inputs.map(input => input.id));
  for (const group of groups) assert.deepEqual(group.request.proposals.items.map(item => item.id), group.request.inputs.map(input => input.id));
  assert.equal(JSON.stringify(request), before);
});

test('smaller output reserve reduces text review batch size without changing tag-only batches', () => {
  const request = fixture(12);
  const small = planTagReviewRequests(request, { ...limits, outputReserveTokens: 8192 });
  const normal = planTagReviewRequests(request, limits);
  assert.ok(small.length > normal.length);
  assert.equal(planTagReviewRequests(fixture(32, false), limits).length, 1);
});

test('output planning preserves the indivisible singleton and existing input-too-large isolation', () => {
  const request = fixture(2);
  request.inputs[0]!.shopText!.description = 'x'.repeat(200000);
  const groups = planTagReviewRequests(request, limits);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]!.oversized, true);
  assert.equal(groups[1]!.oversized, false);
  const singleton = planTagReviewRequests(fixture(1), { ...limits, outputReserveTokens: 1024 });
  assert.equal(singleton.length, 1);
  assert.equal(singleton[0]!.oversized, false);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildStandardizationRequest, estimateStandardizationRequest, readStandardizationRequestLimits } from '../src/ai/standardization-request.js';
import { planStandardizationRequests } from '../src/ai/standardization-request-planner.js';

test('complete request planning splits candidate-heavy items before reservation without dropping evidence', () => {
  const candidates = [1, 2].map(id => ({ id: String(id), family: 'example', product: 'course', tier: 'standard', aliases: ['内容'.repeat(1800)] }));
  const inputs = [1, 2].map(id => ({ productId: BigInt(id), payload: { name: 'course', evidence: '完整尾部证据' }, candidateStandardProductIds: [String(id)] }));
  const limits = { maxRequestBytes: 1000000, maxContextTokens: 1000000, outputReserveTokens: 1024 };
  const one = estimateStandardizationRequest(buildStandardizationRequest({ model: 'mock', candidates, inputs: inputs.slice(0, 1) }), limits);
  const result = planStandardizationRequests({ model: 'mock', candidates, inputs }, { ...limits, maxRequestBytes: one.requestBytes + 1 });
  assert.equal(result.length, 2);
  assert.deepEqual(result.flatMap(group => group.request.inputs), inputs);
  assert.deepEqual(result.map(group => group.request.candidates.map(c => c.id)), [['1'], ['2']]);
  assert.ok(result.every(group => !group.oversized));
});

test('a singleton that cannot fit remains explicitly oversized with its full evidence', () => {
  const request = { model: 'mock', candidates: [], inputs: [{ productId: 1n, payload: { name: '证据'.repeat(3000) }, candidateStandardProductIds: [] }] };
  const [result] = planStandardizationRequests(request, { maxRequestBytes: 1000, maxContextTokens: 1000, outputReserveTokens: 100 });
  assert.equal(result?.oversized, true);
  assert.deepEqual(result?.request, request);
});

test('eight short items sharing twenty candidates fit one default-budget request', () => {
  const candidates = Array.from({ length: 20 }, (_, i) => ({ id: String(i + 1), displayName: 'Example subscription ' + i,
    family: 'example', product: 'subscription', tier: 'plan_' + i, aliases: ['Example Plan ' + i] }));
  const inputs = Array.from({ length: 8 }, (_, i) => ({ productId: BigInt(i + 1),
    payload: { name: 'Example subscription Plan ' + i, spec: '1 month dedicated' }, candidateStandardProductIds: candidates.map(c => c.id) }));
  const [planned, ...rest] = planStandardizationRequests({ model: 'offline-no-call', candidates, inputs }, readStandardizationRequestLimits({}));
  assert.equal(rest.length, 0, 'repeated schema/candidates must not force avoidable splits');
  assert.equal(planned?.oversized, false);
  assert.deepEqual(planned?.request.inputs, inputs);
  assert.ok(planned!.estimate.requestBytes < 50_000);
});

test('split requests rebuild complete local candidate mappings without dropping history or evidence', () => {
  const candidates = [1, 2, 3].map(id => ({ id: String(id), displayName: `Plan ${id}`, family: 'example', product: 'course', tier: 'standard', aliases: ['full alias'] }));
  const inputs = [1, 2].map(id => ({ productId: BigInt(id), payload: { name: `course ${id}`, evidence: '完整尾部证据' },
    previousDecision: { reason: `history ${id}` }, candidateStandardProductIds: [String(id + 1), '1'] }));
  const limits = { maxRequestBytes: 1_000_000, maxContextTokens: 1_000_000, outputReserveTokens: 1024 };
  const one = estimateStandardizationRequest(buildStandardizationRequest({ model: 'mock', candidates, inputs: inputs.slice(0, 1) }), limits);
  const planned = planStandardizationRequests({ model: 'mock', candidates, inputs }, { ...limits, maxRequestBytes: one.requestBytes });
  assert.equal(planned.length, 2);
  for (const [index, group] of planned.entries()) {
    assert.equal(group.oversized, false);
    const built = buildStandardizationRequest(group.request);
    const payload = JSON.parse(built.messages[1]!.content);
    assert.deepEqual(payload.items[0].historyContext, inputs[index]!.previousDecision);
    assert.equal(payload.items[0].evidence, '完整尾部证据');
    assert.deepEqual(payload.items[0].candidateRefs, { i1c1: 'c1', i1c2: 'c2' });
    assert.equal(payload.candidates.c1.displayName, `Plan ${index + 2}`);
    assert.equal(payload.candidates.c2.displayName, 'Plan 1');
    assert.deepEqual(built.protocolInputs[0]?.candidateRefs, { i1c1: String(index + 2), i1c2: '1' });
  }
});

test('larger output reserves retain room for complete inputs and honor explicit overrides', () => {
  const request = { model: 'gpt-6.1-sol', candidates: [], inputs: [
    { productId: 1n, payload: { name: 'Example subscription', spec: '1 month dedicated' }, candidateStandardProductIds: [] },
  ] };
  const limits = readStandardizationRequestLimits({});
  const [planned] = planStandardizationRequests(request, limits);
  assert.equal(planned?.oversized, false);
  assert.equal(planned?.estimate.outputReserveTokens, 32768);
  assert.ok(planned!.estimate.estimatedTotalTokens <= 65536);
  assert.deepEqual(planned?.request.inputs, request.inputs);
  const custom = readStandardizationRequestLimits({ AI_REQUEST_MAX_CONTEXT_TOKENS: '131072', AI_REQUEST_OUTPUT_RESERVE_TOKENS: '65536' });
  assert.equal(estimateStandardizationRequest(buildStandardizationRequest(request), custom).outputReserveTokens, 65536);
  assert.throws(() => readStandardizationRequestLimits({ AI_REQUEST_MAX_CONTEXT_TOKENS: '32768' }), /context.*output|AI_REQUEST_MAX_CONTEXT_TOKENS/i);
  assert.throws(() => readStandardizationRequestLimits({ AI_REASONING_EFFORT: 'minimal' }), /AI_REASONING_EFFORT/);
});

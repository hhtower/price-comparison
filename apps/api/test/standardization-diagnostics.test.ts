import assert from 'node:assert/strict';
import test from 'node:test';
import { assertStandardizationCheckpoint, parseStandardizationProtocolResponse } from '../src/ai/ai.schemas.js';
import { parseStandardizationReviewResponse } from '../src/ai/standardization-review-request.js';
import { validateStandardizationEvidence } from '../src/ai/standardization-evidence.js';

const evidence = [{ path: 'name', quote: 'ChatGPT Plus' }];
const request = {
  model: 'mock',
  candidates: [{ id: '91', family: 'openai', product: 'chatgpt', tier: 'plus', aliases: [] }],
  inputs: [{ productId: 11n, candidateStandardProductIds: ['91'],
    payload: { name: 'ChatGPT Plus', description: '仅提供资格链接，不含订阅。买家须自备账号。' } }],
};
const inputs = [{ id: '11', candidateStandardProductIds: ['91'] }];
const generate = (standardProductId: string | null = '91', nullReason: string | null = null) =>
  parseStandardizationProtocolResponse({ items: [{ id: '11', standardProductId, nullReason, evidence }] }, inputs);
const feedback = { id: '11', approved: false, code: 'identity_mismatch',
  evidence: [{ path: 'description', quote: '仅提供资格链接，不含订阅。' }] };
const review = (vote: unknown = feedback, proposals = generate()) =>
  parseStandardizationReviewResponse(JSON.stringify({ items: [vote] }), proposals, request);

test('null distinguishes candidate unavailable from insufficient source without inventing an identity', () => {
  for (const nullReason of ['candidate_unavailable', 'insufficient_source']) {
    const result = generate(null, nullReason);
    assert.equal(result.items[0]!.reasonCode, nullReason);
    assert.equal(result.items[0]!.identity, undefined);
    const approved = review({ id: '11', approved: true, code: null, evidence: [] }, result);
    assert.equal(approved.items[0]!.reasonCode, nullReason);
    assert.deepEqual(approved.items[0]!.review?.proposal, { standardProductId: null, nullReason });
    assertStandardizationCheckpoint(approved);
  }
  for (const [id, reason] of [['91', 'insufficient_source'], [null, null], [null, 'unknown'], ['91', 'candidate_unavailable']]) {
    assert.throws(() => generate(id!, reason!));
  }
  assert.throws(() => parseStandardizationProtocolResponse({
    items: [{ id: '11', standardProductId: '91', evidence }],
  }, inputs));
});

test('rejection retains exact original proposal and its evidence separately from feedback', () => {
  const proposal = generate();
  const before = structuredClone(proposal);
  const result = review(feedback, proposal);
  assert.deepEqual(proposal, before);
  assert.equal(result.items[0]!.status, 'unclassified');
  assert.equal(result.items[0]!.identity, undefined);
  assert.equal(result.items[0]!.evidence, proposal.items[0]!.evidence);
  assert.deepEqual(result.items[0]!.review, {
    approved: false, code: 'identity_mismatch', evidence: feedback.evidence,
    proposal: { standardProductId: '91', nullReason: null },
  });
  assert.match(result.items[0]!.reason, /实际售卖|交付/u);
  assertStandardizationCheckpoint(result);
});

test('review rejects old votes, unknown IDs, contradictions and fabricated or foreign citations', () => {
  for (const vote of [
    { id: '11', approved: true }, { ...feedback, id: '999' },
    { ...feedback, standardProductId: '91' }, { ...feedback, confidence: 0.99 },
    { ...feedback, approved: true }, { ...feedback, code: null }, { ...feedback, code: 'other' },
    { ...feedback, code: 'supported_candidate' }, { ...feedback, evidence: [] },
    { id: '11', approved: true, code: null, evidence },
    ...[
      { path: 'description', quote: '已激活订阅' },
      { path: 'inputs[0].payload.name', quote: 'ChatGPT Plus' },
      { path: 'candidates[0].product', quote: 'chatgpt' },
      { path: 'constructor.name', quote: 'Object' },
      { path: 'name', quote: 'chatgpt plus' },
      { path: 'description', quote: '仅提供资格链接', explanation: 'extra' },
    ].map(citation => ({ ...feedback, evidence: [citation] })),
    { ...feedback, evidence: Array.from({ length: 6 }, () => feedback.evidence[0]) },
  ]) assert.throws(() => review(vote), JSON.stringify(vote));
  const forged = generate();
  forged.items[0]!.evidence = [{ path: 'description', quote: '不存在' }];
  assert.throws(() => review(feedback, forged));
});

test('review checkpoint enforces vote, proposal, diagnosis and business reason consistency', () => {
  const accepted = review({ id: '11', approved: true, code: null, evidence: [] });
  const rejected = review();
  for (const mutate of [
    (item: any) => { item.review.approved = false; },
    (item: any) => { item.review.proposal.standardProductId = '92'; },
    (item: any) => { item.review.proposal.nullReason = 'insufficient_source'; },
    (item: any) => { item.review.code = 'identity_mismatch'; },
    (item: any) => { item.review.evidence = feedback.evidence; },
  ]) {
    const value = structuredClone(accepted);
    mutate(value.items[0]);
    assert.throws(() => assertStandardizationCheckpoint(value));
  }
  for (const mutate of [
    (item: any) => { item.review.approved = true; },
    (item: any) => { item.review.evidence = []; },
    (item: any) => { item.reason = 'LLM 对该标准化提议判定为否'; },
    (item: any) => { delete item.review.proposal; },
  ]) {
    const value = structuredClone(rejected);
    mutate(value.items[0]);
    assert.throws(() => assertStandardizationCheckpoint(value));
  }
});

test('rejected null keeps its exact reason and frozen review candidates remain item-local', () => {
  const source = generate(null, 'candidate_unavailable');
  const result = review({ ...feedback, code: 'supported_candidate' }, source);
  assert.deepEqual(result.items[0]!.review!.proposal, { standardProductId: null, nullReason: 'candidate_unavailable' });
  assert.equal(result.items[0]!.evidence, source.items[0]!.evidence);
  assert.throws(() => review(feedback, source));
  const forged = review();
  forged.items[0]!.review!.proposal.standardProductId = '999';
  assert.throws(() => validateStandardizationEvidence(forged, request.inputs.map(input => ({
    id: String(input.productId), payload: input.payload, candidateStandardProductIds: input.candidateStandardProductIds,
  })), request.candidates));
  assert.throws(() => parseStandardizationReviewResponse(JSON.stringify({ items: [feedback] }), generate(), {
    ...request, inputs: [{ ...request.inputs[0]!, candidateStandardProductIds: [] }],
  }));
});

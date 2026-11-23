import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundedCandidateIndex } from '../src/standardization/candidate-index.js';
import { parseStandardizationProtocolResponse } from '../src/ai/ai.schemas.js';
import { parseStandardizationReviewResponse } from '../src/ai/standardization-review-request.js';
import { buildStandardizationRequest, readStandardizationRequestLimits } from '../src/ai/standardization-request.js';
import { planStandardizationRepairs } from '../src/ai/standardization-repair.js';
import { validateStandardizationEvidence } from '../src/ai/standardization-evidence.js';

const candidate = (id: string) => ({
  id, family: 'openai', product: 'chatgpt', tier: `plan${id}`, aliases: [`ChatGPT plan${id}`],
  displayName: `ChatGPT plan${id}`, definition: `ChatGPT plan${id} subscriptions`,
});
const request = {
  model: 'mock', candidates: [candidate('91')],
  inputs: [{ productId: 11n, payload: { name: 'ChatGPT plan92' }, candidateStandardProductIds: ['91'] }],
};
const proposals = parseStandardizationProtocolResponse({ items: [{
  id: '11', standardProductId: null, nullReason: 'candidate_unavailable',
  evidence: [{ path: 'name', quote: 'ChatGPT plan92' }],
}] }, [{ id: '11', candidateStandardProductIds: ['91'] }]);
const reviewed = parseStandardizationReviewResponse(JSON.stringify({ items: [
  { id: '11', approved: true, code: null, evidence: [] },
] }), proposals, request);
const limits = readStandardizationRequestLimits({});

test('an approved missing-candidate outcome only requests correction after finding new approved candidates', () => {
  const empty = new BoundedCandidateIndex([candidate('91')]);
  assert.deepEqual(planStandardizationRepairs(request, reviewed.items, empty, limits), []);
  const expanded = new BoundedCandidateIndex([candidate('91'), candidate('92')]);
  const plans = planStandardizationRepairs(request, reviewed.items, expanded, limits);
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0]!.request.inputs[0]!.candidateStandardProductIds, ['91', '92']);
  assert.deepEqual(plans[0]!.request.repairFeedback, reviewed.items);
  assert.deepEqual(request.inputs[0]!.candidateStandardProductIds, ['91'], 'original frozen request is immutable');
});

test('supplemental lookup adds at most five candidates and preserves full source and original definitions', () => {
  const index = new BoundedCandidateIndex(Array.from({ length: 12 }, (_, n) => candidate(String(91 + n))));
  const [plan] = planStandardizationRepairs(request, reviewed.items, index, limits);
  assert.equal(plan!.request.candidates.length, 6);
  assert.deepEqual(plan!.request.candidates[0], candidate('91'));
  assert.deepEqual(plan!.request.inputs[0]!.payload, request.inputs[0]!.payload);
  const body = JSON.parse(buildStandardizationRequest(plan!.request).messages[1]!.content);
  assert.equal(body.feedback[0].proposal.nullReason, 'candidate_unavailable');
  assert.deepEqual(body.items[0].name, 'ChatGPT plan92');
});

test('oversized repair leaves the reviewed result intact without truncating source to force a request', () => {
  const index = new BoundedCandidateIndex([candidate('91'), candidate('92')]);
  assert.deepEqual(planStandardizationRepairs(request, reviewed.items, index, { ...limits, maxRequestBytes: 1 }), []);
});

test('fabricated feedback citations are rejected and diagnostic fields cannot be used as source evidence', () => {
  const rejected = parseStandardizationReviewResponse(JSON.stringify({ items: [
    { id: '11', approved: false, code: 'supported_candidate', evidence: [{ path: 'name', quote: 'ChatGPT plan92' }] },
  ] }), proposals, request);
  const forged = structuredClone(rejected.items);
  forged[0]!.review!.evidence[0]!.quote = 'invented';
  assert.throws(() => planStandardizationRepairs(request, forged, new BoundedCandidateIndex([candidate('91')]), limits));
  const [plan] = planStandardizationRepairs(request, rejected.items, new BoundedCandidateIndex([candidate('91')]), limits);
  const output = parseStandardizationProtocolResponse({ items: [{
    id: '11', standardProductId: '91', nullReason: null,
    evidence: [{ path: 'feedback.0.review.evidence.0.quote', quote: 'ChatGPT plan92' }],
  }] }, [{ id: '11', candidateStandardProductIds: ['91'] }]);
  assert.throws(() => validateStandardizationEvidence(output,
    [{ id: '11', payload: plan!.request.inputs[0]!.payload, candidateStandardProductIds: ['91'] }], request.candidates));
});

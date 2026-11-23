import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStandardizationRequest } from '../src/ai/standardization-request.js';
import { buildStandardizationReviewRequest } from '../src/ai/standardization-review-request.js';
import { parseStandardizationProtocolResponse } from '../src/ai/ai.schemas.js';
import { buildMembershipFeatureRequest, buildMembershipFeatureReviewRequest } from '../src/ai/membership-feature-request.js';
import { buildTagExtractionRequest } from '../src/ai/tag-extraction-request.js';
import { buildTagReviewRequest } from '../src/ai/tag-review-request.js';
import { buildTagWarrantyRequest } from '../src/ai/tag-warranty-request.js';
import { isCurrentPipeline, pipelineVersionSnapshot } from '../src/ai/pipeline-versions.js';

test('generation, review and tag repair receive the same title-first evidence policy', () => {
  const inputs = [{ id: '1', name: 'ChatGPT Plus 1 month', spec: 'Claude Pro 12 months' }];
  const request = { model: 'mock', candidates: [], inputs: [
    { productId: 1n, payload: inputs[0]!, candidateStandardProductIds: [] },
  ] };
  const proposals = parseStandardizationProtocolResponse({ items: [
    { id: '1', standardProductId: null, nullReason: 'candidate_unavailable', evidence: [{ path: 'name', quote: inputs[0]!.name }] },
  ] }, [{ id: '1', candidateStandardProductIds: [] }]);
  const requests = [
    buildStandardizationRequest(request),
    buildStandardizationReviewRequest(request, proposals),
    buildMembershipFeatureRequest(inputs, 'mock'),
    buildMembershipFeatureReviewRequest(inputs, { items: [{ id: '1', refs: [0], membershipKind: 'short_term' }] }, 'mock'),
    buildTagExtractionRequest(inputs, 'mock'),
    buildTagExtractionRequest(inputs, 'mock', [{ productId: 1n, tags: [], rejectedTags: [], reviewFeedback: 'Use 12 months' }]),
    buildTagReviewRequest(inputs, { items: [{ id: '1', tags: [{ name: 'duration', value: 360 }] }] }, 'mock'),
    buildTagWarrantyRequest(inputs, 'mock'),
  ];
  const policies = requests.map(({ messages }) => {
    const prompt = messages[0]!.content;
    const policy = prompt.match(/<offer_evidence_policy>\n([\s\S]*?)\n<\/offer_evidence_policy>/u)?.[1];
    assert.ok(policy, 'every decision stage must receive the shared evidence policy');
    assert.match(policy, /title.*name.*primary/iu);
    assert.match(policy, /same attribute.*title wins/iu);
    assert.match(policy, /missing or ambiguous/iu);
    assert.match(policy, /use duration.*warranty duration/iu);
    assert.doesNotMatch(prompt, /spec take precedence|keeping selected SKU precedence/u);
    return policy;
  });
  assert.equal(new Set(policies).size, 1, 'review and repair must use the generation evidence hierarchy');
});

test('pre-title-priority prompt snapshots are stale for each changed stage', () => {
  const current = pipelineVersionSnapshot('mock');
  assert.equal(isCurrentPipeline(current), true);
  for (const [key, value] of Object.entries({
    prompt: 'standardization-match-prompt-20261119-v1',
    standardizationReviewPrompt: 'standardization-match-review-20261119-v1',
    membershipFeaturePrompt: 'membership-features-20261114-v7',
    membershipFeatureReviewPrompt: 'membership-feature-review-20261114-v7',
    tagPrompt: 'tag-20261117-v17',
    tagReviewPrompt: 'tag-review-20261117-v13',
    tagWarrantyPrompt: 'tag-warranty-20261117-v1',
  })) assert.equal(isCurrentPipeline({ ...current, [key]: value }), false, key);
});

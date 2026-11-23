import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMembershipFeatureRequest, parseMembershipFeatureReviewResponse } from '../src/ai/membership-feature-request.js';
const inputs = [{ id: '42', name: 'Monthly account', spec: 'Seller account. Warranty: first login only.' }];
test('membership review requires a diagnostic and source references for a rejection', () => {
  const result = parseMembershipFeatureReviewResponse(JSON.stringify({ items: [{
    id: '1', classificationDecision: false, code: 'protection_mismatch', refs: [1],
  }] }), inputs);
  assert.deepEqual(result.items[0], { id: '42', classificationDecision: false, code: 'protection_mismatch', refs: [1] });
  for (const feedback of [
    { classificationDecision: false, code: 'protection_mismatch', refs: [] },
    { classificationDecision: false, code: 'protection_mismatch', refs: [9] },
    { classificationDecision: false, code: 'invented', refs: [0] },
    { classificationDecision: true, code: 'protection_mismatch', refs: [0] },
    { classificationDecision: true, code: null, refs: [0] },
    { classificationDecision: false },
  ]) assert.throws(() => parseMembershipFeatureReviewResponse(JSON.stringify({ items: [{ id: '1', ...feedback }] }), inputs));
});
test('correction transports the verified prior proposal and feedback separately from original evidence', () => {
  const previous = [{ productId: 42n, tags: [], rejectedTags: [], membershipKind: 'account' as const,
    membershipRefs: [0], reviewed: true, classificationReviewed: false,
    membershipReview: { classificationDecision: false, code: 'protection_mismatch' as const, refs: [1] } }];
  const built = buildMembershipFeatureRequest(inputs, 'mock', previous);
  const body = JSON.parse(built.messages[1]!.content);
  assert.equal(body.feedback[0].id, '1');
  assert.equal(body.feedback[0].proposal.membershipKind, 'account');
  assert.equal(body.feedback[0].review.code, 'protection_mismatch');
  assert.equal(body.inputs[0].lines[1].text, inputs[0]!.spec);
});

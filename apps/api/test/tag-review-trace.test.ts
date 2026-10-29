import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTagExtractionOutcome, validateReviewedTagExtractionDecision } from '../src/ai/tag-extraction-result.js';

const proposal = (proposalIndex: number, name: string, value: string) => ({
  proposalIndex, name, value, evidence: [{ path: 'sourceData.evidence', quote: '已配置2FA' }],
});

test('the saved vote vector distinguishes model rejection from a true vote rejected by program validation', () => {
  const accepted = proposal(0, '2fa', '有');
  const refused = { ...proposal(1, '2fa', '有'), reasonCode: 'review_rejected', reason: 'LLM 对该标签判定为否' };
  const invalid = proposal(2, 'unknown', 'value');
  const votes = [true, false, true];
  const result = validateReviewedTagExtractionDecision(1n, [accepted, invalid], [refused],
    { sourceData: { evidence: '已配置2FA' } }, votes);
  votes[0] = false;
  assert.deepEqual(result.reviewDecisions, [true, false, true]);
  assert.deepEqual(result.tags.map(tag => tag.proposalIndex), [0]);
  assert.deepEqual(result.rejectedTags.map(tag => [tag.proposalIndex, tag.reasonCode]), [
    [1, 'review_rejected'], [2, 'tag_name_unknown'],
  ]);
  const audit = buildTagExtractionOutcome(result, []);
  assert.deepEqual(audit.review, { mode: 'per_tag_binary', decisions: [true, false, true] });
  assert.equal(audit.acceptedTags[0]?.proposalIndex, 0);
  assert.deepEqual(audit.rejectedTags.map(tag => tag.proposalIndex), [1, 2]);
});

test('publication revalidation retains the original candidate indexes and model decisions', () => {
  const payload = { sourceData: { evidence: '已配置2FA' } };
  const initial = validateReviewedTagExtractionDecision(1n, [proposal(0, '2fa', '有'), proposal(2, 'invented', 'yes')],
    [{ ...proposal(1, '2fa', '有'), reasonCode: 'review_rejected', reason: 'LLM 对该标签判定为否' }], payload, [true, false, true]);
  const restored = JSON.parse(JSON.stringify(initial, (_key, value) => typeof value === 'bigint' ? String(value) : value));
  const published = validateReviewedTagExtractionDecision(1n, restored.tags, restored.rejectedTags, payload, restored.reviewDecisions);
  assert.deepEqual(published, initial);
  const skipped = buildTagExtractionOutcome(published, [], { outcome: 'skipped', reasonCode: 'source_changed' });
  assert.deepEqual(skipped.review?.decisions, [true, false, true]);
  assert.equal(skipped.outcome, 'skipped');
  assert.deepEqual(skipped.diff, []);
});

test('legacy results without a recorded vector stay unrecorded instead of inferring votes', () => {
  const result = validateReviewedTagExtractionDecision(1n, [proposal(0, '2fa', '有')], [],
    { sourceData: { evidence: '已配置2FA' } });
  assert.equal(result.reviewDecisions, undefined);
  assert.deepEqual(buildTagExtractionOutcome(result, []).review, { mode: 'per_tag_binary' });
  const empty = validateReviewedTagExtractionDecision(1n, [], [], {}, []);
  assert.deepEqual(empty.reviewDecisions, []);
});

test('incomplete, non-boolean and ambiguous index records fail before any checkpoint', () => {
  const payload = { sourceData: { evidence: '已配置2FA' } };
  for (const [tags, votes] of [
    [[proposal(0, '2fa', '有')], []],
    [[proposal(0, '2fa', '有')], ['yes']],
    [[proposal(1, '2fa', '有')], [true]],
    [[proposal(0, '2fa', '有'), proposal(0, '2fa', '有')], [true, true]],
    [[proposal(0, '2fa', '有')], [false]],
    [[{ name: '2fa', value: '有', evidence: [] }], [true]],
  ] as const) {
    assert.throws(() => validateReviewedTagExtractionDecision(1n, tags as never, [], payload, votes as never));
  }
});

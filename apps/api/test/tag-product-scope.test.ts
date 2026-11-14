import assert from 'node:assert/strict';
import test from 'node:test';
import { validateReviewedTagExtractionDecision } from '../src/ai/tag-extraction-result.js';
import { tagReviewSemanticControls } from './fixtures/tag-review-semantic-controls.js';

test('an explicit scope review keeps the current item and rejects advertised facts independently', () => {
  const sample = tagReviewSemanticControls.find(control => control.id === 'scope-linked-promotion')!;
  const tags = sample.tags.map((tag, proposalIndex) => ({ ...tag, proposalIndex, evidence: [] }));
  const result = validateReviewedTagExtractionDecision(1n, [tags[0]!],
    tags.slice(1).map(tag => ({ ...tag, reasonCode: 'review_rejected', reason: '模拟复核拒绝该标签' })),
    sample.input, [true, false, false], true);
  assert.deepEqual(result.tags.map(({ name, value }) => ({ name, value })), [{ name: 'sms_verification', value: 'verified' }]);
  assert.deepEqual(result.rejectedTags.map(tag => tag.proposalIndex), [1, 2]);
  assert.deepEqual(result.reviewDecisions, [true, false, false]);
});

test('scope interpretation belongs to review and is not recomputed from promotion text', () => {
  const sample = tagReviewSemanticControls.find(control => control.id === 'scope-inline-promotion')!;
  const tags = sample.tags.map((tag, proposalIndex) => ({ ...tag, proposalIndex, evidence: [] }));
  const result = validateReviewedTagExtractionDecision(1n, tags, [], sample.input, [true, true], true);
  assert.deepEqual(result.tags, tags);
  assert.deepEqual(result.rejectedTags, []);
});

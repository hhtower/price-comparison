import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTagExtractionResponse } from '../src/ai/tag-extraction-request.js';
import { validateReviewedTagExtractionDecision } from '../src/ai/tag-extraction-result.js';
import { tagReviewSemanticControls } from './fixtures/tag-review-semantic-controls.js';

test('semantic reference cases remain current-protocol inputs with explicit mock review labels', () => {
  assert.equal(new Set(tagReviewSemanticControls.map(sample => sample.id)).size, tagReviewSemanticControls.length);
  for (const sample of tagReviewSemanticControls) {
    const parsed = parseTagExtractionResponse(JSON.stringify({ items: [{ id: '1', tags: sample.tags }] }));
    const tags = parsed.items[0]!.tags.map((tag, proposalIndex) => ({ ...tag, proposalIndex, evidence: [] }));
    const votes = sample.expectedAccepted;
    assert.equal(votes.length, tags.length, sample.id);
    const result = validateReviewedTagExtractionDecision(1n, tags.filter(tag => votes[tag.proposalIndex]),
      tags.filter(tag => !votes[tag.proposalIndex]).map(tag => ({ ...tag, reasonCode: 'review_rejected', reason: '模拟复核拒绝该标签' })),
      sample.input, votes, true);
    assert.deepEqual(result.reviewDecisions, votes, sample.id);
    assert.equal(result.tags.length, votes.filter(Boolean).length, sample.id);
    assert.ok(result.rejectedTags.every(tag => tag.reasonCode === 'review_rejected'), sample.id);
  }
});

test('program validation does not override true model votes using warranty or evidence wording', () => {
  for (const value of ['none', 'covered', '不享受质保', '质保已过期', '售后联系商家', '保订阅30天']) {
    const tag = { name: 'warranty', value, evidence: [], proposalIndex: 0 };
    const result = validateReviewedTagExtractionDecision(1n, [tag], [],
      { name: '商品', sourceData: { evidence: '保订阅30天，封号不保。必须提交开箱视频。' } }, [true], true);
    assert.deepEqual(result.tags, [tag]);
    assert.deepEqual(result.rejectedTags, []);
  }
});

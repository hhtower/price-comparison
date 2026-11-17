import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTagExtractionResponse } from '../src/ai/tag-extraction-request.js';
import { validateReviewedTagExtractionDecision } from '../src/ai/tag-extraction-result.js';
import { tagReviewSemanticControls } from './fixtures/tag-review-semantic-controls.js';

test('general semantic reference candidates retain their corresponding mock review votes', () => {
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

test('program validation does not reinterpret general model votes from source wording', () => {
  for (const evidence of ['Supports Codex', 'Client support is unspecified', 'Codex requires a separate purchase']) {
    const tag = { name: 'supported_client', value: 'codex', evidence: [], proposalIndex: 0 };
    const result = validateReviewedTagExtractionDecision(1n, [tag], [],
      { name: '商品', sourceData: { evidence } }, [true], true);
    assert.deepEqual(result.tags, [tag]);
    assert.deepEqual(result.rejectedTags, []);
  }
});

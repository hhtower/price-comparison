import assert from 'node:assert/strict';
import test from 'node:test';
import { readReviewStage } from '../src/ai/review-workflow.js';

test('every frozen review task uses the same explicit stage contract', () => {
  assert.equal(readReviewStage(null), 'generate', 'an unprepared batch has not frozen its first request yet');
  for (const reviewStage of ['generate', 'review', 'repair', 'warranty'] as const) {
    assert.equal(readReviewStage({ reviewStage }), reviewStage);
  }
  for (const value of [{}, { tagStage: 'review' }, { standardizationStage: 'review' }, { reviewStage: 'extract' }]) {
    assert.throws(() => readReviewStage(value), /stage/);
  }
});

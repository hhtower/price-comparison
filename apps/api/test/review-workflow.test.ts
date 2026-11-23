import assert from 'node:assert/strict';
import test from 'node:test';
import { planReviewWorkflow, reviewRequestBudget } from '../src/ai/review-workflow.js';

test('generation and correction always go to an independent review', () => {
  for (const stage of ['generate', 'repair'] as const) {
    assert.deepEqual(planReviewWorkflow(stage, [1, 2], {}, () => true), { review: [1, 2], repair: [], publish: [] });
  }
});
test('only repairable rejections leave publication and each input can correct once', () => {
  assert.deepEqual(planReviewWorkflow('review', [1, 2, 3], {}, n => n === 2), { review: [], repair: [2], publish: [1, 3] });
  const reference = { repairReviewBatchId: '10' };
  assert.deepEqual(planReviewWorkflow('review', [1, 2, 3], reference, () => true), { review: [], repair: [], publish: [1, 2, 3] });
  assert.equal(reviewRequestBudget(reference), 1);
  assert.deepEqual(planReviewWorkflow('review', [1], { reviewRepairRound: 1 }, () => true),
    { review: [], repair: [], publish: [1] });
  assert.equal(reviewRequestBudget({}), 2);
});

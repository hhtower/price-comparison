export const REVIEW_WORKFLOW_VERSION = 'review-correction-once-20261123-v1';
export type ReviewStage = 'generate' | 'review' | 'repair';
export interface ReviewReference { readonly repairReviewBatchId?: unknown; readonly reviewRepairRound?: unknown }

function corrected(reference: ReviewReference): boolean {
  return reference.repairReviewBatchId !== undefined || reference.reviewRepairRound === 1;
}

/** A persisted parent review is the single correction allowance, including after restart. */
export function planReviewWorkflow<T>(
  stage: ReviewStage, items: readonly T[], reference: ReviewReference, repairable: (item: T) => boolean,
): { review: T[]; repair: T[]; publish: T[] } {
  if (stage !== 'review') return { review: [...items], repair: [], publish: [] };
  const repair: T[] = [], publish: T[] = [];
  for (const item of items) {
    (!corrected(reference) && repairable(item) ? repair : publish).push(item);
  }
  return { review: [], repair, publish };
}

export function reviewRequestBudget(reference: ReviewReference): number {
  return corrected(reference) ? 1 : 2;
}

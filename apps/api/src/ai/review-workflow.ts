export const REVIEW_WORKFLOW_VERSION = 'review-executor-20261123-v2';
export type ReviewStage = 'generate' | 'review' | 'repair' | 'warranty';
export interface ReviewReference { readonly repairReviewBatchId?: unknown; readonly reviewRepairRound?: unknown }

export function readReviewStage(reference: unknown): ReviewStage {
  if (reference === null) return 'generate';
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)) throw new Error('Review stage is not frozen');
  const stage = Reflect.get(reference, 'reviewStage');
  if (!['generate', 'review', 'repair', 'warranty'].includes(stage)) throw new Error('Invalid frozen review stage');
  return stage;
}
function corrected(reference: ReviewReference): boolean {
  return reference.repairReviewBatchId !== undefined || reference.reviewRepairRound === 1;
}

/** A persisted parent review is the single correction allowance, including after restart. */
export function planReviewWorkflow<T>(
  stage: Exclude<ReviewStage, 'warranty'>, items: readonly T[], reference: ReviewReference, repairable: (item: T) => boolean,
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

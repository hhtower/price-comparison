export function teamReviewAction(input: { pending: boolean; protectedDecision: boolean; manualDecisionAction: string | null; nowSupported: boolean }):
  'manual_review' | 'manual_preserved' | 'eligible_for_targeted_reevaluation' {
  if (input.protectedDecision && input.manualDecisionAction !== 'quarantine') return 'manual_preserved';
  return input.pending ? 'manual_review' : 'eligible_for_targeted_reevaluation';
}

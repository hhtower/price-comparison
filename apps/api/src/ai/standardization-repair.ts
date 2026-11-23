import type { CandidateSearchQuery, CandidateSearchResult } from '../standardization/candidate-index.js';
import type { StandardizationDecision } from './ai.schemas.js';
import type { StandardizationRequest, StandardizationRequestLimits } from './standardization-request.js';
import { planStandardizationRequests } from './standardization-request-planner.js';
import { validateStandardizationEvidence } from './standardization-evidence.js';

export function needsStandardizationRepair(item: StandardizationDecision): boolean {
  return item.review?.approved === false
    ? item.review.code === 'identity_mismatch' || item.review.code === 'supported_candidate'
    : item.review?.approved === true && item.reasonCode === 'candidate_unavailable';
}

/** Lookup uses validated source quotes, never model-written queries or invented identities. */
export function planStandardizationRepairs(
  request: StandardizationRequest,
  decisions: readonly StandardizationDecision[],
  index: { search(query: CandidateSearchQuery): CandidateSearchResult },
  limits: StandardizationRequestLimits,
) {
  validateStandardizationEvidence({ items: [...decisions], missingIds: [] },
    request.inputs.map(input => ({ id: String(input.productId), payload: input.payload, candidateStandardProductIds: input.candidateStandardProductIds })),
    request.candidates);
  return decisions.filter(needsStandardizationRepair).flatMap(decision => {
    const input = request.inputs.find(input => String(input.productId) === decision.id)!;
    const citations = decision.review!.approved ? decision.evidence : decision.review!.evidence;
    const text = [...new Set(citations.map(citation => citation.quote))].join('\n');
    const found = index.search({ text, primaryText: text });
    const originalIds = new Set(input.candidateStandardProductIds);
    const additions = found.candidates.filter(candidate => !originalIds.has(candidate.id)).slice(0, 5);
    if (decision.review!.approved && !additions.length) return [];
    const candidates = request.candidates.filter(candidate => originalIds.has(candidate.id));
    for (const { score: _score, routes: _routes, ...candidate } of additions) candidates.push(candidate);
    const repair: StandardizationRequest = {
      model: request.model, candidates, repairFeedback: [decision],
      inputs: [{ ...input, candidateStandardProductIds: candidates.map(candidate => candidate.id) }],
    };
    // Preserve the reviewed outcome when the complete correction cannot fit safely.
    return planStandardizationRequests(repair, limits).filter(group => !group.oversized).map(group => ({
      ...group, stats: { scanned: found.stats.scanned, compared: found.stats.compared, truncated: found.stats.truncated },
    }));
  });
}

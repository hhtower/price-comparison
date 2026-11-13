import { buildTagReviewRequest } from './tag-review-request.js';
import { buildMembershipFeatureReviewRequest } from './membership-feature-request.js';
import { buildProductTextReviewRequest } from './product-text-review-request.js';
import type { TagExtractionInput, TagExtractionResponse } from './tag-extraction-request.js';
import { estimateStandardizationRequest, type StandardizationRequestLimits } from './standardization-request.js';
import type { TagExtractionDecision } from './tag-extraction-result.js';
import { CONSISTENCY_KEYS, DISCLOSURE_KEYS, readTextEvidence } from '../shops/shop-text-review.js';

// Planning allowance for brief reasons, citations and JSON, not a bound on schema-valid output.
const TEXT_REVIEW_OUTPUT_TOKENS = (DISCLOSURE_KEYS.length + CONSISTENCY_KEYS.length) * 512;

/** Keep whole frozen inputs and their proposals together within the actual review request budget. */
export function planTagReviewRequests(request: {
  model: string; inputs: readonly TagExtractionInput[]; proposals: TagExtractionResponse; membershipFeatures?: boolean;
  previousDecisions?: TagExtractionDecision[]; textReview?: boolean;
}, limits: StandardizationRequestLimits) {
  const make = (inputs: TagExtractionInput[]) => {
    const ids = new Set(inputs.map(input => input.id));
    const subset = { model: request.model, inputs, proposals: { items: request.proposals.items.filter(item => ids.has(item.id)) },
      ...(request.previousDecisions ? { previousDecisions: request.previousDecisions.filter(item => ids.has(String(item.productId))) } : {}) };
    const built = request.textReview ? buildProductTextReviewRequest(inputs, request.model)
      : request.membershipFeatures ? buildMembershipFeatureReviewRequest(inputs, subset.proposals, request.model)
      : buildTagReviewRequest(inputs, subset.proposals, request.model, subset.previousDecisions);
    const estimate = estimateStandardizationRequest(built, limits);
    const estimatedOutputTokens = inputs.reduce((total, input) => {
      const tags = subset.proposals.items.find(item => item.id === input.id)?.tags.length ?? 0;
      // A singleton is indivisible and retains the entire configured response budget.
      return total + Math.min(limits.outputReserveTokens, request.textReview ? 64 + (readTextEvidence(input) ? TEXT_REVIEW_OUTPUT_TOKENS : 0)
        : request.membershipFeatures ? 64
        : 64 + Math.ceil(input.id.length / 3) + tags * 2);
    }, 0);
    return { request: subset, estimate, oversized: estimate.requestBytes > limits.maxRequestBytes
      || estimate.estimatedTotalTokens > limits.maxContextTokens || estimatedOutputTokens > limits.outputReserveTokens };
  };
  const groups: ReturnType<typeof make>[] = [];
  let current: TagExtractionInput[] = [];
  for (const input of request.inputs) {
    const combined = make([...current, input]);
    if (current.length && combined.oversized) { groups.push(make(current)); current = []; }
    const next = current.length ? combined : make([input]);
    if (next.oversized) { groups.push(next); current = []; }
    else current = next.request.inputs;
  }
  if (current.length) groups.push(make(current));
  return groups;
}

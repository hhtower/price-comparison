import { buildTagReviewRequest } from './tag-review-request.js';
import type { TagExtractionInput, TagExtractionResponse } from './tag-extraction-request.js';
import { estimateStandardizationRequest, type StandardizationRequestLimits } from './standardization-request.js';
import { CONSISTENCY_KEYS, DISCLOSURE_KEYS, readTextEvidence } from '../shops/shop-text-review.js';

// Planning allowance for a brief reason, citations and JSON per text judgment;
// it is not a bound on every schema-valid response or measured model usage.
const TEXT_REVIEW_OUTPUT_TOKENS = (DISCLOSURE_KEYS.length + CONSISTENCY_KEYS.length) * 512;

/** Keep whole frozen inputs and their proposals together within the actual review request budget. */
export function planTagReviewRequests(request: {
  model: string; inputs: readonly TagExtractionInput[]; proposals: TagExtractionResponse;
}, limits: StandardizationRequestLimits) {
  const make = (inputs: TagExtractionInput[]) => {
    const ids = new Set(inputs.map(input => input.id));
    const subset = { model: request.model, inputs, proposals: { items: request.proposals.items.filter(item => ids.has(item.id)) } };
    const estimate = estimateStandardizationRequest(buildTagReviewRequest(inputs, subset.proposals, request.model), limits);
    const estimatedOutputTokens = inputs.reduce((total, input) => {
      const tags = subset.proposals.items.find(item => item.id === input.id)?.tags.length ?? 0;
      // A singleton is indivisible and retains the entire configured response budget.
      return total + Math.min(limits.outputReserveTokens, 64 + tags * 2 + (readTextEvidence(input) ? TEXT_REVIEW_OUTPUT_TOKENS : 0));
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

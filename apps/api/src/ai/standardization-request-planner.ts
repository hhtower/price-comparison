import { buildStandardizationRequest, estimateStandardizationRequest, type StandardizationRequest, type StandardizationRequestLimits } from './standardization-request.js';

/** Partition whole items, retaining every evidence field and item-local candidate. */
export function planStandardizationRequests(request: StandardizationRequest, limits: StandardizationRequestLimits) {
  const make = (inputs: StandardizationRequest['inputs']) => {
    const ids = new Set(inputs.flatMap(input => [...input.candidateStandardProductIds]));
    const subset: StandardizationRequest = { model: request.model, inputs, candidates: request.candidates.filter(candidate => ids.has(candidate.id)) };
    const estimate = estimateStandardizationRequest(buildStandardizationRequest(subset), limits);
    return { request: subset, estimate, oversized: estimate.requestBytes > limits.maxRequestBytes || estimate.estimatedTotalTokens > limits.maxContextTokens };
  };
  const result: ReturnType<typeof make>[] = [];
  let current: StandardizationRequest['inputs'] = [];
  for (const input of request.inputs) {
    const combined = make([...current, input]);
    if (current.length && combined.oversized) { result.push(make(current)); current = []; }
    const next = [...current, input];
    const planned = current.length ? combined : make(next);
    if (planned.oversized) { result.push(planned); current = []; } else current = next;
  }
  if (current.length) result.push(make(current));
  return result;
}

import { buildCandidateSearchQuery, planAdaptiveBatches, type AiInputSize, type BatchLimits } from './adaptive-batching.js';
import { planSimilarityGroups } from '../standardization/input-grouping.js';
import { extractServiceEvidence } from '../standardization/service-evidence.js';

export function planBulkStandardizationBatches(inputs: readonly (AiInputSize & { standardProductId: bigint })[], limits: BatchLimits) {
  const byIdentity = new Map<string, AiInputSize[]>();
  for (const input of inputs) {
    const key = String(input.standardProductId);
    const group = byIdentity.get(key) ?? []; group.push(input); byIdentity.set(key, group);
  }
  return [...byIdentity.values()].flatMap(group => groupByProvider(group).flatMap(provider => planAdaptiveBatches(provider, limits)));
}

function groupByProvider(inputs: readonly AiInputSize[]) {
  const byProvider = new Map<string, AiInputSize[]>();
  for (const input of inputs) {
    const payload = input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? input.payload : {};
    const service = extractServiceEvidence(payload.sourceData);
    const key = JSON.stringify(service);
    const group = byProvider.get(key) ?? []; group.push(input); byProvider.set(key, group);
  }
  return [...byProvider.values()];
}

/** Refusals are terminal for a request: keep independent sale objects/providers apart. */
export function planIndependentStandardizationBatches(inputs: readonly AiInputSize[], limits: BatchLimits) {
  return groupByProvider(inputs).flatMap(provider => {
    const byId = new Map(provider.map(input => [String(input.productId), input]));
    const groups = planSimilarityGroups(provider.map(input => {
      const query = buildCandidateSearchQuery(input.payload);
      return { id: String(input.productId), text: query.primaryText || query.text };
    }), { maxGroupSize: limits.maxItems });
    return groups.groups.flatMap(group => planAdaptiveBatches(group.memberIds.map(id => byId.get(id)!), limits));
  });
}

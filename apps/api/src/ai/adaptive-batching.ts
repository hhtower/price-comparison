import type { JsonValue } from '../database/types.js';
import { normalizeProductEvidence } from '../standardization/fingerprint.js';
import { assessProductEvidence } from '../standardization/identity-policy.js';
import { buildCanonicalStandardKey } from '../standardization/canonical-key.js';
import type { CandidateSearchQuery } from '../standardization/candidate-index.js';
import { sanitizeEvidenceText } from '../standardization/service-evidence.js';
import { visibleEvidenceText } from '../standardization/evidence-text.js';
import { projectShopText } from '../shops/shop-text-review.js';

export interface AiInputSize {
  productId: bigint;
  payload: JsonValue;
  inputBytes: number;
  estimatedTokens: number;
}
export interface BatchLimits { maxItems: number; maxInputBytes: number; maxInputTokens: number; }
export interface PlannedBatch { productIds: bigint[]; inputBytes: number; estimatedTokens: number; }

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function planAdaptiveBatches(inputs: readonly AiInputSize[], limits: BatchLimits): PlannedBatch[] {
  const maxItems = positive(limits.maxItems, 'maxItems');
  const maxInputBytes = positive(limits.maxInputBytes, 'maxInputBytes');
  const maxInputTokens = positive(limits.maxInputTokens, 'maxInputTokens');
  const batches: PlannedBatch[] = [];
  let current: PlannedBatch | undefined;
  for (const input of inputs) {
    if (!Number.isSafeInteger(input.inputBytes) || input.inputBytes < 0 || !Number.isSafeInteger(input.estimatedTokens) || input.estimatedTokens < 0) throw new Error('input size must be a non-negative integer');
    if (input.inputBytes > maxInputBytes || input.estimatedTokens > maxInputTokens) { current = undefined; continue; }
    if (!current || current.productIds.length >= maxItems || current.inputBytes + input.inputBytes > maxInputBytes || current.estimatedTokens + input.estimatedTokens > maxInputTokens) {
      current = { productIds: [], inputBytes: 0, estimatedTokens: 0 };
      batches.push(current);
    }
    current.productIds.push(input.productId);
    current.inputBytes += input.inputBytes;
    current.estimatedTokens += input.estimatedTokens;
  }
  return batches;
}

export interface ExtractionInput { id: string; name: string; spec: string; category?: string; platform?: string; vendor?: string; family?: string; tier?: string; model?: string; sourceData?: JsonValue; evidence?: string; }
export type ExtractionPayload = Record<string, JsonValue>;

export function extractionPayloadKey(payload: ExtractionPayload): string {
  const { id, shopText, shopSource, ...evidence } = payload;
  return JSON.stringify(evidence);
}

/** Search facts rather than JSON field names and prioritize a supported identity. */
export function buildCandidateSearchQuery(payload: JsonValue): CandidateSearchQuery {
  const input = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const normalized = normalizeProductEvidence({
    name: typeof input.name === 'string' ? input.name : '',
    spec: typeof input.spec === 'string' ? input.spec : '',
    sourceCategory: typeof input.category === 'string' ? input.category : '',
    sourceData: input.sourceData,
  });
  const evidence = { ...normalized, ...Object.fromEntries(
    ['brand', 'vendor', 'family', 'tier', 'model', 'evidence'].filter(key => input[key] !== undefined).map(key => [key, input[key]]),
  ) };
  const strings = (value: unknown): string[] => {
    if (typeof value === 'string' || typeof value === 'number') return [String(value)];
    if (!value || typeof value !== 'object') return [];
    return Object.values(value).flatMap(strings);
  };
  // The production payload is already frozen visible text. Normalizing it again
  // would erase block boundaries that distinguish headings from sale assertions.
  const assessment = assessProductEvidence(input, 'text');
  const primaryText = strings({ name: normalized.name, spec: normalized.spec,
    ...Object.fromEntries(['brand', 'vendor', 'family', 'tier', 'model', 'serviceProvider', 'serviceEndpoint']
      .map(key => [key, input[key] ?? normalized.sourceData[key]])),
  }).join(' ');
  return { text: strings(evidence).join(' '), primaryText, ...(assessment.identity ? {
    canonicalKey: buildCanonicalStandardKey(assessment.identity), canonicalKeyConfidence: 'heuristic' as const,
  } : {}) };
}

export function buildExtractionPayload(input: ExtractionInput): ExtractionPayload {
  const normalized = normalizeProductEvidence({ name: input.name, spec: input.spec, sourceCategory: input.category, sourceData: input.sourceData });
  const project = (value: JsonValue): JsonValue => typeof value === 'string' ? visibleEvidenceText(value)
    : Array.isArray(value) ? value.map(project)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, project(item)])) : value;
  const source = project(normalized.sourceData as JsonValue) as Record<string, JsonValue>;
  const payload: ExtractionPayload = { id: input.id, name: visibleEvidenceText(normalized.name), spec: visibleEvidenceText(sanitizeEvidenceText(normalized.spec)) };
  // Keep the original normalized source path for citations. An explicit body is
  // moved there only when no source body exists; distinct evidence is never lost.
  const explicitEvidence = input.evidence === undefined ? undefined
    : visibleEvidenceText(sanitizeEvidenceText(input.evidence.normalize('NFKC')));
  if (explicitEvidence !== undefined) {
    if (source.evidence === undefined) source.evidence = explicitEvidence;
    else if (source.evidence !== explicitEvidence) payload.evidence = explicitEvidence;
  }
  if (Object.keys(source).length) payload.sourceData = source as JsonValue;
  const shopText = projectShopText(input.sourceData);
  if (shopText) payload.shopText = shopText;
  const rawSource = normalized.sourceData;
  const fields = { category: input.category == null ? undefined : normalized.sourceCategory, platform: input.platform, vendor: input.vendor ?? rawSource.vendor ?? rawSource.brand, brand: rawSource.brand, family: input.family ?? rawSource.family, tier: input.tier ?? rawSource.tier, model: input.model ?? rawSource.model };
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string' || typeof value === 'number') {
      payload[key] = visibleEvidenceText(String(value).normalize('NFKC'));
    }
  }
  return payload;
}

export function estimateInputSize(payload: JsonValue): { inputBytes: number; estimatedTokens: number } {
  const serialized = JSON.stringify(payload);
  // A planning estimate, never provider usage: ASCII prose is roughly four
  // characters per token; multilingual and symbol-heavy input needs more room.
  let estimatedTokens = 0;
  for (const character of serialized) {
    estimatedTokens += character.codePointAt(0)! < 128 ? 0.25 : Buffer.byteLength(character, 'utf8') / 2;
  }
  return { inputBytes: Buffer.byteLength(serialized, 'utf8'), estimatedTokens: Math.ceil(estimatedTokens) };
}

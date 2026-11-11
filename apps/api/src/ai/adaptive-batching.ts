import type { JsonValue } from '../database/types.js';
import { normalizeProductEvidence, productContentEvidence, productContentKey } from '../standardization/fingerprint.js';
import { assessProductEvidence } from '../standardization/identity-policy.js';
import { buildCanonicalStandardKey } from '../standardization/canonical-key.js';
import type { CandidateSearchQuery } from '../standardization/candidate-index.js';
import { projectShopText } from '../shops/shop-text-review.js';
import { visibleEvidenceText } from '../standardization/evidence-text.js';
import { sanitizeEvidenceText } from '../standardization/service-evidence.js';

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

export interface ExtractionInput { id: string; name: string; sourceName?: string; description?: string; spec: string; category?: string; platform?: string; vendor?: string; family?: string; tier?: string; model?: string; sourceData?: JsonValue; evidence?: string; }
export type ExtractionPayload = Record<string, JsonValue>;

export function extractionPayloadKey(payload: ExtractionPayload): string {
  return productContentKey(payload);
}

export function extractionContextKey(payload: ExtractionPayload): string {
  const { id: _id, shopText: _shopText, shopSource: _shopSource, ...context } = payload;
  return JSON.stringify(context);
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
  const source = input.sourceData && typeof input.sourceData === 'object' && !Array.isArray(input.sourceData)
    ? input.sourceData : {};
  const body = input.description ?? input.evidence;
  const visible = (value: unknown) => typeof value === 'string'
    ? visibleEvidenceText(sanitizeEvidenceText(value.normalize('NFKC'))).trim() : '';
  const additionalBody = typeof body === 'string' && visible(source.evidence) && visible(source.evidence) !== visible(body)
    ? source.evidence : '';
  const goods = {
    name: input.sourceName || input.name, description: input.description ?? input.evidence,
    spec: input.spec, sourceCategory: input.category, sourceData: additionalBody
      ? { ...source, content: [source.content, additionalBody].filter(value => typeof value === 'string' && value).join('\n') }
      : source,
  };
  const core = productContentEvidence(goods);
  const normalized = normalizeProductEvidence(goods);
  const project = (value: JsonValue): JsonValue => typeof value === 'string' ? visibleEvidenceText(value).trim()
    : Array.isArray(value) ? value.map(project)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, project(item)])) : value;
  const context = project(normalized.sourceData as JsonValue) as Record<string, JsonValue>;
  // Extra facts inform the model without becoming additional change detectors.
  for (const key of ['evidence', 'content', 'warranty_info']) delete context[key];
  const sourceData = { ...context, ...core.sourceData };
  const payload: ExtractionPayload = { id: input.id, name: core.name, spec: core.spec };
  if (Object.keys(sourceData).length) payload.sourceData = sourceData;
  const fields = { category: input.category == null ? undefined : normalized.sourceCategory, platform: input.platform,
    vendor: input.vendor ?? normalized.sourceData.vendor ?? normalized.sourceData.brand, brand: normalized.sourceData.brand,
    family: input.family ?? normalized.sourceData.family, tier: input.tier ?? normalized.sourceData.tier, model: input.model ?? normalized.sourceData.model };
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string' || typeof value === 'number') {
      payload[key] = visibleEvidenceText(sanitizeEvidenceText(String(value).normalize('NFKC'))).trim();
    }
  }
  const shopText = projectShopText(input.sourceData);
  if (shopText) payload.shopText = shopText;
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

import type { JsonValue } from '../database/types.js';
import { readTextEvidence, type TextEvidence } from '../shops/shop-text-review.js';
import { sanitizeEvidenceText } from '../standardization/service-evidence.js';

function object(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function represented(payload: Record<string, JsonValue>, key: 'name' | 'description', text: string): boolean {
  const source = object(payload.sourceData);
  const original = object(payload.originalText);
  const values = key === 'name' ? [payload.name, original.name]
    : [payload.description, payload.evidence, source.evidence, source.content, original.description];
  return values.includes(text);
}

/** Freeze safe verbatim alternatives before any task drops the raw review capture. */
export function projectOriginalText(payload: Record<string, JsonValue>, text: Pick<TextEvidence, 'name' | 'description'>): Record<string, string> {
  return Object.fromEntries((['name', 'description'] as const).flatMap(key => {
    const value = sanitizeEvidenceText(text[key]);
    return represented(payload, key, value) ? [] : [[key, value]];
  }));
}

/** Transport only: keep the complete buildExtractionPayload result for freezing and citation validation. */
export function projectSemanticEvidence(payload: Record<string, JsonValue>): Record<string, JsonValue> {
  const projected = structuredClone(payload);
  const text = readTextEvidence(payload);
  if (!text) return projected;
  const remaining: Record<string, string> = {};
  for (const key of ['name', 'description'] as const) {
    const safe = sanitizeEvidenceText(text[key]);
    if (represented(payload, key, safe)) continue;
    if (safe !== text[key]) throw new Error('Semantic evidence requires frozen sanitized captured text');
    remaining[key] = text[key];
  }
  if (Object.keys(remaining).length) projected.shopText = remaining;
  else delete projected.shopText;
  return projected;
}

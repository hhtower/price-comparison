import { createHash } from 'node:crypto';
import { extractServiceEvidence, sanitizeEvidenceText } from './service-evidence.js';
import { normalizeSpec } from '../products/product-spec.js';

export interface ProductEvidenceInput {
  readonly name: string;
  readonly description?: string | null;
  readonly spec?: string | null;
  readonly sourceCategory?: string | null;
  readonly sourceData?: unknown;
}

export type NormalizedEvidenceValue = null | boolean | number | string | NormalizedEvidenceValue[] | { [key: string]: NormalizedEvidenceValue };

export interface NormalizedProductEvidence {
  readonly name: string;
  readonly spec: string;
  readonly sourceCategory: string;
  readonly sourceData: Record<string, NormalizedEvidenceValue>;
}

const EXCLUDED_SOURCE_KEYS = new Set([
  'price', 'minprice', 'maxprice', 'marketprice', 'saleprice', 'costprice',
  'stock', 'instock', 'stocknum', 'stockavailable', 'stockavailablequantity',
  'stockcount', 'stockavailablestatus',
  'inventory', 'inventorycount', 'availability', 'sales', 'soldcount',
  'salescount', 'salescounttext', 'salesnum', 'soldcounttext', 'soldnum', 'soldquantity',
  'url', 'link', 'image', 'imageurl', 'thumbnail',
  'goodsno', 'goodskey', 'externalid', 'status',
  'capturedat', 'fetchedat', 'crawledat', 'createdat', 'updatedat',
  'createtime', 'updatetime', 'contactformat', 'couponstatus', 'discount',
  'showstocktype', 'querypasswordstatus', 'sendorder',
  'secret', 'password', 'passwd', 'token', 'accesstoken', 'refreshtoken',
  'apikey', 'authorization', 'cookie', 'setcookie', 'session', 'sessionid',
]);

/** Canonical representation used for deterministic matching and lookup. */
export function canonicalizeMatchText(value: unknown): string {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('en-US');
}

function normalizeText(value: unknown): string {
  return sanitizeEvidenceText(String(value ?? '')).normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function normalizedKeyName(key: string): string {
  return key.normalize('NFKC').replace(/[\s_-]+/gu, '').toLocaleLowerCase('en-US');
}

function normalizeEvidenceValue(value: unknown, ancestors: WeakSet<object>, path: readonly string[] = []): NormalizedEvidenceValue | undefined {
  if (value === null) return null;
  if (typeof value === 'string') return normalizeText(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError('product evidence must not contain cycles');
    ancestors.add(value);
    const normalized = value.flatMap((item) => {
      const result = normalizeEvidenceValue(item, ancestors, path);
      return result === undefined ? [] : [result];
    });
    ancestors.delete(value);
    return normalized;
  }
  if (value && typeof value === 'object') {
    if (ancestors.has(value)) throw new TypeError('product evidence must not contain cycles');
    ancestors.add(value);
    const output: Record<string, NormalizedEvidenceValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const normalizedKey = normalizedKeyName(key);
      if (EXCLUDED_SOURCE_KEYS.has(normalizedKey)) continue;
      // Rebuild the controlled projection below, including on normalized input.
      if (path.length === 0 && normalizedKey === 'serviceevidence') continue;
      // These objects identify the listing's seller/category, not the goods.
      // Keep category names and IDs in selected SKU options as actual evidence.
      if (path.length === 0 && ['user', 'seller', 'merchant', 'shop', 'store'].includes(normalizedKey)) continue;
      if (path.at(-1) === 'category' && normalizedKey === 'id') continue;
      const normalized = normalizeEvidenceValue((value as Record<string, unknown>)[key], ancestors, [...path, normalizedKey]);
      if (normalized !== undefined) output[key] = normalized;
    }
    ancestors.delete(value);
    return output;
  }
  return undefined;
}

/** Retains all JSON-compatible facts while removing quote, transport and sensitive metadata. */
export function normalizeSourceEvidence(input: unknown): Record<string, NormalizedEvidenceValue> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  // Shop rating capture has its own hash; adding it must not invalidate goods or derived tags.
  const evidence = Object.fromEntries(Object.entries(input)
    .filter(([key]) => !['ratingtext', 'ratingunitid', 'selectedoptions', 'sku', 'specification', 'spec'].includes(normalizedKeyName(key))));
  const normalized = normalizeEvidenceValue(evidence, new WeakSet()) as Record<string, NormalizedEvidenceValue>;
  const service = extractServiceEvidence(evidence);
  if (service.endpoints.length || service.brands.length) normalized.serviceEvidence = { endpoints: service.endpoints, brands: service.brands };
  return normalized;
}

export function normalizeProductEvidence(input: ProductEvidenceInput): NormalizedProductEvidence {
  return {
    name: normalizeText(input.name),
    spec: normalizeSpec(input.spec),
    sourceCategory: normalizeText(input.sourceCategory),
    sourceData: normalizeSourceEvidence(input.sourceData),
  };
}

export function productContentFingerprint(input: ProductEvidenceInput): string {
  return createHash('sha256').update(JSON.stringify([input.name, input.description ?? '', normalizeSpec(input.spec)])).digest('hex');
}

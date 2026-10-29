import { canonicalizeMatchText } from './fingerprint.js';

export interface TextFeatures {
  readonly normalized: string;
  readonly compact: string;
  readonly tokenTerms: ReadonlyMap<string, number>;
  readonly ngrams: ReadonlySet<string>;
  readonly truncated: boolean;
}

export interface TextFeatureOptions {
  readonly maxFeatures?: number;
}

export function normalizeSearchText(value: unknown): string {
  return canonicalizeMatchText(value).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function compactSearchText(value: unknown): string {
  return normalizeSearchText(value).replace(/\s+/gu, '');
}

export function extractTokenTerms(text: string): Map<string, number> {
  const result = new Map<string, number>();
  for (const term of normalizeSearchText(text).match(/[a-z0-9]+|[\p{Script=Han}]+/gu) ?? []) {
    result.set(term, (result.get(term) ?? 0) + 1);
  }
  return result;
}

export function extractCharacterNgrams(text: string): Set<string> {
  const compact = compactSearchText(text);
  const result = new Set<string>();
  for (const width of [2, 3]) {
    for (let index = 0; index + width <= compact.length; index++) result.add(compact.slice(index, index + width));
  }
  return result;
}

export function extractTextFeatures(text: string, options: TextFeatureOptions = {}): TextFeatures {
  const normalized = normalizeSearchText(text);
  const maxFeatures = options.maxFeatures ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxFeatures) || maxFeatures < 1) {
    throw new RangeError('maxFeatures must be a positive integer');
  }
  const tokenTerms = new Map<string, number>();
  let truncated = false;
  for (const match of normalized.matchAll(/[a-z0-9]+|[\p{Script=Han}]+/gu)) {
    const term = match[0];
    const count = tokenTerms.get(term);
    if (count !== undefined) tokenTerms.set(term, count + 1);
    else if (tokenTerms.size < maxFeatures) tokenTerms.set(term, 1);
    else truncated = true;
  }
  const compact = normalized.replace(/\s+/gu, '');
  const ngrams = new Set<string>();
  outer: for (const width of [2, 3]) {
    for (let index = 0; index + width <= compact.length; index++) {
      const ngram = compact.slice(index, index + width);
      if (ngrams.has(ngram)) continue;
      if (tokenTerms.size + ngrams.size >= maxFeatures) {
        truncated = true;
        break outer;
      }
      ngrams.add(ngram);
    }
  }
  return {
    normalized,
    compact,
    tokenTerms,
    ngrams,
    truncated,
  };
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection++;
  return intersection / (left.size + right.size - intersection);
}

export function textFeatureSimilarity(left: TextFeatures, right: TextFeatures): number {
  if (left.normalized && left.normalized === right.normalized) return 1;
  const tokenScore = jaccard(new Set(left.tokenTerms.keys()), new Set(right.tokenTerms.keys()));
  const ngramScore = jaccard(left.ngrams, right.ngrams);
  return tokenScore * 0.65 + ngramScore * 0.35;
}

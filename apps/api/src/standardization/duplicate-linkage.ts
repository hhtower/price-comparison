import { buildCanonicalStandardKey, canonicalizeMatchText } from './canonical-key.js';
import { extractTextFeatures, textFeatureSimilarity } from './text-features.js';
import type { DuplicateLinkagePolicy, LinkageBin } from './duplicate-linkage-policy.js';

export interface StandardProductIdentity {
  readonly id: string;
  readonly family: string;
  readonly product: string;
  readonly tier: string;
  readonly canonicalKey?: string;
}

export interface DuplicateFeatureVector {
  readonly leftId: string;
  readonly rightId: string;
  readonly sameCanonicalKey: boolean;
  confirmedAlias: boolean;
  readonly familyExact: boolean;
  readonly productExact: boolean;
  readonly tierExact: boolean;
  readonly tierCoreExact: boolean;
  readonly tokenSimilarity: number;
  readonly ngramSimilarity: number;
  readonly editSimilarity: number;
  readonly crossFieldSimilarity: number;
  readonly hardConflicts: readonly string[];
}

export interface DuplicateScoreContribution {
  readonly feature: string;
  readonly bin: LinkageBin;
  readonly weight: number;
  readonly value: number | boolean;
}

export interface DuplicatePairDecision {
  readonly conclusion: 'deterministic_match' | 'suspected_duplicate' | 'distinct';
  readonly policyVersion: string;
  readonly hardConflicts: readonly string[];
  readonly contributions: readonly DuplicateScoreContribution[];
  readonly score: number;
}

function normalizeField(value: string, field: 'family' | 'product' | 'tier', policy: DuplicateLinkagePolicy): string {
  const normalized = canonicalizeMatchText(value);
  return policy.fieldAliases[field][normalized] ?? normalized;
}

function tokens(value: string): Set<string> {
  return new Set(extractTextFeatures(value).tokenTerms.keys());
}

const TIER_QUALIFIERS = new Set([
  'annual', 'annually', 'exclusive', 'month', 'monthly', 'plan', 'plans', 'shared',
  'subscription', 'subscriptions', 'year', 'yearly', '包年', '包月', '合租', '共享',
  '套餐', '年付', '月付', '独享', '订阅', '专享',
]);

function tierCore(value: string): ReadonlySet<string> {
  return new Set([...tokens(value)].filter(token => !TIER_QUALIFIERS.has(token)));
}

function sameNonEmptySet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size > 0 && left.size === right.size && [...left].every(value => right.has(value));
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let common = 0;
  for (const value of left) if (right.has(value)) common += 1;
  return common / (left.size + right.size - common);
}

function levenshtein(left: string, right: string): number {
  if (left === right) return 0;
  if (!left) return right.length;
  if (!right) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1]! + 1,
        previous[column]! + 1,
        previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length]!;
}

function editSimilarity(left: string, right: string): number {
  const maximum = Math.max(left.length, right.length);
  return maximum === 0 ? 1 : 1 - levenshtein(left, right) / maximum;
}

function isSms(product: string): boolean {
  return /(?:_sms|接码|接马|verification)/u.test(product);
}

export function extractDuplicateFeatures(
  left: StandardProductIdentity,
  right: StandardProductIdentity,
  policy: DuplicateLinkagePolicy,
): DuplicateFeatureVector {
  const leftFields = {
    family: normalizeField(left.family, 'family', policy),
    product: normalizeField(left.product, 'product', policy),
    tier: normalizeField(left.tier, 'tier', policy),
  };
  const rightFields = {
    family: normalizeField(right.family, 'family', policy),
    product: normalizeField(right.product, 'product', policy),
    tier: normalizeField(right.tier, 'tier', policy),
  };
  const leftKey = left.canonicalKey ?? buildCanonicalStandardKey(left);
  const rightKey = right.canonicalKey ?? buildCanonicalStandardKey(right);
  const leftCombined = `${leftFields.family} ${leftFields.product} ${leftFields.tier}`;
  const rightCombined = `${rightFields.family} ${rightFields.product} ${rightFields.tier}`;
  const leftTierCore = tierCore(leftFields.tier);
  const rightTierCore = tierCore(rightFields.tier);
  const hardConflicts: string[] = [];
  if (isSms(leftFields.product) !== isSms(rightFields.product)) hardConflicts.push('sale_object_conflict');
  const knownFamilies = new Set(['openai', 'google', 'anthropic', 'microsoft', 'bytedance', 'x', 'steam']);
  if (knownFamilies.has(leftFields.family) && knownFamilies.has(rightFields.family) && leftFields.family !== rightFields.family) hardConflicts.push('family_conflict');
  const sameScope = leftFields.family === rightFields.family && leftFields.product === rightFields.product;
  if (sameScope && leftFields.tier !== rightFields.tier && leftTierCore.size > 0 && rightTierCore.size > 0 && jaccard(leftTierCore, rightTierCore) === 0) {
    hardConflicts.push('tier_conflict');
  }

  const fieldValuesLeft = Object.values(leftFields);
  const fieldValuesRight = Object.values(rightFields);
  let crossFieldSimilarity = 0;
  for (const leftValue of fieldValuesLeft) for (const rightValue of fieldValuesRight) {
    crossFieldSimilarity = Math.max(crossFieldSimilarity, textFeatureSimilarity(extractTextFeatures(leftValue), extractTextFeatures(rightValue)));
  }
  return {
    leftId: left.id,
    rightId: right.id,
    sameCanonicalKey: leftKey === rightKey,
    confirmedAlias: false,
    familyExact: leftFields.family === rightFields.family,
    productExact: leftFields.product === rightFields.product,
    tierExact: leftFields.tier === rightFields.tier,
    tierCoreExact: leftFields.tier === rightFields.tier || sameNonEmptySet(leftTierCore, rightTierCore),
    tokenSimilarity: jaccard(tokens(leftCombined), tokens(rightCombined)),
    ngramSimilarity: textFeatureSimilarity(extractTextFeatures(leftCombined), extractTextFeatures(rightCombined)),
    editSimilarity: editSimilarity(leftCombined.replace(/\s+/gu, ''), rightCombined.replace(/\s+/gu, '')),
    crossFieldSimilarity,
    hardConflicts,
  };
}

export function similarityBin(value: number): LinkageBin {
  if (value >= 0.72) return 'high';
  if (value >= 0.38) return 'medium';
  return 'low';
}

export function duplicateFeatureBins(features: DuplicateFeatureVector): Readonly<Record<string, LinkageBin>> {
  return {
    familyExact: features.familyExact ? 'yes' : 'no',
    productExact: features.productExact ? 'yes' : 'no',
    tierExact: features.tierExact ? 'yes' : 'no',
    tierCoreExact: features.tierCoreExact ? 'yes' : 'no',
    tokenSimilarity: similarityBin(features.tokenSimilarity),
    ngramSimilarity: similarityBin(features.ngramSimilarity),
    editSimilarity: similarityBin(features.editSimilarity),
    crossFieldSimilarity: similarityBin(features.crossFieldSimilarity),
  };
}

export function classifyDuplicatePair(features: DuplicateFeatureVector, policy: DuplicateLinkagePolicy): DuplicatePairDecision {
  const bins = duplicateFeatureBins(features);
  const rawValues: Record<string, number | boolean> = {
    familyExact: features.familyExact,
    productExact: features.productExact,
    tierExact: features.tierExact,
    tierCoreExact: features.tierCoreExact,
    tokenSimilarity: features.tokenSimilarity,
    ngramSimilarity: features.ngramSimilarity,
    editSimilarity: features.editSimilarity,
    crossFieldSimilarity: features.crossFieldSimilarity,
  };
  const values = Object.entries(bins).map(([feature, bin]) => [feature, bin, rawValues[feature]!] as [string, LinkageBin, number | boolean]);
  const contributions = values.map(([feature, bin, value]) => {
    const qualifierOnlyTierDifference = feature === 'tierExact' && !features.tierExact && features.tierCoreExact;
    return {
      feature,
      bin,
      value,
      weight: qualifierOnlyTierDifference ? 0 : policy.weights[feature]?.[bin] ?? 0,
    };
  });
  const score = contributions.reduce((sum, item) => sum + item.weight, 0);
  const conclusion = features.sameCanonicalKey || features.confirmedAlias
    ? 'deterministic_match'
    : features.hardConflicts.length > 0
      ? 'distinct'
      : score >= policy.suspectedThreshold ? 'suspected_duplicate' : 'distinct';
  return { conclusion, policyVersion: policy.version, hardConflicts: features.hardConflicts, contributions, score };
}

export function duplicateBlockingTerms(product: StandardProductIdentity, policy: DuplicateLinkagePolicy): Record<string, readonly string[]> {
  const family = normalizeField(product.family, 'family', policy);
  const productName = normalizeField(product.product, 'product', policy);
  const tier = normalizeField(product.tier, 'tier', policy);
  const productTokens = [...tokens(productName)].sort();
  const tierTokens = [...tokens(tier)].sort();
  const combined = extractTextFeatures(`${family} ${productName} ${tier}`);
  const ngrams = [...combined.ngrams].sort().slice(0, 16);
  return {
    familyProduct: productTokens.map(token => `${family}:${token}`),
    productTier: productTokens.flatMap(productToken => tierTokens.slice(0, 4).map(tierToken => `${productToken}:${tierToken}`)).slice(0, 16),
    characterNgram: ngrams,
    combinedToken: [...combined.tokenTerms.keys()].sort().slice(0, 16),
  };
}

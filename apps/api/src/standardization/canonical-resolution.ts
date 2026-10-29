import { type Transaction } from 'kysely';
import type { DatabaseSchema } from '../database/types.js';
import { buildCanonicalStandardKey } from './canonical-key.js';
import { isValidCatalogIdentity, normalizeIdentity, type Identity } from './identity-policy.js';

export const CANONICAL_RESOLUTION_VERSION = 'reviewed-existing-spellings-20261013-v3';

/** Purchase duration, quantity and face value belong to SKU attributes, not a new plan. */
export function isSkuOnlyIdentityTier(identity: Identity): boolean {
  const tier = normalizeIdentity(identity).tier.replace(/[\s_-]/gu, '');
  return /^\d+(?:\.\d+)?$/u.test(tier)
    || /^(?:(?:daily|weekly|monthly|quarterly|yearly|annual|days?|weeks?|months?|quarters?|years?)(?:card|pass)?|(?:日|天|周|月|季|季度|年)卡|\d+(?:\.\d+)?(?:days?|weeks?|months?|years?|hours?|天|日|周|个月|月|年|小时)(?:卡|card|pass)?)$/iu.test(tier)
    || /^(?:\d+(?:\.\d+)?(?:usd|eur|cny|rmb|dollars?|credits?|tokens?|accounts?|seats?|codes?|个|次|张|元|美元|美金|刀)|(?:[$€¥]|usd|eur|cny|rmb)\d+(?:\.\d+)?)$/iu.test(tier);
}

export type CanonicalResolution =
  | { status: 'resolved'; standardProductId: bigint; identity: Identity; canonicalKey: string }
  | { status: 'new'; identity: Identity; canonicalKey: string }
  | { status: 'conflict'; reason: string };

function sameIdentity(left: Identity, right: Identity): boolean {
  const a = normalizeIdentity(left), b = normalizeIdentity(right);
  return a.family === b.family && a.product === b.product && a.tier === b.tier;
}

// Reviewed spelling equivalents from audited merges (2026-09-29 and later
// similar-standard audits). These authorize only existing targets and merge
// chains, never display aliases.
const reviewedSpellings: Readonly<Record<string, string>> = {
  'google/gmail/standard': 'google/email/standard',
  'google/gmail/free': 'google/email/standard',
  'google/gmail_account/free': 'google/email/standard',
  'google/gmail_mail/standard': 'google/email/standard',
  'apple/icloud_email/standard': 'apple/icloud_mail/standard',
  'openai/codex_credits/standard': 'openai/codex/credits',
  'openai/codex_quota/standard': 'openai/codex/credits',
  'duolingo/super/standard': 'duolingo/duolingo/super',
  '一剑开天门/script_card/天卡': '一键开天门/script_card/standard',
  '芥末科技/ios_location_spoofing/standard': '芥末科技/ios_location_simulator/季卡',
  'deepseek/deepseek_v4_1_harness_bundle/standard': 'deepseek/deepseek_harness/standard',
  // Super Gro 网页镜像四分身与旧镜像键统一归 super_gro_web_mirror 正主（2026-10-24）。
  'xai/grok_mirror/standard': 'software/super_gro_web_mirror/standard',
  'xai/grok_mirror/supergrok': 'software/super_gro_web_mirror/standard',
  'software/super gro网页镜像/mirror': 'software/super_gro_web_mirror/standard',
  'software/grok_mirror/standard': 'software/super_gro_web_mirror/standard',
  'software/grok_web_mirror/standard': 'software/super_gro_web_mirror/standard',
  'software/super_grok_web_mirror/standard': 'software/super_gro_web_mirror/standard',
};
const spelling = (identity: Identity) => {
  const normalized = normalizeIdentity(identity);
  return [normalized.family, normalized.product, normalized.tier].join('/');
};

/** Resolve a key, or its explicitly reviewed equivalent through a verified merge
 * chain. Display aliases never decide identity. Locks last through commit. */
export async function resolveCanonicalIdentity(tx: Transaction<DatabaseSchema>, input: Identity & { canonicalKey?: string }): Promise<CanonicalResolution> {
  // Reviewed legacy spellings authorize existing targets only, never new identities.
  if (!isValidCatalogIdentity(input) && !reviewedSpellings[spelling(input)]) return { status: 'conflict', reason: 'invalid_identity' };
  const identity = normalizeIdentity(input);
  const canonicalKey = buildCanonicalStandardKey(identity);
  const reviewed = reviewedSpellings[spelling(identity)];
  let lookupIdentity = identity;
  let row = await tx.selectFrom('standard_products')
    .select(['id', 'standard_key', 'canonical_family', 'canonical_product', 'canonical_tier', 'merged_into_id', 'verification_state'])
    .where('standard_key', '=', canonicalKey).forUpdate().executeTakeFirst();
  if (!row && reviewed) {
    const [family, product, tier] = reviewed.split('/');
    lookupIdentity = { family: family!, product: product!, tier: tier! };
    row = await tx.selectFrom('standard_products')
      .select(['id', 'standard_key', 'canonical_family', 'canonical_product', 'canonical_tier', 'merged_into_id', 'verification_state'])
      .where('standard_key', '=', buildCanonicalStandardKey(lookupIdentity)).forUpdate().executeTakeFirst();
  }
  if (!row) return !isValidCatalogIdentity(identity) ? { status: 'conflict', reason: 'identity_unavailable' }
    : isSkuOnlyIdentityTier(identity) ? { status: 'conflict', reason: 'sku_in_identity' }
    : { status: 'new', identity, canonicalKey };
  const visited = new Set<bigint>();
  for (;;) {
    if (!row || row.verification_state !== 'verified' || !row.canonical_family || !row.canonical_product || !row.canonical_tier)
      return { status: 'conflict', reason: 'identity_unavailable' };
    const target = { family: row.canonical_family, product: row.canonical_product, tier: row.canonical_tier };
    const targetSpelling = spelling(target);
    if (row.standard_key !== buildCanonicalStandardKey(target) || (!visited.size ? !sameIdentity(lookupIdentity, target)
      : !reviewed || (targetSpelling !== reviewed && reviewedSpellings[targetSpelling] !== reviewed)))
      return { status: 'conflict', reason: 'canonical_identity_conflict' };
    if (row.merged_into_id === null) return isValidCatalogIdentity(target)
      ? { status: 'resolved', standardProductId: row.id, identity: target, canonicalKey: buildCanonicalStandardKey(target) }
      : { status: 'conflict', reason: 'invalid_identity' };
    if (!reviewed || visited.has(row.id) || visited.size >= 4) return { status: 'conflict', reason: 'unreviewed_tombstone' };
    visited.add(row.id);
    row = await tx.selectFrom('standard_products')
      .select(['id', 'standard_key', 'canonical_family', 'canonical_product', 'canonical_tier', 'merged_into_id', 'verification_state'])
      .where('id', '=', row.merged_into_id).forUpdate().executeTakeFirst();
  }
}

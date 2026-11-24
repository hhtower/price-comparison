import { sql, type RawBuilder } from 'kysely';
import { MEMBERSHIP_KINDS, MEMBERSHIP_POLICY_VERSION, MEMBERSHIP_BRANCH_PARENTS, MEMBERSHIP_BRANCH_POLICIES, membershipBaseKind, membershipDescendants,
  type MembershipClassification, type MembershipKind } from '@price-comparison/catalog/membership-policy';
import { type JsonValue } from '../database/types.js';

type EvidenceVersion = { content_version: bigint; content_fingerprint: string; standardization_revision: bigint;
  name?: string; spec?: string; source_category?: string; source_data?: JsonValue;
  shop_url: string; shop_protocol: string | null; shop_platform: string };
type Fact = { name: string; value: string; evidence?: readonly { path: string; quote: string }[] };
const TOP_UP_POLICY_VERSION = 'top-up-eligibility-20261124-v1';
export interface MembershipFeaturesSnapshot {
  contentVersion: string;
  fingerprint: string;
  revision: string;
  policyVersion: string;
  topUpPolicyVersion?: string;
  decision: MembershipClassification;
  tags: Fact[];
  evidence: Array<{ name: string; value: string; path: string; quote: string }>;
  rejectedNames: string[];
  source: { url: string; protocol: string | null; platform: string };
}

export function buildMembershipFeatures(tags: readonly Fact[], product: EvidenceVersion,
  rejectedNames: readonly string[], membershipKind: MembershipKind): MembershipFeaturesSnapshot {
  if (!MEMBERSHIP_KINDS.includes(membershipKind)) throw new Error('Reviewed membership kind is required');
  if (typeof product.shop_url !== 'string' || !product.shop_url
    || typeof product.shop_platform !== 'string'
    || (product.shop_protocol !== null && typeof product.shop_protocol !== 'string')) throw new Error('Membership source is required');
  const decision: MembershipClassification = {
    kind: membershipKind, reason: 'llm_reviewed',
  };
  return { contentVersion: String(product.content_version), fingerprint: product.content_fingerprint,
    revision: String(product.standardization_revision), policyVersion: MEMBERSHIP_POLICY_VERSION,
    ...(membershipBaseKind(membershipKind) === 'top_up' ? { topUpPolicyVersion: TOP_UP_POLICY_VERSION } : {}),
    source: { url: product.shop_url, protocol: product.shop_protocol, platform: product.shop_platform },
    decision, tags: tags.map(({ name, value }) => ({ name, value })), rejectedNames: [...rejectedNames],
    evidence: tags.flatMap(tag => (tag.evidence ?? []).map(citation => ({
      name: tag.name, value: tag.value, path: citation.path, quote: citation.quote,
    }))) };
}

export function readCurrentMembershipFeatures(value: unknown, product: EvidenceVersion): MembershipFeaturesSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const snapshot = value as MembershipFeaturesSnapshot;
  if (snapshot.contentVersion !== String(product.content_version) || snapshot.fingerprint !== product.content_fingerprint
    || snapshot.revision !== String(product.standardization_revision) || snapshot.policyVersion !== MEMBERSHIP_POLICY_VERSION
    || snapshot.decision?.reason !== 'llm_reviewed'
    || Object.keys(snapshot.decision).length !== 2
    || !Array.isArray(snapshot.tags) || !snapshot.tags.every(tag => tag && typeof tag.name === 'string' && typeof tag.value === 'string')
    || !Array.isArray(snapshot.rejectedNames) || !MEMBERSHIP_KINDS.includes(snapshot.decision?.kind)
    || (membershipBaseKind(snapshot.decision.kind) === 'top_up' && snapshot.topUpPolicyVersion !== TOP_UP_POLICY_VERSION)
    || !currentMembershipSource(snapshot, product)) return null;
  return snapshot;
}

function currentMembershipSource(snapshot: MembershipFeaturesSnapshot, product: EvidenceVersion): boolean {
  const source = snapshot.source;
  return Boolean(source && typeof source === 'object' && !Array.isArray(source) && Object.keys(source).length === 3
    && typeof source.url === 'string' && source.url && typeof source.platform === 'string'
    && (source.protocol === null || typeof source.protocol === 'string')
    && source.url === product.shop_url && source.protocol === product.shop_protocol && source.platform === product.shop_platform);
}

/** Read the approved feature of the current merchant SKU, independently of its standard identity. */
export function currentMembershipKind(productAlias = 'p', shopAlias = 'sh'): RawBuilder<MembershipKind | null> {
  const p = sql.table(productAlias), sh = sql.table(shopAlias);
  return sql<MembershipKind | null>`case when
    ${p}.membership_features->>'contentVersion' = ${p}.content_version::text
    and ${p}.membership_features->>'fingerprint' = ${p}.content_fingerprint
    and ${p}.membership_features->>'revision' = ${p}.standardization_revision::text
    and ${p}.membership_features->>'policyVersion' = ${MEMBERSHIP_POLICY_VERSION}
    and ${p}.membership_features #>> '{decision,reason}' = 'llm_reviewed'
    and ${p}.membership_features->'decision' = jsonb_build_object(
      'kind', ${p}.membership_features #>> '{decision,kind}', 'reason', 'llm_reviewed')
    and ${p}.membership_features #>> '{decision,kind}' = any(${[...MEMBERSHIP_KINDS]}::text[])
    and (not (${p}.membership_features #>> '{decision,kind}' = any(${membershipDescendants('top_up')}::text[]))
      or ${p}.membership_features->>'topUpPolicyVersion' = ${TOP_UP_POLICY_VERSION})
    and ${p}.membership_features->'source' =
      jsonb_build_object('url', ${sh}.url, 'protocol', ${sh}.protocol, 'platform', ${sh}.platform)
    then ${p}.membership_features #>> '{decision,kind}' else null end`;
}

export function membershipGroupKind(kind: RawBuilder<MembershipKind | null>, standardAlias = 'sp'): RawBuilder<MembershipKind | null> {
  const standard = sql.table(standardAlias);
  const branches = Object.entries(MEMBERSHIP_BRANCH_PARENTS).map(([branch, parent]) => {
    const identities = MEMBERSHIP_BRANCH_POLICIES.filter(policy => policy.branches.some(item => item.kind === branch))
      .map(({ identity }) => sql`(${standard}.canonical_family = ${identity.family}
        and ${standard}.canonical_product = ${identity.product} and ${standard}.canonical_tier = ${identity.tier})`);
    return sql`when ${kind} = ${branch} and not coalesce(${identities.length ? sql.join(identities, sql` or `) : sql`false`}, false) then ${parent}`;
  });
  return branches.length ? sql<MembershipKind | null>`case ${sql.join(branches, sql` `)} else ${kind} end` : kind;
}

export function catalogMembershipKind(ai: RawBuilder<boolean>, productAlias = 'p', shopAlias = 'sh'): RawBuilder<MembershipKind | null> {
  return sql<MembershipKind | null>`case when ${ai} then ${membershipGroupKind(currentMembershipKind(productAlias, shopAlias))} end`;
}

export function failedMembershipFeatures(productAlias = 'p', shopAlias = 'sh'): RawBuilder<boolean> {
  const p = sql.table(productAlias), sh = sql.table(shopAlias);
  return sql<boolean>`coalesce((
    select m.status in ('unclassified', 'failed')
    from ai_job_input_members m join ai_jobs j on j.id = m.job_id
    where m.product_id = ${p}.id and j.job_type = 'membership_features'
      and m.content_version = ${p}.content_version and m.fingerprint = ${p}.content_fingerprint
      and m.standardization_revision = ${p}.standardization_revision
      and m.payload->'shopSource' = jsonb_build_object('url', ${sh}.url, 'protocol', ${sh}.protocol, 'platform', ${sh}.platform)
    order by j.id desc limit 1
  ), false)`;
}

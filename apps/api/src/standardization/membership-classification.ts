import { sql, type RawBuilder } from 'kysely';
import { MEMBERSHIP_KINDS, MEMBERSHIP_POLICY_VERSION,
  type MembershipClassification, type MembershipKind } from '@price-comparison/catalog/membership-policy';
import { type JsonValue } from '../database/types.js';

type EvidenceVersion = { content_version: bigint; content_fingerprint: string; standardization_revision: bigint;
  name?: string; spec?: string; source_category?: string; source_data?: JsonValue;
  shop_url?: string; shop_protocol?: string | null; shop_platform?: string };
type Fact = { name: string; value: string; evidence?: readonly { path: string; quote: string }[] };
export interface MembershipFeaturesSnapshot {
  contentVersion: string;
  fingerprint: string;
  revision: string;
  policyVersion: string;
  decision: MembershipClassification;
  tags: Fact[];
  evidence: Array<{ name: string; value: string; path: string; quote: string }>;
  rejectedNames: string[];
  source?: { url: string; protocol: string | null; platform: string };
}

export function buildMembershipFeatures(tags: readonly Fact[], product: EvidenceVersion,
  rejectedNames: readonly string[], membershipKind: MembershipKind): MembershipFeaturesSnapshot {
  if (!MEMBERSHIP_KINDS.includes(membershipKind)) throw new Error('Reviewed membership kind is required');
  const decision: MembershipClassification = {
    kind: membershipKind, reason: 'llm_reviewed',
    ...(tags.some(tag => tag.name === 'duration' || tag.name.startsWith('duration_')) ? { durationSource: 'explicit' as const } : {}),
  };
  return { contentVersion: String(product.content_version), fingerprint: product.content_fingerprint,
    revision: String(product.standardization_revision), policyVersion: MEMBERSHIP_POLICY_VERSION,
    ...(product.shop_url !== undefined ? { source: { url: product.shop_url, protocol: product.shop_protocol ?? null, platform: product.shop_platform ?? '' } } : {}),
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
    || !Array.isArray(snapshot.tags) || !snapshot.tags.every(tag => tag && typeof tag.name === 'string' && typeof tag.value === 'string')
    || !Array.isArray(snapshot.rejectedNames) || !MEMBERSHIP_KINDS.includes(snapshot.decision?.kind)
    || !currentMembershipSource(snapshot, product)) return null;
  return snapshot;
}

function currentMembershipSource(snapshot: MembershipFeaturesSnapshot, product: EvidenceVersion): boolean {
  return !snapshot.source || product.shop_url === undefined || (snapshot.source.url === product.shop_url
    && snapshot.source.protocol === (product.shop_protocol ?? null) && snapshot.source.platform === (product.shop_platform ?? ''));
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
    and ${p}.membership_features #>> '{decision,kind}' = any(${[...MEMBERSHIP_KINDS]}::text[])
    and (not (${p}.membership_features ? 'source') or ${p}.membership_features->'source' =
      jsonb_build_object('url', ${sh}.url, 'protocol', ${sh}.protocol, 'platform', ${sh}.platform))
    then ${p}.membership_features #>> '{decision,kind}' else null end`;
}

export function catalogMembershipKind(ai: RawBuilder<boolean>, productAlias = 'p', shopAlias = 'sh'): RawBuilder<MembershipKind | null> {
  return sql<MembershipKind | null>`case when ${ai} then ${currentMembershipKind(productAlias, shopAlias)} end`;
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

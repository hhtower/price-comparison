import { sql, type Transaction } from 'kysely';
import type { DatabaseSchema } from '../database/types.js';
import { canonicalizeMatchText, normalizeProductEvidence, type ProductEvidenceInput } from './fingerprint.js';
import { identityEvidenceConflict, isValidCatalogIdentity, type Identity } from './identity-policy.js';
import { extractServiceEvidence, requiresServiceProviderEvidence } from './service-evidence.js';
import { publicationEvidenceConflict } from './publication-evidence.js';
import { isExcludedApiRelay } from './catalog-exclusion.js';

export interface ConsensusMember extends ProductEvidenceInput {
  readonly id: bigint;
  readonly standardProductId: bigint;
  readonly identity: Identity;
  readonly assignmentSource: string;
  readonly locked: boolean;
  readonly revision: bigint;
  readonly contentVersion: bigint;
  readonly contentFingerprint: string;
}

export interface NameConsensus {
  readonly standardProductId: bigint;
  readonly identity: Identity;
  readonly count: number;
  readonly runnerUpCount: number;
}

/** Short titles (月卡, 季卡, 专业版, etc.) need their full listing context. */
export function nameConsensusKey(input: ProductEvidenceInput): string | null {
  const name = canonicalizeMatchText(input.name);
  if (!name) return null;
  const spec = canonicalizeMatchText(input.spec);
  if (requiresServiceProviderEvidence(input)) {
    const service = extractServiceEvidence(input);
    // Identical generic API copy does not establish an actual shared provider.
    if (!service.endpoints.length && !service.brands.length) return null;
    return JSON.stringify(normalizeProductEvidence({ ...input, name, spec }));
  }
  return Array.from(name).length <= 12
    ? JSON.stringify(normalizeProductEvidence({ ...input, name, spec }))
    : JSON.stringify([name, spec]);
}

/** Each live raw product gets one vote; ties never depend on IDs or row order. */
export function chooseNameConsensus(members: readonly ConsensusMember[], keyFor: (input: ProductEvidenceInput) => string | null = nameConsensusKey): ReadonlyMap<string, NameConsensus> {
  const groups = new Map<string, Map<bigint, { identity: Identity; ids: Set<bigint> }>>();
  for (const member of members) {
    const key = keyFor(member);
    if (!key) continue;
    const votes = groups.get(key) ?? new Map<bigint, { identity: Identity; ids: Set<bigint> }>();
    const vote = votes.get(member.standardProductId) ?? { identity: member.identity, ids: new Set<bigint>() };
    vote.ids.add(member.id);
    votes.set(member.standardProductId, vote);
    groups.set(key, votes);
  }
  const result = new Map<string, NameConsensus>();
  for (const [key, votes] of groups) {
    const ranked = [...votes].sort((a, b) => b[1].ids.size - a[1].ids.size);
    const [id, first] = ranked[0]!;
    const runnerUpCount = ranked[1]?.[1].ids.size ?? 0;
    if (first.ids.size === runnerUpCount || !isValidCatalogIdentity(first.identity)) continue;
    result.set(key, { standardProductId: id, identity: first.identity, count: first.ids.size, runnerUpCount });
  }
  return result;
}

export function compatibleNameConsensus(input: ProductEvidenceInput, winners: ReadonlyMap<string, NameConsensus>): NameConsensus | undefined {
  const key = nameConsensusKey(input);
  const winner = key ? winners.get(key) : undefined;
  const evidence = {
    name: input.name, spec: input.spec, category: input.sourceCategory, sourceData: input.sourceData,
  };
  if (!winner || identityEvidenceConflict(winner.identity, evidence) || publicationEvidenceConflict(evidence)
    || isExcludedApiRelay(evidence)) return undefined;
  return winner;
}

// Kept identical to the expression index in migration 033.
const normalizedName = sql<string>`lower(btrim(regexp_replace(normalize(p.name, NFKC), '[[:space:]]+', ' ', 'g')))`;

/** Read only active, published memberships, independent of offers or stock. */
export async function readNameConsensusMembers(tx: Transaction<DatabaseSchema>, names?: readonly string[]): Promise<ConsensusMember[]> {
  if (names?.length === 0) return [];
  const rows = await tx.selectFrom('products as p')
    .innerJoin('shops as s', 's.id', 'p.shop_id')
    .innerJoin('standard_product_members as m', 'm.product_id', 'p.id')
    .innerJoin('standard_products as sp', 'sp.id', 'm.standard_product_id')
    .select(['p.id', 'p.name', 'p.spec', 'p.source_category', 'p.standardization_locked', 'p.standardization_revision', 'p.content_version', 'p.content_fingerprint',
      'm.standard_product_id', 'm.assignment_source', 'sp.canonical_family', 'sp.canonical_product', 'sp.canonical_tier',
      // Service identity can change without changing a long title. Voting must
      // receive the actual evidence, including endpoints buried in descriptions.
      'p.source_data'])
    .where('p.deleted_at', 'is', null).where('s.deleted_at', 'is', null).where('s.enabled', '=', true)
    .where('m.publication_state', '=', 'published').where('sp.verification_state', '=', 'verified').where('sp.merged_into_id', 'is', null)
    .$if(names !== undefined, query => query.where(normalizedName, 'in', [...new Set(names!.map(canonicalizeMatchText))]))
    .orderBy('p.id').execute();
  return rows.map(row => ({
    id: row.id, name: row.name, spec: row.spec, sourceCategory: row.source_category, sourceData: row.source_data,
    standardProductId: row.standard_product_id, assignmentSource: row.assignment_source, locked: row.standardization_locked,
    revision: row.standardization_revision, contentVersion: row.content_version, contentFingerprint: row.content_fingerprint,
    identity: { family: row.canonical_family ?? '', product: row.canonical_product ?? '', tier: row.canonical_tier ?? '' },
  }));
}

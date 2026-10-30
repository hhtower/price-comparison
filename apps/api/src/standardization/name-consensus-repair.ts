import { sql, type Kysely, type Transaction } from 'kysely';
import type { DatabaseSchema } from '../database/types.js';
import { bumpCatalogVersion, recordCandidateCatalogChanges } from '../catalog/catalog-version.repository.js';
import { assessProductEvidence, isValidCatalogIdentity, IDENTITY_POLICY_VERSION } from './identity-policy.js';
import { buildCanonicalStandardKey } from './canonical-key.js';
import { isManualDecisionForCurrentEvidence, readLatestManualDecisions } from './decision-history.js';
import { chooseNameConsensus, compatibleNameConsensus, nameConsensusKey, readNameConsensusMembers } from './name-consensus.js';
import { publicationEvidenceConflict } from './publication-evidence.js';
import { isExcludedApiRelay } from './catalog-exclusion.js';
import { hasActiveStandardizationWork } from '../ai/product-standardization-state.js';

// Prefer a current reviewed membership source, then the latest current result.
const hasProtectedStandardization = sql<boolean>`(${hasActiveStandardizationWork} or exists (
  select 1 from (
    select r.decision, batch.reference_snapshot->>'standardizationStage' as stage,
      source_job.job_type <> 'tag_extraction' and coalesce(source_job.pipeline_versions->>'standardizationReviewPrompt', '') <> '' as review_pipeline
    from ai_standardization_results r join ai_jobs source_job on source_job.id = r.job_id
    join ai_job_input_members input on input.job_id = r.job_id and input.product_id = r.product_id
    left join ai_job_batches batch on batch.id = r.batch_id
    left join standard_product_members assignment on assignment.product_id = r.product_id
    where r.product_id = p.id and r.content_version = p.content_version
      and input.content_version = p.content_version and input.standardization_revision = p.standardization_revision
      and r.fingerprint = p.content_fingerprint and input.fingerprint = p.content_fingerprint
    order by case when r.job_id = assignment.decision_version and jsonb_typeof(r.decision #> '{review,approved}') = 'boolean' then 0 else 1 end,
      r.job_id desc limit 1
  ) latest where jsonb_typeof(latest.decision #> '{review,approved}') = 'boolean' or latest.stage = 'review' or latest.review_pipeline
))`;

export interface NameConsensusChange {
  productId: bigint;
  name: string;
  fromStandardProductId: bigint | null;
  toStandardProductId: bigint;
  winningCount: number;
  runnerUpCount: number;
  previousRevision: bigint;
  contentVersion: bigint;
  method: 'same_name_majority' | 'identity_rule';
  previousAssignmentSource: string | null;
  locked: boolean;
}

export interface NameConsensusRepairPlan {
  rule: 'same_name_majority_v1';
  conflictGroups: number;
  tiedGroups: number;
  protectedProducts: number;
  evidenceConflicts: number;
  unassignedProducts: number;
  unresolvedProducts: number;
  changes: NameConsensusChange[];
}

async function planRepair(tx: Transaction<DatabaseSchema>): Promise<NameConsensusRepairPlan> {
  const members = await readNameConsensusMembers(tx);
  const manualDecisions = await readLatestManualDecisions(tx, members.map(member => member.id));
  const protectedMemberIds = new Set(members.length ? (await tx.selectFrom('products as p').select('p.id')
    .where('p.id', 'in', members.map(member => member.id)).where(hasProtectedStandardization).execute())
    .map(product => product.id) : []);
  const winners = chooseNameConsensus(members);
  const counts = new Map<string, Map<bigint, number>>();
  for (const member of members) {
    const key = nameConsensusKey(member);
    if (!key) continue;
    const group = counts.get(key) ?? new Map<bigint, number>();
    group.set(member.standardProductId, (group.get(member.standardProductId) ?? 0) + 1);
    counts.set(key, group);
  }
  const conflicts = [...counts.values()].filter(group => group.size > 1);
  const plan: NameConsensusRepairPlan = { rule: 'same_name_majority_v1', conflictGroups: conflicts.length,
    tiedGroups: conflicts.filter(group => { const ranked = [...group.values()].sort((a, b) => b - a); return ranked[0] === ranked[1]; }).length,
    protectedProducts: 0, evidenceConflicts: 0, unassignedProducts: 0, unresolvedProducts: 0, changes: [] };
  const candidates = members.filter(member => {
    const key = nameConsensusKey(member);
    const winner = key ? winners.get(key) : undefined;
    if (!winner || winner.standardProductId === member.standardProductId) return false;
    const manual = manualDecisions.get(member.id);
    if (protectedMemberIds.has(member.id) || member.locked || isManualDecisionForCurrentEvidence(manual, { content_version: member.contentVersion, content_fingerprint: member.contentFingerprint })
      || (member.assignmentSource === 'human' && (!manual || !manual.evidence_known))) {
      plan.protectedProducts++; return false;
    }
    return true;
  });
  for (const member of candidates) {
    const winner = compatibleNameConsensus(member, winners);
    if (!winner) { plan.evidenceConflicts++; continue; }
    plan.changes.push({ productId: member.id, name: member.name, fromStandardProductId: member.standardProductId,
      toStandardProductId: winner.standardProductId, winningCount: winner.count, runnerUpCount: winner.runnerUpCount,
      previousRevision: member.revision, contentVersion: member.contentVersion, method: 'same_name_majority',
      previousAssignmentSource: member.assignmentSource, locked: member.locked });
  }
  const standards = await tx.selectFrom('standard_products').select(['id', 'canonical_family', 'canonical_product', 'canonical_tier'])
    .where('verification_state', '=', 'verified').where('merged_into_id', 'is', null).execute();
  const byIdentity = new Map<string, bigint[]>();
  for (const standard of standards) {
    const identity = { family: standard.canonical_family ?? '', product: standard.canonical_product ?? '', tier: standard.canonical_tier ?? '' };
    if (!isValidCatalogIdentity(identity)) continue;
    const key = buildCanonicalStandardKey(identity);
    byIdentity.set(key, [...(byIdentity.get(key) ?? []), standard.id]);
  }
  const unassigned = await tx.selectFrom('products as p').innerJoin('shops as s', 's.id', 'p.shop_id')
    .select(['p.id', 'p.name', 'p.spec', 'p.source_category', 'p.source_data', 'p.standardization_revision', 'p.content_version', 'p.content_fingerprint', 'p.standardization_locked'])
    .where('p.deleted_at', 'is', null).where('s.deleted_at', 'is', null).where('s.enabled', '=', true)
    .where(sql<boolean>`not ${hasProtectedStandardization}`)
    .where(sql<boolean>`not exists (select 1 from standard_product_members m where m.product_id = p.id)`).orderBy('p.id').execute();
  plan.unassignedProducts = unassigned.length;
  const unassignedDecisions = await readLatestManualDecisions(tx, unassigned.map(product => product.id));
  for (const product of unassigned) {
    const evidence = { name: product.name, spec: product.spec, sourceCategory: product.source_category, sourceData: product.source_data };
    if (product.standardization_locked || isManualDecisionForCurrentEvidence(unassignedDecisions.get(product.id), { content_version: product.content_version, content_fingerprint: product.content_fingerprint })) {
      plan.protectedProducts++; continue;
    }
    if (publicationEvidenceConflict(evidence) || isExcludedApiRelay(evidence)) { plan.evidenceConflicts++; continue; }
    const winner = compatibleNameConsensus(evidence, winners);
    const identity = winner ? undefined : assessProductEvidence({ name: product.name, spec: product.spec, category: product.source_category, sourceData: product.source_data }).identity;
    const matches = identity ? byIdentity.get(buildCanonicalStandardKey(identity)) : undefined;
    const target = winner?.standardProductId ?? (matches?.length === 1 ? matches[0] : undefined);
    if (!target) { plan.unresolvedProducts++; continue; }
    plan.changes.push({ productId: product.id, name: product.name, fromStandardProductId: null, toStandardProductId: target,
      winningCount: winner?.count ?? 0, runnerUpCount: winner?.runnerUpCount ?? 0,
      previousRevision: product.standardization_revision, contentVersion: product.content_version,
      method: winner ? 'same_name_majority' : 'identity_rule', previousAssignmentSource: null, locked: product.standardization_locked });
  }
  return plan;
}

type RepairOptions = { apply?: false } | { apply: true; beforeApply: (plan: NameConsensusRepairPlan) => Promise<void> };

/** A serializable transaction aborts concurrent changes instead of overwriting them. */
export async function reconcileNameConsensus(database: Kysely<DatabaseSchema>, options: RepairOptions = {}): Promise<NameConsensusRepairPlan> {
  const preview = await database.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute(planRepair);
  if (!options.apply || !preview.changes.length) return preview;

  return database.transaction().setIsolationLevel('serializable').execute(async tx => {
    // Live crawler/publication writes also advance the shared cache versions.
    // Acquire all maintenance locks before taking a snapshot; ordinary reads
    // remain available, and an existing writer makes this fail immediately.
    await sql`lock table shops, products, standard_products, standard_product_members,
      catalog_cache_versions, standardization_catalog_versions, catalog_index_changes
      in exclusive mode nowait`.execute(tx);
    const plan = await planRepair(tx);
    if (!plan.changes.length) return plan;
    const standardIds = [...new Set(plan.changes.flatMap(change => change.fromStandardProductId === null ? [change.toStandardProductId] : [change.fromStandardProductId, change.toStandardProductId]))];
    await tx.selectFrom('standard_products').select('id').where('id', 'in', standardIds).orderBy('id').forUpdate().execute();
    // Do not hold all product descriptions in the backup; only membership and
    // revision change. A failed backup must abort before any mutation.
    await options.beforeApply(plan);
    await tx.selectFrom('products').select('id').where('id', 'in', plan.changes.map(change => change.productId)).orderBy('id').forUpdate().execute();
    for (let offset = 0; offset < plan.changes.length; offset += 200) {
      const batch = plan.changes.slice(offset, offset + 200);
      const values = sql.join(batch.map(change => sql`(${change.productId}::bigint, ${change.fromStandardProductId}::bigint,
        ${change.toStandardProductId}::bigint, ${change.previousRevision}::bigint, ${change.contentVersion}::bigint)`));
      const updated = await sql<{ id: bigint }>`update products p set standardization_revision = p.standardization_revision + 1
        from (values ${values}) v(id, source, target, revision, content_version)
        where p.id = v.id and p.standardization_revision = v.revision and p.content_version = v.content_version
          and p.deleted_at is null returning p.id`.execute(tx);
      if (updated.rows.length !== batch.length) throw new Error('Products changed during consensus repair');
      const moved = await sql<{ product_id: bigint }>`update standard_product_members m set standard_product_id = v.target
        from (values ${values}) v(id, source, target, revision, content_version)
        where m.product_id = v.id and m.standard_product_id = v.source
          and m.publication_state = 'published' returning m.product_id`.execute(tx);
      const additions = batch.filter(change => change.fromStandardProductId === null);
      if (moved.rows.length !== batch.length - additions.length) throw new Error('Memberships changed during consensus repair');
      if (additions.length) await tx.insertInto('standard_product_members').values(additions.map(change => ({
        product_id: change.productId, standard_product_id: change.toStandardProductId, publication_state: 'published' as const,
        assignment_source: change.method === 'identity_rule' ? 'rule' : 'consensus', decision_version: 0n,
      }))).execute();
    }
    await bumpCatalogVersion(tx);
    await recordCandidateCatalogChanges(tx, standardIds, IDENTITY_POLICY_VERSION);
    return plan;
  });
}

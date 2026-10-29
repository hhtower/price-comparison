import { sql, type Kysely, type Selectable } from 'kysely';
import { jsonb, type DatabaseSchema, type JsonValue, type ManualStandardizationAction, type ProductStandardizationDecisionTable } from '../database/types.js';
import { normalizeProductEvidence } from './fingerprint.js';
import { sanitizeEvidenceText } from './service-evidence.js';
import { establishReviewedServiceEvidence } from './provider-publication.js';
import { DomainValidationError } from '../common/errors.js';
import { publicationEvidenceConflict } from './publication-evidence.js';

export type ManualDecision = Selectable<ProductStandardizationDecisionTable>;

export async function readLatestManualDecisions(database: Kysely<DatabaseSchema>, productIds: readonly bigint[]): Promise<Map<bigint, ManualDecision>> {
  if (!productIds.length) return new Map();
  const rows = await database.selectFrom('product_standardization_decisions').selectAll().distinctOn('product_id')
    .where('product_id', 'in', [...new Set(productIds)]).orderBy('product_id').orderBy('id', 'desc').execute();
  return new Map(rows.map(row => [row.product_id, row]));
}

export function isManualDecisionForCurrentEvidence(decision: ManualDecision | undefined, current: { content_version: bigint; content_fingerprint: string }): boolean {
  return decision !== undefined && decision.content_version !== null && decision.content_fingerprint !== null
    && decision.content_version === current.content_version && decision.content_fingerprint === current.content_fingerprint;
}

/** Caller must own a transaction. Suppression only covers rows whose application
 * decision is recorded atomically, or whose membership is invalidated by new evidence. */
export async function suppressManualDecisionTrigger(database: Kysely<DatabaseSchema>, productIds: readonly bigint[]): Promise<void> {
  if (!productIds.length) return;
  await sql`select set_config('app.manual_decision_suppressed_products',
    (coalesce(nullif(current_setting('app.manual_decision_suppressed_products', true),''),'[]')::jsonb || ${JSON.stringify(productIds.map(String))}::jsonb)::text, true)`.execute(database);
}

export async function recordManualDecisions(database: Kysely<DatabaseSchema>, productIds: readonly bigint[], decision: {
  action: ManualStandardizationAction; standardProductId: bigint | null; reason: string; allowEvidenceConflict?: boolean;
}): Promise<void> {
  if (!productIds.length) return;
  const ids = [...new Set(productIds)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const products = await database.selectFrom('products').selectAll().where('id', 'in', ids).orderBy('id').forUpdate().execute();
  if (products.length !== ids.length) throw new Error('Manual decision products changed before review');
  if (decision.standardProductId !== null && ['assign', 'merge'].includes(decision.action) && !decision.allowEvidenceConflict) {
    for (const product of products) {
      const conflict = publicationEvidenceConflict({ name: product.name, spec: product.spec, sourceData: product.source_data });
      if (conflict) throw new DomainValidationError('CATALOG_PUBLICATION_BLOCKED', conflict);
    }
  }
  const memberships = await database.selectFrom('standard_product_members').select(['product_id', 'standard_product_id']).where('product_id', 'in', ids).execute();
  const previous = new Map(memberships.map(row => [row.product_id, row.standard_product_id]));
  if (decision.action === 'assign' && decision.standardProductId !== null) await establishReviewedServiceEvidence(database, decision.standardProductId, products.map(product => ({ name: product.name, spec: product.spec, sourceCategory: product.source_category, sourceData: product.source_data })), decision.allowEvidenceConflict);
  const target = decision.standardProductId === null ? undefined : await database.selectFrom('standard_products')
    .select(['canonical_family', 'canonical_product', 'canonical_tier', 'standard_key', 'service_evidence']).where('id', '=', decision.standardProductId).executeTakeFirstOrThrow();
  const targetSnapshot = target ? { family: target.canonical_family, product: target.canonical_product, tier: target.canonical_tier, standardKey: target.standard_key, serviceEvidence: target.service_evidence } : null;
  const reason = sanitizeEvidenceText(decision.reason).replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, 2000);
  if (!reason) throw new Error('Manual decisions require a reason');
  const evidenceById = new Map(products.map(product => [product.id, normalizeProductEvidence({ name: product.name, spec: product.spec, sourceCategory: product.source_category, sourceData: product.source_data })]));
  await database.updateTable('products').set({ standardization_revision: sql`standardization_revision + 1`, updated_at: new Date() }).where('id', 'in', ids).execute();
  await database.insertInto('product_standardization_decisions').values(products.map(product => ({
    product_id: product.id, action: decision.action, standard_product_id: decision.standardProductId, previous_standard_product_id: previous.get(product.id) ?? null,
    target_snapshot: targetSnapshot === null ? null : jsonb(targetSnapshot), content_version: product.content_version, content_fingerprint: product.content_fingerprint,
    standardization_revision: product.standardization_revision + 1n, evidence_known: true,
    evidence_snapshot: jsonb(evidenceById.get(product.id)! as unknown as JsonValue),
    reason, source: 'application' as const,
  }))).execute();
  await suppressManualDecisionTrigger(database, ids);
}

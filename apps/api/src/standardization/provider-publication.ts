import type { Kysely } from 'kysely';
import { jsonb, type DatabaseSchema, type JsonValue } from '../database/types.js';
import { canonicalizeMatchText, type ProductEvidenceInput } from './fingerprint.js';
import { extractServiceEvidence, type ServiceEvidence } from './service-evidence.js';
import { DomainConflictError } from '../common/errors.js';
import { saleEvidenceView } from './sale-evidence.js';
import { assessProductEvidence } from './identity-policy.js';
import { isExcludedApiRelay } from './catalog-exclusion.js';

export interface StandardServiceEvidence extends ServiceEvidence { state: 'verified' | 'unknown' | 'conflict'; source: 'publication' | 'migration' | 'manual' }

/** SMS transport, mailbox retrieval and sold tutorials are not model relays. */
function serviceSaleTitle(input: ProductEvidenceInput): string {
  const sale = saleEvidenceView({ name: input.name, spec: input.spec });
  return canonicalizeMatchText(`${sale.name ?? ''} ${sale.spec ?? ''}`);
}
function isNonRelaySaleObject(input: ProductEvidenceInput): boolean {
  if (!isExcludedApiRelay({ name: input.name, spec: input.spec, sourceData: input.sourceData })
    && assessProductEvidence({ name: input.name, spec: input.spec, sourceData: input.sourceData }).kind === 'account') return true;
  return /接[码马]|短信|邮箱|邮件|教程|教学|(?<![a-z])(?:sms|gmail|icloud|outlook|hotmail|email|tutorial|pdf)(?![a-z])/u.test(serviceSaleTitle(input));
}
export function isModelApiRelayEvidence(input: ProductEvidenceInput): boolean {
  const title = serviceSaleTitle(input);
  if (isNonRelaySaleObject(input)) return false;
  return /(?<![a-z])api(?![a-z])|中转站|模型中转/u.test(title) || extractServiceEvidence(input).endpoints.length > 0;
}

export function serviceProviderCompatible(left: ServiceEvidence, right: ServiceEvidence): boolean {
  const equal = (a: string[], b: string[]) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
  if (left.endpoints.length || right.endpoints.length) return left.endpoints.length > 0 && right.endpoints.length > 0 && equal(left.endpoints, right.endpoints);
  return left.brands.length > 0 && right.brands.length > 0 && equal(left.brands.map(canonicalizeMatchText), right.brands.map(canonicalizeMatchText));
}

/** Run before canonical target creation so unsupported API claims create no keys. */
export function serviceEvidenceRequirement(input: ProductEvidenceInput): string | null {
  if (!isModelApiRelayEvidence(input)) return null;
  const incoming = extractServiceEvidence(input);
  return incoming.endpoints.length || incoming.brands.length ? null : 'service_provider_missing';
}

/** A reviewed batch may establish a new empty target, but never rewrites an
 * established or unknown legacy provider. The caller records its review atomically. */
export async function establishReviewedServiceEvidence(database: Kysely<DatabaseSchema>, standardProductId: bigint, inputs: readonly ProductEvidenceInput[], allowConflict = false): Promise<void> {
  if (!inputs.some(isModelApiRelayEvidence)) return;
  const target = await database.selectFrom('standard_products').select('service_evidence').where('id', '=', standardProductId).forUpdate().executeTakeFirstOrThrow();
  if (!target.service_evidence || typeof target.service_evidence !== 'object' || Array.isArray(target.service_evidence) || Object.keys(target.service_evidence).length) return;
  if (await database.selectFrom('standard_product_members').select('product_id').where('standard_product_id', '=', standardProductId).limit(1).executeTakeFirst()) return;
  const providers = inputs.map(extractServiceEvidence);
  const first = providers[0];
  if (!first || !inputs.every(isModelApiRelayEvidence) || providers.some(provider => !provider.endpoints.length && !provider.brands.length)) return;
  // A confirmed admin batch still binds; the target just keeps no provider profile instead of guessing one.
  if (providers.some(provider => !serviceProviderCompatible(first, provider))) {
    if (allowConflict) return;
    throw new DomainConflictError('SERVICE_PROVIDER_CONFLICT', '批量审核的服务商证据冲突，确认后可继续');
  }
  await database.updateTable('standard_products').set({ service_evidence: jsonb({ ...first, state: 'verified', source: 'manual' }) }).where('id', '=', standardProductId).execute();
}

/** A target's provider is durable catalog identity, not whatever its last raw
 * member happens to sell today. The caller owns the publication transaction. */
export async function ensureStandardServiceEvidence(database: Kysely<DatabaseSchema>, standardProductId: bigint, input: ProductEvidenceInput): Promise<string | null> {
  const target = await database.selectFrom('standard_products').select(['id', 'canonical_family', 'canonical_product', 'canonical_tier', 'service_evidence'])
    .where('id', '=', standardProductId).forUpdate().executeTakeFirst();
  if (!target) return 'standard_product_missing';
  const stored = target.service_evidence && typeof target.service_evidence === 'object' && !Array.isArray(target.service_evidence) ? target.service_evidence : {};
  const saved = extractServiceEvidence({ serviceEvidence: stored });
  // A durable provider profile is identity evidence in its own right; neither
  // a generic canonical spelling nor incidental tutorial text can bypass it.
  const targetIsRelay = stored.state === 'verified' || saved.endpoints.length > 0 || saved.brands.length > 0
    || isModelApiRelayEvidence({ name: `${target.canonical_family ?? ''} ${target.canonical_product ?? ''}` });
  if (!isModelApiRelayEvidence(input) && !targetIsRelay) return null;
  if (isNonRelaySaleObject(input)) return 'service_sale_object_conflict';
  const incoming = extractServiceEvidence(input);
  if (!incoming.endpoints.length && !incoming.brands.length) return 'service_provider_missing';
  if (stored.state === 'unknown' || stored.state === 'conflict') return 'target_service_provider_unknown';
  if (saved.endpoints.length || saved.brands.length) return serviceProviderCompatible(saved, incoming) ? null : 'service_provider_conflict';
  // Legacy targets with members cannot acquire an identity merely from the next
  // model response. The migration backfills only unambiguous current evidence.
  const existing = await database.selectFrom('standard_product_members').select('product_id').where('standard_product_id', '=', standardProductId).limit(1).executeTakeFirst();
  if (existing) return 'target_service_provider_unknown';
  const snapshot: StandardServiceEvidence = { ...incoming, state: 'verified', source: 'publication' };
  await database.updateTable('standard_products').set({ service_evidence: jsonb(snapshot as unknown as JsonValue) }).where('id', '=', standardProductId).execute();
  return null;
}

import { normalizePageRequest, buildCursorPage } from '../common/pagination.js';
import { previewTagJob, createManualTagJob, prepareAllPendingTagJob, type TagJobScope, type TagJobRequest } from './tag-extraction-jobs.js';
import { sanitizeTagAuditText, buildTagExtractionOutcome, tagExtractionVersions, validateTagExtractionDecision, validateReviewedTagExtractionDecision, type TagExtractionDecision } from './tag-extraction-result.js';
import { projectShopText, readTextEvidence, TEXT_REVIEW_VERSION } from '../shops/shop-text-review.js';
import type { StandardizationTag } from './ai.schemas.js';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { canonicalProductDisplayName } from '@price-comparison/catalog/catalog-display';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { Pool } from 'pg';
import { PgNotifications } from '../database/pg-notifications.js';
import { DATABASE, PG_POOL } from '../database/database.providers.js';
import { bumpCatalogVersion, recordCandidateCatalogChanges } from '../catalog/catalog-version.repository.js';
import { DomainConflictError, DomainNotFoundError, DomainValidationError } from '../common/errors.js';
import { jsonb, type DatabaseSchema, type JsonValue, type AiJobTable } from '../database/types.js';
import { type ParsedStandardizationResponse, type StandardizationDecision } from './ai.schemas.js';
import { buildCandidateSearchQuery, buildExtractionPayload, estimateInputSize, extractionPayloadKey } from './adaptive-batching.js';
import { planIndependentStandardizationBatches } from './standardization-batch-planner.js';
import { readAiBatchLimits } from '../config/env.js';
import { extractionProgressDelta, getJobProgress, incrementJobProgress, type ProgressSnapshot } from './ai-progress.repository.js';
import { readLatestManualDecisions, isManualDecisionForCurrentEvidence, type ManualDecision } from '../standardization/decision-history.js';
import { resolveCanonicalIdentity } from '../standardization/canonical-resolution.js';
import { loadCandidateDisplayNames, loadCatalogAliases } from '../standardization/catalog-aliases.js';
import { ensureStandardServiceEvidence, serviceEvidenceRequirement } from '../standardization/provider-publication.js';
import { canonicalizeMatchText } from '../standardization/canonical-key.js';
import { API_RELAY_EXCLUSION_REASON, isExcludedApiRelay } from '../standardization/catalog-exclusion.js';
import { IDENTITY_POLICY_VERSION, normalizeIdentity, type Identity } from '../standardization/identity-policy.js';
import { assertCurrentPipeline, isCurrentPipeline, pipelineVersionSnapshot, PIPELINE_VERSIONS } from './pipeline-versions.js';
import { STANDARDIZATION_PROMPT_VERSION, readStandardizationRequestLimits, assertStandardizationRequestFits } from './standardization-request.js';
import { buildTagExtractionRequest } from './tag-extraction-request.js';
import { buildTagReviewRequest } from './tag-review-request.js';
import { planTagReviewRequests } from './tag-review-planner.js';
import { buildStandardizationReviewRequest, isReviewableStandardizationDecision, parseStandardizationReviewResponse, planStandardizationReviewRequests } from './standardization-review-request.js';
import { validateStandardizationEvidence } from './standardization-evidence.js';
import { planStandardizationRequests } from './standardization-request-planner.js';
import type { CandidateDocument } from '../standardization/candidate-index.js';
import {
  VersionedCandidateIndex,
  type CatalogIndexChange,
} from '../standardization/versioned-candidate-index.js';
import { planPublicationUnits, type PublicationMember } from './publication-planner.js';
import { finalizeOrScheduleMissing } from './standardization-finalizer.js';
import { readAiStandardizationRuntimeStatus } from './ai-standardization-features.js';
import { unknownRequestReason } from './request-outcome.js';
import { readAiConcurrency } from './ai-concurrency.js';
import { currentManualDecision, readRetryPool, retryPoolQuery } from './ai-retry-pool.js';
import { hasActiveStandardizationWork, hasCurrentStandardizationResult, hasManualIsolation, hasPublishedAssignment, productProcessingDisposition } from './product-standardization-state.js';
import { readAiTaskQueue, type TaskQueueFilter } from './ai-task-queue.js';
import type { ResponseDiagnostic } from './response-audit.js';
export interface CreateJobInput { model: string; batchSize?: number; scopeShopId?: bigint | null; sourceFetchRunId?: bigint | null; productIds?: readonly bigint[]; jobType?: 'incremental' | 'manual_full'; triggerEventId?: bigint | null; sourceEvents?: readonly { productId: bigint; eventId: bigint }[]; priority?: number; }
export interface CreatedJob extends Selectable<AiJobTable> { inputs: Array<{ productId: bigint; fingerprint: string }>; batches: Array<{ id: bigint; productIds: bigint[] }>; }
export interface JobProgressEvent { id: string; type: 'progress' | 'keepalive'; data: ProgressSnapshot | null; }
export interface KeysetPage<T> { items: T[]; nextCursor: string | null; total?: number; }
export interface StandardProductSummary extends Record<string, unknown> { standardProductKey: string | null; }
export interface ReviewProduct extends Record<string, unknown> { productId: string; }
export interface AiBatchResultMetadata { firstContentMs?: number | null; responseMs?: number | null; outputBytes?: number; retryClass?: string | null;
  responseDiagnostic?: ResponseDiagnostic;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number; reasoningTokens?: number } | null; responseModel?: string | null; responseId?: string | null; }
export interface FrozenBatchReference {
  readonly standardizationStage?: 'review';
  readonly generationBatchId?: string;
  readonly strategyVersion: 'bounded-candidate-v1' | 'evidence-canonical-candidate-v2';
  readonly catalogVersion: string;
  readonly inputs: ReadonlyArray<{
    readonly id: string;
    readonly candidateStandardProductIds: readonly string[];
    readonly stats: { readonly scanned: number; readonly compared: number; readonly truncated: boolean };
  }>;
  readonly candidates: readonly CandidateDocument[];
}

export function productFingerprint(product: { content_fingerprint: string }): string {
  return product.content_fingerprint;
}
const DATABASE_BATCH_SIZE = 500;

function previousDecisionContext(decision: ManualDecision | undefined): JsonValue | null {
  if (!decision) return null;
  return { action: decision.action, contentVersion: decision.content_version?.toString() ?? null,
    fingerprint: decision.content_fingerprint, evidenceKnown: decision.evidence_known,
    targetIdentity: decision.target_snapshot, reviewedAt: decision.created_at.toISOString(),
    scope: 'historical_evidence_only', reason: decision.reason.slice(0, 500) };
}

function chunks<T>(items: readonly T[], size = DATABASE_BATCH_SIZE): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    result.push(items.slice(offset, offset + size));
  }
  return result;
}

function candidateDocument(value: JsonValue | null): CandidateDocument {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('candidate catalog upsert document is invalid');
  const document = value as Record<string, JsonValue>;
  if (typeof document.id !== 'string'
    || typeof document.family !== 'string'
    || typeof document.product !== 'string'
    || typeof document.tier !== 'string'
    || !Array.isArray(document.aliases)
    || !document.aliases.every(alias => typeof alias === 'string')) {
    throw new Error('candidate catalog upsert document is invalid');
  }
  return {
    id: document.id,
    family: document.family,
    product: document.product,
    tier: document.tier,
    ...(typeof document.displayName === 'string' ? { displayName: document.displayName } : {}),
    aliases: document.aliases,
  };
}

function missingDecision(id: string): StandardizationDecision {
  return {
    id,
    status: 'unclassified',
    ruleIds: [],
    evidence: [],
    reasonCode: 'missing_id',
    reason: '模型响应未包含该商品',
  };
}

function publicationTooLargeDecision(id: string): StandardizationDecision {
  return {
    id,
    status: 'unclassified',
    ruleIds: [],
    evidence: [],
    reasonCode: 'publication_too_large',
    reason: '单个商品的发布负载超过本地安全预算',
  };
}

function publicationMembers(
  members: readonly { product_id: bigint; input_id: bigint }[],
  decision: ParsedStandardizationResponse,
): PublicationMember[] {
  const decisions = new Map(decision.items.map(item => [item.id, item]));
  for (const id of decision.missingIds) decisions.set(id, missingDecision(id));
  return members.map(member => {
    const item = decisions.get(member.input_id.toString()) ?? missingDecision(member.input_id.toString());
    return {
      productId: member.product_id,
      inputId: member.input_id,
      tags: [],
      payload: { productId: member.product_id.toString(), inputId: member.input_id.toString(), decision: item },
    };
  });
}

@Injectable()
export class AiRepository {
  private candidateCatalog?: {
    readonly version: bigint;
    readonly aliasPolicyVersion: string;
    readonly index: VersionedCandidateIndex;
  };

  constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>, @Optional() @Inject(PG_POOL) private readonly pool?: Pool) {}

  /** Preview by default; applying uses the same transactional task creation as manual runs. */
  async backfillMissingResults(input: { model: string; apply?: boolean }) {
    return this.database.transaction().execute(async tx => {
      if (input.apply) await sql`select pg_advisory_xact_lock(hashtextextended('ai-missing-results', 0))`.execute(tx);
      const rows = await tx.selectFrom('products as p').innerJoin('shops as s', 's.id', 'p.shop_id')
        .select(['p.id', 'p.name', 'p.spec', 'p.source_category', 'p.source_data'])
        .where('p.deleted_at', 'is', null).where('s.deleted_at', 'is', null).where('s.enabled', '=', true)
        .where('p.standardization_locked', '=', false)
        .where(sql<boolean>`not ${currentManualDecision}`)
        .where(sql<boolean>`not ${hasPublishedAssignment()}`)
        .where(sql<boolean>`not ${hasCurrentStandardizationResult()}`)
        .where(sql<boolean>`not ${hasActiveStandardizationWork}`)
        .where(sql<boolean>`not exists (select 1 from standardization_outbox o
          join product_change_events e on e.id = o.event_id where o.product_id = p.id
            and e.content_version = p.content_version and e.fingerprint = p.content_fingerprint
            and o.fingerprint = p.content_fingerprint and o.status in ('queued', 'running'))`)
        .orderBy('p.id').forShare('p').execute();
      const productIds = rows.map(row => row.id);
      const job = input.apply && productIds.length ? await this.createJob({ model: input.model, productIds }, tx) : null;
      return { productIds: productIds.map(String), jobId: job?.id.toString() ?? null };
    });
  }

  async createJob(input: CreateJobInput, transaction?: Transaction<DatabaseSchema>): Promise<CreatedJob> {
    if (!input.model?.trim()) throw new Error('model is required');
    const batchSize = input.batchSize ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error('batchSize must be positive');
    const create = async (tx: Transaction<DatabaseSchema>): Promise<CreatedJob> => {
      // Acquire foreign key locks before fingerprint grouping changes member insertion order.
      const selectedProducts = await tx.selectFrom('products').innerJoin('shops', 'shops.id', 'products.shop_id').select([
        'products.id', 'products.name', 'products.spec', 'products.source_category', 'products.source_data', 'products.standardization_revision', 'products.content_version', 'products.content_fingerprint', 'products.standardization_locked',
      ]).where('products.deleted_at', 'is', null)
        .where('shops.deleted_at', 'is', null).where('shops.enabled', '=', true)
        .$if(input.productIds !== undefined, q => input.productIds!.length ? q.where('products.id', 'in', input.productIds!) : q.where(sql<boolean>`false`))
        .$if(input.scopeShopId != null, (q) => q.where('products.shop_id', '=', input.scopeShopId!)).orderBy('products.id').forKeyShare('products').execute();
      let products = selectedProducts;
      if ((input.jobType ?? 'manual_full') === 'incremental' && products.length) {
        // Compatible FK locks do not serialize execution registration across transactions.
        await sql`select pg_advisory_xact_lock(hashtextextended('ai-registration:' || product_id::text, 0))
          from (select unnest(array[${sql.join(products.map(product => product.id))}]::bigint[]) as product_id order by product_id) locked`.execute(tx);
        const previous = await tx.selectFrom('ai_standardization_executions as e').innerJoin('ai_jobs as j', 'j.id', 'e.job_id')
          .innerJoin('ai_job_input_members as m', join => join.onRef('m.job_id', '=', 'e.job_id').onRef('m.product_id', '=', 'e.product_id'))
          .innerJoin('products as p', 'p.id', 'e.product_id')
          .select(['e.product_id', 'e.content_version', 'e.fingerprint'])
          .where('e.product_id', 'in', products.map(product => product.id))
          .whereRef('m.standardization_revision', '=', 'p.standardization_revision')
          .where(sql<boolean>`j.pipeline_versions @> ${JSON.stringify(PIPELINE_VERSIONS)}::jsonb`)
          .execute();
        const registered = new Set(previous.map(row => `${row.product_id}:${row.content_version}:${row.fingerprint}`));
        products = products.filter(product => !registered.has(`${product.id}:${product.content_version}:${productFingerprint(product)}`));
      }
      const manualDecisions = await readLatestManualDecisions(tx, products.map(product => product.id));
      products = products.filter(product => {
        const decision = manualDecisions.get(product.id);
        return decision?.action !== 'exclude' || !isManualDecisionForCurrentEvidence(decision, { content_version: product.content_version, content_fingerprint: productFingerprint(product) });
      });
      const relayIds = new Set(products.filter(product => isExcludedApiRelay({
        name: product.name, spec: product.spec, category: product.source_category, sourceData: product.source_data,
      })).map(product => product.id));
      const protectedMembers = relayIds.size ? await tx.selectFrom('standard_product_members as m')
        .innerJoin('standard_products as sp', 'sp.id', 'm.standard_product_id')
        .select('m.product_id').where('m.product_id', 'in', [...relayIds])
        .where(eb => eb.or([eb('m.assignment_source', '=', 'human'), eb.and([
          eb('m.publication_state', '=', 'published'), eb('sp.verification_state', '=', 'verified'), eb('sp.merged_into_id', 'is', null),
        ])])).execute() : [];
      const protectedIds = new Set(protectedMembers.map(member => member.product_id));
      products = products.filter(product => !relayIds.has(product.id) || (!product.standardization_locked && !protectedIds.has(product.id)
        && !isManualDecisionForCurrentEvidence(manualDecisions.get(product.id), { content_version: product.content_version, content_fingerprint: productFingerprint(product) })));
      const groups = new Map<string, typeof products>();
      for (const p of products) {
        // Equal current evidence with different review history must not inherit
        // another listing's historical decision through fingerprint deduplication.
        const payload = buildExtractionPayload({ id: p.id.toString(), name: p.name, spec: p.spec, category: p.source_category, sourceData: p.source_data });
        const key = JSON.stringify([productFingerprint(p), extractionPayloadKey(payload), String(manualDecisions.get(p.id)?.id ?? 'none')]);
        const group = groups.get(key) ?? []; group.push(p); groups.set(key, group);
      }
      const unique = [...groups.values()].map(members => ({ product: members[0]!, members, fingerprint: productFingerprint(members[0]!) }));
      const excludedCount = products.filter(product => relayIds.has(product.id)).length;
      const needsModel = unique.some(item => !relayIds.has(item.product.id));
      const sourceEventByProduct = new Map(input.sourceEvents?.map(event => [event.productId, event.eventId]) ?? []);
      const job = await tx.insertInto('ai_jobs').values({
        status: needsModel ? 'queued' : 'succeeded', total: BigInt(products.length), model: input.model.trim(), auto_apply: true,
        processed: BigInt(excludedCount), unclassified: BigInt(excludedCount),
        job_type: input.jobType ?? 'manual_full', trigger_event_id: input.triggerEventId ?? null, priority: input.priority ?? 0,
        source_fetch_run_id: input.sourceFetchRunId ?? null,
        scope_shop_id: input.scopeShopId ?? null, prompt_version: STANDARDIZATION_PROMPT_VERSION, rule_version: IDENTITY_POLICY_VERSION,
        pipeline_versions: jsonb(pipelineVersionSnapshot(input.model.trim())),
        request_window_size: readAiConcurrency(), phase: needsModel ? 'standardizing' : 'completed', finished_at: needsModel ? null : sql`now()`,
      }).returningAll().executeTakeFirstOrThrow();
      await incrementJobProgress(tx, { jobId: job.id, ...extractionProgressDelta('initialize', products.length) });
      if (excludedCount) await incrementJobProgress(tx, { jobId: job.id, queued: -excludedCount, processed: excludedCount, succeeded: excludedCount });
      if (unique.length) {
        const sized = unique.map(({ product: p, members, fingerprint }) => {
          const payload = buildExtractionPayload({ id: p.id.toString(), name: p.name, spec: p.spec, category: p.source_category, sourceData: p.source_data as JsonValue });
          const size = estimateInputSize(payload);
          return { product: p, members, fingerprint, payload, ...size };
        });
        await tx.updateTable('ai_jobs').set({
          input_bytes: BigInt(sized.reduce((sum, item) => sum + item.inputBytes, 0)),
          estimated_tokens: BigInt(sized.reduce((sum, item) => sum + item.estimatedTokens, 0)),
        }).where('id', '=', job.id).execute();
        for (const chunk of chunks(sized)) {
          await tx.insertInto('ai_job_inputs').values(chunk.map(({ product: p, fingerprint, payload, inputBytes, estimatedTokens }) => ({
            job_id: job.id, input_id: p.id, fingerprint, payload: jsonb(payload), input_bytes: BigInt(inputBytes),
            manual_decision_id: manualDecisions.get(p.id)?.id ?? null,
            previous_decision: manualDecisions.has(p.id) ? jsonb(previousDecisionContext(manualDecisions.get(p.id))) : null,
            estimated_tokens: BigInt(estimatedTokens), status: relayIds.has(p.id) ? 'succeeded' as const : 'queued' as const,
            reason_code: relayIds.has(p.id) ? 'not_sellable' : null, round: 0, content_version: p.content_version,
          }))).execute();
        }
        const inputMembers = unique.flatMap(({ product: p, members }) => members.map((member) => {
          const payload = buildExtractionPayload({ id: member.id.toString(), name: member.name, spec: member.spec, category: member.source_category, sourceData: member.source_data as JsonValue });
          return {
            job_id: job.id, input_id: p.id, product_id: member.id, standardization_revision: member.standardization_revision,
            content_version: member.content_version, fingerprint: productFingerprint(member), payload: jsonb(payload),
            status: relayIds.has(member.id) ? 'unclassified' as const : 'queued' as const,
            reason_code: relayIds.has(member.id) ? 'not_sellable' : null,
          };
        }));
        for (const chunk of chunks(inputMembers)) await tx.insertInto('ai_job_input_members').values(chunk).execute();
        for (const chunk of chunks(inputMembers)) {
          const currentVersions = sql.join(chunk.map(member => sql`(${member.product_id}::bigint, ${member.content_version}::bigint)`));
          await sql`
            update ai_standardization_executions as execution
            set status = ${'superseded'}, completed_at = now()
            from (values ${currentVersions}) as current(product_id, content_version)
            where execution.product_id = current.product_id
              and execution.content_version < current.content_version
              and execution.status in ('registered', 'processing')
          `.execute(tx);
        }
        for (const chunk of chunks(inputMembers)) {
          await tx.insertInto('ai_standardization_executions').values(chunk.map(member => ({
            product_id: member.product_id, content_version: member.content_version, fingerprint: member.fingerprint,
            snapshot: member.payload, event_id: sourceEventByProduct.get(member.product_id) ?? null,
            job_id: job.id, input_id: member.input_id, status: relayIds.has(member.product_id) ? 'completed' as const : 'registered' as const,
            completed_at: relayIds.has(member.product_id) ? sql<Date>`now()` : null,
          }))).onConflict(conflict => conflict.columns(['product_id', 'content_version', 'fingerprint']).doUpdateSet(eb => ({
            job_id: eb.ref('excluded.job_id'), input_id: eb.ref('excluded.input_id'), event_id: eb.ref('excluded.event_id'),
            snapshot: eb.ref('excluded.snapshot'), status: eb.ref('excluded.status'), completed_at: eb.ref('excluded.completed_at'),
          })).where(sql<boolean>`not exists (select 1 from ai_jobs previous_job
            join ai_job_input_members previous_member on previous_member.job_id = previous_job.id
              and previous_member.product_id = ai_standardization_executions.product_id
            join products current_product on current_product.id = previous_member.product_id
            where previous_job.id = ai_standardization_executions.job_id
              and previous_member.standardization_revision = current_product.standardization_revision
              and previous_job.pipeline_versions @> ${JSON.stringify(PIPELINE_VERSIONS)}::jsonb)`)).execute();
        }
        for (const chunk of chunks(inputMembers.filter(member => relayIds.has(member.product_id)))) {
          await tx.insertInto('ai_standardization_results').values(chunk.map(member => ({
            job_id: job.id, product_id: member.product_id, batch_id: null, input_id: member.input_id,
            content_version: member.content_version, fingerprint: member.fingerprint, status: 'unclassified' as const,
            standard_product_id: null, tags: jsonb([]), evidence: jsonb([]), reason_code: 'not_sellable', reason: API_RELAY_EXCLUSION_REASON,
            decision: jsonb({ id: String(member.input_id), status: 'unclassified', ruleIds: ['catalog_model_relay_excluded'], evidence: [],
              reasonCode: 'not_sellable', reason: API_RELAY_EXCLUSION_REASON, diagnostic: { stage: 'identity', code: 'deterministic_catalog_exclusion' } }),
            current_assignment_preserved: true, published_at: sql`now()`,
          }))).execute();
        }
        const limits = readAiBatchLimits();
        const maxItems = Math.min(limits.maxItems, batchSize);
        const modelInputs = sized.filter(item => !relayIds.has(item.product.id));
        const planned = planIndependentStandardizationBatches(modelInputs.map(x => ({ productId: x.product.id, payload: x.payload, inputBytes: x.inputBytes, estimatedTokens: x.estimatedTokens })), { ...limits, maxItems });
        const plannedIds = new Set(planned.flatMap((b) => b.productIds));
        const oversized = modelInputs.filter((x) => !plannedIds.has(x.product.id));
        if (oversized.length) {
          const oversizedProductCount = oversized.reduce((count, item) => count + item.members.length, 0);
          const oversizedInputIds = oversized.map(item => item.product.id);
          for (const chunk of chunks(oversizedInputIds)) {
            await tx.updateTable('ai_job_inputs').set({ status: 'failed', error: 'input_too_large', reason_code: 'input_too_large' }).where('job_id', '=', job.id).where('input_id', 'in', chunk).execute();
            await tx.updateTable('ai_job_input_members').set({ status: 'unclassified', reason_code: 'input_too_large' }).where('job_id', '=', job.id).where('input_id', 'in', chunk).execute();
          }
          const oversizedInputIdSet = new Set(oversizedInputIds.map(String));
          const oversizedMembers = inputMembers.filter(member => oversizedInputIdSet.has(member.input_id.toString()));
          const oversizedReason = '商品输入超过单次标准化安全预算';
          for (const chunk of chunks(oversizedMembers)) {
            await tx.insertInto('ai_standardization_results').values(chunk.map(member => ({
              job_id: job.id,
              product_id: member.product_id,
              batch_id: null,
              input_id: member.input_id,
              content_version: member.content_version,
              fingerprint: member.fingerprint,
              status: 'unclassified' as const,
              standard_product_id: null,
              tags: jsonb([]),
              evidence: jsonb([]),
              reason_code: 'input_too_large',
              reason: oversizedReason,
              decision: jsonb({
                id: member.input_id.toString(), status: 'unclassified', ruleIds: [], evidence: [],
                reasonCode: 'input_too_large', reason: oversizedReason,
              }),
              current_assignment_preserved: true,
              published_at: sql`now()`,
            }))).onConflict(conflict => conflict.columns(['job_id', 'product_id']).doNothing()).execute();
          }
          await tx.updateTable('ai_standardization_executions').set({ status: 'completed', completed_at: sql`now()` }).where('job_id', '=', job.id).where('input_id', 'in', oversizedInputIds).execute();
          await tx.updateTable('ai_jobs').set({ unclassified: BigInt(excludedCount + oversizedProductCount), status: planned.length ? 'queued' : 'ready_with_errors', finished_at: planned.length ? null : sql`now()` }).where('id', '=', job.id).execute();
          await incrementJobProgress(tx, { jobId: job.id, ...extractionProgressDelta('oversized', oversizedProductCount) });
        }
        const memberCounts = new Map(unique.map((item) => [item.product.id, item.members.length]));
        const batches: Array<{ job_id: bigint; batch_index: bigint; product_ids: ReturnType<typeof jsonb>; product_count: bigint; input_bytes: bigint; estimated_tokens: bigint; status: 'queued'; round: number; step: 'request'; request_budget_limit: number }> = planned.map((batch, index) => ({ job_id: job.id, batch_index: BigInt(index), product_ids: jsonb(batch.productIds.map(String)), product_count: BigInt(batch.productIds.reduce((count, id) => count + (memberCounts.get(id) ?? 0), 0)), input_bytes: BigInt(batch.inputBytes), estimated_tokens: BigInt(batch.estimatedTokens), status: 'queued', round: 0, step: 'request', request_budget_limit: 2 }));
        const inserted: Array<{ id: bigint; product_ids: JsonValue }> = [];
        for (const chunk of chunks(batches)) inserted.push(...await tx.insertInto('ai_job_batches').values(chunk).returning(['id', 'product_ids']).execute());
        let currentJob = await tx.selectFrom('ai_jobs').selectAll().where('id', '=', job.id).executeTakeFirstOrThrow();
        return { ...currentJob, inputs: unique.map((x) => ({ productId: x.product.id, fingerprint: x.fingerprint })), batches: inserted.map((b) => ({ id: b.id, productIds: (b.product_ids as unknown as string[]).map(BigInt) })) };
      }
      const empty = await tx.selectFrom('ai_jobs').selectAll().where('id', '=', job.id).executeTakeFirstOrThrow();
      return { ...empty, inputs: [], batches: [] };
    };
    return transaction ? create(transaction) : this.database.transaction().execute(create);
  }

  /** Build candidate references outside the queue transaction, then freeze them once. */
  async prepareBatch(batchId: bigint, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const batch = await this.database.selectFrom('ai_job_batches as b')
      .innerJoin('ai_jobs as j', 'j.id', 'b.job_id')
      .select(['b.job_id', 'b.product_ids', 'b.step', 'b.reference_snapshot', 'j.prompt_version', 'j.rule_version', 'j.pipeline_versions', 'j.model', 'j.job_type'])
      .where('b.id', '=', batchId)
      .executeTakeFirstOrThrow();
    assertCurrentPipeline(batch);
    if (batch.rule_version !== IDENTITY_POLICY_VERSION) throw new Error('AI rule version is stale');
    if (batch.step !== 'request') return;

    // Tag requests have no candidate catalog; budget the exact frozen evidence and prompt.
    if (batch.job_type === 'tag_extraction') {
      const { model, stage, proposals, inputs } = await this.getTagExtractionBatchInputs(batchId);
      const payloads = inputs.map(input => ({
        ...(input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? input.payload : {}),
        id: String(input.productId), name: input.name, spec: input.spec, sourceData: input.sourceData,
      }));
      if (stage === 'review' && !proposals) throw new Error('tag review proposals are missing');
      const limits = readStandardizationRequestLimits();
      const request = stage === 'review' ? buildTagReviewRequest(payloads, proposals!, model) : buildTagExtractionRequest(payloads, model);
      if (stage === 'review') {
        const groups = planTagReviewRequests({ model, inputs: payloads, proposals: proposals! }, limits);
        const activeIds = new Set(payloads.map(input => input.id));
        if (groups[0]?.oversized && (batch.product_ids as string[]).some(id => !activeIds.has(id))) {
          // Unavailable inputs must reach reservation's skip guards before any oversized group fails.
          const fitting = groups.findIndex(group => !group.oversized);
          if (fitting >= 0) groups.unshift(groups.splice(fitting, 1)[0]!);
          else {
            const empty = { model, inputs: [], proposals: { items: [] } };
            groups.unshift({ request: empty,
              estimate: assertStandardizationRequestFits(buildTagReviewRequest(empty.inputs, empty.proposals, model), limits),
              oversized: false });
          }
        }
        if (groups.length > 1) {
          const outcome = await this.database.transaction().execute(async tx => {
            const job = await tx.selectFrom('ai_jobs').select(['status', 'pause_requested', 'cancel_requested'])
              .where('id', '=', batch.job_id).forUpdate().executeTakeFirstOrThrow();
            const current = await tx.selectFrom('ai_job_batches').selectAll().where('id', '=', batchId).forUpdate().executeTakeFirstOrThrow();
            if (job.pause_requested || job.cancel_requested || ['paused', 'cancelled', 'failed', 'succeeded'].includes(job.status)
              || current.step !== 'request' || !['queued', 'running'].includes(current.status)
              || JSON.stringify(current.product_ids) !== JSON.stringify(batch.product_ids)
              || JSON.stringify(current.reference_snapshot) !== JSON.stringify(batch.reference_snapshot)) return 'changed';
            if (current.request_budget_used !== 0) return 'reserved';
            signal?.throwIfAborted();
            const reference = current.reference_snapshot as unknown as FrozenBatchReference;
            const members = await tx.selectFrom('ai_job_input_members').select(['input_id', 'payload'])
              .where('job_id', '=', batch.job_id).where('input_id', 'in', (current.product_ids as string[]).map(BigInt)).execute();
            const sizes = new Map(members.map(member => [String(member.input_id), estimateInputSize(member.payload)]));
            for (const input of payloads) sizes.set(input.id, estimateInputSize(input as unknown as JsonValue));
            const plannedIds = new Set(groups.flatMap(group => group.request.inputs.map(input => input.id)));
            const maximum = await tx.selectFrom('ai_job_batches').select(sql<bigint>`coalesce(max(batch_index), -1)`.as('index'))
              .where('job_id', '=', batch.job_id).executeTakeFirstOrThrow();
            let nextIndex = maximum.index;
            for (const [index, group] of groups.entries()) {
              const ids = new Set(group.request.inputs.map(input => input.id));
              // Keep unavailable inputs on the root so reservation can materialize their skips.
              if (index === 0) for (const id of current.product_ids as string[]) if (!plannedIds.has(id)) ids.add(id);
              const references = reference.inputs.filter(input => ids.has(input.id));
              const candidates = new Set(references.flatMap(input => input.candidateStandardProductIds));
              const fields = {
                product_ids: jsonb([...ids]), product_count: BigInt(members.filter(member => ids.has(String(member.input_id))).length),
                input_bytes: BigInt([...ids].reduce((sum, id) => sum + (sizes.get(id)?.inputBytes ?? 0), 0)),
                estimated_tokens: BigInt([...ids].reduce((sum, id) => sum + (sizes.get(id)?.estimatedTokens ?? 0), 0)),
                reference_snapshot: jsonb({ ...reference, inputs: references, candidates: reference.candidates.filter(candidate => candidates.has(candidate.id)) } as unknown as JsonValue),
                reference_version: current.reference_version, planned_at: sql<Date>`now()`,
                request_estimate: jsonb({ ...group.estimate, oversized: group.oversized }),
              };
              if (index === 0) await tx.updateTable('ai_job_batches').set(fields).where('id', '=', batchId).execute();
              else await tx.insertInto('ai_job_batches').values({ ...fields, job_id: batch.job_id, batch_index: ++nextIndex,
                round: current.round, status: 'queued', step: 'request', request_budget_limit: current.request_budget_limit }).execute();
            }
            return 'split';
          });
          if (outcome === 'changed') return;
          const first = groups[0]!.request;
          assertStandardizationRequestFits(outcome === 'split' ? buildTagReviewRequest(first.inputs, first.proposals, first.model) : request, limits);
          return;
        }
      }
      const estimate = assertStandardizationRequestFits(request, limits);
      signal?.throwIfAborted();
      const trivialSnapshot: FrozenBatchReference = {
        strategyVersion: 'evidence-canonical-candidate-v2',
        catalogVersion: '0',
        inputs: (batch.product_ids as unknown as string[]).map(id => ({ id, candidateStandardProductIds: [], stats: { scanned: 0, compared: 0, truncated: false } })),
        candidates: [],
      };
      await this.database.updateTable('ai_job_batches')
        .set({
          ...(batch.reference_snapshot === null ? { reference_snapshot: jsonb(trivialSnapshot as unknown as JsonValue) } : {}),
          planned_at: sql`now()`, request_estimate: jsonb(estimate),
        })
        .where('id', '=', batchId)
        .execute();
      return;
    }
    if ((batch.reference_snapshot as unknown as FrozenBatchReference | null)?.standardizationStage === 'review') {
      const request = await this.getBatchRequest(batchId);
      if (!request.proposals) throw new Error('standardization review proposals are missing');
      const estimate = assertStandardizationRequestFits(buildStandardizationReviewRequest(request, request.proposals));
      await this.database.updateTable('ai_job_batches').set({ planned_at: sql`now()`, request_estimate: jsonb(estimate) })
        .where('id', '=', batchId).execute();
      return;
    }
    if (batch.reference_snapshot !== null) return;

    const ids = (batch.product_ids as unknown as string[]).map(BigInt);
    // Re-read active members after queueing. A representative can be deleted
    // after job creation while another member of the same frozen group remains
    // usable; only the latter may provide evidence to the model.
    const inputRows = ids.length ? await this.database.selectFrom('ai_job_inputs as i')
      .innerJoin('ai_job_input_members as m', join => join.onRef('m.job_id', '=', 'i.job_id').onRef('m.input_id', '=', 'i.input_id'))
      .innerJoin('products as p', 'p.id', 'm.product_id')
      .innerJoin('shops as s', 's.id', 'p.shop_id')
      .select(['i.input_id', 'i.previous_decision', 'm.payload as payload', 'i.input_bytes', 'i.estimated_tokens'])
      .where('i.job_id', '=', batch.job_id)
      .where('i.input_id', 'in', ids)
      .where('p.deleted_at', 'is', null)
      .where('s.deleted_at', 'is', null)
      .where('s.enabled', '=', true)
      .orderBy('i.input_id').orderBy('m.product_id')
      .execute() : [];
    const inputs = [...new Map(inputRows.map(row => [row.input_id.toString(), row])).values()];
    signal?.throwIfAborted();

    const catalog = await this.loadCandidateCatalog();
    const candidateIds = new Set<string>();
    const plannedInputs = inputs.map(input => {
      const result = catalog.index.search(buildCandidateSearchQuery(input.payload));
      for (const candidate of result.candidates) candidateIds.add(candidate.id);
      return {
        id: input.input_id.toString(),
        candidateStandardProductIds: result.candidates.map(candidate => candidate.id),
        stats: { scanned: result.stats.scanned, compared: result.stats.compared, truncated: result.stats.truncated },
      };
    });
    const reference: FrozenBatchReference = {
      strategyVersion: 'evidence-canonical-candidate-v2',
      catalogVersion: catalog.version.toString(),
      inputs: plannedInputs,
      candidates: [...candidateIds]
        .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
        .flatMap(id => {
          const document = catalog.index.getDocument(id);
          return document ? [document] : [];
        }),
    };
    signal?.throwIfAborted();
    const references = new Map(reference.inputs.map(input => [input.id, input]));
    const requestPlan = planStandardizationRequests({ model: batch.model, candidates: reference.candidates, inputs: inputs.map(input => ({
      productId: input.input_id, payload: input.payload, previousDecision: input.previous_decision, candidateStandardProductIds: references.get(String(input.input_id))!.candidateStandardProductIds,
    })) }, readStandardizationRequestLimits());

    if (!requestPlan.length && inputs.length) throw new Error('batch has no request inputs');
    await this.database.transaction().execute(async tx => {
      const job = await tx.selectFrom('ai_jobs').select(['id', 'status', 'prompt_version', 'rule_version', 'pipeline_versions', 'pause_requested', 'cancel_requested'])
        .where('id', '=', batch.job_id).forUpdate().executeTakeFirstOrThrow();
      if (job.prompt_version !== STANDARDIZATION_PROMPT_VERSION || job.rule_version !== IDENTITY_POLICY_VERSION || !isCurrentPipeline(job.pipeline_versions)) throw new Error('AI policy version is stale');
      if (job.pause_requested || job.cancel_requested || ['paused', 'cancelled', 'failed', 'succeeded'].includes(job.status)) throw new Error(`job status ${job.status} cannot prepare a batch`);
      const current = await tx.selectFrom('ai_job_batches').select(['step', 'reference_snapshot', 'round', 'request_budget_used', 'request_budget_limit'])
        .where('id', '=', batchId).where('job_id', '=', batch.job_id).forUpdate().executeTakeFirstOrThrow();
      if (current.step !== 'request' || current.reference_snapshot !== null) return;
      if (current.request_budget_used !== 0) throw new Error('cannot replan a reserved request');
      if (!requestPlan.length) {
        const emptyReference: FrozenBatchReference = { ...reference, inputs: [], candidates: [] };
        await tx.updateTable('ai_job_batches').set({
          input_bytes: 0n, estimated_tokens: 0n,
          reference_snapshot: jsonb(emptyReference as unknown as JsonValue), reference_version: catalog.version,
          planned_at: sql<Date>`now()`, request_estimate: jsonb({}),
        }).where('id', '=', batchId).execute();
        return;
      }
      const maximum = await tx.selectFrom('ai_job_batches').select(sql<bigint>`coalesce(max(batch_index), -1)`.as('index')).where('job_id', '=', batch.job_id).executeTakeFirstOrThrow();
      let nextIndex = maximum.index;
      const members = await tx.selectFrom('ai_job_input_members').select('input_id').where('job_id', '=', batch.job_id).where('input_id', 'in', ids).execute();
      const sizes = new Map(inputs.map(input => [input.input_id, input]));
      for (let index = 0; index < requestPlan.length; index++) {
        const group = requestPlan[index]!;
        const groupIds = new Set(group.request.inputs.map(input => input.productId));
        const frozen: FrozenBatchReference = { ...reference, inputs: reference.inputs.filter(input => groupIds.has(BigInt(input.id))), candidates: group.request.candidates };
        const fields = {
          product_ids: jsonb([...groupIds].map(String)), product_count: BigInt(members.filter(member => groupIds.has(member.input_id)).length),
          input_bytes: [...groupIds].reduce((sum, id) => sum + sizes.get(id)!.input_bytes, 0n),
          estimated_tokens: [...groupIds].reduce((sum, id) => sum + sizes.get(id)!.estimated_tokens, 0n),
          reference_snapshot: jsonb(frozen as unknown as JsonValue), reference_version: catalog.version, planned_at: sql<Date>`now()`,
          request_estimate: jsonb({ ...group.estimate, oversized: group.oversized }),
        };
        if (index === 0) await tx.updateTable('ai_job_batches').set(fields).where('id', '=', batchId).execute();
        else await tx.insertInto('ai_job_batches').values({ ...fields, job_id: batch.job_id, batch_index: ++nextIndex,
          status: 'queued', step: 'request', round: current.round, request_budget_limit: current.request_budget_limit }).execute();
      }
    });
  }

  /** Reserve a real provider attempt. Queue claims and local preparation do not consume this budget. */
  async reserveBatchRequest(batchId: bigint, claim?: { workerId?: string; attempt?: bigint; token?: string }): Promise<'reserved' | 'refresh' | 'skipped'> {
    const outcome = await this.database.transaction().execute(async tx => {
      const located = await tx.selectFrom('ai_job_batches').select('job_id').where('id', '=', batchId).executeTakeFirstOrThrow();
      const job = await tx.selectFrom('ai_jobs').select(['status', 'prompt_version', 'rule_version', 'pipeline_versions', 'pause_requested', 'cancel_requested', 'job_type'])
        .where('id', '=', located.job_id).forUpdate().executeTakeFirstOrThrow();
      const batch = await tx.selectFrom('ai_job_batches').selectAll().where('id', '=', batchId).forUpdate().executeTakeFirstOrThrow();
      if (job.prompt_version !== STANDARDIZATION_PROMPT_VERSION || job.rule_version !== IDENTITY_POLICY_VERSION || !isCurrentPipeline(job.pipeline_versions)) return 'stale_policy' as const;
      if (job.pause_requested || job.cancel_requested || ['paused', 'cancelled', 'failed', 'succeeded'].includes(job.status)) return 'inactive_job' as const;
      if (batch.step !== 'request' || batch.reference_snapshot === null) return 'reference_not_frozen' as const;
      if (claim?.workerId && (batch.status !== 'running' || batch.claimed_by !== claim.workerId || batch.lease_until === null || batch.lease_until <= new Date())) return 'stale_lease' as const;
      if (claim?.attempt !== undefined && batch.attempts !== claim.attempt) return 'stale_lease' as const;
      if (claim?.token !== undefined && batch.claim_token !== claim.token) return 'stale_lease' as const;

      const inputIds = (batch.product_ids as unknown as string[]).map(BigInt);
      if (job.job_type === 'tag_extraction' && inputIds.length) {
        const snapshots = await tx.selectFrom('ai_job_input_members').selectAll().where('job_id', '=', located.job_id).where('input_id', 'in', inputIds).where('output', 'is', null).execute();
        const productIds = snapshots.map(member => member.product_id);
        const sources = productIds.length ? await tx.selectFrom('products as p').innerJoin('shops as s', 's.id', 'p.shop_id').selectAll('p').where('p.id', 'in', productIds).where('p.deleted_at', 'is', null).where('s.deleted_at', 'is', null).where('s.enabled', '=', true).orderBy('p.id').forUpdate('p').execute() : [];
        const assignments = productIds.length ? await tx.selectFrom('standard_product_members').select(['product_id', 'assignment_source']).where('product_id', 'in', productIds).where('publication_state', '=', 'published').execute() : [];
        const manual = await readLatestManualDecisions(tx, productIds);
        for (const member of snapshots) {
          const product = sources.find(source => source.id === member.product_id);
          const assignment = assignments.find(row => row.product_id === member.product_id);
          const reasonCode = !product ? 'source_unavailable' : !assignment ? 'not_published' : assignment.assignment_source === 'human' ? 'human_assignment'
            : product.standardization_locked ? 'product_locked' : product.content_version !== member.content_version || productFingerprint(product) !== member.fingerprint ? 'source_changed'
            : product.standardization_revision !== member.standardization_revision ? 'revision_changed'
            : isManualDecisionForCurrentEvidence(manual.get(member.product_id), { content_version: product.content_version, content_fingerprint: productFingerprint(product) }) ? 'manual_decision' : null;
          if (!reasonCode) continue;
          const before = await tx.selectFrom('product_tags').select(['name', 'value']).where('product_id', '=', member.product_id).execute();
          const result = buildTagExtractionOutcome({ productId: member.input_id, tags: [], rejectedTags: [] }, before, { outcome: 'skipped', reasonCode });
          result.versions = tagExtractionVersions(member, job.pipeline_versions);
          await tx.updateTable('ai_job_input_members').set({ status: 'classified', reason_code: reasonCode, output: jsonb(result as unknown as JsonValue) }).where('job_id', '=', located.job_id).where('product_id', '=', member.product_id).execute();
        }
      }
      const activeMembers = inputIds.length ? await tx.selectFrom('ai_job_input_members as m')
        .innerJoin('products as p', 'p.id', 'm.product_id')
        .innerJoin('shops as s', 's.id', 'p.shop_id')
        .select(['m.input_id', 'm.product_id'])
        .where('m.job_id', '=', located.job_id).where('m.input_id', 'in', inputIds)
        .where(q => job.job_type === 'tag_extraction' ? q('m.output', 'is', null) : q.val(true))
        .where('p.deleted_at', 'is', null).where('s.deleted_at', 'is', null).where('s.enabled', '=', true)
        .execute() : [];
      const activeInputIds = [...new Set(activeMembers.map(member => member.input_id.toString()))].map(BigInt);
      const activeProductCount = activeMembers.length;
      const currentReference = batch.reference_snapshot as unknown as FrozenBatchReference;
      const referenceInputSet = new Set(currentReference.inputs.map(input => input.id));
      const activeInputSet = new Set(activeInputIds.map(String));
      const referenceNeedsRefresh = activeInputIds.length !== inputIds.length
        || activeInputIds.some(id => !referenceInputSet.has(id.toString()));
      if (!activeInputIds.length || referenceNeedsRefresh) {
        const inactiveInputIds = inputIds.filter(id => !activeInputSet.has(id.toString()));
        const inactiveMembers = inactiveInputIds.length ? await tx.selectFrom('ai_job_input_members')
          .select(['input_id', 'product_id', 'content_version', 'fingerprint', 'standardization_revision'])
          .where('job_id', '=', located.job_id)
          .where('input_id', 'in', inactiveInputIds)
          .where('status', 'not in', ['classified', 'unclassified', 'cancelled'])
          .execute() : [];
        if (inactiveMembers.length && job.job_type === 'tag_extraction') {
          for (const member of inactiveMembers) await tx.updateTable('ai_job_input_members').set({ status: 'classified', reason_code: 'source_unavailable', output: jsonb({ ...buildTagExtractionOutcome({ productId: member.input_id, tags: [], rejectedTags: [] }, [], { outcome: 'skipped', reasonCode: 'source_unavailable' }), versions: tagExtractionVersions(member, job.pipeline_versions) } as unknown as JsonValue) }).where('job_id', '=', located.job_id).where('product_id', '=', member.product_id).where('output', 'is', null).execute();
          await tx.updateTable('ai_job_inputs').set({ status: 'succeeded', reason_code: 'source_unavailable' }).where('job_id', '=', located.job_id).where('input_id', 'in', inactiveInputIds).execute();
        }
        if (inactiveMembers.length && job.job_type !== 'tag_extraction') {
          for (const member of inactiveMembers) {
            const reason = '商品或所属商铺已删除或停用，跳过模型判断';
            await tx.insertInto('ai_standardization_results').values({
              job_id: located.job_id, product_id: member.product_id, batch_id: batchId, input_id: member.input_id,
              content_version: member.content_version, fingerprint: member.fingerprint, status: 'unclassified',
              standard_product_id: null, tags: jsonb([]), evidence: jsonb([]), reason_code: 'source_changed', reason,
              decision: jsonb({ id: member.input_id.toString(), status: 'unclassified', ruleIds: [], evidence: [], reasonCode: 'source_changed', reason }),
              current_assignment_preserved: true, published_at: sql`now()`,
            }).onConflict(conflict => conflict.columns(['job_id', 'product_id']).doUpdateSet({
              batch_id: batchId, input_id: member.input_id, content_version: member.content_version, fingerprint: member.fingerprint,
              status: 'unclassified', standard_product_id: null, tags: jsonb([]), evidence: jsonb([]), reason_code: 'source_changed', reason,
              current_assignment_preserved: true, published_at: sql`now()`,
            })).execute();
            await tx.updateTable('ai_job_input_members').set({ status: 'unclassified', reason_code: 'source_changed' })
              .where('job_id', '=', located.job_id).where('product_id', '=', member.product_id).execute();
            await tx.updateTable('ai_standardization_executions').set({ status: 'completed', completed_at: sql`now()` })
              .where('job_id', '=', located.job_id).where('product_id', '=', member.product_id).execute();
          }
          await tx.updateTable('ai_job_inputs').set({ status: 'succeeded', reason_code: 'source_changed' })
            .where('job_id', '=', located.job_id).where('input_id', 'in', inactiveInputIds).execute();
        }
        if (!activeInputIds.length) {
          await tx.updateTable('ai_job_batches').set({
            product_ids: jsonb([]), product_count: 0n, input_bytes: 0n, estimated_tokens: 0n,
            step: 'done', status: 'succeeded', claimed_by: null, claim_token: null, lease_until: null, finished_at: sql`now()`,
          }).where('id', '=', batchId).execute();
          await finalizeOrScheduleMissing(tx, located.job_id);
          await incrementJobProgress(tx, { jobId: located.job_id });
          return 'skipped' as const;
        }
        const referenceInputs = currentReference.inputs.filter(input => activeInputSet.has(input.id));
        const missingReferenceInput = activeInputIds.some(id => !referenceInputSet.has(id.toString()));
        const candidateIds = new Set(referenceInputs.flatMap(input => input.candidateStandardProductIds));
        const refreshedReference: FrozenBatchReference = {
          ...currentReference,
          inputs: referenceInputs,
          candidates: currentReference.candidates.filter(candidate => candidateIds.has(candidate.id)),
        };
        await tx.updateTable('ai_job_batches').set({
          product_ids: jsonb(activeInputIds.map(String)),
          product_count: BigInt(activeProductCount),
          reference_snapshot: missingReferenceInput ? null : jsonb(refreshedReference as unknown as JsonValue),
          reference_version: missingReferenceInput ? null : batch.reference_version,
          planned_at: missingReferenceInput ? null : batch.planned_at,
          request_estimate: missingReferenceInput || batch.request_estimate === null ? null : jsonb(batch.request_estimate as JsonValue),
        }).where('id', '=', batchId).execute();
        return 'refresh' as const;
      }
      const unresolved = batch.request_budget_used - batch.confirmed_requests - batch.unknown_requests;
      if (batch.unknown_requests > 0) return 'request_outcome_unknown' as const;
      if (unresolved > 0) {
        await tx.updateTable('ai_job_batches').set({
          unknown_requests: batch.unknown_requests + unresolved, status: 'failed', error_source: 'request_outcome_unknown',
          error: 'request_outcome_unknown', claimed_by: null, claim_token: null, lease_until: null, finished_at: sql`now()`,
        }).where('id', '=', batchId).execute();
        return 'request_outcome_unknown' as const;
      }
      if (batch.request_budget_used >= batch.request_budget_limit) {
        await tx.updateTable('ai_job_batches').set({ status: 'failed', error_source: 'request_budget_exhausted', error: 'request_budget_exhausted', claimed_by: null, claim_token: null, lease_until: null, finished_at: sql`now()` }).where('id', '=', batchId).execute();
        return 'request_budget_exhausted' as const;
      }
      await tx.updateTable('ai_job_batches').set({ request_budget_used: batch.request_budget_used + 1, error_source: null }).where('id', '=', batchId).execute();
      return 'reserved' as const;
    });
    if (outcome !== 'reserved' && outcome !== 'refresh' && outcome !== 'skipped') throw new Error(outcome);
    return outcome;
  }

  async recordBatchRequestOutcome(batchId: bigint, outcome: 'confirmed' | 'unknown' | 'local_failure',
    metadata?: AiBatchResultMetadata, claim?: { workerId?: string; attempt?: bigint; token?: string }): Promise<void> {
    await this.database.transaction().execute(async tx => {
      const batch = await tx.selectFrom('ai_job_batches').select(['request_budget_used', 'confirmed_requests', 'unknown_requests',
        'status', 'step', 'claimed_by', 'attempts', 'claim_token', 'lease_until'])
        .where('id', '=', batchId).forUpdate().executeTakeFirstOrThrow();
      const unresolved = batch.request_budget_used - batch.confirmed_requests - batch.unknown_requests;
      if (metadata && (!claim?.workerId || claim.attempt === undefined || !claim.token || batch.status !== 'running'
        || batch.step !== 'request' || batch.claimed_by !== claim.workerId || batch.attempts !== claim.attempt
        || batch.claim_token !== claim.token || !batch.lease_until || batch.lease_until <= new Date()
        || batch.request_budget_used < 1 || outcome !== 'confirmed' || batch.unknown_requests > 0)) throw new Error('stale batch response audit');
      if (unresolved < 1 && !metadata) return;
      await tx.updateTable('ai_job_batches').set({ ...(unresolved < 1 ? {} : outcome === 'confirmed'
        ? { confirmed_requests: batch.confirmed_requests + 1 }
        : outcome === 'unknown'
          ? { unknown_requests: batch.unknown_requests + 1, error_source: 'request_outcome_unknown' }
          : { request_budget_used: batch.request_budget_used - 1, error_source: 'local_failure' }),
        ...(metadata ? {
          response_diagnostic: metadata.responseDiagnostic ? jsonb(metadata.responseDiagnostic as unknown as JsonValue) : null,
          response_usage: metadata.usage ? jsonb(metadata.usage) : null,
          response_model: metadata.responseModel ?? null, response_id: metadata.responseId ?? null,
          response_ms: metadata.responseMs == null ? null : Math.max(0, Math.round(metadata.responseMs)),
        } : {}),
      })
        .where('id', '=', batchId).execute();
    });
  }

  private async loadCandidateCatalog(): Promise<{ readonly version: bigint; readonly aliasPolicyVersion: string; readonly index: VersionedCandidateIndex }> {
    const target = await this.database.selectFrom('standardization_catalog_versions')
      .select(['version', 'alias_policy_version'])
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    if (this.candidateCatalog?.version === target.version
      && this.candidateCatalog.aliasPolicyVersion === target.alias_policy_version) return this.candidateCatalog;
    if (!this.candidateCatalog) return this.loadFullCandidateCatalog();

    const rows = await this.database.selectFrom('catalog_index_changes')
      .select(['version', 'standard_product_id', 'operation', 'document'])
      .where('version', '>', this.candidateCatalog.version)
      .where('version', '<=', target.version)
      .orderBy('version')
      .orderBy('id')
      .execute();
    const changes: CatalogIndexChange[] = rows.map(row => ({
      version: row.version,
      standardProductId: row.standard_product_id.toString(),
      operation: row.operation,
      ...(row.operation === 'upsert' ? { document: candidateDocument(row.document) } : {}),
    }));
    const applied = this.candidateCatalog.index.applyChanges(changes, target.version, {
      aliasPolicyVersion: target.alias_policy_version,
    });
    if (!applied.targetVersionReady) return this.loadFullCandidateCatalog();
    this.candidateCatalog = {
      version: applied.version,
      aliasPolicyVersion: target.alias_policy_version,
      index: this.candidateCatalog.index,
    };
    if (applied.compaction.required) {
      try {
        return await this.loadFullCandidateCatalog();
      } catch (error) {
        if (applied.compaction.blocksReady) throw error;
      }
    }
    return this.candidateCatalog;
  }

  private async loadFullCandidateCatalog(): Promise<{ readonly version: bigint; readonly aliasPolicyVersion: string; readonly index: VersionedCandidateIndex }> {
    const catalog = await this.database.transaction().execute(async tx => {
      const version = await tx.selectFrom('standardization_catalog_versions')
        .select(['version', 'alias_policy_version'])
        .where('id', '=', 1)
        .forShare()
        .executeTakeFirstOrThrow();
      const standards = await tx.selectFrom('standard_products as sp')
      .select(['sp.id', 'sp.name', 'sp.canonical_family', 'sp.canonical_product', 'sp.canonical_tier'])
      .where('sp.verification_state', '=', 'verified')
      .where('sp.merged_into_id', 'is', null)
      .where(sql<boolean>`exists (select 1 from standard_product_members m join products p on p.id = m.product_id
        where m.standard_product_id = sp.id and m.publication_state = 'published' and p.deleted_at is null)`)
      .orderBy('sp.id')
      .execute();
      const ids = standards.map(row => row.id);
      const aliases = ids.length ? await loadCatalogAliases(tx, ids) : [];
      const displayNames = await loadCandidateDisplayNames(tx, standards);
      const aliasOwners = new Map<string, Set<string>>();
      for (const alias of aliases) {
        const owners = aliasOwners.get(alias.normalized_alias) ?? new Set<string>();
        owners.add(alias.standard_product_id.toString());
        aliasOwners.set(alias.normalized_alias, owners);
      }
      const byStandard = new Map<string, string[]>();
      for (const alias of aliases) {
        if (aliasOwners.get(alias.normalized_alias)?.size !== 1) continue;
        const key = alias.standard_product_id.toString();
        const values = byStandard.get(key) ?? [];
        values.push(alias.alias);
        byStandard.set(key, values);
      }
      const documents: CandidateDocument[] = standards.flatMap(row => {
        if (!row.canonical_family || !row.canonical_product || !row.canonical_tier) return [];
        return [{ id: row.id.toString(), displayName: displayNames.get(row.id.toString()) ?? row.name, family: row.canonical_family, product: row.canonical_product, tier: row.canonical_tier, aliases: byStandard.get(row.id.toString()) ?? [] }];
      });
      return {
        version: version.version,
        aliasPolicyVersion: version.alias_policy_version,
        index: VersionedCandidateIndex.build({
          version: version.version,
          aliasPolicyVersion: version.alias_policy_version,
          documents,
        }),
      };
    });
    this.candidateCatalog = catalog;
    return catalog;
  }

  /** Fetch product evidence for a tag_extraction batch (no candidate catalog needed). */
  async getTagExtractionBatchInputs(batchId: bigint): Promise<{ jobId: bigint; model: string; stage: 'extract' | 'review'; proposals?: import('./tag-extraction-request.js').TagExtractionResponse; inputs: Array<{ productId: bigint; name: string; spec: string; sourceData: unknown; payload: JsonValue }> }> {
    const batch = await this.database.selectFrom('ai_job_batches as b')
      .innerJoin('ai_jobs as j', 'j.id', 'b.job_id')
      .select(['b.job_id', 'b.product_ids', 'b.reference_snapshot', 'j.model', 'j.job_type', 'j.prompt_version', 'j.rule_version', 'j.pipeline_versions'])
      .where('b.id', '=', batchId)
      .executeTakeFirstOrThrow();
    if (batch.job_type !== 'tag_extraction') throw new Error('getTagExtractionBatchInputs called on non-tag_extraction batch');
    assertCurrentPipeline(batch);
    const productIds = (batch.product_ids as unknown as string[]).map(BigInt);
    const products = productIds.length ? await this.database.selectFrom('ai_job_input_members as m')
      .innerJoin('products as p', 'p.id', 'm.product_id')
      .innerJoin('shops as s', 's.id', 'p.shop_id')
      .select(['m.input_id', 'm.payload'])
      .where('m.job_id', '=', batch.job_id)
      .where('m.input_id', 'in', productIds)
      .where('p.deleted_at', 'is', null)
      .where('s.deleted_at', 'is', null)
      .where('s.enabled', '=', true)
      .orderBy('p.id')
      .execute() : [];
    const reference = batch.reference_snapshot as { tagStage?: string; extractionBatchId?: string } | null;
    const stage = reference?.tagStage === 'review' ? 'review' : 'extract';
    const activeInputs = new Set(products.map(product => String(product.input_id)));
    let proposals: import('./tag-extraction-request.js').TagExtractionResponse | undefined;
    if (stage === 'review') {
      if (!reference?.extractionBatchId || !/^[1-9]\d*$/u.test(reference.extractionBatchId)) throw new Error('tag review source is invalid');
      const extraction = await this.database.selectFrom('ai_job_batches').select(['validated_decision', 'step', 'status'])
        .where('id', '=', BigInt(reference.extractionBatchId)).where('job_id', '=', batch.job_id).executeTakeFirstOrThrow();
      const document = extraction.validated_decision as unknown as { items?: Array<{ productId: string; tags: StandardizationTag[]; rejectedTags: StandardizationTag[] }> } | null;
      if (extraction.step !== 'done' || extraction.status !== 'succeeded' || !document || !Array.isArray(document.items)) throw new Error('tag extraction checkpoint is unavailable');
      proposals = { items: document.items.filter(item => activeInputs.has(item.productId)).map(item => ({
        id: item.productId, tags: [...item.tags, ...item.rejectedTags].map(tag => ({
          name: tag.name, value: tag.value, path: tag.evidence[0]?.path ?? '', quote: tag.evidence[0]?.quote ?? '',
        })),
      })) };
    }
    return { jobId: batch.job_id, model: batch.model, stage, ...(proposals ? { proposals } : {}), inputs: [...new Map(products.map(p => [String(p.input_id), p])).values()].map(p => {
      const payload = p.payload as Record<string, JsonValue>;
      if (typeof payload.name !== 'string' || typeof payload.spec !== 'string') throw new Error('tag extraction evidence is not frozen');
      return { productId: p.input_id, name: payload.name, spec: payload.spec, sourceData: payload.sourceData, payload: p.payload };
    }) };
  }

  async getBatchRequest(batchId: bigint, includeInactive = false): Promise<{ jobId: bigint; model: string; stage: 'generate' | 'review'; proposals?: ParsedStandardizationResponse; candidates: readonly CandidateDocument[]; inputs: Array<{ productId: bigint; fingerprint: string; payload: JsonValue; previousDecision: JsonValue | null; candidateStandardProductIds: readonly string[] }> }> {
    const batch = await this.database.selectFrom('ai_job_batches as b').innerJoin('ai_jobs as j', 'j.id', 'b.job_id').select(['b.job_id', 'b.product_ids', 'b.reference_snapshot', 'j.model', 'j.prompt_version', 'j.rule_version', 'j.pipeline_versions']).where('b.id', '=', batchId).executeTakeFirstOrThrow();
    assertCurrentPipeline(batch);
    if (batch.reference_snapshot === null) throw new Error('batch reference snapshot is not frozen');
    const reference = batch.reference_snapshot as unknown as FrozenBatchReference;
    const ids = (batch.product_ids as unknown as string[]).map(BigInt);
    const inputRows = await this.database.selectFrom('ai_job_inputs as i')
      .innerJoin('ai_job_input_members as m', join => join.onRef('m.job_id', '=', 'i.job_id').onRef('m.input_id', '=', 'i.input_id'))
      .innerJoin('products as p', 'p.id', 'm.product_id')
      .innerJoin('shops as s', 's.id', 'p.shop_id')
      .select(['i.input_id', 'i.fingerprint', 'i.previous_decision', 'm.payload as payload'])
      .where('i.job_id', '=', batch.job_id).where('i.input_id', 'in', ids)
      .where(eb => includeInactive ? eb.val(true) : eb.and([eb('p.deleted_at', 'is', null), eb('s.deleted_at', 'is', null), eb('s.enabled', '=', true)]))
      .orderBy('i.input_id').orderBy('m.product_id').execute();
    const inputs = [...new Map(inputRows.map(row => [row.input_id.toString(), row])).values()];
    const references = new Map(reference.inputs.map(input => [input.id, input.candidateStandardProductIds]));
    let proposals: ParsedStandardizationResponse | undefined;
    if (reference.standardizationStage === 'review') {
      if (!reference.generationBatchId || !/^[1-9]\d*$/u.test(reference.generationBatchId)) throw new Error('standardization review source is invalid');
      const generation = await this.database.selectFrom('ai_job_batches').select(['validated_decision', 'step', 'status'])
        .where('id', '=', BigInt(reference.generationBatchId)).where('job_id', '=', batch.job_id).executeTakeFirstOrThrow();
      if (generation.step !== 'done' || generation.status !== 'succeeded' || !generation.validated_decision) throw new Error('standardization generation checkpoint is unavailable');
      const document = generation.validated_decision as unknown as ParsedStandardizationResponse;
      const active = new Set(inputs.map(input => String(input.input_id)));
      const items = document.items.filter(item => active.has(item.id));
      const refs = new Set(items.flatMap(item => item.identity?.kind === 'new' ? [item.identity.ref] : []));
      proposals = { items, identities: document.identities.filter(identity => refs.has(identity.ref)), missingIds: document.missingIds.filter(id => active.has(id)) };
    }
    return { jobId: batch.job_id, model: batch.model, stage: proposals ? 'review' : 'generate', ...(proposals ? { proposals } : {}),
      candidates: reference.candidates, inputs: inputs.map((row) => ({ productId: row.input_id, fingerprint: row.fingerprint, payload: row.payload, previousDecision: row.previous_decision, candidateStandardProductIds: references.get(row.input_id.toString()) ?? [] })) };
  }

  /** Checkpoint and confirm before queueing review/publication; omitted stage preserves legacy direct calls. */
  async checkpointTagExtractionBatchDecision(jobId: bigint, batchId: bigint, items: TagExtractionDecision[], metadata: AiBatchResultMetadata = {}, claim?: { workerId?: string; attempt?: bigint; token?: string }, stage?: 'extract' | 'review'): Promise<void> {
    await this.database.transaction().execute(async tx => {
      const job = await tx.selectFrom('ai_jobs').select(['status', 'pause_requested', 'cancel_requested', 'job_type', 'prompt_version', 'rule_version', 'pipeline_versions'])
        .where('id', '=', jobId).forUpdate().executeTakeFirstOrThrow();
      if (job.job_type !== 'tag_extraction') throw new Error('tag checkpoint requires a tag_extraction job');
      assertCurrentPipeline(job);
      if (job.pause_requested || job.cancel_requested || ['paused', 'cancelled', 'failed', 'succeeded'].includes(job.status)) throw new Error(`job status ${job.status} cannot checkpoint results`);
      const batch = await tx.selectFrom('ai_job_batches').selectAll().where('id', '=', batchId).where('job_id', '=', jobId).forUpdate().executeTakeFirstOrThrow();
      if (batch.step !== 'request' || batch.status !== 'running' || !claim?.workerId || claim.attempt === undefined || !claim.token
        || batch.claimed_by !== claim.workerId || batch.attempts !== claim.attempt || batch.claim_token !== claim.token
        || batch.lease_until === null || batch.lease_until <= new Date()) throw new Error('stale batch checkpoint claim');
      const reference = batch.reference_snapshot as Record<string, JsonValue> | null;
      if (stage !== undefined && stage !== (reference?.tagStage === 'review' ? 'review' : 'extract')) throw new Error('tag checkpoint stage does not match frozen batch');
      if (batch.unknown_requests !== 0 || batch.request_budget_used - batch.confirmed_requests !== 1) throw new Error('tag checkpoint requires one unresolved request');
      const expected = new Set((batch.product_ids as unknown as string[]).map(String));
      if ((stage !== undefined && items.length !== expected.size) || new Set(items.map(item => String(item.productId))).size !== items.length
        || items.some(item => !expected.has(String(item.productId)))) throw new Error('tag extraction decision does not match batch inputs');
      const document = { items: items.map(item => ({ ...item, productId: String(item.productId) })) };
      const completedAt = Date.now();
      const responseCompletedAt = metadata.responseMs != null && Number.isFinite(metadata.responseMs) ? new Date(completedAt) : null;
      const firstContentAt = responseCompletedAt && metadata.firstContentMs != null && Number.isFinite(metadata.firstContentMs)
        ? new Date(completedAt - Math.max(0, metadata.responseMs! - metadata.firstContentMs)) : null;
      await tx.updateTable('ai_job_batches').set({
        validated_decision: jsonb(document as unknown as JsonValue),
        decision_hash: createHash('sha256').update(JSON.stringify(document)).digest('hex'),
        decision_saved_at: sql`now()`, confirmed_requests: batch.confirmed_requests + 1,
        step: stage === 'extract' ? 'done' : 'publish', status: stage === 'extract' ? 'succeeded' : 'queued',
        attempts: stage === 'extract' ? batch.attempts : 0n, claimed_by: null, claim_token: null, lease_until: null,
        available_at: sql`now()`, finished_at: stage === 'extract' ? sql`now()` : null, error: null, error_source: null, retry_class: null,
        first_content_at: firstContentAt, response_completed_at: responseCompletedAt,
        response_diagnostic: metadata.responseDiagnostic ? jsonb(metadata.responseDiagnostic as unknown as JsonValue) : null,
        response_ms: metadata.responseMs != null && Number.isFinite(metadata.responseMs) ? Math.max(0, Math.round(metadata.responseMs)) : null,
        response_usage: metadata.usage ? jsonb(metadata.usage) : null,
        response_model: metadata.responseModel ?? null, response_id: metadata.responseId ?? null,
      }).where('id', '=', batchId).execute();
      if (stage === 'extract') {
        const maximum = await tx.selectFrom('ai_job_batches').select(sql<bigint>`coalesce(max(batch_index), -1)`.as('index'))
          .where('job_id', '=', jobId).executeTakeFirstOrThrow();
        await tx.insertInto('ai_job_batches').values({
          job_id: jobId, batch_index: maximum.index + 1n, product_ids: jsonb(batch.product_ids), product_count: batch.product_count,
          input_bytes: batch.input_bytes, estimated_tokens: batch.estimated_tokens, round: 1,
          status: 'queued', step: 'request', request_budget_limit: 2,
          reference_snapshot: jsonb({ ...reference, tagStage: 'review', extractionBatchId: String(batchId) }),
        }).execute();
      }
    });
  }

  async publishTagExtractionBatch(batchId: bigint, claim?: { workerId?: string; attempt?: bigint; token?: string }): Promise<void> {
    const batch = await this.database.selectFrom('ai_job_batches').select(['job_id', 'validated_decision'])
      .where('id', '=', batchId).executeTakeFirstOrThrow();
    const document = batch.validated_decision as unknown as { items?: Array<Omit<TagExtractionDecision, 'productId'> & { productId: string }> } | null;
    if (!document || !Array.isArray(document.items) || document.items.some(item => !item || typeof item.productId !== 'string'
      || !/^[1-9]\d*$/u.test(item.productId) || !Array.isArray(item.tags) || !Array.isArray(item.rejectedTags))) throw new Error('tag checkpoint is invalid');
    await this.persistTagExtractionBatchDecision(batch.job_id, batchId,
      document.items.map(item => ({ ...item, productId: BigInt(item.productId) })), {}, claim, 'publish');
  }

  /** Publish atomically, rechecking each frozen member and current product before writing. */
  async persistTagExtractionBatchDecision(jobId: bigint, batchId: bigint, items: TagExtractionDecision[], metadata: AiBatchResultMetadata = {}, claim?: { workerId?: string; attempt?: bigint; token?: string }, expectedStep: 'request' | 'publish' = 'request'): Promise<void> {
    await this.database.transaction().execute(async tx => {
      const job = await tx.selectFrom('ai_jobs').select(['status', 'pause_requested', 'cancel_requested', 'job_type', 'prompt_version', 'rule_version', 'pipeline_versions']).where('id', '=', jobId).forUpdate().executeTakeFirstOrThrow();
      if (job.job_type !== 'tag_extraction') throw new Error('persistTagExtractionBatchDecision called on non-tag_extraction job');
      assertCurrentPipeline(job);
      const batch = await tx.selectFrom('ai_job_batches').select(['step', 'status', 'claimed_by', 'attempts', 'claim_token', 'lease_until', 'product_ids', 'reference_snapshot']).where('id', '=', batchId).where('job_id', '=', jobId).forUpdate().executeTakeFirstOrThrow();
      if (batch.step === 'done') return;
      if (job.pause_requested || job.cancel_requested || ['paused', 'cancelled', 'failed', 'succeeded'].includes(job.status)) throw new Error(`job status ${job.status} cannot persist results`);
      if (batch.step !== expectedStep) throw new Error('stale batch publication step');
      if (batch.status !== 'running' || (claim?.workerId && batch.claimed_by !== claim.workerId) || batch.lease_until === null || batch.lease_until <= new Date()) throw new Error('stale batch lease');
      if (claim?.attempt !== undefined && batch.attempts !== claim.attempt) throw new Error('stale batch attempt');
      if (claim?.token !== undefined && batch.claim_token !== claim.token) throw new Error('stale batch claim token');

      const ids = (batch.product_ids as unknown as string[]).map(BigInt);
      const expected = new Set(ids.map(String));
      if (new Set(items.map(item => String(item.productId))).size !== items.length || items.some(item => !expected.has(String(item.productId)))) throw new Error('tag extraction decision does not match batch inputs');
      const members = ids.length ? await tx.selectFrom('ai_job_input_members').selectAll().where('job_id', '=', jobId).where('input_id', 'in', ids).orderBy('product_id').execute() : [];
      const productIds = members.map(member => member.product_id);
      // Match crawler lock order: shop source first, then product evidence.
      if (productIds.length) await tx.selectFrom('shops').select('id')
        .where('id', 'in', tx.selectFrom('products').select('shop_id').where('id', 'in', productIds))
        .orderBy('id').forShare().execute();
      const products = productIds.length ? await tx.selectFrom('products as p').innerJoin('shops as s', 's.id', 'p.shop_id')
        .selectAll('p').select(['s.url as shop_url', 's.protocol as shop_protocol', 's.platform as shop_platform'])
        .where('p.id', 'in', productIds).where('p.deleted_at', 'is', null)
        .where('s.deleted_at', 'is', null).where('s.enabled', '=', true).orderBy('p.id').forUpdate('p').execute() : [];
      const current = new Map(products.map(product => [product.id, product]));
      const manual = await readLatestManualDecisions(tx, productIds);
      const memberships = productIds.length ? await tx.selectFrom('standard_product_members').select(['product_id', 'assignment_source']).where('product_id', 'in', productIds).where('publication_state', '=', 'published').execute() : [];
      const byInput = new Map(items.map(item => [item.productId, item]));
      // Revalidate the complete response against every frozen member before any writes.
      const decisions = new Map(members.flatMap(member => {
        const item = byInput.get(member.input_id);
        if (!item) return [];
        if (!item.reviewed && (readTextEvidence(member.payload) || item.textReview !== undefined)) {
          throw new Error('text review requires a reviewed decision');
        }
        const reference = batch.reference_snapshot as Record<string, JsonValue> | null;
        if (reference?.tagStage === 'review' && item.textReview === undefined) throw new Error('text review is missing from publication');
        const validated = item.reviewed
          ? validateReviewedTagExtractionDecision(member.input_id, item.tags, item.rejectedTags, member.payload, item.reviewDecisions, item.textReview)
          : validateTagExtractionDecision(member.input_id, [...item.tags, ...item.rejectedTags.map(({ reasonCode, reason, ...tag }) => tag)], member.payload);
        return [[member.product_id, validated] as const];
      }));
      let changed = false;

      for (const member of members) {
        if (member.output !== null && member.reason_code !== 'missing_id') continue;
        const product = current.get(member.product_id);
        const membership = memberships.find(row => row.product_id === member.product_id);
        const decision = decisions.get(member.product_id);
        const text = readTextEvidence(member.payload);
        const source = member.payload && typeof member.payload === 'object' && !Array.isArray(member.payload) ? member.payload.shopSource : null;
        const sourceMatches = source && typeof source === 'object' && !Array.isArray(source)
          && Object.keys(source).length === 3 && source.url === product?.shop_url
          && source.protocol === product?.shop_protocol && source.platform === product?.shop_platform;
        const before = await tx.selectFrom('product_tags').select(['name', 'value']).where('product_id', '=', member.product_id).orderBy('name').orderBy('value').execute();
        const skip = !product ? 'source_unavailable' : !membership ? 'not_published' : membership.assignment_source === 'human' ? 'human_assignment'
          : product.standardization_locked ? 'product_locked'
          : product.content_version !== member.content_version || productFingerprint(product) !== member.fingerprint ? 'source_changed'
          : text && (!sourceMatches || projectShopText(product.source_data)?.hash !== text.hash) ? 'text_review_source_changed'
          : product.standardization_revision !== member.standardization_revision ? 'revision_changed'
          : isManualDecisionForCurrentEvidence(manual.get(member.product_id), { content_version: product.content_version, content_fingerprint: productFingerprint(product) }) ? 'manual_decision' : null;
        const missing = !decision && !skip;
        const terminalMissing = missing && member.missing_reprocess_count > 0;
        const result = buildTagExtractionOutcome(decision ?? { productId: member.input_id, tags: [], rejectedTags: [] }, before,
          skip ? { outcome: 'skipped', reasonCode: skip } : missing ? { outcome: 'failed', reasonCode: 'missing_id' } : undefined);
        result.versions = tagExtractionVersions(member, job.pipeline_versions);
        if (result.diff.length) {
          const names = result.diff.map(change => change.name);
          await tx.deleteFrom('product_tags').where('product_id', '=', member.product_id).where('name', 'in', names).execute();
          const tags = decision!.tags.filter(tag => names.includes(tag.name));
          if (tags.length) await tx.insertInto('product_tags').values(tags.map(({ name, value }) => ({ product_id: member.product_id, name, value }))).execute();
          changed = true;
        }
        if (!skip && decision?.reviewed && decision.textReview && text) {
          const stored = { version: TEXT_REVIEW_VERSION, contentVersion: String(member.content_version),
            fingerprint: member.fingerprint, source, textHash: text.hash, review: decision.textReview };
          if (!isDeepStrictEqual(product!.text_review, stored)) {
            await tx.updateTable('products').set({ text_review: jsonb(stored as unknown as JsonValue) }).where('id', '=', member.product_id).execute();
            changed = true;
          }
        }
        await tx.updateTable('ai_job_input_members').set({ status: terminalMissing ? 'failed' : missing ? 'unclassified' : 'classified', reason_code: result.reasonCode, output: jsonb(result as unknown as JsonValue) }).where('job_id', '=', jobId).where('product_id', '=', member.product_id).execute();

      }
      if (changed) await bumpCatalogVersion(tx);
      for (const id of ids) {
        const missing = !byInput.has(id) && members.some(member => member.input_id === id && current.has(member.product_id));
        await tx.updateTable('ai_job_inputs').set({ status: missing && members.some(member => member.input_id === id && member.missing_reprocess_count > 0) ? 'failed' : 'succeeded', reason_code: missing ? 'missing_id' : null }).where('job_id', '=', jobId).where('input_id', '=', id).execute();
      }

      const responseCompletedAt = metadata.responseMs != null && Number.isFinite(metadata.responseMs) ? new Date() : null;
      await tx.updateTable('ai_job_batches').set({
        step: 'done', status: 'succeeded',
        claimed_by: null, claim_token: null, lease_until: null, finished_at: sql`now()`,
        ...(expectedStep === 'request' ? {
          response_ms: metadata.responseMs != null && Number.isFinite(metadata.responseMs) ? Math.max(0, Math.round(metadata.responseMs)) : null,
          response_usage: metadata.usage ? jsonb(metadata.usage) : null,
          response_model: metadata.responseModel ?? null, response_id: metadata.responseId ?? null,
          response_completed_at: responseCompletedAt,
        } : {}),
        retry_class: metadata.retryClass ?? null, error: null, error_source: null,
      }).where('id', '=', batchId).execute();

      await finalizeOrScheduleMissing(tx, jobId);
      await incrementJobProgress(tx, { jobId });
    });
  }

  async persistBatchDecision(jobId: bigint, batchId: bigint, decision: ParsedStandardizationResponse, metadata: AiBatchResultMetadata = {}, claim?: { workerId?: string; attempt?: bigint; token?: string }, stage?: 'generate' | 'review'): Promise<void> {
    const request = await this.getBatchRequest(batchId, true);
    if (stage && stage !== request.stage) throw new Error('standardization checkpoint stage does not match frozen batch');
    stage = request.stage;
    const needsReview = decision.items.some(isReviewableStandardizationDecision);
    const reviewPlan = stage === 'generate' && needsReview ? planStandardizationReviewRequests(request, decision, readStandardizationRequestLimits()) : undefined;
    await this.database.transaction().execute(async tx => {
      const job = await tx.selectFrom('ai_jobs').select(['prompt_version', 'rule_version', 'pipeline_versions', 'status', 'pause_requested', 'cancel_requested']).where('id', '=', jobId).forUpdate().executeTakeFirstOrThrow();
      if (job.prompt_version !== STANDARDIZATION_PROMPT_VERSION || job.rule_version !== IDENTITY_POLICY_VERSION || !isCurrentPipeline(job.pipeline_versions)) throw new Error('AI policy version is stale');
      if (job.pause_requested || job.cancel_requested || ['paused', 'cancelled', 'failed', 'succeeded'].includes(job.status)) throw new Error(`job status ${job.status} cannot persist results`);
      const batch = await tx.selectFrom('ai_job_batches').selectAll().where('id', '=', batchId).where('job_id', '=', jobId).forUpdate().executeTakeFirstOrThrow();
      if (batch.step === 'publish' || batch.step === 'done') {
        throw new Error('stale batch checkpoint');
      }
      if (batch.status !== 'running' || (claim?.workerId && batch.claimed_by !== claim.workerId) || batch.lease_until === null || batch.lease_until <= new Date()) throw new Error('stale batch lease');
      if (claim?.attempt !== undefined && batch.attempts !== claim.attempt) throw new Error('stale batch attempt');
      if (claim?.token !== undefined && batch.claim_token !== claim.token) throw new Error('stale batch claim token');
      const expected = new Set((batch.product_ids as unknown as string[]).map(String));
      const returned = new Set(decision.items.map(item => item.id));
      const missing = new Set(decision.missingIds);
      if ([...returned].some(id => !expected.has(id)) || [...missing].some(id => !expected.has(id) || returned.has(id)) || returned.size + missing.size !== expected.size) throw new Error('standardization decision does not match batch inputs');
      const reference = batch.reference_snapshot as unknown as FrozenBatchReference | null;
      if (!reference) throw new Error('batch reference snapshot is not frozen');
      if (stage !== (reference.standardizationStage === 'review' ? 'review' : 'generate')) throw new Error('standardization checkpoint stage does not match frozen batch');
      if (batch.unknown_requests !== 0 || batch.request_budget_used - batch.confirmed_requests !== 1) throw new Error('standardization checkpoint requires one unresolved request');
      const candidatesByInput = new Map(reference.inputs.map(input => [input.id, new Set(input.candidateStandardProductIds)]));
      for (const item of decision.items) {
        if (item.identity?.kind === 'existing' && !candidatesByInput.get(item.id)?.has(item.identity.standardProductId)) {
          throw new Error(`standardization decision references an unfrozen candidate for input ${item.id}`);
        }
      }
      if (stage === 'review') {
        if (!request.proposals || decision.items.some(item => isReviewableStandardizationDecision(item) && typeof item.review?.approved !== 'boolean')) throw new Error('standardization review votes are missing');
        const reviewed = parseStandardizationReviewResponse(JSON.stringify({ items: decision.items.filter(item => item.review !== undefined).map(item => ({ id: item.id, approved: item.review!.approved })) }), request.proposals);
        const bounded = validateStandardizationEvidence(reviewed, request.inputs.map(input => ({ id: String(input.productId), payload: input.payload })), request.candidates, 'boundary');
        if (!isDeepStrictEqual({ items: decision.items, identities: decision.identities, missingIds: decision.missingIds }, bounded)) throw new Error('standardization review changed its original proposals');
      }
      const completedAt = Date.now();
      const responseCompletedAt = metadata.responseMs != null && Number.isFinite(metadata.responseMs) ? new Date(completedAt) : null;
      const firstContentAt = responseCompletedAt && metadata.firstContentMs != null && Number.isFinite(metadata.firstContentMs) ? new Date(completedAt - Math.max(0, metadata.responseMs! - metadata.firstContentMs)) : null;
      const responseFields = {
        confirmed_requests: batch.confirmed_requests + 1,
        ...(metadata.responseDiagnostic ? { response_diagnostic: jsonb(metadata.responseDiagnostic as unknown as JsonValue) } : {}),
        decision_saved_at: sql<Date>`now()`, first_content_at: firstContentAt, response_completed_at: responseCompletedAt,
        response_usage: metadata.usage ? jsonb(metadata.usage) : null, response_model: metadata.responseModel ?? null, response_id: metadata.responseId ?? null,
        response_ms: metadata.responseMs != null && Number.isFinite(metadata.responseMs) ? Math.max(0, Math.round(metadata.responseMs)) : null,
        retry_class: metadata.retryClass ?? null, error: null, error_source: null, claimed_by: null, claim_token: null, lease_until: null,
      };
      if (stage === 'generate' && needsReview) {
        const planned = new Set(reviewPlan!.flatMap(group => group.request.inputs.map(input => String(input.productId))));
        if (planned.size !== expected.size || [...expected].some(id => !planned.has(id))) throw new Error('standardization review plan lost inputs');
        await tx.updateTable('ai_job_batches').set({
          ...responseFields, step: 'done', status: 'succeeded', finished_at: sql`now()`,
          validated_decision: jsonb({ items: decision.items, identities: decision.identities, missingIds: decision.missingIds } as unknown as JsonValue),
          decision_hash: createHash('sha256').update(JSON.stringify({ items: decision.items, identities: decision.identities, missingIds: decision.missingIds })).digest('hex'),
        }).where('id', '=', batchId).execute();
        const maximum = await tx.selectFrom('ai_job_batches').select(sql<bigint>`coalesce(max(batch_index), -1)`.as('index'))
          .where('job_id', '=', jobId).executeTakeFirstOrThrow();
        let nextIndex = maximum.index;
        for (const group of reviewPlan!) {
          const ids = new Set(group.request.inputs.map(input => String(input.productId)));
          const groupMembers = await tx.selectFrom('ai_job_input_members').select('product_id')
            .where('job_id', '=', jobId).where('input_id', 'in', [...ids].map(BigInt)).execute();
          await tx.insertInto('ai_job_batches').values({
            job_id: jobId, batch_index: ++nextIndex, product_ids: jsonb([...ids]), product_count: BigInt(groupMembers.length),
            input_bytes: BigInt(group.request.inputs.reduce((sum, input) => sum + estimateInputSize(input.payload).inputBytes, 0)),
            estimated_tokens: BigInt(group.request.inputs.reduce((sum, input) => sum + estimateInputSize(input.payload).estimatedTokens, 0)),
            round: 1, status: 'queued', step: 'request', request_budget_limit: 2,
            reference_snapshot: jsonb({ ...reference, standardizationStage: 'review', generationBatchId: String(batchId),
              inputs: reference.inputs.filter(input => ids.has(input.id)), candidates: group.request.candidates } as unknown as JsonValue),
            reference_version: batch.reference_version, planned_at: sql`now()`, request_estimate: jsonb({ ...group.estimate, oversized: group.oversized }),
          }).execute();
        }
        await incrementJobProgress(tx, { jobId });
        return;
      }

      let document: ParsedStandardizationResponse = { items: decision.items, identities: decision.identities, missingIds: decision.missingIds };
      const identities = new Map(document.identities.map(identity => [identity.ref, identity]));
      for (const item of document.items) if (item.identity?.kind === 'new' && !identities.has(item.identity.ref)) throw new Error('standardization decision has a dangling identity ref');
      const members = await tx.selectFrom('ai_job_input_members').select(['product_id', 'input_id']).where('job_id', '=', jobId).where('input_id', 'in', [...expected].map(BigInt)).orderBy('product_id').execute();
      let plan = planPublicationUnits(publicationMembers(members, document));
      if (plan.oversizedProductIds.length) {
        const oversized = new Set(plan.oversizedProductIds.map(String));
        const oversizedInputs = new Set(members.filter(member => oversized.has(member.product_id.toString())).map(member => member.input_id.toString()));
        document = {
          ...document,
          items: document.items.map(item => oversizedInputs.has(item.id)
            ? { ...publicationTooLargeDecision(item.id), ...(item.review ? { review: item.review } : {}) } : item),
          missingIds: document.missingIds.filter(id => !oversizedInputs.has(id)),
        };
        plan = planPublicationUnits(publicationMembers(members, document));
        if (plan.oversizedProductIds.length) throw new Error('publication fallback does not fit configured limits');
      }

      for (const identity of document.identities) await tx.insertInto('ai_batch_identity_mappings').values({
        batch_id: batchId, identity_ref: identity.ref, canonical_key: identity.canonicalKey,
        identity_snapshot: jsonb(identity as unknown as JsonValue), status: 'pending',
      }).onConflict(conflict => conflict.columns(['batch_id', 'identity_ref']).doNothing()).execute();
      for (let index = 0; index < plan.units.length; index++) await tx.insertInto('ai_publication_units').values({
        batch_id: batchId, unit_index: index, product_ids: jsonb(plan.units[index]!.productIds.map(String)),
        member_count: plan.units[index]!.memberCount, tag_count: plan.units[index]!.tagCount,
        payload_bytes: BigInt(plan.units[index]!.payloadBytes),
      }).onConflict(conflict => conflict.columns(['batch_id', 'unit_index']).doNothing()).execute();
      const serialized = JSON.stringify(document);
      await tx.updateTable('ai_job_batches').set({
        ...responseFields,
        step: 'publish', status: 'queued', attempts: 0n, validated_decision: jsonb(document as unknown as JsonValue),
        decision_hash: createHash('sha256').update(serialized).digest('hex'),
        publication_plan: jsonb({ hash: plan.planHash, units: plan.units.map(unit => ({ productIds: unit.productIds.map(String), memberCount: unit.memberCount, tagCount: unit.tagCount, payloadBytes: unit.payloadBytes, sqlParameters: unit.sqlParameters })) }),
        publication_cursor: 0,
        available_at: sql`now()`,
      }).where('id', '=', batchId).execute();
    });
  }

  async publishBatch(batchId: bigint, claim?: { workerId?: string; attempt?: bigint; token?: string }): Promise<void> {
    await this.database.transaction().execute(async tx => {
      const batch = await tx.selectFrom('ai_job_batches').select(['step', 'status', 'claimed_by', 'attempts', 'claim_token', 'lease_until']).where('id', '=', batchId).forUpdate().executeTakeFirstOrThrow();
      if (batch.step === 'done') return;
      if (batch.step !== 'publish' || batch.status !== 'running' || batch.lease_until === null || batch.lease_until <= new Date()
        || (claim?.workerId && batch.claimed_by !== claim.workerId) || (claim?.attempt !== undefined && batch.attempts !== claim.attempt)
        || (claim?.token !== undefined && batch.claim_token !== claim.token)) throw new Error('stale batch lease');
    });
    const units = await this.database.selectFrom('ai_publication_units').select(['id']).where('batch_id', '=', batchId).where('status', 'in', ['queued', 'running']).orderBy('unit_index').execute();
    for (const unit of units) await this.publishUnit(batchId, unit.id, claim);
    await this.database.transaction().execute(async tx => {
      const located = await tx.selectFrom('ai_job_batches').select('job_id').where('id', '=', batchId).executeTakeFirstOrThrow();
      await tx.selectFrom('ai_jobs').select('id').where('id', '=', located.job_id).forUpdate().executeTakeFirstOrThrow();
      const batch = await tx.selectFrom('ai_job_batches').select(['step', 'status', 'claimed_by', 'attempts', 'claim_token', 'lease_until']).where('id', '=', batchId).forUpdate().executeTakeFirstOrThrow();
      if (batch.step === 'done') return;
      if (batch.step !== 'publish' || batch.status !== 'running' || batch.lease_until === null || batch.lease_until <= new Date()
        || (claim?.workerId && batch.claimed_by !== claim.workerId) || (claim?.attempt !== undefined && batch.attempts !== claim.attempt)
        || (claim?.token !== undefined && batch.claim_token !== claim.token)) throw new Error('stale batch lease');
      const pending = await tx.selectFrom('ai_publication_units').select('id').where('batch_id', '=', batchId).where('status', '!=', 'succeeded').executeTakeFirst();
      if (pending) throw new Error('publication units are incomplete');
      const count = await tx.selectFrom('ai_publication_units').select(sql<number>`count(*)::int`.as('count')).where('batch_id', '=', batchId).executeTakeFirstOrThrow();
      await tx.updateTable('ai_job_batches').set({ step: 'done', status: 'succeeded', claimed_by: null, claim_token: null, lease_until: null, finished_at: sql`now()`, publication_cursor: count.count }).where('id', '=', batchId).execute();
      await finalizeOrScheduleMissing(tx, located.job_id);
      await incrementJobProgress(tx, { jobId: located.job_id });
    });
  }

  private async publishUnit(batchId: bigint, unitId: bigint, claim?: { workerId?: string; attempt?: bigint; token?: string }): Promise<void> {
    await this.database.transaction().execute(async tx => {
      const located = await tx.selectFrom('ai_job_batches').select('job_id').where('id', '=', batchId).executeTakeFirstOrThrow();
      const job = await tx.selectFrom('ai_jobs').select(['id', 'status', 'pause_requested', 'cancel_requested', 'prompt_version', 'rule_version', 'pipeline_versions']).where('id', '=', located.job_id).forUpdate().executeTakeFirstOrThrow();
      assertCurrentPipeline(job);
      if (job.pause_requested || job.cancel_requested || ['paused', 'cancelled', 'failed'].includes(job.status)) throw new Error(`job status ${job.status} cannot publish`);
      const batch = await tx.selectFrom('ai_job_batches').select(['step', 'status', 'claimed_by', 'attempts', 'claim_token', 'lease_until', 'validated_decision', 'reference_snapshot'])
        .where('id', '=', batchId).forUpdate().executeTakeFirstOrThrow();
      if (batch.step === 'done') return;
      if (batch.step !== 'publish' || batch.status !== 'running' || batch.lease_until === null || batch.lease_until <= new Date()
        || (claim?.workerId && batch.claimed_by !== claim.workerId) || (claim?.attempt !== undefined && batch.attempts !== claim.attempt)
        || (claim?.token !== undefined && batch.claim_token !== claim.token)) throw new Error('stale batch lease');
      const unit = await tx.selectFrom('ai_publication_units').selectAll().where('id', '=', unitId).where('batch_id', '=', batchId).forUpdate().executeTakeFirstOrThrow();
      if (unit.status === 'succeeded') return;
      if (!['queued', 'running'].includes(unit.status)) throw new Error(`publication unit status ${unit.status} cannot publish`);
      await tx.updateTable('ai_publication_units').set({ status: 'running', started_at: sql`coalesce(started_at, now())`, error: null }).where('id', '=', unitId).execute();

      const document = batch.validated_decision as unknown as ParsedStandardizationResponse;
      const reference = batch.reference_snapshot as unknown as FrozenBatchReference | null;
      if (!reference) throw new Error('batch reference snapshot is not frozen');
      const reviewed = reference.standardizationStage === 'review';
      if (document.items.some(item => isReviewableStandardizationDecision(item) && (!reviewed || item.review?.approved !== true))) throw new Error('standardization publication requires reviewed decisions');
      const candidatesByInput = new Map(reference.inputs.map(input => [input.id, new Set(input.candidateStandardProductIds)]));
      const decisions = new Map(document.items.map(item => [item.id, item]));
      for (const id of document.missingIds) decisions.set(id, missingDecision(id));
      const identities = new Map(document.identities.map(identity => [identity.ref, identity]));
      const productIds = (unit.product_ids as unknown as string[]).map(BigInt);
      const members = await tx.selectFrom('ai_job_input_members').selectAll().where('job_id', '=', located.job_id).where('product_id', 'in', productIds).orderBy('product_id').forUpdate().execute();
      const productQuery = tx.selectFrom('products as p')
        .innerJoin('shops as s', 's.id', 'p.shop_id')
        .select(['p.id as id', 'p.content_version as content_version', 'p.content_fingerprint', 'p.standardization_revision', 'p.standardization_locked', 'p.name', 'p.spec', 'p.source_category', 'p.source_data'])
        .where('p.id', 'in', productIds).where('p.deleted_at', 'is', null).where('s.enabled', '=', true).where('s.deleted_at', 'is', null)
        .orderBy('p.id');
      // Preserve the shared name-before-product lock order for catalog writes.
      const names = [...new Set((await productQuery.execute()).map(product => canonicalizeMatchText(product.name)))].sort();
      if (names.length) await sql`select pg_advisory_xact_lock(hashtextextended(name, 0))
        from (select unnest(array[${sql.join(names)}]::text[]) as name order by name) names`.execute(tx);
      const currentProducts = await productQuery.forUpdate('p').execute();
      const current = new Map(currentProducts.map(product => [product.id.toString(), product]));
      const previousMemberships = productIds.length ? await tx.selectFrom('standard_product_members')
        .select(['product_id', 'standard_product_id', 'assignment_source'])
        .where('product_id', 'in', productIds)
        .execute() : [];
      const manualDecisions = await readLatestManualDecisions(tx, productIds);
      const affectedStandardProductIds = new Set(previousMemberships.map(member => member.standard_product_id));
      let visibleChange = false;
      for (const member of members) {
        // A locally reopened publication unit may also contain successful members.
        if (['classified', 'unclassified', 'cancelled'].includes(member.status)) continue;
        const decision = decisions.get(member.input_id.toString()) ?? missingDecision(member.input_id.toString());
        let publishedDecision = decision;
        const product = current.get(member.product_id.toString());
        let status: 'classified' | 'unclassified' = decision.status;
        let reasonCode = decision.reasonCode;
        let reason = decision.reason;
        let standardProductId: bigint | null = null;
        let publicationFailure: string | undefined;
        const sourceChanged = !product || product.content_version !== member.content_version
          || product.standardization_revision !== member.standardization_revision || productFingerprint(product) !== member.fingerprint;
        const choice = decision.identity;
        const proposedIdentity = choice?.kind === 'new' ? identities.get(choice.ref)
          : choice?.kind === 'existing' ? reference.candidates.find(candidate => candidate.id === choice.standardProductId) : undefined;
        const providerConflict = product ? serviceEvidenceRequirement({ name: product.name, spec: product.spec, sourceCategory: product.source_category, sourceData: product.source_data }) : null;
        if (sourceChanged) {
          status = 'unclassified'; reasonCode = 'source_changed'; reason = '商品资料、人工归类或商铺状态已变化';
        } else if (product.standardization_locked
          || isManualDecisionForCurrentEvidence(manualDecisions.get(member.product_id), { content_version: product.content_version, content_fingerprint: productFingerprint(product) })
          || (previousMemberships.some(previous => previous.product_id === member.product_id && previous.assignment_source === 'human')
            && (!manualDecisions.get(member.product_id)?.evidence_known || manualDecisions.get(member.product_id)?.content_version === product.content_version))) {
          status = 'unclassified'; reasonCode = 'manual_decision_preserved'; reason = '保留持续锁定或当前证据版本的人工决定';
        } else if (status === 'classified' && providerConflict) {
          status = 'unclassified'; reasonCode = 'insufficient_evidence'; reason = providerConflict;
        } else if (status === 'classified' && decision.identity) {
          standardProductId = await this.resolvePublishedIdentity(tx, batchId, decision, identities,
            candidatesByInput.get(member.input_id.toString()) ?? new Set(), proposedIdentity);
          if (standardProductId === null) {
            status = 'unclassified'; reasonCode = 'publication_blocked'; reason = '标准商品身份不可发布';
            const mapping = decision.identity.kind === 'new' ? await tx.selectFrom('ai_batch_identity_mappings').select('error')
              .where('batch_id', '=', batchId).where('identity_ref', '=', decision.identity.ref).executeTakeFirst() : undefined;
            publicationFailure = mapping?.error?.slice(0, 100) || (decision.identity.kind === 'existing' ? 'candidate_unavailable' : 'identity_unavailable');
          }
          // Canonical lookup may follow aliases; publish only the reviewed identity.
          if (standardProductId !== null) {
            const final = await tx.selectFrom('standard_products').select(['canonical_family', 'canonical_product', 'canonical_tier', 'verification_state', 'merged_into_id'])
              .where('id', '=', standardProductId).forUpdate().executeTakeFirst();
            const finalAvailable = final && !final.merged_into_id && final.verification_state === 'verified';
            const finalIdentity = finalAvailable ? normalizeIdentity({ family: final.canonical_family, product: final.canonical_product, tier: final.canonical_tier }) : undefined;
            let finalConflict = !finalAvailable ? '最终标准商品已失效'
              : !proposedIdentity || !isDeepStrictEqual(finalIdentity, normalizeIdentity(proposedIdentity)) ? '最终身份与 LLM 复核身份不一致' : null;
            finalConflict ??= await ensureStandardServiceEvidence(tx, standardProductId, { name: product.name, spec: product.spec, sourceCategory: product.source_category, sourceData: product.source_data });
            if (finalConflict) {
              status = 'unclassified'; standardProductId = null; reasonCode = finalAvailable ? 'identity_conflict' : 'publication_blocked'; reason = finalConflict;
              publicationFailure = finalAvailable ? 'final_identity_conflict' : 'final_identity_unavailable';
            }
          }
        }

        if (status === 'unclassified' && decision.status === 'classified') {
          publishedDecision = { id: decision.id, status, ruleIds: [], evidence: [], reasonCode, reason,
            ...(decision.review ? { review: decision.review } : {}),
            diagnostic: { stage: reasonCode === 'identity_conflict' ? 'identity' : 'publication', code: publicationFailure ?? reasonCode ?? 'publication_blocked',
              ...(proposedIdentity ? { proposedIdentity: normalizeIdentity(proposedIdentity) } : {}),
              ...(choice?.kind === 'existing' ? { standardProductId: choice.standardProductId } : {}),
            } };
        }

        if (status === 'classified' && standardProductId !== null) {
          affectedStandardProductIds.add(standardProductId);
          await tx.deleteFrom('standard_product_members').where('product_id', '=', member.product_id).execute();
          await tx.insertInto('standard_product_members').values({ standard_product_id: standardProductId, product_id: member.product_id, publication_state: 'published', assignment_source: 'ai', decision_version: located.job_id }).execute();
          visibleChange = true;
        }
        await tx.insertInto('ai_standardization_results').values({
          job_id: located.job_id, product_id: member.product_id, batch_id: batchId, input_id: member.input_id,
          content_version: member.content_version, fingerprint: member.fingerprint, status,
          standard_product_id: status === 'classified' ? standardProductId : null,
          tags: jsonb([]), evidence: jsonb(decision.evidence as unknown as JsonValue),
          reason_code: status === 'classified' ? null : reasonCode ?? 'invalid_response', reason,
          decision: jsonb(publishedDecision as unknown as JsonValue), current_assignment_preserved: status === 'unclassified', published_at: sql`now()`,
        }).onConflict(conflict => conflict.columns(['job_id', 'product_id']).doUpdateSet({
          batch_id: batchId, input_id: member.input_id, content_version: member.content_version, fingerprint: member.fingerprint, status,
          standard_product_id: status === 'classified' ? standardProductId : null,
          tags: jsonb([]), evidence: jsonb(decision.evidence as unknown as JsonValue),
          reason_code: status === 'classified' ? null : reasonCode ?? 'invalid_response', reason,
          decision: jsonb(publishedDecision as unknown as JsonValue), current_assignment_preserved: status === 'unclassified', published_at: sql`now()`,
        })).execute();
        await tx.updateTable('ai_job_input_members').set({ status, reason_code: status === 'classified' ? null : reasonCode ?? 'invalid_response', output: jsonb(publishedDecision as unknown as JsonValue) }).where('job_id', '=', located.job_id).where('product_id', '=', member.product_id).execute();
        await tx.updateTable('ai_standardization_executions').set({ status: 'completed', completed_at: sql`now()` }).where('job_id', '=', located.job_id).where('product_id', '=', member.product_id).execute();
      }
      if (visibleChange) {
        await bumpCatalogVersion(tx);
        await recordCandidateCatalogChanges(tx, [...affectedStandardProductIds], IDENTITY_POLICY_VERSION);
      }
      await tx.updateTable('ai_publication_units').set({ status: 'succeeded', completed_at: sql`now()`, error: null }).where('id', '=', unitId).execute();
      await tx.updateTable('ai_job_batches').set({ publication_cursor: sql`publication_cursor + 1` }).where('id', '=', batchId).execute();
      await incrementJobProgress(tx, { jobId: located.job_id });
    });
  }

  private async resolvePublishedIdentity(tx: Transaction<DatabaseSchema>, batchId: bigint, decision: StandardizationDecision, identities: ReadonlyMap<string, ParsedStandardizationResponse['identities'][number]>, allowedExistingIds: ReadonlySet<string>, frozenIdentity: Identity | undefined): Promise<bigint | null> {
    if (!decision.identity) return null;
    if (decision.identity.kind === 'existing') {
      if (!allowedExistingIds.has(decision.identity.standardProductId) || !frozenIdentity) return null;
      const id = BigInt(decision.identity.standardProductId);
      const row = await tx.selectFrom('standard_products').select(['id', 'verification_state']).where('id', '=', id).where('merged_into_id', 'is', null)
        .where('canonical_family', '=', frozenIdentity.family).where('canonical_product', '=', frozenIdentity.product).where('canonical_tier', '=', frozenIdentity.tier)
        .forUpdate().executeTakeFirst();
      return row?.verification_state === 'verified' ? row.id : null;
    }
    const identity = identities.get(decision.identity.ref);
    if (!identity) return null;
    const mapping = await tx.selectFrom('ai_batch_identity_mappings').select(['standard_product_id', 'status', 'identity_snapshot']).where('batch_id', '=', batchId).where('identity_ref', '=', identity.ref).forUpdate().executeTakeFirstOrThrow();
    const resolution = await resolveCanonicalIdentity(tx, identity);
    if (decision.review?.approved && resolution.status === 'resolved'
      && !isDeepStrictEqual(normalizeIdentity(identity), normalizeIdentity(resolution.identity))) {
      await tx.updateTable('ai_batch_identity_mappings').set({ status: 'conflict', error: 'reviewed_identity_changed', resolved_at: sql`now()` })
        .where('batch_id', '=', batchId).where('identity_ref', '=', identity.ref).execute();
      return null;
    }
    if (resolution.status === 'conflict') {
      await tx.updateTable('ai_batch_identity_mappings').set({ status: 'conflict', error: resolution.reason, resolved_at: sql`now()` }).where('batch_id', '=', batchId).where('identity_ref', '=', identity.ref).execute();
      return null;
    }
    if (mapping.status === 'resolved' && mapping.standard_product_id !== null) {
      if (resolution.status !== 'resolved' || resolution.standardProductId !== mapping.standard_product_id) return null;
      const frozen = mapping.identity_snapshot as unknown as Identity;
      const resolved = await tx.selectFrom('standard_products').select(['id', 'verification_state']).where('id', '=', mapping.standard_product_id).where('merged_into_id', 'is', null)
        .where('canonical_family', '=', frozen.family).where('canonical_product', '=', frozen.product).where('canonical_tier', '=', frozen.tier)
        .forUpdate().executeTakeFirst();
      return resolved?.verification_state === 'verified' ? resolved.id : null;
    }
    let standard: { id: bigint; verification_state: string } | undefined = resolution.status === 'resolved'
      ? { id: resolution.standardProductId, verification_state: 'verified' } : undefined;
    if (!standard) {
      standard = await tx.insertInto('standard_products').values({
        name: canonicalProductDisplayName(identity), platform: identity.family, standard_key: identity.canonicalKey,
        canonical_platform: identity.family, canonical_family: identity.family, canonical_product: identity.product, canonical_tier: identity.tier,
        verification_state: 'verified', verification_run_id: null, verification_reason: jsonb({ reason: identity.reason, evidence: identity.evidence } as unknown as JsonValue),
      }).onConflict(conflict => conflict.column('standard_key').where('standard_key', 'is not', null).doNothing()).returning(['id', 'verification_state']).executeTakeFirst();
      standard ??= await tx.selectFrom('standard_products').select(['id', 'verification_state']).where('standard_key', '=', identity.canonicalKey).where('merged_into_id', 'is', null).forUpdate().executeTakeFirst();
    }
    if (!standard || standard.verification_state !== 'verified') {
      await tx.updateTable('ai_batch_identity_mappings').set({ status: 'conflict', error: 'identity_quarantined', resolved_at: sql`now()` }).where('batch_id', '=', batchId).where('identity_ref', '=', identity.ref).execute();
      return null;
    }
    // Confirmed aliases may resolve to a different spelling. Freeze the resolved
    // target's identity so later publication units cannot follow an edited ID.
    const resolvedIdentity = await tx.selectFrom('standard_products').select(['canonical_family', 'canonical_product', 'canonical_tier'])
      .where('id', '=', standard.id).forUpdate().executeTakeFirstOrThrow();
    await tx.updateTable('ai_batch_identity_mappings').set({ status: 'resolved', standard_product_id: standard.id,
      identity_snapshot: jsonb({ family: resolvedIdentity.canonical_family, product: resolvedIdentity.canonical_product, tier: resolvedIdentity.canonical_tier }),
      error: null, resolved_at: sql`now()` }).where('batch_id', '=', batchId).where('identity_ref', '=', identity.ref).execute();
    return standard.id;
  }

  getJobProgress(jobId: bigint, since?: bigint): Promise<ProgressSnapshot | null> {
    return getJobProgress(this.database, jobId, since);
  }

  async *streamJobEvents(jobId: bigint, since: bigint, signal: AbortSignal): AsyncIterable<JobProgressEvent> {
    let version = since;
    let lastKeepalive = Date.now();
    if (signal.aborted) return;
    const listener = this.pool ? await PgNotifications.open(this.pool, 'ai_job_progress_changed', jobId.toString()) : undefined;
    try {
      while (!signal.aborted) {
        listener?.check();
        const snapshot = await this.getJobProgress(jobId, version);
        listener?.check();
        if (snapshot) { version = BigInt(snapshot.version); yield { id: `${jobId}:${snapshot.version}`, type: 'progress', data: snapshot }; lastKeepalive = Date.now(); }
        else if (Date.now() - lastKeepalive >= 15_000) { yield { id: `${jobId}:keepalive`, type: 'keepalive', data: null }; lastKeepalive = Date.now(); }
        if (listener) await listener.wait(signal);
        else await new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
          const timer = setTimeout(finish, 1000);
          signal.addEventListener('abort', finish, { once: true });
          if (signal.aborted) finish();
        });
      }
    } finally {
      await listener?.close();
    }
    listener?.check();
  }

  async pauseJob(jobId: bigint) {
    return this.database.transaction().execute(async tx => {
      const job = await tx.selectFrom('ai_jobs').selectAll().where('id', '=', jobId).forUpdate().executeTakeFirst();
      if (!job) throw new DomainNotFoundError('AI_JOB_NOT_FOUND', 'AI 任务不存在');
      if (job.status === 'paused') return job;
      if (!['queued', 'running'].includes(job.status)) throw new DomainConflictError('AI_JOB_STATE', '当前状态不能暂停');
      const updated = await tx.updateTable('ai_jobs').set({ status: 'paused', pause_requested: true }).where('id', '=', jobId).returningAll().executeTakeFirstOrThrow();
      await incrementJobProgress(tx, { jobId });
      return updated;
    });
  }
  async resumeJob(jobId: bigint) {
    return this.database.transaction().execute(async tx => {
      const job = await tx.selectFrom('ai_jobs').selectAll().where('id', '=', jobId).forUpdate().executeTakeFirst();
      if (!job) throw new DomainNotFoundError('AI_JOB_NOT_FOUND', 'AI 任务不存在');
      assertCurrentPipeline(job);
      if (['queued', 'running'].includes(job.status) && !job.pause_requested) return job;
      if (job.status !== 'paused') throw new DomainConflictError('AI_JOB_STATE', '当前状态不能恢复');
      const updated = await tx.updateTable('ai_jobs').set({ status: 'queued', pause_requested: false }).where('id', '=', jobId).returningAll().executeTakeFirstOrThrow();
      await incrementJobProgress(tx, { jobId });
      return updated;
    });
  }
  async cancelJob(jobId: bigint) {
    return this.database.transaction().execute(async (tx) => {
      const job = await tx.selectFrom('ai_jobs').selectAll().where('id', '=', jobId).forUpdate().executeTakeFirst();
      if (!job) throw new DomainNotFoundError('AI_JOB_NOT_FOUND', 'AI 任务不存在');
      if (job.status === 'cancelled') return job;
      if (['succeeded', 'failed'].includes(job.status)) throw new DomainConflictError('AI_JOB_STATE', '当前状态不能取消');
      const cancelled = await tx.updateTable('ai_jobs').set({ status: 'cancelled', cancel_requested: true, finished_at: sql`now()` }).where('id', '=', jobId).returningAll().executeTakeFirstOrThrow();
      await tx.updateTable('ai_job_batches').set({ status: 'cancelled', claimed_by: null, lease_until: null, finished_at: sql`now()` }).where('job_id', '=', jobId).where('status', 'in', ['queued', 'running']).execute();
      await tx.updateTable('ai_job_inputs').set({ status: 'cancelled' }).where('job_id', '=', jobId).where('status', 'in', ['queued', 'running']).execute();
      if (job.job_type === 'tag_extraction') {
        const pending = await tx.selectFrom('ai_job_input_members').selectAll().where('job_id', '=', jobId)
          .where(eb => eb.or([eb('output', 'is', null), eb.and([eb('status', '=', 'unclassified'), eb('reason_code', '=', 'missing_id'), eb('missing_reprocess_count', '=', 0)])])).execute();
        for (const member of pending) await tx.updateTable('ai_job_input_members').set({ status: 'cancelled', reason_code: 'job_cancelled', output: jsonb({ ...buildTagExtractionOutcome({ productId: member.input_id, tags: [], rejectedTags: [] }, [], { outcome: 'cancelled', reasonCode: 'job_cancelled' }), versions: tagExtractionVersions(member, job.pipeline_versions) } as unknown as JsonValue) }).where('job_id', '=', jobId).where('product_id', '=', member.product_id).execute();
      }
      await tx.updateTable('ai_job_input_members').set({ status: 'cancelled', reason_code: 'job_cancelled' }).where('job_id', '=', jobId).where('status', 'in', ['queued', 'processing']).execute();
      await tx.updateTable('ai_standardization_executions').set({ status: 'cancelled', completed_at: sql`now()` }).where('job_id', '=', jobId).where('status', 'in', ['registered', 'processing']).execute();
      await incrementJobProgress(tx, { jobId });
      return cancelled;
    });
  }

  previewTagJob(input: TagJobScope & {model:string}) { return previewTagJob(this.database,input); }
  createTagJob(input: TagJobRequest) { return createManualTagJob(this.database,input); }
  prepareTagJob(batchId:bigint,claim:{workerId:string;attempt:bigint;token:string},signal?:AbortSignal) { return prepareAllPendingTagJob(this.database,batchId,claim,signal); }

  async retryJob(jobId: bigint) {
    return this.database.transaction().execute(async (tx) => {
      const job = await tx.selectFrom('ai_jobs').select(['status', 'job_type', 'prompt_version', 'rule_version', 'pipeline_versions']).where('id', '=', jobId).forUpdate().executeTakeFirst();
      if (!job) throw new DomainNotFoundError('AI_JOB_NOT_FOUND', 'AI 任务不存在');
      if(job.job_type==='tag_extraction') throw new DomainConflictError('AI_TAG_TARGETED_RETRY_REQUIRED','请预览并明确选择标签重试范围');
      assertCurrentPipeline(job);
      if (['cancelled', 'succeeded'].includes(job.status)) throw new DomainConflictError('AI_JOB_STATE', '当前状态不能重试');
      const result = await tx.updateTable('ai_job_batches').set({ status: 'queued', attempts: 0n, error: null, error_source: null, retry_class: null, available_at: new Date(), finished_at: null, claimed_by: null, claim_token: null, lease_until: null })
        .where('job_id', '=', jobId).where('status', '=', 'failed')
        .where(q => q.or([
          q('step', '=', 'publish'),
          q.and([q('step', '=', 'request'), q('error_source', '=', 'local')]),
          q.and([q('step', '=', 'request'), q('error_source', '=', 'provider_transient'), q('unknown_requests', '=', 0), q('request_budget_used', '<', q.ref('request_budget_limit'))]),
        ])).returning(['id', 'product_ids', 'product_count']).execute();
      if (!result.length) throw new DomainNotFoundError('AI_RETRY_NOT_FOUND', '没有可重试的失败批次');
      const ids = result.flatMap(row => (row.product_ids as string[]).map(BigInt));
      const batchIds = result.map(batch => batch.id);
      if (ids.length) {
        await tx.updateTable('ai_job_inputs').set({ status: 'queued', reason_code: null, error: null })
          .where('job_id', '=', jobId).where('input_id', 'in', ids).where('status', '!=', 'succeeded').execute();
        // Reopen only terminal failures synthesized for these batches. Valid
        // decisions and already committed publication units remain unchanged.
        const reopened = await tx.updateTable('ai_job_input_members').set({ status: 'queued', reason_code: null, output: null })
          .where('job_id', '=', jobId).where('input_id', 'in', ids).where('status', '=', 'unclassified')
          .where('product_id', 'in', tx.selectFrom('ai_standardization_results').select('product_id')
            .where('job_id', '=', jobId).where('batch_id', 'in', batchIds).where('reason_code', 'in', ['publication_error', 'provider_error']))
          .returning('product_id').execute();
        if (reopened.length) {
          const productIds = reopened.map(member => member.product_id);
          await tx.deleteFrom('ai_standardization_results').where('job_id', '=', jobId).where('product_id', 'in', productIds).execute();
          await tx.updateTable('ai_standardization_executions').set({ status: 'registered', completed_at: null })
            .where('job_id', '=', jobId).where('product_id', 'in', productIds).execute();
        }
      }
      await tx.updateTable('ai_publication_units').set({ status: 'queued', completed_at: null, error: null })
        .where('batch_id', 'in', batchIds).where('status', 'in', ['queued', 'running', 'blocked', 'failed']).execute();
      const failed = await tx.selectFrom('ai_job_batches').select(sql<bigint>`count(*)`.as('count'))
        .where('job_id', '=', jobId).where('status', '=', 'failed').executeTakeFirstOrThrow();
      const updated = await tx.updateTable('ai_jobs').set({ status: 'queued', phase: 'standardizing', failed_batches: failed.count, error: null, cancel_requested: false, pause_requested: false, finished_at: null }).where('id', '=', jobId).returningAll().executeTakeFirstOrThrow();
      await incrementJobProgress(tx, { jobId });
      return updated;
    });
  }

  /** Read-only projections used by the administrator AI workbench. */
  adminTaskQueue(input: TaskQueueFilter) { return readAiTaskQueue(this.database, input); }

  async adminStatus() {
    const job = await this.database.selectFrom('ai_jobs').selectAll().where('job_type', '!=', 'tag_extraction').orderBy('id', 'desc').limit(1).executeTakeFirst();
    const runtime = readAiStandardizationRuntimeStatus();
    if (!job) return { ...runtime, job: null, progress: emptyProgress(), currentBatches: [], errors: [] };
    return { ...runtime, ...(await this.adminJobSnapshot(job.id)) };
  }

  listRetryPool(input: { limit: number; cursor?: string }) {
    return readRetryPool(this.database, { limit: Math.min(100, Math.max(1, Math.trunc(input.limit))), afterId: parseCursor(input.cursor) });
  }

  /** Atomically reserve eligible products via normal job membership and an idempotent submission. */
  async retryPool(input: { model: string; requestId: string; productIds?: readonly bigint[] }): Promise<Selectable<AiJobTable>> {
    return this.database.transaction().execute(async tx => {
      // Serialize only manual pool submissions; model execution uses the shared WorkerRuntime.
      await sql`select pg_advisory_xact_lock(71402, 1)`.execute(tx);
      const existing = await tx.selectFrom('ai_jobs').selectAll().where('retry_request_id', '=', input.requestId).executeTakeFirst();
      if (existing) return existing;
      const query = retryPoolQuery(tx).$if(input.productIds !== undefined, q => input.productIds!.length
        ? q.where('p.id', 'in', input.productIds!) : q.where(sql<boolean>`false`));
      const locked = await query.select('p.id').orderBy('p.id').forUpdate('p').execute();
      if (!locked.length) throw new DomainNotFoundError('AI_RETRY_NOT_FOUND', '没有可重试商品，请刷新待重试池');
      // A competing publication or manual edit may have completed while locks were acquired.
      const eligible = await query.where('p.id', 'in', locked.map(row => row.id))
        .select(['p.id', 'r.job_id as sourceJobId', 'r.reason_code as reasonCode']).orderBy('p.id').execute();
      if (!eligible.length) throw new DomainNotFoundError('AI_RETRY_NOT_FOUND', '商品已处理或正在处理中，请刷新待重试池');
      const created = await this.createJob({ model: input.model, productIds: eligible.map(row => row.id) }, tx);
      if (!created.total) throw new DomainNotFoundError('AI_RETRY_NOT_FOUND', '可重试商品已不可用，请刷新待重试池');
      for (const group of chunks(eligible)) {
        const sources = sql.join(group.map(row => sql`(${row.id}::bigint, ${row.sourceJobId}::bigint)`));
        await sql`update ai_job_input_members m set retry_source_job_id = source.job_id
          from (values ${sources}) as source(product_id, job_id)
          where m.job_id = ${created.id} and m.product_id = source.product_id`.execute(tx);
      }
      return tx.updateTable('ai_jobs').set({ retry_request_id: input.requestId }).where('id', '=', created.id).returningAll().executeTakeFirstOrThrow();
    });
  }

  async reapplySavedResults(jobId: bigint) {
    return this.database.transaction().execute(async tx => {
      const job = await tx.selectFrom('ai_jobs').selectAll().where('id', '=', jobId).forUpdate().executeTakeFirst();
      if (!job) throw new DomainNotFoundError('AI_JOB_NOT_FOUND', 'AI 任务不存在');
      if (!['succeeded', 'ready_with_errors'].includes(job.status)) throw new DomainConflictError('AI_JOB_STATE', '请等待任务结束后重新应用结果');
      assertCurrentPipeline(job);
      const results = await tx.selectFrom('ai_standardization_results as r')
        .innerJoin('products as p', 'p.id', 'r.product_id').innerJoin('shops as s', 's.id', 'p.shop_id')
        .innerJoin('ai_job_input_members as m', join => join.onRef('m.job_id', '=', 'r.job_id').onRef('m.product_id', '=', 'r.product_id'))
        .select(['r.product_id', 'r.batch_id', 'r.content_version as snapshot_version', 'r.fingerprint', 'p.content_version', 'p.content_fingerprint', 'p.standardization_revision', 'm.standardization_revision as snapshot_revision', 'p.name', 'p.spec', 'p.source_category', 'p.source_data'])
        .where('r.job_id', '=', jobId).where('r.status', '=', 'unclassified').where('r.reason_code', '=', 'source_changed')
        .where('p.deleted_at', 'is', null).where('s.deleted_at', 'is', null).where('s.enabled', '=', true)
        .orderBy('p.id').forUpdate('p').execute();
      const eligible = results.filter(row => row.batch_id !== null && row.content_version === row.snapshot_version
        && row.standardization_revision === row.snapshot_revision && productFingerprint(row) === row.fingerprint);
      if (!eligible.length) throw new DomainConflictError('AI_REAPPLY_NOT_FOUND', '没有可重新应用的结果；资料确已变化的商品需要创建新任务');
      const batchIds = [...new Set(eligible.map(row => row.batch_id!))];
      const batches = await tx.selectFrom('ai_job_batches').select(['id', 'validated_decision', 'reference_snapshot']).where('id', 'in', batchIds).forUpdate().execute();
      if (batches.some(batch => !batch.validated_decision || !batch.reference_snapshot)) throw new DomainConflictError('AI_RESULT_UNAVAILABLE', '已保存结果不完整，无法重新应用');
      const ids = new Set(eligible.map(row => row.product_id.toString()));
      const units = await tx.selectFrom('ai_publication_units').select(['id', 'product_ids']).where('batch_id', 'in', batchIds).execute();
      const unitIds = units.filter(unit => (unit.product_ids as string[]).some(id => ids.has(id))).map(unit => unit.id);
      if (!unitIds.length) throw new DomainConflictError('AI_RESULT_UNAVAILABLE', '没有可恢复的发布单元');
      await tx.updateTable('ai_job_input_members').set({ status: 'queued', reason_code: null }).where('job_id', '=', jobId).where('product_id', 'in', eligible.map(row => row.product_id)).execute();
      await tx.updateTable('ai_publication_units').set({ status: 'queued', completed_at: null, error: null }).where('id', 'in', unitIds).execute();
      await tx.updateTable('ai_job_batches').set({ step: 'publish', status: 'queued', attempts: 0n, claimed_by: null, claim_token: null, lease_until: null, finished_at: null, available_at: sql`now()`, error: null, error_source: null })
        .where('id', 'in', batchIds).execute();
      const updated = await tx.updateTable('ai_jobs').set({ status: 'queued', phase: 'standardizing', finished_at: null, pause_requested: false, cancel_requested: false, error: null }).where('id', '=', jobId).returningAll().executeTakeFirstOrThrow();
      await incrementJobProgress(tx, { jobId });
      return updated;
    });
  }

  async listJobResults(input: { jobId: bigint; limit: number; cursor?: string }): Promise<KeysetPage<ReviewProduct>> {
    await this.ensureJob(input.jobId);
    const afterId = parseCursor(input.cursor);
    const size = Math.min(100, Math.max(1, Math.trunc(input.limit)));
    const rows = await this.database.selectFrom('ai_standardization_results as r')
      .innerJoin('products as p', 'p.id', 'r.product_id').innerJoin('shops as s', 's.id', 'p.shop_id')
      .leftJoin('ai_job_batches as b', 'b.id', 'r.batch_id')
      .select('b.error as requestError')
      .select(sql<JsonValue | null>`r.decision -> 'diagnostic'`.as('diagnostic'))
      .select(['r.product_id as productId', 'p.name', 'p.spec', 's.name as shopName', 'r.reason_code as reasonCode', 'r.reason', 'r.evidence', 'r.current_assignment_preserved as currentAssignmentPreserved'])
      .where('r.job_id', '=', input.jobId).where('r.status', '=', 'unclassified')
      .$if(afterId !== undefined, query => query.where('r.product_id', '>', afterId!))
      .orderBy('r.product_id').limit(size + 1).execute();
    const items = rows.slice(0, size).map(({ requestError, ...row }) => stringifyBigints({
      ...row, reason: row.reasonCode === 'request_outcome_unknown' ? unknownRequestReason(requestError) : row.reason,
    }) as ReviewProduct);
    return { items, nextCursor: rows.length > size ? items[items.length - 1]!.productId : null };
  }

  async listTagJobResults(input: {jobId:bigint;limit:number;cursor?:string}) {
    await this.ensureJob(input.jobId);
    const job=await this.database.selectFrom('ai_jobs').select('job_type').where('id','=',input.jobId).executeTakeFirstOrThrow();
    if(job.job_type!=='tag_extraction') throw new DomainValidationError('AI_TAG_JOB_REQUIRED','需要标签任务');
    const page=normalizePageRequest(input);
    const rows=await this.database.selectFrom('ai_job_input_members as m').innerJoin('products as p','p.id','m.product_id')
      .innerJoin('shops as s','s.id','p.shop_id')
      .select(['m.product_id as id','m.input_id','m.status','m.reason_code','m.output','m.content_version','m.standardization_revision','p.name','p.spec','s.name as shop_name'])
      .where('m.job_id','=',input.jobId).$if(page.afterId!==undefined,q=>q.where('m.product_id','>',page.afterId!)).orderBy('m.product_id').limit(page.limit+1).execute();
    const result=buildCursorPage(rows,page.limit);
    return {...result,items:result.items.map(({output,...r})=>{const audit=output as Record<string,JsonValue>|null;return stringifyBigints({...r,outcome:audit?.outcome??(['queued','processing'].includes(r.status)?r.status:'unrecorded'),acceptedCount:Array.isArray(audit?.acceptedTags)?audit.acceptedTags.length:0,rejectedCount:Array.isArray(audit?.rejectedTags)?audit.rejectedTags.length:0,changedFields:Array.isArray(audit?.diff)?audit.diff.length:0});})};
  }
  async tagProductAudit(jobId:bigint,productId:bigint) {
    const job=await this.database.selectFrom('ai_jobs').select(['id','job_type','parent_identity_job_id','retry_of_job_id','model','pipeline_versions','created_at','finished_at']).where('id','=',jobId).where('job_type','=','tag_extraction').executeTakeFirst();
    if(!job) throw new DomainNotFoundError('AI_JOB_NOT_FOUND','标签任务不存在');
    const member=await this.database.selectFrom('ai_job_input_members').select(['product_id','input_id','status','reason_code','output','payload','content_version','standardization_revision','fingerprint','retry_source_job_id']).where('job_id','=',jobId).where('product_id','=',productId).executeTakeFirst();
    if(!member) throw new DomainNotFoundError('AI_TAG_MEMBER_NOT_FOUND','任务商品不存在');
    const sensitiveKey = (key: string) => /^(?:secret|password|passwd|token|accesstoken|refreshtoken|apikey|authorization|cookie|setcookie|session|sessionid)$/u
      .test(key.normalize('NFKC').replace(/[\s_-]+/gu, '').toLowerCase());
    const sensitivePath = (path: JsonValue | undefined) => typeof path === 'string' && path.split(/[.[\]]/u).some(sensitiveKey);
    const redact = (value: JsonValue): JsonValue => {
      if (typeof value === 'string') return sanitizeTagAuditText(value, Infinity);
      if (Array.isArray(value)) return value.map(redact);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [
        sanitizeTagAuditText(key, Infinity),
        sensitiveKey(key) || (key === 'quote' && sensitivePath(value.path))
          || (key === 'value' && Array.isArray(value.evidence) && value.evidence.some(citation =>
            citation && !Array.isArray(citation) && typeof citation === 'object' && sensitivePath(citation.path)))
          ? '[redacted]' : redact(item),
      ]));
    };
    const rows = await this.database.selectFrom('ai_job_batches').select([
      'id', 'batch_index', 'round', 'status', 'step', 'attempts', 'product_count', 'input_bytes', 'estimated_tokens',
      'queued_at', 'planned_at', 'request_budget_used', 'request_budget_limit',
      'confirmed_requests', 'unknown_requests', 'started_at', 'decision_saved_at', 'finished_at', 'first_content_at',
      'response_completed_at', 'response_model', 'response_id', 'response_usage', 'response_ms', 'request_estimate',
      'response_diagnostic', 'decision_hash', 'error_source', 'retry_class', 'error', 'reference_snapshot', 'validated_decision',
    ]).where('job_id', '=', jobId).where(sql<boolean>`product_ids @> ${jsonb([String(member.input_id)])}`).orderBy('batch_index').execute();
    const batches = rows.map(({ reference_snapshot, validated_decision, ...batch }) => {
      const reference = reference_snapshot as { tagStage?: string; extractionBatchId?: string } | null;
      const stage = reference?.tagStage === 'review' ? 'review' : 'extract';
      const document = validated_decision as unknown as {
        items?: Array<{ productId: string; tags?: StandardizationTag[]; rejectedTags?: StandardizationTag[]; reviewDecisions?: unknown }>;
      } | null;
      const item = Array.isArray(document?.items) ? document.items.find(item => item?.productId === String(member.input_id)) : undefined;
      const votes = item?.reviewDecisions;
      return { ...batch, error: batch.error ? sanitizeTagAuditText(batch.error) : null,
        request_estimate: redact(batch.request_estimate), response_diagnostic: redact(batch.response_diagnostic),
        stage, extraction_batch_id: reference?.extractionBatchId ?? null,
        proposals: stage === 'extract' && Array.isArray(item?.tags) ? [...item.tags, ...(Array.isArray(item.rejectedTags) ? item.rejectedTags : [])].map((tag, proposalIndex) => redact({
          proposalIndex, name: sanitizeTagAuditText(tag.name, 100), value: sanitizeTagAuditText(tag.value, 500),
          evidence: tag.evidence.slice(0, 8).map(citation => ({
            path: sanitizeTagAuditText(citation.path, 300), quote: sanitizeTagAuditText(citation.quote),
          })),
        })) : null,
        review_decisions: stage === 'review' && Array.isArray(votes) && votes.every(vote => typeof vote === 'boolean') ? votes : null };
    });
    return JSON.parse(JSON.stringify({job,member:{...member,payload:redact(member.payload),output:redact(member.output),outcome:(member.output as Record<string,JsonValue>|null)?.outcome??(['queued','processing'].includes(member.status)?member.status:'unrecorded')},batches},(_key,value)=>typeof value==='bigint'?String(value):value));
  }

  async adminJobSnapshot(jobId: bigint) {
    const job = await this.database.selectFrom('ai_jobs').selectAll().where('id', '=', jobId).executeTakeFirst();
    if (!job) throw new DomainNotFoundError('AI_JOB_NOT_FOUND', 'AI 任务不存在');
    const [snapshot, currentBatches, errors] = await Promise.all([
      getJobProgress(this.database, jobId),
      this.database.selectFrom('ai_job_batches').select(['batch_index', 'round', 'step', 'attempts', 'product_count', 'request_budget_used', 'request_budget_limit'])
        .where('job_id', '=', jobId).where('status', '=', 'running').orderBy('round').orderBy('batch_index').execute(),
      this.database.selectFrom('ai_job_batches').select(['batch_index', 'round', 'step', 'error_source', 'error',
        'response_diagnostic', 'response_model', 'response_id', 'response_ms', 'response_usage'])
        .where('job_id', '=', jobId).where('status', '=', 'failed').where('error', 'is not', null).orderBy('id', 'desc').limit(20).execute(),
    ]);
    const progress = snapshot ? {
      ...snapshot,
      productCount: snapshot.rawProductCount,
      uniqueInputs: snapshot.uniqueInputCount,
      deduplicatedProducts: Math.max(0, snapshot.rawProductCount - snapshot.uniqueInputCount),
      percent: snapshot.rawProductCount ? Math.min(100, Number(snapshot.processed) / snapshot.rawProductCount * 100) : 0,
      remaining: Math.max(0, snapshot.rawProductCount - Number(snapshot.processed)),
      failedBatches: snapshot.requests.failedBatches,
      batches: {
        total: snapshot.requests.totalBatches, queued: snapshot.requests.queuedBatches, running: snapshot.requests.runningBatches,
        succeeded: snapshot.requests.succeededBatches, failed: snapshot.requests.failedBatches, cancelled: snapshot.requests.cancelledBatches,
      },
      standardization: { standardProducts: snapshot.results.standardProducts },
    } : emptyProgress();
    return {
      job: {...job,error:job.error?sanitizeTagAuditText(job.error):null},
      progress,
      currentBatches: currentBatches.map(batch => ({
        batchIndex: Number(batch.batch_index), round: batch.round, step: batch.step, attempts: Number(batch.attempts),
        productCount: Number(batch.product_count), requestBudgetUsed: batch.request_budget_used, requestBudgetLimit: batch.request_budget_limit,
      })),
      errors: errors.map(row => ({
        batchIndex: Number(row.batch_index), round: row.round, step: row.step,
        source: row.error_source, error: row.error ? sanitizeTagAuditText(row.error) : null,
        diagnostic: row.response_diagnostic, responseModel: row.response_model, responseId: row.response_id,
        responseMs: row.response_ms, responseUsage: row.response_usage,
      })),
    };
  }

  async listStandardProductsByCursor(input: { jobId: bigint; query?: string; limit: number; cursor?: string; includeTotal?: boolean }): Promise<KeysetPage<StandardProductSummary>> {
    await this.ensureJob(input.jobId);
    const limit = Math.min(100, Math.max(1, Math.trunc(input.limit)));
    const afterId = parseCursor(input.cursor);
    const escaped = input.query?.trim().replace(/[\\%_]/g, '\\$&');
    const rows = await sql<Record<string, unknown>>`
      select sp.id as "standardProductId", sp.standard_key as "standardProductKey", sp.name as "standardName", sp.platform,
        count(*)::int as "productCount", count(distinct p.shop_id)::int as "shopCount"
      from ai_standardization_results r
      join standard_products sp on sp.id=r.standard_product_id and sp.verification_state='verified' and sp.merged_into_id is null
      join standard_product_members m on m.standard_product_id=sp.id and m.product_id=r.product_id and m.publication_state='published'
      join products p on p.id=r.product_id and p.deleted_at is null
      where r.job_id=${input.jobId} and r.status='classified'
        ${afterId === undefined ? sql`` : sql`and sp.id > ${afterId}`}
        ${escaped ? sql`and (sp.name ilike ${`%${escaped}%`} or sp.standard_key ilike ${`%${escaped}%`} or sp.platform ilike ${`%${escaped}%`})` : sql``}
      group by sp.id,sp.standard_key,sp.name,sp.platform
      order by sp.id
      limit ${limit + 1}
    `.execute(this.database);
    const hasNext = rows.rows.length > limit;
    const visible = rows.rows.slice(0, limit);
    const items = visible.map(row => stringifyBigints(row) as StandardProductSummary);
    const last = visible[visible.length - 1];
    const result: KeysetPage<StandardProductSummary> = { items, nextCursor: hasNext && last ? String(last.standardProductId) : null };
    if (input.includeTotal) {
      const count = await sql<{ count: number }>`
        select count(distinct r.standard_product_id)::int count
        from ai_standardization_results r
        join standard_products sp on sp.id=r.standard_product_id and sp.verification_state='verified' and sp.merged_into_id is null
        join standard_product_members m on m.standard_product_id=sp.id and m.product_id=r.product_id and m.publication_state='published'
        where r.job_id=${input.jobId} and r.status='classified'
          ${escaped ? sql`and (sp.name ilike ${`%${escaped}%`} or sp.standard_key ilike ${`%${escaped}%`} or sp.platform ilike ${`%${escaped}%`})` : sql``}
      `.execute(this.database);
      result.total = Number(count.rows[0]?.count ?? 0);
    }
    return result;
  }

  async listStandardProductItemsByCursor(input: { jobId: bigint; key: string; limit: number; cursor?: string }): Promise<KeysetPage<ReviewProduct>> {
    await this.ensureJob(input.jobId);
    const limit = Math.min(100, Math.max(1, Math.trunc(input.limit)));
    const afterId = parseCursor(input.cursor);
    const rows = await sql<Record<string, unknown>>`
      select p.id as "productId",p.name,p.spec,s.name as "shopName",sp.name as "standardName",sp.platform,
        r.tags,r.evidence,r.reason,r.decision,r.published_at as "publishedAt"
      from ai_standardization_results r
      join standard_products sp on sp.id=r.standard_product_id and sp.standard_key=${input.key} and sp.verification_state='verified' and sp.merged_into_id is null
      join standard_product_members m on m.standard_product_id=sp.id and m.product_id=r.product_id and m.publication_state='published'
      join products p on p.id=r.product_id and p.deleted_at is null
      join shops s on s.id=p.shop_id and s.enabled and s.deleted_at is null
      where r.job_id=${input.jobId} and r.status='classified'
        ${afterId === undefined ? sql`` : sql`and p.id > ${afterId}`}
      order by p.id limit ${limit + 1}
    `.execute(this.database);
    const hasNext = rows.rows.length > limit;
    const visible = rows.rows.slice(0, limit);
    const items = visible.map(row => stringifyBigints(row) as ReviewProduct);
    const last = visible[visible.length - 1];
    return { items, nextCursor: hasNext && last ? String(last.productId) : null };
  }

  async listGlobalStandardProducts(input: { query?: string; limit: number; cursor?: string; includeTotal?: boolean }): Promise<KeysetPage<StandardProductSummary>> {
    const limit = Math.min(100, Math.max(1, Math.trunc(input.limit)));
    const afterId = parseCursor(input.cursor);
    const escaped = input.query?.trim().replace(/[\\%_]/g, '\\$&');
    const filter = sql`sp.verification_state='verified' and sp.merged_into_id is null
      ${escaped ? sql`and (sp.name ilike ${`%${escaped}%`} or sp.standard_key ilike ${`%${escaped}%`} or sp.platform ilike ${`%${escaped}%`})` : sql``}`;
    const { rows } = await sql<Record<string, unknown>>`
      select sp.id as "standardProductId", sp.standard_key as "standardProductKey", sp.name as "standardName", sp.platform,
        count(current_member.product_id)::int as "productCount", count(distinct current_member.shop_id)::int as "shopCount"
      from standard_products sp
      left join (
        select m.standard_product_id, m.product_id, p.shop_id
        from standard_product_members m
        join products p on p.id=m.product_id and p.deleted_at is null
        join shops s on s.id=p.shop_id and s.enabled and s.deleted_at is null
        where m.publication_state='published'
      ) current_member on current_member.standard_product_id=sp.id
      where ${filter} ${afterId === undefined ? sql`` : sql`and sp.id > ${afterId}`}
      group by sp.id order by sp.id limit ${limit + 1}
    `.execute(this.database);
    const items = rows.slice(0, limit).map(row => stringifyBigints(row) as StandardProductSummary);
    const page: KeysetPage<StandardProductSummary> = { items, nextCursor: rows.length > limit ? String(items.at(-1)!.standardProductId) : null };
    if (input.includeTotal) {
      const count = await sql<{ total: number }>`select count(*)::int total from standard_products sp where ${filter}`.execute(this.database);
      page.total = count.rows[0]?.total ?? 0;
    }
    return page;
  }

  async listGlobalStandardProductItems(input: { standardProductId: bigint; limit: number; cursor?: string }): Promise<KeysetPage<ReviewProduct>> {
    const limit = Math.min(100, Math.max(1, Math.trunc(input.limit)));
    const afterId = parseCursor(input.cursor);
    const { rows } = await sql<Record<string, unknown>>`
      select p.id as "productId", p.name, p.spec, s.name as "shopName", sp.name as "standardName", sp.platform,
        m.assignment_source as "assignmentSource", r.job_id as "sourceJobId", m.created_at as "publishedAt",
        coalesce(r.evidence, '[]'::jsonb) as evidence, r.reason, r.decision
      from standard_product_members m
      join standard_products sp on sp.id=m.standard_product_id and sp.verification_state='verified' and sp.merged_into_id is null
      join products p on p.id=m.product_id and p.deleted_at is null
      join shops s on s.id=p.shop_id and s.enabled and s.deleted_at is null
      left join ai_standardization_results r on m.assignment_source='ai' and r.job_id=m.decision_version
        and r.product_id=p.id and r.standard_product_id=sp.id and r.status='classified'
      where m.standard_product_id=${input.standardProductId} and m.publication_state='published'
        ${afterId === undefined ? sql`` : sql`and p.id > ${afterId}`}
      order by p.id limit ${limit + 1}
    `.execute(this.database);
    const items = rows.slice(0, limit).map(row => stringifyBigints(row) as ReviewProduct);
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.productId : null };
  }

  async listGlobalResults(input: { limit: number; cursor?: string }): Promise<KeysetPage<ReviewProduct>> {
    const limit = Math.min(100, Math.max(1, Math.trunc(input.limit)));
    const afterId = parseCursor(input.cursor);
    const { rows } = await sql<Record<string, unknown>>`
      select p.id as "productId", p.name, p.spec, s.name as "shopName", r.job_id as "sourceJobId",
        case when p.standardization_locked or (d.content_version = p.content_version and d.content_fingerprint = p.content_fingerprint) then 'manual_decision_preserved'
          when r.job_id is null then 'not_processed'
          when r.content_version <> p.content_version or im.standardization_revision <> p.standardization_revision
            or r.fingerprint <> p.content_fingerprint or im.fingerprint <> p.content_fingerprint then 'source_changed'
          when r.status='unclassified' then r.reason_code else 'unassigned' end as "reasonCode",
        r.reason, b.error as "requestError", d.action as "manualAction", d.reason as "manualReason"
      from products p
      join shops s on s.id=p.shop_id and s.enabled and s.deleted_at is null
      left join lateral (
        select d.* from product_standardization_decisions d where d.product_id = p.id order by d.id desc limit 1
      ) d on true
      left join lateral (
        select r.* from ai_standardization_results r where r.product_id=p.id order by r.job_id desc limit 1
      ) r on true
      left join ai_job_input_members im on im.job_id=r.job_id and im.product_id=p.id
      left join ai_job_batches b on b.id=r.batch_id
      where p.deleted_at is null
        and not ${hasManualIsolation()}
        and not exists (
          select 1 from standard_product_members m
          join standard_products sp on sp.id=m.standard_product_id and sp.verification_state='verified' and sp.merged_into_id is null
          where m.product_id=p.id and m.publication_state='published'
        )
        ${afterId === undefined ? sql`` : sql`and p.id > ${afterId}`}
      order by p.id limit ${limit + 1}
    `.execute(this.database);
    const items = rows.slice(0, limit).map(({ requestError, manualReason, ...row }) => stringifyBigints({
      ...row,
      processingDisposition: productProcessingDisposition(row.reasonCode),
      reason: row.reasonCode === 'manual_decision_preserved' ? manualReason ?? '保留当前证据版本的人工决定或持续锁定。'
        : row.reasonCode === 'not_processed' ? '尚无模型处理结果。'
        : row.reasonCode === 'source_changed' ? '商品资料或人工归类已变化，请核对当前商品。'
          : row.reasonCode === 'unassigned' ? '当前没有已发布的有效归属，请重新归类。'
            : row.reasonCode === 'request_outcome_unknown' ? unknownRequestReason(typeof requestError === 'string' ? requestError : null) : row.reason,
    }) as ReviewProduct);
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.productId : null };
  }

  private async ensureJob(jobId: bigint) {
    const exists = await this.database.selectFrom('ai_jobs').select('id').where('id', '=', jobId).executeTakeFirst();
    if (!exists) throw new DomainNotFoundError('AI_JOB_NOT_FOUND', 'AI 任务不存在');
  }
}

function emptyProgress() {
  return {
    total: 0, processed: 0, percent: 0, remaining: 0, rawProductCount: 0, productCount: 0,
    uniqueInputCount: 0, uniqueInputs: 0, deduplicatedProducts: 0, failedBatches: 0,
    requests: { totalBatches: 0, queuedBatches: 0, runningBatches: 0, succeededBatches: 0, failedBatches: 0, cancelledBatches: 0, confirmed: 0, unknown: 0, budgetUsed: 0, budgetLimit: 0 },
    publication: { totalUnits: 0, queuedUnits: 0, runningUnits: 0, succeededUnits: 0, blockedUnits: 0, failedUnits: 0, cancelledUnits: 0, publishedMembers: 0, pendingMembers: 0 },
    results: { classified: 0, unclassified: 0, unclassifiedReasons: {}, standardProducts: 0 },
    missing: { scheduledInputs: 0, reprocessedInputs: 0 },
    batches: { total: 0, queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
    standardization: { standardProducts: 0 },
  };
}

function parseCursor(value?: string): bigint | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/u.test(value)) throw new DomainConflictError('INVALID_CURSOR', '分页游标无效');
  return BigInt(value);
}

function stringifyBigints(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === 'bigint' ? item.toString() : item]));
}

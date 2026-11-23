import { createHash } from 'node:crypto';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { jsonb, type AiJobBatchTable, type AiJobTable, type DatabaseSchema, type JsonValue } from '../database/types.js';
import type { AiBatchResultMetadata } from './response-audit.js';
import { assertCurrentPipeline } from './pipeline-versions.js';
import { incrementJobProgress } from './ai-progress.repository.js';
import { finalizeAiJob } from './standardization-finalizer.js';
import type { PublicationPlan } from './publication-planner.js';
import { readReviewStage, reviewRequestBudget, type ReviewStage } from './review-workflow.js';

export interface ReviewCheckpointContext {
  tx: Transaction<DatabaseSchema>;
  job: Selectable<AiJobTable>;
  batch: Selectable<AiJobBatchTable>;
  stage: ReviewStage;
  reference: Record<string, JsonValue>;
}
export interface NextReviewBatch {
  stage: ReviewStage;
  inputIds: readonly bigint[];
  reference?: Record<string, JsonValue>;
  referenceVersion?: bigint | null;
  estimate?: JsonValue;
  inputBytes?: number;
  estimatedTokens?: number;
  document?: JsonValue;
}
export interface ReviewCheckpointPlan {
  document: JsonValue;
  next: readonly NextReviewBatch[];
  publication?: { inputIds: readonly bigint[]; plan?: PublicationPlan };
}
export interface ReviewCheckpointInput {
  jobId: bigint;
  batchId: bigint;
  inputIds: readonly bigint[];
  claim?: { workerId?: string; attempt?: bigint; token?: string };
  stage?: ReviewStage;
  metadata?: AiBatchResultMetadata;
  reviewRequired?: (job: Selectable<AiJobTable>) => boolean;
  plan: (context: ReviewCheckpointContext) => Promise<ReviewCheckpointPlan>;
}

function assertBatchClaim(
  batch: Pick<Selectable<AiJobBatchTable>, 'step' | 'status' | 'claimed_by' | 'attempts' | 'claim_token' | 'lease_until'>,
  claim: ReviewCheckpointInput['claim'], step: 'request' | 'publish',
) {
  if (batch.step !== step) throw new Error('stale batch step');
  if (batch.status !== 'running' || !claim?.workerId || batch.claimed_by !== claim.workerId
    || batch.lease_until === null || batch.lease_until <= new Date()) throw new Error('stale batch lease');
  if (claim.attempt === undefined || batch.attempts !== claim.attempt) throw new Error('stale batch attempt');
  if (!claim.token || batch.claim_token !== claim.token) throw new Error('stale batch claim token');
}

export async function lockReviewPublication(tx: Transaction<DatabaseSchema>, batchId: bigint, claim: ReviewCheckpointInput['claim']) {
  const located = await tx.selectFrom('ai_job_batches').select('job_id').where('id', '=', batchId).executeTakeFirstOrThrow();
  const job = await tx.selectFrom('ai_jobs').selectAll().where('id', '=', located.job_id).forUpdate().executeTakeFirstOrThrow();
  const batch = await tx.selectFrom('ai_job_batches').select([
    'id', 'job_id', 'step', 'status', 'claimed_by', 'attempts', 'claim_token', 'lease_until',
    'product_ids', 'reference_snapshot', 'validated_decision',
  ]).where('id', '=', batchId).forUpdate().executeTakeFirstOrThrow();
  if (batch.step === 'done') return null;
  assertCurrentPipeline(job);
  if (job.pause_requested || job.cancel_requested || ['paused', 'cancelled', 'failed', 'succeeded'].includes(job.status)) {
    throw new Error(`job status ${job.status} cannot publish`);
  }
  assertBatchClaim(batch, claim, 'publish');
  if (!batch.reference_snapshot || readReviewStage(batch.reference_snapshot) !== (job.job_type === 'text_review' ? 'generate' : 'review')) {
    throw new Error('Publication requires its completed review stage');
  }
  return { job, batch };
}

/** Business writes and their completion marker remain inside the caller's locked transaction. */
export async function completeReviewPublication(tx: Transaction<DatabaseSchema>, context: NonNullable<Awaited<ReturnType<typeof lockReviewPublication>>>) {
  const { job, batch } = context;
  const pending = await tx.selectFrom('ai_publication_units').select('id')
    .where('batch_id', '=', batch.id).where('status', '!=', 'succeeded').executeTakeFirst();
  if (pending) throw new Error('publication units are incomplete');
  const units = await tx.selectFrom('ai_publication_units').select(sql<number>`count(*)::int`.as('count'))
    .where('batch_id', '=', batch.id).executeTakeFirstOrThrow();
  await tx.updateTable('ai_job_batches').set({
    step: 'done', status: 'succeeded', claimed_by: null, claim_token: null, lease_until: null,
    finished_at: sql`now()`, publication_cursor: units.count, retry_class: null, error: null, error_source: null,
  }).where('id', '=', batch.id).execute();
  await finalizeAiJob(tx, job.id);
  await incrementJobProgress(tx, { jobId: job.id });
}

function assertCoverage(stage: ReviewStage, expected: Set<string>, plan: ReviewCheckpointPlan, reference: Record<string, JsonValue>, reviewed: boolean) {
  const covered = new Set<string>();
  const add = (ids: readonly bigint[]) => {
    for (const id of ids.map(String)) {
      if (!expected.has(id) || covered.has(id)) throw new Error('Review transition duplicates or invents an input');
      covered.add(id);
    }
  };
  if (plan.publication) {
    if (reviewed && stage !== 'review') throw new Error('Review must complete before publication');
    add(plan.publication.inputIds);
    if (plan.publication.plan?.oversizedProductIds.length) throw new Error('Review publication exceeds configured limits');
  }
  for (const next of plan.next) {
    if (!reviewed || !next.inputIds.length) throw new Error('Invalid next review batch');
    if (next.document !== undefined) {
      if (stage !== 'review' || next.stage !== 'review') throw new Error('Publication requires a reviewed checkpoint');
    } else {
      const allowed = stage === 'warranty' ? 'generate' : stage === 'review' ? 'repair' : 'review';
      if (next.stage !== allowed) throw new Error('Invalid review stage transition');
      if (next.stage === 'repair' && reviewRequestBudget(reference) === 1) throw new Error('Review repair allowance is exhausted');
    }
    add(next.inputIds);
  }
  if (covered.size !== expected.size) throw new Error('Review transition lost inputs');
}

/** All response confirmation, checkpoints and following batches commit in one transaction. */
export async function executeReviewCheckpoint(database: Kysely<DatabaseSchema>, input: ReviewCheckpointInput): Promise<void> {
  await database.transaction().execute(async tx => {
    const job = await tx.selectFrom('ai_jobs').selectAll().where('id', '=', input.jobId).forUpdate().executeTakeFirstOrThrow();
    assertCurrentPipeline(job);
    if (job.pause_requested || job.cancel_requested || ['paused', 'cancelled', 'failed', 'succeeded'].includes(job.status)) {
      throw new Error(`job status ${job.status} cannot checkpoint results`);
    }
    const batch = await tx.selectFrom('ai_job_batches').selectAll().where('id', '=', input.batchId)
      .where('job_id', '=', input.jobId).forUpdate().executeTakeFirstOrThrow();
    assertBatchClaim(batch, input.claim, 'request');
    if (!batch.reference_snapshot || typeof batch.reference_snapshot !== 'object' || Array.isArray(batch.reference_snapshot)) {
      throw new Error('Review reference is not frozen');
    }
    const reference = batch.reference_snapshot;
    const stage = readReviewStage(reference);
    if (input.stage !== undefined && input.stage !== stage) throw new Error('Review checkpoint stage does not match frozen batch');
    if (batch.unknown_requests !== 0 || batch.request_budget_used - batch.confirmed_requests !== 1
      || batch.request_budget_used > batch.request_budget_limit) throw new Error('Review checkpoint requires one unresolved request');
    const expected = new Set((batch.product_ids as string[]).map(String));
    const supplied = new Set(input.inputIds.map(String));
    if (supplied.size !== input.inputIds.length || expected.size !== supplied.size || [...supplied].some(id => !expected.has(id))) {
      throw new Error('Review decision does not match batch inputs');
    }
    const plan = await input.plan({ tx, job, batch, stage, reference });
    assertCoverage(stage, expected, plan, reference, input.reviewRequired?.(job) ?? true);
    if (plan.publication?.plan) {
      const publication = plan.publication;
      const members = publication.inputIds.length ? await tx.selectFrom('ai_job_input_members').select('product_id')
        .where('job_id', '=', job.id).where('input_id', 'in', publication.inputIds).execute() : [];
      const expectedProducts = new Set(members.map(member => String(member.product_id)));
      const publishedProducts = publication.plan!.units.flatMap(unit => unit.productIds.map(String));
      if (publishedProducts.length !== expectedProducts.size || new Set(publishedProducts).size !== publishedProducts.length
        || publishedProducts.some(id => !expectedProducts.has(id))) throw new Error('Review publication scope does not match its inputs');
    }
    const metadata = input.metadata ?? {};
    const responseCompletedAt = metadata.responseMs != null && Number.isFinite(metadata.responseMs) ? new Date() : null;
    const firstContentAt = responseCompletedAt && metadata.firstContentMs != null && Number.isFinite(metadata.firstContentMs)
      ? new Date(responseCompletedAt.getTime() - Math.max(0, metadata.responseMs! - metadata.firstContentMs)) : null;
    const publication = plan.publication;
    await tx.updateTable('ai_job_batches').set({
      confirmed_requests: batch.confirmed_requests + 1,
      validated_decision: jsonb(plan.document), decision_hash: createHash('sha256').update(JSON.stringify(plan.document)).digest('hex'),
      decision_saved_at: sql`now()`, first_content_at: firstContentAt, response_completed_at: responseCompletedAt,
      response_diagnostic: metadata.responseDiagnostic ? jsonb(metadata.responseDiagnostic as unknown as JsonValue) : null,
      response_usage: metadata.usage ? jsonb(metadata.usage) : null, response_model: metadata.responseModel ?? null,
      response_id: metadata.responseId ?? null,
      response_ms: metadata.responseMs != null && Number.isFinite(metadata.responseMs) ? Math.max(0, Math.round(metadata.responseMs)) : null,
      step: publication ? 'publish' : 'done', status: publication ? 'queued' : 'succeeded',
      attempts: publication ? 0n : batch.attempts, available_at: sql`now()`, finished_at: publication ? null : sql`now()`,
      claimed_by: null, claim_token: null, lease_until: null, error: null, error_source: null, retry_class: metadata.retryClass ?? null,
      ...(publication?.plan ? {
        publication_cursor: 0,
        publication_plan: jsonb({ hash: publication.plan.planHash, units: publication.plan.units.map(unit => ({
          productIds: unit.productIds.map(String), memberCount: unit.memberCount, tagCount: unit.tagCount,
          payloadBytes: unit.payloadBytes, sqlParameters: unit.sqlParameters,
        })) }),
      } : {}),
    }).where('id', '=', batch.id).execute();
    for (const [index, unit] of (publication?.plan?.units ?? []).entries()) {
      await tx.insertInto('ai_publication_units').values({
        batch_id: batch.id, unit_index: index, product_ids: jsonb(unit.productIds.map(String)), member_count: unit.memberCount,
        tag_count: unit.tagCount, payload_bytes: BigInt(unit.payloadBytes),
      }).execute();
    }
    if (plan.next.length) {
      const maximum = await tx.selectFrom('ai_job_batches').select(sql<bigint>`coalesce(max(batch_index), -1)`.as('index'))
        .where('job_id', '=', job.id).executeTakeFirstOrThrow();
      const members = await tx.selectFrom('ai_job_input_members').select(['input_id', sql<string>`count(*)`.as('count')])
        .where('job_id', '=', job.id).where('input_id', 'in', input.inputIds).groupBy('input_id').execute();
      const sizes = await tx.selectFrom('ai_job_inputs').select(['input_id', 'input_bytes', 'estimated_tokens'])
        .where('job_id', '=', job.id).where('input_id', 'in', input.inputIds).execute();
      let nextIndex = maximum.index;
      for (const next of plan.next) {
        const ids = new Set(next.inputIds.map(String));
        const nextReference: Record<string, JsonValue> = { ...reference, ...next.reference, reviewStage: next.stage };
        for (const key of ['proposalBatchId', 'repairReviewBatchId', 'reviewRepairRound', 'warrantyBatchId']) {
          if (reference[key] === undefined) delete nextReference[key];
          else nextReference[key] = reference[key];
        }
        if (reference.repairReviewBatchId !== undefined) {
          nextReference.repairReviewBatchId = reference.repairReviewBatchId;
          nextReference.reviewRepairRound = 1;
        }
        if (next.document === undefined && next.stage === 'review') nextReference.proposalBatchId = String(batch.id);
        if (next.stage === 'repair') {
          delete nextReference.proposalBatchId;
          nextReference.repairReviewBatchId = String(batch.id);
          nextReference.reviewRepairRound = 1;
        }
        if (stage === 'warranty') nextReference.warrantyBatchId = String(batch.id);
        await tx.insertInto('ai_job_batches').values({
          job_id: job.id, batch_index: ++nextIndex, product_ids: jsonb([...ids]),
          product_count: members.filter(member => ids.has(String(member.input_id))).reduce((sum, member) => sum + BigInt(member.count), 0n),
          input_bytes: next.inputBytes === undefined ? sizes.filter(row => ids.has(String(row.input_id))).reduce((sum, row) => sum + row.input_bytes, 0n) : BigInt(next.inputBytes),
          estimated_tokens: next.estimatedTokens === undefined ? sizes.filter(row => ids.has(String(row.input_id))).reduce((sum, row) => sum + row.estimated_tokens, 0n) : BigInt(next.estimatedTokens),
          round: 1, status: 'queued', step: next.document === undefined ? 'request' : 'publish',
          request_budget_limit: reviewRequestBudget(nextReference), reference_snapshot: jsonb(nextReference),
          reference_version: next.referenceVersion === undefined ? batch.reference_version : next.referenceVersion,
          ...(next.estimate ? { planned_at: sql<Date>`now()`, request_estimate: jsonb(next.estimate) } : {}),
          ...(next.document === undefined ? {} : {
            validated_decision: jsonb(next.document),
            decision_hash: createHash('sha256').update(JSON.stringify(next.document)).digest('hex'), decision_saved_at: sql<Date>`now()`,
          }),
        }).execute();
      }
    }
    await incrementJobProgress(tx, { jobId: job.id });
  });
}

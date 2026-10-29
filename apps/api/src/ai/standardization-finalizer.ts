import { DomainNotFoundError } from '../common/errors.js';
import { createTagJob } from './tag-extraction-jobs.js';
import { buildTagExtractionOutcome, tagExtractionVersions } from './tag-extraction-result.js';
import { sql, type Kysely, type Transaction } from 'kysely';
import { jsonb, type DatabaseSchema, type JsonValue } from '../database/types.js';
import { readAiBatchLimits } from '../config/env.js';
import { planIndependentStandardizationBatches } from './standardization-batch-planner.js';
import { unknownRequestReason } from './request-outcome.js';
import type { ParsedStandardizationResponse, StandardizationDecision } from './ai.schemas.js';
import { isReviewableStandardizationDecision } from './standardization-review-request.js';
import { readAiStandardizationFeatures } from './ai-standardization-features.js';

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) result.push(items.slice(offset, offset + size));
  return result;
}

function terminalReason(errorSource: string | null, error?: string | null): { code: string; reason: string } {
  if (errorSource === 'provider_policy_rejection') return { code: 'provider_policy_rejection', reason: '服务方明确拒绝该请求；不自动重发相同内容' };
  if (errorSource === 'input_too_large') return { code: 'input_too_large', reason: '完整请求超过本地安全预算，需要减少候选或拆分证据范围' };
  if (errorSource === 'invalid_response') {
    return { code: 'invalid_response', reason: error?.slice(0, 1000) || '模型返回格式未通过校验' };
  }
  if (errorSource === 'request_outcome_unknown' || errorSource === 'provider_unknown') {
    return { code: 'request_outcome_unknown', reason: unknownRequestReason(error) };
  }
  if (errorSource === 'result_not_saved') {
    return { code: 'result_not_saved', reason: '模型响应未能完整保存' };
  }
  if (errorSource === 'local') {
    return { code: 'publication_error', reason: '本地发布重试耗尽' };
  }
  return { code: 'provider_error', reason: '模型请求失败或请求预算耗尽' };
}

async function materializeFailedBatch(
  tx: Transaction<DatabaseSchema>,
  jobId: bigint,
  batch: { id: bigint; product_ids: JsonValue; error_source: string | null; error?: string | null; reference_snapshot?: JsonValue | null },
): Promise<void> {
  const inputIds = (batch.product_ids as string[]).map(BigInt);
  if (!inputIds.length) return;
  const job = await tx.selectFrom('ai_jobs').select(['job_type', 'pipeline_versions']).where('id', '=', jobId).executeTakeFirstOrThrow();
  const reference = batch.reference_snapshot as { standardizationStage?: string; generationBatchId?: string } | null | undefined;
  const review = job.job_type !== 'tag_extraction' && reference?.standardizationStage === 'review';
  const members = await tx.selectFrom('ai_job_input_members')
    .select(['input_id', 'product_id', 'content_version', 'fingerprint', 'standardization_revision'])
    .where('job_id', '=', jobId)
    .where('input_id', 'in', inputIds)
    .where('status', 'not in', ['classified', 'unclassified', 'cancelled'])
    // An attached missing input may already be queued for its generation retry.
    .$if(review, query => query.where(sql<boolean>`not exists (select 1 from ai_standardization_results r
      where r.job_id = ${jobId} and r.product_id = ai_job_input_members.product_id and r.batch_id = ${batch.id})`))
    .orderBy('product_id')
    .execute();
  if (!members.length) return;
  const terminal = terminalReason(batch.error_source, batch.error);
  if (job.job_type === 'tag_extraction') {
    await tx.updateTable('ai_job_inputs').set({ status: 'failed', reason_code: terminal.code, error: terminal.reason }).where('job_id', '=', jobId).where('input_id', 'in', members.map(member => member.input_id)).execute();
    for (const member of members) await tx.updateTable('ai_job_input_members').set({ status: 'failed', reason_code: terminal.code, output: jsonb({ ...buildTagExtractionOutcome({ productId: member.input_id, tags: [], rejectedTags: [] }, [], { outcome: 'failed', reasonCode: terminal.code }), versions: tagExtractionVersions(member, job.pipeline_versions) } as unknown as JsonValue) }).where('job_id', '=', jobId).where('product_id', '=', member.product_id).where('output', 'is', null).execute();
    return;
  }
  const preserved = new Map<bigint, StandardizationDecision>();
  if (review) {
    if (!reference?.generationBatchId || !/^[1-9]\d*$/u.test(reference.generationBatchId)) throw new Error('standardization review source is invalid');
    const generation = await tx.selectFrom('ai_job_batches').select(['validated_decision', 'step', 'status'])
      .where('id', '=', BigInt(reference.generationBatchId)).where('job_id', '=', jobId).executeTakeFirstOrThrow();
    if (generation.step !== 'done' || generation.status !== 'succeeded' || !generation.validated_decision) throw new Error('standardization generation checkpoint is unavailable');
    const document = generation.validated_decision as unknown as ParsedStandardizationResponse;
    const items = new Map(document.items.map(item => [item.id, item]));
    const missing = new Set(document.missingIds);
    for (const inputId of new Set(members.map(member => member.input_id))) {
      const id = String(inputId), item = items.get(id);
      if (missing.has(id)) preserved.set(inputId, {
        id, status: 'unclassified', ruleIds: [], evidence: [], reasonCode: 'missing_id', reason: '模型响应未包含该商品',
      });
      else if (item && !isReviewableStandardizationDecision(item)) preserved.set(inputId, item);
    }
  }
  const decision = (inputId: bigint) => jsonb((preserved.get(inputId) ?? {
    id: inputId.toString(), status: 'unclassified', ruleIds: [], evidence: [],
    reasonCode: terminal.code, reason: terminal.reason,
  }) as unknown as JsonValue);
  for (const batchMembers of chunks(members, 500)) {
    await tx.insertInto('ai_standardization_results').values(batchMembers.map(member => ({
      job_id: jobId,
      product_id: member.product_id,
      batch_id: batch.id,
      input_id: member.input_id,
      content_version: member.content_version,
      fingerprint: member.fingerprint,
      status: 'unclassified' as const,
      standard_product_id: null,
      tags: jsonb([]),
      evidence: jsonb((preserved.get(member.input_id)?.evidence ?? []) as unknown as JsonValue),
      reason_code: preserved.get(member.input_id)?.reasonCode ?? terminal.code,
      reason: preserved.get(member.input_id)?.reason ?? terminal.reason,
      decision: decision(member.input_id),
      current_assignment_preserved: true,
      published_at: sql`now()`,
    }))).onConflict(conflict => conflict.columns(['job_id', 'product_id']).doUpdateSet(eb => ({
      batch_id: eb.ref('excluded.batch_id'),
      input_id: eb.ref('excluded.input_id'),
      content_version: eb.ref('excluded.content_version'),
      fingerprint: eb.ref('excluded.fingerprint'),
      status: eb.ref('excluded.status'),
      standard_product_id: null,
      tags: eb.ref('excluded.tags'),
      evidence: eb.ref('excluded.evidence'),
      reason_code: eb.ref('excluded.reason_code'),
      reason: eb.ref('excluded.reason'),
      decision: eb.ref('excluded.decision'),
      current_assignment_preserved: true,
      published_at: sql`now()`,
    }))).execute();
  }
  await tx.updateTable('ai_job_inputs').set({ status: 'failed', reason_code: terminal.code, error: terminal.reason })
    .where('job_id', '=', jobId).where('input_id', 'in', inputIds).execute();
  for (const productIds of chunks(members.map(member => member.product_id), 500)) {
    await tx.updateTable('ai_job_input_members').set({ status: 'unclassified', reason_code: terminal.code })
      .where('job_id', '=', jobId).where('product_id', 'in', productIds).execute();
    await tx.updateTable('ai_standardization_executions').set({ status: 'completed', completed_at: sql`now()` })
      .where('job_id', '=', jobId).where('product_id', 'in', productIds).execute();
  }
  for (const [inputId, item] of preserved) {
    await tx.updateTable('ai_job_inputs').set({
      status: item.reasonCode === 'missing_id' ? 'succeeded' : 'failed', reason_code: item.reasonCode,
      error: item.reasonCode === 'missing_id' ? null : item.reason,
    }).where('job_id', '=', jobId).where('input_id', '=', inputId).execute();
    await tx.updateTable('ai_job_input_members').set({ reason_code: item.reasonCode })
      .where('job_id', '=', jobId).where('product_id', 'in', members.filter(member => member.input_id === inputId).map(member => member.product_id)).execute();
  }
}

/** Finish an inactive standardization job or atomically create its only missing-ID retry round. */
export async function finalizeOrScheduleMissing(tx: Transaction<DatabaseSchema>, jobId: bigint): Promise<void> {
  const job = await tx.selectFrom('ai_jobs')
    .select(['id', 'status', 'pause_requested', 'cancel_requested', 'configuration_blocked', 'job_type', 'pipeline_versions'])
    .where('id', '=', jobId).forUpdate().executeTakeFirstOrThrow();
  if (job.pause_requested || job.cancel_requested || job.configuration_blocked
    || ['paused', 'cancelled', 'failed', 'succeeded', 'ready_with_errors'].includes(job.status)) return;

  const active = await tx.selectFrom('ai_job_batches').select('id')
    .where('job_id', '=', jobId).where('status', 'in', ['queued', 'running']).executeTakeFirst();

  const failed = await tx.selectFrom('ai_job_batches')
    .select(['id', 'product_ids', 'error_source', 'error', 'reference_snapshot'])
    .where('job_id', '=', jobId).where('status', '=', 'failed').orderBy('id').execute();
  for (const batch of failed) await materializeFailedBatch(tx, jobId, batch);
  // Failed products must be visible to the global retry pool before unrelated batches finish.
  if (active) return;

  const existingRoundOne = await tx.selectFrom('ai_job_batches').select('id')
    .where('job_id', '=', jobId).where('round', '=', 1)
    .where(sql<boolean>`reference_snapshot->>'standardizationStage' is distinct from 'review'`).executeTakeFirst();
  const missingRows = existingRoundOne ? [] : await tx.selectFrom('ai_job_input_members as m')
    .innerJoin('ai_job_inputs as i', join => join.onRef('i.job_id', '=', 'm.job_id').onRef('i.input_id', '=', 'm.input_id'))
    .select(['m.input_id', 'm.product_id', 'm.content_version', 'm.fingerprint', 'm.standardization_revision', 'i.payload', 'i.input_bytes', 'i.estimated_tokens'])
    .where('m.job_id', '=', jobId).where('m.reason_code', '=', 'missing_id')
    .where('m.missing_reprocess_count', '=', 0).where('i.round', '=', 0)
    .orderBy('m.input_id').orderBy('m.product_id').execute();
  if (missingRows.length) {
    const inputIds = [...new Set(missingRows.map(row => row.input_id.toString()))].map(BigInt);
    const byInput = new Map<string, { members: number; payload: JsonValue; inputBytes: bigint; estimatedTokens: bigint }>();
    for (const row of missingRows) byInput.set(row.input_id.toString(), {
      members: (byInput.get(row.input_id.toString())?.members ?? 0) + 1,
      payload: row.payload, inputBytes: row.input_bytes,
      estimatedTokens: row.estimated_tokens,
    });
    const original = await tx.selectFrom('ai_job_batches')
      .select(sql<number>`max(jsonb_array_length(product_ids))::int`.as('max_items'))
      .where('job_id', '=', jobId).where('round', '=', 0).executeTakeFirstOrThrow();
    const limits = readAiBatchLimits();
    // The caller's batchSize is not stored; original batches give a safe upper bound.
    const maxItems = Math.min(limits.maxItems, original.max_items);
    const planned = planIndependentStandardizationBatches(inputIds.map(id => ({
      productId: id, payload: byInput.get(id.toString())!.payload,
      inputBytes: Number(byInput.get(id.toString())!.inputBytes),
      estimatedTokens: Number(byInput.get(id.toString())!.estimatedTokens),
    })), { ...limits, maxItems });
    const plannedIds = new Set(planned.flatMap(batch => batch.productIds.map(String)));
    const oversizedIds = inputIds.filter(id => !plannedIds.has(id.toString()));
    if (oversizedIds.length) {
      const reason = '商品输入超过单次标准化安全预算';
      const oversizedSet = new Set(oversizedIds.map(String));
      for (const ids of chunks(oversizedIds, 500)) {
        await tx.updateTable('ai_job_inputs').set({
          round: 1, status: 'failed', missing_reprocess_count: 1, reason_code: 'input_too_large', error: 'input_too_large',
        }).where('job_id', '=', jobId).where('input_id', 'in', ids).execute();
        await tx.updateTable('ai_job_input_members').set({
          status: 'unclassified', missing_reprocess_count: 1, reason_code: 'input_too_large',
        }).where('job_id', '=', jobId).where('input_id', 'in', ids).where('reason_code', '=', 'missing_id').where('missing_reprocess_count', '=', 0).execute();
      }
      const oversizedMembers = missingRows.filter(row => oversizedSet.has(row.input_id.toString()));
      for (const members of chunks(oversizedMembers, 500)) {
        if (job.job_type === 'tag_extraction') {
          for (const member of members) await tx.updateTable('ai_job_input_members').set({ output: jsonb({ ...buildTagExtractionOutcome({ productId: member.input_id, tags: [], rejectedTags: [] }, [], { outcome: 'failed', reasonCode: 'input_too_large' }), versions: tagExtractionVersions(member, job.pipeline_versions) } as unknown as JsonValue) }).where('job_id', '=', jobId).where('product_id', '=', member.product_id).execute();
          continue;
        }
        await tx.insertInto('ai_standardization_results').values(members.map(member => ({
          job_id: jobId, product_id: member.product_id, batch_id: null, input_id: member.input_id,
          content_version: member.content_version, fingerprint: member.fingerprint, status: 'unclassified' as const,
          standard_product_id: null, tags: jsonb([]), evidence: jsonb([]),
          reason_code: 'input_too_large', reason,
          decision: jsonb({ id: member.input_id.toString(), status: 'unclassified', ruleIds: [], evidence: [], reasonCode: 'input_too_large', reason }),
          current_assignment_preserved: true, published_at: sql`now()`,
        }))).onConflict(conflict => conflict.columns(['job_id', 'product_id']).doUpdateSet(eb => ({
          batch_id: null, input_id: eb.ref('excluded.input_id'), content_version: eb.ref('excluded.content_version'),
          fingerprint: eb.ref('excluded.fingerprint'), status: eb.ref('excluded.status'), standard_product_id: null,
          tags: eb.ref('excluded.tags'), evidence: eb.ref('excluded.evidence'), reason_code: eb.ref('excluded.reason_code'),
          reason: eb.ref('excluded.reason'), decision: eb.ref('excluded.decision'), current_assignment_preserved: true,
          published_at: sql`now()`,
        }))).execute();
        await tx.updateTable('ai_standardization_executions').set({ status: 'completed', completed_at: sql`now()` })
          .where('job_id', '=', jobId).where('product_id', 'in', members.map(member => member.product_id)).execute();
      }
    }
    if (planned.length) {
      const retryIds = planned.flatMap(batch => batch.productIds);
      for (const ids of chunks(retryIds, 500)) {
        await tx.updateTable('ai_job_inputs').set({
          round: 1, status: 'queued', missing_reprocess_count: 1, reason_code: null, error: null,
        }).where('job_id', '=', jobId).where('input_id', 'in', ids)
          .where('round', '=', 0).where('missing_reprocess_count', '=', 0).execute();
        await tx.updateTable('ai_job_input_members').set({
          status: 'queued', missing_reprocess_count: 1, reason_code: null, ...(job.job_type === 'tag_extraction' ? { output: null } : {}),
        }).where('job_id', '=', jobId).where('input_id', 'in', ids)
          .where('missing_reprocess_count', '=', 0).where('reason_code', '=', 'missing_id').execute();
      }
      const start = await tx.selectFrom('ai_job_batches')
        .select(sql<bigint>`coalesce(max(batch_index), -1) + 1`.as('next'))
        .where('job_id', '=', jobId).executeTakeFirstOrThrow();
      for (const [offset, batch] of planned.entries()) {
        await tx.insertInto('ai_job_batches').values({
          job_id: jobId, batch_index: start.next + BigInt(offset),
          product_ids: jsonb(batch.productIds.map(String)),
          product_count: BigInt(batch.productIds.reduce((sum, id) => sum + byInput.get(id.toString())!.members, 0)),
          input_bytes: BigInt(batch.inputBytes), estimated_tokens: BigInt(batch.estimatedTokens),
          status: 'queued', round: 1, step: 'request', request_budget_limit: 1,
        }).execute();
      }
      return;
    }
  }

  const counts = await tx.selectFrom('ai_standardization_results')
    .select(['status', sql<number>`count(*)::int`.as('count')])
    .where('job_id', '=', jobId).groupBy('status').execute();
  const classified = counts.find(row => row.status === 'classified')?.count ?? 0;
  const unclassified = counts.find(row => row.status === 'unclassified')?.count ?? 0;
  const failedInput = await tx.selectFrom('ai_job_inputs').select('input_id')
    .where('job_id', '=', jobId).where('status', '=', 'failed').executeTakeFirst();
  const parentJob = await tx.selectFrom('ai_jobs').select(['model', 'job_type', 'pipeline_versions', 'total'])
    .where('id', '=', jobId).executeTakeFirstOrThrow();

  // Tag results count original members, independently of input deduplication or request batches.
  let jobClassified = classified, jobUnclassified = unclassified;
  if (parentJob.job_type === 'tag_extraction') {
    const memberCounts = await tx.selectFrom('ai_job_input_members')
      .select(['status', sql<number>`count(*)::int`.as('count')])
      .where('job_id', '=', jobId).groupBy('status').execute();
    jobClassified = memberCounts.find(row => row.status === 'classified')?.count ?? 0;
    jobUnclassified = memberCounts.filter(row => ['failed', 'unclassified'].includes(row.status)).reduce((sum, row) => sum + row.count, 0);
  }

  await tx.updateTable('ai_jobs').set({
    status: failed.length || failedInput ? 'ready_with_errors' : 'succeeded',
    phase: 'completed',
    processed: BigInt(jobClassified + jobUnclassified),
    classified: BigInt(jobClassified),
    unclassified: BigInt(jobUnclassified),
    failed_batches: BigInt(failed.length),
    finished_at: sql`now()`,
  }).where('id', '=', jobId).execute();

  // Schedule tag extraction for classified products, but only from standardization jobs
  // (not from tag_extraction jobs themselves, to avoid infinite loops).
  if (classified > 0 && parentJob.job_type !== 'tag_extraction' && readAiStandardizationFeatures().tagExtractionEnabled) {
    await scheduleTagExtractionForJob(tx, jobId, parentJob.model);
  }
}

/** Create a tag_extraction job for all classified products from the given standardization job. */
async function scheduleTagExtractionForJob(tx: Transaction<DatabaseSchema>, sourceJobId: bigint, model: string): Promise<void> {
  const classifiedProducts = await tx.selectFrom('ai_standardization_results as r')
    .innerJoin('products as p', 'p.id', 'r.product_id')
    .innerJoin('shops as s', 's.id', 'p.shop_id')
    .select(['p.id', 'p.name', 'p.spec', 'p.source_category', 'p.source_data', 'p.content_version', 'p.standardization_revision'])
    .where('r.job_id', '=', sourceJobId)
    .where('r.status', '=', 'classified')
    .where('p.deleted_at', 'is', null)
    .where('s.deleted_at', 'is', null)
    .where('s.enabled', '=', true)
    .orderBy('p.id')
    .execute();
  if (!classifiedProducts.length) return;

  try {
    await createTagJob(tx,{model,productIds:classifiedProducts.map(p=>p.id),parentIdentityJobId:sourceJobId});
  } catch(error) {
    if (!(error instanceof DomainNotFoundError)) throw error;
  }
}

/**
 * Fail running request batches whose lease expired with a request budget the claim
 * window can never readmit. A crash between the unknown-outcome commit and the
 * terminal failure marking leaves such rows blocking the rolling window head forever.
 * Abandoned rows are unclaimable by definition, so the only concurrent writer is
 * another reaper: the outer status re-check keeps repeated sweeps a no-op without
 * row locks (which would contend with the claim path's job-then-batch lock order).
 */
export async function recoverAbandonedStandardizationBatches(database: Kysely<DatabaseSchema>, limit = 100): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit must be positive');
  const result = await sql<{ id: bigint }>`
    with abandoned as (
      select q.id
      from ai_job_batches q
      join ai_jobs j on j.id = q.job_id
      where q.status = 'running' and q.step = 'request'
        and (q.lease_until is null or q.lease_until <= now())
        and not (q.request_budget_used < q.request_budget_limit and q.unknown_requests = 0)
        and j.status not in ('paused', 'cancelled', 'failed', 'succeeded')
        and not j.pause_requested and not j.cancel_requested
      order by q.id
      limit ${limit}
    )
    update ai_job_batches q
    set status = 'failed',
        error_source = case
          when q.unknown_requests > 0 or q.request_budget_used > q.confirmed_requests + q.unknown_requests
            then 'request_outcome_unknown'
          else 'request_budget_exhausted'
        end,
        error = case
          when q.unknown_requests > 0 or q.request_budget_used > q.confirmed_requests + q.unknown_requests
            then 'request_outcome_unknown'
          else 'request_budget_exhausted'
        end,
        claimed_by = null, claim_token = null, lease_until = null, finished_at = now()
    from abandoned
    where q.id = abandoned.id and q.status = 'running'
    returning q.id
  `.execute(database);
  return result.rows.length;
}

/** Recover jobs whose last terminal batch committed before job finalization did. */
export async function recoverStandardizationFinalization(database: Kysely<DatabaseSchema>, limit = 100): Promise<number> {
  const jobs = await database.selectFrom('ai_jobs as j').select('j.id')
    .where('j.status', 'in', ['queued', 'running'])
    .where('j.phase', '=', 'standardizing')
    .where('j.pause_requested', '=', false)
    .where('j.cancel_requested', '=', false)
    .where('j.configuration_blocked', '=', false)
    .where(sql<boolean>`not exists (
      select 1 from ai_job_batches b where b.job_id = j.id and b.status in ('queued', 'running')
    )`)
    .orderBy('j.id').limit(limit).execute();
  for (const job of jobs) {
    await database.transaction().execute(tx => finalizeOrScheduleMissing(tx, job.id));
  }
  return jobs.length;
}

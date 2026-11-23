import { isAttributeJobType } from '../database/types.js';
import { DomainNotFoundError } from '../common/errors.js';
import { createTagJob, createMembershipFeatureJob, createProductTextReviewJob } from './tag-extraction-jobs.js';
import { buildTagExtractionOutcome, tagExtractionVersions } from './tag-extraction-result.js';
import { sql, type Kysely, type Transaction } from 'kysely';
import { jsonb, type DatabaseSchema, type JsonValue } from '../database/types.js';
import { unknownRequestReason } from './request-outcome.js';
import { readAiStandardizationFeatures } from './ai-standardization-features.js';
import { assertCurrentPipeline, currentExecutionPipeline } from './pipeline-versions.js';
import { readCurrentMembershipFeatures } from '../standardization/membership-classification.js';
import { hasUsableOffer } from './offer-eligibility.js';

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
  const reference = batch.reference_snapshot as { reviewStage?: string } | null | undefined;
  const review = !isAttributeJobType(job.job_type) && reference?.reviewStage === 'review';
  const members = await tx.selectFrom('ai_job_input_members')
    .select(['input_id', 'product_id', 'content_version', 'fingerprint', 'standardization_revision'])
    .where('job_id', '=', jobId)
    .where('input_id', 'in', inputIds)
    .where('status', 'not in', ['classified', 'unclassified', 'cancelled'])
    .$if(review, query => query.where(sql<boolean>`not exists (select 1 from ai_standardization_results r
      where r.job_id = ${jobId} and r.product_id = ai_job_input_members.product_id and r.batch_id = ${batch.id})`)
      .where(sql<boolean>`not exists (select 1 from ai_job_batches repair
        where repair.job_id = ${jobId} and repair.reference_snapshot->>'repairReviewBatchId' = ${String(batch.id)}
          and repair.product_ids @> jsonb_build_array(ai_job_input_members.input_id::text))`))
    .orderBy('product_id')
    .execute();
  if (!members.length) return;
  const terminal = terminalReason(batch.error_source, batch.error);
  if (isAttributeJobType(job.job_type)) {
    await tx.updateTable('ai_job_inputs').set({ status: 'failed', reason_code: terminal.code, error: terminal.reason }).where('job_id', '=', jobId).where('input_id', 'in', members.map(member => member.input_id)).execute();
    for (const member of members) {
      const before = job.job_type === 'tag_extraction'
        ? await tx.selectFrom('product_tags').select(['name', 'value']).where('product_id', '=', member.product_id).execute() : [];
      await tx.updateTable('ai_job_input_members').set({ status: 'failed', reason_code: terminal.code,
        output: jsonb({ ...buildTagExtractionOutcome({ productId: member.input_id, tags: [], rejectedTags: [] }, before,
          { outcome: 'failed', reasonCode: terminal.code }), versions: tagExtractionVersions(member, job.pipeline_versions) } as unknown as JsonValue),
      }).where('job_id', '=', jobId).where('product_id', '=', member.product_id).where('output', 'is', null).execute();
    }
    return;
  }
  const decision = (inputId: bigint) => jsonb({
    id: inputId.toString(), status: 'unclassified', ruleIds: [], evidence: [],
    reasonCode: terminal.code, reason: terminal.reason,
  });
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
      evidence: jsonb([]),
      reason_code: terminal.code,
      reason: terminal.reason,
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
    .where('job_id', '=', jobId).where('input_id', 'in', members.map(member => member.input_id)).execute();
  for (const productIds of chunks(members.map(member => member.product_id), 500)) {
    await tx.updateTable('ai_job_input_members').set({ status: 'unclassified', reason_code: terminal.code })
      .where('job_id', '=', jobId).where('product_id', 'in', productIds).execute();
    await tx.updateTable('ai_standardization_executions').set({ status: 'completed', completed_at: sql`now()` })
      .where('job_id', '=', jobId).where('product_id', 'in', productIds).execute();
  }
}

/** Finish inactive jobs after every validated stage reaches a terminal state. */
export async function finalizeAiJob(tx: Transaction<DatabaseSchema>, jobId: bigint): Promise<void> {
  const job = await tx.selectFrom('ai_jobs')
    .select(['id', 'status', 'pause_requested', 'cancel_requested', 'configuration_blocked', 'job_type', 'pipeline_versions', 'prompt_version', 'rule_version'])
    .where('id', '=', jobId).forUpdate().executeTakeFirstOrThrow();
  if (job.pause_requested || job.cancel_requested || job.configuration_blocked
    || ['paused', 'cancelled', 'failed', 'succeeded', 'ready_with_errors'].includes(job.status)) return;
  assertCurrentPipeline(job);

  const failed = await tx.selectFrom('ai_job_batches')
    .select(['id', 'product_ids', 'error_source', 'error', 'reference_snapshot'])
    .where('job_id', '=', jobId).where('status', '=', 'failed').orderBy('id').execute();
  for (const batch of failed) await materializeFailedBatch(tx, jobId, batch);
  // Failed products must be visible to the global retry pool before unrelated batches finish.
  const active = await tx.selectFrom('ai_job_batches').select('id')
    .where('job_id', '=', jobId).where('status', 'in', ['queued', 'running']).executeTakeFirst();
  if (active) return;

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
  if (isAttributeJobType(parentJob.job_type)) {
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
  // Attribute jobs consume published identities without blocking identity publication.
  if (classified > 0 && !isAttributeJobType(parentJob.job_type)) {
    await scheduleAttributeJobs(tx, jobId, parentJob.model);
  }
}

export async function scheduleAttributeJobs(tx: Transaction<DatabaseSchema>, sourceJobId: bigint, model: string, restoredProductIds?: readonly bigint[]): Promise<void> {
  const classifiedProducts = await tx.selectFrom('products as p')
    .innerJoin('shops as s', 's.id', 'p.shop_id')
    .select(['p.id', 'p.membership_features', 'p.content_fingerprint', 'p.content_version', 'p.standardization_revision',
      's.url as shop_url', 's.protocol as shop_protocol', 's.platform as shop_platform'])
    .where(restoredProductIds
      ? sql<boolean>`p.id in (${sql.join(restoredProductIds)})`
      : sql<boolean>`exists (select 1 from ai_standardization_results r where r.product_id=p.id
          and r.job_id=${sourceJobId} and r.status='classified'
          and r.content_version=p.content_version and r.fingerprint=p.content_fingerprint)`)
    .where('p.deleted_at', 'is', null)
    .where('s.deleted_at', 'is', null)
    .where('s.enabled', '=', true)
    .where(hasUsableOffer())
    .orderBy('p.id')
    .execute();
  if (!classifiedProducts.length) return;

  for (const kind of ['membership_features', 'tag_extraction', 'text_review'] as const) {
    if (kind !== 'membership_features' && !readAiStandardizationFeatures().tagExtractionEnabled) continue;
    const covered = await tx.selectFrom('ai_job_input_members as m')
      .innerJoin('ai_jobs as j', 'j.id', 'm.job_id').innerJoin('products as p', 'p.id', 'm.product_id')
      .select('m.product_id').where('j.parent_identity_job_id', '=', sourceJobId).where('j.job_type', '=', kind)
      .whereRef('m.content_version', '=', 'p.content_version').whereRef('m.fingerprint', '=', 'p.content_fingerprint')
      .whereRef('m.standardization_revision', '=', 'p.standardization_revision').execute();
    const coveredIds = new Set(covered.map(member => member.product_id));
    const productIds = classifiedProducts.filter(product => !coveredIds.has(product.id)
      && (kind !== 'membership_features' || !readCurrentMembershipFeatures(product.membership_features, product))).map(product => product.id);
    if (!productIds.length) continue;
    const create = kind === 'membership_features' ? createMembershipFeatureJob
      : kind === 'text_review' ? createProductTextReviewJob : createTagJob;
    try {
      await create(tx, {model,productIds,parentIdentityJobId:sourceJobId});
    } catch(error) {
      if (!(error instanceof DomainNotFoundError)) throw error;
    }
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
        and ${currentExecutionPipeline()}
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
    .where(currentExecutionPipeline())
    .where(sql<boolean>`not exists (
      select 1 from ai_job_batches b where b.job_id = j.id and b.status in ('queued', 'running')
    )`)
    .orderBy('j.id').limit(limit).execute();
  for (const job of jobs) {
    await database.transaction().execute(tx => finalizeAiJob(tx, job.id));
  }
  return jobs.length;
}

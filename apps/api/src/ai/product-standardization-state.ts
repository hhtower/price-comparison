import { sql } from 'kysely';
import { unknownRequestReason } from './request-outcome.js';
import { PIPELINE_VERSIONS, STANDARDIZATION_POLICY_VERSION } from './pipeline-versions.js';
import type { EvidenceCitation } from './ai.schemas.js';
import { API_RELAY_EXCLUSION_CODE } from '../standardization/catalog-exclusion.js';

export const RETRYABLE_RESULT_REASONS = ['unmatched', 'request_outcome_unknown', 'invalid_response', 'provider_error', 'evidence_invalid', 'attribute_conflict', 'missing_id', 'result_not_saved'] as const;

export function productProcessingDisposition(reasonCode: unknown): 'review_required' | 'retry_available' | 'pending' | 'handled' {
  if (reasonCode === API_RELAY_EXCLUSION_CODE) return 'handled';
  if (reasonCode === 'identity_conflict' || reasonCode === 'publication_blocked' || reasonCode === 'review_rejected' || reasonCode === 'manual_decision_preserved' || reasonCode === 'input_too_large') return 'review_required';
  if (RETRYABLE_RESULT_REASONS.some(reason => reason === reasonCode)) return 'retry_available';
  return 'pending';
}

export interface ProductProcessingState {
  reasonCode: string;
  reason?: string | null;
  requestError?: string | null;
  manualReason?: string | null;
  evidence?: EvidenceCitation[] | null;
}

export interface ProductProcessingSummary {
  reasonCode: string;
  processingDisposition: ReturnType<typeof productProcessingDisposition>;
  reason: string;
  evidence?: EvidenceCitation[];
}

export function productProcessingSummary(state: ProductProcessingState): ProductProcessingSummary {
  const reason = state.reasonCode === 'manual_decision_preserved' ? state.manualReason || '保留当前证据版本的人工决定或持续锁定。'
    : state.reasonCode === 'not_processed' ? '尚无模型处理结果。'
    : state.reasonCode === 'source_changed' ? '商品资料或人工归类已变化，历史处理结果已过期。'
    : state.reasonCode === 'unassigned' ? '模型已返回结果，但当前没有已发布的有效归属。'
    : state.reasonCode === 'request_outcome_unknown' ? unknownRequestReason(state.requestError)
    : state.reason || '处理未完成，历史记录未提供具体原因。';
  return {
    reasonCode: state.reasonCode,
    processingDisposition: productProcessingDisposition(state.reasonCode),
    reason: reason.replace(/\s+/gu, ' ').trim().slice(0, 240),
    ...(!['manual_decision_preserved', 'source_changed', 'not_processed'].includes(state.reasonCode)
      && Array.isArray(state.evidence) && state.evidence.length > 0 ? { evidence: state.evidence } : {}),
  };
}

export function hasCurrentStandardizationResult(product = 'p') {
  return sql<boolean>`exists (select 1 from ai_standardization_results r
    join ai_job_input_members m on m.job_id = r.job_id and m.product_id = r.product_id
    join ai_jobs result_job on result_job.id = r.job_id
    where r.product_id = ${sql.ref(product + '.id')}
      and result_job.prompt_version = ${PIPELINE_VERSIONS.prompt} and result_job.rule_version = ${STANDARDIZATION_POLICY_VERSION}
      and result_job.pipeline_versions @> ${JSON.stringify(PIPELINE_VERSIONS)}::jsonb
      and r.content_version = ${sql.ref(product + '.content_version')}
      and m.content_version = ${sql.ref(product + '.content_version')}
      and r.fingerprint = ${sql.ref(product + '.content_fingerprint')}
      and m.fingerprint = ${sql.ref(product + '.content_fingerprint')}
      and m.standardization_revision = ${sql.ref(product + '.standardization_revision')})`;
}

export function hasPublishedAssignment(product = 'p') {
  return sql<boolean>`exists (select 1 from standard_product_members assignment
    join standard_products standard on standard.id = assignment.standard_product_id
    where assignment.product_id = ${sql.ref(product + '.id')}
      and assignment.publication_state = 'published'
      and standard.verification_state = 'verified' and standard.merged_into_id is null)`;
}

/** Isolation requires a current review or an explicit ongoing lock. */
export function hasManualIsolation(product = 'p') {
  return sql<boolean>`exists (select 1 from product_standardization_decisions d
    where d.product_id = ${sql.ref(product + '.id')} and d.action in ('quarantine', 'exclude')
      and (${sql.ref(product + '.standardization_locked')} or (d.evidence_known and d.content_version = ${sql.ref(product + '.content_version')}
        and d.content_fingerprint = ${sql.ref(product + '.content_fingerprint')}))
      and not exists (select 1 from product_standardization_decisions newer where newer.product_id = d.product_id and newer.id > d.id))`;
}

export function productStandardizationOutcome(product = 'p') {
  return sql<'classified' | 'cannot_process' | null>`case when ${hasPublishedAssignment(product)} then 'classified'
    when ${hasManualIsolation(product)} or ${hasCurrentRelayExclusion(product)} then 'cannot_process'
    else null end`;
}

export function hasCurrentRelayExclusion(product = 'p') {
  return sql<boolean>`coalesce((select r.reason_code = ${API_RELAY_EXCLUSION_CODE}
    from ai_standardization_results r
    join ai_job_input_members m on m.job_id = r.job_id and m.product_id = r.product_id
    join ai_jobs j on j.id = r.job_id
    where r.product_id = ${sql.ref(product + '.id')}
      and j.prompt_version = ${PIPELINE_VERSIONS.prompt} and j.rule_version = ${STANDARDIZATION_POLICY_VERSION}
      and j.pipeline_versions @> ${JSON.stringify(PIPELINE_VERSIONS)}::jsonb
      and r.content_version = ${sql.ref(product + '.content_version')} and m.content_version = r.content_version
      and r.fingerprint = ${sql.ref(product + '.content_fingerprint')} and m.fingerprint = r.fingerprint
      and m.standardization_revision = ${sql.ref(product + '.standardization_revision')}
    order by r.job_id desc limit 1), false)`;
}

export const hasActiveStandardizationWork = sql<boolean>`exists (select 1 from ai_job_input_members active
  join ai_jobs j on j.id = active.job_id
  where active.product_id = p.id and active.content_version = p.content_version
    and active.fingerprint = p.content_fingerprint
    and active.standardization_revision = p.standardization_revision
    and j.prompt_version = ${PIPELINE_VERSIONS.prompt} and j.rule_version = ${STANDARDIZATION_POLICY_VERSION}
    and j.pipeline_versions @> ${JSON.stringify(PIPELINE_VERSIONS)}::jsonb
    and j.status in ('queued', 'running', 'paused', 'ready') and not j.cancel_requested
    and (active.status in ('queued', 'processing') or exists (
      select 1 from ai_job_batches pending where pending.job_id = active.job_id
        and pending.status in ('queued', 'running') and pending.step <> 'done'
        and pending.product_ids @> jsonb_build_array(active.input_id::text))))`;

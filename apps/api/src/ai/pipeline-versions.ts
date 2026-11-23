import { DomainConflictError } from '../common/errors.js';
import { sql } from 'kysely';
import type { AiJobType, JsonValue } from '../database/types.js';
import { CATALOG_ALIAS_VERSION } from '../standardization/catalog-aliases.js';
import { STANDARDIZATION_SCHEMA_VERSION } from './ai.schemas.js';
import { STANDARDIZATION_PROMPT_VERSION } from './standardization-request.js';
import { TAG_EXTRACTION_PROMPT_VERSION, TAG_EXTRACTION_PROTOCOL_VERSION } from './tag-extraction-request.js';
import { TAG_REVIEW_PROMPT_VERSION } from './tag-review-request.js';
import { TAG_WARRANTY_PROMPT_VERSION } from './tag-warranty-request.js';
import { STANDARDIZATION_REVIEW_PROMPT_VERSION } from './standardization-review-request.js';
import { MEMBERSHIP_POLICY_VERSION } from '@price-comparison/catalog/membership-policy';
import { MEMBERSHIP_FEATURE_PROMPT_VERSION, MEMBERSHIP_FEATURE_REVIEW_PROMPT_VERSION } from './membership-feature-request.js';
import { PRODUCT_TEXT_REVIEW_PROMPT_VERSION } from './product-text-review-request.js';
import { REVIEW_WORKFLOW_VERSION } from './review-workflow.js';

export const EVIDENCE_PROJECTION_VERSION = 'evidence-task-projections-20261123-v4';
export const CANDIDATE_RETRIEVAL_VERSION = 'evidence-supplement-20261123-v3';
export const EVIDENCE_VALIDATION_VERSION = 'match-only-boundary-20261119-v1';
export const TAG_VALIDATION_VERSION = 'tag-explicit-warranty-20261117-v5';
export const STANDARDIZATION_POLICY_VERSION = 'standardization-evidence-review-20261123-v4';
export const PIPELINE_VERSIONS = Object.freeze({
  contentFingerprint: 'name-description-spec-20261028-v1',
  prompt: STANDARDIZATION_PROMPT_VERSION, schema: STANDARDIZATION_SCHEMA_VERSION,
  projection: EVIDENCE_PROJECTION_VERSION, retrieval: CANDIDATE_RETRIEVAL_VERSION,
  mapping: CATALOG_ALIAS_VERSION, standardizationPolicy: STANDARDIZATION_POLICY_VERSION,
  validation: EVIDENCE_VALIDATION_VERSION, tagPrompt: TAG_EXTRACTION_PROMPT_VERSION, tagProtocol: TAG_EXTRACTION_PROTOCOL_VERSION,
  tagReviewPrompt: TAG_REVIEW_PROMPT_VERSION,
  tagWarrantyPrompt: TAG_WARRANTY_PROMPT_VERSION,
  tagValidation: TAG_VALIDATION_VERSION,
  productTextReviewPrompt: PRODUCT_TEXT_REVIEW_PROMPT_VERSION,
  standardizationReviewPrompt: STANDARDIZATION_REVIEW_PROMPT_VERSION,
  membershipPolicy: MEMBERSHIP_POLICY_VERSION,
  membershipFeaturePrompt: MEMBERSHIP_FEATURE_PROMPT_VERSION,
  membershipFeatureReviewPrompt: MEMBERSHIP_FEATURE_REVIEW_PROMPT_VERSION,
  attributeOrder: 'standardization-first-20261112-v1',
  offerEligibility: 'latest-available-quote-20261123-v1',
  reviewWorkflow: REVIEW_WORKFLOW_VERSION,
});
/** Completed outputs depend on their business stage, not scheduling or other stages. */
export function taskResultVersions(kind: AiJobType | 'standardization'): Record<string, string> {
  if (kind === 'text_review') return { ...PIPELINE_VERSIONS };
  const { contentFingerprint, projection, prompt, schema, retrieval, mapping, standardizationPolicy, validation,
    standardizationReviewPrompt, tagPrompt, tagProtocol, tagReviewPrompt, tagWarrantyPrompt, tagValidation,
    membershipPolicy, membershipFeaturePrompt, membershipFeatureReviewPrompt } = PIPELINE_VERSIONS;
  if (kind === 'tag_extraction') return {
    contentFingerprint, projection, tagPrompt, tagProtocol, tagReviewPrompt, tagWarrantyPrompt, tagValidation,
  };
  if (kind === 'membership_features') return {
    contentFingerprint, projection, membershipPolicy, membershipFeaturePrompt, membershipFeatureReviewPrompt,
  };
  return { contentFingerprint, prompt, schema, projection, retrieval, mapping, standardizationPolicy, validation,
    standardizationReviewPrompt };
}
export function pipelineVersionSnapshot(model: string): JsonValue {
  return { ...PIPELINE_VERSIONS, requestedModel: model, applicationBuild: process.env.APP_BUILD_SHA ?? process.env.GIT_COMMIT ?? null };
}
export function taskExecutionVersions(kind: AiJobType): Record<string, string> {
  const { reviewWorkflow, offerEligibility, attributeOrder } = PIPELINE_VERSIONS;
  switch (kind) {
    case 'text_review': return { ...PIPELINE_VERSIONS };
    case 'incremental':
    case 'manual_full':
    case 'calibration':
    case 'tag_extraction':
    case 'membership_features':
      return { ...taskResultVersions(kind), reviewWorkflow, offerEligibility, attributeOrder };
    default: throw new Error('AI job type is required');
  }
}
export function isCurrentPipeline(snapshot: JsonValue | null, kind: AiJobType): boolean {
  return !!snapshot && !Array.isArray(snapshot) && typeof snapshot === 'object'
    && Object.entries(taskExecutionVersions(kind)).every(([key, value]) => snapshot[key] === value);
}
export function assertCurrentPipeline(job: { job_type: AiJobType; prompt_version: string; rule_version: string; pipeline_versions: JsonValue | null }): void {
  const checksHeaders = job.job_type !== 'tag_extraction' && job.job_type !== 'membership_features';
  if ((checksHeaders && (job.prompt_version !== STANDARDIZATION_PROMPT_VERSION || job.rule_version !== STANDARDIZATION_POLICY_VERSION))
    || !isCurrentPipeline(job.pipeline_versions, job.job_type)) {
    throw new DomainConflictError('AI_POLICY_STALE', '该任务使用了过期的识别流程，请创建新任务重新处理');
  }
}

/** Keep SQL admission and recovery aligned with the in-memory execution guard. */
export function currentExecutionPipeline(jobAlias = 'j') {
  const field = (name: string) => sql.ref(`${jobAlias}.${name}`);
  const snapshot = (kind: AiJobType) => sql<boolean>`${field('pipeline_versions')} @> ${JSON.stringify(taskExecutionVersions(kind))}::jsonb`;
  const headers = sql<boolean>`${field('prompt_version')} = ${STANDARDIZATION_PROMPT_VERSION}
    and ${field('rule_version')} = ${STANDARDIZATION_POLICY_VERSION}`;
  return sql<boolean>`coalesce(case
    when ${field('job_type')} = 'tag_extraction' then ${snapshot('tag_extraction')}
    when ${field('job_type')} = 'membership_features' then ${snapshot('membership_features')}
    when ${field('job_type')} = 'text_review' then (${headers} and ${snapshot('text_review')})
    when ${field('job_type')} in ('incremental', 'manual_full', 'calibration') then (${headers} and ${snapshot('manual_full')})
    else false end, false)`;
}

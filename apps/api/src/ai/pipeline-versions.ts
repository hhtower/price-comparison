import { DomainConflictError } from '../common/errors.js';
import type { JsonValue } from '../database/types.js';
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

export const EVIDENCE_PROJECTION_VERSION = 'evidence-visible-text-20261007-v3';
export const CANDIDATE_RETRIEVAL_VERSION = 'approved-definitions-20261121-v2';
export const EVIDENCE_VALIDATION_VERSION = 'match-only-boundary-20261119-v1';
export const TAG_VALIDATION_VERSION = 'tag-explicit-warranty-20261117-v5';
export const STANDARDIZATION_POLICY_VERSION = 'standardization-match-only-20261121-v3';
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
});
export function pipelineVersionSnapshot(model: string): JsonValue {
  return { ...PIPELINE_VERSIONS, requestedModel: model, applicationBuild: process.env.APP_BUILD_SHA ?? process.env.GIT_COMMIT ?? null };
}
export function isCurrentPipeline(snapshot: JsonValue | null): boolean {
  return !!snapshot && !Array.isArray(snapshot) && typeof snapshot === 'object'
    && Object.entries(PIPELINE_VERSIONS).every(([key, value]) => snapshot[key] === value);
}
export function assertCurrentPipeline(job: { prompt_version: string; rule_version: string; pipeline_versions: JsonValue | null }): void {
  if (job.prompt_version !== STANDARDIZATION_PROMPT_VERSION || job.rule_version !== STANDARDIZATION_POLICY_VERSION || !isCurrentPipeline(job.pipeline_versions)) {
    throw new DomainConflictError('AI_POLICY_STALE', '该任务使用了过期的识别流程，请创建新任务重新处理');
  }
}

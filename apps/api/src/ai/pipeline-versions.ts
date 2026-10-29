import { DomainConflictError } from '../common/errors.js';
import type { JsonValue } from '../database/types.js';
import { IDENTITY_POLICY_VERSION } from '../standardization/identity-policy.js';
import { CATALOG_ALIAS_VERSION } from '../standardization/catalog-aliases.js';
import { CANONICAL_RESOLUTION_VERSION } from '../standardization/canonical-resolution.js';
import { STANDARDIZATION_SCHEMA_VERSION } from './ai.schemas.js';
import { STANDARDIZATION_PROMPT_VERSION } from './standardization-request.js';
import { TAG_EXTRACTION_PROMPT_VERSION, TAG_EXTRACTION_PROTOCOL_VERSION } from './tag-extraction-request.js';
import { TAG_REVIEW_PROMPT_VERSION } from './tag-review-request.js';
import { STANDARDIZATION_REVIEW_PROMPT_VERSION } from './standardization-review-request.js';

export const EVIDENCE_PROJECTION_VERSION = 'evidence-visible-text-20261007-v3';
export const CANDIDATE_RETRIEVAL_VERSION = 'weighted-member-name-display-20261007-v2';
export const EVIDENCE_VALIDATION_VERSION = 'evidence-identity-publication-20261025-v11';
export const PIPELINE_VERSIONS = Object.freeze({
  contentFingerprint: 'name-description-spec-20261028-v1',
  prompt: STANDARDIZATION_PROMPT_VERSION, schema: STANDARDIZATION_SCHEMA_VERSION,
  projection: EVIDENCE_PROJECTION_VERSION, retrieval: CANDIDATE_RETRIEVAL_VERSION,
  mapping: CATALOG_ALIAS_VERSION, identityPolicy: IDENTITY_POLICY_VERSION, resolution: CANONICAL_RESOLUTION_VERSION,
  validation: EVIDENCE_VALIDATION_VERSION, tagPrompt: TAG_EXTRACTION_PROMPT_VERSION, tagProtocol: TAG_EXTRACTION_PROTOCOL_VERSION,
  tagReviewPrompt: TAG_REVIEW_PROMPT_VERSION,
  standardizationReviewPrompt: STANDARDIZATION_REVIEW_PROMPT_VERSION,
});
export function pipelineVersionSnapshot(model: string): JsonValue {
  return { ...PIPELINE_VERSIONS, requestedModel: model, applicationBuild: process.env.APP_BUILD_SHA ?? process.env.GIT_COMMIT ?? null };
}
export function isCurrentPipeline(snapshot: JsonValue | null): boolean {
  return !!snapshot && !Array.isArray(snapshot) && typeof snapshot === 'object'
    && Object.entries(PIPELINE_VERSIONS).every(([key, value]) => snapshot[key] === value);
}
export function assertCurrentPipeline(job: { prompt_version: string; rule_version: string; pipeline_versions: JsonValue | null }): void {
  if (job.prompt_version !== STANDARDIZATION_PROMPT_VERSION || job.rule_version !== IDENTITY_POLICY_VERSION || !isCurrentPipeline(job.pipeline_versions)) {
    throw new DomainConflictError('AI_POLICY_STALE', '该任务使用了过期的识别流程，请创建新任务重新处理');
  }
}

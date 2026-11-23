import type { JsonValue } from '../database/types.js';
import { projectSemanticEvidence } from './evidence-projection.js';
import type { CandidateDocument } from '../standardization/candidate-index.js';
import { assertStandardizationCheckpoint, StandardizationValidationError, type EvidenceCitation,
  type ParsedStandardizationResponse, type StandardizationResponseInput } from './ai.schemas.js';

/** Paths address this item's payload only; inherited properties and whole objects are not evidence. */
function validateCitations(citations: readonly EvidenceCitation[], payload: JsonValue, responsePath = 'evidence'): void {
  if (!citations.length) throw new StandardizationValidationError('必须提供当前商品证据', 'evidence_invalid',
    { stage: 'evidence', code: 'citation_missing', fieldPath: responsePath });
  for (const [index, citation] of citations.entries()) {
    const invalid = (reason: string, code: string, facts = {}, field = 'path') => new StandardizationValidationError(reason, 'evidence_invalid',
      { stage: 'evidence', code, fieldPath: `${responsePath}[${index}].${field}`, ...facts });
    const segments = citation.path.replace(/\[(\d+)\]/gu, '.$1').split('.');
    if (segments.at(-1) === 'id') throw invalid('商品 ID 不能作为事实证据', 'citation_path_invalid');
    let value: unknown = payload;
    for (const segment of segments) {
      if (!segment || ['__proto__', 'prototype', 'constructor'].includes(segment) || value === null
        || typeof value !== 'object' || !Object.hasOwn(value, segment)
        || Array.isArray(value) && !/^(0|[1-9]\d*)$/u.test(segment)) throw invalid('证据路径不属于当前商品', 'citation_path_invalid');
      value = Reflect.get(value, segment);
    }
    if (typeof value !== 'string' && typeof value !== 'number') throw invalid('证据必须引用原始文本或数值字段', 'citation_type_invalid');
    const source = String(value);
    if (!citation.quote.trim() || !source.includes(citation.quote)) throw invalid('证据引文不存在于当前商品的指定字段', 'citation_quote_mismatch',
      { quoteLength: citation.quote.length, sourceLength: source.length, matched: false }, 'quote');
  }
}

export function validateTagCitations(citations: readonly EvidenceCitation[], payload: JsonValue): void {
  validateCitations(citations, payload);
}

/** Check frozen boundaries only; the model and binary reviewer judge the mapping semantics. */
export function validateStandardizationEvidence(
  response: ParsedStandardizationResponse,
  inputs: readonly (StandardizationResponseInput & { payload: JsonValue })[],
  candidates: readonly CandidateDocument[],
): ParsedStandardizationResponse {
  assertStandardizationCheckpoint(response);
  const byId = new Map(inputs.map(input => [input.id, input]));
  const existing = new Set(candidates.map(candidate => candidate.id));
  if (byId.size !== inputs.length || existing.size !== candidates.length || response.items.length !== inputs.length) {
    throw new StandardizationValidationError('标准化冻结快照 ID 重复或数量不一致', 'invalid_response',
      { stage: 'evidence', code: 'snapshot_ids_invalid' });
  }
  for (const [index, item] of response.items.entries()) {
    const input = byId.get(item.id);
    if (!input) throw new StandardizationValidationError('标准化决策缺少对应输入快照', 'invalid_response',
      { stage: 'evidence', code: 'item_id_unknown', fieldPath: `items[${index}].id` });
    if (new Set(input.candidateStandardProductIds).size !== input.candidateStandardProductIds.length
      || input.candidateStandardProductIds.some(id => !existing.has(id))) {
      throw new StandardizationValidationError('标准化候选快照无效', 'invalid_response',
        { stage: 'evidence', code: 'candidate_snapshot_invalid', itemId: item.id });
    }
    if (item.identity && !input.candidateStandardProductIds.includes(item.identity.standardProductId)) {
      throw new StandardizationValidationError('标准化身份不在本项冻结候选中', 'invalid_response',
        { stage: 'evidence', code: 'unknown_candidate_id', itemId: item.id, fieldPath: `items[${index}].identity.standardProductId` });
    }
    const proposedId = item.review?.proposal.standardProductId;
    if (proposedId != null && !input.candidateStandardProductIds.includes(proposedId)) {
      throw new StandardizationValidationError('复核原始提议不在本项冻结候选中', 'invalid_response',
        { stage: 'evidence', code: 'unknown_candidate_id', itemId: item.id, fieldPath: `items[${index}].review.proposal.standardProductId` });
    }
    try {
      validateCitations(item.evidence, input.payload, `items[${index}].evidence`);
      const transported = projectSemanticEvidence(input.payload as Record<string, JsonValue>);
      validateCitations(item.evidence, transported, `items[${index}].evidence`);
      if (item.review && !item.review.approved) {
        validateCitations(item.review.evidence, input.payload, `items[${index}].review.evidence`);
        validateCitations(item.review.evidence, transported, `items[${index}].review.evidence`);
      }
    } catch (error) {
      if (error instanceof StandardizationValidationError) error.diagnostic.itemId = item.id;
      throw error;
    }
  }
  return response;
}

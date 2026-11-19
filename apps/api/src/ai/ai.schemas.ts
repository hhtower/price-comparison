import type { TagValue } from '@price-comparison/catalog/purchase-attributes';
import type { Identity } from '../standardization/identity-policy.js';

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const valueType = (value: unknown): string => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const schemaError = (message: string, code: string, fieldPath: string, facts: Partial<StandardizationDiagnostic> = {}) =>
  new StandardizationValidationError(message, 'invalid_response', { stage: 'schema', code, fieldPath, ...facts });
const text = (value: unknown, fieldPath: string, max = 1000, citationWhitespace = false): string => {
  if (typeof value !== 'string') throw schemaError('AI 字段类型必须为 string', 'invalid_type', fieldPath,
    { expectedType: 'string', actualType: valueType(value) });
  if (!value.trim()) throw schemaError('AI 字符串为空', 'empty_string', fieldPath);
  if (value.length > max) throw schemaError('AI 字符串超过长度上限', 'string_too_long', fieldPath);
  if (/[\u0000-\u001f\u007f]/u.test(citationWhitespace ? value.replace(/[\t\r\n]/gu, ' ') : value)) {
    throw schemaError('AI 字符串包含控制字符', 'control_character', fieldPath);
  }
  return value;
};
export const STANDARDIZATION_REASON_CODES = [
  'unmatched',
  'input_too_large',
  'publication_too_large',
  'invalid_response',
  'evidence_invalid',
  'attribute_conflict',
  'publication_blocked',
  'provider_error',
  'provider_policy_rejection',
  'manual_decision_preserved',
  'identity_conflict',
  'source_changed',
  'missing_id',
  'review_rejected',
] as const;

export type StandardizationReasonCode = typeof STANDARDIZATION_REASON_CODES[number];
/** Internal bounded diagnostics, never model output or publishable classification. */
export interface StandardizationDiagnostic {
  stage: 'schema' | 'evidence' | 'attribute' | 'identity' | 'publication';
  code: string;
  fieldPath?: string;
  expectedType?: string;
  actualType?: string;
  actualCount?: number;
  maxCount?: number;
  /** Only an input ID confirmed against the current batch. */
  itemId?: string;
  proposedIdentity?: Identity;
  standardProductId?: string;
  ruleIds?: string[];
  quoteLength?: number;
  sourceLength?: number;
  matched?: boolean;
}
export class StandardizationValidationError extends Error {
  constructor(message: string, readonly reasonCode: StandardizationReasonCode, readonly diagnostic: StandardizationDiagnostic) {
    super(message);
  }
}
export interface EvidenceCitation { path: string; quote: string }
export interface StandardizationTag { name: string; value: TagValue; evidence: EvidenceCitation[] }
export type StandardizationIdentityChoice = { kind: 'existing'; standardProductId: string };
export interface StandardizationDecision {
  id: string;
  status: 'classified' | 'unclassified';
  identity?: StandardizationIdentityChoice;
  ruleIds: string[];
  evidence: EvidenceCitation[];
  reasonCode: StandardizationReasonCode | null;
  reason: string;
  diagnostic?: StandardizationDiagnostic;
  review?: { approved: boolean };
}
export interface StandardizationResponseInput {
  readonly id: string;
  readonly candidateStandardProductIds: readonly string[];
}
export interface ParsedStandardizationResponse {
  items: StandardizationDecision[];
  missingIds: string[];
}

export const STANDARDIZATION_SCHEMA_VERSION = 'standardization-match-20261119-v1';
export type StandardizationProtocolInput = StandardizationResponseInput;
const MATCHED_REASON = '匹配已准入标准商品';
const UNMATCHED_REASON = '未匹配到已准入标准商品';
const REVIEW_REJECTED_REASON = 'LLM 对该标准化提议判定为否';

const exactKeys = (value: Record<string, unknown>, keys: readonly string[], fieldPath = '$'): void => {
  const missing = keys.find(key => !Object.hasOwn(value, key));
  if (missing) throw schemaError('AI 响应缺少必要字段', 'missing_field', fieldPath === '$' ? missing : `${fieldPath}.${missing}`);
  if (Object.keys(value).some(key => !keys.includes(key))) throw schemaError('AI 响应包含多余字段', 'unexpected_field', fieldPath);
};
const schemaObject = (properties: Record<string, unknown>) => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
});

export function standardizationProtocolSchema(inputs: readonly StandardizationProtocolInput[]): Record<string, unknown> {
  const string = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
  return { ...schemaObject({ items: {
    type: 'array', minItems: inputs.length, maxItems: inputs.length,
    ...(inputs.length ? { items: { anyOf: inputs.map(input => schemaObject({
      id: { const: input.id },
      standardProductId: { type: ['string', 'null'], enum: [...input.candidateStandardProductIds, null] },
      evidence: { type: 'array', minItems: 1, maxItems: 50, items: { $ref: '#/$defs/citation' } },
    })) } } : {}),
  } }), $defs: { citation: schemaObject({ path: string(250), quote: string(1000) }) } };
}

function parseEvidence(value: unknown, fieldPath: string): EvidenceCitation[] {
  if (!Array.isArray(value)) throw schemaError('AI 证据必须为数组', 'invalid_type', fieldPath,
    { expectedType: 'array', actualType: valueType(value) });
  if (!value.length || value.length > 50) throw schemaError('AI 证据数量必须为 1 至 50', 'evidence_count_invalid', fieldPath,
    { actualCount: value.length, maxCount: 50 });
  return value.map((entry, index) => {
    const entryPath = `${fieldPath}[${index}]`;
    if (!isRecord(entry)) throw schemaError('AI 证据无效', 'invalid_type', entryPath,
      { expectedType: 'object', actualType: valueType(entry) });
    exactKeys(entry, ['path', 'quote'], entryPath);
    return { path: text(entry.path, `${entryPath}.path`, 250), quote: text(entry.quote, `${entryPath}.quote`, 1000, true) };
  });
}

export function parseStandardizationProtocolResponse(value: unknown, inputs: readonly StandardizationProtocolInput[]): ParsedStandardizationResponse {
  if (!isRecord(value)) throw schemaError('AI 响应外壳无效', 'invalid_type', '$', { expectedType: 'object', actualType: valueType(value) });
  exactKeys(value, ['items']);
  if (!Array.isArray(value.items)) throw schemaError('AI items 必须为数组', 'items_type_invalid', 'items',
    { expectedType: 'array', actualType: valueType(value.items) });
  const byId = new Map(inputs.map(input => [input.id, input]));
  if (byId.size !== inputs.length) throw schemaError('标准化输入 ID 重复', 'duplicate_input_id', 'items');
  if (value.items.length > inputs.length) throw schemaError('AI items 数量超过输入数量', 'items_limit_exceeded', 'items',
    { actualCount: value.items.length, maxCount: inputs.length });
  const decisions = new Map<string, StandardizationDecision>();
  for (const [index, raw] of value.items.entries()) {
    const itemPath = `items[${index}]`;
    if (!isRecord(raw)) throw schemaError('AI item 无效', 'invalid_type', itemPath, { expectedType: 'object', actualType: valueType(raw) });
    const id = text(raw.id, `${itemPath}.id`, 30);
    const input = byId.get(id);
    if (!input) throw schemaError('AI 响应包含未知 ID', 'item_id_unknown', `${itemPath}.id`);
    if (decisions.has(id)) throw schemaError('AI 响应包含重复 ID', 'duplicate_item_id', `${itemPath}.id`, { itemId: id });
    try {
      exactKeys(raw, ['id', 'standardProductId', 'evidence'], itemPath);
      const standardProductId = raw.standardProductId === null ? null : text(raw.standardProductId, `${itemPath}.standardProductId`, 30);
      if (standardProductId !== null && !input.candidateStandardProductIds.includes(standardProductId)) {
        throw schemaError('AI item 引用了未提供的本项候选 ID', 'unknown_candidate_id', `${itemPath}.standardProductId`);
      }
      const evidence = parseEvidence(raw.evidence, `${itemPath}.evidence`);
      decisions.set(id, standardProductId === null
        ? { id, status: 'unclassified', ruleIds: [], evidence, reasonCode: 'unmatched', reason: UNMATCHED_REASON }
        : { id, status: 'classified', identity: { kind: 'existing', standardProductId },
          ruleIds: [], evidence, reasonCode: null, reason: MATCHED_REASON });
    } catch (error) {
      if (error instanceof StandardizationValidationError) error.diagnostic.itemId = id;
      throw error;
    }
  }
  if (decisions.size !== inputs.length) throw schemaError('AI 响应遗漏输入 ID', 'missing_item_id', 'items',
    { actualCount: decisions.size, maxCount: inputs.length });
  return { items: inputs.map(input => decisions.get(input.id)!), missingIds: [] };
}

/** Persisted decisions must be current business results, never repaired legacy output or technical failures. */
export function assertStandardizationCheckpoint(value: unknown): asserts value is ParsedStandardizationResponse {
  if (!isRecord(value)) throw schemaError('标准化检查点外壳无效', 'invalid_type', '$');
  exactKeys(value, ['items', 'missingIds']);
  if (!Array.isArray(value.items)) throw schemaError('标准化检查点 items 无效', 'items_type_invalid', 'items');
  if (!Array.isArray(value.missingIds) || value.missingIds.length) {
    throw schemaError('标准化检查点不允许遗漏 ID', 'missing_item_id', 'missingIds');
  }
  const seen = new Set<string>();
  for (const [index, item] of value.items.entries()) {
    const fieldPath = `items[${index}]`;
    if (!isRecord(item)) throw schemaError('标准化检查点 item 无效', 'invalid_type', fieldPath);
    const id = text(item.id, `${fieldPath}.id`, 30);
    if (id !== id.trim() || seen.has(id)) throw schemaError('标准化检查点 ID 无效或重复', 'invalid_item_id', `${fieldPath}.id`);
    seen.add(id);
    const classified = item.status === 'classified';
    exactKeys(item, ['id', 'status', 'ruleIds', 'evidence', 'reasonCode', 'reason',
      ...(classified ? ['identity'] : []), ...(Object.hasOwn(item, 'review') ? ['review'] : [])], fieldPath);
    if (!Array.isArray(item.ruleIds) || item.ruleIds.length) throw schemaError('标准化检查点 ruleIds 必须为空', 'invalid_rule_ids', `${fieldPath}.ruleIds`);
    parseEvidence(item.evidence, `${fieldPath}.evidence`);
    if (classified) {
      if (!isRecord(item.identity)) throw schemaError('标准化检查点缺少已有标准身份', 'invalid_identity', `${fieldPath}.identity`);
      exactKeys(item.identity, ['kind', 'standardProductId'], `${fieldPath}.identity`);
      const standardProductId = text(item.identity.standardProductId, `${fieldPath}.identity.standardProductId`, 30);
      if (item.identity.kind !== 'existing' || standardProductId !== standardProductId.trim()
        || item.reasonCode !== null || item.reason !== MATCHED_REASON) {
        throw schemaError('标准化检查点匹配结果无效', 'invalid_decision', fieldPath);
      }
    } else if (item.status !== 'unclassified' || !(
      item.reasonCode === 'unmatched' && item.reason === UNMATCHED_REASON
      || item.reasonCode === 'review_rejected' && item.reason === REVIEW_REJECTED_REASON
    )) throw schemaError('标准化检查点未匹配结果无效', 'invalid_decision', fieldPath);
    if (Object.hasOwn(item, 'review')) {
      if (!isRecord(item.review)) throw schemaError('标准化检查点复核无效', 'invalid_review', `${fieldPath}.review`);
      exactKeys(item.review, ['approved'], `${fieldPath}.review`);
      if (item.review.approved !== (item.reasonCode !== 'review_rejected')) {
        throw schemaError('标准化检查点复核结论矛盾', 'invalid_review', `${fieldPath}.review`);
      }
    } else if (item.reasonCode === 'review_rejected') {
      throw schemaError('标准化检查点缺少拒绝复核结论', 'invalid_review', `${fieldPath}.review`);
    }
  }
}

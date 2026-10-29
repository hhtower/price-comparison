import { buildCanonicalStandardKey } from '../standardization/canonical-key.js';
import { normalizeIdentity, isValidCatalogIdentity, type Identity } from '../standardization/identity-policy.js';
import { isSkuOnlyIdentityTier } from '../standardization/canonical-resolution.js';

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const valueType = (value: unknown): string => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const schemaError = (message: string, code: string, fieldPath: string, facts: Partial<StandardizationDiagnostic> = {}) =>
  new StandardizationValidationError(message, 'invalid_response', { stage: 'schema', code, fieldPath, ...facts });
const text = (value: unknown, name: string, max = 1000, citationWhitespace = false, fieldPath = name): string => {
  if (typeof value !== 'string') throw schemaError(`AI ${name} 无效：类型应为 string，实际为 ${valueType(value)}`, 'invalid_type', fieldPath,
    { expectedType: 'string', actualType: valueType(value) });
  if (!value.trim()) throw schemaError(`AI ${name} 无效：字符串为空`, 'empty_string', fieldPath);
  if (value.length > max) throw schemaError(`AI ${name} 无效：长度 ${value.length} 超过上限 ${max}`, 'string_too_long', fieldPath);
  if (/[\u0000-\u001f\u007f]/u.test(citationWhitespace ? value.replace(/[\t\r\n]/gu, ' ') : value)) throw schemaError(`AI ${name} 无效：包含控制字符`, 'control_character', fieldPath);
  const normalized = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (!normalized || normalized.length > max) throw schemaError(`AI ${name} 无效`, 'invalid_string', fieldPath);
  return normalized;
};
export const STANDARDIZATION_REASON_CODES = [
  'insufficient_evidence',
  'not_sellable',
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
export interface StandardizationTag { name: string; value: string; evidence: EvidenceCitation[] }
export interface StandardizationIdentity {
  ref: string;
  family: string;
  product: string;
  tier: string;
  canonicalKey: string;
  reason: string;
  evidence: EvidenceCitation[];
}
export type StandardizationIdentityChoice =
  | { kind: 'new'; ref: string; canonicalKey: string }
  | { kind: 'existing'; standardProductId: string };
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
  id: string;
  candidateStandardProductIds: readonly string[];
}
export interface ParsedStandardizationResponse {
  identities: StandardizationIdentity[];
  items: StandardizationDecision[];
  missingIds: string[];
}

export const STANDARDIZATION_SCHEMA_VERSION = 'standardization-identity-actions-20261015-v10';
export interface StandardizationProtocolInput extends StandardizationResponseInput {
  readonly candidateRefs: Readonly<Record<string, string>>;
}

/** The model sees actions and item-local references; publication retains its established shape. */
export function standardizationProtocolSchema(inputs: readonly StandardizationProtocolInput[]): Record<string, unknown> {
  const string = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
  const evidence = { type: 'array', maxItems: 50, items: { $ref: '#/$defs/citation' } };
  const common = { id: { type: 'string', enum: inputs.map(input => input.id) },
    ruleIds: { type: 'array', maxItems: 50, uniqueItems: true, items: string(100) }, evidence, reason: string(1000) };
  return { ...schemaObject({ items: { type: 'array', maxItems: inputs.length, items: { anyOf: [
    ...inputs.filter(input => Object.keys(input.candidateRefs).length).map(input => schemaObject({
      ...common, id: { const: input.id }, action: { const: 'reuse_candidate' },
      candidateRef: { type: 'string', enum: Object.keys(input.candidateRefs) },
    })),
    schemaObject({ ...common, action: { const: 'create_identity' }, identity: { $ref: '#/$defs/identity' } }),
    schemaObject({ ...common, action: { const: 'insufficient_evidence' } }),
    schemaObject({ ...common, action: { const: 'not_sellable' } }),
  ] } } }), $defs: {
    citation: schemaObject({ path: string(250), quote: string(1000) }),
    identity: schemaObject({ family: string(250), product: string(250), tier: string(250), reason: string(1000), evidence: { ...evidence, minItems: 1 } }),
  } };
}

export function parseStandardizationProtocolResponse(value: unknown, inputs: readonly StandardizationProtocolInput[]): ParsedStandardizationResponse {
  if (!isRecord(value)) throw schemaError('AI 响应外壳无效', 'invalid_type', '$', { expectedType: 'object', actualType: valueType(value) });
  if (!Object.hasOwn(value, 'items')) throw schemaError('AI 响应字段无效：缺少字段 "items"', 'missing_field', 'items',
    { expectedType: 'array', actualType: 'undefined' });
  exactKeys(value, ['items'], 'AI 响应字段无效');
  if (!Array.isArray(value.items)) throw schemaError(`AI items 无效：类型应为 array，实际为 ${valueType(value.items)}`, 'items_type_invalid', 'items',
    { expectedType: 'array', actualType: valueType(value.items) });
  if (value.items.length > inputs.length) throw schemaError(`AI items 无效：数量 ${value.items.length} 超过上限 ${inputs.length}`, 'items_limit_exceeded', 'items',
    { actualCount: value.items.length, maxCount: inputs.length });
  const byId = new Map(inputs.map(input => [input.id, input]));
  if (byId.size !== inputs.length) throw schemaError('标准化输入 ID 重复', 'duplicate_input_id', 'items');
  const seen = new Set<string>();
  const identities: StandardizationIdentity[] = [];
  const items: StandardizationDecision[] = [];
  for (const [index, raw] of value.items.entries()) {
    const itemPath = `items[${index}]`;
    if (!isRecord(raw)) throw schemaError('AI item 无效', 'invalid_type', itemPath, { expectedType: 'object', actualType: valueType(raw) });
    const id = text(raw.id, 'item ID', 30, false, `${itemPath}.id`);
    const input = byId.get(id);
    if (!input) throw schemaError('AI 响应包含未知 ID（未出现在当前批次）', 'item_id_unknown', `${itemPath}.id`);
    if (seen.has(id)) throw schemaError('AI 响应包含重复 ID', 'duplicate_item_id', `${itemPath}.id`, { itemId: input.id });
    seen.add(id);
    let proposedIdentity: Identity | undefined;
    try {
      const commonKeys = ['id', 'action', 'ruleIds', 'evidence', 'reason'];
      const identityMap = new Map<string, { identity: StandardizationIdentity }>();
      let identityRef: string | null = null;
      let standardProductId: string | null = null;
      let reasonCode: string | null = null;
      if (raw.action === 'reuse_candidate') {
        exactKeys(raw, [...commonKeys, 'candidateRef'], 'AI 复用动作字段无效');
        const ref = text(raw.candidateRef, 'candidate ref', 30, false, 'candidateRef');
        if (!Object.hasOwn(input.candidateRefs, ref)) throw schemaError('AI item 引用了未提供的本项候选', 'unknown_candidate_ref', 'candidateRef');
        standardProductId = input.candidateRefs[ref]!;
      } else if (raw.action === 'create_identity') {
        exactKeys(raw, [...commonKeys, 'identity'], 'AI 新身份动作字段无效');
        if (!isRecord(raw.identity)) throw schemaError('AI identity 无效', 'invalid_type', 'identity', { expectedType: 'object', actualType: valueType(raw.identity) });
        exactKeys(raw.identity, ['family', 'product', 'tier', 'reason', 'evidence'], 'AI identity 字段无效', 'identity');
        identityRef = `i-${id}`;
        const identity = parseIdentity({ ...raw.identity, ref: identityRef });
        proposedIdentity = normalizeIdentity(identity);
        identityMap.set(identityRef, { identity });
      } else if (raw.action === 'insufficient_evidence' || raw.action === 'not_sellable') {
        exactKeys(raw, commonKeys, 'AI 未分类动作字段无效');
        reasonCode = raw.action;
      } else throw schemaError('AI item 动作无效', 'invalid_action', 'action', { expectedType: 'string', actualType: valueType(raw.action) });
      const decision = parseDecision({ id, status: reasonCode ? 'unclassified' : 'classified', identityRef, standardProductId,
        reasonCode, ruleIds: raw.ruleIds, evidence: raw.evidence, reason: raw.reason }, input, identityMap);
      items.push(decision);
      identities.push(...[...identityMap.values()].map(entry => entry.identity));
    } catch (error) {
      items.push(invalidDecision(id, error, proposedIdentity, itemPath));
    }
  }
  const itemById = new Map(items.map(item => [item.id, item]));
  return { identities, items: inputs.flatMap(input => itemById.has(input.id) ? [itemById.get(input.id)!] : []),
    missingIds: inputs.filter(input => !seen.has(input.id)).map(input => input.id) };
}

const exactKeys = (value: Record<string, unknown>, keys: readonly string[], message: string, fieldPath = ''): void => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    // Keep only bounded field names, never response values or raw content.
    const describe = (names: string[]) => names.slice(0, 8).map(name => JSON.stringify(name.slice(0, 60).replace(/[\p{Cc}\p{Cf}]/gu, '?'))).join(', ') + (names.length > 8 ? ` …共 ${names.length} 个` : '');
    const missing = expected.filter(key => !Object.hasOwn(value, key));
    const extra = actual.filter(key => !keys.includes(key));
    throw schemaError(`${message}：${[missing.length ? `缺少字段 ${describe(missing)}` : '', extra.length ? `多余字段 ${describe(extra)}` : ''].filter(Boolean).join('；')}`.slice(0, 1000),
      missing.length ? 'missing_field' : 'unexpected_field',
      missing.length ? (fieldPath ? `${fieldPath}.${missing[0]}` : missing[0]!) : fieldPath || '$');
  }
};

const schemaObject = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

function parseEvidence(value: unknown, fieldPath = 'evidence'): EvidenceCitation[] {
  if (!Array.isArray(value)) throw schemaError('AI 证据无效', 'invalid_type', fieldPath, { expectedType: 'array', actualType: valueType(value) });
  if (value.length > 50) throw schemaError('AI 证据无效', 'too_many_items', fieldPath, { actualCount: value.length, maxCount: 50 });
  return value.map((entry, index) => {
    const entryPath = `${fieldPath}[${index}]`;
    if (!isRecord(entry)) throw schemaError('AI 证据无效', 'invalid_type', entryPath, { expectedType: 'object', actualType: valueType(entry) });
    exactKeys(entry, ['path', 'quote'], 'AI 证据字段无效', entryPath);
    return { path: text(entry.path, '证据路径', 250, false, `${entryPath}.path`), quote: text(entry.quote, '证据原文', 1000, true, `${entryPath}.quote`) };
  });
}

function parseIdentity(value: unknown): StandardizationIdentity {
  if (!isRecord(value)) throw schemaError('AI identity 无效', 'invalid_type', 'identity', { expectedType: 'object', actualType: valueType(value) });
  exactKeys(value, ['ref', 'family', 'product', 'tier', 'reason', 'evidence'], 'AI identity 字段无效', 'identity');
  const ref = text(value.ref, 'identity ref', 100, false, 'identity.ref');
  const identity = normalizeIdentity({
    family: text(value.family, 'family', 250, false, 'identity.family'),
    product: text(value.product, 'product', 250, false, 'identity.product'),
    tier: text(value.tier, 'tier', 250, false, 'identity.tier'),
  });
  if (!isValidCatalogIdentity(identity)) throw new StandardizationValidationError('AI identity 三要素无效', 'identity_conflict',
    { stage: 'identity', code: 'invalid_identity', fieldPath: 'identity', proposedIdentity: identity });
  if (isSkuOnlyIdentityTier(identity)) throw new StandardizationValidationError('新身份不能以购买时长、数量或金额作为套餐', 'identity_conflict',
    { stage: 'identity', code: 'sku_in_identity', fieldPath: 'identity.tier', proposedIdentity: identity });
  return {
    ref,
    ...identity,
    canonicalKey: buildCanonicalStandardKey(identity),
    reason: text(value.reason, 'identity 说明', 1000, false, 'identity.reason'),
    evidence: parseEvidence(value.evidence, 'identity.evidence'),
  };
}

function invalidDecision(id: string, error: unknown, proposedIdentity: Identity | undefined, itemPath: string): StandardizationDecision {
  const diagnostic: StandardizationDiagnostic = error instanceof StandardizationValidationError ? error.diagnostic
    : { stage: 'schema', code: 'invalid_structure' };
  return {
    id,
    status: 'unclassified',
    ruleIds: [],
    evidence: [],
    reasonCode: error instanceof StandardizationValidationError ? error.reasonCode : 'invalid_response',
    reason: error instanceof Error ? error.message : 'AI 响应无效',
    diagnostic: { ...(proposedIdentity ? { proposedIdentity } : {}), ...diagnostic, itemId: id,
      ...(diagnostic.stage === 'schema' ? { fieldPath: diagnostic.fieldPath && diagnostic.fieldPath !== '$' ? `${itemPath}.${diagnostic.fieldPath}` : itemPath } : {}) },
  };
}

function parseDecision(
  value: Record<string, unknown>,
  input: StandardizationResponseInput,
  identities: ReadonlyMap<string, { identity?: StandardizationIdentity; error?: string }>,
): StandardizationDecision {
  exactKeys(value, ['id', 'status', 'identityRef', 'standardProductId', 'ruleIds', 'evidence', 'reasonCode', 'reason'], 'AI item 字段无效');
  const status = value.status;
  if (status !== 'classified' && status !== 'unclassified') throw schemaError('AI item 状态无效', 'invalid_status', 'status');
  const identityRef = value.identityRef === null ? null : text(value.identityRef, 'identity ref', 100, false, 'identityRef');
  const standardProductId = value.standardProductId === null ? null : text(value.standardProductId, '标准商品 ID', 30, false, 'candidateRef');
  if (standardProductId !== null && !/^[1-9]\d*$/u.test(standardProductId)) throw schemaError('AI 标准商品 ID 无效', 'invalid_candidate_ref', 'candidateRef');

  if (!Array.isArray(value.ruleIds)) throw schemaError('AI ruleIds 无效', 'invalid_type', 'ruleIds', { expectedType: 'array', actualType: valueType(value.ruleIds) });
  if (value.ruleIds.length > 50) throw schemaError('AI ruleIds 无效', 'too_many_items', 'ruleIds', { actualCount: value.ruleIds.length, maxCount: 50 });
  const ruleIds = value.ruleIds.map((entry, index) => text(entry, '规则 ID', 100, false, `ruleIds[${index}]`));
  if (new Set(ruleIds).size !== ruleIds.length) throw schemaError('AI ruleIds 重复', 'duplicate_value', 'ruleIds');
  const evidence = parseEvidence(value.evidence);
  const reason = text(value.reason, 'item 说明', 1000, false, 'reason');

  if (status === 'unclassified') {
    if (identityRef !== null || standardProductId !== null) throw schemaError('AI 未分类 item 携带了分类结果', 'invalid_identity_reference', 'identity');
    if (value.reasonCode !== 'insufficient_evidence' && value.reasonCode !== 'not_sellable') throw schemaError('AI 未分类原因无效', 'invalid_reason_code', 'reasonCode');
    return { id: input.id, status, ruleIds, evidence, reasonCode: value.reasonCode, reason };
  }

  if (value.reasonCode !== null || (identityRef === null) === (standardProductId === null)) throw schemaError('AI 已分类 item 身份引用无效', 'invalid_identity_reference', 'identity');
  if (identityRef !== null) {
    const resolved = identities.get(identityRef);
    if (!resolved) throw schemaError('AI item 引用了不存在的 identity ref', 'unknown_identity_ref', 'identityRef');
    if (!resolved.identity) throw schemaError(resolved.error ?? 'AI item 引用了无效 identity', 'invalid_identity_reference', 'identityRef');
    return {
      id: input.id,
      status,
      identity: { kind: 'new', ref: identityRef, canonicalKey: resolved.identity.canonicalKey },
      ruleIds,
      evidence,
      reasonCode: null,
      reason,
    };
  }
  if (!input.candidateStandardProductIds.includes(standardProductId!)) throw schemaError('AI item 引用了未提供的标准商品 ID', 'unknown_candidate_ref', 'candidateRef');
  return {
    id: input.id,
    status,
    identity: { kind: 'existing', standardProductId: standardProductId! },
    ruleIds,
    evidence,
    reasonCode: null,
    reason,
  };
}

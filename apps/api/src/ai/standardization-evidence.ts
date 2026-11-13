import type { JsonValue } from '../database/types.js';
import { tagValueKey } from '@price-comparison/catalog/purchase-attributes';
import { isCanonicalProductTag, PRODUCT_TAG_RULES } from '@price-comparison/catalog/product-tag-policy';
import { canonicalizeMatchText } from '../standardization/fingerprint.js';
import { assessProductEvidence, identityEvidenceConflict, normalizeIdentity, type Identity } from '../standardization/identity-policy.js';
import type { CandidateDocument } from '../standardization/candidate-index.js';
import { publicationEvidenceConflict } from '../standardization/publication-evidence.js';
import { currentProductTagEvidence, scopeEvidenceLines, tagCitationSupports, tagEvidenceFacts, tagEvidenceValue } from './tag-evidence.js';
import { StandardizationValidationError, type StandardizationDiagnostic, type StandardizationReasonCode, type EvidenceCitation, type ParsedStandardizationResponse, type StandardizationDecision, type StandardizationTag } from './ai.schemas.js';

interface CitationSource { path: string; quote: string; source: string }

function primaryTagText(payload: JsonValue): string {
  const item = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  return canonicalizeMatchText(`${item.name ?? ''} ${item.spec ?? ''}`);
}

/** Paths address this item's payload only; inherited properties and whole objects are not evidence. */
function citationSources(citations: readonly EvidenceCitation[], payload: JsonValue, required: boolean, responsePath = 'evidence'): CitationSource[] {
  if (required && !citations.length) throw new StandardizationValidationError('已分类结果和标签必须提供当前商品证据', 'evidence_invalid', { stage: 'evidence', code: 'citation_missing', fieldPath: responsePath });
  return citations.map((citation, index) => {
    const invalid = (reason: string, code: string, facts = {}, field = 'path') => new StandardizationValidationError(reason, 'evidence_invalid',
      { stage: 'evidence', code, fieldPath: `${responsePath}[${index}].${field}`, ...facts });
    const segments = citation.path.replace(/\[(\d+)\]/gu, '.$1').split('.');
    let value: unknown = payload;
    for (const segment of segments) {
      if (!segment || ['__proto__', 'prototype', 'constructor'].includes(segment) || value === null
        || typeof value !== 'object' || !Object.hasOwn(value, segment)) throw invalid('证据路径不属于当前商品', 'citation_path_invalid');
      value = Reflect.get(value, segment);
    }
    if (typeof value !== 'string' && typeof value !== 'number') throw invalid('证据必须引用原始文本或数值字段', 'citation_type_invalid');
    // Keep semantic boundaries; only citation matching collapses all whitespace.
    const source = String(value).normalize('NFKC').split(/\r\n?|\n/u).map(canonicalizeMatchText).join('\n');
    const quote = canonicalizeMatchText(citation.quote);
    if (!quote || !canonicalizeMatchText(source).includes(quote)) throw invalid('证据引文不存在于当前商品的指定字段', 'citation_quote_mismatch',
      { quoteLength: quote.length, sourceLength: source.length, matched: false }, 'quote');
    return { path: citation.path, quote, source };
  });
}

/** Reviewed tags use literal source validation; the review model owns semantic assessment. */
export function validateTagCitations(citations: readonly EvidenceCitation[], payload: JsonValue): void {
  if (citations.some(citation => citation.path.split('.').at(-1) === 'id')) {
    throw new StandardizationValidationError('商品 ID 不能作为标签事实证据', 'evidence_invalid',
      { stage: 'evidence', code: 'citation_path_invalid' });
  }
  citationSources(citations, payload, true);
  for (const citation of citations) {
    let value: unknown = payload;
    for (const segment of citation.path.replace(/\[(\d+)\]/gu, '.$1').split('.')) {
      value = Reflect.get(value as object, segment);
    }
    if (!String(value).includes(citation.quote)) {
      throw new StandardizationValidationError('证据引文不存在于当前商品的指定字段', 'evidence_invalid',
        { stage: 'evidence', code: 'citation_quote_mismatch' });
    }
  }
}

function tagCitationSources(citations: readonly EvidenceCitation[], payload: JsonValue): CitationSource[] {
  const primaryText = primaryTagText(payload);
  const sources = citationSources(citations, payload, true)
    .map(source => ({ ...source, source: scopeEvidenceLines(['name', 'spec'].includes(source.path)
      ? source.source : currentProductTagEvidence(source.source, primaryText)) }))
    .filter(source => canonicalizeMatchText(source.source).includes(source.quote));
  if (!sources.length) throw new StandardizationValidationError('标签引文属于其他商品的推广内容', 'evidence_invalid',
    { stage: 'attribute', code: 'tag_subject_mismatch' });
  return sources;
}

function textFacts(value: JsonValue | undefined, primaryText: string): string {
  if (Array.isArray(value)) return value.map(item => textFacts(item, primaryText)).join('; ');
  if (value && typeof value === 'object') {
    return Object.values(value).map(item => textFacts(item, primaryText)).join('; ');
  }
  return typeof value === 'string' ? currentProductTagEvidence(value, primaryText).split('\n').map(canonicalizeMatchText).join('\n')
    : canonicalizeMatchText(value);
}

function validateTag(tag: StandardizationTag, payload: JsonValue): void {
  if (!isCanonicalProductTag(tag)) throw new Error('标签值不符合规范枚举或格式');
  validateTagCitations(tag.evidence, payload);
  const sources = tagCitationSources(tag.evidence, payload);
  const wanted = tagEvidenceValue(tag.value);
  let selected = new Set<string>();
  if (payload && !Array.isArray(payload) && typeof payload === 'object') {
    selected = tagEvidenceFacts(tag, canonicalizeMatchText(payload.spec));
    if (!selected.size && tag.name === 'duration') selected = tagEvidenceFacts(tag, canonicalizeMatchText(payload.name));
  }
  if (selected.size && !selected.has(wanted)) throw new Error('标签与商品选中规格或标题冲突');
  if (tag.name === 'warranty' && !tagEvidenceFacts(tag, textFacts(payload, primaryTagText(payload))).has(wanted)) {
    throw new Error('售后说明未保留完整保障范围或条件');
  }
  const supported = sources.some(source => {
    if (tag.name === 'duration' && /warranty|guarantee|质保|保修|token|号龄|account.?age/iu.test(source.path)) return false;
    const context = tagEvidenceFacts(tag, source.source);
    return context.has(wanted) && (PRODUCT_TAG_RULES[tag.name]?.multiple || context.size === 1 || selected.has(wanted))
      && tagCitationSupports(tag, source.quote, source.source);
  });
  if (!supported) throw new Error('标签证据不支持所声明的属性事实');
}
function unclassified(item: StandardizationDecision, reason: string, reasonCode: StandardizationReasonCode, diagnostic: StandardizationDiagnostic): StandardizationDecision {
  return { id: item.id, status: 'unclassified', ruleIds: [], evidence: [], reasonCode, reason, diagnostic,
    ...(item.review ? { review: item.review } : {}) };
}

/** Tag extraction enforces citations and complete attribute claims independently of identity. */
export function validateStandardizationTags(proposedTags: readonly StandardizationTag[], payload: JsonValue, proposedIdentity?: Identity, initialDiagnostic?: StandardizationDiagnostic): { tags: StandardizationTag[]; rejectedTags: Array<StandardizationTag & { reasonCode: string; reason: string }>; diagnostic?: StandardizationDiagnostic } {
  const tags: StandardizationTag[] = [];
  const rejectedTags: Array<StandardizationTag & { reasonCode: string; reason: string }> = [];
  const validationErrors = new Map<string, unknown>();
  let tagDiagnostic = initialDiagnostic;
  // Reject foreign subjects before they can create SKU conflicts.
  const scopedTags = proposedTags.filter(tag => {
    try { tagCitationSources(tag.evidence, payload); }
    catch (error) {
      if (error instanceof StandardizationValidationError && error.diagnostic.code === 'tag_subject_mismatch') {
        rejectedTags.push({ ...tag, reasonCode: error.diagnostic.code, reason: error.message });
        tagDiagnostic ??= error.diagnostic;
        return false;
      }
    }
    return true;
  });
  for (const [index, tag] of scopedTags.entries()) {
    const diagnostic: StandardizationDiagnostic = { stage: 'attribute', code: 'tag_value_conflict', fieldPath: 'tags[' + index + ']', proposedIdentity };
    try {
      if (!PRODUCT_TAG_RULES[tag.name]?.multiple && scopedTags.some(other => other.name === tag.name && tagValueKey(other.value) !== tagValueKey(tag.value))) {
        throw new StandardizationValidationError('单值标签出现多个互相冲突的值', 'attribute_conflict',
          { ...diagnostic, code: 'tag_single_value_conflict' });
      }
      const key = JSON.stringify(tag);
      if (!validationErrors.has(key)) {
        try { validateTag(tag, payload); validationErrors.set(key, null); }
        catch (error) { validationErrors.set(key, error); }
      }
      if (validationErrors.get(key) !== null) throw validationErrors.get(key);
      tags.push(tag);
    } catch (error) {
      rejectedTags.push({ ...tag, reasonCode: error instanceof StandardizationValidationError ? error.diagnostic.code : 'tag_value_conflict', reason: error instanceof Error ? error.message : '标签证据无效' });
      // Optional attributes cannot invalidate an independently verified identity.
      tagDiagnostic ??= error instanceof StandardizationValidationError ? { ...error.diagnostic, proposedIdentity } : diagnostic;
    }
  }
  return { tags, rejectedTags, ...(tagDiagnostic ? { diagnostic: tagDiagnostic } : {}) };
}

/** Validate every decision against its frozen source before atomically saving any result. */
export function validateStandardizationEvidence(
  response: ParsedStandardizationResponse,
  inputs: readonly { id: string; payload: JsonValue }[],
  candidates: readonly CandidateDocument[],
  mode: 'semantic' | 'boundary' = 'semantic',
): ParsedStandardizationResponse {
  const byId = new Map(inputs.map(input => [input.id, input.payload]));
  const identities = new Map(response.identities.map(identity => [identity.ref, identity]));
  const existing = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const items = response.items.map(item => {
    if (mode === 'boundary' && item.status !== 'classified'
      && item.reasonCode !== 'insufficient_evidence' && item.reasonCode !== 'not_sellable') return item;
    const payload = byId.get(item.id);
    if (payload === undefined) throw new Error('标准化决策缺少对应输入快照');
    const chosen = item.identity?.kind === 'new' ? identities.get(item.identity.ref)
      : item.identity?.kind === 'existing' ? existing.get(item.identity.standardProductId) : undefined;
    const proposedIdentity = chosen ? normalizeIdentity(chosen) : undefined;
    let diagnostic: StandardizationDiagnostic = { stage: 'evidence', code: 'citation_invalid', proposedIdentity };
    try {
      citationSources(item.evidence, payload, item.status === 'classified');
      if (mode === 'boundary') {
        if (item.evidence.length) validateTagCitations(item.evidence, payload);
        if (item.status === 'classified') {
          if (!chosen) throw new Error('标准化身份不在当前响应或候选快照中');
          if ('evidence' in chosen) validateTagCitations(chosen.evidence, payload);
        }
        return item;
      }
      const source = payload && !Array.isArray(payload) && typeof payload === 'object' ? payload : {};
      const publicationConflict = publicationEvidenceConflict(source, 'text');
      if (item.status !== 'classified') return item.reasonCode === 'insufficient_evidence' && publicationConflict
        ? unclassified(item, publicationConflict, 'publication_blocked', { stage: 'publication', code: 'commercial_evidence_conflict', proposedIdentity })
        : item;
      if (!chosen) throw new Error('标准化身份不在当前响应或候选快照中');
      if ('evidence' in chosen) citationSources(chosen.evidence, payload, true, 'identity.evidence');
      const conflict = identityEvidenceConflict(chosen as Identity, source, 'text');
      if (conflict) return unclassified(item, conflict, 'identity_conflict', { stage: 'identity', code: 'evidence_identity_conflict',
        proposedIdentity, ruleIds: assessProductEvidence(source, 'text').rules.slice(0, 8) });
      if (publicationConflict) return unclassified(item, publicationConflict, 'publication_blocked', {
        stage: 'publication', code: 'commercial_evidence_conflict', proposedIdentity,
      });
      return item;
    } catch (error) {
      return unclassified(item, error instanceof Error ? error.message : '商品证据无效',
        error instanceof StandardizationValidationError ? error.reasonCode : diagnostic.stage === 'attribute' ? 'attribute_conflict' : 'evidence_invalid',
        error instanceof StandardizationValidationError ? { ...error.diagnostic, proposedIdentity } : diagnostic);
    }
  });
  // Failed identity evidence must not survive into canonical folding or storage.
  const referenced = new Set(items.flatMap(item => item.status === 'classified' && item.identity?.kind === 'new' ? [item.identity.ref] : []));
  return { ...response, items, identities: response.identities.filter(identity => referenced.has(identity.ref)) };
}

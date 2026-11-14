import type { JsonValue } from '../database/types.js';
import { canonicalizeMatchText } from '../standardization/fingerprint.js';
import { assessProductEvidence, identityEvidenceConflict, normalizeIdentity, type Identity } from '../standardization/identity-policy.js';
import type { CandidateDocument } from '../standardization/candidate-index.js';
import { publicationEvidenceConflict } from '../standardization/publication-evidence.js';
import { StandardizationValidationError, type StandardizationDiagnostic, type StandardizationReasonCode, type EvidenceCitation, type ParsedStandardizationResponse, type StandardizationDecision } from './ai.schemas.js';

interface CitationSource { path: string; quote: string; source: string }

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

/** Identity boundaries and fingerprint rebasing require literal source citations. */
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

function unclassified(item: StandardizationDecision, reason: string, reasonCode: StandardizationReasonCode, diagnostic: StandardizationDiagnostic): StandardizationDecision {
  return { id: item.id, status: 'unclassified', ruleIds: [], evidence: [], reasonCode, reason, diagnostic,
    ...(item.review ? { review: item.review } : {}) };
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

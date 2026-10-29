import type { JsonValue } from '../database/types.js';
import { normalizePurchaseTag } from '@price-comparison/catalog/purchase-attributes';
import { normalizeProductTag, PRODUCT_TAG_RULES } from '@price-comparison/catalog/product-tag-policy';
import { canonicalizeMatchText } from '../standardization/fingerprint.js';
import { assessProductEvidence, identityEvidenceConflict, normalizeIdentity, type Identity } from '../standardization/identity-policy.js';
import type { CandidateDocument } from '../standardization/candidate-index.js';
import { publicationEvidenceConflict } from '../standardization/publication-evidence.js';
import { currentProductTagEvidence, scopeEvidenceLines, tagCitationSupports, tagEvidenceFacts, warrantyEvidenceFacts } from './tag-evidence.js';
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

function durationFacts(text: string): Set<string> {
  // Warranty periods are not subscription terms, including a quote cut out of a warranty sentence.
  const period = String.raw`(?:(?:\d+(?:\.\d+)?|一|二|两|三|半)[\s-]*(?:个?月|年|天|周|months?|years?|days?|weeks?)|monthly|quarterly|annual(?:ly)?|yearly|permanent|lifetime|永久|终身)`;
  const warranty = String.raw`(?:质保|保修|售后|warranty|guarantee)`;
  const clean = text.replace(new RegExp(`${warranty}(?:期限|时长|时间|保障|期|为|是|for|of|is|coverage|[\\s:：])*${period}`, 'giu'), ' ')
    .replace(new RegExp(`${period}\\s*(?:的)?\\s*${warranty}`, 'giu'), ' ')
    .replace(new RegExp(`(?:token|令牌)(?:有效期|有效期限|validity)[\\s:：为是]*${period}|(?:账号)?(?:号龄|年龄)[\\s:：为是]*${period}`, 'giu'), ' ');
  const facts = new Set<string>();
  for (const match of clean.matchAll(/(?<![\d.零一二两三四五六七八九十百千万])([0-9]+(?:\.[0-9]+)?|一|二|两|三|半)[\s-]*(个月|月|年|天|周|months?|years?|days?|weeks?)(?![a-z])/gu)) {
    const amount = ({ 一: 1, 二: 2, 两: 2, 三: 3, 半: 0.5 } as Record<string, number>)[match[1]!] ?? Number(match[1]);
    const unit = match[2]!;
    if (!Number.isFinite(amount) || amount <= 0) continue;
    facts.add(/年|year/u.test(unit) ? `months:${amount * 12}` : /月|month/u.test(unit) ? `months:${amount}` : /周|week/u.test(unit) ? `days:${amount * 7}` : `days:${amount}`);
  }
  if (/月卡|包月|(?<![a-z])monthly(?![a-z])/u.test(clean)) facts.add('months:1');
  if (/季卡|季度|(?<![a-z])quarterly(?![a-z])/u.test(clean)) facts.add('months:3');
  if (/年卡|包年|(?<![a-z])(?:annual|annually|yearly)(?![a-z])/u.test(clean)) facts.add('months:12');
  if (/永久|终身|(?<![a-z])(?:permanent|lifetime)(?![a-z])/u.test(clean)) facts.add('permanent');
  return facts;
}

function accessFacts(text: string): Set<string> {
  const facts = new Set<string>();
  // Negative wording cannot be cherry-picked as positive support.
  const clean = text.replace(/(?:不支持|不提供|不能|不可|禁止|非|不|无需)\s*(?:合租|共享|独享|独用)|(?:not|no|without)\s+(?:for\s+)?(?:shared|sharing|private|dedicated|exclusive)/gu, ' ');
  if (/合租|共享|(?<![a-z])(?:shared|sharing|public)(?![a-z])/u.test(clean)) facts.add('shared');
  if (/独享|独用|独立账号|(?<![a-z])(?:dedicated|private|exclusive)(?![a-z])/u.test(clean)) facts.add('dedicated');
  return facts;
}

function textFacts(value: JsonValue | undefined, primaryText: string): string {
  if (Array.isArray(value)) return value.map(item => textFacts(item, primaryText)).join('; ');
  if (value && typeof value === 'object') {
    return Object.values(value).map(item => textFacts(item, primaryText)).join(' ');
  }
  return canonicalizeMatchText(typeof value === 'string' ? currentProductTagEvidence(value, primaryText) : value);
}

function twoFactorFacts(text: string): Set<string> {
  if (/部分|可能|建议|推荐|需(?:要)?设置|或|\bor\b|optional|recommended|required|unknown/u.test(text)) return new Set();
  const exact = normalizeProductTag({ name: '2fa', value: text });
  if (exact?.length) return new Set(exact.map(tag => tag.value));
  const negative = /(?:no |without |不带|不支持|无|未设置|未开启)(?:2fa|mfa)|(?:2fa|mfa)[ :：]*(?:not (?:included|enabled|supported)|disabled|无|未开启)/gu;
  const absent = negative.test(text);
  const positive = /2fa|mfa/u.test(text.replace(negative, ' '));
  return new Set([...(absent ? ['无'] : []), ...(positive ? ['有'] : [])]);
}

function verificationFacts(text: string, name: string): Set<string> {
  if (/部分|可能|或|\bor\b|partial|maybe|不保证/u.test(text)) return new Set();
  if (name === 'sms_verification' && /kyc|实名/u.test(text) && !/sms|短信|接码|接马/u.test(text)) return new Set();
  if (name === 'kyc' && /sms|短信|接码|接马/u.test(text) && !/kyc|实名/u.test(text)) return new Set();
  const negative = /\b(?:unverified|not verified)\b|(?:并非|不是|没有)已(?:接码|接马|验证|认证|实名)|未(?:接码|接马|验证|认证|实名)|未过kyc|(?:未|尚未|(?:并非|不是|没有)已)完成(?:短信验证|真人验证|实名认证|kyc)/gu;
  const absent = negative.test(text);
  const clean = text.replace(negative, ' ');
  const completion = name === 'kyc' ? /已完成(?:真人验证|实名认证|kyc)/u : /已完成短信验证/u;
  const completed = clean.split(/[;；。!！?？\n]/u).some(sentence =>
    !/建议|推荐|如果|若|仅限|前提|条件|才能|才可/u.test(sentence)
    && sentence.split(/[,，]/u).some(clause => completion.test(clause)
      && !/并非|不是|没有|无需|不需要|需要|必须|不要求/u.test(clause)));
  const positive = /\bverified\b|已(?:接码|接马|验证|认证|实名)|已过kyc/u.test(clean) || completed;
  return new Set([...(absent ? ['unverified'] : []), ...(positive ? ['verified'] : [])]);
}

function validateTag(tag: StandardizationTag, payload: JsonValue): void {
  const sources = tagCitationSources(tag.evidence, payload);
  const canonical = normalizePurchaseTag(tag)[0]!;
  const facts = canonical.name === 'duration' ? durationFacts : canonical.name === 'access' ? accessFacts : canonical.name === '2fa' ? twoFactorFacts
    : ['sms_verification', 'kyc'].includes(canonical.name) ? (text: string) => verificationFacts(text, canonical.name) : undefined;
  if (!facts) {
    for (const source of sources) {
      const field = source.path.split(/[.[\]]/u).filter(Boolean).at(-1)!;
      if (normalizeProductTag({ name: field, value: source.source })?.some(fact => fact.name === canonical.name)) {
        source.source = `${canonical.name}: ${source.source}`;
      }
    }
    let selected = new Set<string>();
    if (payload && !Array.isArray(payload) && typeof payload === 'object') {
      selected = tagEvidenceFacts(canonical, canonicalizeMatchText(payload.spec));
    }
    const multiple = PRODUCT_TAG_RULES[canonical.name]?.multiple;
    if (selected.size && !selected.has(canonical.value)) throw new Error('标签与商品选中规格冲突');
    if (!sources.some(source => {
      const context = tagEvidenceFacts(canonical, source.source);
      return context.has(canonical.value) && (multiple || context.size === 1 || selected.has(canonical.value))
        && tagCitationSupports(canonical, source.quote, source.source);
    })) throw new Error('标签证据不支持所声明的属性事实');
    return;
  }
  const expected = facts(canonical.value);
  if (expected.size !== 1) throw new Error('标签值不是明确的属性事实');
  const wanted = [...expected][0]!;
  let selected = new Set<string>();
  if (payload && !Array.isArray(payload) && typeof payload === 'object') {
    selected = facts(canonicalizeMatchText(payload.spec));
    if (!selected.size) selected = facts(canonicalizeMatchText(payload.name));
    if (selected.size && (selected.size !== 1 || !selected.has(wanted))) throw new Error('标签与商品选中规格或标题冲突');
  }
  const supported = sources.some(source => {
    if (canonical.name === 'duration' && /warranty|guarantee|质保|保修/iu.test(source.path)) return false;
    const context = facts(source.source);
    return facts(source.quote).has(wanted) && context.has(wanted) && (context.size === 1 || selected.has(wanted));
  });
  if (!supported) throw new Error('标签证据不支持所声明的属性事实');
}

function validateWarrantyGroup(tags: readonly StandardizationTag[], payload: JsonValue): boolean {
  const warrantyTags = tags.map(tag => normalizePurchaseTag(tag)[0]!).filter(tag => tag.name.startsWith('warranty'));
  if (!warrantyTags.length) return false;
  const sourceText = textFacts(payload, primaryTagText(payload));
  if (/(?:仅限自用|非人为|人为.*(?:不保|除外)|修改[^，。；]*不保|(?:质保|保修)[^，。；]*(?:才保|条件|前提)|(?:质保|保修)\s*\d[^，。；]*(?:需|必须|保持|修改后))/u.test(sourceText)) {
    return true;
  }
  if (warrantyTags.some(tag => tag.name === 'warranty_days')
    && !warrantyTags.some(tag => tag.name === 'warranty_scope')
    && /(?:首登|首次登录|first[_-]?login|订阅质保|subscription coverage)/u.test(sourceText)) {
    return true;
  }
  return false;
}

function unclassified(item: StandardizationDecision, reason: string, reasonCode: StandardizationReasonCode, diagnostic: StandardizationDiagnostic): StandardizationDecision {
  return { id: item.id, status: 'unclassified', ruleIds: [], evidence: [], reasonCode, reason, diagnostic,
    ...(item.review ? { review: item.review } : {}) };
}

/** Tag extraction enforces citation, attribute and warranty group rules independently of identity. */
export function validateStandardizationTags(proposedTags: readonly StandardizationTag[], payload: JsonValue, proposedIdentity?: Identity, initialDiagnostic?: StandardizationDiagnostic): { tags: StandardizationTag[]; rejectedTags: Array<StandardizationTag & { reasonCode: string; reason: string }>; diagnostic?: StandardizationDiagnostic } {
  const tags: StandardizationTag[] = [];
  const rejectedTags: Array<StandardizationTag & { reasonCode: string; reason: string }> = [];
  const validationErrors = new Map<string, unknown>();
  let tagDiagnostic = initialDiagnostic;
  // Reject foreign subjects before they can create SKU conflicts or invalidate a warranty group.
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
  let invalidWarranty = validateWarrantyGroup(scopedTags, payload);
  if (invalidWarranty) tagDiagnostic = { stage: 'attribute', code: 'warranty_group_invalid', proposedIdentity };
  for (const [index, tag] of scopedTags.entries()) {
    const diagnostic: StandardizationDiagnostic = { stage: 'attribute', code: 'tag_value_conflict', fieldPath: 'tags[' + index + ']', proposedIdentity };
    try {
      if (!PRODUCT_TAG_RULES[tag.name]?.multiple && scopedTags.some(other => other.name === tag.name && other.value !== tag.value)) {
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
      invalidWarranty ||= tag.name.startsWith('warranty');
    }
  }
  if (!invalidWarranty) {
    for (const tag of tags.filter(tag => tag.name.startsWith('warranty') && tag.value !== 'none')) {
      const required = tagCitationSources(tag.evidence, payload).flatMap(source => {
        const facts = warrantyEvidenceFacts(source.source);
        const qualified = facts.some(fact => fact.name === 'warranty_scope' && fact.value !== 'period');
        return facts.filter(fact => fact.name === 'warranty_exclusion' || fact.name === 'warranty_trigger'
          || (qualified && fact.name === 'warranty_window') || (fact.name === 'warranty_scope' && fact.value !== 'period'));
      });
      if (required.some(fact => !tags.some(tag => tag.name === fact.name && tag.value === fact.value))) {
        invalidWarranty = true;
        tagDiagnostic ??= { stage: 'attribute', code: 'tag_value_conflict', proposedIdentity };
        break;
      }
    }
  }
  // Removing a warranty condition must also remove the promise it qualifies.
  if (invalidWarranty) for (const tag of tags.filter(tag => tag.name.startsWith('warranty'))) rejectedTags.push({ ...tag, reasonCode: 'warranty_group_invalid', reason: '质保条件不完整或冲突，整组待复核' });
  return { tags: tags.filter(tag => !(invalidWarranty && tag.name.startsWith('warranty'))), rejectedTags, ...(tagDiagnostic ? { diagnostic: tagDiagnostic } : {}) };
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

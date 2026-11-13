import type { JsonValue } from '../database/types.js';
import { tagValueKey, type TagValue } from '@price-comparison/catalog/purchase-attributes';
import { readTextEvidence, validateTextReview, type TextReview } from '../shops/shop-text-review.js';
import { StandardizationValidationError, type StandardizationTag } from './ai.schemas.js';
import { validateStandardizationTags, validateTagCitations } from './standardization-evidence.js';
import { sanitizeEvidenceText } from '../standardization/service-evidence.js';
import { PRODUCT_TAG_RULES, isCanonicalProductTag } from '@price-comparison/catalog/product-tag-policy';
import type { MembershipClassification, MembershipKind } from '@price-comparison/catalog/membership-policy';

export type TagExtractionOutcome = 'updated' | 'unchanged' | 'empty' | 'review' | 'skipped' | 'failed' | 'cancelled';
export interface TagFact { name: string; value: TagValue }
export interface TagExtractionTag extends StandardizationTag { proposalIndex?: number }
export interface RejectedTag extends TagExtractionTag { reasonCode: string; reason: string }
export interface TagExtractionDecision { productId: bigint; tags: TagExtractionTag[]; rejectedTags: RejectedTag[]; membershipKind?: MembershipKind; classificationReviewed?: boolean; reviewed?: boolean; reviewDecisions?: boolean[]; textReview?: TextReview | null }
export interface TagExtractionResult {
  classification?: MembershipClassification;
  proposedMembershipKind?: MembershipKind;
  classificationReviewed?: boolean;
  outcome: TagExtractionOutcome; reasonCode: string | null;
  acceptedTags: TagExtractionTag[]; rejectedTags: RejectedTag[];
  before: TagFact[]; after: TagFact[];
  diff: Array<{ name: string; before: TagValue[]; after: TagValue[] }>;
  review?: { mode: 'per_tag_binary'; decisions?: boolean[] } | { mode: 'membership_binary'; decision: boolean };
  textReview?: TextReview | null;
  versions?: { contentVersion: string; fingerprint: string; revision: string; pipeline: JsonValue };
}
export const sanitizeTagAuditText = (value: string, limit = 1000): string => sanitizeEvidenceText(value).slice(0, limit);
const auditValue = (value: TagValue): TagValue => typeof value === 'string' ? sanitizeTagAuditText(value, 500) : value;
function auditTag<T extends StandardizationTag>(tag: T): T {
  return { ...tag, name: sanitizeTagAuditText(tag.name, 100), value: auditValue(tag.value),
    evidence: tag.evidence.slice(0, 8).map(c => ({ path: sanitizeTagAuditText(c.path, 300), quote: sanitizeTagAuditText(c.quote) })),
    ...('reason' in tag ? { reason: sanitizeTagAuditText(String(tag.reason)), reasonCode: sanitizeTagAuditText(String(Reflect.get(tag, 'reasonCode')), 100) } : {}) };
}
export function validateTagExtractionDecision(productId: bigint, tags: readonly StandardizationTag[], payload: JsonValue): TagExtractionDecision {
  const rejectedTags: RejectedTag[] = [];
  const candidates = tags.filter(tag => {
    if (!Object.hasOwn(PRODUCT_TAG_RULES, tag.name)) {
      rejectedTags.push({ ...tag, reasonCode: 'tag_name_unknown', reason: '标签名称不在规范词表中' });
      return false;
    }
    if (!isCanonicalProductTag({ name: tag.name, value: tag.value })) {
      rejectedTags.push({ ...tag, reasonCode: 'tag_value_invalid', reason: '标签值不符合规范枚举或格式' });
      return false;
    }
    return true;
  });
  const validated = validateStandardizationTags(candidates, payload);
  const facts = new Set<string>();
  validated.tags = validated.tags.filter(tag => {
    const fact = JSON.stringify([tag.name, tagValueKey(tag.value)]);
    if (facts.has(fact)) {
      rejectedTags.push({ ...tag, reasonCode: 'tag_duplicate', reason: '重复的标签事实已去重' });
      return false;
    }
    facts.add(fact);
    return true;
  });
  return { productId, tags: validated.tags, rejectedTags: [...rejectedTags, ...validated.rejectedTags] };
}
export function validateReviewedTagExtractionDecision(productId: bigint, tags: readonly TagExtractionTag[], rejectedTags: readonly RejectedTag[], payload: JsonValue, decisions?: readonly boolean[], textReview?: unknown): TagExtractionDecision {
  const text = readTextEvidence(payload);
  let validatedText: TextReview | null | undefined;
  try { validatedText = textReview !== undefined || text ? validateTextReview(textReview, text) : undefined; }
  catch {
    throw new StandardizationValidationError('标签复核的文本审查无效', 'evidence_invalid',
      { stage: 'attribute', code: 'text_review_invalid', fieldPath: 'items.textReview' });
  }
  if (decisions !== undefined) {
    const occurrences = [...tags, ...rejectedTags];
    const indexes = occurrences.map(tag => tag.proposalIndex);
    if (!Array.isArray(decisions) || decisions.length > 100 || decisions.length !== occurrences.length
      || decisions.some(vote => typeof vote !== 'boolean')
      || indexes.some(index => !Number.isInteger(index) || index! < 0 || index! >= decisions.length)
      || new Set(indexes).size !== occurrences.length
      || tags.some(tag => decisions[tag.proposalIndex!] !== true)
      || rejectedTags.some(tag => decisions[tag.proposalIndex!] !== (tag.reasonCode !== 'review_rejected'))) {
      throw new Error('标签审查记录与原始候选顺序或二元判定不一致');
    }
  }
  const accepted: TagExtractionTag[] = [];
  const rejected = [...rejectedTags];
  const facts = new Set<string>();
  for (const tag of tags) {
    let code: string | undefined;
    let reason = '';
    const rule = PRODUCT_TAG_RULES[tag.name];
    if (!Object.hasOwn(PRODUCT_TAG_RULES, tag.name)) { code = 'tag_name_unknown'; reason = '标签名称不在规范词表中'; }
    else if (!isCanonicalProductTag(tag)) {
      code = 'tag_value_invalid'; reason = '标签值不符合规范枚举或格式';
    } else if (!rule!.multiple && tags.some(other => other.name === tag.name && tagValueKey(other.value) !== tagValueKey(tag.value)
      && isCanonicalProductTag(other))) {
      code = 'tag_single_value_conflict'; reason = '单值标签出现多个互相冲突的值';
    } else {
      try { validateTagCitations(tag.evidence, payload); }
      catch (error) {
        code = (error as { diagnostic?: { code?: string } }).diagnostic?.code ?? 'citation_invalid';
        reason = error instanceof Error ? error.message : '标签证据无效';
      }
      if (!code && ['warranty', 'bulk_purchase'].includes(tag.name)) {
        const invalid = validateStandardizationTags([tag], payload).rejectedTags[0];
        if (invalid) { code = invalid.reasonCode; reason = invalid.reason; }
      }
    }
    const key = JSON.stringify([tag.name, tagValueKey(tag.value)]);
    if (!code && facts.has(key)) { code = 'tag_duplicate'; reason = '重复的标签事实已去重'; }
    if (code) rejected.push({ ...tag, reasonCode: code, reason });
    else { facts.add(key); accepted.push(tag); }
  }
  return { productId, tags: accepted, rejectedTags: rejected, reviewed: true,
    ...(validatedText !== undefined ? { textReview: validatedText } : {}),
    ...(decisions !== undefined ? { reviewDecisions: [...decisions] } : {}) };
}
export function buildTagExtractionOutcome(decision: TagExtractionDecision, before: TagFact[], terminal?: { outcome: 'skipped' | 'failed' | 'cancelled'; reasonCode: string }): TagExtractionResult {
  const names = new Set([...before.map(t => t.name), ...decision.tags.map(t => t.name)]);
  const after = terminal ? before : decision.tags.map(({ name, value }) => ({ name, value }));
  const values = (tags: TagFact[], name: string) => tags.filter(t => t.name === name).map(t => t.value)
    .sort((a, b) => tagValueKey(a).localeCompare(tagValueKey(b)));
  const diff = terminal ? [] : [...names].flatMap(name => JSON.stringify(values(before, name).map(tagValueKey)) === JSON.stringify(values(after, name).map(tagValueKey)) ? [] : [{ name, before: values(before, name), after: values(after, name) }]);
  const auditFacts = (facts: TagFact[]) => facts.slice(0, 256).map(fact => ({ name: sanitizeTagAuditText(fact.name, 100), value: auditValue(fact.value) }));
  return { outcome: terminal?.outcome ?? (diff.length ? 'updated' : decision.rejectedTags.length ? 'review' : decision.tags.length ? 'unchanged' : 'empty'),
    reasonCode: terminal ? sanitizeTagAuditText(terminal.reasonCode, 100) : decision.rejectedTags.length ? 'tag_evidence_rejected' : null,
    acceptedTags: decision.tags.slice(0, 128).map(auditTag), rejectedTags: decision.rejectedTags.slice(0, 128).map(auditTag),
    before: auditFacts(before), after: auditFacts(after), diff: diff.slice(0, 128).map(change => ({ name: sanitizeTagAuditText(change.name, 100), before: change.before.slice(0, 256).map(auditValue), after: change.after.slice(0, 256).map(auditValue) })),
    ...(decision.textReview !== undefined ? { textReview: decision.textReview } : {}),
    ...(decision.reviewed && decision.membershipKind && typeof decision.classificationReviewed === 'boolean'
      ? { review: { mode: 'membership_binary' as const, decision: decision.classificationReviewed } }
      : decision.reviewed ? { review: { mode: 'per_tag_binary' as const,
      ...(decision.reviewDecisions !== undefined ? { decisions: [...decision.reviewDecisions] } : {}) } } : {}) };
}

export function tagExtractionVersions(member: { content_version: bigint; fingerprint: string; standardization_revision: bigint }, pipeline: JsonValue): NonNullable<TagExtractionResult['versions']> {
  const bounded = pipeline && !Array.isArray(pipeline) && typeof pipeline === 'object'
    ? Object.fromEntries(Object.entries(pipeline).slice(0, 32).map(([key, value]) => [sanitizeTagAuditText(key, 100), value === null ? null : sanitizeTagAuditText(typeof value === 'string' ? value : JSON.stringify(value), 500)])) : null;
  return { contentVersion: member.content_version.toString(), fingerprint: sanitizeTagAuditText(member.fingerprint, 128), revision: member.standardization_revision.toString(), pipeline: bounded };
}

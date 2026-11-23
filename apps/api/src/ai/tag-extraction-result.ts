import type { JsonValue } from '../database/types.js';
import { tagValueKey, type TagValue } from '@price-comparison/catalog/purchase-attributes';
import type { TextReview } from '../shops/shop-text-review.js';
import type { StandardizationTag } from './ai.schemas.js';
import { sanitizeEvidenceText } from '../standardization/service-evidence.js';
import { PRODUCT_TAG_RULES, isCanonicalProductTag } from '@price-comparison/catalog/product-tag-policy';
import type { MembershipClassification, MembershipKind } from '@price-comparison/catalog/membership-policy';
import { warrantyTags, WARRANTY_TAG_NAMES, type WarrantyLabels } from './tag-warranty-request.js';
import type { MembershipFeatureReviewFeedback } from './membership-feature-request.js';

export type TagExtractionOutcome = 'updated' | 'unchanged' | 'empty' | 'partial_success' | 'review' | 'skipped' | 'failed' | 'cancelled';
export interface TagFact { name: string; value: TagValue }
export interface TagExtractionTag extends StandardizationTag { proposalIndex?: number }
export interface RejectedTag extends TagExtractionTag { reasonCode: string; reason: string }
export interface TagExtractionAttempt { round: number; tags: TagExtractionTag[]; rejectedTags: RejectedTag[]; complete: boolean; reviewDecisions?: boolean[]; reviewFeedback?: string }
export interface TagExtractionDecision { productId: bigint; tags: TagExtractionTag[]; rejectedTags: RejectedTag[]; warrantyLabels?: WarrantyLabels; membershipKind?: MembershipKind; membershipRefs?: number[]; membershipReview?: MembershipFeatureReviewFeedback; classificationReviewed?: boolean; reviewed?: boolean; reviewDecisions?: boolean[]; reviewFeedback?: string; complete?: boolean; attempts?: TagExtractionAttempt[]; textReview?: TextReview }
export interface TagExtractionResult {
  warrantyLabels?: WarrantyLabels;
  classification?: MembershipClassification;
  proposedMembershipKind?: MembershipKind;
  classificationReviewed?: boolean;
  outcome: TagExtractionOutcome; reasonCode: string | null;
  successfulCount: number; failedCount: number; complete: boolean;
  attempts?: TagExtractionAttempt[];
  acceptedTags: TagExtractionTag[]; rejectedTags: RejectedTag[];
  before: TagFact[]; after: TagFact[];
  diff: Array<{ name: string; before: TagValue[]; after: TagValue[] }>;
  review?: { mode: 'per_tag_binary'; decisions?: boolean[]; feedback?: string } | { mode: 'membership_binary'; decision: boolean; code?: MembershipFeatureReviewFeedback['code']; refs?: number[] };
  textReview?: TextReview;
  versions?: { contentVersion: string; fingerprint: string; revision: string; pipeline: JsonValue };
}
export const sanitizeTagAuditText = (value: string, limit = 1000): string => sanitizeEvidenceText(value).slice(0, limit);
const auditValue = (value: TagValue): TagValue => typeof value === 'string' ? sanitizeTagAuditText(value, 500) : value;
function auditTag<T extends StandardizationTag>(tag: T): T {
  return { ...tag, name: sanitizeTagAuditText(tag.name, 100), value: auditValue(tag.value),
    evidence: tag.evidence.slice(0, 8).map(c => ({ path: sanitizeTagAuditText(c.path, 300), quote: sanitizeTagAuditText(c.quote) })),
    ...('reason' in tag ? { reason: sanitizeTagAuditText(String(tag.reason)), reasonCode: sanitizeTagAuditText(String(Reflect.get(tag, 'reasonCode')), 100) } : {}) };
}
export function validateReviewedTagExtractionDecision(productId: bigint, tags: readonly TagExtractionTag[], rejectedTags: readonly RejectedTag[], _payload: JsonValue, decisions?: readonly boolean[], complete = true, reviewFeedback?: string): TagExtractionDecision {
  if (typeof complete !== 'boolean') throw new Error('标签复核完整性必须为布尔值');
  if (reviewFeedback !== undefined && (typeof reviewFeedback !== 'string' || reviewFeedback.length > 1000)) {
    throw new Error('标签复核反馈必须为不超过1000字的字符串');
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
    if (WARRANTY_TAG_NAMES.has(tag.name) || !Object.hasOwn(PRODUCT_TAG_RULES, tag.name)) { code = 'tag_name_unknown'; reason = '标签名称不在规范词表中'; }
    else if (!isCanonicalProductTag(tag)) {
      code = 'tag_value_invalid'; reason = '标签值不符合规范枚举或格式';
    } else if (!rule!.multiple && tags.some(other => other.name === tag.name && tagValueKey(other.value) !== tagValueKey(tag.value)
      && isCanonicalProductTag(other))) {
      code = 'tag_single_value_conflict'; reason = '单值标签只能返回一个不同值';
    }
    const key = JSON.stringify([tag.name, tagValueKey(tag.value)]);
    if (!code && facts.has(key)) { code = 'tag_duplicate'; reason = '重复的标签事实已去重'; }
    if (code) rejected.push({ ...tag, reasonCode: code, reason });
    else { facts.add(key); accepted.push(tag); }
  }
  return { productId, tags: accepted, rejectedTags: rejected, reviewed: true, complete,
    ...(reviewFeedback !== undefined ? { reviewFeedback } : {}),
    ...(decisions !== undefined ? { reviewDecisions: [...decisions] } : {}) };
}

export function needsTagRepair(decision: TagExtractionDecision): boolean {
  return decision.complete === false || decision.rejectedTags.some(tag => tag.reasonCode !== 'tag_duplicate');
}

const factKey = (tag: TagFact): string => JSON.stringify([tag.name, tagValueKey(tag.value)]);

export function recordTagRepairAttempt(previous: TagExtractionDecision, current: TagExtractionDecision): TagExtractionDecision {
  if (previous.productId !== current.productId) throw new Error('不能记录不同商品的标签修正结果');
  const snapshot = (decision: TagExtractionDecision, round: number): TagExtractionAttempt => ({
    round, tags: decision.tags.map(tag => ({ ...tag })), rejectedTags: decision.rejectedTags.map(tag => ({ ...tag })),
    complete: decision.complete ?? true,
    ...(decision.reviewDecisions !== undefined ? { reviewDecisions: [...decision.reviewDecisions] } : {}),
    ...(decision.reviewFeedback !== undefined ? { reviewFeedback: decision.reviewFeedback } : {}),
  });
  return {
    ...current,
    attempts: [previous.attempts?.[0] ?? snapshot(previous, 1), snapshot(current, 2)],
  };
}

function publishedTags(decision: TagExtractionDecision): TagExtractionTag[] {
  return [...decision.tags, ...(decision.warrantyLabels ? warrantyTags(decision.warrantyLabels) : [])];
}

export function resolveTagExtractionFacts(decision: TagExtractionDecision): TagFact[] {
  const facts = new Set<string>();
  return publishedTags(decision).map(({ name, value }) => ({ name, value })).filter(tag => {
    const key = factKey(tag);
    if (facts.has(key)) return false;
    facts.add(key);
    return true;
  });
}

export function buildTagExtractionOutcome(decision: TagExtractionDecision, before: TagFact[], terminal?: { outcome: 'skipped' | 'failed' | 'cancelled'; reasonCode: string }): TagExtractionResult {
  const accepted = publishedTags(decision);
  const rejected = decision.rejectedTags;
  const complete = decision.complete ?? true;
  const successfulCount = accepted.length;
  const failedCount = rejected.length;
  const failed = !successfulCount && (failedCount > 0 || !complete);
  const after = terminal || failed ? before : resolveTagExtractionFacts(decision);
  const names = new Set([...before.map(t => t.name), ...accepted.map(t => t.name)]);
  const values = (tags: TagFact[], name: string) => tags.filter(t => t.name === name).map(t => t.value)
    .sort((a, b) => tagValueKey(a).localeCompare(tagValueKey(b)));
  const diff = terminal ? [] : [...names].flatMap(name => JSON.stringify(values(before, name).map(tagValueKey)) === JSON.stringify(values(after, name).map(tagValueKey)) ? [] : [{ name, before: values(before, name), after: values(after, name) }]);
  const auditFacts = (facts: TagFact[]) => facts.slice(0, 256).map(fact => ({ name: sanitizeTagAuditText(fact.name, 100), value: auditValue(fact.value) }));
  return { outcome: terminal?.outcome ?? (failedCount || !complete ? successfulCount ? 'partial_success' : 'failed' : !successfulCount ? 'empty' : diff.length ? 'updated' : 'unchanged'),
    reasonCode: terminal ? sanitizeTagAuditText(terminal.reasonCode, 100) : failedCount ? 'tag_evidence_rejected' : !complete ? 'tag_review_incomplete' : null,
    successfulCount, failedCount, complete,
    ...(decision.warrantyLabels ? { warrantyLabels: decision.warrantyLabels } : {}),
    acceptedTags: accepted.slice(0, 100).map(auditTag), rejectedTags: rejected.slice(0, 100).map(auditTag),
    before: auditFacts(before), after: auditFacts(after), diff: diff.slice(0, 128).map(change => ({ name: sanitizeTagAuditText(change.name, 100), before: change.before.slice(0, 256).map(auditValue), after: change.after.slice(0, 256).map(auditValue) })),
    ...(decision.textReview !== undefined ? { textReview: decision.textReview } : {}),
    ...(decision.attempts !== undefined ? { attempts: decision.attempts.slice(0, 2).map(attempt => ({
      round: attempt.round, tags: attempt.tags.slice(0, 100).map(auditTag), rejectedTags: attempt.rejectedTags.slice(0, 100).map(auditTag),
      complete: attempt.complete, ...(attempt.reviewDecisions !== undefined ? { reviewDecisions: attempt.reviewDecisions.slice(0, 100) } : {}),
      ...(attempt.reviewFeedback !== undefined ? { reviewFeedback: sanitizeTagAuditText(attempt.reviewFeedback) } : {}),
    })) } : {}),
    ...(decision.reviewed && decision.membershipKind && typeof decision.classificationReviewed === 'boolean'
      ? { review: { mode: 'membership_binary' as const, decision: decision.classificationReviewed,
        ...(decision.membershipReview ? { code: decision.membershipReview.code, refs: [...decision.membershipReview.refs] } : {}) } }
      : decision.reviewed ? { review: { mode: 'per_tag_binary' as const,
      ...(decision.reviewFeedback !== undefined ? { feedback: sanitizeTagAuditText(decision.reviewFeedback) } : {}),
      ...(decision.reviewDecisions !== undefined ? { decisions: [...decision.reviewDecisions] } : {}) } } : {}) };
}

export function tagExtractionVersions(member: { content_version: bigint; fingerprint: string; standardization_revision: bigint }, pipeline: JsonValue): NonNullable<TagExtractionResult['versions']> {
  const bounded = pipeline && !Array.isArray(pipeline) && typeof pipeline === 'object'
    ? Object.fromEntries(Object.entries(pipeline).slice(0, 32).map(([key, value]) => [sanitizeTagAuditText(key, 100), value === null ? null : sanitizeTagAuditText(typeof value === 'string' ? value : JSON.stringify(value), 500)])) : null;
  return { contentVersion: member.content_version.toString(), fingerprint: sanitizeTagAuditText(member.fingerprint, 128), revision: member.standardization_revision.toString(), pipeline: bounded };
}

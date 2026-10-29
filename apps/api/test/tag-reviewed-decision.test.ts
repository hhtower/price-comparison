import assert from 'node:assert/strict';
import test from 'node:test';
import { validateReviewedTagExtractionDecision, buildTagExtractionOutcome } from '../src/ai/tag-extraction-result.js';

const tag = (name: string, value: string, quote = value, path = 'sourceData.evidence') => ({
  name, value, evidence: [{ path, quote }],
});
const rejected = (fact: ReturnType<typeof tag>) => ({ ...fact, reasonCode: 'review_rejected', reason: 'LLM 对该标签判定为否' });

test('a true label keeps its original value and citation without legacy semantic veto', () => {
  const fact = tag('official_bill', '有', '可提供付款卡账单');
  const result = validateReviewedTagExtractionDecision(1n, [fact], [], { sourceData: { evidence: '可提供付款卡账单' } });
  assert.deepEqual(result.tags, [fact]);
  assert.deepEqual(buildTagExtractionOutcome(result, []).review, { mode: 'per_tag_binary' });
});

test('a false label is retained only in audit and does not change existing product facts', () => {
  const fact = tag('warranty', 'covered', '质保30天');
  const result = validateReviewedTagExtractionDecision(1n, [], [rejected(fact)], { sourceData: { evidence: '质保30天' } });
  const before = [{ name: 'warranty', value: 'covered' }, { name: 'warranty_days', value: '7' }];
  const output = buildTagExtractionOutcome(result, before);
  assert.deepEqual(result.tags, []);
  assert.deepEqual(result.rejectedTags, [rejected(fact)]);
  assert.deepEqual(output.after, before);
  assert.deepEqual(output.diff, []);
});

test('one false warranty label does not veto another true label from the same product', () => {
  const yes = tag('warranty_scope', 'first_login', '仅保首登');
  const no = rejected(tag('warranty_window', '30 days', '仅保首登'));
  const result = validateReviewedTagExtractionDecision(1n, [yes], [no], { sourceData: { evidence: '仅保首登' } });
  assert.deepEqual(result.tags, [yes]);
  assert.deepEqual(result.rejectedTags, [no]);
});

test('separate occurrences with different binary decisions remain independent', () => {
  const fact = tag('2fa', '有', '已配置2FA');
  const result = validateReviewedTagExtractionDecision(1n, [fact], [rejected(fact)], { sourceData: { evidence: '已配置2FA' } });
  assert.deepEqual(result.tags, [fact]);
  assert.deepEqual(result.rejectedTags, [rejected(fact)]);
});

test('true votes retain vocabulary, scalar path, verbatim quote and single-value safeguards', () => {
  const result = validateReviewedTagExtractionDecision(1n, [
    tag('2fa', '有', '已配置2FA', 'sourceData.__proto__.evidence'),
    tag('2fa', '有', '不存在'),
    tag('invented', '有', '已配置2FA'),
    tag('duration', '0 days', '已配置2FA'),
    tag('sms_verification', 'verified', '已配置2FA'),
    tag('sms_verification', 'unverified', '已配置2FA'),
  ], [], { sourceData: { evidence: '已配置2FA' } });
  assert.deepEqual(result.tags, []);
  assert.deepEqual(new Set(result.rejectedTags.map(fact => fact.reasonCode)), new Set([
    'citation_path_invalid', 'citation_quote_mismatch', 'tag_name_unknown', 'tag_value_invalid', 'tag_single_value_conflict',
  ]));
  const changedQuote = tag('2fa', '有', 'includes 2fa only first login');
  assert.deepEqual(validateReviewedTagExtractionDecision(1n, [changedQuote], [],
    { sourceData: { evidence: 'Includes 2FA\nOnly first login' } }).tags, []);
});

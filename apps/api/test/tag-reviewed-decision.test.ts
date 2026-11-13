import assert from 'node:assert/strict';
import test from 'node:test';
import { validateReviewedTagExtractionDecision, buildTagExtractionOutcome } from '../src/ai/tag-extraction-result.js';

const tag = (name: string, value: string, quote = value, path = 'sourceData.evidence') => ({
  name, value, evidence: [{ path, quote }],
});
const rejected = (fact: ReturnType<typeof tag>) => ({ ...fact, reasonCode: 'review_rejected', reason: 'LLM 对该标签判定为否' });

test('a true label keeps its original value and citation without legacy semantic veto', () => {
  const fact = tag('supported_client', 'codex', '可使用Codex');
  const result = validateReviewedTagExtractionDecision(1n, [fact], [], { sourceData: { evidence: '可使用Codex' } });
  assert.deepEqual(result.tags, [fact]);
  assert.deepEqual(buildTagExtractionOutcome(result, []).review, { mode: 'per_tag_binary' });
});

test('a false label is retained only in audit and is removed from the replacement result', () => {
  const fact = tag('warranty', 'covered', '质保30天');
  const result = validateReviewedTagExtractionDecision(1n, [], [rejected(fact)], { sourceData: { evidence: '质保30天' } });
  const before = [{ name: 'warranty', value: 'covered' }, { name: 'warranty_days', value: '7' }];
  const output = buildTagExtractionOutcome(result, before);
  assert.deepEqual(result.tags, []);
  assert.deepEqual(result.rejectedTags, [rejected(fact)]);
  assert.deepEqual(output.after, []);
  assert.equal(output.diff.length, 2);
});

test('one false warranty label does not veto another true label from the same product', () => {
  const yes = tag('warranty', '仅保首登', '仅保首登');
  const no = rejected(tag('duration', '30', '仅保首登'));
  const result = validateReviewedTagExtractionDecision(1n, [yes], [no], { sourceData: { evidence: '仅保首登' } });
  assert.deepEqual(result.tags, [yes]);
  assert.deepEqual(result.rejectedTags, [no]);
});

test('separate occurrences with different binary decisions remain independent', () => {
  const fact = tag('sms_verification', 'verified', '已接码');
  const result = validateReviewedTagExtractionDecision(1n, [fact], [rejected(fact)], { sourceData: { evidence: '已接码' } });
  assert.deepEqual(result.tags, [fact]);
  assert.deepEqual(result.rejectedTags, [rejected(fact)]);
});

test('true votes retain vocabulary, scalar path, verbatim quote and single-value safeguards', () => {
  const result = validateReviewedTagExtractionDecision(1n, [
    tag('supported_client', 'codex', '已接码', 'sourceData.__proto__.evidence'),
    tag('supported_client', 'codex', '不存在'),
    tag('invented', '有', '已接码'),
    tag('duration', '0 days', '已接码'),
    tag('sms_verification', 'verified', '已接码'),
    tag('sms_verification', 'unverified', '已接码'),
  ], [], { sourceData: { evidence: '已接码' } });
  assert.deepEqual(result.tags, []);
  assert.deepEqual(new Set(result.rejectedTags.map(fact => fact.reasonCode)), new Set([
    'citation_path_invalid', 'citation_quote_mismatch', 'tag_name_unknown', 'tag_value_invalid', 'tag_single_value_conflict',
  ]));
  const changedQuote = tag('sms_verification', 'verified', 'includes 2fa only first login');
  assert.deepEqual(validateReviewedTagExtractionDecision(1n, [changedQuote], [],
    { sourceData: { evidence: 'Includes 2FA\nOnly first login' } }).tags, []);
});

test('a true vote cannot drop coverage exclusions or turn optional bulk into a minimum order', () => {
  for (const [fact, evidence] of [
    [tag('warranty', '保订阅30天', '保订阅30天'), '保订阅30天，封号不保'],
    [tag('warranty', '所有问题无条件包赔', '所有问题无条件包赔'), '所有问题无条件包赔'],
    [tag('warranty', '本商品不提供售后。', '本商品不提供售后。'), '本商品不提供售后。'],
    [tag('warranty', '无售后，售出不退', '无售后，售出不退'), '无售后，售出不退'],
    [tag('warranty', '售后联系商家', '售后联系商家'), '售后联系商家'],
    [tag('bulk_purchase', 'required', '支持批量下单'), '支持批量下单'],
  ] as const) {
    const result = validateReviewedTagExtractionDecision(1n, [fact], [], { sourceData: { evidence } });
    assert.deepEqual(result.tags, []);
    assert.equal(result.rejectedTags.length, 1);
  }
});

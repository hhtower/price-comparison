import assert from 'node:assert/strict';
import test from 'node:test';
import { validateReviewedTagExtractionDecision, buildTagExtractionOutcome } from '../src/ai/tag-extraction-result.js';

const tag = (name: string, value: string | number) => ({
  name, value, evidence: [],
});
const rejected = (fact: ReturnType<typeof tag>) => ({ ...fact, reasonCode: 'review_rejected', reason: 'LLM 对该标签判定为否' });

test('a true label needs no citation or text review and ignores payload semantic rules', () => {
  const fact = tag('supported_client', 'codex');
  const result = validateReviewedTagExtractionDecision(1n, [fact], [], {
    sourceData: { evidence: '可使用Codex' },
    shopText: { unitId: '1', name: '账号', description: '完整商铺文案', hash: 'a'.repeat(64) },
  });
  assert.deepEqual(result.tags, [fact]);
  assert.equal(result.textReview, undefined);
  assert.deepEqual(buildTagExtractionOutcome(result, []).review, { mode: 'per_tag_binary' });
});

test('a false label stays in audit and cannot remove existing facts', () => {
  const fact = tag('warranty', '质保30天');
  const result = validateReviewedTagExtractionDecision(1n, [], [rejected(fact)], { sourceData: { evidence: '质保30天' } });
  const before = [{ name: 'warranty', value: 'covered' }, { name: 'warranty_days', value: '7' }];
  const output = buildTagExtractionOutcome(result, before);
  assert.deepEqual(result.tags, []);
  assert.deepEqual(result.rejectedTags, [rejected(fact)]);
  assert.deepEqual(output.after, before);
  assert.deepEqual(output.diff, []);
  assert.equal(output.outcome, 'failed');
});

test('one false warranty label does not veto another true label from the same product', () => {
  const yes = tag('warranty', '仅保首登');
  const no = rejected(tag('duration', 30));
  const result = validateReviewedTagExtractionDecision(1n, [yes], [no], { sourceData: { evidence: '仅保首登' } });
  assert.deepEqual(result.tags, [yes]);
  assert.deepEqual(result.rejectedTags, [no]);
});

test('separate occurrences with different binary decisions remain independent', () => {
  const fact = tag('sms_verification', 'verified');
  const result = validateReviewedTagExtractionDecision(1n, [fact], [rejected(fact)], { sourceData: { evidence: '已接码' } });
  assert.deepEqual(result.tags, [fact]);
  assert.deepEqual(result.rejectedTags, [rejected(fact)]);
});

test('true votes retain vocabulary, typed numeric values, length and single-value safeguards', () => {
  const result = validateReviewedTagExtractionDecision(1n, [
    tag('invented', '有'),
    tag('duration', '30'),
    tag('duration', 0),
    tag('duration', 36501),
    tag('duration', Number.NaN),
    tag('region', 'invalid'),
    tag('supported_client', 'c'.repeat(81)),
    tag('warranty', '质保'.repeat(126)),
    tag('sms_verification', 'verified'),
    tag('sms_verification', 'unverified'),
  ], [], { sourceData: { evidence: '已接码' } });
  assert.deepEqual(result.tags, []);
  assert.deepEqual(new Set(result.rejectedTags.map(fact => fact.reasonCode)), new Set([
    'tag_name_unknown', 'tag_value_invalid', 'tag_single_value_conflict',
  ]));
});

test('the review model owns warranty and bulk semantics instead of payload regex vetoes', () => {
  for (const [fact, evidence] of [
    [tag('warranty', '保订阅30天'), '保订阅30天，封号不保'],
    [tag('warranty', '所有问题无条件包赔'), '所有问题无条件包赔'],
    [tag('bulk_purchase', 'required'), '支持批量下单'],
  ] as const) {
    const result = validateReviewedTagExtractionDecision(1n, [fact], [], { sourceData: { evidence } });
    assert.deepEqual(result.tags, [fact]);
    assert.deepEqual(result.rejectedTags, []);
  }
});

test('same facts deduplicate and invalid candidates do not conflict with valid typed values', () => {
  const duration = tag('duration', 30);
  const result = validateReviewedTagExtractionDecision(1n, [duration, duration, tag('duration', '30')], [], {});
  assert.deepEqual(result.tags, [duration]);
  assert.deepEqual(result.rejectedTags.map(item => item.reasonCode), ['tag_duplicate', 'tag_value_invalid']);
});

test('complete defaults to true and only accepts a boolean', () => {
  assert.equal(validateReviewedTagExtractionDecision(1n, [], [], {}).complete, true);
  assert.equal(validateReviewedTagExtractionDecision(1n, [], [], {}, [], false).complete, false);
  assert.throws(() => validateReviewedTagExtractionDecision(1n, [], [], {}, [], {} as never));
});

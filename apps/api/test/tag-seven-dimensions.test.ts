import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTagExtractionResponse } from '../src/ai/tag-extraction-request.js';
import { buildTagExtractionOutcome, validateTagExtractionDecision, validateReviewedTagExtractionDecision } from '../src/ai/tag-extraction-result.js';
import { alignTagReviewDecisions, buildTagReviewRequest, parseTagReviewResponse } from '../src/ai/tag-review-request.js';
import type { StandardizationTag } from '../src/ai/ai.schemas.js';

const tag = (name: string, value: StandardizationTag['value'], quote: string, path = 'evidence') =>
  ({ name, value, evidence: [{ path, quote }] });

test('compact duration JSON and reviewed results preserve numeric days and structured qualifiers', () => {
  for (const value of [30, 365, 360, 0.5, { kind: 'range', min: 30, max: 90 }, { kind: 'min', days: 30 },
    { kind: 'max', days: 7 }, { kind: 'approx', days: 30 }, { kind: 'permanent' }]) {
    const response = { items: [{ id: '1', tags: [{ name: 'duration', value }] }] };
    const parsed = parseTagExtractionResponse(JSON.stringify(response));
    assert.deepEqual(parsed, response);
    const candidates = parsed.items[0]!.tags.map((tag, proposalIndex) => ({ ...tag, evidence: [], proposalIndex }));
    const reviewed = validateReviewedTagExtractionDecision(1n, candidates, [], {}, [true], true);
    assert.deepEqual(reviewed.tags, candidates);
    assert.deepEqual(reviewed.rejectedTags, []);
    assert.deepEqual(buildTagExtractionOutcome(reviewed, []).after, [{ name: 'duration', value }]);
  }
  for (const value of [{ kind: 'min', days: '30' }, { kind: 'permanent', days: 1 }]) {
    assert.throws(() => parseTagExtractionResponse(JSON.stringify({
      items: [{ id: '1', tags: [{ name: 'duration', value }] }],
    })));
  }
});

test('invalid duration values fail per candidate without discarding valid tags or the old duration', () => {
  for (const value of ['30', '1 month', 0, -1, 36501, { kind: 'range', min: 30, max: 7 }]) {
    const parsed = parseTagExtractionResponse(JSON.stringify({ items: [{ id: '1', tags: [
      { name: 'region', value: 'us' }, { name: 'duration', value },
    ] }] }));
    const candidates = parsed.items[0]!.tags.map((tag, proposalIndex) => ({ ...tag, evidence: [], proposalIndex }));
    const reviewed = validateReviewedTagExtractionDecision(1n, candidates, [], {}, [true, true], true);
    assert.deepEqual(reviewed.tags, [{ name: 'region', value: 'us', evidence: [], proposalIndex: 0 }]);
    assert.equal(reviewed.rejectedTags.length, 1);
    assert.equal(reviewed.rejectedTags[0]!.reasonCode, 'tag_value_invalid');
    assert.equal(reviewed.rejectedTags[0]!.proposalIndex, 1);
    assert.deepEqual(reviewed.rejectedTags[0]!.value, value);
    const result = buildTagExtractionOutcome(reviewed, [{ name: 'duration', value: 360 }]);
    assert.equal(result.outcome, 'partial_success');
    assert.equal(result.successfulCount, 1);
    assert.equal(result.failedCount, 1);
    assert.deepEqual(result.after, [{ name: 'region', value: 'us' }, { name: 'duration', value: 360 }]);
  }
});

test('review matches products by ID and uses strict positional votes for every candidate occurrence', () => {
  const proposals = { items: [
    { id: '1', tags: [{ name: 'region', value: 'us' }, { name: 'region', value: 'jp' }, { name: 'region', value: 'us' }] },
    { id: '2', tags: [{ name: 'duration', value: 30 }] },
  ] };
  const request = buildTagReviewRequest([{ id: '1', name: '美区日区' }, { id: '2', name: '月卡' }], proposals, 'mock');
  assert.deepEqual(JSON.parse(request.messages[1]!.content).proposals, proposals);
  const output = { items: [
    { id: '2', accepted: [false], complete: false },
    { id: '1', accepted: [true, false, false], complete: true },
  ] };
  const parsed = parseTagReviewResponse(JSON.stringify(output));
  assert.deepEqual(parsed, output);
  assert.deepEqual(alignTagReviewDecisions(parsed.items[1]!, proposals.items[0]!), [true, false, false]);
  assert.deepEqual(alignTagReviewDecisions(parsed.items[0]!, proposals.items[1]!), [false]);
  for (const accepted of [[], [true], [true, false], [true, false, false, true]]) {
    assert.throws(() => alignTagReviewDecisions({ id: '1', accepted, complete: true }, proposals.items[0]!));
  }
  assert.throws(() => alignTagReviewDecisions({ id: '2', accepted: [true, false, false], complete: true }, proposals.items[0]!));
  for (const item of [
    { id: '1', accepted: ['true', false, false], complete: true },
    { id: '1', accepted: [true, false, false], complete: 'true' },
    { id: '1', accepted: [true, false, false] },
    { id: '1', decisions: [{ tagId: '1:0', accepted: true }], textReview: null },
  ]) {
    assert.throws(() => parseTagReviewResponse(JSON.stringify({ items: [item] })));
  }
});

test('successful results replace the complete set including empty; terminal failure preserves it', () => {
  const before = [{ name: 'region', value: 'us' }, { name: 'duration', value: 30 }];
  const empty = { productId: 1n, tags: [], rejectedTags: [] };
  assert.deepEqual(buildTagExtractionOutcome(empty, before).after, []);
  assert.equal('retainedUnconfirmed' in buildTagExtractionOutcome(empty, before), false);
  assert.deepEqual(buildTagExtractionOutcome(empty, before).diff.map(t => t.name), ['region', 'duration']);
  assert.deepEqual(buildTagExtractionOutcome(empty, before, { outcome: 'failed', reasonCode: 'invalid_response' }).after, before);
});

test('structured duration equality ignores object key order and preserves typed audits', () => {
  const value = { kind: 'range', min: 30, max: 90 } as const;
  const reordered = { max: 90, min: 30, kind: 'range' } as const;
  const decision = validateTagExtractionDecision(1n, [tag('duration', value, '1-3个月'), tag('duration', reordered, '1-3个月')], { evidence: '1-3个月' });
  assert.equal(decision.tags.length, 1);
  assert.equal(decision.rejectedTags[0]?.reasonCode, 'tag_duplicate');
  const result = buildTagExtractionOutcome(decision, [{ name: 'duration', value: reordered }]);
  assert.deepEqual(result.diff, []);
  assert.deepEqual(result.after, [{ name: 'duration', value }]);
});

for (const [name, value] of [['美区代充', 'us'], ['菲区充值', 'ph']] as const) {
  test(`the current recharge product retains its region: ${name}`, () => {
    const proposed = [tag('region', value, name, 'name')];
    const result = validateTagExtractionDecision(1n, proposed, { name });
    assert.deepEqual(result.tags, proposed);
    assert.deepEqual(result.rejectedTags, []);
  });
}

const positives: Array<[string, StandardizationTag['value'], string]> = [
  ['duration', 30, '使用期限1个月'], ['duration', 90, '使用期限3个月'],
  ['duration', 365, '使用期限1年'], ['duration', 360, '使用期限12个月'],
  ['duration', 0.5, '使用期限12小时'], ['duration', 7, '使用期限1周'],
  ['duration', { kind: 'min', days: 30 }, '至少使用1个月'],
  ['duration', { kind: 'range', min: 30, max: 90 }, '使用期限1-3个月'],
  ['duration', { kind: 'permanent' }, '永久使用'],
  ['sms_verification', 'unverified', '账号未接码'], ['sms_verification', 'verified', '账号已接码'],
  ['region', 'us', '美区IP'], ['region', 'jp', '美区、日区账号'],
  ['region', 'ph', '当前商品付款地区：菲律宾'],
  ['region', 'us', '本商品支付地区为美国'],
  ['supported_client', 'sub2api', '仅支持Sub2API'], ['access_channel', 'web', '支持网页'],
  ['subscription_override', '无', '不可覆盖现有订阅'],
  ['bulk_purchase', 'supported', '支持批量下单'], ['bulk_purchase', 'required', '10件起购'],
  ['bulk_purchase', 'bundle', '10个账号一包'],
  ['warranty', '购买后1小时内仅保首登', '购买后1小时内仅保首登'],
  ['warranty', '保订阅30天，封号不保', '保订阅30天，封号不保'],
];
for (const [name, value, evidence] of positives) test(`supported fact: ${name} ${evidence}`, () => {
  const proposed = [tag(name, value, evidence)];
  const result = validateTagExtractionDecision(1n, proposed, { name: '商品', evidence });
  assert.deepEqual(result.rejectedTags, []);
  assert.deepEqual(result.tags, proposed);
});

const negatives: Array<[string, StandardizationTag['value'], string, string?]> = [
  ['duration', 30, '至少使用1个月'], ['duration', 30, '30天内兑换'], ['duration', 7, 'Token有效期7天', '7天'],
  ['duration', 365, '账号号龄1年', '1年'], ['duration', 30, '质保30天', '30天'],
  ['region', 'us', '账号建议使用美区IP', '美区'], ['region', 'us', '账号必须使用美区IP', '美区'],
  ['region', 'ph', '推荐商品：菲区账号', '菲区'],
  ['region', 'us', '普通账号付款时建议使用美区IP', '美区'],
  ['region', 'us', '普通账号支付时必须使用美区IP', '美区'],
  ['region', 'us', '美区代充或菲区充值，可选规格尚未确定', '美区代充'],
  ['region', 'us', '不提供美区代充', '美区代充'],
  ['sms_verification', 'verified', '需要买家接码'], ['sms_verification', 'unverified', '建议买家接码'],
  ['subscription_override', '有', '可覆盖订阅'], ['bulk_purchase', 'required', '支持批量下单'],
  ['bulk_purchase', 'bundle', '库存1000'], ['bulk_purchase', 'supported', '不支持批量下单'],
  ['access_channel', 'reverse_proxy', '禁止反代', '反代'], ['supported_client', 'sub2api', 'JSON格式'],
  ['warranty', '质保30天', '仅保订阅30天，封号不保'], ['warranty', '保订阅30天', '保订阅30天，封号不保', '保订阅30天'],
  ['warranty', 'covered', '质保30天'], ['warranty', 'none', '无售后'], ['delivery', 'account', '成品账号'],
  ['warranty', '本商品不提供售后。', '本商品不提供售后。'],
  ['warranty', '无售后，售出不退', '无售后，售出不退'],
  ['warranty', '售后联系商家', '售后联系商家'],
  ['warranty', '本商品不提供质保', '本商品不提供质保'],
  ['warranty', '本商品不保订阅30天', '本商品不保订阅30天'],
  ['warranty', '首登不保', '首登不保'],
  ['warranty', '订阅不保', '订阅不保'],
];
for (const [name, value, evidence, quote = evidence] of negatives) test(`unsupported fact: ${name} ${evidence}`, () => {
  const result = validateTagExtractionDecision(1n, [tag(name, value, quote)], { name: '商品', evidence });
  assert.deepEqual(result.tags, []);
  assert.equal(result.rejectedTags.length, 1);
});

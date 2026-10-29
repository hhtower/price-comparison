import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTagExtractionResponse } from '../src/ai/tag-extraction-request.js';
import { validateTagExtractionDecision, buildTagExtractionOutcome } from '../src/ai/tag-extraction-result.js';
import { validateStandardizationTags } from '../src/ai/standardization-evidence.js';
import { buildExtractionPayload } from '../src/ai/adaptive-batching.js';

const tag = (name: string, value: string, quote = value) => ({ name, value, path: 'spec', quote });
const decide = (tags: ReturnType<typeof tag>[], spec = '1个月，不可续费') => {
  const parsed = parseTagExtractionResponse(JSON.stringify({ items: [{ id: '1', tags }] }));
  return validateTagExtractionDecision(1n, parsed.items[0]!.tags.map(({ path, quote, ...fact }) =>
    ({ ...fact, evidence: [{ path, quote }] })), { spec });
};

test('vocabulary failures stay local and retain specific rejection diagnostics', () => {
  const valid = tag('duration', '1 month', '1个月');
  const result = decide([valid, tag('invented', 'yes'), tag('renewable', 'yes'), tag('quantity', '0')]);
  assert.deepEqual(result.tags.map(({ name, value }) => ({ name, value })), [{ name: 'duration', value: '1 month' }]);
  assert.deepEqual(result.rejectedTags.map(t => t.reasonCode), ['tag_name_unknown', 'tag_value_invalid', 'tag_value_invalid']);
  assert.ok(result.rejectedTags.every(t => t.reason && t.evidence.length));
  assert.equal(buildTagExtractionOutcome(result, []).outcome, 'updated');
  const rejected = decide([tag('invented', 'yes')]);
  assert.equal(buildTagExtractionOutcome(rejected, []).outcome, 'review');
});

test('duplicate facts are deduplicated and conflicting single values are all rejected', () => {
  const valid = tag('duration', '1 month', '1个月');
  const result = decide([valid, valid, tag('renewable', '有'), tag('renewable', '无')]);
  assert.deepEqual(result.tags.map(t => t.name), ['duration']);
  assert.deepEqual(result.rejectedTags.map(t => t.reasonCode).sort(), [
    'tag_duplicate', 'tag_single_value_conflict', 'tag_single_value_conflict',
  ]);
  const multi = decide([tag('device_platform', 'android', '安卓IOS通用'), tag('device_platform', 'ios', '安卓IOS通用')], '安卓IOS通用');
  assert.equal(multi.tags.length, 2);
});

test('a duplicate with bad evidence cannot hide a later supported citation', () => {
  const result = decide([tag('duration', '1 month', '不存在的引文'), tag('duration', '1 month', '1个月')]);
  assert.deepEqual(result.tags.map(t => [t.name, t.value]), [['duration', '1 month']]);
  assert.equal(result.rejectedTags[0]!.reasonCode, 'citation_quote_mismatch');
});

test('invalid warranty qualifiers remove the related promise but keep independent facts', () => {
  const result = decide([
    tag('duration', '1 month', '1个月'),
    tag('warranty', 'covered', '首登质保24小时'),
    tag('warranty_scope', 'first_login', '首登质保24小时'),
    tag('warranty_window', '24 hours', '首登质保24小时'),
    tag('warranty_exclusion', 'not_ban', '封号不保'),
  ], '1个月，首登质保24小时，封号不保');
  assert.deepEqual(result.tags.map(t => t.name), ['duration']);
  assert.ok(result.rejectedTags.some(t => t.name === 'warranty_exclusion' && t.reasonCode === 'tag_value_invalid'));
  assert.ok(result.rejectedTags.some(t => t.name === 'warranty' && t.reasonCode === 'warranty_group_invalid'));
});

test('structural corruption, unsafe IDs and oversized arrays remain request failures', () => {
  for (const items of [
    [{ id: '1', tags: [tag('duration', '1 month')], extra: true }],
    [{ id: '1', tags: [{ ...tag('duration', '1 month'), extra: true }] }],
    [{ id: '1', tags: [] }, { id: '1', tags: [] }],
    [{ id: '0', tags: [] }],
    [{ id: '1', tags: Array.from({ length: 101 }, () => tag('invented', 'x')) }],
    [{ id: '1', tags: [{ ...tag('duration', '1 month'), quote: '' }] }],
  ]) assert.throws(() => parseTagExtractionResponse(JSON.stringify({ items })));
  assert.throws(() => parseTagExtractionResponse('{"items":'));
});

const multilineSamples = [
  { source: '禁止反代。\n如果需要其他服务，请另行购买。', facts: [
    ['usage_restriction', '禁止反代', '禁止反代。'],
  ] },
  { source: '交付格式为CDK兑换码。安卓IOS通用。\n如果需要安装帮助，请联系客服。', facts: [
    ['delivery_format', 'cdk', '交付格式为CDK兑换码。'],
    ['device_platform', 'android', '安卓IOS通用'],
    ['device_platform', 'ios', '安卓IOS通用'],
  ] },
  { source: '发货格式:账号----密码----2fa key\n如果需要额外功能，请自行设置。', facts: [
    ['delivery_format', 'credentials', '发货格式:账号----密码----2fa key'],
  ] },
];
for (const [index, { source, facts }] of multilineSamples.entries()) {
  const sample = {
    input: { sourceData: { evidence: source } },
    tags: facts.map(([name, value, quote]) => ({ name: name!, value: value!, evidence: [{ path: 'sourceData.evidence', quote: quote! }] })),
  };
  test(`synthetic facts survive unrelated multiline conditions: ${index + 1}`, () => {
    const result = validateStandardizationTags(sample.tags, sample.input);
    assert.deepEqual(result.tags, sample.tags);
    assert.deepEqual(result.rejectedTags, []);
  });
}

for (const source of [
  '不提供以下交付方式：\n账号密码',
  '如果购买附加服务：\n账号密码',
  '以下方式不支持：\nJSON\n账号密码',
  '如果购买附加服务\n账号密码',
  '不提供\n账号密码',
  '不提供：\n\n账号密码',
  '不提供以下交付方式：\n交付格式:账号密码',
  '如果购买附加服务：\n交付格式:账号密码',
  '不提供\n交付格式:账号密码',
  '本商品不提供\n账号密码',
  '需要自行准备\n账号密码',
  '本商品不带\n账号密码',
  '买家自备\n账号密码',
  '本商品不提供以下交付方式\n账号密码',
  '请自行提供以下信息\n账号密码',
]) {
  test(`line boundaries do not drop a governing restriction: ${source}`, () => {
    const result = validateStandardizationTags([
      { name: 'delivery_format', value: 'credentials', evidence: [{ path: 'sourceData.evidence', quote: '账号密码' }] },
    ], { sourceData: { evidence: source } });
    assert.deepEqual(result.tags, []);
  });
}

test('multiline citations allow whitespace differences without accepting invented quotes', () => {
  const payload = { sourceData: { evidence: '交付方式：\n账号密码\n仅支持Sub2API。禁止反代。' } };
  const facts = [
    { name: 'delivery_format', value: 'credentials', evidence: [{ path: 'sourceData.evidence', quote: '交付方式： 账号密码' }] },
    { name: 'access_channel', value: 'reverse_proxy', evidence: [{ path: 'sourceData.evidence', quote: '反代' }] },
    { name: 'delivery_mode', value: 'automatic', evidence: [{ path: 'sourceData.evidence', quote: '自动发货' }] },
  ];
  const result = validateStandardizationTags(facts, payload);
  assert.deepEqual(result.tags, [facts[0]]);
  assert.equal(result.rejectedTags.length, 2);
});

for (const [name, quote] of [
  ['kyc', '账号已完成实名认证'],
  ['sms_verification', '账号已完成短信验证'],
]) {
  test(`a cross-line condition does not prove completed ${name}`, () => {
    for (const condition of ['如果商家确认', '以商家确认为前提', '买家必须']) {
      const result = validateStandardizationTags([
        { name: name!, value: 'verified', evidence: [{ path: 'sourceData.evidence', quote: quote! }] },
      ], { sourceData: { evidence: `${condition}\n${quote}` } });
      assert.deepEqual(result.tags, [], condition);
    }
  });
}

for (const [source, value] of [['接入方式：\nAPI', 'api'], ['访问方式：\n反代', 'reverse_proxy']]) {
  test(`access citation may span an affirmative heading and value: ${value}`, () => {
    const facts = [{ name: 'access_channel', value: value!, evidence: [{ path: 'sourceData.evidence', quote: source!.replace('\n', ' ') }] }];
    assert.deepEqual(validateStandardizationTags(facts, { sourceData: { evidence: source! } }).tags, facts);
    assert.deepEqual(validateStandardizationTags(facts, { sourceData: { evidence: `不支持：\n${source}` } }).tags, []);
  });
}

test('long multiline evidence with exact duplicate tags stays within a bounded local validation time', () => {
  const input = buildExtractionPayload({ name: '账号', spec: '', sourceData: {
    evidence: Array.from({ length: 1000 }, (_, i) => `<div>note ${i}</div>`).join('') + '<div>账号密码</div>',
  } });
  const fact = { name: 'delivery_format', value: 'credentials', evidence: [{ path: 'sourceData.evidence', quote: '账号密码' }] };
  const started = performance.now();
  const result = validateTagExtractionDecision(1n, Array.from({ length: 100 }, () => fact), input);
  assert.equal(result.tags.length, 1);
  assert.equal(result.rejectedTags.length, 99);
  assert.ok(performance.now() - started < 2000, '100 identical citations should not repeatedly scan the full document');
});

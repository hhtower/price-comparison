import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTagExtractionResponse } from '../src/ai/tag-extraction-request.js';
import { validateTagExtractionDecision } from '../src/ai/tag-extraction-result.js';
import { validateStandardizationTags } from '../src/ai/standardization-evidence.js';
import type { StandardizationTag } from '../src/ai/ai.schemas.js';
import { buildExtractionPayload } from '../src/ai/adaptive-batching.js';

const tag = (name: string, value: StandardizationTag['value'], quote: string, path = 'spec') => ({ name, value, evidence: [{ path, quote }] });

test('retired names and invalid values retain rejection diagnostics at the validation boundary', () => {
  const result = validateTagExtractionDecision(1n, [tag('duration', 30, '1个月'), tag('invented', 'yes', '1个月'),
    tag('subscription_override', '有', '可覆盖'), tag('duration', 0, '1个月')], { spec: '1个月，可覆盖' });
  assert.deepEqual(result.tags.map(t => [t.name, t.value]), [['duration', 30]]);
  assert.deepEqual(result.rejectedTags.map(t => t.reasonCode), ['tag_name_unknown', 'tag_value_invalid', 'tag_value_invalid']);
});

test('duplicates are deduplicated; conflicting single values are rejected; multiple regions survive', () => {
  const duration = tag('duration', 30, '1个月');
  const result = validateTagExtractionDecision(1n, [duration, duration, tag('sms_verification', 'verified', '已接码'),
    tag('sms_verification', 'unverified', '未接码')], { spec: '1个月，已接码，未接码' });
  assert.deepEqual(result.tags, [duration]);
  assert.deepEqual(result.rejectedTags.map(t => t.reasonCode).sort(), ['tag_duplicate', 'tag_single_value_conflict', 'tag_single_value_conflict']);
  const regions = [tag('region', 'us', '美区'), tag('region', 'jp', '日区')];
  assert.deepEqual(validateTagExtractionDecision(1n, regions, { spec: '美区、日区账号' }).tags, regions);
});

test('an invalid duplicate citation cannot hide a later supported occurrence', () => {
  const result = validateTagExtractionDecision(1n, [tag('duration', 30, '不存在'), tag('duration', 30, '1个月')], { spec: '1个月' });
  assert.equal(result.tags.length, 1);
  assert.equal(result.rejectedTags[0]!.reasonCode, 'citation_quote_mismatch');
});

test('incomplete warranty is rejected without removing independently supported duration', () => {
  const result = validateTagExtractionDecision(1n, [tag('duration', 30, '1个月'), tag('warranty', '首登质保24小时', '首登质保24小时')],
    { spec: '1个月，首登质保24小时，封号不保' });
  assert.deepEqual(result.tags.map(t => t.name), ['duration']);
  assert.equal(result.rejectedTags.length, 1);
});

test('structural corruption, retired output keys and oversized arrays reject the response', () => {
  const fact = { name: 'duration', value: 30, path: 'spec', quote: '1个月' };
  for (const items of [
    [{ id: '1', tags: [fact], extra: true }], [{ id: '1', tags: [{ ...fact, extra: true }] }],
    [{ id: '1', tags: [] }, { id: '1', tags: [] }], [{ id: '0', tags: [] }],
    [{ id: '1', tags: Array(101).fill(fact) }], [{ id: '1', tags: [{ ...fact, quote: '' }] }],
    [{ id: '1', tags: [{ ...fact, name: 'delivery' }] }],
  ]) assert.throws(() => parseTagExtractionResponse(JSON.stringify({ items })));
  assert.throws(() => parseTagExtractionResponse('{"items":'));
});

for (const prefix of ['不支持：', '如果购买附加服务：', '不提供以下入口：', '不支持', '买家必须']) {
  test(`line boundaries retain their governing restriction: ${prefix}`, () => {
    const name = prefix === '买家必须' ? 'sms_verification' : 'access_channel';
    const value = prefix === '买家必须' ? 'verified' : 'api';
    const quote = prefix === '买家必须' ? '账号已完成短信验证' : 'API';
    assert.deepEqual(validateStandardizationTags([tag(name, value, quote, 'evidence')], { evidence: `${prefix}\n${quote}` }).tags, []);
  });
}

test('verbatim multiline citations survive without accepting whitespace rewrites or invented quotes', () => {
  const evidence = '支持\nSub2API。支持API。';
  const good = tag('supported_client', 'sub2api', '支持\nSub2API', 'evidence');
  const result = validateStandardizationTags([good, tag('supported_client', 'sub2api', '支持 Sub2API', 'evidence'),
    tag('access_channel', 'web', '网页', 'evidence')], { evidence });
  assert.deepEqual(result.tags, [good]);
  assert.equal(result.rejectedTags.length, 2);
});

test('100 duplicate citations over long evidence are bounded and deduplicated', () => {
  const input = buildExtractionPayload({ name: '账号', sourceData: { evidence: '<div>note</div>'.repeat(1000) + '<div>支持Codex</div>' } });
  const fact = tag('supported_client', 'codex', '支持Codex', 'sourceData.evidence');
  const started = performance.now();
  const result = validateTagExtractionDecision(1n, Array(100).fill(fact), input);
  assert.equal(result.tags.length, 1);
  assert.equal(result.rejectedTags.length, 99);
  assert.ok(performance.now() - started < 2000);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyShoppingNeeds, validateAssistantReply } from '@price-comparison/catalog/assistant-contract';
import { consultationKnowledge, renderConsultation } from '../src/assistant/assistant-consultation.js';

const facts = [
  { id: 'd1', title: '目录统计', text: '公开目录共有987条报价（全部类别，CNY）。', path: '/' },
  { id: 'd2', title: '分类说明', text: '短期包括保障或交付信息不明确的商品。', path: '/guide' },
];

test('consultation knowledge explains both top-up features and the limits of general eligibility', () => {
  const knowledge = consultationKnowledge(new Date());
  const topUp = knowledge.find(fact => fact.title === '代充');
  assert.ok(topUp);
  assert.match(topUp.text, /明确要求半价资格.*需半价资格.*其余.*通用/u);
  assert.match(topUp.text, /通用不保证.*其他购买限制/u);
});

test('fact placeholders preserve numbers while complete scope stays in expandable details', () => {
  const result = renderConsultation({ text: '先了解分类：{{d2}}', evidenceIds: ['d2'] }, facts, ['d1']);
  assert.equal(result.text, `先了解分类：${facts[1]!.text}`);
  assert.deepEqual(result.messages, [result.text]);
  assert.ok(result.details?.some(detail => detail.text === facts[0]!.text));
  assert.deepEqual(result.sources?.map(source => source.path), ['/guide', '/']);
  const inline = renderConsultation({ text: '{{d1}}', evidenceIds: ['d1'] }, facts, ['d1']);
  assert.equal(inline.text, facts[0]!.text);
});

test('a response contains one to three short messages, not three mandatory messages', () => {
  for (const messages of [['可以先了解分类。'], ['可以先了解分类。', '{{d2}}'], ['先看区别。', '{{d2}}', '需要时再继续选购。']]) {
    const result = renderConsultation({ text: messages.join('\n\n'), evidenceIds: ['d2'] }, facts);
    assert.equal(result.messages?.length, messages.length);
    assert.ok(result.messages!.every(message => message.length <= 200));
    assert.equal(result.text, result.messages?.join('\n\n'));
  }
  for (const text of ['甲\n\n乙\n\n丙\n\n丁', '字'.repeat(201)]) {
    assert.throws(() => renderConsultation({ text, evidenceIds: [] }, facts), /MODEL_INVALID_RESPONSE/u);
  }
});

test('brief server summaries replace references and failed queries cannot be hidden in details', () => {
  const result = renderConsultation({ text: '{{d1}}', evidenceIds: ['d1'] },
    [{ ...facts[0]!, summary: '当前公开报价共987条（CNY）。', text: '完整口径。'.repeat(60) },
      { id: 'd2', title: '不可用', text: '历史查询失败。', summary: '价格历史暂时不可用，请稍后重试。', critical: true }],
    ['d1', 'd2']);
  assert.deepEqual(result.messages, ['当前公开报价共987条（CNY）。', '价格历史暂时不可用，请稍后重试。']);
  assert.ok(result.details?.some(detail => detail.text.length > 200));
});

test('a critical notice stays visible at the three-message boundary without losing the last explanation', () => {
  const messages = ['甲'.repeat(190), '乙'.repeat(190), '丙'.repeat(190)];
  const failure = { id: 'd3', title: '查询失败', text: '查询服务暂不可用，请稍后重试。', critical: true };
  const result = renderConsultation({ text: messages.join('\n\n'), evidenceIds: [] }, [...facts, failure], ['d3']);
  assert.equal(result.messages?.length, 3);
  assert.equal(result.messages?.[2], failure.text);
  assert.ok(result.details?.some(detail => detail.title === '补充说明' && detail.text === messages[2]));
});

test('combined bounded queries retain all evidence without increasing visible message count', () => {
  const combined = Array.from({ length: 56 }, (_, index) => ({
    id: `d${index}`, title: '分组依据', text: `分组 ${index} 的完整查询结果。`,
  }));
  const result = renderConsultation({ text: '查询结果可展开核对。', evidenceIds: combined.slice(0, 12).map(fact => fact.id) },
    combined, combined.slice(12).map(fact => fact.id));
  assert.equal(result.messages?.length, 1);
  const reply = validateAssistantReply({ kind: 'explanation', ...result, options: [], cards: [], needs: emptyShoppingNeeds() });
  assert.equal(reply.details?.length, 56);
});

test('answers reject invented references, numbers, links, control characters and malformed payloads', () => {
  for (const answer of [
    null, [], { text: '你好', evidenceIds: [], extra: 'x' },
    { text: '{{d3}}', evidenceIds: ['d3'] },
    { text: '{{d1}}', evidenceIds: [] },
    { text: '共有９９９条', evidenceIds: ['d1'] },
    { text: '共有九千九百九十九条报价，均价八十元。', evidenceIds: [] },
    { text: '均价捌拾元，每月八十元。', evidenceIds: ['d1'] },
    { text: 'There are nine hundred offers, averaging eighty dollars.', evidenceIds: [] },
    { text: '所有成品号都保证永久独享，永不封号。', evidenceIds: ['d2'] },
    { text: '[详情](//evil.invalid)', evidenceIds: [] },
    { text: '<img src=x>', evidenceIds: [] },
    { text: '你好\u0000', evidenceIds: [] },
    { text: '你好', evidenceIds: ['d1', 'd1'] },
    { text: 'x'.repeat(4001), evidenceIds: [] },
  ]) assert.throws(() => renderConsultation(answer, facts), /MODEL_INVALID_RESPONSE/u);
});

test('quantity checks allow ordinary non-quantitative Chinese phrases', () => {
  for (const text of ['零基础也可以先了解分类。', '资料可能陆续更新。', '千万不要只看标价。', '两者的区别可以对照指南查看。',
    '万一遇到登录问题，请核对售后条款。', '中国大陆是否可用，需向商家确认。']) {
    assert.equal(renderConsultation({ text, evidenceIds: ['d2'] }, facts).text, text);
  }
});

test('warnings against guarantees are accepted while affirmative promises remain invalid', () => {
  for (const text of ['不能保证永不封号，请核对商家条款。', '不能说绝对安全，也不是全网最低价。', '不要相信永久独享的承诺。']) {
    assert.equal(renderConsultation({ text, evidenceIds: ['d2'] }, facts).text, text);
  }
  assert.throws(() => renderConsultation({ text: '不能保证价格最低，但保证永不封号。', evidenceIds: ['d2'] }, facts));
});

test('knowledge omits expired official capability claims and includes the site classification', () => {
  const knowledge = consultationKnowledge(new Date('2026-11-23T12:00:00Z'));
  assert.ok(knowledge.some(fact => fact.title === '短期' && fact.text.includes('25')));
  assert.ok(knowledge.some(fact => fact.title === '使用保障'));
  assert.ok(!knowledge.some(fact => fact.title === '已核验套餐能力'));
  const comparison = knowledge.find(fact => fact.title === '选购比较')!;
  assert.match(comparison.text, /虚构示例.*不是实时报价/u);
  assert.match(comparison.text, /示例报价 A/u);
});

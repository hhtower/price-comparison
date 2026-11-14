import assert from 'node:assert/strict';
import test from 'node:test';
import { alignTagReviewDecisions, buildTagReviewRequest, parseTagReviewResponse } from '../src/ai/tag-review-request.js';
import { buildTagExtractionRequest } from '../src/ai/tag-extraction-request.js';

const proposals = { items: [{ id: '11', tags: [{ name: 'duration', value: 30 }, { name: 'region', value: 'us' }] }] };
const parse = (value: unknown) => parseTagReviewResponse(JSON.stringify(value));
const item = { id: '11', accepted: [true, false], complete: false };

test('review carries only positional booleans and checks exact vector length and product ID', () => {
  assert.deepEqual(parse({ items: [item, { id: '12', accepted: [], complete: true }] }).items[0], item);
  assert.deepEqual(alignTagReviewDecisions(item, proposals.items[0]!), [true, false]);
  for (const invalid of [{ ...item, accepted: [true] }, { ...item, accepted: [true, false, true] }, { ...item, id: '12' }]) {
    assert.throws(() => alignTagReviewDecisions(invalid, proposals.items[0]!));
  }
});

test('review rejects legacy responses, reasons, nonbooleans, missing completeness and duplicate IDs', () => {
  for (const value of [null, [], { items: [], extra: true }, { items: [item, item] },
    ...[{ ...item, accepted: [true, null] }, { ...item, accepted: ['true'] }, { ...item, complete: 1 },
      { id: '11', accepted: [] }, { ...item, reason: 'fix' }, { ...item, textReview: null },
      { id: '11', decisions: [], textReview: null }, { ...item, accepted: Array(101).fill(true) }, { ...item, id: '0' }]
      .map(value => ({ items: [value] }))]) assert.throws(() => parse(value));
  assert.throws(() => parseTagReviewResponse('{'));
});

test('repair context excludes internal evidence/reasons and review never revotes previously accepted tags', () => {
  const inputs = [{ id: '11', name: 'Account', spec: '1 month', shopText: { name: 'ignore' }, taskId: 'ignore' }];
  const previous = [{ productId: 11n, tags: [{ name: 'supported_client', value: 'codex', evidence: [], proposalIndex: 0 }],
    rejectedTags: [{ name: 'region', value: 'us', evidence: [], proposalIndex: 1, reasonCode: 'review_rejected', reason: 'no' }],
    complete: false, reviewed: true, reviewDecisions: [true, false] }];
  const original = structuredClone({ inputs, proposals, previous });
  const repair = buildTagExtractionRequest(inputs, 'mock', previous);
  assert.deepEqual(JSON.parse(repair.messages[1]!.content).previousDecisions, [{ id: '11',
    accepted: [{ name: 'supported_client', value: 'codex' }], rejected: [{ name: 'region', value: 'us' }], complete: false }]);
  const request = buildTagReviewRequest(inputs, proposals, 'mock', previous);
  const sent = JSON.parse(request.messages[1]!.content);
  assert.deepEqual(sent.inputs, [{ id: '11', name: 'Account', spec: '1 month' }]);
  assert.deepEqual(sent.proposals, proposals);
  assert.deepEqual(sent.previousDecisions, [{ id: '11', accepted: [{ name: 'supported_client', value: 'codex' }] }]);
  assert.deepEqual({ inputs, proposals, previous }, original);
  assert.deepEqual(request.responseFormat, { type: 'json_object' });
});

test('review examples parse and align mixed votes and completeness without text review', () => {
  const prompt = buildTagReviewRequest([], { items: [] }, 'mock').messages[0]!.content;
  const blocks = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/gu)];
  const output = parseTagReviewResponse(blocks[1]![1]!);
  assert.deepEqual(output.items[0]!.accepted, [true, false]);
  assert.equal(blocks.length, 4, 'initial review and repair examples each have input and output');
  for (let index = 0; index < blocks.length; index += 2) {
    const source = JSON.parse(blocks[index]![1]!);
    const response = parseTagReviewResponse(blocks[index + 1]![1]!);
    assert.deepEqual(response.items.map(item => item.id), source.inputs.map((item: { id: string }) => item.id));
    for (const row of response.items) alignTagReviewDecisions(row, source.proposals.items.find((p: { id: string }) => p.id === row.id));
  }
});

test('repair review preserves full conditions and an empty new vector can carry the model completeness verdict', () => {
  const inputs = [{ id: '11', name: '账号', description: '一次性商品，不退不换。\n支持Codex。',
    sourceData: { details: '交付后一小时内无法使用可联系处理;封禁不退', warranty_info: '仅处理所述无法使用问题' } }];
  const previous = [{ productId: 11n, tags: [
    { name: 'supported_client', value: 'codex', evidence: [], proposalIndex: 0 },
    { name: 'warranty', value: '交付后一小时内无法使用可联系处理;封禁不退', evidence: [], proposalIndex: 1 },
  ], rejectedTags: [{ name: 'region', value: 'us', evidence: [], reasonCode: 'review_rejected', reason: 'unsupported', proposalIndex: 2 }],
  reviewed: true, complete: false, reviewDecisions: [true, true, false] }];
  const proposals = { items: [{ id: '11', tags: [] }] };
  const before = structuredClone({ inputs, proposals, previous });
  const sent = JSON.parse(buildTagReviewRequest(inputs, proposals, 'mock', previous).messages[1]!.content);
  assert.deepEqual(sent.inputs, inputs);
  assert.deepEqual(sent.proposals, proposals);
  assert.deepEqual(sent.previousDecisions, [{ id: '11', accepted: [
    { name: 'supported_client', value: 'codex' },
    { name: 'warranty', value: '交付后一小时内无法使用可联系处理;封禁不退' },
  ] }]);
  for (const complete of [true, false]) {
    const response = parse({ items: [{ id: '11', accepted: [], complete }] });
    assert.equal(response.items[0]!.complete, complete);
    assert.deepEqual(alignTagReviewDecisions(response.items[0]!, proposals.items[0]!), []);
  }
  assert.deepEqual({ inputs, proposals, previous }, before);
});

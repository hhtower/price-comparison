import assert from 'node:assert/strict';
import test from 'node:test';
import { alignTagReviewDecisions, buildTagReviewRequest, parseTagReviewResponse } from '../src/ai/tag-review-request.js';
import { buildTagExtractionRequest, TAG_SCHEMA } from '../src/ai/tag-extraction-request.js';

const proposals = { items: [{ id: '11', tags: [{ name: 'duration', value: 30 }, { name: 'region', value: 'us' }] }] };
const parse = (value: unknown) => parseTagReviewResponse(JSON.stringify(value));
const item = { id: '11', feedback: '商品地区未明确', accepted: [true, false], complete: false };

test('review carries only positional booleans and checks exact vector length and product ID', () => {
  assert.deepEqual(parse({ items: [item, { id: '12', feedback: '', accepted: [], complete: true }] }).items[0], item);
  assert.deepEqual(alignTagReviewDecisions(item, proposals.items[0]!), [true, false]);
  for (const invalid of [{ ...item, accepted: [true] }, { ...item, accepted: [true, false, true] }, { ...item, id: '12' }]) {
    assert.throws(() => alignTagReviewDecisions(invalid, proposals.items[0]!));
  }
});

test('review rejects missing fields, invalid feedback, nonbooleans and duplicate IDs', () => {
  for (const value of [null, [], { items: [], extra: true }, { items: [item, item] },
    ...[{ ...item, accepted: [true, null] }, { ...item, accepted: ['true'] }, { ...item, complete: 1 },
      { id: '11', accepted: [] }, { ...item, feedback: null }, { ...item, feedback: 'x'.repeat(1001) },
      { id: '11', accepted: [], complete: true }, { ...item, reason: 'fix' }, { ...item, textReview: null },
      { id: '11', decisions: [], textReview: null }, { ...item, accepted: Array(101).fill(true) }, { ...item, id: '0' }]
      .map(value => ({ items: [value] }))]) assert.throws(() => parse(value));
  assert.throws(() => parseTagReviewResponse('{'));
});

test('repair feedback belongs to generation while review judges only current candidates and original input', () => {
  const inputs = [{ id: '11', name: 'Account', spec: '1 month', shopText: { name: 'ignore' }, taskId: 'ignore' }];
  const previous = [{ productId: 11n, tags: [{ name: 'supported_client', value: 'codex', evidence: [], proposalIndex: 0 }],
    rejectedTags: [{ name: 'region', value: 'us', evidence: [], proposalIndex: 1, reasonCode: 'review_rejected', reason: 'no' }],
    complete: false, reviewed: true, reviewDecisions: [true, false], reviewFeedback: '商品地区未明确' }];
  const original = structuredClone({ inputs, proposals, previous });
  const repair = buildTagExtractionRequest(inputs, 'mock', previous);
  assert.deepEqual(JSON.parse(repair.messages[1]!.content).previousDecisions, [{ id: '11',
    draft: [{ name: 'supported_client', value: 'codex' }, { name: 'region', value: 'us' }],
    feedback: '商品地区未明确' }]);
  const request = buildTagReviewRequest(inputs, proposals, 'mock');
  const sent = JSON.parse(request.messages[1]!.content);
  assert.deepEqual(sent.inputs, [{ id: '11', name: 'Account', spec: '1 month' }]);
  assert.deepEqual(sent.proposals, { items: [{ ...proposals.items[0], candidateCount: 2 }] });
  assert.equal(Object.hasOwn(sent, 'previousDecisions'), false);
  assert.deepEqual({ inputs, proposals, previous }, original);
  assert.deepEqual(request.responseFormat, { type: 'json_object' });
  assert.equal(request.model, 'mock');
});

test('review examples parse and align mixed votes and completeness without text review', () => {
  const prompt = buildTagReviewRequest([], { items: [] }, 'mock').messages[0]!.content;
  const blocks = [...prompt.matchAll(/<(input|output)>\n([\s\S]*?)\n<\/\1>/gu)];
  const output = parseTagReviewResponse(blocks[1]![2]!);
  assert.deepEqual(output.items[0]!.accepted, [true, false]);
  assert.equal(blocks.length, 2, 'one focused example covers mixed votes and missing general facts');
  assert.equal(output.items[0]!.complete, true);
  assert.equal(output.items[1]!.complete, false);
  assert.doesNotMatch(prompt, /subscription_warranty|usage_warranty|warranty_terms|warrantyEvidence/u);
  const vocabulary = JSON.parse(prompt.match(/<tag_vocabulary>\n([\s\S]*?)\n<\/tag_vocabulary>/u)![1]!);
  assert.deepEqual(vocabulary, TAG_SCHEMA);
  const instructions = prompt.replace(/<review_example>[\s\S]*?<\/review_example>/gu, '').replace(/<tag_vocabulary>[\s\S]*?<\/tag_vocabulary>/u, '');
  assert.doesNotMatch(instructions.replaceAll('无', ''), /[\u3400-\u9fff]/u, 'review instructions are English apart from canonical values');
  for (let index = 0; index < blocks.length; index += 2) {
    const source = JSON.parse(blocks[index]![2]!);
    const response = parseTagReviewResponse(blocks[index + 1]![2]!);
    assert.deepEqual(response.items.map(item => item.id), source.inputs.map((item: { id: string }) => item.id));
    for (const row of response.items) {
      const proposal = source.proposals.items.find((p: { id: string }) => p.id === row.id);
      assert.equal(proposal.candidateCount, proposal.tags.length);
      alignTagReviewDecisions(row, proposal);
    }
  }
});

test('review preserves full conditions without retaining previous accepted facts in its context', () => {
  const inputs = [{ id: '11', name: '账号', description: '一次性商品，不退不换。\n支持Codex。',
    sourceData: { details: '交付后一小时内无法使用可联系处理;封禁不退', warranty_info: '仅处理所述无法使用问题' } }];
  const previous = [{ productId: 11n, tags: [
    { name: 'supported_client', value: 'codex', evidence: [], proposalIndex: 0 },
    { name: 'duration', value: 30, evidence: [], proposalIndex: 1 },
  ], rejectedTags: [{ name: 'region', value: 'us', evidence: [], reasonCode: 'review_rejected', reason: 'unsupported', proposalIndex: 2 }],
  reviewed: true, complete: false, reviewDecisions: [true, true, false] }];
  const proposals = { items: [{ id: '11', tags: [] }] };
  const before = structuredClone({ inputs, proposals, previous });
  const sent = JSON.parse(buildTagReviewRequest(inputs, proposals, 'mock').messages[1]!.content);
  assert.deepEqual(sent.inputs, inputs);
  assert.deepEqual(sent.proposals, { items: [{ id: '11', candidateCount: 0, tags: [] }] });
  assert.equal(Object.hasOwn(sent, 'previousDecisions'), false);
  for (const complete of [true, false]) {
    const response = parse({ items: [{ id: '11', feedback: '', accepted: [], complete }] });
    assert.equal(response.items[0]!.complete, complete);
    assert.deepEqual(alignTagReviewDecisions(response.items[0]!, proposals.items[0]!), []);
  }
  assert.deepEqual({ inputs, proposals, previous }, before);
});

test('candidate count includes structured values and every duplicate occurrence without changing proposals', () => {
  const proposals = { items: [{ id: '11', tags: [
    { name: 'duration', value: { kind: 'range', min: 7, max: 30 } },
    { name: 'region', value: 'us' },
    { name: 'region', value: 'us' },
    { name: 'supported_client', value: 'codex' },
  ] }] };
  const before = structuredClone(proposals);
  const sent = JSON.parse(buildTagReviewRequest([{ id: '11', name: '账号' }], proposals, 'mock').messages[1]!.content);
  assert.deepEqual(sent.proposals, { items: [{ ...before.items[0], candidateCount: 4 }] });
  assert.deepEqual(proposals, before);
});

test('repair draft preserves the original candidate order addressed by review feedback', () => {
  const previous = [{
    productId: 11n,
    tags: [
      { name: 'duration', value: 30, evidence: [], proposalIndex: 0 },
      { name: 'region', value: 'us', evidence: [], proposalIndex: 2 },
    ],
    rejectedTags: [{ name: 'duration', value: '1 month', evidence: [], proposalIndex: 1,
      reasonCode: 'review_rejected', reason: '' }],
    reviewed: true, complete: false, reviewDecisions: [true, false, true], reviewFeedback: '第二项期限需要归一。',
  }];
  const before = structuredClone(previous);
  const sent = JSON.parse(buildTagExtractionRequest([{ id: '11', name: '账号' }], 'mock', previous).messages[1]!.content);
  assert.deepEqual(sent.previousDecisions, [{ id: '11', feedback: '第二项期限需要归一。', draft: [
    { name: 'duration', value: 30 }, { name: 'duration', value: '1 month' }, { name: 'region', value: 'us' },
  ] }]);
  assert.deepEqual(previous, before);
});

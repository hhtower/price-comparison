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
  const input = JSON.parse(blocks[0]![1]!);
  const output = parseTagReviewResponse(blocks[1]![1]!);
  assert.deepEqual(output.items[0]!.accepted, [true, false]);
  for (const row of output.items) alignTagReviewDecisions(row, input.proposals.items.find((p: { id: string }) => p.id === row.id));
});

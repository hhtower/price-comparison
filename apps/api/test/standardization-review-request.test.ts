import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStandardizationProtocolResponse, type ParsedStandardizationResponse } from '../src/ai/ai.schemas.js';
import { buildStandardizationReviewRequest, parseStandardizationReviewResponse, planStandardizationReviewRequests,
  isReviewableStandardizationDecision } from '../src/ai/standardization-review-request.js';
import { estimateStandardizationRequest } from '../src/ai/standardization-request.js';

const request = { model: 'mock', candidates: [
  { id: '91', family: 'openai', product: 'chatgpt', tier: 'plus', aliases: [] },
  { id: '92', family: 'anthropic', product: 'claude', tier: 'team', aliases: [] },
], inputs: [
  { productId: 11n, payload: { name: 'ChatGPT Plus', description: 'Full current evidence '.repeat(200) },
    candidateStandardProductIds: ['91'], previousDecision: { reason: 'PRIVATE OLD HISTORY' } },
  { productId: 12n, payload: { name: 'Unknown offer', description: 'Current source '.repeat(200) },
    candidateStandardProductIds: ['92'], previousDecision: { reason: 'PRIVATE OLD HISTORY' } },
] };
const wire = { items: [
  { id: '11', standardProductId: '91', evidence: [{ path: 'name', quote: 'ChatGPT Plus' }] },
  { id: '12', standardProductId: null, evidence: [{ path: 'name', quote: 'Unknown offer' }] },
] };
const proposals = (): ParsedStandardizationResponse => parseStandardizationProtocolResponse(wire,
  request.inputs.map(input => ({ id: String(input.productId), candidateStandardProductIds: input.candidateStandardProductIds })));
const parse = (value: unknown, source = proposals()) => parseStandardizationReviewResponse(JSON.stringify(value), source);
const votes = (approved = true) => ({ items: wire.items.map(item => ({ id: item.id, approved })) });
const limits = { maxRequestBytes: 1_000_000, maxContextTokens: 1_000_000, outputReserveTokens: 1024 };

test('review sends only exact proposed mappings, approved candidates and complete current source', () => {
  const source = proposals();
  const before = structuredClone({ request, source });
  const built = buildStandardizationReviewRequest(request, source);
  const body = JSON.parse(built.messages[1]!.content);
  assert.deepEqual(body, {
    inputs: request.inputs.map(input => ({ id: String(input.productId), payload: input.payload,
      candidateStandardProductIds: input.candidateStandardProductIds })),
    candidates: request.candidates, proposals: wire,
  });
  assert.doesNotMatch(JSON.stringify(built.messages), /previousDecision|historyContext|PRIVATE OLD HISTORY|create_identity|not_sellable|insufficient_evidence/u);
  assert.match(built.messages[0]!.content, /approved definitions/iu);
  assert.match(built.messages[0]!.content, /untrusted/iu);
  assert.match(built.messages[0]!.content, /attributes/iu);
  assert.deepEqual({ request, source }, before);
});

test('binary approval preserves exact decisions in proposal order', () => {
  const source = proposals();
  const result = parse({ items: votes().items.reverse() }, source);
  assert.deepEqual(result, { items: source.items.map(item => ({ ...item, review: { approved: true } })), missingIds: [] });
  assert.equal(result.items[0]!.identity, source.items[0]!.identity);
  assert.equal(result.items[0]!.evidence, source.items[0]!.evidence);
  assert.ok(source.items.every(item => item.review === undefined));
});

test('binary rejection removes the mapping but preserves current evidence for pending handling', () => {
  const source = proposals();
  const result = parse(votes(false), source);
  assert.deepEqual(result.items, source.items.map(item => ({
    id: item.id, status: 'unclassified', reasonCode: 'review_rejected',
    reason: 'LLM 对该标准化提议判定为否', ruleIds: [], evidence: item.evidence, review: { approved: false },
  })));
  assert.equal(result.items[0]!.evidence, source.items[0]!.evidence);
  assert.equal(result.items[1]!.evidence, source.items[1]!.evidence);
  assert.deepEqual(result.missingIds, []);
});

test('binary parser rejects malformed, omitted, duplicate, corrected and coerced votes', () => {
  for (const value of [
    null, [], {}, { items: null }, { ...votes(), reason: 'extra' }, { ...votes(), identities: [] },
    { items: [] }, { items: votes().items.slice(1) }, { items: [...votes().items, votes().items[0]] },
    { items: [votes().items[0], votes().items[0]] },
    ...[null, {}, { id: '11' }, { id: '11', approved: true, standardProductId: '92' },
      ...[1, null, 'true', 'false', []].map(approved => ({ id: '11', approved })),
      ...[' 11', '011', 11, '999'].map(id => ({ id, approved: true }))].map(first => ({
      items: [first, votes().items[1]],
    })),
  ]) assert.throws(() => parse(value));
  for (const content of ['', '{"items":', '```json\n{"items":[]}\n```', '{"items":[]} extra']) {
    assert.throws(() => parseStandardizationReviewResponse(content, proposals()));
  }
});

test('review rejects missing proposal IDs and wrong or absent item-local frozen candidates', () => {
  const source = proposals();
  for (const invalid of [
    { ...source, items: source.items.slice(1) },
    { ...source, items: [source.items[0]!, source.items[0]!] },
    { ...source, missingIds: ['12'] },
  ]) {
    assert.throws(() => buildStandardizationReviewRequest(request, invalid));
    assert.throws(() => planStandardizationReviewRequests(request, invalid, limits));
  }
  const wrong = proposals();
  wrong.items[0]!.identity = { kind: 'existing', standardProductId: '92' };
  assert.throws(() => buildStandardizationReviewRequest(request, wrong));
  assert.throws(() => buildStandardizationReviewRequest({ ...request, candidates: [] }, source));
  assert.throws(() => buildStandardizationReviewRequest({ ...request, candidates: [...request.candidates, request.candidates[0]!] }, source));
  assert.throws(() => parse(votes(), { ...source, missingIds: ['12'] }));
});

test('review planner splits complete proposals by actual bytes or context and isolates oversized singletons', () => {
  const source = proposals();
  const singles = request.inputs.map((input, index) => estimateStandardizationRequest(buildStandardizationReviewRequest({
    ...request, inputs: [input],
  }, { items: [source.items[index]!], missingIds: [] }), limits));
  for (const budget of [
    { ...limits, maxRequestBytes: Math.max(...singles.map(size => size.requestBytes)) },
    { ...limits, maxContextTokens: Math.max(...singles.map(size => size.estimatedTotalTokens)) },
  ]) {
    const groups = planStandardizationReviewRequests(request, source, budget);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.flatMap(group => group.request.inputs), request.inputs);
    assert.deepEqual(groups.flatMap(group => group.proposals.items), source.items);
    assert.ok(groups.every(group => !group.oversized));
    for (const group of groups) assert.deepEqual(group.estimate,
      estimateStandardizationRequest(buildStandardizationReviewRequest(group.request, group.proposals), budget));
  }
  const oversized = planStandardizationReviewRequests(request, source, { ...limits, maxRequestBytes: 1 });
  assert.deepEqual(oversized.map(group => group.oversized), [true, true]);
  const [whole] = planStandardizationReviewRequests(request, source, limits);
  const exact = planStandardizationReviewRequests(request, source, { ...limits, maxRequestBytes: whole!.estimate.requestBytes });
  assert.equal(exact.length, 1);
  assert.equal(exact[0]!.oversized, false);
  assert.deepEqual(planStandardizationReviewRequests({ model: 'mock', candidates: [], inputs: [] }, { items: [], missingIds: [] }, limits), []);
});

test('only matched or unmatched decisions are model reviewable; technical failures cannot become proposals', () => {
  for (const item of proposals().items) assert.equal(isReviewableStandardizationDecision(item), true);
  const source = proposals();
  source.items[1] = { id: '12', status: 'unclassified', reasonCode: 'input_too_large',
    ruleIds: [], evidence: [], reason: 'Local budget error' };
  assert.equal(isReviewableStandardizationDecision(source.items[1]), false);
  assert.throws(() => buildStandardizationReviewRequest(request, source));
  assert.throws(() => parse({ items: [{ id: '11', approved: true }] }, source));
});

test('review aliases current names consistently across source candidates and exact mapping evidence', () => {
  const source = proposals();
  source.items[0]!.evidence = [{ path: 'name', quote: '破甲 catalogword1' }];
  const built = buildStandardizationReviewRequest({ ...request,
    candidates: [{ ...request.candidates[0]!, product: '破甲' }],
    inputs: [{ ...request.inputs[0]!, payload: { name: '破甲 catalogword1' } }],
  }, { items: [source.items[0]!], missingIds: [] });
  assert.doesNotMatch(built.messages[1]!.content, /破甲/u);
  const body = JSON.parse(built.messages[1]!.content);
  assert.equal(body.inputs[0].payload.name, 'catalogword2 catalogword1');
  assert.equal(body.candidates[0].product, 'catalogword2');
  assert.equal(body.proposals.items[0].evidence[0].quote, 'catalogword2 catalogword1');
});

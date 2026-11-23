import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStandardizationProtocolResponse, standardizationProposal, STANDARDIZATION_REVIEW_REASONS, type ParsedStandardizationResponse } from '../src/ai/ai.schemas.js';
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
  { id: '11', standardProductId: '91', nullReason: null, evidence: [{ path: 'name', quote: 'ChatGPT Plus' }] },
  { id: '12', standardProductId: null, nullReason: 'insufficient_source', evidence: [{ path: 'name', quote: 'Unknown offer' }] },
] };
const proposals = (): ParsedStandardizationResponse => parseStandardizationProtocolResponse(wire,
  request.inputs.map(input => ({ id: String(input.productId), candidateStandardProductIds: input.candidateStandardProductIds })));
const parse = (value: unknown, source = proposals()) => parseStandardizationReviewResponse(JSON.stringify(value), source, request);
const votes = (approved = true) => ({ items: wire.items.map(item => ({
  id: item.id, approved, code: approved ? null : 'source_conflict', evidence: approved ? [] : item.evidence,
})) });
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

test('approval preserves exact decisions in proposal order', () => {
  const source = proposals();
  const result = parse({ items: votes().items.reverse() }, source);
  assert.deepEqual(result, { items: source.items.map(item => ({ ...item,
    review: { approved: true, code: null, evidence: [], proposal: standardizationProposal(item) } })), missingIds: [] });
  assert.equal(result.items[0]!.identity, source.items[0]!.identity);
  assert.equal(result.items[0]!.evidence, source.items[0]!.evidence);
  assert.ok(source.items.every(item => item.review === undefined));
});

test('rejection retains original mapping and evidence for pending handling', () => {
  const source = proposals();
  const result = parse(votes(false), source);
  assert.deepEqual(result.items, source.items.map(item => ({
    id: item.id, status: 'unclassified', reasonCode: 'review_rejected',
    reason: STANDARDIZATION_REVIEW_REASONS.source_conflict, ruleIds: [], evidence: item.evidence,
    review: { approved: false, code: 'source_conflict', evidence: item.evidence, proposal: standardizationProposal(item) },
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
    assert.throws(() => parseStandardizationReviewResponse(content, proposals(), request));
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

test('review restores feedback aliases before checking exact original paths and quotes', () => {
  const source = proposals();
  source.items[0]!.evidence = [{ path: 'name', quote: '破甲 catalogword1' }];
  const frozen = { ...request,
    candidates: [request.candidates[0]!],
    inputs: [{ ...request.inputs[0]!, payload: {
      name: '破甲 catalogword1', sourceData: { 破甲说明: '仅供破甲工具，不含订阅' },
    } }],
  };
  const selected = { items: [source.items[0]!], missingIds: [] };
  const reviewed = parseStandardizationReviewResponse(JSON.stringify({ items: [{
    id: '11', approved: false, code: 'identity_mismatch',
    evidence: [{ path: 'sourceData.catalogword2说明', quote: '仅供catalogword2工具，不含订阅' }],
  }] }), selected, frozen);
  assert.deepEqual(reviewed.items[0]!.review!.evidence, [{ path: 'sourceData.破甲说明', quote: '仅供破甲工具，不含订阅' }]);
  assert.equal(reviewed.items[0]!.evidence, selected.items[0]!.evidence);
  assert.equal(reviewed.items[0]!.review!.proposal.standardProductId, '91');
});

test('prompt examples distinguish buyer prerequisites, eligibility links, active subscriptions and unknowns', () => {
  const prompt = buildStandardizationReviewRequest(request, proposals()).messages[0]!.content;
  const input = JSON.parse(prompt.match(/<input>\n([\s\S]*?)\n<\/input>/u)![1]!);
  const output = prompt.match(/<output>\n([\s\S]*?)\n<\/output>/u)![1]!;
  const frozen = { model: 'mock', candidates: input.candidates,
    inputs: input.inputs.map((item: any) => ({
      productId: BigInt(item.id), payload: item.payload, candidateStandardProductIds: item.candidateStandardProductIds,
    })) };
  const source = parseStandardizationProtocolResponse(input.proposals, input.inputs);
  const reviewed = parseStandardizationReviewResponse(output, source, frozen);
  assert.deepEqual(reviewed.items.map(item => item.review!.approved), [false, false, true, true]);
  assert.deepEqual(reviewed.items.map(item => item.review!.proposal.standardProductId), ['92', '91', '91', null]);
  assert.deepEqual(reviewed.items.map(item => item.evidence), source.items.map(item => item.evidence));
  assert.equal(reviewed.items[3]!.reasonCode, 'insufficient_source');
});

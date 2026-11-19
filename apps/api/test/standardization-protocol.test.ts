import assert from 'node:assert/strict';
import test from 'node:test';
import * as schemas from '../src/ai/ai.schemas.js';
import { parseStandardizationProtocolResponse, standardizationProtocolSchema, StandardizationValidationError } from '../src/ai/ai.schemas.js';
import { buildStandardizationRequest, estimateStandardizationRequest, assertStandardizationRequestFits, readStandardizationRequestLimits } from '../src/ai/standardization-request.js';
import { validateStandardizationEvidence } from '../src/ai/standardization-evidence.js';

const evidence = [{ path: 'name', quote: 'ChatGPT Plus' }];
const request = { model: 'mock', candidates: [
  { id: '91', family: 'openai', product: 'chatgpt', tier: 'plus', aliases: [] },
  { id: '92', family: 'anthropic', product: 'claude', tier: 'team', aliases: [] },
], inputs: [
  { productId: 11n, payload: { name: 'ChatGPT Plus' }, candidateStandardProductIds: ['91'] },
  { productId: 12n, payload: { name: 'Claude Team' }, candidateStandardProductIds: ['92'] },
] };
const wireItems = [
  { id: '11', standardProductId: '91', evidence },
  { id: '12', standardProductId: null, evidence: [{ path: 'name', quote: 'Claude Team' }] },
];
const parse = (value: unknown) => parseStandardizationProtocolResponse(value, buildStandardizationRequest(request).protocolInputs);

test('minimal protocol returns existing mappings or unmatched decisions in input order', () => {
  const result = parse({ items: [...wireItems].reverse() });
  assert.deepEqual(Object.keys(result).sort(), ['items', 'missingIds']);
  assert.deepEqual(result.missingIds, []);
  assert.deepEqual(result.items, [
    { id: '11', status: 'classified', identity: { kind: 'existing', standardProductId: '91' },
      evidence, ruleIds: [], reasonCode: null, reason: '匹配已准入标准商品' },
    { id: '12', status: 'unclassified', evidence: wireItems[1]!.evidence,
      ruleIds: [], reasonCode: 'unmatched', reason: '未匹配到已准入标准商品' },
  ]);
});

test('schema binds each ID to only its frozen allowed candidate IDs and requires all items', () => {
  const schema = standardizationProtocolSchema(buildStandardizationRequest(request).protocolInputs) as any;
  assert.deepEqual(schema.required, ['items']);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.items.minItems, 2);
  assert.equal(schema.properties.items.maxItems, 2);
  for (const [index, branch] of schema.properties.items.items.anyOf.entries()) {
    assert.deepEqual(branch.required, ['id', 'standardProductId', 'evidence']);
    assert.equal(branch.additionalProperties, false);
    assert.equal(branch.properties.id.const, String(index + 11));
    assert.deepEqual(branch.properties.standardProductId.enum, [String(index + 91), null]);
    assert.equal(branch.properties.evidence.minItems, 1);
  }
  assert.doesNotMatch(JSON.stringify(schema), /candidateRef|action|identity|reason|ruleIds/u);
});

test('every malformed output throws instead of becoming a business decision', () => {
  const replaceFirst = (item: unknown) => ({ items: [item, wireItems[1]] });
  for (const value of [
    null, [], {}, { items: false }, { items: [], identities: [] }, { items: wireItems, missingIds: [] },
    { items: [] }, { items: wireItems.slice(1) }, { items: [...wireItems, wireItems[0]] },
    { items: [wireItems[0], wireItems[0]] },
    replaceFirst(null), replaceFirst({ id: '11', standardProductId: '91' }),
    replaceFirst({ ...wireItems[0], action: 'reuse_candidate' }),
    replaceFirst({ ...wireItems[0], reason: 'explanation' }),
    replaceFirst({ ...wireItems[0], identity: { kind: 'new' } }),
    ...['92', '999', 'i1c1', ' 91', '９１', 91, false, {}, undefined].map(standardProductId =>
      replaceFirst({ ...wireItems[0], standardProductId })),
    ...['999', ' 11', '11 ', '１１', 11, null].map(id => replaceFirst({ ...wireItems[0], id })),
    ...[[], null, [{ path: 'name', quote: '' }], [{ path: 'name', quote: 'x', reason: 'extra' }],
      [{ path: 1, quote: 'x' }], [{ path: 'name', quote: 'x'.repeat(1001) }],
      Array.from({ length: 51 }, () => evidence[0])].map(invalidEvidence =>
      replaceFirst({ ...wireItems[0], evidence: invalidEvidence })),
    { items: [{ id: '11', action: 'create_identity', identity: {}, evidence, reason: 'old', ruleIds: [] }, wireItems[1]] },
  ]) assert.throws(() => parse(value), StandardizationValidationError, JSON.stringify(value));
});

test('empty batches are valid but duplicated input IDs are not', () => {
  assert.deepEqual(parseStandardizationProtocolResponse({ items: [] }, []), { items: [], missingIds: [] });
  const [input] = buildStandardizationRequest(request).protocolInputs;
  assert.throws(() => parseStandardizationProtocolResponse({ items: [] }, [input!, input!]), /ID.*重复/u);
  assert.deepEqual((standardizationProtocolSchema([]) as any).properties.items, { type: 'array', minItems: 0, maxItems: 0 });
});

test('request shares approved candidates once, carries current payload and excludes previous decisions', () => {
  const source = structuredClone(request);
  source.inputs[1]!.candidateStandardProductIds = ['91', '92'];
  source.candidates.push({ id: '999', family: 'unused', product: 'unused', tier: 'unused', aliases: [] });
  const withHistory = { ...source, inputs: source.inputs.map(input => ({
    ...input, previousDecision: { reason: 'PRIVATE OLD HISTORY' },
  })) };
  const built = buildStandardizationRequest(withHistory);
  const body = JSON.parse(built.messages[1]!.content);
  assert.deepEqual(body.candidates, source.candidates.slice(0, 2));
  assert.deepEqual(body.items, source.inputs.map(input => ({
    ...input.payload, id: String(input.productId), candidateStandardProductIds: input.candidateStandardProductIds,
  })));
  assert.doesNotMatch(JSON.stringify(built.messages), /previousDecision|historyContext|PRIVATE OLD HISTORY|create_identity|IDENTITY_POLICY|not_sellable/u);
  assert.match(built.messages[0]!.content, /approved definitions/iu);
  assert.match(built.messages[0]!.content, /attributes/iu);
  assert.match(built.messages[0]!.content, /untrusted/iu);
  source.inputs[0]!.candidateStandardProductIds[0] = '92';
  source.inputs[0]!.payload.name = 'changed';
  assert.deepEqual(built.protocolInputs[0]!.candidateStandardProductIds, ['91']);
  assert.ok(Object.isFrozen(built.protocolInputs[0]!.candidateStandardProductIds));
  assert.equal(JSON.parse(built.messages[1]!.content).items[0].name, 'ChatGPT Plus');
});

test('request rejects duplicate IDs, missing candidates and protocol fields inside source payload', () => {
  for (const invalid of [
    { ...request, inputs: [request.inputs[0]!, request.inputs[0]!] },
    { ...request, candidates: [request.candidates[0]!, request.candidates[0]!] },
    { ...request, candidates: [] },
    { ...request, inputs: [{ ...request.inputs[0]!, candidateStandardProductIds: ['91', '91'] }] },
    ...['candidateRefs', 'candidates', 'candidateStandardProductIds', 'historyContext', 'previousDecision'].map(key => ({
      ...request, inputs: [{ ...request.inputs[0]!, payload: { name: 'ChatGPT Plus', [key]: {} } }],
    })),
  ]) assert.throws(() => buildStandardizationRequest(invalid));
});

test('prompt example validates through the exact new protocol and evidence boundary', () => {
  const prompt = buildStandardizationRequest(request).messages[0]!.content;
  const blocks = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/gu)];
  assert.equal(blocks.length, 2);
  const input = JSON.parse(blocks[0]![1]!);
  const inputs = input.items.map((item: any) => ({
    id: item.id, candidateStandardProductIds: item.candidateStandardProductIds, payload: item,
  }));
  const parsed = parseStandardizationProtocolResponse(JSON.parse(blocks[1]![1]!), inputs);
  assert.deepEqual(validateStandardizationEvidence(parsed, inputs, input.candidates), parsed);
});

test('response parsing requires complete JSON without fences or field repairs and retains literal quotes', () => {
  const built = buildStandardizationRequest(request);
  for (const content of ['', '{"items":', '```json\n{"items":[]}\n```', '{"items":[]} extra']) {
    assert.throws(() => built.parseResponse(content), /JSON/u);
  }
  const raw = { items: [{ ...wireItems[0], evidence: [{ path: 'name', quote: 'ＣhatGPT  Plus\n' }] }, wireItems[1]] };
  const parsed = parse(built.parseResponse(JSON.stringify(raw)));
  assert.equal(parsed.items[0]!.evidence[0]!.quote, raw.items[0]!.evidence[0]!.quote);
});

test('source aliases remain collision free and restore literal names and citation paths', () => {
  const source = { model: 'mock', candidates: [{ id: '91', family: 'software', product: '破甲', tier: 'standard', aliases: ['破甲工具'] }],
    inputs: [{ productId: 11n, payload: { name: '破甲工具 catalogword1 ＣＡＴＡＬＯＧＷＯＲＤ２', sourceData: { 破甲说明: '破甲工具' } },
      candidateStandardProductIds: ['91'] }] };
  const before = structuredClone(source);
  const built = buildStandardizationRequest(source);
  const body = JSON.parse(built.messages[1]!.content);
  assert.match(body.items[0].name, /^catalogword3工具/u);
  assert.doesNotMatch(JSON.stringify(built.messages), /破甲/u);
  const parsed = parseStandardizationProtocolResponse(built.parseResponse(JSON.stringify({ items: [{
    id: '11', standardProductId: '91', evidence: [{ path: 'sourceData.catalogword3说明', quote: 'catalogword3工具' }],
  }] })), built.protocolInputs);
  assert.deepEqual(parsed.items[0]!.evidence, [{ path: 'sourceData.破甲说明', quote: '破甲工具' }]);
  assert.deepEqual(source, before);
});

test('request budget includes candidates, schema and streaming options', () => {
  const built = buildStandardizationRequest(request);
  const limits = { maxRequestBytes: 1_000_000, maxContextTokens: 1_000_000, outputReserveTokens: 1000 };
  const size = estimateStandardizationRequest(built, limits);
  assert.equal(size.estimatedTotalTokens, size.estimatedInputTokens + 1000);
  assert.throws(() => assertStandardizationRequestFits(built, { ...limits, maxRequestBytes: size.requestBytes - 1 }), /budget|limit/iu);
  assert.throws(() => assertStandardizationRequestFits(built, { ...limits, maxContextTokens: size.estimatedTotalTokens - 1 }), /budget|limit/iu);
  const plain = estimateStandardizationRequest(built, readStandardizationRequestLimits({ AI_THINKING: 'auto' }));
  const enabled = estimateStandardizationRequest(built, readStandardizationRequestLimits({ AI_THINKING: 'enabled' }));
  assert.equal(enabled.requestBytes - plain.requestBytes, Buffer.byteLength(',"thinking":{"type":"enabled"}'));
});

test('checkpoint assertion accepts only exact current internal business shapes with evidence', () => {
  const check = (schemas as any).assertStandardizationCheckpoint;
  assert.equal(typeof check, 'function');
  const matched = { id: '11', status: 'classified', identity: { kind: 'existing', standardProductId: '91' },
    ruleIds: [], evidence, reasonCode: null, reason: '匹配已准入标准商品' };
  const unmatched = { id: '12', status: 'unclassified', ruleIds: [], evidence,
    reasonCode: 'unmatched', reason: '未匹配到已准入标准商品' };
  const rejected = { ...unmatched, reasonCode: 'review_rejected', reason: 'LLM 对该标准化提议判定为否',
    review: { approved: false } };
  for (const item of [matched, unmatched, { ...matched, review: { approved: true } },
    { ...unmatched, review: { approved: true } }, rejected]) {
    assert.doesNotThrow(() => check({ items: [item], missingIds: [] }));
  }
  for (const value of [
    null, [], {}, { items: [], missingIds: ['11'] }, { items: [], missingIds: [], identities: [] },
    { items: [matched], missingIds: [], metadata: {} }, { items: [matched, matched], missingIds: [] },
    ...[
      { ...matched, identity: { kind: 'new', ref: 'old', canonicalKey: 'old' } },
      { ...matched, identity: { kind: 'existing', standardProductId: '91', ref: 'old' } },
      { ...matched, identity: undefined }, { ...matched, evidence: [] },
      { ...matched, reasonCode: 'unmatched' }, { ...matched, ruleIds: ['old-rule'] },
      { ...matched, diagnostic: { stage: 'schema', code: 'invalid_type' } },
      { ...matched, review: { approved: false } }, { ...matched, review: { approved: true, extra: true } },
      { ...unmatched, identity: matched.identity }, { ...unmatched, reason: 'model explanation' },
      { ...unmatched, reasonCode: 'insufficient_evidence' }, { ...unmatched, reasonCode: 'publication_too_large' },
      { ...unmatched, review: { approved: false } }, { ...rejected, review: undefined },
      { ...rejected, evidence: [] }, { ...rejected, review: { approved: true } },
    ].map(item => ({ items: [item], missingIds: [] })),
  ]) assert.throws(() => check(value), StandardizationValidationError, JSON.stringify(value));
});

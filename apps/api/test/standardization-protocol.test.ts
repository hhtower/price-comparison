import assert from 'node:assert/strict';
import test from 'node:test';
import * as schemas from '../src/ai/ai.schemas.js';
import * as worker from '../src/ai/ai.worker.js';
import { validateStandardizationEvidence } from '../src/ai/standardization-evidence.js';
import { buildExtractionPayload } from '../src/ai/adaptive-batching.js';
import { buildSourceEvidence } from '../src/platforms/source-evidence.js';
import type { JsonValue } from '../src/database/types.js';
import type { CandidateDocument } from '../src/standardization/candidate-index.js';

const evidence = [{ path: 'name', quote: 'ChatGPT Plus' }];
const base = { id: '11', ruleIds: [], evidence, reason: 'Explicit offer' };
const request = { model: 'test-model', candidates: [
  { id: '91', family: 'openai', product: 'chatgpt', tier: 'plus', aliases: [] },
  { id: '92', family: 'anthropic', product: 'claude', tier: 'team', aliases: [] },
], inputs: [
  { productId: 11n, payload: { id: '11', name: 'ChatGPT Plus' }, candidateStandardProductIds: ['91'] },
  { productId: 12n, payload: { id: '12', name: 'Claude Team' }, candidateStandardProductIds: ['92'] },
] };
const builders = () => {
  assert.equal(typeof (worker as any).buildStandardizationRequest, 'function', 'full request builder must exist before planning');
  return worker as any;
};

test('identity prompt example passes the current protocol and item evidence validation', () => {
  const prompt = worker.buildStandardizationRequest(request).messages[0]!.content;
  assert.doesNotMatch(prompt, /\btags?\b|标签/iu);
  const blocks = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/gu)];
  assert.equal(blocks.length, 2, 'one complete input/output example');
  const example = JSON.parse(blocks[0]![1]!) as {
    candidates: Record<string, Omit<CandidateDocument, 'id'>>;
    items: Array<{ id: string; name: string; sourceData?: Record<string, JsonValue>; candidateRefs: Record<string, string> }>;
  };
  const candidateIds = new Map(Object.keys(example.candidates).map((key, index) => [key, String(91 + index)]));
  const inputs = example.items.map(item => ({ id: item.id,
    candidateRefs: Object.fromEntries(Object.entries(item.candidateRefs).map(([ref, tableRef]) => [ref, candidateIds.get(tableRef)!])),
    candidateStandardProductIds: Object.values(item.candidateRefs).map(tableRef => candidateIds.get(tableRef)!) }));
  const parsed = schemas.parseStandardizationProtocolResponse(JSON.parse(blocks[1]![1]!), inputs);
  const validated = validateStandardizationEvidence(parsed,
    example.items.map(item => ({ id: item.id, payload: buildExtractionPayload({
      id: item.id, name: item.name, spec: '', sourceData: buildSourceEvidence(item.sourceData ?? {}),
    }) })),
    Object.entries(example.candidates).map(([id, candidate]) => ({ ...candidate, id: candidateIds.get(id)! })));
  assert.deepEqual(validated.items.map(item => [item.id, item.status, item.reasonCode]), [
    ['101', 'classified', null], ['102', 'classified', null],
    ['103', 'unclassified', 'insufficient_evidence'], ['104', 'unclassified', 'not_sellable'],
    ['105', 'unclassified', 'publication_blocked'],
  ]);
  assert.deepEqual(parsed.missingIds, []);
});

test('new identities reject SKU-only tiers while genuine plans and historical candidates remain usable', () => {
  const built = worker.buildStandardizationRequest({ ...request, candidates: [
    { id: '91', family: 'software', product: 'yunfan_protocol_card', tier: 'monthly', aliases: [] },
    request.candidates[1]!,
  ] });
  for (const tier of ['天卡', 'monthly', '30 days', '100 usd', '5个', '月卡', 'yearly', '100元',
    'monthly_card', 'day-card', 'weekly pass', '30天卡', '1个月', 'USD 100', '100刀', '5 accounts', '100', '10.5', '１００']) {
    const parsed = schemas.parseStandardizationProtocolResponse({ items: [{ ...base, action: 'create_identity',
      identity: { family: 'software', product: 'yunfan_protocol_card', tier, evidence, reason: 'Explicit offer' },
    }] }, built.protocolInputs);
    assert.equal(parsed.items[0]?.reasonCode, 'identity_conflict', tier);
    assert.equal(parsed.items[0]?.diagnostic?.code, 'sku_in_identity', tier);
    assert.equal(parsed.identities.length, 0);
  }
  for (const tier of ['standard', 'pro', 'vip']) {
    const parsed = schemas.parseStandardizationProtocolResponse({ items: [{ ...base, action: 'create_identity',
      identity: { family: 'software', product: 'yunfan_protocol_card', tier, evidence, reason: 'Explicit offer' },
    }] }, built.protocolInputs);
    assert.equal(parsed.items[0]?.status, 'classified', tier);
  }
  const reused = schemas.parseStandardizationProtocolResponse({ items: [{ ...base, action: 'reuse_candidate', candidateRef: 'i1c1' }] }, built.protocolInputs);
  assert.deepEqual(reused.items[0]?.identity, { kind: 'existing', standardProductId: '91' });
});

test('finite action protocol resolves only item-local candidate refs and derives internal new identity keys', () => {
  const api = builders();
  const built = api.buildStandardizationRequest(request);
  assert.equal(typeof (schemas as any).parseStandardizationProtocolResponse, 'function');
  const parsed = (schemas as any).parseStandardizationProtocolResponse({ items: [
    { ...base, action: 'reuse_candidate', candidateRef: 'i1c1' },
    { ...base, id: '12', action: 'create_identity', identity: { family: 'Anthropic', product: 'Claude', tier: 'Team', evidence: [{ path: 'name', quote: 'Claude Team' }], reason: 'Explicit offer' } },
  ] }, built.protocolInputs);
  assert.deepEqual(parsed.items[0].identity, { kind: 'existing', standardProductId: '91' });
  assert.equal(parsed.items[1].identity.kind, 'new');
  assert.equal(parsed.identities[0].canonicalKey, 'v3:76cdf8907e6ba537e20d3902bfe3f49dfbf95f04d892e7d8a583fd860aa92539');
  for (const candidateRef of ['i1c1', '91', 'i2c2']) {
    const rejected = (schemas as any).parseStandardizationProtocolResponse({ items: [
      { ...base, id: '12', action: 'reuse_candidate', candidateRef },
    ] }, built.protocolInputs);
    assert.equal(rejected.items[0].reasonCode, 'invalid_response');
  }
});

test('protocol separates evidence gaps from nonsellable items and rejects unknown actions', () => {
  const built = builders().buildStandardizationRequest(request);
  const parsed = (schemas as any).parseStandardizationProtocolResponse({ items: [
    { id: '11', action: 'insufficient_evidence', evidence: [], ruleIds: [], reason: 'Tier missing' },
    { id: '12', action: 'not_sellable', evidence: [], ruleIds: [], reason: 'Notice only' },
  ] }, built.protocolInputs);
  assert.deepEqual(parsed.items.map((item: any) => item.reasonCode), ['insufficient_evidence', 'not_sellable']);
  const bad = (schemas as any).parseStandardizationProtocolResponse({ items: [{ ...base, action: 'guess_identity' }] }, built.protocolInputs);
  assert.equal(bad.items[0].reasonCode, 'invalid_response');
});

test('full request estimate includes policy, schema, candidate documents, items and output allowance', () => {
  const api = builders();
  const built = api.buildStandardizationRequest(request);
  const limits = { maxRequestBytes: 1000000, maxContextTokens: 1000000, outputReserveTokens: 1000 };
  const sized = api.estimateStandardizationRequest(built, limits);
  assert.ok(sized.requestBytes > Buffer.byteLength(JSON.stringify(request.inputs.map(input => input.payload))));
  assert.equal(sized.estimatedTotalTokens, sized.estimatedInputTokens + 1000);
  const large = api.buildStandardizationRequest({ ...request, candidates: request.candidates.map(item => ({ ...item, aliases: ['资料'.repeat(10000)] })) });
  assert.throws(() => api.assertStandardizationRequestFits(large, { ...limits, maxRequestBytes: sized.requestBytes + 1 }), (error: any) => error.retryClass === 'input_too_large' && error.retryable === false);
  assert.throws(() => api.assertStandardizationRequestFits(built, { ...limits, maxContextTokens: sized.estimatedTotalTokens - 1 }), /budget|limit/i);
  const payload = JSON.parse(built.messages[1].content);
  assert.deepEqual(payload.items[0].candidateRefs, { i1c1: 'c1' });
  assert.equal(payload.items[0].candidateStandardProductIds, undefined);
  assert.equal(payload.candidates.c1.id, undefined);
});

test('request builder freezes references and evidence independently from later source mutations', () => {
  const value = structuredClone(request);
  const built = builders().buildStandardizationRequest(value);
  value.inputs[0].candidateStandardProductIds[0] = '92';
  value.inputs[0].payload.name = 'changed';
  assert.equal(built.protocolInputs[0].candidateRefs.i1c1, '91');
  assert.equal(JSON.parse(built.messages[1].content).items[0].name, 'ChatGPT Plus');
});

test('shared candidate documents are sent once with only item-local response references', () => {
  const source = structuredClone(request);
  source.inputs[1].candidateStandardProductIds = ['91', '92'];
  source.candidates.push({ id: '999', family: 'unused', product: 'unused', tier: 'unused', aliases: [] });
  const built = worker.buildStandardizationRequest(source);
  const payload = JSON.parse(built.messages[1]!.content);
  assert.deepEqual(payload.candidates, {
    c1: { family: 'openai', product: 'chatgpt', tier: 'plus', aliases: [] },
    c2: { family: 'anthropic', product: 'claude', tier: 'team', aliases: [] },
  });
  assert.deepEqual(payload.items.map((item: any) => item.candidateRefs), [{ i1c1: 'c1' }, { i2c1: 'c1', i2c2: 'c2' }]);
  assert.ok(payload.items.every((item: any) => !Object.hasOwn(item, 'candidates')));
  for (const candidateRef of ['c1', 'c2', 'i2c1', 'i2c2', '92']) {
    const parsed = schemas.parseStandardizationProtocolResponse({ items: [{ ...base, action: 'reuse_candidate', candidateRef }] }, built.protocolInputs);
    assert.equal(parsed.items[0]?.reasonCode, 'invalid_response', candidateRef);
  }
  const parsed = schemas.parseStandardizationProtocolResponse({ items: [
    { ...base, action: 'reuse_candidate', candidateRef: 'i1c1' },
    { ...base, id: '12', action: 'reuse_candidate', candidateRef: 'i2c2' },
  ] }, built.protocolInputs);
  assert.deepEqual(parsed.items.map(item => item.identity), [
    { kind: 'existing', standardProductId: '91' }, { kind: 'existing', standardProductId: '92' },
  ]);
});

test('request aliases preserve source names, candidates and history without colliding with literal catalog tokens', () => {
  const source = { model: 'mock', candidates: [
    { id: '91', family: '破甲', product: 'tool', tier: 'standard', aliases: ['破甲工具'] },
  ], inputs: [{ productId: 11n, candidateStandardProductIds: ['91'],
    payload: { name: '破甲工具破解版', spec: 'CATALOGWORD1 ｃａｔａｌｏｇｗｏｒｄ２', sourceData: { selectedOptions: [{ value: '破甲' }], 破甲说明: '破甲工具' } },
    previousDecision: { reason: '破甲工具', contentVersion: '0' },
  }] };
  const original = structuredClone(source);
  const built = builders().buildStandardizationRequest(source);
  const payload = JSON.parse(built.messages[1].content);
  const item = payload.items[0];
  const candidate = payload.candidates[item.candidateRefs.i1c1];
  const alias = item.sourceData.selectedOptions[0].value;
  assert.doesNotMatch(JSON.stringify(built.messages), /破甲/u);
  assert.notEqual(alias, 'catalogword1');
  assert.notEqual(alias, 'catalogword2');
  assert.equal(item.name, `${alias}工具破解版`);
  assert.equal(item.spec, source.inputs[0]!.payload.spec);
  assert.equal(candidate.family, alias);
  assert.deepEqual(candidate.aliases, [`${alias}工具`]);
  assert.equal(item.historyContext.reason, `${alias}工具`);
  assert.deepEqual(item.candidateRefs, { i1c1: 'c1' });
  assert.deepEqual(built.parseResponse(JSON.stringify({ value: item.spec, reason: alias })),
    { value: 'CATALOGWORD1 ｃａｔａｌｏｇｗｏｒｄ２', reason: '破甲' });
  assert.deepEqual(source, original);
  assert.deepEqual(builders().buildStandardizationRequest(source).messages, built.messages);
});

test('streamed aliases are restored before identity keys, schema lengths and original-source citation validation', async () => {
  const source = { jobId: 3n, model: 'mock', candidates: [
    { id: '91', family: '破甲', product: 'tool', tier: 'standard', aliases: ['破甲工具'] },
  ], inputs: [11n, 12n].map(productId => ({ productId, candidateStandardProductIds: ['91'],
    payload: { name: '破甲工具破解版', sourceData: { 破甲说明: '破甲工具' }, spec: '破甲'.repeat(125) },
  })) };
  const original = structuredClone(source);
  const call = worker.createOpenAiModelCall({ getBatchRequest: async () => source } as never, {
    AI_BASE_URL: 'https://model.invalid/v1', AI_API_KEY: 'test', AI_MODEL: 'mock',
  }, async (_url, init) => {
    const sent = JSON.parse(String(init?.body));
    assert.equal(sent.stream, true);
    assert.doesNotMatch(JSON.stringify(sent.messages), /破甲/u);
    const estimate = builders().estimateStandardizationRequest(builders().buildStandardizationRequest(source));
    assert.equal(estimate.requestBytes, Buffer.byteLength(String(init?.body)));
    const payload = JSON.parse(sent.messages[1].content);
    const [first, second] = payload.items;
    const candidate = payload.candidates[first.candidateRefs.i1c1];
    assert.deepEqual(second.candidateRefs, { i2c1: 'c1' });
    const quote = first.name;
    const evidence = [{ path: 'name', quote }, { path: `sourceData.${candidate.family}说明`, quote: candidate.aliases[0] }];
    const content = JSON.stringify({ items: [
      { id: first.id, action: 'create_identity', identity: { family: candidate.family.toUpperCase(), product: 'tool', tier: 'standard', evidence, reason: quote },
        evidence, ruleIds: [], reason: quote },
      { id: second.id, action: 'reuse_candidate', candidateRef: Object.keys(second.candidateRefs)[0], evidence, ruleIds: [], reason: quote },
    ] }).replace(/catalogword/gu, '\\u0063atalogword');
    const chunks = [content.slice(0, 29), content.slice(29)];
    return new Response(chunks.map((part, i) => `data: ${JSON.stringify({ choices: [{ delta: { content: part }, ...(i === 1 ? { finish_reason: 'stop' } : {}) }] })}\n\n`).join('') + 'data: [DONE]\n\n');
  });
  const result = await call({ id: 7n }, new AbortController().signal);
  assert.deepEqual(result.items.map(item => item.status), ['classified', 'classified']);
  assert.equal(result.identities[0]?.family, '破甲');
  const plain = schemas.parseStandardizationProtocolResponse({ items: [{ id: '11', action: 'create_identity',
    identity: { family: '破甲', product: 'tool', tier: 'standard', evidence: [{ path: 'name', quote: '破甲工具破解版' }], reason: 'Explicit offer' },
    evidence: [{ path: 'name', quote: '破甲工具破解版' }], ruleIds: [], reason: 'Explicit offer',
  }] }, builders().buildStandardizationRequest(source).protocolInputs);
  assert.equal(result.identities[0]?.canonicalKey, plain.identities[0]?.canonicalKey);
  assert.deepEqual(result.items[1]?.identity, { kind: 'existing', standardProductId: '91' });
  assert.equal(result.items[0]?.evidence[1]?.path, 'sourceData.破甲说明');
  assert.equal(result.items[0]?.reason, '破甲工具破解版');
  assert.deepEqual(source, original);
});

test('full request budget includes configured streaming thinking body options', () => {
  const api = builders();
  const built = api.buildStandardizationRequest(request);
  const plain = api.readStandardizationRequestLimits({ AI_THINKING: 'auto' });
  const enabled = api.readStandardizationRequestLimits({ AI_THINKING: 'enabled' });
  const ordinarySize = api.estimateStandardizationRequest(built, plain);
  const thinkingSize = api.estimateStandardizationRequest(built, enabled);
  assert.equal(thinkingSize.requestBytes - ordinarySize.requestBytes, Buffer.byteLength(',"thinking":{"type":"enabled"}'));
  assert.throws(() => api.assertStandardizationRequestFits(built, { ...enabled, maxRequestBytes: ordinarySize.requestBytes }), /budget|limit/i);
});

test('prior decision is versioned context in the request, never current citation evidence', async () => {
  const source = { ...request, inputs: [ { ...request.inputs[0], previousDecision: { contentVersion: '0', action: 'assign', evidence: 'Old Claude Team listing' } } ] };
  const built = builders().buildStandardizationRequest(source);
  assert.deepEqual(JSON.parse(built.messages[1].content).items[0].historyContext, source.inputs[0].previousDecision);
  const call = worker.createOpenAiModelCall({ getBatchRequest: async () => ({ ...source, jobId: 3n }) } as never, { AI_BASE_URL: 'https://model.invalid/v1', AI_API_KEY: 'test', AI_MODEL: 'test' }, async () => new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ items: [{ ...base, action: 'reuse_candidate', candidateRef: 'i1c1', evidence: [{ path: 'historyContext.evidence', quote: 'Old Claude Team listing' }] }] }) }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'));
  const parsed = await call({ id: 7n }, new AbortController().signal);
  assert.equal(parsed.items[0]?.reasonCode, 'evidence_invalid');
  assert.equal(Object.hasOwn(source.inputs[0].payload, 'historyContext'), false);
});

test('over-budget candidate context is rejected before reserving any provider request', async () => {
  let reserved = 0, sent = 0, failed = 0;
  let pending: any = { kind: 'ai_batch', id: 7n, attempts: 1n, claimed_by: 'worker', lease_until: new Date(Date.now() + 60000), row: { job_id: 3n, step: 'request', claim_token: 't', input_bytes: 10n } };
  const repository = {
    prepareBatch: async () => undefined,
    getBatchRequest: async () => ({ ...request, jobId: 3n, candidates: request.candidates.map(candidate => ({ ...candidate, aliases: ['大'.repeat(100000)] })) }),
    reserveBatchRequest: async () => { reserved++; },
    recordBatchRequestOutcome: async () => undefined,
  };
  const runtime = worker.createAiWorker({
    claimNext: async () => { const value = pending; pending = null; return value; }, heartbeat: async () => undefined,
    fail: async (_kind: unknown, _id: unknown, _owner: unknown, _message: unknown, options: any) => { assert.equal(options.retryClass, 'input_too_large'); failed++; },
  } as never, { repository: repository as never, modelCall: worker.createOpenAiModelCall(repository as never, { AI_BASE_URL: 'https://model.invalid/v1', AI_API_KEY: 'test', AI_MODEL: 'm', AI_REQUEST_MAX_BYTES: '50000' }, async () => { sent++; throw new Error('must not send oversized request'); }) });
  await runtime.runOnce();
  for (let i = 0; i < 30 && !failed; i++) await new Promise(resolve => setTimeout(resolve, 5));
  await runtime.stop();
  assert.equal(reserved, 0); assert.equal(sent, 0); assert.equal(failed, 1);
});

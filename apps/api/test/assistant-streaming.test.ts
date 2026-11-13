import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyShoppingNeeds, type AssistantReply } from '@price-comparison/catalog/assistant-contract';
import { createStreamingCall, type StreamingInput } from '../src/ai/llm-runtime.js';
import { AssistantService } from '../src/assistant/assistant.service.js';
import type { AssistantRepository } from '../src/assistant/assistant.repository.js';
import type { CatalogService } from '../src/catalog/catalog.service.js';
import type { ClaimedJob } from '../src/jobs/jobs.repository.js';
import type { AssistantReasoning } from '../src/assistant/assistant-reasoning.js';
import { StructuredLogger } from '../src/observability/request-context.js';

const environment = { AI_BASE_URL: 'http://model.invalid/v1', AI_API_KEY: 'local-mock', AI_TIMEOUT_MS: '200', AI_MAX_OUTPUT_BYTES: '16384' };
const output = JSON.stringify({ intent: 'clarify', patch: {}, evidence: [], question: '主要用来做什么？', options: ['工作', '学习'] });

function fixture(fetcher: typeof fetch, env = environment, recommend = false) {
  let committed = 0;
  let requests = 0;
  let finishes = 0;
  let saved: AssistantReply | null = null;
  const thoughts: string[] = [];
  let progressClosed = 0;
  const logs: string[] = [];
  const repository = {
    readTurnContext: async () => ({
      snapshot: { id: '1', sessionId: '11111111-1111-4111-8111-111111111111', inputText: '帮我选商品', expectedRevision: 0 },
      needs: { ...emptyShoppingNeeds(), ...recommend ? { platform: 'fictional', product: 'Fictional subscription' } : {} }, history: [],
      deadlineAt: new Date(Date.now() + 10_000),
    }),
    reserveModelRequest: async () => { requests++; },
    finishModelRequest: async () => { finishes++; },
    setPhase: async () => {},
    completeTurn: async ({ reply }: { reply: AssistantReply }) => { saved = reply; committed++; },
  } as unknown as AssistantRepository;
  const job: ClaimedJob = { kind: 'assistant_turn', id: 1n, attempts: 1n, claimed_by: 'test', lease_until: new Date(Date.now() + 30_000), row: { claim_token: 'claim' } };
  const product = { id: '1', name: 'Fictional subscription', platform: 'fictional', kind: 'subscription' };
  const capturedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const offers = Array.from({ length: 5 }, (_, index) => ({ productId: String(index + 1), shopId: '1', shop: 'Fixture',
    name: 'Fixture quote', price: String(10 + index), currency: 'CNY', priceStatus: 'verified', inStock: true, stale: false,
    settlementQuantity: 1, capturedAt, priceExpiresAt: expiresAt, inventoryExpiresAt: expiresAt,
    tags: [{ name: 'duration', value: 30 }], spec: '', productUrl: 'https://example.invalid',
  }));
  const catalog = { getProducts: async () => ({ items: [product] }), getProduct: async () => product,
    getReferenceOffers: async () => offers,
  } as unknown as CatalogService;
  const reasoning = { start: async (key: string) => {
    assert.equal(key, '11111111-1111-4111-8111-111111111111:1');
    return { append: async (text: string) => { thoughts.push(text); }, close: async () => { progressClosed++; } };
  } } as unknown as AssistantReasoning;
  const service = new AssistantService(repository, catalog, createStreamingCall(env, fetcher), 'mock', undefined, reasoning,
    new StructuredLogger(line => logs.push(line)));
  return { run: (signal = new AbortController().signal) => service.runTurn(job, signal), thoughts, logs,
    get progressClosed() { return progressClosed; }, get saved() { return saved; }, get committed() { return committed; }, get requests() { return requests; }, get finishes() { return finishes; } };
}

function stream(parts: string[], finishReason = 'stop') {
  return new Response('data: {"id":"r1","model":"mock","choices":[{"delta":{"reasoning_content":"先看需求"}}]}\n\n' + parts.map((content, index) => `data: ${JSON.stringify({
    id: 'r1', model: 'mock', choices: [{ index: 0, delta: { content }, ...(index === parts.length - 1 ? { finish_reason: finishReason } : {}) }],
  })}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}

test('fragmented JSON is aggregated by shared transport and committed once only after validation', async () => {
  const state = fixture(async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).stream, true);
    assert.deepEqual(JSON.parse(String(init?.body)).response_format, { type: 'json_object' });
    assert.equal(JSON.parse(String(init?.body)).max_tokens, 8192);
    return stream([output.slice(0, 8), output.slice(8, 30), output.slice(30)]);
  });
  await state.run();
  assert.equal(state.committed, 1);
  assert.equal(state.requests, 1);
  assert.equal(state.finishes, 1);
  assert.deepEqual(state.thoughts, ['先看需求']);
  assert.equal(state.progressClosed, 1);
  assert.doesNotMatch(JSON.stringify(state.saved), /先看需求/u);
});

for (const [label, opening, closing] of [
  ['JSON fence', '```json\n', '\n```'],
  ['plain fence', '```\n', '\n```'],
  ['CRLF and whitespace', ' \r\n```JSON \r\n', '\r\n```\r\n '],
] as const) {
  test(`complete ${label} preserves JSON strings and commits only the validated reply`, async () => {
    const response = opening + output.replace('主要用来做什么？', '主要用来做什么？包含标记```json') + closing;
    const state = fixture(async () => stream([response.slice(0, 2), response.slice(2, 14), response.slice(14)]));
    await state.run();
    assert.equal(state.saved?.text, '主要用来做什么？包含标记```json');
    assert.equal(state.committed, 1);
    assert.equal(state.requests, 1);
    assert.equal(state.finishes, 1);
    assert.deepEqual(state.logs, []);
  });
}

for (const [label, parts, reason] of [
  ['truncated', [output.slice(0, 20)], 'length'],
  ['invalid JSON', ['{"intent":'], 'stop'],
  ['invalid schema', ['{"intent":"clarify"}'], 'stop'],
  ['unclosed fence', ['```json\n' + output], 'stop'],
  ['fenced invalid JSON', ['```json\n{"intent":\n```'], 'stop'],
  ['fenced invalid schema', ['```json\n{"intent":"clarify"}\n```'], 'stop'],
  ['commentary before fence', ['private-model-text\n```json\n' + output + '\n```'], 'stop'],
  ['commentary after fence', ['```json\n' + output + '\n```\nprivate-model-text'], 'stop'],
  ['multiple fenced objects', ['```json\n' + output + '\n```\n```json\n' + output + '\n```'], 'stop'],
  ['complete fence but truncated stream', ['```json\n' + output + '\n```'], 'length'],
] as const) {
  test(`${label} understanding fails without committing a misleading follow-up or retrying automatically`, async () => {
    const state = fixture(async () => stream([...parts], reason));
    await assert.rejects(state.run(), /MODEL_INVALID_RESPONSE/u);
    assert.equal(state.committed, 0);
    assert.equal(state.finishes, 1);
    assert.equal(state.saved, null);
    assert.equal(state.requests, 1);
    assert.deepEqual(state.thoughts, ['先看需求']);
    assert.equal(state.progressClosed, 1);
    assert.doesNotMatch(state.logs.join(''), /private-model-text|主要用来做什么/u);
  });
}

test('oversize stream with unknown request outcome cannot commit a fallback', async () => {
  const state = fixture(async () => stream(['x'.repeat(17000)]));
  await assert.rejects(state.run(), /MODEL_UNAVAILABLE/u);
  assert.equal(state.committed, 0);
  assert.equal(state.finishes, 0);
  assert.equal(state.requests, 1);
});

test('provider timeout aborts fetch and leaves no partial answer', async () => {
  let aborted = false;
  const state = fixture(async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => { aborted = true; reject(init.signal?.reason); }, { once: true });
  }), { ...environment, AI_TIMEOUT_MS: '20' });
  await assert.rejects(state.run());
  assert.equal(aborted, true);
  assert.equal(state.progressClosed, 1);
  assert.equal(state.committed, 0);
  assert.equal(state.requests, 1);
});

test('user cancellation aborts the same shared transport signal', async () => {
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const state = fixture(async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    started();
  }));
  const pending = state.run(controller.signal);
  await ready;
  controller.abort(new Error('cancelled'));
  await assert.rejects(pending, /cancelled/u);
  assert.equal(state.progressClosed, 1);
  assert.equal(state.committed, 0);
  assert.equal(state.requests, 1);
});

const recommendation = JSON.stringify({ intent: 'recommend', patch: {}, evidence: [], question: null, options: [] });

for (const [changes, validationReason] of [
  [{ extra: 'private-model-text' }, 'understanding_fields'],
  [{ patch: { purpose: 'private-model-text' } }, 'understanding_missing_evidence'],
  [{ patch: { purpose: 'private-model-text' }, evidence: [{ field: 'purpose', quote: 'private-model-text' }] }, 'understanding_evidence_quote'],
  [{ patch: { budget: { amount: 80, currency: 'CNY', basis: 'purchase' } } }, 'understanding_amount'],
  [{ patch: { requiredTags: [{ name: 'delivery', value: 'private-model-text' }] } }, 'understanding_requiredTags'],
  [{ options: ['private-model-text'] }, 'understanding_question_options'],
  [{ intent: 'clarify', question: 'https://private-model-text.invalid' }, 'understanding_unsafe_clarification'],
] as const) {
  test(`understanding diagnostics identify ${validationReason} without exposing model output`, async () => {
    const response = JSON.stringify({ ...JSON.parse(recommendation), ...changes });
    const state = fixture(async () => stream([response]));
    await assert.rejects(state.run(), /MODEL_INVALID_RESPONSE/u);
    const records = state.logs.map(line => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.equal(records[0].phase, 'understanding');
    assert.equal(records[0].validationReason, validationReason);
    assert.doesNotMatch(state.logs.join(''), /private-model-text|先看需求|帮我选商品/u);
    assert.equal(state.committed, 0);
    assert.equal(state.requests, 1);
    assert.equal(state.finishes, 1);
  });
}

for (const [label, response, validationReason] of [
  ['empty content', '', 'empty_content'],
  ['invalid JSON', '{"private-model-text":', 'invalid_json'],
  ['wrong schema', '{"selections":[]}', 'explanation_schema'],
  ['wrong selection schema', '{"selections":[{"productId":1,"evidenceIds":["unknown"]}]}', 'selection_schema'],
  ['empty evidence', '{"selections":[{"productId":"1","evidenceIds":[]}]}', 'evidence_count'],
  ['duplicate evidence', '{"selections":[{"productId":"1","evidenceIds":["private-model-text","private-model-text"]}]}', 'duplicate_evidence'],
  ['unknown product', '{"selections":[{"productId":"private-model-text","evidenceIds":["unknown"]}]}', 'unknown_product'],
  ['unknown evidence', '{"selections":[{"productId":"1","evidenceIds":["private-model-text"]}]}', 'unknown_evidence'],
] as const) {
  test(`reranking diagnostics identify ${label} without logging model text or saving a partial reply`, async () => {
    const state = fixture(async (_url, init) => {
      const input = JSON.parse(JSON.parse(String(init?.body)).messages.at(-1).content);
      return input.candidates ? stream([response]) : stream([recommendation]);
    }, environment, true);
    await assert.rejects(state.run(), /MODEL_INVALID_RESPONSE/u);
    const records = state.logs.map(line => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.equal(records[0].message, 'assistant.validation_failed');
    assert.equal(records[0].turnId, '1');
    assert.equal(records[0].phase, 'explaining');
    assert.equal(records[0].validationReason, validationReason);
    assert.doesNotMatch(state.logs.join(''), /private-model-text|先看需求|帮我选商品/u);
    assert.equal(state.committed, 0);
    assert.equal(state.requests, 2);
    assert.equal(state.progressClosed, 1);
  });
}

for (const fenced of [false, true]) {
  test(`semantic reranking uses fragmented ${fenced ? 'fenced' : 'plain'} JSON and persists one complete recommendation`, async () => {
    const state = fixture(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      assert.equal(request.stream, true);
      const input = JSON.parse(request.messages.at(-1).content);
      assert.deepEqual(request.response_format, { type: 'json_object' });
      if (!input.candidates) return stream(fenced ? ['```json\n', recommendation, '\n```'] : [recommendation]);
      assert.equal(input.candidates.length, 5);
      const response = JSON.stringify({ selections: input.candidates.slice(0, 3).map((candidate: { productId: string; evidence: Array<{ id: string }> }) => ({
        productId: candidate.productId, evidenceIds: [candidate.evidence[0]!.id],
      })) });
      return stream([...(fenced ? ['```json\n'] : []), response.slice(0, 20), response.slice(20, 70), response.slice(70), ...(fenced ? ['\n```'] : [])]);
    }, environment, true);
    await state.run();
    assert.equal(state.requests, 2);
    assert.equal(state.finishes, 2);
    assert.equal(state.committed, 1);
    assert.deepEqual(state.logs, []);
  });
}

for (const [label, parts, reason] of [
  ['truncated', ['{"selections":['], 'length'],
  ['invalid JSON', ['{"selections":'], 'stop'],
  ['invalid schema', ['{"selections":[]}'], 'stop'],
  ['invented candidate', ['{"selections":[{"productId":"invented","evidenceIds":["invented"]}]}'], 'stop'],
  ['oversize', ['x'.repeat(17000)], 'stop'],
] as const) {
  test(`semantic reranking ${label} response never persists a partial recommendation`, async () => {
    const state = fixture(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      assert.equal(request.stream, true);
      return JSON.parse(request.messages.at(-1).content).candidates ? stream([...parts], reason) : stream([recommendation]);
    }, environment, true);
    await assert.rejects(state.run());
    assert.equal(state.requests, 2);
    assert.equal(state.committed, 0);
  });
}

for (const cancel of [false, true]) {
  test(`semantic reranking ${cancel ? 'cancellation' : 'timeout'} aborts the shared stream without persistence`, async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let aborted = false;
    const state = fixture(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      assert.equal(request.stream, true);
      if (!JSON.parse(request.messages.at(-1).content).candidates) return stream([recommendation]);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { aborted = true; reject(init.signal?.reason); }, { once: true });
        started();
      });
    }, { ...environment, AI_TIMEOUT_MS: cancel ? '2000' : '20' }, true);
    const pending = state.run(controller.signal);
    await ready;
    if (cancel) controller.abort(new Error('cancelled'));
    await assert.rejects(pending);
    assert.equal(aborted, true);
    assert.equal(state.requests, 2);
    assert.equal(state.committed, 0);
  });
}

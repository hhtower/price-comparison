import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyShoppingNeeds } from '@price-comparison/catalog/assistant-contract';
import { createStreamingCall, type StreamingInput } from '../src/ai/llm-runtime.js';
import { AssistantService } from '../src/assistant/assistant.service.js';
import type { AssistantRepository } from '../src/assistant/assistant.repository.js';
import type { CatalogService } from '../src/catalog/catalog.service.js';
import type { ClaimedJob } from '../src/jobs/jobs.repository.js';

const environment = { AI_BASE_URL: 'http://model.invalid/v1', AI_API_KEY: 'local-mock', AI_TIMEOUT_MS: '200', AI_MAX_OUTPUT_BYTES: '16384' };
const output = JSON.stringify({ intent: 'clarify', patch: {}, evidence: [], question: '主要用来做什么？', options: ['工作', '学习'] });

function fixture(fetcher: typeof fetch, env = environment) {
  let committed = 0;
  let requests = 0;
  let finishes = 0;
  const repository = {
    readTurnContext: async () => ({
      snapshot: { id: '1', inputText: '帮我选商品', expectedRevision: 0 }, needs: emptyShoppingNeeds(), history: [],
      deadlineAt: new Date(Date.now() + 10_000),
    }),
    reserveModelRequest: async () => { requests++; },
    finishModelRequest: async () => { finishes++; },
    setPhase: async () => {},
    completeTurn: async () => { committed++; },
  } as unknown as AssistantRepository;
  const job: ClaimedJob = { kind: 'assistant_turn', id: 1n, attempts: 1n, claimed_by: 'test', lease_until: new Date(Date.now() + 30_000), row: { claim_token: 'claim' } };
  const service = new AssistantService(repository, {} as CatalogService, createStreamingCall(env, fetcher), 'mock');
  return { run: (signal = new AbortController().signal) => service.runTurn(job, signal), get committed() { return committed; }, get requests() { return requests; }, get finishes() { return finishes; } };
}

function stream(parts: string[], finishReason = 'stop') {
  return new Response(parts.map((content, index) => `data: ${JSON.stringify({
    id: 'r1', model: 'mock', choices: [{ index: 0, delta: { content }, ...(index === parts.length - 1 ? { finish_reason: finishReason } : {}) }],
  })}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}

test('fragmented JSON is aggregated by shared transport and committed once only after validation', async () => {
  const state = fixture(async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).stream, true);
    assert.equal(JSON.parse(String(init?.body)).max_tokens, 2048);
    return stream([output.slice(0, 8), output.slice(8, 30), output.slice(30)]);
  });
  await state.run();
  assert.equal(state.committed, 1);
  assert.equal(state.requests, 1);
  assert.equal(state.finishes, 1);
});

for (const [label, parts, reason] of [
  ['truncated', [output.slice(0, 20)], 'length'],
  ['invalid JSON', ['{"intent":'], 'stop'],
  ['invalid schema', ['{"intent":"clarify"}'], 'stop'],
  ['oversize', ['x'.repeat(17000)], 'stop'],
] as const) {
  test(`${label} output never reaches persistence and never creates a repair request`, async () => {
    const state = fixture(async () => stream([...parts], reason));
    await assert.rejects(state.run());
    assert.equal(state.committed, 0);
    assert.equal(state.requests, 1);
  });
}

test('provider timeout aborts fetch and leaves no partial answer', async () => {
  let aborted = false;
  const state = fixture(async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => { aborted = true; reject(init.signal?.reason); }, { once: true });
  }), { ...environment, AI_TIMEOUT_MS: '20' });
  await assert.rejects(state.run());
  assert.equal(aborted, true);
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
  assert.equal(state.committed, 0);
  assert.equal(state.requests, 1);
});

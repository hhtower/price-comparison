import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiWorker, createOpenAiModelCall } from '../src/ai/ai.worker.js';
import type { ParsedStandardizationResponse } from '../src/ai/ai.schemas.js';
import type { StandardizationRequest } from '../src/ai/standardization-request.js';
import type { ClaimedJob } from '../src/jobs/jobs.repository.js';

const proposals: ParsedStandardizationResponse = {
  items: [{ id: '11', status: 'classified', identity: { kind: 'existing', standardProductId: '91' },
    ruleIds: [], evidence: [{ path: 'name', quote: 'ChatGPT Plus' }], reasonCode: null, reason: 'Explicit plan' }],
  identities: [], missingIds: [],
};
const request = {
  jobId: 3n, model: 'mock', stage: 'review' as const, proposals,
  candidates: [{ id: '91', family: 'openai', product: 'chatgpt', tier: 'plus', aliases: [] }],
  inputs: [{ productId: 11n, payload: { name: 'ChatGPT Plus' }, candidateStandardProductIds: ['91'] }],
};
const environment = { AI_BASE_URL: 'https://mock.invalid/v1', AI_API_KEY: 'mock', AI_MODEL: 'mock', AI_TIMEOUT_MS: '35' };
const claimed: ClaimedJob = {
  id: 7n, kind: 'ai_batch', attempts: 1n, claimed_by: 'worker', lease_until: new Date(Date.now() + 60000),
  row: { job_id: 3n, step: 'request', claim_token: 'claim' },
};
function streamed(content: string, finish: string | null = 'stop', done = true) {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(0, 15) } }] })}\n\n`
    + `data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(15) }, finish_reason: finish }] })}\n\n`
    + (done ? 'data: [DONE]\n\n' : ''));
}
function model(fetchImpl: typeof fetch, frozen: StandardizationRequest & {
  jobId: bigint; stage: 'generate' | 'review'; proposals?: ParsedStandardizationResponse;
} = request) {
  return createOpenAiModelCall({ getBatchRequest: async () => frozen } as never, environment, fetchImpl);
}

test('review streaming returns an exact original identity or a fixed rejection without corrections', async () => {
  for (const approved of [true, false]) {
    const call = model(async (_url, init) => {
      const sent = JSON.parse(String(init?.body));
      assert.equal(sent.stream, true);
      assert.match(sent.messages[0].content, /binary judge/);
      assert.deepEqual(JSON.parse(sent.messages[1].content).proposals.items, proposals.items);
      return streamed(JSON.stringify({ items: [{ id: '11', approved }] }));
    });
    const result = await call(claimed, new AbortController().signal);
    assert.equal(result.standardizationStage, 'review');
    assert.deepEqual(result.items[0]?.review, { approved });
    assert.deepEqual(result.items[0]?.identity, approved ? proposals.items[0]!.identity : undefined);
    assert.equal(result.items[0]?.reasonCode, approved ? null : 'review_rejected');
  }
});

test('review failures use one shared reservation and never checkpoint or publish incomplete decisions', async () => {
  for (const scenario of ['invalid-json', 'wrong-bool', 'missing-id', 'truncated', 'no-finish', 'timeout', 'cancel'] as const) {
    const events: string[] = [];
    let controllerSignal: AbortSignal | undefined;
    const repository = {
      prepareBatch: async () => {},
      getBatchRequest: async () => request,
      reserveBatchRequest: async () => { events.push('reserve'); return 'reserved'; },
      recordBatchRequestOutcome: async (_id: bigint, outcome: string, metadata: any) => {
        events.push(outcome);
        if (scenario === 'invalid-json') assert.equal(metadata.responseDiagnostic.phase, 'json');
      },
      persistBatchDecision: async () => { events.push('persist'); },
      publishBatch: async () => { events.push('publish'); },
    };
    const call = createOpenAiModelCall(repository as never, environment, async (_url, init) => {
      events.push('send');
      controllerSignal = init?.signal ?? undefined;
      if (scenario === 'timeout' || scenario === 'cancel') {
        return new Response(new ReadableStream({
          start(stream) {
            init?.signal?.addEventListener('abort', () => stream.error(init.signal!.reason), { once: true });
          },
        }));
      }
      const content = scenario === 'invalid-json' ? '{broken'
        : scenario === 'wrong-bool' ? '{"items":[{"id":"11","approved":"true"}]}'
        : scenario === 'missing-id' ? '{"items":[]}' : '{"items":[{"id":"11","approved":true}]}';
      return streamed(content, scenario === 'truncated' ? 'length' : scenario === 'no-finish' ? null : 'stop', scenario !== 'no-finish');
    });
    let next: ClaimedJob | null = claimed;
    let settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    const service = {
      onSettled: () => settle(),
      claimNext: async () => { const item = next; next = null; return item; }, heartbeat: async () => {},
      complete: async () => { events.push('complete'); }, requeue: async () => {},
      fail: async (_kind: string, _id: bigint, _worker: string, _error: string, options: any) => {
        events.push('fail'); assert.equal(options.retry, false);
      },
    };
    const worker = createAiWorker(service as never, { repository: repository as never, modelCall: call });
    try {
      await worker.runOnce();
      if (scenario === 'cancel') {
        while (!controllerSignal) await new Promise(resolve => setTimeout(resolve, 1));
        worker.cancel(claimed.id);
      }
      await settled;
      assert.equal(events.filter(event => event === 'send').length, 1, scenario);
      assert.equal(events.filter(event => event === 'reserve').length, 1, scenario);
      assert.equal(events.includes('persist'), false, scenario);
      assert.equal(events.includes('publish'), false, scenario);
      assert.equal(events.includes('complete'), false, scenario);
      assert.ok(events.includes(scenario === 'timeout' || scenario === 'cancel' || scenario === 'no-finish' ? 'unknown' : 'confirmed'), scenario);
    } finally { await worker.stop(); }
  }
});

test('successful review checkpoints its vote and request outcome together without a separate confirmation', async () => {
  const events: string[] = [];
  const repository = {
    prepareBatch: async () => {}, getBatchRequest: async () => request,
    reserveBatchRequest: async () => { events.push('reserve'); return 'reserved'; },
    recordBatchRequestOutcome: async () => { events.push('separate-confirm'); },
    persistBatchDecision: async (_job: bigint, _batch: bigint, result: any, _metadata: any, _claim: any, stage: string) => {
      assert.equal(stage, 'review'); assert.deepEqual(result.items[0].review, { approved: true }); events.push('checkpoint');
    },
  };
  const call = createOpenAiModelCall(repository as never, environment, async () => streamed('{"items":[{"id":"11","approved":true}]}'));
  let next: ClaimedJob | null = claimed;
  let settle!: () => void;
  const settled = new Promise<void>(resolve => { settle = resolve; });
  const worker = createAiWorker({
    onSettled: () => settle(),
    claimNext: async () => { const item = next; next = null; return item; }, heartbeat: async () => {},
    complete: async () => { events.push('complete'); }, fail: async () => { events.push('fail'); }, requeue: async () => {},
  } as never, { repository: repository as never, modelCall: call });
  try { await worker.runOnce(); await settled; } finally { await worker.stop(); }
  assert.deepEqual(events, ['reserve', 'checkpoint', 'complete']);
});

test('generation keeps local parser and citation errors while review sends only the valid proposal', async () => {
  const frozen = {
    ...request, stage: 'generate' as const,
    candidates: [request.candidates[0]!, ...['92', '93'].map(id => ({ ...request.candidates[0]!, id }))],
    inputs: [11n, 12n, 13n, 14n].map(productId => ({
      productId, payload: { name: 'ChatGPT Plus' },
      candidateStandardProductIds: [productId === 11n ? '92' : productId === 12n ? '93' : '91'],
    })),
  };
  const raw = (id: string, candidateRef: string) => ({
    id, action: 'reuse_candidate', candidateRef, ruleIds: [],
    evidence: [{ path: 'name', quote: 'ChatGPT Plus' }], reason: 'Explicit plan',
  });
  const generate = model(async (_url, init) => {
    const sent = JSON.parse(String(init?.body));
    assert.equal(sent.stream, true);
    assert.match(sent.messages[0].content, /classify catalog offers/);
    assert.deepEqual(JSON.parse(sent.messages[1].content).items.map((item: { id: string }) => item.id), ['11', '12', '13', '14']);
    return streamed(JSON.stringify({ items: [
      { ...raw('11', 'i1c1'), ruleIds: 'malformed' },
      { ...raw('12', 'i2c1'), evidence: [{ path: 'name', quote: 'invented evidence' }] },
      raw('13', 'i3c1'),
    ] }));
  }, frozen);
  const generated = await generate(claimed, new AbortController().signal);
  assert.equal(generated.standardizationStage, 'generate');
  assert.deepEqual(generated.items.map(item => item.reasonCode), ['invalid_response', 'evidence_invalid', null]);
  assert.deepEqual(generated.missingIds, ['14']);
  assert.ok(generated.items.every(item => !Object.hasOwn(item, 'review')));
  const before = structuredClone(generated);
  for (const approved of [true, false]) {
    const review = model(async (_url, init) => {
      const sent = JSON.parse(String(init?.body));
      assert.equal(sent.stream, true);
      assert.match(sent.messages[0].content, /binary judge/);
      const body = JSON.parse(sent.messages[1].content);
      assert.deepEqual(body.inputs.map((input: { id: string }) => input.id), ['13']);
      assert.deepEqual(body.proposals.items, [generated.items[2]]);
      assert.deepEqual(body.candidates, [request.candidates[0]]);
      return streamed(JSON.stringify({ items: [{ id: '13', approved }] }));
    }, { ...frozen, stage: 'review', proposals: generated });
    const result = await review(claimed, new AbortController().signal);
    assert.equal(result.standardizationStage, 'review');
    assert.deepEqual(result.items.slice(0, 2), generated.items.slice(0, 2));
    assert.ok(result.items.slice(0, 2).every(item => !Object.hasOwn(item, 'review')));
    assert.deepEqual(result.items[2]!.review, { approved });
    assert.equal(result.items[2]!.reasonCode, approved ? null : 'review_rejected');
    assert.deepEqual(result.missingIds, ['14']);
  }
  assert.deepEqual(generated, before);
});

test('review never revalidates or rewrites a frozen local error as a new evidence error', async () => {
  const local: ParsedStandardizationResponse['items'][number] = {
    id: '12', status: 'unclassified', reasonCode: 'invalid_response', reason: 'Original local parser error',
    evidence: [{ path: 'missing.path', quote: 'unparsed source claim' }], ruleIds: [],
    diagnostic: { stage: 'schema', code: 'invalid_type', itemId: '12' },
  };
  const frozen = {
    ...request,
    inputs: [...request.inputs, { productId: 12n, payload: { name: 'Local error input' }, candidateStandardProductIds: [] }],
    proposals: { ...proposals, items: [...proposals.items, local] },
  };
  const call = model(async (_url, init) => {
    const body = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    assert.deepEqual(body.inputs.map((input: { id: string }) => input.id), ['11']);
    assert.deepEqual(body.proposals.items, proposals.items);
    return streamed('{"items":[{"id":"11","approved":false}]}');
  }, frozen);
  const result = await call(claimed, new AbortController().signal);
  assert.deepEqual(result.items[1], local);
  assert.equal(Object.hasOwn(result.items[1]!, 'review'), false);
  assert.equal(result.items[0]!.reasonCode, 'review_rejected');
});

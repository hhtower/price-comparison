import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiWorker, createOpenAiModelCall } from '../src/ai/ai.worker.js';
import { parseStandardizationProtocolResponse, standardizationProposal } from '../src/ai/ai.schemas.js';
import type { ParsedStandardizationResponse } from '../src/ai/ai.schemas.js';
import { buildStandardizationRequest, type StandardizationRequest } from '../src/ai/standardization-request.js';
import type { ClaimedJob } from '../src/jobs/jobs.repository.js';

const proposals = parseStandardizationProtocolResponse({
  items: [{ id: '11', standardProductId: '91', nullReason: null, evidence: [{ path: 'name', quote: 'ChatGPT Plus' }] }],
}, [{ id: '11', candidateStandardProductIds: ['91'] }]);
const request = {
  jobId: 3n, model: 'mock', stage: 'review' as const, proposals,
  candidates: [{ id: '91', family: 'openai', product: 'chatgpt', tier: 'plus', aliases: [] }],
  inputs: [{ productId: 11n, payload: { name: 'ChatGPT Plus' }, candidateStandardProductIds: ['91'] }],
};
const environment = { AI_BASE_URL: 'https://mock.invalid/v1', AI_API_KEY: 'mock', AI_MODEL: 'mock', AI_TIMEOUT_MS: '35' };
const vote = (approved: boolean) => ({
  id: '11', approved, code: approved ? null : 'source_conflict',
  evidence: approved ? [] : [{ path: 'name', quote: 'ChatGPT Plus' }],
});
const review = (approved: boolean, source = proposals) => {
  const { id: _id, ...feedback } = vote(approved);
  return { ...feedback, proposal: standardizationProposal(source.items[0]!) };
};
const claimed: ClaimedJob = {
  id: 7n, kind: 'ai_batch', attempts: 1n, claimed_by: 'worker', lease_until: new Date(Date.now() + 60000),
  row: { job_id: 3n, job_type: 'manual_full', step: 'request', claim_token: 'claim' },
};
function streamed(content: string, finish: string | null = 'stop', done = true) {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(0, 15) } }] })}\n\n`
    + `data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(15) }, finish_reason: finish }] })}\n\n`
    + (done ? 'data: [DONE]\n\n' : ''));
}
function model(fetchImpl: typeof fetch, frozen: StandardizationRequest & {
  jobId: bigint; stage: 'generate' | 'review' | 'repair'; proposals?: ParsedStandardizationResponse;
} = request) {
  return createOpenAiModelCall({ getBatchRequest: async () => frozen } as never, environment, fetchImpl);
}

test('review streaming returns an exact original identity or a fixed rejection without corrections', async () => {
  for (const approved of [true, false]) {
    const call = model(async (_url, init) => {
      const sent = JSON.parse(String(init?.body));
      assert.equal(sent.stream, true);
      assert.match(sent.messages[0].content, /binary judge/);
      assert.deepEqual(JSON.parse(sent.messages[1].content).proposals.items, [
        { id: '11', standardProductId: '91', nullReason: null, evidence: [{ path: 'name', quote: 'ChatGPT Plus' }] },
      ]);
      return streamed(JSON.stringify({ items: [vote(approved)] }));
    });
    const result = await call(claimed, new AbortController().signal);
    assert.equal(result.reviewStage, 'review');
    assert.deepEqual(result.items[0]?.review, review(approved));
    assert.deepEqual(result.items[0]?.identity, approved ? proposals.items[0]!.identity : undefined);
    assert.equal(result.items[0]?.reasonCode, approved ? null : 'review_rejected');
    assert.deepEqual(result.items[0]?.evidence, proposals.items[0]!.evidence);
    assert.equal(Object.hasOwn(result, 'identities'), false);
  }
});

test('review failures use one shared reservation and never checkpoint or publish incomplete decisions', async () => {
  for (const scenario of ['invalid-json', 'wrong-bool', 'extra-field', 'missing-id', 'duplicate-id', 'unknown-id',
    'bogus-citation', 'approved-feedback', 'legacy-vote', 'truncated', 'no-finish', 'timeout', 'cancel'] as const) {
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
      const content = scenario === 'invalid-json' ? '{broken' : JSON.stringify({
        items: scenario === 'missing-id' ? [] : scenario === 'duplicate-id' ? [vote(true), vote(false)] : [
          scenario === 'wrong-bool' ? { ...vote(true), approved: 'true' }
            : scenario === 'extra-field' ? { ...vote(true), reason: 'model reason' }
            : scenario === 'unknown-id' ? { ...vote(true), id: '999' }
            : scenario === 'bogus-citation' ? { ...vote(false), evidence: [{ path: 'name', quote: 'invented' }] }
            : scenario === 'approved-feedback' ? { ...vote(false), approved: true }
            : scenario === 'legacy-vote' ? { id: '11', approved: true } : vote(true),
        ],
      });
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
      assert.equal(stage, 'review'); assert.deepEqual(result.items[0].review, review(true)); events.push('checkpoint');
    },
  };
  const call = createOpenAiModelCall(repository as never, environment, async () => streamed(JSON.stringify({ items: [vote(true)] })));
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

for (const stage of ['generate', 'repair'] as const) {
test(`${stage} failures reject the whole batch without checkpoints, publication or missing-item retries`, async () => {
  const frozen = {
    ...request, stage,
    inputs: [11n, 12n].map(productId => ({
      productId, payload: { name: 'ChatGPT Plus' }, candidateStandardProductIds: ['91'],
      previousDecision: { reason: 'private old history' },
    })),
  };
  const item = (id: string) => ({ id, standardProductId: '91', nullReason: null, evidence: [{ path: 'name', quote: 'ChatGPT Plus' }] });
  for (const scenario of ['schema', 'evidence', 'missing-id', 'candidate', 'history', 'truncated', 'no-finish', 'timeout', 'cancel'] as const) {
    const events: string[] = [];
    let signal: AbortSignal | undefined;
    const repository = {
      prepareBatch: async () => {}, getBatchRequest: async () => frozen,
      reserveBatchRequest: async () => { events.push('reserve'); return 'reserved'; },
      recordBatchRequestOutcome: async (_id: bigint, outcome: string) => { events.push(outcome); },
      persistBatchDecision: async () => { events.push('persist'); },
      publishBatch: async () => { events.push('publish'); },
    };
    const call = createOpenAiModelCall(repository as never, environment, async (_url, init) => {
      events.push('send'); signal = init?.signal ?? undefined;
      const sent = JSON.parse(String(init?.body));
      assert.equal(sent.stream, true);
      assert.doesNotMatch(sent.messages[1].content, /private old history|historyContext|candidateRefs/);
      if (scenario === 'timeout' || scenario === 'cancel') return new Response(new ReadableStream({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ delta: { content: '{"items":[' } }] }) + '\n\n'));
          signal!.addEventListener('abort', () => stream.error(signal!.reason), { once: true });
        },
      }));
      const invalid = scenario === 'schema' ? { ...item('12'), ruleIds: [] }
        : scenario === 'candidate' ? { ...item('12'), standardProductId: '999' }
        : scenario === 'history' ? { ...item('12'), evidence: [{ path: 'historyContext.reason', quote: 'private old history' }] }
        : { ...item('12'), evidence: [{ path: 'name', quote: 'invented evidence' }] };
      return streamed(JSON.stringify({ items: scenario === 'missing-id' ? [item('11')]
        : scenario === 'truncated' || scenario === 'no-finish' ? [item('11'), item('12')] : [item('11'), invalid] }),
      scenario === 'truncated' ? 'length' : scenario === 'no-finish' ? null : 'stop', scenario !== 'no-finish');
    });
    let next: ClaimedJob | null = claimed;
    let settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    const worker = createAiWorker({
      onSettled: () => settle(),
      claimNext: async () => { const item = next; next = null; return item; }, heartbeat: async () => {},
      complete: async () => { events.push('complete'); }, requeue: async () => { events.push('requeue'); },
      fail: async (_kind: string, _id: bigint, _worker: string, _error: string, options: any) => {
        events.push('fail'); assert.equal(options.retry, false);
      },
    } as never, { repository: repository as never, modelCall: call });
    try {
      await worker.runOnce();
      if (scenario === 'cancel') {
        while (!signal) await new Promise(resolve => setTimeout(resolve, 1));
        worker.cancel(claimed.id);
      }
      await settled;
      assert.deepEqual(events, ['reserve', 'send', scenario === 'timeout' || scenario === 'cancel' || scenario === 'no-finish' ? 'unknown' : 'confirmed',
        scenario === 'cancel' ? 'requeue' : 'fail'], scenario);
    } finally { await worker.stop(); }
  }
});
}

test('standardization correction uses the generation prompt and preserves repair through the worker checkpoint', async () => {
  const events: string[] = [];
  const frozen = { ...request, stage: 'repair' as const };
  const repository = {
    prepareBatch: async () => {}, getBatchRequest: async () => frozen,
    reserveBatchRequest: async () => { events.push('reserve'); return 'reserved'; },
    recordBatchRequestOutcome: async () => assert.fail('successful correction confirms atomically'),
    persistBatchDecision: async (_job: bigint, _batch: bigint, result: any, _metadata: any, claim: unknown, stage: string) => {
      assert.equal(stage, 'repair');
      assert.equal(result.reviewStage, 'repair');
      assert.deepEqual(claim, { workerId: 'worker', attempt: 1n, token: 'claim' });
      assert.deepEqual(result.items, proposals.items);
      events.push('checkpoint');
    },
  };
  const call = createOpenAiModelCall(repository as never, environment, async (_url, init) => {
    const sent = JSON.parse(String(init?.body));
    assert.equal(sent.stream, true);
    assert.deepEqual(sent.messages, buildStandardizationRequest(frozen).messages);
    events.push('send');
    return streamed(JSON.stringify({ items: [
      { id: '11', standardProductId: '91', nullReason: null, evidence: [{ path: 'name', quote: 'ChatGPT Plus' }] },
    ] }));
  });
  let next: ClaimedJob | null = claimed;
  const settled = Promise.withResolvers<void>();
  const worker = createAiWorker({
    claimNext: async () => { const item = next; next = null; return item; },
    heartbeat: async () => {}, requeue: async () => assert.fail('correction must not requeue'),
    complete: async () => { events.push('complete'); }, fail: async () => { events.push('fail'); },
    onSettled: () => settled.resolve(),
  } as never, { repository: repository as never, modelCall: call });
  try { await worker.runOnce(); await settled.promise; } finally { await worker.stop(); }
  assert.deepEqual(events, ['reserve', 'send', 'checkpoint', 'complete']);
});

test('review judges unmatched proposals without creating identities and retains their evidence', async () => {
  const unmatched = parseStandardizationProtocolResponse({
    items: [{ id: '11', standardProductId: null, nullReason: 'insufficient_source', evidence: proposals.items[0]!.evidence }],
  }, [{ id: '11', candidateStandardProductIds: ['91'] }]);
  for (const approved of [true, false]) {
    const call = model(async (_url, init) => {
      const body = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      assert.deepEqual(body.inputs.map((input: { id: string }) => input.id), ['11']);
      assert.deepEqual(body.proposals.items, [
        { id: '11', standardProductId: null, nullReason: 'insufficient_source', evidence: [{ path: 'name', quote: 'ChatGPT Plus' }] },
      ]);
      return streamed(JSON.stringify({ items: [vote(approved)] }));
    }, { ...request, proposals: unmatched });
    const result = await call(claimed, new AbortController().signal);
    assert.equal(result.items[0]?.status, 'unclassified');
    assert.equal(result.items[0]?.reasonCode, approved ? 'insufficient_source' : 'review_rejected');
    assert.equal(result.items[0]?.identity, undefined);
    assert.deepEqual(result.items[0]?.evidence, unmatched.items[0]!.evidence);
    assert.deepEqual(result.items[0]?.review, review(approved, unmatched));
  }
});

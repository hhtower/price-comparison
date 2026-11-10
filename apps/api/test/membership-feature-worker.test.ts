import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiWorker, createOpenAiModelCall } from '../src/ai/ai.worker.js';
import type { ClaimedJob } from '../src/jobs/jobs.repository.js';
import { MEMBERSHIP_FEATURE_REVIEW_PROMPT, type MembershipFeatureResponse } from '../src/ai/membership-feature-request.js';
import type { TagReviewResponse } from '../src/ai/tag-review-request.js';

const payload = { id: '11', name: 'ChatGPT Plus', spec: '商家账号，订阅1个月，质保28天。' };
const tags = [
  { name: 'delivery', value: 'account', path: 'spec', quote: '商家账号' },
  { name: 'duration', value: '1 month', path: 'spec', quote: '订阅1个月' },
  { name: 'warranty_days', value: '28', path: 'spec', quote: '质保28天' },
];
const proposals = { items: [{ id: '11', membershipKind: 'account', tags }] };
const environment = { AI_BASE_URL: 'http://model.invalid/v1', AI_API_KEY: 'local-mock', AI_MODEL: 'configured', AI_TIMEOUT_MS: '1000' };
const claimed = (step = 'request'): ClaimedJob => ({
  kind: 'ai_batch', id: 7n, attempts: 1n, claimed_by: 'worker',
  lease_until: new Date(Date.now() + 60_000),
  row: { job_id: 3n, job_type: 'membership_features', step, claim_token: 'claim' },
});

function response(output: unknown, finishReason = 'stop') {
  const content = typeof output === 'string' ? output : JSON.stringify(output);
  return new Response([content.slice(0, 17), content.slice(17)].map((part, index) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content: part }, ...(index ? { finish_reason: finishReason } : {}) }] })}\n\n`).join('')
    + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}

function repository(stage: 'extract' | 'review' = 'extract', proposed = proposals, currentPayload = payload) {
  return {
    getBatchRequest: async () => assert.fail('membership facts must not query identity candidates'),
    getTagExtractionBatchInputs: async () => ({
      jobId: 3n, model: 'frozen-model', stage, ...(stage === 'review' ? { proposals: proposed } : {}),
      inputs: [{ productId: 11n, name: currentPayload.name, spec: currentPayload.spec, sourceData: {}, payload: currentPayload }],
    }),
  };
}

test('membership extraction selects its dedicated prompt and aggregates streamed facts without assigning identity', async () => {
  const call = createOpenAiModelCall(repository() as never, environment, async (_url, init) => {
    const sent = JSON.parse(String(init?.body));
    assert.equal(sent.stream, true);
    assert.equal(sent.model, 'frozen-model');
    assert.match(sent.messages[0].content, /membership_features/u);
    assert.doesNotMatch(sent.messages[0].content, /supported_client|sms_verification|candidateRef/u);
    return response(proposals);
  });
  const result = await call(claimed(), new AbortController().signal);
  assert.equal(result.tagExtractionStage, 'extract');
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.identities, []);
  assert.deepEqual(result.tagExtractionItems?.[0]?.tags, tags.map(({ path, quote, ...tag }) =>
    ({ ...tag, evidence: [{ path, quote }] })));
  assert.equal(result.metadata?.responseDiagnostic.code, 'accepted');
});

test('membership review retains binary proposal order and current citations through the shared validator', async () => {
  const call = createOpenAiModelCall(repository('review') as never, environment, async (_url, init) => {
    const sent = JSON.parse(String(init?.body));
    assert.equal(sent.stream, true);
    assert.deepEqual(JSON.parse(sent.messages[1].content).proposals, proposals);
    return response({ items: [{ id: '11', decisions: [true, true, false], classificationDecision: true, textReview: null }] });
  });
  const result = await call(claimed(), new AbortController().signal);
  assert.equal(result.tagExtractionStage, 'review');
  assert.deepEqual(result.tagExtractionItems?.[0]?.tags.map(tag => tag.name), ['delivery', 'duration']);
  assert.deepEqual(result.tagExtractionItems?.[0]?.reviewDecisions, [true, true, false]);
  assert.equal(result.tagExtractionItems?.[0]?.membershipKind, 'account');
  assert.equal(result.tagExtractionItems?.[0]?.classificationReviewed, true);
  assert.equal(result.tagExtractionItems?.[0]?.rejectedTags[0]?.reasonCode, 'review_rejected');
});

test('membership review prompt examples preserve independent fact and category verdicts through streaming validation', async () => {
  const blocks = [...MEMBERSHIP_FEATURE_REVIEW_PROMPT.matchAll(/```json\n([\s\S]*?)\n```/gu)];
  assert.equal(blocks.length, 2);
  const { inputs, proposals: proposed } = JSON.parse(blocks[0]![1]!) as {
    inputs: Array<typeof payload>; proposals: MembershipFeatureResponse;
  };
  const output = JSON.parse(blocks[1]![1]!) as TagReviewResponse;
  const call = createOpenAiModelCall({
    ...repository('review'),
    getTagExtractionBatchInputs: async () => ({
      jobId: 3n, model: 'frozen-model', stage: 'review', proposals: proposed,
      inputs: inputs.map(input => ({ productId: BigInt(input.id), name: input.name, spec: input.spec, sourceData: {}, payload: input })),
    }),
  } as never, environment, async () => response(output));
  const result = await call(claimed(), new AbortController().signal);
  assert.deepEqual(result.tagExtractionItems?.map(item => ({
    id: String(item.productId), approved: item.classificationReviewed,
    decisions: item.reviewDecisions, rejected: item.rejectedTags.map(tag => tag.name),
  })), [
    { id: '301', approved: false, decisions: [true, false, false, true], rejected: ['access', 'rental'] },
    { id: '302', approved: false, decisions: [true, true, true, true], rejected: [] },
    { id: '303', approved: true, decisions: [true, true], rejected: [] },
    { id: '304', approved: true, decisions: [true, false, true], rejected: ['duration'] },
  ]);
});

test('rental and shared facts survive complete streaming and binary review with real citations', async () => {
  const current = { ...payload, spec: '租用账号，多人共享' };
  const proposed = { items: [{ id: '11', membershipKind: 'rental' as const, tags: [
    { name: 'rental', value: '有', path: 'spec', quote: '租用账号' },
    { name: 'access', value: 'shared', path: 'spec', quote: '多人共享' },
  ] }] };
  for (const stage of ['extract', 'review'] as const) {
    const call = createOpenAiModelCall(repository(stage, proposed, current) as never, environment, async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).stream, true);
      return response(stage === 'extract' ? { items: [{ id: '11', membershipKind: 'rental', tags: proposed.items[0]!.tags }] }
        : { items: [{ id: '11', decisions: [true, true], classificationDecision: true, textReview: null }] });
    });
    const result = await call(claimed(), new AbortController().signal);
    assert.deepEqual(result.tagExtractionItems?.[0]?.tags.map(tag => ({ name: tag.name, value: tag.value })),
      [{ name: 'rental', value: '有' }, { name: 'access', value: 'shared' }]);
    assert.deepEqual(result.tagExtractionItems?.[0]?.rejectedTags, []);
    assert.equal(result.tagExtractionItems?.[0]?.membershipKind, 'rental');
  }
});

test('successful membership extraction with no stated facts does not invent a period or classification', async () => {
  const call = createOpenAiModelCall(repository() as never, environment,
    async () => response({ items: [{ id: '11', membershipKind: 'short_term', tags: [] }] }));
  const result = await call(claimed(), new AbortController().signal);
  assert.deepEqual(result.tagExtractionItems, [{ productId: 11n, tags: [], rejectedTags: [], membershipKind: 'short_term' }]);
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.identities, []);
});

test('membership review cannot approve fabricated citations or omit a binary vote', async () => {
  const proposed = { items: [{ id: '11', membershipKind: 'account' as const, tags: [{ ...tags[0]!, quote: '不存在的商家承诺' }] }] };
  const call = createOpenAiModelCall(repository('review', proposed) as never, environment,
    async () => response({ items: [{ id: '11', decisions: [true], classificationDecision: true, textReview: null }] }));
  const result = await call(claimed(), new AbortController().signal);
  assert.equal(result.tagExtractionItems?.[0]?.tags.length, 0);
  assert.equal(result.tagExtractionItems?.[0]?.rejectedTags.length, 1);
  const rejectedClassification = createOpenAiModelCall(repository('review') as never, environment,
    async () => response({ items: [{ id: '11', decisions: [true, true, true], classificationDecision: false, textReview: null }] }));
  const rejectedResult = await rejectedClassification(claimed(), new AbortController().signal);
  assert.equal(rejectedResult.tagExtractionItems?.[0]?.classificationReviewed, false);
  const missingVote = createOpenAiModelCall(repository('review') as never, environment,
    async () => response({ items: [{ id: '11', decisions: [true], textReview: null }] }));
  await assert.rejects(missingVote(claimed(), new AbortController().signal), {
    retryClass: 'invalid_response', retryable: false, requestOutcome: 'confirmed',
  });
});

test('membership extraction rejects invalid, truncated, unknown-ID and out-of-scope responses', async () => {
  for (const [output, finish] of [
    ['{', 'stop'],
    [proposals, 'length'],
    [{ items: [{ id: '99', tags }] }, 'stop'],
    [{ items: [{ id: '11', tags: [{ name: 'renewable', value: '有', path: 'spec', quote: '商家账号' }] }] }, 'stop'],
    [{ items: [{ id: '11', tags, membershipKind: 'invalid' }] }, 'stop'],
  ] as const) {
    const call = createOpenAiModelCall(repository() as never, environment, async () => response(output, finish));
    await assert.rejects(call(claimed(), new AbortController().signal), (error: any) => {
      assert.equal(error.retryClass, 'invalid_response');
      assert.equal(error.retryable, false);
      assert.equal(error.requestOutcome, 'confirmed');
      return true;
    });
  }
});

test('membership review refuses out-of-scope proposals before sending a provider request', async () => {
  let sends = 0;
  const proposed = { items: [{ id: '11', tags: [{ name: 'renewable', value: '有', path: 'spec', quote: '订阅1个月' }] }] };
  const call = createOpenAiModelCall(repository('review', proposed) as never, environment,
    async () => { sends++; return response({ items: [] }); });
  await assert.rejects(call.prepare!(claimed(), new AbortController().signal), /scope|membership/i);
  assert.equal(sends, 0);
});

test('membership request preflight rejects oversized current evidence before sending', async () => {
  let sends = 0;
  const call = createOpenAiModelCall(repository() as never, { ...environment, AI_REQUEST_MAX_BYTES: '1' },
    async () => { sends++; return response(proposals); });
  await assert.rejects(call.prepare!(claimed(), new AbortController().signal), /limit|budget|large|bytes|超/u);
  assert.equal(sends, 0);
});

test('membership streams share whole-response timeouts and caller cancellation', async () => {
  for (const cancellation of [false, true]) {
    const controller = new AbortController();
    let sent!: () => void;
    const started = new Promise<void>(resolve => { sent = resolve; });
    let aborted = false;
    const call = createOpenAiModelCall(repository() as never,
      { ...environment, AI_TIMEOUT_MS: cancellation ? '1000' : '30' }, async (_url, init) => {
        sent();
        return new Response(new ReadableStream({
          start(stream) {
            stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"{"}}]}\n\n'));
            init!.signal!.addEventListener('abort', () => {
              aborted = true; stream.error(init!.signal!.reason);
            }, { once: true });
          },
        }), { headers: { 'content-type': 'text/event-stream' } });
      });
    const running = call(claimed(), controller.signal);
    const rejected = assert.rejects(running, cancellation ? /cancelled/u : /timed out/iu);
    await started;
    if (cancellation) controller.abort(new Error('cancelled'));
    await rejected;
    assert.equal(aborted, true);
  }
});

test('membership worker checkpoints only complete results and publishes through the existing attribute methods', async () => {
  for (const step of ['request', 'publish', 'invalid'] as const) {
    const job = claimed(step === 'publish' ? 'publish' : 'request');
    const events: string[] = [];
    let settled!: () => void;
    const done = new Promise<void>(resolve => { settled = resolve; });
    let pending: ClaimedJob | null = job;
    const service = {
      claimNext: async () => { const result = pending; pending = null; return result; },
      heartbeat: async () => {}, complete: async () => { events.push('complete'); },
      fail: async () => { events.push('fail'); }, requeue: async () => assert.fail('no private retry'),
      onSettled: settled,
    };
    const repo = {
      ...repository(), prepareBatch: async () => {},
      reserveBatchRequest: async () => { events.push('reserve'); return 'reserved'; },
      recordBatchRequestOutcome: async (_id: bigint, outcome: string) => { events.push(outcome); },
      checkpointTagExtractionBatchDecision: async (_job: bigint, _batch: bigint, items: unknown[], _metadata: unknown, _claim: unknown, stage: string) => {
        assert.equal(stage, 'extract'); assert.equal(items.length, 1); events.push('checkpoint');
      },
      publishTagExtractionBatch: async () => { events.push('publish'); },
      publishBatch: async () => assert.fail('membership features must not publish identities'),
    };
    const call = createOpenAiModelCall(repo as never, environment, async () => {
      events.push('send'); return response(proposals, step === 'invalid' ? 'length' : 'stop');
    });
    const worker = createAiWorker(service as never, { repository: repo as never, modelCall: call, workerId: 'worker', maxRetries: 0 });
    try {
      await worker.runOnce();
      await done;
      assert.deepEqual(events, step === 'publish' ? ['publish', 'complete'] : step === 'invalid'
        ? ['reserve', 'send', 'confirmed', 'fail'] : ['reserve', 'send', 'checkpoint', 'complete']);
    } finally { await worker.stop(); }
  }
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createAiWorker, createOpenAiModelCall } from '../src/ai/ai.worker.js';
import type { AiBatchResultMetadata } from '../src/ai/ai.repository.js';

const job = { id: 7n, attempts: 1n, claimed_by: 'tag-audit-worker', lease_until: new Date(Date.now() + 60000),
  row: { job_id: 3n, job_type: 'tag_extraction', step: 'request', claim_token: 'tag-audit-claim' } };
const inputs = [
  { productId: 11n, name: 'Private listing', spec: '1\u4e2a\u6708', sourceData: null },
  { productId: 12n, name: 'Other listing', spec: null, sourceData: null },
];

function setup(content: string, finishReason: string | null = 'stop', auditUnavailable = false, throwingLogger = false,
  reviewProposals?: Array<{ name: string; value: string; path: string; quote: string }>) {
  const outcomes: Array<{ outcome: unknown; metadata?: AiBatchResultMetadata; claim: unknown }> = [];
  const events: unknown[][] = [];
  let sends = 0, saved: unknown, savedMetadata: AiBatchResultMetadata | undefined, failure: unknown, completed = false;
  const repository = {
    prepareBatch: async () => undefined,
    reserveBatchRequest: async () => 'reserved',
    getTagExtractionBatchInputs: async () => ({ jobId: 3n, model: 'mock', inputs,
      ...(reviewProposals ? { stage: 'review', proposals: { items: [{ id: '11', tags: reviewProposals }, { id: '12', tags: [] }] } } : {}) }),
    recordBatchRequestOutcome: async (_id: bigint, outcome: unknown, metadata: AiBatchResultMetadata | undefined, claim: unknown) => {
      if (auditUnavailable) throw new Error('audit unavailable');
      outcomes.push({ outcome, metadata, claim });
    },
    checkpointTagExtractionBatchDecision: async (_job: bigint, _batch: bigint, decision: unknown, metadata: AiBatchResultMetadata | undefined, claim: unknown) => {
      saved = decision; savedMetadata = metadata;
      outcomes.push({ outcome: 'confirmed', metadata, claim });
    },
    persistBatchDecision: async () => assert.fail('tag responses must not persist identity decisions'),
  };
  const modelCall = createOpenAiModelCall(repository as never, {
    AI_BASE_URL: 'https://mock.invalid/v1', AI_API_KEY: 'private-key', AI_MODEL: 'mock',
  }, async (_url, init) => {
    sends++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.stream, true);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.deepEqual(body.stream_options, { include_usage: true });
    return new Response([
      { id: 'resp-tag', model: 'actual-model', choices: [{ delta: { content: content.slice(0, 3) } }] },
      { id: 'resp-tag', model: 'actual-model', choices: [{ delta: { content: content.slice(3) }, finish_reason: finishReason }] },
      { id: 'resp-tag', model: 'actual-model', choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } },
    ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n');
  }, { log: (...args: unknown[]) => {
    events.push(args);
    if (throwingLogger && args[0] === 'ai.validation_failed') throw new Error('audit logger unavailable');
  } });
  let pending: typeof job | null = job;
  const settled = Promise.withResolvers<void>();
  const worker = createAiWorker({
    claimNext: async () => { const claimed = pending; pending = null; return claimed; },
    heartbeat: async () => undefined,
    complete: async () => { completed = true; },
    fail: async (_kind: unknown, _id: unknown, _worker: unknown, message: string, options: unknown) => { failure = { message, options }; },
    requeue: async () => assert.fail('completed responses must not be requeued'),
    onSettled: () => settled.resolve(),
  } as never, { repository: repository as never, modelCall });
  return {
    modelCall, events, outcomes,
    stats: () => ({ sends, saved, savedMetadata, failure, completed }),
    run: async () => { try { await worker.runOnce(); await settled.promise; } finally { await worker.stop(); } },
  };
}

function assertProvenance(metadata: AiBatchResultMetadata | undefined, content: string) {
  assert.ok(metadata?.responseDiagnostic, 'tag response must retain shared audit metadata');
  assert.equal(metadata.responseId, 'resp-tag');
  assert.equal(metadata.responseModel, 'actual-model');
  assert.deepEqual(metadata.usage, { promptTokens: 10, completionTokens: 20, totalTokens: 30 });
  assert.equal(typeof metadata.responseMs, 'number');
  assert.equal(typeof metadata.firstContentMs, 'number');
  const diagnostic = metadata.responseDiagnostic;
  assert.equal(diagnostic.contentSha256, createHash('sha256').update(content).digest('hex'));
  assert.equal(diagnostic.outputBytes, Buffer.byteLength(content));
  assert.equal(diagnostic.chunkCount, 3);
  assert.equal(diagnostic.contentChunks, 2);
  assert.equal(diagnostic.inputCount, 2);
  assert.equal(diagnostic.finishReason, 'stop');
  assert.doesNotMatch(JSON.stringify(metadata), /Private listing|private-response|private-key|\u4e2a\u6708/);
  return diagnostic;
}

test('successful tag streams persist response provenance and counts with the decision', { timeout: 5000 }, async () => {
  const tag = { name: 'duration', value: '1 month', path: 'spec', quote: '1\u4e2a\u6708' };
  const content = JSON.stringify({ items: [{ id: '11', tags: [tag] }, { id: '12', tags: [] }] });
  const state = setup(content);
  await state.run();
  assert.equal(state.stats().completed, true);
  assert.equal(state.stats().failure, undefined);
  assert.equal(state.stats().sends, 1);
  assert.deepEqual(state.stats().saved, [
    { productId: 11n, tags: [{ name: 'duration', value: '1 month', evidence: [{ path: 'spec', quote: '1\u4e2a\u6708' }] }], rejectedTags: [] },
    { productId: 12n, tags: [], rejectedTags: [] },
  ]);
  const diagnostic = assertProvenance(state.outcomes[0]!.metadata, content);
  assert.equal(diagnostic.phase, 'evidence');
  assert.equal(diagnostic.code, 'accepted');
  assert.equal(diagnostic.returnedItemCount, 2);
  assert.equal(diagnostic.missingItemCount, 0);
  assert.deepEqual(state.stats().savedMetadata, state.outcomes[0]!.metadata);
});

test('partial extraction responses retain provenance and fail without inventing empty decisions', { timeout: 5000 }, async () => {
  const content = '{"items":[{"id":"11","tags":[]}]}';
  const state = setup(content);
  await state.run();
  const diagnostic = assertProvenance(state.outcomes[0]!.metadata, content);
  assert.equal(diagnostic.code, 'invalid_response');
  assert.equal(state.stats().saved, undefined);
  assert.ok(state.stats().failure);
});

test('review rejection counts measure affected items while preserving accepted facts', { timeout: 5000 }, async () => {
  const tags = [
    { name: 'duration', value: '1 month', path: 'spec', quote: '1\u4e2a\u6708' },
    { name: 'private-response', value: 'yes', path: 'spec', quote: 'private-response' },
    { name: 'another-private-response', value: 'yes', path: 'spec', quote: 'private-response' },
  ];
    const content = JSON.stringify({ items: [
      { id: '11', decisions: [true, false, false], textReview: null },
      { id: '12', decisions: [], textReview: null },
    ] });
    const state = setup(content, 'stop', false, false, tags);
    await state.run();
    assert.equal(state.stats().completed, true);
    assert.equal(state.stats().sends, 1);
    const diagnostic = assertProvenance(state.outcomes[0]!.metadata, content);
    assert.equal(diagnostic.returnedItemCount, 2);
    assert.equal(diagnostic.missingItemCount, 0);
    assert.equal(diagnostic.rejectedItemCount, 1, 'two rejected tags on one product count as one affected item');
    assert.equal(diagnostic.code, 'items_rejected');
    const saved = state.stats().saved as Array<{ tags: unknown[]; rejectedTags: unknown[] }>;
    assert.equal(saved[0]!.tags.length, 1);
    assert.equal(saved[0]!.rejectedTags.length, 2);
});

for (const [name, content, phase] of [
  ['JSON', '{"private-response":', 'json'],
  ['items type', '{"items":"private-response"}', 'schema'],
  ['root keys', '{"items":[],"private-response":true}', 'schema'],
  ['tag fields', '{"items":[{"id":"11","tags":[{"name":"duration","value":"1 month","path":"spec","quote":""}]}]}', 'schema'],
  ['extra tag keys', '{"items":[{"id":"11","tags":[{"name":"duration","value":"1 month","path":"spec","quote":"private-response","extra":true}]}]}', 'schema'],
  ['duplicate IDs', '{"items":[{"id":"11","tags":[]},{"id":"11","tags":[]}]}', 'schema'],
  ['unknown IDs', '{"items":[{"id":"99","tags":[]}]}', 'schema'],
  ['unsafe IDs', '{"items":[{"id":"0","tags":[]}]}', 'schema'],
] as const) {
  test(`invalid tag ${name} retains completed response provenance without saving or retrying`, { timeout: 5000 }, async () => {
    const state = setup(content);
    await state.run();
    assert.equal(state.stats().sends, 1);
    assert.equal(state.stats().saved, undefined);
    assert.equal(state.stats().completed, false);
    assert.deepEqual((state.stats().failure as { options: unknown }).options, { retry: false, backoffMs: 0, retryClass: 'invalid_response' });
    assert.equal(state.outcomes.length, 1);
    assert.equal(state.outcomes[0]!.outcome, 'confirmed');
    assert.deepEqual(state.outcomes[0]!.claim, { workerId: 'tag-audit-worker', attempt: 1n, token: 'tag-audit-claim' });
    const diagnostic = assertProvenance(state.outcomes[0]!.metadata, content);
    assert.equal(diagnostic.phase, phase);
    assert.equal(diagnostic.code, phase === 'json' ? 'invalid_json' : 'invalid_response');
    const validationEvents = state.events.filter(([event]) => event === 'ai.validation_failed');
    assert.equal(validationEvents.length, 1);
    assert.doesNotMatch(JSON.stringify(validationEvents), /private-response|private-key/);
  });
}

test('tag validation survives unavailable audit storage', { timeout: 5000 }, async () => {
  const state = setup('{"items":false}', 'stop', true);
  await state.run();
  assert.equal(state.stats().sends, 1);
  assert.equal(state.stats().saved, undefined);
  assert.match((state.stats().failure as { message: string }).message, /items array/);
});

test('throwing tag audit loggers preserve the validation failure and its response metadata', async () => {
  const content = '{"items":false}';
  const state = setup(content, 'stop', false, true);
  await assert.rejects(state.modelCall(job, new AbortController().signal), (error: any) => {
    assert.equal(error.retryClass, 'invalid_response');
    assert.equal(error.retryable, false);
    assert.equal(error.requestOutcome, 'confirmed');
    assert.match(error.message, /items array/);
    assertProvenance(error.responseMetadata, content);
    return true;
  });
  assert.equal(state.stats().sends, 1);
});

test('truncated tag streams retain transport diagnostics without saving a partial result or resending', { timeout: 5000 }, async () => {
  for (const finishReason of [null, 'length']) {
    const state = setup('{"items":', finishReason);
    await state.run();
    assert.equal(state.stats().sends, 1);
    assert.equal(state.stats().saved, undefined);
    assert.equal(state.outcomes[0]!.outcome, finishReason === null ? 'unknown' : 'confirmed');
    assert.equal(state.outcomes[0]!.metadata, undefined);
    assert.equal(state.events.some(([event]) => event === 'ai.validation_failed'), false);
    assert.equal(state.events.filter(([event]) => event === 'ai.response_failed').length, 1);
  }
});

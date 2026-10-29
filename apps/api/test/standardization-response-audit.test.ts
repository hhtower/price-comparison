import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiWorker, createOpenAiModelCall } from '../src/ai/ai.worker.js';
import { createHash } from 'node:crypto';
import { buildResponseAudit } from '../src/ai/response-audit.js';

const job = { id: 7n, attempts: 1n, claimed_by: 'audit-worker', lease_until: new Date(Date.now() + 60000),
  row: { job_id: 3n, step: 'request', claim_token: 'audit-claim' } };
const request = { jobId: 3n, model: 'mock', candidates: [], inputs: [
  { productId: 11n, fingerprint: 'f'.repeat(64), payload: { name: 'ChatGPT Plus' }, candidateStandardProductIds: [] },
] };
const item = { id: '11', action: 'create_identity', ruleIds: [], reason: 'Explicit listing',
  evidence: [{ path: 'name', quote: 'ChatGPT Plus' }],
  identity: { family: 'openai', product: 'chatgpt', tier: 'plus', reason: 'Explicit listing', evidence: [{ path: 'name', quote: 'ChatGPT Plus' }] } };

function setup(content: string, overrides: Record<string, unknown> = {}, finishReason: string | null = 'stop') {
  const outcomes: any[] = [], events: unknown[][] = [];
  let failed = 0, complete = 0, sends = 0, saved: any;
  const repository = {
    prepareBatch: async () => undefined,
    reserveBatchRequest: async () => 'reserved',
    getBatchRequest: async () => request,
    recordBatchRequestOutcome: async (...args: unknown[]) => { outcomes.push(args); },
    persistBatchDecision: async (_job: unknown, _batch: unknown, decision: unknown) => { saved = decision; },
    ...overrides,
  };
  const modelCall = createOpenAiModelCall(repository as never, {
    AI_BASE_URL: 'https://mock.invalid/v1', AI_API_KEY: 'private-key', AI_MODEL: 'mock',
  }, async () => {
    sends++;
    return new Response([
      { id: 'resp-1', model: 'actual-model', choices: [{ delta: { content: content.slice(0, 3) } }] },
      { id: 'resp-1', model: 'actual-model', choices: [{ delta: { content: content.slice(3) }, finish_reason: finishReason }] },
      { id: 'resp-1', model: 'actual-model', choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } },
    ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n');
  }, { log: (...args: unknown[]) => { events.push(args); } });
  let pending: any = job;
  const service = { claimNext: async () => { const value = pending; pending = null; return value; }, heartbeat: async () => {},
    fail: async () => { failed++; }, complete: async () => { complete++; }, requeue: async () => {} };
  const worker = createAiWorker(service as never, { repository: repository as never, modelCall });
  return { worker, outcomes, events, modelCall, stats: () => ({ failed, complete, sends, saved }) };
}

test('completed protocol failures retain bounded response provenance and no decision', async () => {
  for (const [content, phase, code, fieldPath] of [
    ['{"private-response":', 'json', 'invalid_json', null],
    ['{"items":"private-response"}', 'schema', 'items_type_invalid', 'items'],
    [JSON.stringify({ items: [item, item] }), 'schema', 'items_limit_exceeded', 'items'],
    [JSON.stringify({ items: [{ ...item, id: 'private-response' }] }), 'schema', 'item_id_unknown', 'items[0].id'],
    ['{"items":[],"content policy blocked":"private-response"}', 'schema', 'unexpected_field', '$'],
  ]) {
    const state = setup(content!);
    try {
      await state.worker.runOnce();
      for (let i = 0; i < 60 && !state.stats().failed; i++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.deepEqual(state.stats(), { failed: 1, complete: 0, sends: 1, saved: undefined });
      assert.equal(state.outcomes[0][1], 'confirmed');
      const metadata = state.outcomes[0][2];
      assert.equal(metadata.responseId, 'resp-1');
      assert.equal(metadata.responseModel, 'actual-model');
      assert.equal(metadata.usage.totalTokens, 30);
      assert.equal(metadata.responseDiagnostic.phase, phase);
      assert.equal(metadata.responseDiagnostic.code, code);
      assert.equal(metadata.responseDiagnostic.fieldPath, fieldPath);
      assert.equal(metadata.responseDiagnostic.contentSha256, createHash('sha256').update(content!).digest('hex'));
      assert.equal(metadata.responseDiagnostic.outputBytes, Buffer.byteLength(content!));
      assert.equal(metadata.responseDiagnostic.inputCount, 1);
      assert.equal(metadata.responseDiagnostic.chunkCount, 3);
      assert.deepEqual(state.outcomes[0][3], { workerId: 'audit-worker', attempt: 1n, token: 'audit-claim' });
      assert.doesNotMatch(JSON.stringify(metadata), /private-response|private-key/);
      const rejected = state.events.filter(([event]) => event === 'ai.validation_failed');
      assert.equal(rejected.length, 1);
      assert.doesNotMatch(JSON.stringify(rejected), /private-response|private-key/);
    } finally { await state.worker.stop(); }
  }
});

test('item-local schema and evidence rejections keep their safe coordinate summaries', async () => {
  for (const candidate of [
    { ...item, identity: { ...item.identity, tier: null } },
    { ...item, evidence: [{ path: 'name', quote: 'private-fabricated-quote' }] },
  ]) {
    const state = setup(JSON.stringify({ items: [candidate] }));
    try {
      await state.worker.runOnce();
      for (let i = 0; i < 60 && !state.stats().complete; i++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(state.stats().failed, 0);
      assert.equal(state.stats().saved.items[0].status, 'unclassified');
      const diagnostic = state.stats().saved.metadata.responseDiagnostic;
      assert.equal(state.outcomes.length, 0, 'successful generation confirms atomically with its checkpoint');
      assert.equal(diagnostic.rejectedItemCount, 1);
      assert.equal(diagnostic.issues[0].itemId, '11');
      assert.ok(diagnostic.issues[0].fieldPath);
      assert.doesNotMatch(JSON.stringify(diagnostic), /private-fabricated-quote/);
    } finally { await state.worker.stop(); }
  }
});

test('audit storage failure never masks the original model validation failure', async () => {
  const state = setup('{"items":false}', { recordBatchRequestOutcome: async () => { throw new Error('audit unavailable'); } });
  try {
    await assert.rejects(state.modelCall(job, new AbortController().signal), (error: any) => {
      assert.equal(error.retryClass, 'invalid_response');
      assert.equal(error.retryable, false);
      assert.equal(error.responseMetadata.responseDiagnostic.code, 'items_type_invalid');
      return true;
    });
    await state.worker.runOnce();
    for (let i = 0; i < 60 && !state.stats().failed; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(state.stats().failed, 1);
    assert.equal(state.stats().saved, undefined);
  } finally { await state.worker.stop(); }
});

test('incomplete streams remain transport failures without a completed response audit or a resend', async () => {
  for (const finish of [null, 'length']) {
    const state = setup('{"items":', {}, finish);
    try {
      await state.worker.runOnce();
      for (let i = 0; i < 60 && !state.stats().failed; i++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(state.stats().sends, 1);
      assert.equal(state.stats().saved, undefined);
      assert.equal(state.outcomes[0][1], finish === null ? 'unknown' : 'confirmed');
      assert.equal(state.outcomes[0][2], undefined);
      assert.equal(state.events.some(([event]) => event === 'ai.validation_failed'), false);
      assert.equal(state.events.filter(([event]) => event === 'ai.response_failed').length, 1);
    } finally { await state.worker.stop(); }
  }
});

test('large rejection summaries cap details and exclude proposed identities and response text', () => {
  const audit = buildResponseAudit({
    content: 'private-response-body', finishReason: 'stop', firstContentMs: 1, responseMs: 2, toolCalls: [],
    usage: null, responseModel: 'mock', responseModels: ['mock'], responseId: 'resp', chunkCount: 2, contentChunks: 1,
  }, 1000, 'evidence', {
    identities: [], missingIds: [],
    items: Array.from({ length: 1000 }, (_, i) => ({
      id: String(i + 1), status: 'unclassified', ruleIds: [], evidence: [], reasonCode: 'invalid_response',
      reason: 'private-response-value', diagnostic: { stage: 'schema', code: 'invalid_type',
        fieldPath: `items[${i}].identity.tier`, proposedIdentity: { family: 'private', product: 'private', tier: 'private' } },
    })),
  });
  assert.equal(audit.responseDiagnostic.rejectedItemCount, 1000);
  assert.equal(audit.responseDiagnostic.issues.length, 20);
  assert.ok(Buffer.byteLength(JSON.stringify(audit.responseDiagnostic)) < 16384);
  assert.doesNotMatch(JSON.stringify(audit), /private/);
});

test('evidence summaries use generated response coordinates instead of the model citation path', async () => {
  const state = setup(JSON.stringify({ items: [{ ...item, evidence: [{ path: 'customer-private-value-493827', quote: 'ChatGPT Plus' }] }] }));
  try {
    const result = await state.modelCall(job, new AbortController().signal);
    const diagnostic = result.metadata!.responseDiagnostic!;
    assert.equal(diagnostic.issues[0]!.fieldPath, 'evidence[0].path');
    assert.doesNotMatch(JSON.stringify(diagnostic), /customer-private-value/);
  } finally { await state.worker.stop(); }
});

test('issue count and multibyte payloads obey the serialized diagnostic byte budget', () => {
  const audit = buildResponseAudit({
    content: '{}', finishReason: 'stop', firstContentMs: 1, responseMs: 2, toolCalls: [], usage: null,
    responseModel: 'mock', responseModels: ['mock'], responseId: 'resp', chunkCount: 1, contentChunks: 1,
  }, 21, 'evidence', {
    identities: [], missingIds: [],
    items: Array.from({ length: 21 }, (_, i) => ({
      id: String(i + 1), status: 'unclassified', ruleIds: [], evidence: [], reasonCode: 'evidence_invalid', reason: 'unsupported',
      diagnostic: { stage: 'identity', code: 'identity_conflict', fieldPath: '字'.repeat(250) },
    })),
  });
  assert.ok(Buffer.byteLength(JSON.stringify(audit.responseDiagnostic, null, 2)) <= 12000);
  assert.ok(audit.responseDiagnostic.issues.length < 20);
  assert.equal(audit.responseDiagnostic.issuesTruncated, true);
  assert.equal(audit.responseDiagnostic.rejectedItemCount, 21);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiWorker, createOpenAiModelCall } from '../src/ai/ai.worker.js';
import { parseStandardizationProtocolResponse } from '../src/ai/ai.schemas.js';
import { parseStandardizationReviewResponse } from '../src/ai/standardization-review-request.js';
import type { ClaimedJob } from '../src/jobs/jobs.repository.js';

const request = {
  jobId: 3n, model: 'mock', stage: 'generate' as const, repairReviewBatchId: '6',
  candidates: [{ id: '91', family: 'openai', product: 'chatgpt', tier: 'plus', aliases: [] }],
  inputs: [{ productId: 11n, payload: { name: 'ChatGPT Plus' }, candidateStandardProductIds: ['91'] }],
};
const proposal = parseStandardizationProtocolResponse({ items: [{
  id: '11', standardProductId: null, nullReason: 'insufficient_source', evidence: [{ path: 'name', quote: 'ChatGPT Plus' }],
}] }, [{ id: '11', candidateStandardProductIds: ['91'] }]);
const reviewed = parseStandardizationReviewResponse(JSON.stringify({ items: [{
  id: '11', approved: false, code: 'supported_candidate', evidence: [{ path: 'name', quote: 'ChatGPT Plus' }],
}] }), proposal, request);
const correctionRequest = { ...request, stage: 'repair' as const, repairFeedback: reviewed.items };
const environment = { AI_BASE_URL: 'https://mock.invalid/v1', AI_API_KEY: 'mock', AI_MODEL: 'mock', AI_TIMEOUT_MS: '50' };
const claimed: ClaimedJob = {
  id: 7n, kind: 'ai_batch', attempts: 1n, claimed_by: 'worker', lease_until: new Date(Date.now() + 60000),
  row: { job_id: 3n, step: 'request', claim_token: 'claim' },
};

for (const scenario of ['success', 'invalid-json', 'missing-id', 'invented-citation', 'feedback-citation',
  'unknown-candidate', 'truncated', 'timeout', 'cancel'] as const) {
  test(`correction ${scenario} uses one streaming reservation and checkpoints only a complete validated result`, async () => {
    const events: string[] = [];
    let providerSignal: AbortSignal | undefined;
    const repository = {
      prepareBatch: async () => {}, getBatchRequest: async () => correctionRequest,
      reserveBatchRequest: async () => { events.push('reserve'); return 'reserved'; },
      recordBatchRequestOutcome: async (_id: bigint, outcome: string) => { events.push(outcome); },
      persistBatchDecision: async (_job: bigint, _batch: bigint, decision: any, _metadata: any, _claim: any, stage: string) => {
        assert.equal(stage, 'repair');
        assert.equal(decision.items[0].identity.standardProductId, '91');
        assert.equal(decision.items[0].review, undefined, 'correction must still receive its own review');
        events.push('checkpoint');
      },
      publishBatch: async () => { events.push('publish'); },
    };
    const call = createOpenAiModelCall(repository as never, environment, async (_url, init) => {
      events.push('send'); providerSignal = init?.signal ?? undefined;
      const sent = JSON.parse(String(init?.body));
      assert.equal(sent.stream, true);
      const body = JSON.parse(sent.messages[1].content);
      assert.equal(body.feedback[0].review.code, 'supported_candidate');
      if (scenario === 'timeout' || scenario === 'cancel') return new Response(new ReadableStream({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ delta: { content: '{"items":[' } }] }) + '\n\n'));
          providerSignal!.addEventListener('abort', () => stream.error(providerSignal!.reason), { once: true });
        },
      }));
      const content = scenario === 'invalid-json' ? '{invalid' : JSON.stringify({ items: scenario === 'missing-id' ? [] : [{
        id: '11', standardProductId: scenario === 'unknown-candidate' ? '999' : '91', nullReason: null,
        evidence: [{
          path: scenario === 'feedback-citation' ? 'feedback.0.review.evidence.0.quote' : 'name',
          quote: scenario === 'invented-citation' ? 'invented' : 'ChatGPT Plus',
        }],
      }] });
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(0, 10) } }] })}\n\n`
        + `data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(10) }, finish_reason: scenario === 'truncated' ? 'length' : 'stop' }] })}\n\n`
        + 'data: [DONE]\n\n');
    });
    let next: ClaimedJob | null = claimed;
    let settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    const worker = createAiWorker({
      onSettled: () => settle(),
      claimNext: async () => { const item = next; next = null; return item; }, heartbeat: async () => {},
      complete: async () => { events.push('complete'); }, requeue: async () => { events.push('requeue'); },
      fail: async (_kind: string, _id: bigint, _worker: string, _error: string, options: any) => {
        assert.equal(options.retry, false); events.push('fail');
      },
    } as never, { repository: repository as never, modelCall: call });
    try {
      await worker.runOnce();
      if (scenario === 'cancel') {
        while (!providerSignal) await new Promise(resolve => setTimeout(resolve, 1));
        worker.cancel(claimed.id);
      }
      await settled;
      assert.deepEqual(events, scenario === 'success' ? ['reserve', 'send', 'checkpoint', 'complete']
        : ['reserve', 'send', scenario === 'timeout' || scenario === 'cancel' ? 'unknown' : 'confirmed',
          scenario === 'cancel' ? 'requeue' : 'fail']);
    } finally { await worker.stop(); }
  });
}

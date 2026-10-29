import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiWorker } from '../src/ai/ai.worker.js';
import type { ClaimedJob } from '../src/jobs/jobs.repository.js';

function claimed(): ClaimedJob {
  return {
    kind: 'ai_batch',
    id: 7n,
    attempts: 1n,
    claimed_by: 'worker',
    lease_until: new Date(Date.now() + 60_000),
    row: { job_id: 3n, step: 'request', claim_token: 'claim-1', input_bytes: 10n },
  };
}

function service() {
  let pending: ClaimedJob | null = claimed();
  const failures: Array<{ retry?: boolean; retryClass?: string | null }> = [];
  return {
    failures,
    async claimNext() { const result = pending; pending = null; return result; },
    async heartbeat() {},
    async complete() {},
    async requeue() {},
    async fail(_kind: string, _id: bigint, _workerId: string, _error: string, options?: { retry?: boolean; retryClass?: string | null }) {
      failures.push(options ?? {});
    },
  };
}

async function waitForFailure(state: ReturnType<typeof service>): Promise<void> {
  for (let index = 0; index < 20 && state.failures.length === 0; index++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(state.failures.length, 1);
}

test('confirmed transient provider response consumes the request and may use the remaining budget', async () => {
  const state = service();
  const outcomes: string[] = [];
  const worker = createAiWorker(state as never, {
    repository: {
      prepareBatch: async () => undefined,
      reserveBatchRequest: async () => undefined,
      recordBatchRequestOutcome: async (_id: bigint, outcome: string) => { outcomes.push(outcome); },
    } as never,
    modelCall: async () => { throw Object.assign(new Error('503 unavailable'), { status: 503 }); },
  });
  await worker.runOnce();
  await waitForFailure(state);
  await worker.stop();
  assert.deepEqual(outcomes, ['confirmed']);
  assert.deepEqual(state.failures[0], { retry: true, backoffMs: 5_000, retryClass: 'provider_transient' });
});

test('rejected response_format request is confirmed and retried within budget', async () => {
  const state = service();
  const outcomes: string[] = [];
  const worker = createAiWorker(state as never, {
    repository: {
      prepareBatch: async () => undefined,
      reserveBatchRequest: async () => undefined,
      recordBatchRequestOutcome: async (_id: bigint, outcome: string) => { outcomes.push(outcome); },
    } as never,
    modelCall: async () => {
      throw Object.assign(new Error('400 <400> ***.***.InvalidParameter: This response_format type is unavailable now'), { status: 400 });
    },
  });
  await worker.runOnce();
  await waitForFailure(state);
  await worker.stop();
  assert.deepEqual(outcomes, ['confirmed']);
  assert.deepEqual(state.failures[0], { retry: true, backoffMs: 5_000, retryClass: 'provider_transient' });
});

test('unknown send outcome is recorded once and never retried', async () => {
  const state = service();
  const outcomes: string[] = [];
  const worker = createAiWorker(state as never, {
    repository: {
      prepareBatch: async () => undefined,
      reserveBatchRequest: async () => undefined,
      recordBatchRequestOutcome: async (_id: bigint, outcome: string) => { outcomes.push(outcome); },
    } as never,
    modelCall: async () => { throw new Error('socket closed'); },
  });
  await worker.runOnce();
  await waitForFailure(state);
  await worker.stop();
  assert.deepEqual(outcomes, ['unknown']);
  assert.equal(state.failures[0]?.retry, false);
  assert.equal(state.failures[0]?.retryClass, 'provider_unknown');
});

test('explicit provider policy rejection remains terminal even with HTTP 503', async () => {
  for (const failure of [
    Object.assign(new Error('503 request rejected: sensitive words detected'), { status: 503 }),
    Object.assign(new Error('服务方拒绝请求：包含敏感词'), { status: 500 }),
    Object.assign(new Error('service refused request'), { status: 503, error: { code: 'content_policy_violation' } }),
  ]) {
    const state = service();
    const outcomes: string[] = [];
    let requests = 0;
    const worker = createAiWorker(state as never, {
      repository: {
        prepareBatch: async () => undefined, reserveBatchRequest: async () => undefined,
        recordBatchRequestOutcome: async (_id: bigint, outcome: string) => { outcomes.push(outcome); },
      } as never,
      modelCall: async () => { requests++; throw failure; },
    });
    await worker.runOnce(); await waitForFailure(state); await worker.stop();
    assert.equal(requests, 1);
    assert.deepEqual(outcomes, ['confirmed']);
    assert.equal(state.failures[0]?.retry, false);
    assert.equal(state.failures[0]?.retryClass, 'provider_policy_rejection');
  }
});

test('confirmed rate limiting keeps the shared request retry budget', async () => {
  const state = service(); const outcomes: string[] = [];
  const worker = createAiWorker(state as never, {
    repository: { prepareBatch: async () => undefined, reserveBatchRequest: async () => undefined,
      recordBatchRequestOutcome: async (_id: bigint, outcome: string) => { outcomes.push(outcome); },
    } as never,
    modelCall: async () => { throw Object.assign(new Error('Too many requests'), { status: 429 }); },
  });
  await worker.runOnce(); await waitForFailure(state); await worker.stop();
  assert.deepEqual(outcomes, ['confirmed']);
  assert.equal(state.failures[0]?.retry, true);
  assert.equal(state.failures[0]?.retryClass, 'provider_transient');
});

test('decision persistence failure after a confirmed response never resends the request', async () => {
  const state = service();
  const outcomes: string[] = [];
  const worker = createAiWorker(state as never, {
    repository: {
      prepareBatch: async () => undefined,
      reserveBatchRequest: async () => undefined,
      recordBatchRequestOutcome: async (_id: bigint, outcome: string) => { outcomes.push(outcome); },
      persistBatchDecision: async () => { throw new Error('database unavailable'); },
    } as never,
    modelCall: async () => ({ identities: [], items: [], missingIds: [] }),
  });
  await worker.runOnce();
  await waitForFailure(state);
  await worker.stop();
  assert.deepEqual(outcomes, ['confirmed']);
  assert.equal(state.failures[0]?.retry, false);
  assert.equal(state.failures[0]?.retryClass, 'result_not_saved');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiWorker } from '../src/ai/ai.worker.js';

test('validated tag results checkpoint directly without a separate outcome audit or product publication', async () => {
  const events: string[] = [];
  let pending = true;
  const settled = Promise.withResolvers<void>();
  const worker = createAiWorker({
    claimNext: async () => pending ? (pending = false, { id: 7n, attempts: 1n, claimed_by: 'worker',
      lease_until: new Date(Date.now() + 60000), row: { job_id: 3n, job_type: 'tag_extraction', step: 'request', claim_token: 'claim' } }) : null,
    heartbeat: async () => {}, complete: async () => { events.push('complete'); },
    fail: async () => { events.push('failed'); }, requeue: async () => {},
    onSettled: () => settled.resolve(),
  } as never, {
    repository: {
      prepareBatch: async () => {},
      reserveBatchRequest: async () => { events.push('reserve'); },
      recordBatchRequestOutcome: async () => { events.push('separate audit'); throw new Error('audit unavailable'); },
      persistTagExtractionBatchDecision: async () => { events.push('product publication'); },
      checkpointTagExtractionBatchDecision: async (_job: bigint, _batch: bigint, items: unknown, metadata: unknown, claim: unknown, stage: unknown) => {
        events.push('checkpoint');
        assert.deepEqual(items, []);
        assert.deepEqual(metadata, { responseId: 'mock' });
        assert.deepEqual(claim, { workerId: 'worker', attempt: 1n, token: 'claim' });
        assert.equal(stage, 'extract');
      },
    } as never,
    modelCall: async () => { events.push('model'); return { items: [], identities: [], missingIds: [], tagExtractionItems: [], tagExtractionStage: 'extract' as const, metadata: { responseId: 'mock' } }; },
  });
  try { await worker.runOnce(); await settled.promise; } finally { await worker.stop(); }
  assert.deepEqual(events, ['reserve', 'model', 'checkpoint', 'complete']);
});

test('a publish claim dispatches to tag publication and never reserves or calls a model', async () => {
  const events: string[] = [];
  let pending = true;
  const settled = Promise.withResolvers<void>();
  const worker = createAiWorker({
    claimNext: async () => pending ? (pending = false, { id: 7n, attempts: 1n, claimed_by: 'worker',
      lease_until: new Date(Date.now() + 60000), row: { job_id: 3n, job_type: 'tag_extraction', step: 'publish', claim_token: 'claim' } }) : null,
    heartbeat: async () => {}, complete: async () => { events.push('complete'); },
    fail: async () => { events.push('failed'); }, requeue: async () => {},
    onSettled: () => settled.resolve(),
  } as never, {
    repository: {
      prepareBatch: async () => {},
      publishBatch: async () => { events.push('identity publication'); },
      publishTagExtractionBatch: async () => { events.push('tag publication'); },
      reserveBatchRequest: async () => assert.fail('publish must not reserve a request'),
    } as never,
    modelCall: async () => assert.fail('publish must not call a model'),
  });
  try { await worker.runOnce(); await settled.promise; } finally { await worker.stop(); }
  assert.deepEqual(events, ['tag publication', 'complete']);
});

test('failure before a durable checkpoint remains terminal instead of sending another provider request', async () => {
  let pending = true, calls = 0, auditWrites = 0;
  let failure: { retry?: boolean; retryClass?: string | null } | undefined;
  const settled = Promise.withResolvers<void>();
  const worker = createAiWorker({
    claimNext: async () => pending ? (pending = false, { id: 7n, attempts: 1n, claimed_by: 'worker',
      lease_until: new Date(Date.now() + 60000), row: { job_id: 3n, job_type: 'tag_extraction', step: 'request', claim_token: 'claim' } }) : null,
    heartbeat: async () => {}, complete: async () => assert.fail('unsaved response cannot complete'),
    fail: async (_kind: unknown, _id: bigint, _worker: string, _error: string, options: typeof failure) => { failure = options; },
    requeue: async () => assert.fail('unsaved response cannot automatically resend'),
    onSettled: () => settled.resolve(),
  } as never, {
    repository: {
      prepareBatch: async () => {}, reserveBatchRequest: async () => {},
      recordBatchRequestOutcome: async () => { auditWrites++; },
      checkpointTagExtractionBatchDecision: async () => { throw new Error('database unavailable'); },
    } as never,
    modelCall: async () => { calls++; return { items: [], identities: [], missingIds: [], tagExtractionItems: [] }; },
  });
  try { await worker.runOnce(); await settled.promise; } finally { await worker.stop(); }
  assert.equal(calls, 1);
  assert.equal(auditWrites, 0);
  assert.equal(failure?.retry, false);
  assert.equal(failure?.retryClass, 'result_not_saved');
});

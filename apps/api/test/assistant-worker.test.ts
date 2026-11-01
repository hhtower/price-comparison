import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkerRuntime, type WorkerRuntimeService } from '../src/workers/worker-runtime.js';
import type { ClaimedJob } from '../src/jobs/jobs.repository.js';

test('unlimited assistant execution drains bounded claim batches without waiting for active model calls', async () => {
  const queues: string[] = [];
  const pending = Array.from({ length: 205 }, (_, index): ClaimedJob => ({
    kind: 'assistant_turn', id: BigInt(index + 1), attempts: 1n, claimed_by: 'test',
    lease_until: new Date(Date.now() + 30_000), row: {},
  }));
  const signals: AbortSignal[] = [];
  let sharedAcquisitions = 0;
  const sharedPool = {
    acquire: async () => {
      sharedAcquisitions++;
      throw new Error('shared AI pool is unavailable');
    },
  };
  const service: WorkerRuntimeService = {
    claimNext: async () => null,
    claimAvailable: async (queue, _worker, limit) => {
      queues.push(queue);
      assert.ok(Number.isSafeInteger(limit) && limit > 0 && limit <= 100, 'SQL claims must remain bounded');
      return pending.splice(0, limit);
    },
    heartbeat: async () => {}, complete: async () => {}, fail: async () => {}, requeue: async () => {},
  };
  // A separate background worker cannot acquire the shared pool; the assistant must still run.
  const background = new WorkerRuntime({
    kind: 'ai_batch', workerId: 'background', service: { ...service,
      claimAvailable: async () => [{ kind: 'ai_batch', id: 999n, attempts: 1n, claimed_by: 'background',
        lease_until: new Date(Date.now() + 30_000), row: {} }],
    }, aiStage: 'standardization', aiCoordinator: sharedPool, concurrency: 1,
    handler: async () => { throw new Error('background must not execute'); },
  });
  const worker = new WorkerRuntime({
    kind: 'assistant_turn', workerId: 'test', service, concurrency: Infinity,
    handler: async (_job, signal) => {
      signals.push(signal);
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
  });
  try {
    await background.runOnce();
    await worker.runOnce();
    await worker.runOnce();
    await worker.runOnce();
    assert.equal(signals.length, 205, 'active requests do not prevent later batches from starting');
    assert.equal(sharedAcquisitions, 1, 'only the background worker uses the shared pool');
    assert.deepEqual(queues, ['assistant', 'assistant', 'assistant']);
    assert.ok(signals.every(signal => !signal.aborted));
  } finally {
    await Promise.all([worker.stop(), background.stop()]);
  }
  assert.ok(signals.every(signal => signal.aborted), 'shutdown cancels every independent request');
});

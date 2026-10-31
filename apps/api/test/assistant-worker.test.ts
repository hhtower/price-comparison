import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkerRuntime, type WorkerRuntimeService } from '../src/workers/worker-runtime.js';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Redis } from 'ioredis';
import { createAiConcurrencyCoordinator } from '../src/ai/ai-concurrency.js';

test('assistant runtime claims its own queue and shares AI concurrency coordination', async () => {
  const queues: string[] = [];
  const stages: string[] = [];
  let sent = 0;
  let resolveCompleted!: () => void;
  const completed = new Promise<void>(resolve => { resolveCompleted = resolve; });
  const service: WorkerRuntimeService = {
    claimNext: async () => null,
    claimAvailable: async queue => {
      queues.push(queue);
      return [{
        kind: 'assistant_turn', id: 1n, attempts: 1n, claimed_by: 'test',
        lease_until: new Date(Date.now() + 30_000), row: {},
      }];
    },
    heartbeat: async () => {},
    complete: async () => { resolveCompleted(); },
    fail: async () => { throw new Error('unexpected failure'); },
    requeue: async () => {},
  };
  const worker = new WorkerRuntime({
    kind: 'assistant_turn', workerId: 'test', service, concurrency: 1, aiConcurrency: 1, aiStage: 'assistant',
    aiCoordinator: { acquire: async ({ stage }) => {
      stages.push(stage);
      return { tokenId: 'shared', queueWaitMs: 0, heartbeat: async () => {}, release: async () => {} };
    } },
    handler: async () => { sent += 1; },
  });
  await worker.runOnce();
  await completed;
  await worker.stop();
  assert.deepEqual(queues, ['assistant']);
  assert.deepEqual(stages, ['assistant']);
  assert.equal(sent, 1);
});

test('assistant and standardization workers share one real Redis AI capacity budget', { skip: !process.env.TEST_REDIS_URL }, async () => {
  const redis = new Redis(process.env.TEST_REDIS_URL!);
  redis.on('error', () => {});
  if (redis.status !== 'ready') await once(redis, 'ready');
  const key = `test:assistant-mixed:${randomUUID()}`;
  const coordinator = createAiConcurrencyCoordinator(redis, { key, concurrency: 1, maxWaitMs: 2000, pollMs: 5 });
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  let started!: () => void;
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  let running = 0;
  let peak = 0;
  let finished = 0;
  let resolveDone!: () => void;
  const done = new Promise<void>(resolve => { resolveDone = resolve; });
  function service(kind: 'ai_batch' | 'assistant_turn'): WorkerRuntimeService {
    let claimed = false;
    return {
      claimNext: async () => {
        if (claimed) return null;
        claimed = true;
        return { kind, id: kind === 'ai_batch' ? 1n : 2n, attempts: 1n, claimed_by: kind, lease_until: new Date(Date.now() + 30_000), row: {} };
      },
      heartbeat: async () => {},
      complete: async () => { if (++finished === 2) resolveDone(); },
      fail: async (_kind, _id, _worker, error) => { throw new Error(error); },
      requeue: async () => {},
    };
  }
  const standardization = new WorkerRuntime({
    kind: 'ai_batch', service: service('ai_batch'), workerId: 'standard', aiStage: 'standardization', aiCoordinator: coordinator,
    concurrency: 1, handler: async () => {
      running++; peak = Math.max(peak, running); started();
      await firstGate;
      running--;
    },
  });
  const assistant = new WorkerRuntime({
    kind: 'assistant_turn', service: service('assistant_turn'), workerId: 'assistant', aiStage: 'assistant', aiCoordinator: coordinator,
    concurrency: 1, handler: async () => { running++; peak = Math.max(peak, running); running--; },
  });
  try {
    await standardization.runOnce();
    await firstStarted;
    await assistant.runOnce();
    assert.equal(running, 1);
    assert.equal(await redis.hlen(key), 1);
    releaseFirst();
    await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error('mixed workers timed out')), 3000).unref())]);
    assert.equal(peak, 1);
    assert.equal(finished, 2);
    await Promise.all([standardization.stop(), assistant.stop()]);
    assert.equal(await redis.hlen(key), 0);
  } finally {
    releaseFirst();
    await Promise.all([standardization.stop(), assistant.stop()]);
    await redis.del(key);
    redis.disconnect();
  }
});

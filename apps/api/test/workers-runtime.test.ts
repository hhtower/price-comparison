import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkerRuntime, type WorkerRuntimeService } from '../src/workers/worker-runtime.js';
import { createAiWorker } from '../src/workers/ai.worker.js';
import { createCrawlerWorker } from '../src/workers/crawler.worker.js';
import { StructuredLogger } from '../src/observability/request-context.js';
import { MetricsRegistry } from '../src/observability/metrics.js';
import type { AiConcurrencyCoordinator } from '../src/ai/ai-concurrency.js';

function job(id: bigint, attempts = 1n) { return { kind: 'ai_batch' as const, id, attempts, claimed_by: 'worker', lease_until: new Date(Date.now() + 60_000), row: {} }; }
function service(claims: ReturnType<typeof job>[] = []): WorkerRuntimeService & { completed: bigint[]; requeued: bigint[]; failed: bigint[]; failOptions: Array<{ retry?: boolean; backoffMs?: number; retryClass?: string | null } | undefined> } {
  return {
    completed: [], requeued: [], failed: [], failOptions: [],
    async claimNext() { return claims.shift() ?? null; },
    async heartbeat() {},
    async complete(_kind, id) { this.completed.push(id); },
    async fail(_kind, id, _worker, _error, options) { this.failed.push(id); this.failOptions.push(options); },
    async requeue(_kind, id) { this.requeued.push(id); },
  };
}

test('runtime uses one bounded batch claim per pump', async () => {
  const state = service();
  const calls: Array<{ queue: string; limit: number }> = [];
  state.claimAvailable = async (queue, _worker, limit) => {
    calls.push({ queue, limit });
    return [job(100n), job(101n)];
  };
  const runtime = new WorkerRuntime({ service: state, kind: 'ai_batch', workerId: 'batch-worker', concurrency: 2, handler: async () => undefined });
  assert.equal(await runtime.runOnce(), 2);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls, [{ queue: 'ai_standardization', limit: 2 }]);
  await runtime.stop();
});

test('runtime enforces bounded concurrency and completes jobs', async () => {
  const state = service([job(1n), job(2n), job(3n)]);
  let running = 0; let maxRunning = 0;
  const runtime = new WorkerRuntime({ service: state, kind: 'ai_batch', workerId: 'test', concurrency: 2, handler: async () => { running++; maxRunning = Math.max(maxRunning, running); await new Promise((resolve) => setTimeout(resolve, 20)); running--; } });
  await runtime.runOnce();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(maxRunning, 2);
  assert.deepEqual(state.completed, [1n, 2n]);
  await runtime.stop();
});

test('heartbeat failure aborts handler and requeues instead of completing', async () => {
  const state = service([job(4n)]);
  let aborted = false;
  state.heartbeat = async () => { throw new Error('db down'); };
  const runtime = new WorkerRuntime({ service: state, kind: 'ai_batch', workerId: 'test', heartbeatMs: 5, handler: async (_job, signal) => { await new Promise((resolve) => setTimeout(resolve, 20)); aborted = signal.aborted; } });
  await runtime.runOnce();
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(aborted, true);
  assert.deepEqual(state.completed, []);
  assert.deepEqual(state.requeued, [4n]);
  await runtime.stop();
});

test('stop waits for an in-flight claim and requeues a job claimed after stop starts', async () => {
  const state = service();
  let resolveClaim!: (value: ReturnType<typeof job>) => void;
  state.claimNext = async () => new Promise((resolve) => { resolveClaim = resolve; });
  const runtime = new WorkerRuntime({ service: state, kind: 'ai_batch', workerId: 'test', handler: async () => undefined });
  const run = runtime.runOnce();
  const stopping = runtime.stop();
  resolveClaim(job(5n));
  await Promise.all([run, stopping]);
  assert.deepEqual(state.requeued, [5n]);
});

test('worker factories use unique default IDs and fail closed without handlers', async () => {
  const first = createAiWorker(service([job(6n)]));
  const second = createAiWorker(service([job(7n)]));
  assert.notEqual(first.workerId, second.workerId);
  const state = service([job(8n)]);
  const crawler = createCrawlerWorker(state);
  await crawler.runOnce();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(state.completed, []);
  assert.deepEqual(state.failed, [8n]);
  await first.stop(); await second.stop(); await crawler.stop();
});

test('worker lifecycle logs and metrics carry job correlation fields', async () => {
  const state = service([job(9n)]);
  const lines: string[] = [];
  const logger = new StructuredLogger((line) => lines.push(line));
  const metrics = new MetricsRegistry();
  const runtime = new WorkerRuntime({
    service: state,
    kind: 'ai_batch',
    workerId: 'observed-worker',
    logger,
    metrics,
    handler: async () => {
      logger.log('worker.handler');
    },
  });

  await runtime.runOnce();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await runtime.stop();

  const record = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.match(String(record.requestId), /^worker-observed-worker-/);
  assert.equal(record.jobId, '9');
  assert.equal(record.queryName, 'worker.ai_batch');
  assert.equal(typeof record.duration, 'number');
  assert.equal(metrics.snapshot().workers.ai_batch.succeeded, 1);
});

test('worker samples queue depth into the shared metrics registry', async () => {
  const state = service([job(10n)]) as WorkerRuntimeService & {
    queueDepth: () => Promise<number>;
  };
  state.queueDepth = async function () { assert.equal(this, state); return 7; };
  const metrics = new MetricsRegistry();
  const runtime = new WorkerRuntime({
    service: state,
    kind: 'ai_batch',
    workerId: 'queue-worker',
    metrics,
    handler: async () => undefined,
  });

  await runtime.runOnce();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(metrics.snapshot().queues.ai_batch, 7);
  await runtime.stop();
});

test('AI runtime releases a shared lease and retries when the coordinator is unavailable', async () => {
  const state = service([job(11n)]);
  let released = 0;
  const coordinator: AiConcurrencyCoordinator = {
    acquire: async () => ({ tokenId: 'token', queueWaitMs: 0, heartbeat: async () => undefined, release: async () => { released++; } }),
  };
  const runtime = new WorkerRuntime({ service: state, kind: 'ai_batch', workerId: 'lease-worker', aiCoordinator: coordinator, aiStage: 'standardization', handler: async () => undefined });
  await runtime.runOnce();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(released, 1);
  await runtime.stop();

  const unavailable = service([job(12n)]);
  let modelCalled = false;
  const blocked = new WorkerRuntime({
    service: unavailable, kind: 'ai_batch', workerId: 'blocked-worker', aiStage: 'standardization',
    aiCoordinator: { acquire: async () => { throw new Error('AI_CONCURRENCY_UNAVAILABLE'); } },
    handler: async () => { modelCalled = true; },
  });
  await blocked.runOnce();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(modelCalled, false);
  assert.deepEqual(unavailable.failed, [12n]);
  await blocked.stop();
});

test('local publish steps do not acquire an AI concurrency lease', async () => {
  const publishJob = { ...job(14n), row: { step: 'publish' } };
  const state = service([publishJob]);
  let acquired = 0;
  const coordinator: AiConcurrencyCoordinator = {
    acquire: async () => {
      acquired++;
      return { tokenId: 'unused', queueWaitMs: 0, heartbeat: async () => undefined, release: async () => undefined };
    },
  };
  const runtime = new WorkerRuntime({
    service: state,
    kind: 'ai_batch',
    workerId: 'publish-worker',
    aiCoordinator: coordinator,
    aiStage: 'standardization',
    usesAiLease: (claimed) => claimed.row.step === 'request',
    handler: async () => undefined,
  });
  await runtime.runOnce();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(acquired, 0);
  assert.deepEqual(state.completed, [14n]);
  await runtime.stop();
});

test('batch preparation runs before acquiring an AI concurrency lease', async () => {
  const state = service([job(15n)]);
  const events: string[] = [];
  const runtime = new WorkerRuntime({
    service: state,
    kind: 'ai_batch',
    workerId: 'prepared-request-worker',
    aiStage: 'standardization',
    beforeExecute: async () => { events.push('prepare'); },
    aiCoordinator: {
      acquire: async () => {
        events.push('lease');
        return { tokenId: 'request', queueWaitMs: 0, heartbeat: async () => undefined, release: async () => undefined };
      },
    },
    handler: async () => { events.push('handler'); },
  });
  await runtime.runOnce();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(events, ['prepare', 'lease', 'handler']);
  await runtime.stop();
});

test('batch preparation and publication failures use local retry semantics', async () => {
  for (const [claimed, beforeExecute, handler] of [
    [job(16n), async () => { throw new Error('database connection reset'); }, async () => undefined],
    [{ ...job(17n), row: { step: 'publish' } }, undefined, async () => { throw new Error('database connection reset'); }],
  ] as const) {
    const state = service([claimed]);
    const runtime = new WorkerRuntime({
      service: state,
      kind: 'ai_batch',
      workerId: 'local-failure-worker',
      beforeExecute,
      usesAiLease: item => item.row.step === 'request',
      handler,
    });
    await runtime.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(state.failOptions[0]?.retry, true);
    assert.equal(state.failOptions[0]?.retryClass, 'local');
    await runtime.stop();
  }
});

test('local preparation permits maxRetries additional attempts, then fails', async () => {
  for (const [attempts, retry, backoffMs] of [
    [1n, true, 500],
    [3n, true, 2_000],
    [4n, false, 0],
  ] as const) {
    const state = service([job(40n, attempts)]);
    const runtime = new WorkerRuntime({
      service: state, kind: 'ai_batch', workerId: 'bounded-local-worker', maxRetries: 3,
      beforeExecute: async () => { throw new Error('database connection reset'); },
      handler: async () => undefined,
    });
    await runtime.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(state.failOptions[0], { retry, backoffMs, retryClass: 'local' });
    await runtime.stop();
  }
});

test('local publication starts with a fresh attempt budget', async () => {
  for (const [attempts, retry] of [[1n, true], [4n, false]] as const) {
    const state = service([{ ...job(41n, attempts), row: { step: 'publish' } }]);
    const runtime = new WorkerRuntime({
      service: state, kind: 'ai_batch', workerId: 'bounded-publish-worker', maxRetries: 3,
      handler: async () => { throw new Error('database connection reset'); },
    });
    await runtime.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(state.failOptions[0]?.retry, retry);
    await runtime.stop();
  }
});

test('zero maxRetries makes local failures terminal on the first attempt', async () => {
  const state = service([job(42n)]);
  const runtime = new WorkerRuntime({
    service: state, kind: 'ai_batch', workerId: 'no-local-retry-worker', maxRetries: 0,
    beforeExecute: async () => { throw new Error('database connection reset'); },
    handler: async () => undefined,
  });
  await runtime.runOnce();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(state.failOptions[0], { retry: false, backoffMs: 0, retryClass: 'local' });
  await runtime.stop();
});

test('capacity failures retain independent retries with capped backoff after many claims', async () => {
  const state = service([job(43n, 20n)]);
  const runtime = new WorkerRuntime({
    service: state, kind: 'ai_batch', workerId: 'long-capacity-wait-worker', maxRetries: 0,
    retryBaseMs: 1_000, transientRetryMaxMs: 60_000, aiStage: 'standardization',
    aiCoordinator: { acquire: async () => { throw new Error('AI_CONCURRENCY_QUEUE_TIMEOUT'); } },
    handler: async () => undefined,
  });
  await runtime.runOnce();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(state.failOptions[0], { retry: true, backoffMs: 60_000, retryClass: 'local' });
  await runtime.stop();
});

test('runtime rejects invalid local retry configuration', () => {
  for (const maxRetries of [-1, 1.5, Number.POSITIVE_INFINITY]) {
    assert.throws(() => new WorkerRuntime({
      service: service(), kind: 'ai_batch', workerId: 'invalid-local-retries', maxRetries, handler: async () => undefined,
    }), /maxRetries/);
  }
  for (const retryBaseMs of [0, 1.5, Number.POSITIVE_INFINITY]) {
    assert.throws(() => new WorkerRuntime({
      service: service(), kind: 'ai_batch', workerId: 'invalid-local-delay', retryBaseMs, handler: async () => undefined,
    }), /retryBaseMs/);
  }
});

test('structured provider outcomes override message-based retry classification', async () => {
  for (const [id, retryClass, retry] of [
    [18n, 'provider_transient', true],
    [19n, 'provider_unknown', false],
    [20n, 'provider_terminal', false],
  ] as const) {
    const state = service([job(id)]);
    const runtime = new WorkerRuntime({
      service: state,
      kind: 'ai_batch',
      workerId: 'provider-outcome-worker',
      handler: async () => {
        throw Object.assign(new Error('provider request failed'), { retryClass, retryable: retry });
      },
    });
    await runtime.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(state.failOptions[0]?.retry, retry);
    assert.equal(state.failOptions[0]?.retryClass, retryClass);
    await runtime.stop();
  }
});

test('AI runtime local concurrency cannot exceed the shared AI concurrency', async () => {
  const runtime = new WorkerRuntime({
    service: service(), kind: 'ai_batch', workerId: 'capped-worker', concurrency: 8, aiConcurrency: 3,
    handler: async () => undefined,
  });
  assert.equal(runtime.concurrency, 3);
  await runtime.stop();
});

test('AI concurrency capacity failures remain retryable after the ordinary attempt limit', async () => {
  const state = service([job(13n, 3n)]);
  let handlerCalled = false;
  const runtime = new WorkerRuntime({
    service: state, kind: 'ai_batch', workerId: 'capacity-worker', aiStage: 'standardization',
    aiCoordinator: { acquire: async () => { throw new Error('AI_CONCURRENCY_QUEUE_TIMEOUT'); } },
    handler: async () => { handlerCalled = true; },
  });
  await runtime.runOnce();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(handlerCalled, false);
  assert.deepEqual(state.failed, [13n]);
  assert.equal(state.failOptions[0]?.retry, true);
  await runtime.stop();
});

test('transient provider failures use an independent retry budget and backoff', async () => {
  const state = service([job(20n, 3n)]);
  const runtime = new WorkerRuntime({
    service: state,
    kind: 'ai_batch',
    workerId: 'transient-worker',
    transientMaxAttempts: 8,
    transientRetryBaseMs: 5_000,
    transientRetryMaxMs: 60_000,
    handler: async () => { throw new Error('Connection error.'); },
  });
  await runtime.runOnce();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(state.failed, [20n]);
  assert.equal(state.failOptions[0]?.retry, true);
  assert.equal(state.failOptions[0]?.backoffMs, 20_000);
  assert.equal(state.failOptions[0]?.retryClass, 'network');
  await runtime.stop();
});

test('confirmed provider throttling uses the transient delay instead of the local retry delay', async () => {
  const state = service([job(22n)]);
  const runtime = new WorkerRuntime({
    service: state,
    kind: 'ai_batch',
    workerId: 'provider-throttled',
    handler: async () => { throw Object.assign(new Error('rate limited'), { retryClass: 'provider_transient', retryable: true }); },
  });
  await runtime.runOnce();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(state.failOptions[0]?.retry, true);
  assert.equal(state.failOptions[0]?.retryClass, 'provider_transient');
  assert.equal(state.failOptions[0]?.backoffMs, 5_000);
  await runtime.stop();
});

test('transient provider failures stop at their own attempt ceiling', async () => {
  const state = service([job(21n, 8n)]);
  const runtime = new WorkerRuntime({
    service: state,
    kind: 'ai_batch',
    workerId: 'transient-exhausted',
    transientMaxAttempts: 8,
    transientRetryBaseMs: 5_000,
    transientRetryMaxMs: 60_000,
    handler: async () => { throw new Error('Upstream HTTP/2 stream failed'); },
  });
  await runtime.runOnce();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(state.failed, [21n]);
  assert.equal(state.failOptions[0]?.retry, false);
  assert.equal(state.failOptions[0]?.backoffMs, 0);
  assert.equal(state.failOptions[0]?.retryClass, 'network');
  await runtime.stop();
});

test('business and response errors never retry regardless of ordinary attempt budget', async () => {
  for (const message of [
    'AI 审核身份与原始证据冲突: conflicting account brand',
    '403 Insufficient account balance',
    'AI audit response JSON is invalid',
    'AI 结果属性字段无效',
  ]) {
    const state = service([job(30n)]);
    const runtime = new WorkerRuntime({
      service: state,
      kind: 'ai_batch',
      workerId: `business-error-${message.slice(0, 3)}`,
      maxRetries: 10,
      handler: async () => { throw new Error(message); },
    });
    await runtime.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(state.failed, [30n], message);
    assert.equal(state.failOptions[0]?.retry, false, message);
    await runtime.stop();
  }
});

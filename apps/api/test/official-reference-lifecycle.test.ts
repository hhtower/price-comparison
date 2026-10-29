import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OfficialReferenceRepository } from '../src/official-reference/official-reference.repository.js';
import { WorkerRuntime, type WorkerRuntimeService } from '../src/workers/worker-runtime.js';
import type { ClaimedJob } from '../src/jobs/jobs.repository.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const cancelled of [false, true]) {
  test('retains local claim through ' + (cancelled ? 'requeue -> requeue' : 'complete -> fail'), { timeout: 3000 }, async t => {
    const enteredFinalTransition = deferred<void>();
    const finalTransition = deferred<{ rowCount: number }>();
    const firstSettled = deferred<void>();
    let releases = 0, claims = 0, handlers = 0, settlements = 0;
    const pool = { query: async (sql: string, args: unknown[]) => {
      if (sql.startsWith('with candidate')) {
        if ((args[3] as string[]).includes('1')) return { rows: [] };
        claims++;
        return { rows: [{ id: '1', attempts: String(claims), claimed_by: args[0], claim_token: args[1], lease_until: new Date(0), task_key: 'fx' }] };
      }
      releases++;
      if (releases === 1) throw new Error('first transition lost connection');
      if (releases === 2) { enteredFinalTransition.resolve(); return finalTransition.promise; }
      return { rowCount: 1 };
    } };
    const repository = new OfficialReferenceRepository(pool as never);
    const originalSettled = repository.onSettled.bind(repository);
    repository.onSettled = (kind, id, workerId) => { originalSettled(kind, id, workerId); settlements++; firstSettled.resolve(); };
    let runtime!: WorkerRuntime;
    runtime = new WorkerRuntime({ service: repository, kind: 'fetch_run', workerId: 'stable-worker', concurrency: 2,
      handler: async (job, signal) => {
        handlers++;
        if (handlers === 1) { if (cancelled) runtime.cancel(job.id); return; }
        await new Promise<void>(resolve => {
          if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    });
    t.after(async () => { finalTransition.reject(new Error('cleanup')); await runtime.stop(); });
    assert.equal(await runtime.runOnce(), 1);
    await enteredFinalTransition.promise;
    assert.equal(await runtime.runOnce(), 0); assert.equal(handlers, 1); assert.equal(settlements, 0);
    finalTransition.reject(new Error('final transition lost connection'));
    await firstSettled.promise;
    assert.equal(settlements, 1); assert.equal(await runtime.runOnce(), 1); assert.equal(claims, 2);
    await runtime.stop(); assert.equal(handlers, 2); assert.equal(settlements, 2);
  });
}

const job = (id: bigint): ClaimedJob => ({ id, kind: 'fetch_run', attempts: 1n, claimed_by: 'test', lease_until: new Date(), row: {} });
const base = (): WorkerRuntimeService => ({ claimNext: async () => null, heartbeat: async () => {}, complete: async () => {}, fail: async () => {}, requeue: async () => {} });

test('partial claim failure settles every unstarted claim even when requeue fails', async () => {
  let claims = 0;
  const settled: bigint[] = [];
  const service = { ...base(), claimNext: async () => { if (++claims === 2) throw new Error('DB unavailable'); return job(1n); },
    requeue: async () => { throw new Error('DB unavailable'); }, onSettled: (_kind: unknown, id: bigint) => { settled.push(id); } };
  const runtime = new WorkerRuntime({ service, kind: 'fetch_run', workerId: 'test', handler: async () => { throw new Error('must not run'); } });
  await assert.rejects(runtime.runOnce(), /DB unavailable/);
  assert.deepEqual(settled, [1n]); await runtime.stop();
});

test('shutdown settles all jobs from an in-flight batch claim', async () => {
  const pending = deferred<ClaimedJob[]>();
  const settled: bigint[] = [], requeued: bigint[] = [];
  const service = { ...base(), claimAvailable: async () => pending.promise,
    requeue: async (_kind: unknown, id: bigint) => { requeued.push(id); },
    onSettled: (_kind: unknown, id: bigint) => { settled.push(id); } };
  const runtime = new WorkerRuntime({ service, kind: 'fetch_run', workerId: 'test', handler: async () => { throw new Error('must not run'); } });
  const run = runtime.runOnce(); const stop = runtime.stop(); pending.resolve([job(1n), job(2n)]);
  await Promise.all([run, stop]); assert.deepEqual(settled, [1n, 2n]); assert.deepEqual(requeued, [1n, 2n]);
});

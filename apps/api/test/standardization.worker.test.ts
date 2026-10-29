import test from 'node:test';
import assert from 'node:assert/strict';
import { StandardizationWorker } from '../src/workers/standardization.worker.js';

test('standardization sends every claimed event to one atomic incremental operation', async () => {
  const controller = new AbortController();
  const rows = [{ id: 1n, product_id: 101n, attempts: 2n, claim_token: 'token' }, { id: 2n, product_id: 102n, attempts: 1n, claim_token: 'other' }];
  let workerId = '';
  let submitted = 0;
  let recoveries = 0;
  const worker = new StandardizationWorker({
    recoverFinalization: async () => { recoveries++; },
    claimOutbox: async (owner: string) => { workerId = owner; return rows; },
    createIncrementalJob: async (input: any) => {
      assert.equal(input.workerId, workerId);
      assert.deepEqual(input.outbox, rows);
      assert.equal(input.priority, 50);
      submitted++;
      controller.abort();
    },
  } as never);
  await worker.start(controller.signal);
  assert.equal(submitted, 1);
  assert.equal(recoveries, 1);
});

test('failed incremental creation releases only its claimed events for retry', async () => {
  const controller = new AbortController();
  const rows = [{ id: 1n, product_id: 101n, attempts: 2n, claim_token: 'token' }];
  const failed: unknown[] = [];
  const worker = new StandardizationWorker({
    recoverFinalization: async () => undefined,
    claimOutbox: async () => rows,
    createIncrementalJob: async () => { throw new Error('transaction failed'); },
    failOutbox: async (claim: unknown, owner: string, error: string) => { failed.push(claim); assert.match(owner,/standardization-/); assert.equal(error,'transaction failed'); controller.abort(); },
  } as never);
  await worker.start(controller.signal);
  assert.deepEqual(failed,rows);
});

test('aborted workers do not claim or create incremental jobs', async () => {
  const controller = new AbortController(); controller.abort();
  const worker = new StandardizationWorker({claimOutbox:async()=>assert.fail('claimed after cancellation')} as never);
  await worker.start(controller.signal);
});

test('idle workers run the same-name consensus repair at most once per interval', async () => {
  const controller = new AbortController();
  let claims = 0, repairs = 0;
  const worker = new StandardizationWorker({
    recoverFinalization: async () => undefined,
    claimOutbox: async () => { if (++claims === 3) controller.abort(); return []; },
    reconcileNameConsensus: async () => { repairs++; return 0; },
  } as never);
  await worker.start(controller.signal);
  assert.equal(repairs, 1);
});

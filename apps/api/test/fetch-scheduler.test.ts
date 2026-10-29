import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FetchSchedulerWorker } from '../src/workers/fetch-scheduler.worker.js';

test('scheduler checks expired settlements even when no shop list is due', async () => {
  const controller = new AbortController();
  let expiryPolls = 0;
  const worker = new FetchSchedulerWorker({
    claimDueShops: async () => [],
    enqueueFetchRun: async () => { throw new Error('no list should be created'); },
  } as never, 'expiry-scheduler', undefined, async () => {
    expiryPolls++;
    controller.abort();
    return 1;
  });
  await worker.start(controller.signal);
  assert.equal(expiryPolls, 1);
});

test('scheduler survives claim errors with backoff and keeps polling', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const shops = {
    claimDueShops: async () => { attempts += 1; if (attempts === 1) throw new Error('db hiccup'); return []; },
    enqueueFetchRun: async () => null,
  };
  const errors: unknown[] = [];
  const worker = new FetchSchedulerWorker(shops as never, 'test-scheduler', { error: (...args) => errors.push(args[0]) });
  const loop = worker.start(controller.signal);
  await new Promise(resolve => setTimeout(resolve, 2_300)); // 第一次失败 + 退避后的第二次轮询
  controller.abort();
  await loop;
  assert.ok(attempts >= 2, `expected retry after failure, got ${attempts}`);
  assert.equal(errors.length, 1);
});

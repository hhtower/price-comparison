import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCatalogWorker } from '../src/workers/catalog.worker.js';

test('catalog worker drains work and stops after the current publication', async () => {
  const controller = new AbortController();
  let calls = 0;
  await runCatalogWorker(async () => {
    if (++calls === 3) controller.abort();
    return true;
  }, controller.signal);
  assert.equal(calls, 3);
});

test('catalog worker can cancel its idle wait', async () => {
  const controller = new AbortController();
  const running = runCatalogWorker(async () => false, controller.signal);
  setImmediate(() => controller.abort());
  await running;
});

test('catalog worker sanitizes failures and cancels retry backoff', async () => {
  const controller = new AbortController();
  const errors: string[] = [];
  await runCatalogWorker(async () => { throw new Error('private source data'); }, controller.signal, {
    error(message: string) { errors.push(message); controller.abort(); },
  });
  assert.deepEqual(errors, ['catalog.projection_failed']);
});

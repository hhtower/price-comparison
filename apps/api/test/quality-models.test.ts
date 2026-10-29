import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QualityService } from '../src/quality/quality.service.js';
import type { QualityModelLister } from '../src/quality/quality-models.js';

const input = { endpoint: 'https://relay.example/v1', apiKey: 'private-key' };
function service(modelLister: QualityModelLister) {
  return new QualityService({
    repository: { async save() { assert.fail('metadata must not be persisted'); }, async read() { return null; } },
    aiDetector: async () => { assert.fail('metadata must not generate completions'); }, ipDetector: async () => [],
    maxTasks: 1, modelLister,
  });
}

test('metadata requests release capacity on cancellation and shut down with the service', async t => {
  const signals: AbortSignal[] = [];
  const instance = service(async (_input, signal) => {
    signals.push(signal);
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  t.after(() => instance.onModuleDestroy());
  const caller = new AbortController();
  const first = instance.models(input, caller.signal);
  const rejectedFirst = assert.rejects(first, /无法获取模型列表/);
  await assert.rejects(instance.models(input, new AbortController().signal), /暂时不可用/);
  caller.abort(); await rejectedFirst;
  assert.equal(signals[0].aborted, true);
  const second = instance.models(input, new AbortController().signal);
  const rejectedSecond = assert.rejects(second, /无法获取模型列表/);
  await instance.onModuleDestroy(); await rejectedSecond;
  assert.equal(signals[1].aborted, true);
  await assert.rejects(instance.models(input, new AbortController().signal), /暂时不可用/);
});

test('metadata failures are sanitized and do not retain credentials or consume capacity', async t => {
  let calls = 0;
  const instance = service(async () => { if (++calls === 1) throw new Error('private-key upstream details'); return ['model-a']; });
  t.after(() => instance.onModuleDestroy());
  await assert.rejects(instance.models(input, new AbortController().signal), error => error instanceof Error && /无法获取模型列表/.test(error.message) && !/private-key|upstream/.test(error.message));
  assert.deepEqual(await instance.models(input, new AbortController().signal), { models: ['model-a'] });
});

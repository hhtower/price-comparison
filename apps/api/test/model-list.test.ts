import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as runtime from '../src/ai/llm-runtime.js';

const environment = { AI_BASE_URL: 'https://relay.example/prefix/v1', AI_API_KEY: 'private-key' };
const signal = () => new AbortController().signal;

test('model discovery performs one authenticated metadata GET and validates sorted unique IDs', async () => {
  let calls = 0;
  const call = runtime.createModelListCall(environment, async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://relay.example/prefix/v1/models');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.body, undefined);
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer private-key');
    return Response.json({ data: [{ id: 'model-z', owned_by: 'private-owner' }, { id: 'model-a' }, { id: 'model-z' }] });
  });
  assert.deepEqual(await call(signal()), ['model-a', 'model-z']);
  assert.equal(calls, 1);
});

test('model discovery accepts an empty list but rejects malformed oversized or truncated metadata', async () => {
  assert.deepEqual(await runtime.createModelListCall(environment, async () => Response.json({ data: [] }))(signal()), []);
  for (const payload of [{}, { data: null }, { data: [{ id: '' }] }, { data: [{ id: 123 }] }, { data: [{ id: 'line\nbreak' }] }, { data: [{ id: 'a'.repeat(201) }] }, { data: Array.from({ length: 1001 }, () => ({ id: 'model' })) }]) {
    await assert.rejects(runtime.createModelListCall(environment, async () => Response.json(payload))(signal()), /model list/i);
  }
  await assert.rejects(runtime.createModelListCall(environment, async () => new Response('{"data":['))(signal()), /model list/i);
  await assert.rejects(runtime.createModelListCall({ ...environment, AI_MAX_OUTPUT_BYTES: '12' }, async () => Response.json({ data: [{ id: 'large-model' }] }))(signal()), /model list/i);
});

test('model discovery timeout cancels a stalled body without returning partial IDs or retrying', async () => {
  let requests = 0, cancelled = false;
  const call = runtime.createModelListCall({ ...environment, AI_TIMEOUT_MS: '20' }, async () => {
    requests++;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"data":[{"id":"partial"}')); }, cancel() { cancelled = true; } }));
  });
  await assert.rejects(call(signal()), /timed out/i);
  assert.equal(cancelled, true);
  assert.equal(requests, 1);
});

test('model discovery propagates cancellation and sanitizes upstream failures', async () => {
  const controller = new AbortController(); let requests = 0;
  const call = runtime.createModelListCall(environment, async (_url, init) => {
    requests++;
    return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
  });
  const pending = call(controller.signal);
  while (!requests) await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('cancelled'));
  await assert.rejects(pending, /cancelled/);
  await assert.rejects(call(controller.signal), /cancelled/);
  assert.equal(requests, 1);
  let failures = 0;
  const failed = runtime.createModelListCall(environment, async () => { failures++; return new Response('private-key upstream details', { status: 401 }); });
  await assert.rejects(failed(signal()), error => error instanceof Error && !error.message.includes('private-key') && !error.message.includes('upstream details'));
  assert.equal(failures, 1);
});

test('model discovery cancels error bodies before the SDK can buffer oversized or stalled responses', { timeout: 1000 }, async () => {
  for (const status of [401, 500]) {
    let chunks = 0, cancelled = false, requests = 0;
    const call = runtime.createModelListCall({ ...environment, AI_MAX_OUTPUT_BYTES: '12' }, async () => {
      requests++;
      return new Response(new ReadableStream({
        pull(controller) { if (++chunks <= 1024) controller.enqueue(new Uint8Array(1024)); else controller.close(); },
        cancel() { cancelled = true; },
      }), { status });
    });
    await assert.rejects(call(signal()), /model list/i);
    assert.equal(cancelled, true);
    assert.ok(chunks <= 1, 'error bodies must not be drained into SDK memory');
    assert.equal(requests, 1);
  }
  let cancelled = false;
  const stalled = runtime.createModelListCall(environment, async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 500 }));
  await assert.rejects(stalled(signal()), /model list/i);
  assert.equal(cancelled, true);
});

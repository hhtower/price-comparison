import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { Redis } from 'ioredis';
import { ASSISTANT_LIMITS } from '@price-comparison/catalog/assistant-contract';
import { AssistantReasoning } from '../src/assistant/assistant-reasoning.js';

function broker() {
  const clients: MockRedis[] = [];
  const frames: string[] = [];
  class MockRedis extends EventEmitter {
    channel = '';
    async connect() {}
    async subscribe(channel: string) { this.channel = channel; }
    async publish(channel: string, text: string) {
      frames.push(text);
      clients.filter(client => client.channel === channel).forEach(client => client.emit('message', channel, text));
    }
    disconnect() { this.channel = ''; this.removeAllListeners(); }
  }
  return { frames, clients, create: () => {
    const redis = new MockRedis(); clients.push(redis); return redis as unknown as Redis;
  } };
}

test('reasoning crosses processes, replays from worker memory and releases subscribers', async context => {
  const bus = broker();
  const worker = new AssistantReasoning(bus.create);
  const api = new AssistantReasoning(bus.create);
  context.after(() => { worker.onApplicationShutdown(); api.onApplicationShutdown(); });
  const writer = await worker.start('1');
  await writer.append('先看');
  const seen: string[] = [];
  const other: string[] = [];
  const off = await api.subscribe('1', text => seen.push(text));
  const offOther = await api.subscribe('2', text => other.push(text));
  assert.deepEqual(seen, ['先看']);
  await writer.append('预算');
  await writer.close();
  assert.equal(seen.at(-1), '先看预算');
  assert.deepEqual(other, []);
  off(); off(); offOther();
  const count = seen.length;
  await writer.append('已关闭');
  await writer.close();
  assert.equal(seen.length, count);
  const completed: string[] = [];
  const offCompleted = await api.subscribe('1', text => completed.push(text));
  assert.deepEqual(completed, []);
  offCompleted();
  assert.equal(bus.clients.length, 4);
});

test('reasoning is bounded and malformed pubsub data is ignored', async context => {
  const bus = broker();
  const worker = new AssistantReasoning(bus.create);
  const api = new AssistantReasoning(bus.create);
  context.after(() => { worker.onApplicationShutdown(); api.onApplicationShutdown(); });
  const seen: string[] = [];
  await api.subscribe('1', text => seen.push(text));
  const writer = await worker.start('1');
  await writer.append('\u0000'.repeat(ASSISTANT_LIMITS.reasoningMaxChars + 1));
  await writer.append('超出上限');
  await writer.close();
  assert.equal(seen.at(-1)?.length, ASSISTANT_LIMITS.reasoningMaxChars);
  assert.match(seen.at(-1)!, /后续省略/u);
  assert.ok(bus.frames.every(frame => Buffer.byteLength(frame) < ASSISTANT_LIMITS.sseBufferMaxBytes));
  const count = seen.length;
  for (const raw of ['{bad', 'null', '{"turnKey":"1","text":42}', JSON.stringify({ turnKey: '1', text: 'x'.repeat(8001) })]) {
    bus.clients.forEach(client => client.emit('message', 'assistant:reasoning', raw));
  }
  assert.equal(seen.length, count);
});

test('reasoning flushes a throttled fragment while the model pauses without waiting for close', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const bus = broker();
  const worker = new AssistantReasoning(bus.create);
  const api = new AssistantReasoning(bus.create);
  context.after(() => { worker.onApplicationShutdown(); api.onApplicationShutdown(); });
  const seen: string[] = [];
  await api.subscribe('1', text => seen.push(text));
  const writer = await worker.start('1');
  await writer.append('先看');
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await writer.append('预算');
  assert.deepEqual(seen, ['先看']);
  context.mock.timers.tick(100);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.deepEqual(seen, ['先看', '先看预算']);
  await writer.close();
  const count = seen.length;
  context.mock.timers.tick(1000);
  assert.equal(seen.length, count);
});

test('unavailable progress transport rejects initialization and cleans up connections', async () => {
  let closed = 0;
  const bus = new AssistantReasoning(() => Object.assign(new EventEmitter(), {
    async connect() { throw new Error('unavailable'); },
    disconnect() { closed++; },
  }) as unknown as Redis);
  await assert.rejects(bus.start('1'), /unavailable/u);
  assert.equal(closed, 2);
  await assert.rejects(bus.start('1'), /unavailable/u);
  assert.equal(closed, 4);
});

test('slow progress publishing does not block model fragments or queue one publish per chunk', { timeout: 1000 }, async () => {
  let release!: () => void;
  let blocked = true;
  let publications = 0;
  const bus = new AssistantReasoning(() => Object.assign(new EventEmitter(), {
    async connect() {}, async subscribe() {}, disconnect() {},
    async publish() { publications++; if (blocked) await new Promise<void>(resolve => { release = resolve; }); },
  }) as unknown as Redis);
  const writer = await bus.start('session:1');
  for (let index = 0; index < 10; index++) await writer.append('片段');
  assert.equal(publications, 1);
  blocked = false;
  release();
  await writer.close();
  assert.equal(publications, 2);
  bus.onApplicationShutdown();
});

test('same numeric turn ids from different sessions never share reasoning or replay', async context => {
  const bus = broker();
  const first = new AssistantReasoning(bus.create);
  const second = new AssistantReasoning(bus.create);
  const api = new AssistantReasoning(bus.create);
  context.after(() => { first.onApplicationShutdown(); second.onApplicationShutdown(); api.onApplicationShutdown(); });
  const firstWriter = await first.start('session-a:1');
  const secondWriter = await second.start('session-b:1');
  await firstWriter.append('会话A');
  await secondWriter.append('会话B');
  const seen: string[] = [];
  await api.subscribe('session-a:1', text => seen.push(text));
  assert.deepEqual(seen, ['会话A']);
  await secondWriter.close();
  assert.deepEqual(seen, ['会话A']);
  await firstWriter.close();
});

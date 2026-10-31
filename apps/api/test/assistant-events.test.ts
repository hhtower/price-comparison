import 'reflect-metadata';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpException } from '@nestjs/common';
import { Redis } from 'ioredis';
import type { TurnSnapshot } from '@price-comparison/catalog/assistant-contract';
import { AssistantController } from '../src/assistant/assistant.controller.js';
import { AssistantAccess } from '../src/assistant/assistant-access.js';
import type { AssistantRepository } from '../src/assistant/assistant.repository.js';
import { createAiConcurrencyRedisClient } from '../src/ai/ai-concurrency.js';

const id = '11111111-1111-4111-8111-111111111111';
const auth = `Bearer ${'a'.repeat(43)}`;
const snapshot: TurnSnapshot = { id: '1', sessionId: id, clientMessageId: '22222222-2222-4222-8222-222222222222',
  inputText: 'Help', expectedRevision: 0, eventVersion: 1, status: 'queued', phase: 'queued', reply: null, errorCode: null };
function enabled(context: { after(fn: () => void): void }) {
  const previous = { ...process.env };
  Object.assign(process.env, { ASSISTANT_ENABLED: 'true', ASSISTANT_MODEL: 'mock', AI_BASE_URL: 'http://localhost', AI_API_KEY: 'mock' });
  context.after(() => { process.env = previous; });
}
class RawReply extends EventEmitter {
  writableLength = 0;
  destroyed = false;
  writableEnded = false;
  headersSent = false;
  chunks: string[] = [];
  headers: Record<string, string> = {};
  writeHead(status: number, headers: Record<string, string>) {
    assert.equal(status, 200); this.headersSent = true; Object.assign(this.headers, headers);
  }
  write(chunk: string) { this.chunks.push(chunk); return true; }
  end() { this.writableEnded = true; this.emit('close'); }
  destroy() { this.destroyed = true; this.emit('close'); return this; }
}
function fixture(read: () => Promise<TurnSnapshot> = async () => snapshot) {
  const raw = new RawReply();
  const reply = { raw, hijack() {}, header(name: string, value: string) { raw.headers[name] = value; return this; } };
  let releases = 0;
  let renewals = 0;
  let acquired = 0;
  const access = { async acquire() {
    acquired++;
    return { async renew() { renewals++; }, async release() { releases++; } };
  } };
  const repo = { readTurn: read };
  return { raw, reply: reply as never, repo, access,
    controller: new AssistantController(repo as unknown as AssistantRepository, access as unknown as AssistantAccess),
    releases: () => releases, renewals: () => renewals, acquired: () => acquired };
}
async function flush() { for (let i = 0; i < 15; i++) await Promise.resolve(); }

test('terminal subscription sends its authoritative snapshot then closes and releases', async context => {
  enabled(context);
  const terminal = { ...snapshot, status: 'cancelled' as const, phase: 'cancelled' as const, eventVersion: 2 };
  const f = fixture(async () => terminal);
  await f.controller.events(id, '1', auth, f.reply);
  assert.equal(f.raw.headers['Cache-Control'], 'no-store');
  assert.equal(f.raw.headers['X-Accel-Buffering'], 'no');
  assert.equal(f.raw.chunks.length, 1);
  assert.deepEqual(JSON.parse(f.raw.chunks[0].split('data: ')[1]), terminal);
  assert.match(f.raw.chunks[0], /^event: snapshot\n/u);
  assert.equal(f.raw.writableEnded, true);
  assert.equal(f.releases(), 1);
  assert.equal(f.raw.listenerCount('close'), 0);
});

test('authentication, feature and slot failures happen before sending SSE headers', async context => {
  enabled(context);
  const f = fixture();
  await assert.rejects(f.controller.events(id, '1', undefined, f.reply), error => (error as HttpException).getStatus() === 404);
  f.repo.readTurn = async () => { throw new HttpException('missing', 404); };
  await assert.rejects(f.controller.events(id, '1', auth, f.reply));
  assert.equal(f.acquired(), 0);
  f.repo.readTurn = async () => snapshot;
  f.access.acquire = async () => { throw new HttpException('unavailable', 503); };
  await assert.rejects(f.controller.events(id, '1', auth, f.reply));
  assert.equal(f.raw.headersSent, false);
  assert.equal(f.raw.headers['Cache-Control'], 'no-store');
  delete process.env.ASSISTANT_ENABLED;
  await assert.rejects(f.controller.events(id, '1', auth, f.reply), error => (error as HttpException).getStatus() === 503);
});

test('polling emits only increasing versions, never overlaps reads and closes at a terminal status', { timeout: 5000 }, async context => {
  enabled(context);
  let reads = 0;
  let active = false;
  const frames = [snapshot, snapshot, { ...snapshot, eventVersion: 0 },
    { ...snapshot, eventVersion: 2, status: 'cancelled' as const, phase: 'cancelled' as const }];
  const f = fixture(async () => {
    assert.equal(active, false); active = true;
    await Promise.resolve();
    active = false;
    return frames[reads++];
  });
  context.after(() => f.raw.end());
  const pending = f.controller.events(id, '1', auth, f.reply);
  await pending;
  assert.equal(reads, 4);
  assert.equal(f.raw.chunks.length, 2);
  assert.equal(f.releases(), 1);
});

test('close during slot acquisition releases the eventual lease without headers or polling', async context => {
  enabled(context);
  const f = fixture();
  let complete!: () => void;
  f.access.acquire = async () => {
    await new Promise<void>(resolve => { complete = resolve; });
    return { async renew() {}, async release() { f.raw.chunks.push('released'); } };
  };
  const pending = f.controller.events(id, '1', auth, f.reply);
  await flush();
  f.raw.destroyed = true;
  f.raw.emit('close');
  complete();
  await pending;
  assert.equal(f.raw.headersSent, false);
  assert.deepEqual(f.raw.chunks, ['released']);
});

test('disconnect aborts only the subscription sleep and releases promptly', async context => {
  enabled(context);
  const f = fixture();
  const pending = f.controller.events(id, '1', auth, f.reply);
  await flush();
  f.raw.destroyed = true;
  f.raw.emit('close');
  await Promise.race([pending, delay(100).then(() => { throw new Error('subscription did not stop'); })]);
  assert.equal(f.releases(), 1);
});

test('slow streams close without writing additional buffered data', async context => {
  enabled(context);
  const f = fixture();
  f.raw.writableLength = 65_537;
  await f.controller.events(id, '1', auth, f.reply);
  assert.equal(f.raw.chunks.length, 0);
  assert.equal(f.raw.destroyed, true);
  assert.equal(f.releases(), 1);
});

test('a snapshot that pushes the buffer over the limit destroys the slow socket and releases', async context => {
  enabled(context);
  const f = fixture();
  f.raw.write = chunk => { f.raw.chunks.push(chunk); f.raw.writableLength = 65_537; return false; };
  await f.controller.events(id, '1', auth, f.reply);
  assert.equal(f.raw.chunks.length, 1);
  assert.equal(f.raw.destroyed, true);
  assert.equal(f.releases(), 1);
});

test('heartbeat renews the slot and sends keepalive; stream failures emit only a generic error and close', { timeout: 5000 }, async context => {
  enabled(context);
  context.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const f = fixture();
  context.after(() => f.raw.end());
  const pending = f.controller.events(id, '1', auth, f.reply);
  await flush();
  context.mock.timers.setTime(16_000);
  await delay(1100);
  assert.equal(f.renewals(), 1);
  assert.ok(f.raw.chunks.includes(': heartbeat\n\n'));
  f.repo.readTurn = async () => { throw new Error('provider password and raw response'); };
  await pending;
  assert.match(f.raw.chunks.at(-1)!, /^event: error\n/u);
  assert.doesNotMatch(f.raw.chunks.join(''), /provider|password|raw response/u);
  assert.equal(f.raw.writableEnded, true);
  assert.equal(f.releases(), 1);
});

test('connection slots are lazy and unavailable Redis fails closed', async () => {
  let clients = 0;
  const access = new AssistantAccess({ hit: async () => ({ count: 1, retryAfterMs: 1 }) },
    () => { clients++; return { eval: async () => { throw new Error('secret'); } }; });
  assert.equal(clients, 0);
  await assert.rejects(access.acquire(id), error => (error as HttpException).getStatus() === 503);
  assert.equal(clients, 1);
});

test('slot renewal detects lost ownership, release is idempotent and shutdown closes only its Redis', async () => {
  let calls = 0;
  let disconnects = 0;
  const access = new AssistantAccess({ hit: async () => ({ count: 1, retryAfterMs: 1 }) }, () => ({
    async eval() { calls++; return calls === 1 ? 1 : 0; },
    disconnect() { disconnects++; },
  }));
  const lease = await access.acquire(id);
  await assert.rejects(lease.renew(), error => (error as HttpException).getStatus() === 503);
  await Promise.all([lease.release(), lease.release()]);
  await lease.release();
  await lease.renew();
  assert.equal(calls, 3);
  access.onApplicationShutdown();
  assert.equal(disconnects, 1);
  const unused = new AssistantAccess({ hit: async () => { throw new Error('not used'); } },
    () => { throw new Error('disabled must not connect'); });
  unused.onApplicationShutdown();
});

test('real local Redis enforces two streams across instances, expiry, renewal and independent release', { timeout: 8000 }, async context => {
  const url = process.env.TEST_REDIS_URL;
  if (!url || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) {
    return context.skip('requires an explicit local TEST_REDIS_URL');
  }
  const sessionId = randomUUID();
  const key = `assistant:streams:${sessionId}`;
  const inspector = new Redis(url, { maxRetriesPerRequest: 1, connectTimeout: 1000, commandTimeout: 1000 });
  inspector.on('error', () => undefined);
  const store = { hit: async () => ({ count: 1, retryAfterMs: 60_000 }) };
  const first = new AssistantAccess(store, () => createAiConcurrencyRedisClient({ REDIS_URL: url }));
  const second = new AssistantAccess(store, () => createAiConcurrencyRedisClient({ REDIS_URL: url }));
  context.after(async () => {
    try { await inspector.del(key); }
    finally { first.onApplicationShutdown(); second.onApplicationShutdown(); inspector.disconnect(); }
  });
  const a = await first.acquire(sessionId);
  const b = await second.acquire(sessionId.toUpperCase());
  await assert.rejects(first.acquire(sessionId), error => (error as HttpException).getStatus() === 429);
  assert.equal(await inspector.zcard(key), 2);
  const ttl = await inspector.pttl(key);
  assert.ok(ttl > 0 && ttl <= 30_000);
  const before = await inspector.zrange(key, 0, -1, 'WITHSCORES');
  await delay(5);
  await a.renew();
  const after = await inspector.zrange(key, 0, -1, 'WITHSCORES');
  assert.notDeepEqual(after, before);
  await Promise.all([a.release(), a.release()]);
  assert.equal(await inspector.zcard(key), 1);
  const [oldToken] = await inspector.zrange(key, 0, -1);
  await inspector.zadd(key, 0, oldToken!);
  await assert.rejects(b.renew(), error => (error as HttpException).getStatus() === 503);
  const [c, d] = await Promise.all([first.acquire(sessionId), second.acquire(sessionId)]);
  assert.equal(await inspector.zcard(key), 2);
  await b.release();
  assert.equal(await inspector.zcard(key), 2);
  await Promise.all([c.release(), d.release()]);
  assert.equal(await inspector.zcard(key), 0);
});

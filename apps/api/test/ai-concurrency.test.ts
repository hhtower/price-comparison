import assert from 'node:assert/strict';
import test from 'node:test';
import { Redis } from 'ioredis';
import { createAiConcurrencyCoordinator, readAiConcurrency } from '../src/ai/ai-concurrency.js';

class RedisDouble {
  readonly tokens = new Map<string, { owner: string; expiresAt: number }>();
  unavailable = false;

  async eval(script: string, _keys: number, _key: string, ...args: string[]): Promise<unknown> {
    if (this.unavailable) throw new Error('redis unavailable');
    const now = Date.now();
    for (const [token, value] of this.tokens) if (value.expiresAt <= now) this.tokens.delete(token);
    if (script.includes('AI_CONCURRENCY_ACQUIRE')) {
      const [, limit, ttlMs, token, owner] = args;
      if (this.tokens.size >= Number(limit)) return [0];
      this.tokens.set(token!, { owner: owner!, expiresAt: now + Number(ttlMs) });
      return [1];
    }
    const [token, owner, nowArg, ttlMs] = args;
    const current = this.tokens.get(token!);
    if (!current || current.owner !== owner) return 0;
    if (script.includes('AI_CONCURRENCY_HEARTBEAT')) current.expiresAt = Number(nowArg) + Number(ttlMs);
    else this.tokens.delete(token!);
    return 1;
  }
}

test('reads one positive integer AI concurrency setting', () => {
  assert.equal(readAiConcurrency({ AI_CONCURRENCY: '4' }), 4);
  assert.equal(readAiConcurrency({}), 2);
  assert.throws(() => readAiConcurrency({ AI_CONCURRENCY: '0' }), /concurrency/i);
  assert.throws(() => readAiConcurrency({ AI_CONCURRENCY: '1.5' }), /concurrency/i);
  assert.throws(() => readAiConcurrency({ AI_CONCURRENCY: 'nope' }), /concurrency/i);
});

test('coordinates tokens across callers and hands a released token to a waiter', async () => {
  const redis = new RedisDouble();
  const coordinator = createAiConcurrencyCoordinator(redis, { concurrency: 2, pollMs: 2 });
  const first = await coordinator.acquire({ workerId: 'one', stage: 'standardization', signal: new AbortController().signal });
  const second = await coordinator.acquire({ workerId: 'two', stage: 'standardization', signal: new AbortController().signal });
  let acquired = false;
  const waiting = coordinator.acquire({ workerId: 'three', stage: 'standardization', signal: new AbortController().signal }).then((lease) => { acquired = true; return lease; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(acquired, false);
  await first.release();
  const third = await waiting;
  assert.equal(redis.tokens.size, 2);
  await second.release();
  await third.release();
});

test('expires abandoned tokens and does not leak a token for an aborted waiter', async () => {
  const redis = new RedisDouble();
  const coordinator = createAiConcurrencyCoordinator(redis, { concurrency: 1, ttlMs: 10, pollMs: 2 });
  await coordinator.acquire({ workerId: 'stale', stage: 'standardization', signal: new AbortController().signal });
  await new Promise((resolve) => setTimeout(resolve, 15));
  const recovered = await coordinator.acquire({ workerId: 'next', stage: 'standardization', signal: new AbortController().signal });
  const controller = new AbortController();
  const waiting = coordinator.acquire({ workerId: 'cancelled', stage: 'standardization', signal: controller.signal });
  controller.abort(new Error('cancelled'));
  await assert.rejects(waiting, /cancelled/);
  assert.equal(redis.tokens.size, 1);
  await recovered.release();
});

test('heartbeats extend only a live owner lease and release is idempotent', async () => {
  const redis = new RedisDouble();
  const coordinator = createAiConcurrencyCoordinator(redis, { concurrency: 1, ttlMs: 50, pollMs: 2 });
  const lease = await coordinator.acquire({ workerId: 'alive', stage: 'standardization', signal: new AbortController().signal });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await lease.heartbeat();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(redis.tokens.size, 1);
  await lease.release();
  await lease.release();
  assert.equal(redis.tokens.size, 0);
});

test('cancellation during a denied Redis acquire does not wait for the next poll', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled before polling');
  const coordinator = createAiConcurrencyCoordinator({
    async eval() { controller.abort(reason); return 0; },
  }, { concurrency: 1, pollMs: 100 });
  const outcome = await Promise.race([
    coordinator.acquire({ workerId: 'cancelled', stage: 'standardization', signal: controller.signal }).catch(error => error),
    new Promise(resolve => setTimeout(() => resolve('still waiting'), 20)),
  ]);
  assert.equal(outcome, reason);
});

test('surfaces Redis failures as an unavailable AI concurrency service', async () => {
  const redis = new RedisDouble();
  redis.unavailable = true;
  const coordinator = createAiConcurrencyCoordinator(redis, { concurrency: 1 });
  await assert.rejects(coordinator.acquire({ workerId: 'one', stage: 'standardization', signal: new AbortController().signal }), /AI_CONCURRENCY_UNAVAILABLE/);
});

test('releases a token acquired during an abort race', async () => {
  let startEval!: () => void;
  let finishEval!: () => void;
  let releases = 0;
  const started = new Promise<void>((resolve) => { startEval = resolve; });
  const finished = new Promise<void>((resolve) => { finishEval = resolve; });
  const redis = {
    async eval(script: string): Promise<unknown> {
      if (script.includes('AI_CONCURRENCY_ACQUIRE')) {
        startEval();
        await finished;
        return 1;
      }
      if (script.includes('AI_CONCURRENCY_RELEASE')) releases++;
      return 1;
    },
  };
  const controller = new AbortController();
  const acquire = createAiConcurrencyCoordinator(redis, { concurrency: 1 }).acquire({ workerId: 'racing', stage: 'standardization', signal: controller.signal });
  await started;
  controller.abort(new Error('cancelled'));
  finishEval();
  await assert.rejects(acquire, /cancelled/);
  assert.equal(releases, 1);
});

test('runs Lua coordinator against configured Redis', async (context) => {
  const url = process.env.TEST_REDIS_URL;
  if (!url) return context.skip('TEST_REDIS_URL is not configured');
  const redis = new Redis(url, { maxRetriesPerRequest: 1 });
  const key = `test:ai:concurrency:${Date.now()}`;
  try {
    const coordinator = createAiConcurrencyCoordinator(redis, { concurrency: 1, key, ttlMs: 25, pollMs: 2 });
    const first = await coordinator.acquire({ workerId: 'first', stage: 'standardization', signal: new AbortController().signal });
    await redis.hset(key, first.tokenId, `other:standardization|${Date.now() + 1000}`);
    await assert.rejects(first.heartbeat(), /LEASE_LOST/);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = await coordinator.acquire({ workerId: 'second', stage: 'standardization', signal: new AbortController().signal });
    await second.release();
  } finally {
    await redis.del(key);
    redis.disconnect();
  }
});

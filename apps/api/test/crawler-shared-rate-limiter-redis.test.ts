import 'reflect-metadata';
import '../src/config/env.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Redis } from 'ioredis';
import { createSharedHostRateLimiter } from '../src/crawler/rate-limiter.js';
import { createCrawlerRedis } from '../src/crawler/crawler-redis.module.js';

const url = process.env.TEST_REDIS_URL?.trim();

test('Redis atomically shares host slots across independent crawler clients', { skip: !url }, async () => {
  const host = `crawler-test-${randomUUID()}.invalid`;
  const otherHost = `shop-test-${randomUUID()}.invalid`;
  const keys = [host, otherHost].map(value => `crawler:host-rate:v1:${value}`);
  const first = createCrawlerRedis({ REDIS_URL: url })!;
  const second = createCrawlerRedis({ REDIS_URL: url })!;
  const inspector = new Redis(url!, { maxRetriesPerRequest: 1, connectTimeout: 5000, commandTimeout: 5000 });
  inspector.on('error', () => {});
  const interval = 200;
  const intervals = new Map([[host, interval], [otherHost, interval]]);
  try {
    await createSharedHostRateLimiter(intervals, first).acquire(host);
    const previous = Number(await inspector.get(keys[0]!));
    assert.ok(previous > 0);
    await createSharedHostRateLimiter(intervals, second).acquire(host);
    const current = Number(await inspector.get(keys[0]!));
    assert.ok(current >= previous + interval);
    const remaining = await inspector.pttl(keys[0]!);
    assert.ok(remaining > 0 && remaining <= 60000);
    await createSharedHostRateLimiter(intervals, second).acquire(otherHost);
    assert.equal(Number(await inspector.get(keys[0]!)), current);
    assert.ok(Number(await inspector.get(keys[1]!)) > 0);
  } finally {
    try { await inspector.del(...keys); }
    finally { first.disconnect(); second.disconnect(); inspector.disconnect(); }
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Redis } from 'ioredis';
import { AuthService, createSessionStore, hashPassword } from '../src/auth/auth.service.js';

test('invalid session configuration fails before opening a Redis connection', (context) => {
  const connect = context.mock.method(Redis.prototype, 'connect', async () => {});
  for (const [environment, message] of [
    [{ REDIS_URL: '' }, /REDIS_URL is required/],
    [{ REDIS_URL: 'https://redis.invalid' }, /REDIS_URL must use/],
    [{ REDIS_URL: 'redis://redis.invalid', AUTH_SESSION_KEY_PREFIX: 'invalid prefix' }, /AUTH_SESSION_KEY_PREFIX/],
  ] as const) {
    assert.throws(() => createSessionStore(environment), message);
  }
  assert.equal(connect.mock.callCount(), 0);
});

test('login issues redis-backed session and rejects wrong password', async () => {
  const db = { selectFrom: () => ({ select: () => ({ where: () => ({ executeTakeFirst: async () => ({ password_hash: 'scrypt$16384$8$1$00$00' }) }) }) }) } as never;
  const redis = { set: async () => 'OK', get: async () => null, del: async () => 1 } as never;
  const auth = new AuthService(db, redis);
  await assert.rejects(auth.login('wrong'));
});

test('hashPassword supports a successful login with adaptive scrypt parameters', async () => {
  const hash = await hashPassword('correct');
  const db = { selectFrom: () => ({ select: () => ({ where: () => ({ executeTakeFirst: async () => ({ id: 1, password_hash: hash }) }) }) }) } as never;
  const stored: string[] = [];
  const redis = { set: async (_k: string, v: string) => { stored.push(v); return 'OK'; }, get: async () => stored[0] ?? null, del: async () => 1 } as never;
  const session = await new AuthService(db, redis).login('correct');
  assert.match(session.token, /^[A-Za-z0-9_-]+$/);
});

test('auth service disconnects a Redis client while it is still connecting', async () => {
  let disconnected = false;
  let quitCalled = false;
  const store = {
    get: async () => null,
    set: async () => 'OK',
    del: async () => 1,
    disconnect: () => { disconnected = true; },
    quit: async () => { quitCalled = true; },
  };

  await new (await import('../src/auth/auth.service.js')).AuthService({} as never, store).onApplicationShutdown();

  assert.equal(disconnected, true);
  assert.equal(quitCalled, false);
});

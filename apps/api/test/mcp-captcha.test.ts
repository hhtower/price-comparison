import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { McpCaptcha } from '../src/mcp/mcp-captcha.js';

const digest = (id: string, answer: string, address: string) => createHash('sha256').update(`${id}\0${answer}\0${address}`).digest('hex');
const status = (error: unknown) => (error as { getStatus(): number }).getStatus();
function fixture() {
  const entries = new Map<string, string>();
  let ttl: unknown;
  let count = 1;
  let offline = false;
  const redis = {
    set: async (key: string, value: string, mode: string, seconds: number) => {
      if (offline) throw new Error('redis://private');
      assert.equal(mode, 'EX'); ttl = seconds; entries.set(key, value); return 'OK';
    },
    getdel: async (key: string) => {
      if (offline) throw new Error('redis://private');
      const value = entries.get(key) ?? null;
      entries.delete(key);
      return value;
    },
  };
  const limits = { hit: async () => {
    if (offline) throw new Error('private Redis connection');
    return { count, retryAfterMs: 60_000 };
  } };
  const captcha = new McpCaptcha(redis as never, limits);
  const seed = (id: string, answer: string, address: string) => entries.set(`mcp:captcha:${id}`, digest(id, answer, address));
  return { captcha, second: new McpCaptcha(redis as never, limits), entries, seed, ttl: () => ttl, limit: () => { count = 21; }, fail: () => { offline = true; } };
}

test('graphic challenge stores only a hash in shared Redis with a five minute expiry', async () => {
  const { captcha, entries, ttl } = fixture();
  const challenge = await captcha.create('127.0.0.1');
  assert.match(challenge.id, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(challenge.expiresInSeconds, 300);
  assert.equal(ttl(), 300);
  assert.equal(entries.size, 1);
  assert.match([...entries.values()][0]!, /^[a-f0-9]{64}$/u);
  assert.match(challenge.image, /^data:image\/png;base64,/u);
  const png = Buffer.from(challenge.image.split(',')[1]!, 'base64');
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 186);
  assert.equal(png.readUInt32BE(20), 54);
  for (let offset = 8; offset < png.length; offset += 12 + png.readUInt32BE(offset)) {
    assert.ok(!['tEXt', 'iTXt', 'zTXt', 'eXIf'].includes(png.toString('ascii', offset + 4, offset + 8)), 'PNG must not embed the source or answer in metadata');
  }
  assert.deepEqual(Object.keys(challenge).sort(), ['expiresInSeconds', 'id', 'image']);
});

test('captcha is bound to the requester, expires and can only be used once, even on wrong answers', async () => {
  const { captcha, seed } = fixture();
  const id = 'a'.repeat(43);
  seed(id, '12345', '127.0.0.1');
  await captcha.verify(id, '12345', '127.0.0.1');
  await assert.rejects(captcha.verify(id, '12345', '127.0.0.1'), error => status(error) === 400);
  for (const [answer, address] of [['00000', '127.0.0.1'], ['12345', 'other'], ['', '127.0.0.1'], ['123456', '127.0.0.1']]) {
    seed(id, '12345', '127.0.0.1');
    await assert.rejects(captcha.verify(id, answer, address), error => status(error) === 400);
    await assert.rejects(captcha.verify(id, '12345', '127.0.0.1'), error => status(error) === 400);
  }
  await assert.rejects(captcha.verify('invalid', '12345', '127.0.0.1'), error => status(error) === 400);
});

test('concurrent captcha attempts have exactly one winner across service instances', async () => {
  const { captcha, second, seed } = fixture();
  const id = 'b'.repeat(43);
  seed(id, '98765', 'client');
  const results = await Promise.allSettled([captcha.verify(id, '98765', 'client'), second.verify(id, '98765', 'client')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
});

test('challenge creation is rate limited and all Redis failures close the application path', async () => {
  const limited = fixture(); limited.limit();
  await assert.rejects(limited.captcha.create('client'), error => status(error) === 429);
  assert.equal(limited.entries.size, 0);
  const offline = fixture(); offline.fail();
  await assert.rejects(offline.captcha.create('client'), error => status(error) === 503);
  await assert.rejects(offline.captcha.verify('a'.repeat(43), '12345', 'client'), error => status(error) === 503);
});

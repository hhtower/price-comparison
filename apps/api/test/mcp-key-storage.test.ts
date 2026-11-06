import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { encryptMcpKey, decryptMcpKey } from '../src/mcp/mcp-key-storage.js';
import { McpAccess } from '../src/mcp/mcp-access.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const key = 'mcp_' + 'a'.repeat(43);
function configure(t: TestContext) {
  const previous = process.env.MCP_KEY_ENCRYPTION_KEY;
  process.env.MCP_KEY_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  t.after(() => {
    if (previous === undefined) delete process.env.MCP_KEY_ENCRYPTION_KEY;
    else process.env.MCP_KEY_ENCRYPTION_KEY = previous;
  });
}

test('stored keys use randomized authenticated encryption bound to their authentication hash', t => {
  configure(t);
  const first = encryptMcpKey(key);
  const second = encryptMcpKey(key);
  assert.notEqual(first, second);
  assert.ok(!first.includes(key));
  assert.equal(decryptMcpKey(first, hash(key)), key);
  assert.equal(decryptMcpKey(second, hash(key)), key);
  assert.throws(() => decryptMcpKey(first, hash('another key')));
  const parts = first.split('.');
  const bytes = Buffer.from(parts[3]!, 'base64url');
  bytes[0] = bytes[0]! ^ 1;
  parts[3] = bytes.toString('base64url');
  assert.throws(() => decryptMcpKey(parts.join('.'), hash(key)));
  process.env.MCP_KEY_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  assert.throws(() => decryptMcpKey(first, hash(key)));
});

test('missing configuration and corrupt ciphertext fail safely without exposing credentials', t => {
  configure(t);
  for (const configured of ['', 'not-a-secret', 'a'.repeat(63)]) {
    process.env.MCP_KEY_ENCRYPTION_KEY = configured;
    assert.throws(() => encryptMcpKey(key), (error: any) =>
      error.getStatus() === 503 && !JSON.stringify(error.getResponse()).includes(key));
  }
  process.env.MCP_KEY_ENCRYPTION_KEY = 'a'.repeat(64);
  for (const value of ['', '1.invalid.invalid.invalid', `2.${'a'.repeat(90)}`, '1.a.b.c.extra']) {
    assert.throws(() => decryptMcpKey(value, hash(key)), (error: any) =>
      error.getStatus() === 503 && !JSON.stringify(error.getResponse()).includes(value || key));
  }
});

test('claim stores encrypted material in the same conditional update and admin reveal recovers that key', async t => {
  configure(t);
  let saved: any;
  const row = { id: randomUUID(), key_expires_at: new Date('2027-01-01'), requests_per_minute: 60 };
  const update = {
    set(value: any) { saved = value; return this; }, where() { return this; },
    returning() { return this; }, async executeTakeFirst() { return row; },
  };
  const select = {
    select() { return this; }, where() { return this; },
    async executeTakeFirst() { return { key_hash: saved.key_hash, key_ciphertext: saved.key_ciphertext }; },
  };
  const access = new McpAccess({ updateTable: () => update, selectFrom: () => select } as never, {} as never, {} as never);
  const claimed = await access.claimForAccount('owner@example.com');
  assert.equal(saved.key_hash, hash(claimed.apiKey));
  assert.ok(saved.key_ciphertext);
  assert.ok(!JSON.stringify(saved).includes(claimed.apiKey));
  assert.deepEqual(await access.viewKey(row.id), { apiKey: claimed.apiKey });
  saved.key_ciphertext = null;
  await assert.rejects(access.viewKey(row.id), (error: any) => error.getStatus() === 409);
  await assert.rejects(access.viewKey('invalid-id'), (error: any) => error.getStatus() === 400);
});

test('an unavailable encryption key prevents issuing an unrecoverable new credential', async t => {
  configure(t);
  delete process.env.MCP_KEY_ENCRYPTION_KEY;
  const access = new McpAccess({ updateTable: () => assert.fail('must not consume the claim') } as never, {} as never, {} as never);
  await assert.rejects(access.claimForAccount('owner@example.com'), (error: any) => error.getStatus() === 503);
});

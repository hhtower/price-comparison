import 'reflect-metadata';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Kysely, PostgresDialect } from 'kysely';
import { readAccountPasswordMinLength } from '../src/config/env.js';
import { AccountService } from '../src/account/account.service.js';
import { McpAccess } from '../src/mcp/mcp-access.js';
import { verifyPassword } from '../src/auth/auth.service.js';
import type { DatabaseSchema } from '../src/database/types.js';

function policy(t: TestContext, value?: string) {
  const previous = process.env.ACCOUNT_PASSWORD_MIN_LENGTH;
  if (value === undefined) delete process.env.ACCOUNT_PASSWORD_MIN_LENGTH;
  else process.env.ACCOUNT_PASSWORD_MIN_LENGTH = value;
  t.after(() => {
    if (previous === undefined) delete process.env.ACCOUNT_PASSWORD_MIN_LENGTH;
    else process.env.ACCOUNT_PASSWORD_MIN_LENGTH = previous;
  });
}

test('the account password minimum defaults to eight and rejects invalid configuration', () => {
  assert.equal(readAccountPasswordMinLength({}), 8);
  assert.equal(readAccountPasswordMinLength({ ACCOUNT_PASSWORD_MIN_LENGTH: '16' }), 16);
  assert.equal(readAccountPasswordMinLength({ ACCOUNT_PASSWORD_MIN_LENGTH: '128' }), 128);
  for (const value of ['0', '7', '129', '8.5', 'invalid']) {
    assert.throws(() => readAccountPasswordMinLength({ ACCOUNT_PASSWORD_MIN_LENGTH: value }), /ACCOUNT_PASSWORD_MIN_LENGTH/);
  }
});

test('public access configuration publishes the same minimum used for registration', t => {
  policy(t, '16');
  const access = new McpAccess({} as never, { enabled: () => true } as never, {} as never);
  assert.equal(access.config().passwordMinLength, 16);
});

for (const minimum of [8, 16]) {
  test(`registration enforces ${minimum} characters and returns a usable login session`, async t => {
    policy(t, String(minimum));
    const user = { id: 'account-test', email: 'owner@example.com' };
    let passwordHash = '';
    let calls = 0;
    const connection = {
      async query(text: string, values: unknown[] = []) {
        calls++;
        let rows: Record<string, unknown>[] = [];
        if (text.includes('clock_timestamp()')) rows = [{ now: new Date() }];
        else if (text.startsWith('select') && text.includes('"account_email_challenges"')) {
          rows = [{ email: user.email, registration_expires_at: new Date(Date.now() + 600000) }];
        } else if (text.startsWith('insert into "user_accounts"')) {
          passwordHash = values.find(value => typeof value === 'string' && value.startsWith('scrypt$')) as string;
          rows = [user];
        } else if (text.startsWith('select') && text.includes('"user_accounts"')) rows = [{ ...user, password_hash: passwordHash }];
        return { rows, rowCount: rows.length, command: text.split(' ')[0]!.toUpperCase() };
      },
      release() {},
    };
    const db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({
      pool: { connect: async () => connection, end: async () => {} } as never,
    }) });
    t.after(() => db.destroy());
    const service = new AccountService(db, { get: async () => null, set: async () => 'OK', del: async () => 1 } as never,
      {} as never, { verify: async () => {} } as never, { hit: async () => ({ count: 1, retryAfterMs: 60000 }) });
    const registrationToken = 'a'.repeat(43);
    for (const length of [minimum - 1, 129]) {
      await assert.rejects(service.register({ registrationToken, password: 'x'.repeat(length) }),
        (error: any) => error.getStatus() === 400);
    }
    assert.equal(calls, 0);
    const password = 'x'.repeat(minimum);
    const registered = await service.register({ registrationToken, password });
    assert.deepEqual(registered.user, user);
    assert.match(registered.sessionToken, /^[A-Za-z0-9_-]{43}$/u);
    assert.ok(await verifyPassword(password, passwordHash));
    process.env.ACCOUNT_PASSWORD_MIN_LENGTH = '32';
    const login = { email: user.email, password, captchaId: 'captcha', captchaAnswer: '12345' };
    assert.deepEqual((await service.login(login)).user, user);
    await assert.rejects(service.login({ ...login, password: 'incorrect' }), (error: any) => error.getStatus() === 401);
  });
}

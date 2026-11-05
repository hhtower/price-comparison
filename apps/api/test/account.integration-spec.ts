import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import '../src/config/env.js';
import type { DatabaseSchema } from '../src/database/types.js';
import { up } from '../src/database/migrations/032_user_accounts_20261105.js';
import { AccountService } from '../src/account/account.service.js';
import type { McpMailer } from '../src/mcp/mcp-mailer.js';
import { McpCaptcha } from '../src/mcp/mcp-captcha.js';
import { VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { AccountController } from '../src/account/account.controller.js';
import { AccountGuard } from '../src/account/account.guard.js';
import { accountCookie } from '../src/account/account-cookies.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { AuthService } from '../src/auth/auth.service.js';
import { McpAccess } from '../src/mcp/mcp-access.js';
import { McpController, AdminMcpController } from '../src/mcp/mcp.controller.js';
import { up as mcpUp } from '../src/database/migrations/031_mcp_access_20261104.js';
import { DomainValidationError } from '../src/common/errors.js';

const schema = `account_${randomUUID().replaceAll('-', '')}`;
const enabled = !!process.env.TEST_DATABASE_URL;
const integration = (name: string, run: () => Promise<void>) => test(name, { skip: !enabled && 'TEST_DATABASE_URL is required' }, run);
let db: Kysely<DatabaseSchema>;
let admin: Pool;
let account: AccountService;
let failMail = false;
let failRedis = false;
let limitCount = 1;
let captchaCalls = 0;
const mailer = {
  enabled: () => true,
  send: async (to: string, _subject: string, text: string) => {
    if (failMail) throw new Error('SMTP_PASSWORD=private-value');
    messages.push({ to, text });
  },
  origin: () => 'https://account.example',
} as unknown as McpMailer;
const captcha = {
  verify: async (id: string, answer: string) => {
    captchaCalls++;
    if (id !== 'captcha-id' || answer !== '12345') throw new DomainValidationError('MCP_CAPTCHA_INVALID', '图形验证码错误');
  },
} as unknown as McpCaptcha;
const limiter = { hit: async () => ({ count: limitCount, retryAfterMs: 60_000 }) };
const messages: { to: string; text: string }[] = [];
const sessions = new Map<string, string>();
const password = 'a-strong-account-password';
const source = '127.0.0.1';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const code = () => {
  const result = /(?<![0-9])[0-9]{6}(?![0-9])/u.exec(messages.at(-1)?.text ?? '')?.[0];
  assert.ok(result); return result;
};
const send = (email: string, retryToken?: string) => account.sendCode({
  email, captchaId: 'captcha-id', captchaAnswer: '12345', ...(retryToken ? { retryToken } : {}),
}, source);
const status = (error: unknown) => (error as { getStatus(): number }).getStatus();
const details = (error: unknown) => ((error as { getResponse(): { error: { details: Record<string, unknown> } } }).getResponse()).error.details;

before(async () => {
  if (!enabled) return;
  admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({
    pool: new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public`, max: 8 }),
  }) });
  await up(db);
  await mcpUp(db);
  account = new AccountService(db, {
    get: async (key: string) => { if (failRedis) throw new Error('private Redis credentials'); return sessions.get(key) ?? null; },
    set: async (key: string, value: string) => { if (failRedis) throw new Error('private Redis credentials'); sessions.set(key, value); return 'OK'; },
    del: async (key: string) => { if (failRedis) throw new Error('private Redis credentials'); return Number(sessions.delete(key)); },
  } as never, mailer, captcha, limiter);
});

after(async () => {
  await db?.destroy();
  if (admin) { await admin.query(`drop schema "${schema}" cascade`); await admin.end(); }
});

async function newAccount(email: string) {
  const challenge = await send(email);
  const verified = await account.verifyEmail({ challengeId: challenge.challengeId, code: code() });
  assert.ok('registrationToken' in verified);
  return account.register({ registrationToken: verified.registrationToken, password });
}

integration('new email verifies first, asks for a password, and registers exactly once without plaintext secrets', async () => {
  const sent = await send('NEW@example.com');
  const plaintext = code();
  assert.equal(sent.retryAfterSeconds, 60);
  assert.equal(sent.expiresInSeconds, 600);
  assert.equal((await db.selectFrom('user_accounts').selectAll().execute()).length, 0);
  const row = await db.selectFrom('account_email_challenges').selectAll().where('email', '=', 'new@example.com').executeTakeFirstOrThrow();
  assert.ok(!JSON.stringify(row).includes(plaintext));
  assert.equal(row.code_hash, hash(`${sent.challengeId}\0${plaintext}`));
  assert.notEqual(row.retry_hash, sent.retryToken);
  const verified = await account.verifyEmail({ challengeId: sent.challengeId, code: plaintext });
  assert.ok('registrationToken' in verified);
  assert.equal(verified.email, 'new@example.com');
  await assert.rejects(account.verifyEmail({ challengeId: sent.challengeId, code: plaintext }), error => status(error) === 400);
  await assert.rejects(account.register({ registrationToken: verified.registrationToken, password: 'short' }), error => status(error) === 400);
  const result = await account.register({ registrationToken: verified.registrationToken, password });
  assert.equal(result.user.email, 'new@example.com');
  assert.match(result.sessionToken, /^[A-Za-z0-9_-]{43}$/u);
  const user = await db.selectFrom('user_accounts').selectAll().where('email', '=', result.user.email).executeTakeFirstOrThrow();
  assert.match(user.password_hash, /^scrypt\$/u);
  assert.notEqual(user.password_hash, password);
  assert.deepEqual(await account.validate(result.sessionToken), result.user);
  assert.ok(![...sessions.keys()].some(key => key.includes(result.sessionToken)));
  await assert.rejects(account.register({ registrationToken: verified.registrationToken, password }));
});

integration('registered email logs in with a verified code and never returns another registration grant', async () => {
  await newAccount('existing@example.com');
  await db.updateTable('account_email_challenges').set({ send_after: new Date(0) }).where('email', '=', 'existing@example.com').execute();
  const sent = await send('existing@example.com');
  const result = await account.verifyEmail({ challengeId: sent.challengeId, code: code() });
  assert.ok('user' in result);
  assert.equal(result.user.email, 'existing@example.com');
  assert.ok(!('registrationToken' in result));
  assert.deepEqual(await account.validate(result.sessionToken), result.user);
});

integration('every paid email needs a fresh graphic check in addition to retry proof, cooldown and source binding', async () => {
  const first = await send('retry@example.com');
  const oldCode = code();
  const before = captchaCalls;
  await assert.rejects(send('retry@example.com', first.retryToken), error => status(error) === 429 && Number(details(error).retryAfterSeconds) > 0);
  await assert.rejects(account.sendCode({ email: 'retry@example.com', retryToken: first.retryToken, captchaId: 'captcha-id', captchaAnswer: '12345' }, 'other-source'), error => status(error) === 403);
  await assert.rejects(send('other-email@example.com', first.retryToken), error => status(error) === 403);
  for (const seconds of [120, 240, 480, 600]) {
    await db.updateTable('account_email_challenges').set({ send_after: new Date(0) }).where('email', '=', 'retry@example.com').execute();
    const next = await send('retry@example.com', first.retryToken);
    assert.equal(next.retryAfterSeconds, seconds);
  }
  assert.equal(captchaCalls, before + 7);
  await assert.rejects(account.verifyEmail({ challengeId: first.challengeId, code: oldCode }), error => status(error) === 400);
  await db.updateTable('account_email_challenges').set({ send_after: new Date(0) }).where('email', '=', 'retry@example.com').execute();
  await assert.rejects(send('retry@example.com', first.retryToken), error => status(error) === 429);
});

integration('a retry token cannot send mail without fresh graphic verification', async () => {
  const first = await send('fresh-check@example.com');
  await db.updateTable('account_email_challenges').set({ send_after: new Date(0) }).where('email', '=', 'fresh-check@example.com').execute();
  const sentBefore = messages.length;
  await assert.rejects(account.sendCode({ email: 'fresh-check@example.com', retryToken: first.retryToken }, source));
  assert.equal(messages.length, sentBefore);
});

integration('one real graphic challenge authorizes at most one SMTP call, including concurrent and repeated sends', async () => {
  const entries = new Map<string, string>();
  const graphic = new McpCaptcha({
    getdel: async (key: string) => {
      const value = entries.get(key) ?? null;
      entries.delete(key);
      return value;
    },
  } as never, limiter);
  const guarded = new AccountService(db, {} as never, mailer, graphic, limiter);
  const id = 'z'.repeat(43);
  const answer = '12345';
  const seed = () => entries.set(`mcp:captcha:${id}`, hash(`${id}\0${answer}\0${source}`));
  const input = { email: 'graphic-single-use@example.com', captchaId: id, captchaAnswer: answer };
  seed();
  const before = messages.length;
  const outcomes = await Promise.allSettled([guarded.sendCode(input, source), guarded.sendCode(input, source)]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(messages.length, before + 1);
  const first = (outcomes.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<AccountService['sendCode']>>>).value;
  await db.updateTable('account_email_challenges').set({ send_after: new Date(0) }).where('email', '=', input.email).execute();
  await assert.rejects(guarded.sendCode({ ...input, retryToken: first.retryToken }, source), error => status(error) === 400);
  assert.equal(messages.length, before + 1);
  seed();
  const second = await guarded.sendCode({ ...input, retryToken: first.retryToken }, source);
  assert.equal(second.retryAfterSeconds, 120);
  assert.equal(messages.length, before + 2);
});

integration('incorrect codes commit their attempt count and lock after five; expired codes and proofs fail', async () => {
  const sent = await send('wrong@example.com');
  const correct = code();
  for (let index = 0; index < 5; index++) {
    await assert.rejects(account.verifyEmail({ challengeId: sent.challengeId, code: correct === '000000' ? '111111' : '000000' }));
  }
  await assert.rejects(account.verifyEmail({ challengeId: sent.challengeId, code: correct }), error => status(error) === 400);
  const expired = await send('expired-code@example.com');
  const expiredCode = code();
  await db.updateTable('account_email_challenges').set({ code_expires_at: new Date(0) }).where('email', '=', 'expired-code@example.com').execute();
  await assert.rejects(account.verifyEmail({ challengeId: expired.challengeId, code: expiredCode }), error => status(error) === 400);
  const grant = await send('expired-grant@example.com');
  const verified = await account.verifyEmail({ challengeId: grant.challengeId, code: code() });
  assert.ok('registrationToken' in verified);
  await db.updateTable('account_email_challenges').set({ registration_expires_at: new Date(0) }).where('email', '=', 'expired-grant@example.com').execute();
  await assert.rejects(account.register({ registrationToken: verified.registrationToken, password }), error => status(error) === 400);
});

integration('concurrent verification and registration each have only one winner', async () => {
  const sent = await send('race@example.com');
  const input = { challengeId: sent.challengeId, code: code() };
  const checks = await Promise.allSettled([account.verifyEmail(input), account.verifyEmail(input)]);
  assert.equal(checks.filter(result => result.status === 'fulfilled').length, 1);
  const verified = (checks.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<{ registrationToken: string }>).value;
  const creates = await Promise.allSettled([
    account.register({ registrationToken: verified.registrationToken, password }),
    account.register({ registrationToken: verified.registrationToken, password }),
  ]);
  assert.equal(creates.filter(result => result.status === 'fulfilled').length, 1);
});

integration('SMTP failure preserves retry proof and cooldown without revealing transport errors', async () => {
  failMail = true;
  let token = '';
  await assert.rejects(send('mail-failure@example.com'), error => {
    assert.equal(status(error), 503);
    token = String(details(error).retryToken);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(details(error).retryAfterSeconds, 60);
    assert.ok(!JSON.stringify((error as { getResponse(): unknown }).getResponse()).includes('SMTP_PASSWORD'));
    return true;
  });
  failMail = false;
  await assert.rejects(send('mail-failure@example.com', token), error => status(error) === 429);
  await db.updateTable('account_email_challenges').set({ send_after: new Date(0) }).where('email', '=', 'mail-failure@example.com').execute();
  assert.equal((await send('mail-failure@example.com', token)).retryAfterSeconds, 120);
});

integration('password login, logout, boundary validation and Redis failure respect account/admin separation', async () => {
  const created = await newAccount('password@example.com');
  const login = { email: 'password@example.com', password, captchaId: 'captcha-id', captchaAnswer: '12345' };
  await assert.rejects(account.login({ ...login, password: 'incorrect' }), error => status(error) === 401);
  assert.equal((await account.login(login, source)).user.id, created.user.id);
  await account.logout(created.sessionToken);
  assert.equal(await account.validate(created.sessionToken), null);
  assert.equal(await account.validate('invalid'), null);
  for (const invalid of [{}, { email: 'bad' }, { email: 'valid@example.com', unwanted: true }]) {
    await assert.rejects(account.sendCode(invalid, source), error => status(error) === 400);
  }
  failRedis = true;
  await assert.rejects(account.login(login, source), error => status(error) === 503);
  failRedis = false;
  limitCount = 11;
  await assert.rejects(send('ip-limited@example.com'), error => status(error) === 429);
  limitCount = 1;
  assert.ok((await sql`select 1`.execute(db)).rows.length);
});

integration('HTTP code verification, conditional password registration, private MCP review and claim form one flow', async () => {
  const mcp = new McpAccess(db, mailer, limiter);
  const module = await Test.createTestingModule({
    controllers: [AccountController, McpController, AdminMcpController],
    providers: [
      AccountGuard, AuthGuard, { provide: AccountService, useValue: account },
      { provide: McpAccess, useValue: mcp }, { provide: McpCaptcha, useValue: captcha },
      { provide: AuthService, useValue: { validate: async (token: string) => token === 'a'.repeat(43) ? { userId: '1' } : null } },
    ],
  }).compile();
  const app = module.createNestApplication(new FastifyAdapter({ logger: false }));
  app.enableVersioning({ type: VersioningType.URI });
  await app.init();
  const http = app.getHttpAdapter().getInstance();
  try {
    assert.deepEqual((await http.inject('/v1/account/session')).json(), { user: null });
    const email = 'http-account@example.com';
    const issued = await http.inject({ method: 'POST', url: '/v1/account/email-code', payload: { email, captchaId: 'captcha-id', captchaAnswer: '12345' } });
    assert.equal(issued.statusCode, 200);
    assert.equal(issued.headers['cache-control'], 'no-store');
    const verified = await http.inject({ method: 'POST', url: '/v1/account/verify-email', payload: { challengeId: issued.json().challengeId, code: code() } });
    assert.equal(verified.statusCode, 200);
    assert.equal(verified.headers['set-cookie'], undefined);
    assert.ok(verified.json().registrationToken);
    const registered = await http.inject({ method: 'POST', url: '/v1/account/register', payload: { registrationToken: verified.json().registrationToken, password } });
    assert.equal(registered.statusCode, 200);
    const cookie = String(registered.headers['set-cookie']);
    assert.match(cookie, /^account_session=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=604800$/u);
    assert.deepEqual(Object.keys(registered.json()), ['user']);
    const headers = { cookie };
    assert.equal((await http.inject({ url: '/v1/account/session', headers })).json().user.email, email);
    const input = { name: '账号报价工具', purpose: '对比商品', expectedUsage: '每天50次' };
    assert.equal((await http.inject({ method: 'POST', url: '/v1/mcp/applications', payload: input })).statusCode, 401);
    assert.equal((await http.inject({ method: 'POST', url: '/v1/mcp/applications', payload: { ...input, email: 'other@example.com' }, headers })).statusCode, 400);
    assert.equal((await http.inject({ method: 'POST', url: '/v1/mcp/applications', payload: input, headers })).statusCode, 201);
    const application = (await http.inject({ url: '/v1/mcp/application', headers })).json().application;
    assert.equal(application.email, email);
    assert.equal(application.status, 'pending');
    const other = await newAccount('other-http@example.com');
    assert.equal((await http.inject({ url: '/v1/mcp/application', headers: { cookie: accountCookie(other.sessionToken) } })).json().application, null);
    const adminHeaders = { cookie: `admin_session=${'a'.repeat(43)}` };
    assert.equal((await http.inject({ url: '/v1/mcp/application', headers: adminHeaders })).statusCode, 401);
    assert.equal((await http.inject({ url: '/v1/admin/mcp/applications', headers })).statusCode, 401);
    assert.equal((await http.inject({
      method: 'POST', url: `/v1/admin/mcp/applications/${application.id}/approve`, headers: adminHeaders,
      payload: { expiresInDays: 90, requestsPerMinute: 60, reviewNote: '' },
    })).statusCode, 201);
    const claimed = await http.inject({ method: 'POST', url: '/v1/mcp/application/claim', headers, payload: {} });
    assert.equal(claimed.statusCode, 201);
    assert.equal(claimed.headers['cache-control'], 'no-store');
    assert.match(claimed.json().apiKey, /^mcp_[A-Za-z0-9_-]{43}$/u);
    assert.equal((await http.inject({ method: 'POST', url: '/v1/mcp/application/claim', headers, payload: {} })).statusCode, 400);
    assert.equal((await http.inject({ method: 'POST', url: '/v1/account/logout', headers, payload: {} })).statusCode, 200);
    assert.equal((await http.inject({ url: '/v1/account/session', headers })).json().user, null);
  } finally {
    await mcp.beforeApplicationShutdown();
    await app.close();
  }
});

integration('codes, registration grants and retry proofs that expire while waiting for a row lock are rejected', async () => {
  for (const kind of ['code', 'registration', 'retry'] as const) {
    const email = `lock-expiry-${kind}@example.com`;
    const challenge = await send(email);
    const correct = code();
    let grant = '';
    if (kind === 'registration') {
      const result = await account.verifyEmail({ challengeId: challenge.challengeId, code: correct });
      assert.ok('registrationToken' in result);
      grant = result.registrationToken;
    }
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const holder = db.transaction().execute(async transaction => {
      await transaction.updateTable('account_email_challenges').set(kind === 'code'
        ? { code_expires_at: sql<Date>`clock_timestamp() + interval '700 milliseconds'` }
        : kind === 'registration' ? { registration_expires_at: sql<Date>`clock_timestamp() + interval '700 milliseconds'` }
          : { retry_expires_at: sql<Date>`clock_timestamp() + interval '700 milliseconds'`, send_after: new Date(0) })
        .where('email', '=', email).execute();
      entered();
      await held;
    });
    await started;
    const operation = kind === 'code'
      ? account.verifyEmail({ challengeId: challenge.challengeId, code: correct })
      : kind === 'registration' ? account.register({ registrationToken: grant, password }) : send(email, challenge.retryToken);
    const settled = Promise.allSettled([operation]);
    try {
      const deadline = Date.now() + 1500;
      while (!(await sql<{ blocked: boolean }>`select exists (
        select 1 from pg_stat_activity where wait_event_type = 'Lock'
          and query like '%account_email_challenges%') as blocked`.execute(db)).rows[0]!.blocked) {
        assert.ok(Date.now() < deadline, 'credential verification must be waiting on the row lock');
      }
      await new Promise(resolve => setTimeout(resolve, 900));
    } finally {
      release(); await holder;
    }
    const [result] = await settled;
    assert.equal(result.status, 'rejected', `${kind} must expire during the lock wait`);
    if (result.status === 'rejected') assert.equal(status(result.reason), kind === 'retry' ? 403 : 400);
  }
});

import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import '../src/config/env.js';
import type { DatabaseSchema } from '../src/database/types.js';
import { up } from '../src/database/migrations/031_mcp_access_20261104.js';
import { McpAccess } from '../src/mcp/mcp-access.js';
import type { McpMailer } from '../src/mcp/mcp-mailer.js';
import { VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { AuthService } from '../src/auth/auth.service.js';
import { AccountGuard } from '../src/account/account.guard.js';
import { AccountService } from '../src/account/account.service.js';
import { CatalogService } from '../src/catalog/catalog.service.js';
import { McpController, AdminMcpController } from '../src/mcp/mcp.controller.js';
import { registerMcpEndpoint } from '../src/mcp/mcp-server.js';
import { McpCaptcha } from '../src/mcp/mcp-captcha.js';

const schema = `mcp_${randomUUID().replaceAll('-', '')}`;
const messages: { to: string; subject: string; text: string }[] = [];
let failMail = false;
let failLimit = false;
let count = 1;
let db: Kysely<DatabaseSchema>;
let admin: Pool;
let access: McpAccess;
let mailHook: (() => Promise<void>) | undefined;
const mailer = {
  enabled: () => true,
  origin: () => 'https://quotes.example',
  send: async (to: string, subject: string, text: string) => {
    if (failMail) throw new Error('SMTP_PASSWORD=must-never-leak');
    await mailHook?.();
    messages.push({ to, subject, text });
  },
} as unknown as McpMailer;
const limits = {
  hit: async () => {
    if (failLimit) throw new Error('redis offline');
    return { count, retryAfterMs: 60_000 };
  },
};
const enabled = !!process.env.TEST_DATABASE_URL;
const integration = (name: string, fn: () => Promise<void>) => test(name, { skip: !enabled && 'TEST_DATABASE_URL is required' }, fn);

before(async () => {
  if (!enabled) return;
  admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({
    pool: new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public`, max: 6 }),
  }) });
  await up(db);
  access = new McpAccess(db, mailer, limits);
});

after(async () => {
  await access?.beforeApplicationShutdown();
  await db?.destroy();
  if (admin) {
    await admin.query(`drop schema "${schema}" cascade`);
    await admin.end();
  }
});

const statusCode = (error: unknown) => (error as { getStatus(): number }).getStatus();
const serialized = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
const token = (kind: string) => {
  const text = messages.at(-1)?.text ?? '';
  const value = new RegExp(`#${kind}=([A-Za-z0-9_-]{43})`, 'u').exec(text)?.[1];
  assert.ok(value, text);
  return value;
};
const application = (email: string) => ({ name: '报价助手', email, purpose: '为用户提供订阅报价对比', expectedUsage: '每天约100次' });
async function apply(input: unknown) {
  const result = await access.apply(input);
  await access.beforeApplicationShutdown();
  return result;
}
async function resubmit(email: string) {
  const result = await access.apply(application(email));
  await access.beforeApplicationShutdown();
  return result;
}
async function pending(email: string) {
  await apply(application(email));
  const verification = token('verify');
  assert.deepEqual(await access.verify(verification), { status: 'pending' });
  return (await db.selectFrom('mcp_applications').selectAll().where('email', '=', email).executeTakeFirstOrThrow()).id;
}
const review = { expiresInDays: 90, requestsPerMinute: 60, reviewNote: '合理使用' };
async function approved(email: string) {
  const id = await pending(email);
  await access.approve(id, review, '1');
  return { id, claim: token('claim') };
}

const accountInput = { name: 'account applicant', purpose: 'compare quotes', expectedUsage: '100/day' };

integration('account applications bind only to the verified email and never send verification mail', async () => {
  const sent = messages.length;
  assert.deepEqual(await access.getForAccount('account-a@example.com'), { application: null });
  assert.deepEqual(await access.applyForAccount(accountInput, ' ACCOUNT-A@example.com '), { ok: true });
  await access.applyForAccount({ ...accountInput, name: 'second account' }, 'account-b@example.com');
  const first = (await access.getForAccount('account-a@example.com')).application!;
  const second = (await access.getForAccount('account-b@example.com')).application!;
  assert.equal(first.email, 'account-a@example.com');
  assert.equal(first.name, 'account applicant');
  assert.equal(first.status, 'pending');
  assert.ok(first.emailVerifiedAt);
  assert.equal(first.canClaim, false);
  assert.equal(second.name, 'second account');
  assert.notEqual(first.id, second.id);
  await access.beforeApplicationShutdown();
  assert.equal(messages.length, sent);
  for (const input of [
    { ...accountInput, email: 'account-b@example.com' }, { ...accountInput, id: second.id },
    { ...accountInput, captchaId: 'injected' }, { ...accountInput, name: ' ' },
  ]) {
    await assert.rejects(access.applyForAccount(input, 'account-a@example.com'), error => statusCode(error) === 400);
  }
  await assert.rejects(access.getForAccount('invalid email'), error => statusCode(error) === 400);
  await assert.rejects(access.claimForAccount('account-b@example.com'), error => statusCode(error) === 400);
});

integration('verified account reads and applications promote legacy unverified rows without replacing their details', async () => {
  for (const operation of ['get', 'apply'] as const) {
    const email = `account-promote-${operation}@example.com`;
    await apply(application(email));
    const verification = token('verify');
    const before = await db.selectFrom('mcp_applications').selectAll().where('email', '=', email).executeTakeFirstOrThrow();
    if (operation === 'apply') await access.applyForAccount(accountInput, email);
    const result = (await access.getForAccount(email)).application!;
    assert.equal(result.id, before.id);
    assert.equal(result.name, before.name);
    assert.equal(result.purpose, before.purpose);
    assert.equal(result.expectedUsage, before.expected_usage);
    assert.equal(result.status, 'pending');
    assert.ok(result.emailVerifiedAt);
    const row = await db.selectFrom('mcp_applications').selectAll().where('id', '=', before.id).executeTakeFirstOrThrow();
    assert.equal(row.verification_hash, null);
    assert.equal(row.verification_expires_at, null);
    await assert.rejects(access.verify(verification), error => statusCode(error) === 400);
  }
});

integration('account reapplication and reads preserve pending, approved, issued, denied, revoked and expired rows', async () => {
  for (const state of ['pending', 'approved', 'issued', 'denied', 'revoked', 'expired'] as const) {
    const email = `account-preserve-${state}@example.com`;
    const id = await pending(email);
    if (state === 'denied') await access.reject(id, 'not eligible', '1');
    else if (state !== 'pending') {
      await access.approve(id, review, '1');
      if (state === 'issued') await access.claim(token('claim'));
      if (state === 'revoked') await access.revoke(id, '1');
      if (state === 'expired') await db.updateTable('mcp_applications').set({ key_expires_at: new Date(0) }).where('id', '=', id).execute();
    }
    const before = await db.selectFrom('mcp_applications').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    const sent = messages.length;
    await access.applyForAccount(accountInput, email);
    const result = (await access.getForAccount(email)).application!;
    assert.equal(result.canClaim, state === 'approved', state);
    assert.equal(result.id, id);
    const after = await db.selectFrom('mcp_applications').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    assert.deepEqual(after, before, state);
    assert.equal(messages.length, sent);
    for (const hidden of ['verification_hash', 'claim_hash', 'key_hash', 'reviewed_by', 'key_updated_by']) {
      assert.ok(!JSON.stringify(result).includes(hidden), hidden);
    }
    for (const value of [before.verification_hash, before.claim_hash, before.key_hash].filter(Boolean)) {
      assert.ok(!JSON.stringify(result).includes(value!));
    }
    if (state !== 'approved') await assert.rejects(access.claimForAccount(email), error => statusCode(error) === 400);
  }
});

integration('concurrent account and legacy claims share one winner and consume the legacy claim credential', async () => {
  for (const legacyRace of [false, true]) {
    const email = `account-race-${legacyRace}@example.com`;
    const { id, claim } = await approved(email);
    const attempts = [
      access.claimForAccount(email),
      legacyRace ? access.claim(claim) : access.claimForAccount(email),
    ];
    const results = await Promise.allSettled(attempts);
    const winners = results.filter(result => result.status === 'fulfilled');
    assert.equal(winners.length, 1);
    const winner = (winners[0] as PromiseFulfilledResult<Awaited<ReturnType<McpAccess['claim']>>>).value;
    assert.match(winner.apiKey, /^mcp_[A-Za-z0-9_-]{43}$/u);
    assert.equal((await access.authenticate(`Bearer ${winner.apiKey}`)).id, id);
    assert.equal((await access.getForAccount(email)).application!.canClaim, false);
    const row = await db.selectFrom('mcp_applications').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    assert.equal(row.claim_hash, null);
    assert.equal(row.claim_expires_at, null);
    assert.ok(row.claimed_at);
    assert.ok(!JSON.stringify(await access.getForAccount(email)).includes(winner.apiKey));
    await assert.rejects(access.claim(claim), error => statusCode(error) === 400);
    await assert.rejects(access.claimForAccount(email), error => statusCode(error) === 400);
  }
});

integration('account claims do not depend on an unexpired legacy mail link', async () => {
  const email = 'account-expired-link@example.com';
  const { id, claim } = await approved(email);
  await db.updateTable('mcp_applications').set({ claim_expires_at: new Date(0) }).where('id', '=', id).execute();
  assert.equal((await access.getForAccount(email)).application!.canClaim, true);
  await assert.rejects(access.claim(claim), error => statusCode(error) === 400);
  assert.equal((await access.claimForAccount(email)).requestsPerMinute, 60);
});

integration('concurrent account submissions create one pending row without depending on mail or its rate limiter', async () => {
  const email = 'account-concurrent-apply@example.com';
  const withoutMail = new McpAccess(db, {
    enabled: () => false,
    send: () => assert.fail('account applications must not send mail'),
  } as unknown as McpMailer, { hit: () => assert.fail('account applications must not use mail limits') });
  const results = await Promise.all([
    withoutMail.applyForAccount(accountInput, email),
    withoutMail.applyForAccount(accountInput, email),
  ]);
  assert.deepEqual(results, [{ ok: true }, { ok: true }]);
  const rows = await db.selectFrom('mcp_applications').selectAll().where('email', '=', email).execute();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, 'pending');
  assert.ok(rows[0]!.email_verified_at);
  await assert.rejects(withoutMail.applyForAccount(accountInput, 'bad email'), error => statusCode(error) === 400);
  await assert.rejects(withoutMail.claimForAccount('bad email'), error => statusCode(error) === 400);
  await assert.rejects(access.claim('bad token'), error => statusCode(error) === 400);
});

integration('application verifies mailbox ownership and only persists credential hashes', async () => {
  const input = application('owner@example.com');
  assert.deepEqual(await apply(input), { ok: true });
  const verification = token('verify');
  const row = await db.selectFrom('mcp_applications').selectAll().where('email', '=', input.email).executeTakeFirstOrThrow();
  assert.equal(row.status, 'unverified');
  assert.equal(row.verification_hash?.length, 64);
  assert.ok(!serialized(row).includes(verification));
  await assert.rejects(access.approve(row.id, review, '1'), error => statusCode(error) === 409);
  assert.deepEqual(await access.verify(verification), { status: 'pending' });
  await assert.rejects(access.verify(verification), error => statusCode(error) === 400);
  assert.deepEqual(await apply({ ...input, email: 'OWNER@example.com' }), { ok: true });
  assert.equal(Number((await db.selectFrom('mcp_applications').select(eb => eb.fn.countAll().as('count'))
    .where('email', '=', input.email).executeTakeFirstOrThrow()).count), 1);
});

integration('concurrent claims produce exactly one usable key and never expose it in lists or email', async () => {
  const { id, claim } = await approved('claim@example.com');
  const results = await Promise.allSettled([access.claim(claim), access.claim(claim)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const result = results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<McpAccess['claim']>>>;
  const { apiKey } = result.value;
  assert.match(apiKey, /^mcp_[A-Za-z0-9_-]{43}$/u);
  const row = await db.selectFrom('mcp_applications').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  assert.equal(row.claim_hash, null);
  assert.equal(row.key_hash?.length, 64);
  assert.ok(!serialized(row).includes(apiKey));
  assert.ok(!JSON.stringify(messages).includes(apiKey));
  assert.equal((await access.authenticate(`Bearer ${apiKey}`)).id, id);
  assert.ok(!JSON.stringify(await access.list({})).includes(apiKey));
  assert.ok(!JSON.stringify(await access.list({})).includes(row.key_hash!));
  await assert.rejects(access.authenticate(undefined), error => statusCode(error) === 401);
  await assert.rejects(access.authenticate(`Bearer mcp_${apiKey[4] === 'x' ? 'y' : 'x'}${apiKey.slice(5)}`), error => statusCode(error) === 401);
});

integration('expired verification and claim links cannot be redeemed', async () => {
  await apply(application('expired@example.com'));
  const verification = token('verify');
  await db.updateTable('mcp_applications').set({ verification_expires_at: new Date(0) }).where('email', '=', 'expired@example.com').execute();
  await assert.rejects(access.verify(verification), error => statusCode(error) === 400);
  const { id, claim } = await approved('expired-claim@example.com');
  await db.updateTable('mcp_applications').set({ claim_expires_at: new Date(0) }).where('id', '=', id).execute();
  await assert.rejects(access.claim(claim), error => statusCode(error) === 400);
});

integration('a short-lived key also bounds the claim link expiry', async () => {
  const id = await pending('short-lived@example.com');
  await access.approve(id, { ...review, expiresInDays: 1 }, '1');
  const row = await db.selectFrom('mcp_applications').select(['claim_expires_at', 'key_expires_at']).where('id', '=', id).executeTakeFirstOrThrow();
  assert.equal(row.claim_expires_at?.getTime(), row.key_expires_at?.getTime());
  assert.ok(messages.at(-1)?.text.includes(row.claim_expires_at!.toISOString()));
});

integration('revocation prevents both existing key use and outstanding claims; reissue invalidates old keys', async () => {
  const { id, claim } = await approved('revoke@example.com');
  const first = await access.claim(claim);
  await access.reissue(id, review, '1');
  const nextClaim = token('claim');
  await assert.rejects(access.authenticate(`Bearer ${first.apiKey}`), error => statusCode(error) === 401);
  await access.revoke(id, '1');
  await assert.rejects(access.claim(nextClaim), error => statusCode(error) === 400);
  await assert.rejects(access.resend(id), error => statusCode(error) === 409);
  await access.reissue(id, review, '1');
  const next = await access.claim(token('claim'));
  assert.equal((await access.authenticate(`Bearer ${next.apiKey}`)).id, id);
  await db.updateTable('mcp_applications').set({ key_expires_at: new Date(0) }).where('id', '=', id).execute();
  await assert.rejects(access.authenticate(`Bearer ${next.apiKey}`), error => statusCode(error) === 401);
});

integration('mail failure remains visible for retry and reapplication returns a generic result', async () => {
  const id = await pending('mail-fail@example.com');
  failMail = true;
  assert.deepEqual(await access.approve(id, review, '1'), { ok: true });
  assert.equal((await db.selectFrom('mcp_applications').select('notification_status').where('id', '=', id).executeTakeFirstOrThrow()).notification_status, 'failed');
  failMail = false;
  await access.resend(id);
  assert.equal((await access.claim(token('claim'))).requestsPerMinute, 60);
  assert.deepEqual(await apply(application('new-mailbox@example.com')), { ok: true });
  assert.deepEqual(await resubmit('mail-fail@example.com'), { ok: true });
});

integration('reapplication rotates verification links and provides approved applicants a new claim link', async () => {
  await apply(application('recover@example.com'));
  const oldVerification = token('verify');
  await resubmit('recover@example.com');
  await assert.rejects(access.verify(oldVerification));
  await access.verify(token('verify'));
  const id = (await db.selectFrom('mcp_applications').select('id').where('email', '=', 'recover@example.com').executeTakeFirstOrThrow()).id;
  await access.approve(id, review, '1');
  const oldClaim = token('claim');
  await resubmit('recover@example.com');
  await assert.rejects(access.claim(oldClaim));
  await access.claim(token('claim'));
});

integration('reapplication preserves reviewed details and never reactivates or replaces an issued key', async () => {
  const { id, claim } = await approved('repeat-existing@example.com');
  const { apiKey } = await access.claim(claim);
  const reapply = () => apply({ ...application('repeat-existing@example.com'), name: 'different name', purpose: 'different purpose' });
  assert.deepEqual(await reapply(), { ok: true });
  const row = await db.selectFrom('mcp_applications').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  assert.equal(row.name, '报价助手');
  assert.equal(row.purpose, application(row.email).purpose);
  assert.equal(row.status, 'approved');
  assert.equal(row.claim_hash, null);
  assert.equal((await access.authenticate(`Bearer ${apiKey}`)).id, id);
  await access.revoke(id, '1');
  await reapply();
  await assert.rejects(access.authenticate(`Bearer ${apiKey}`), error => statusCode(error) === 401);
  const revoked = await db.selectFrom('mcp_applications').select(['key_revoked_at', 'claim_hash']).where('id', '=', id).executeTakeFirstOrThrow();
  assert.ok(revoked.key_revoked_at);
  assert.equal(revoked.claim_hash, null);
});

integration('rejection is final and concurrent approvals cannot issue competing credentials', async () => {
  const id = await pending('reject@example.com');
  await access.reject(id, '用途不符', '1');
  await assert.rejects(access.approve(id, review, '1'), error => statusCode(error) === 409);
  const pendingId = await pending('concurrent@example.com');
  const reviews = await Promise.allSettled([access.approve(pendingId, review, '1'), access.approve(pendingId, review, '1')]);
  assert.equal(reviews.filter(result => result.status === 'fulfilled').length, 1);
});

integration('key rate limits and mail limits fail closed', async () => {
  count = 61;
  await assert.rejects(access.admitKey('test-id', 60), error => statusCode(error) === 429);
  count = 1;
  failLimit = true;
  await assert.rejects(access.admitKey('test-id', 60), error => statusCode(error) === 503);
  await assert.rejects(access.apply(application('offline@example.com')), error => statusCode(error) === 503);
  failLimit = false;
  count = 4;
  await assert.rejects(access.apply(application('limited@example.com')), error => statusCode(error) === 429);
  count = 1;
});

integration('boundary validation rejects malformed inputs and unreasonable quotas', async () => {
  for (const input of [{}, { ...application('bad'), extra: 'x' }, application('bad'), { ...application('valid@example.com'), name: ' ' }]) {
    await assert.rejects(access.apply(input), error => statusCode(error) === 400);
  }
  const id = await pending('quota@example.com');
  await assert.rejects(access.approve(id, { ...review, requestsPerMinute: 0 }, '1'), error => statusCode(error) === 400);
  await assert.rejects(access.approve(id, { ...review, expiresInDays: 366 }, '1'), error => statusCode(error) === 400);
  const empty = await sql`select 1`.execute(db);
  assert.equal(empty.rows.length, 1);
});

integration('HTTP accounts isolate applications and claims while admin review and legacy links remain compatible', async () => {
  const adminToken = 'a'.repeat(43);
  const accountToken = 'b'.repeat(43);
  const otherToken = 'c'.repeat(43);
  const module = await Test.createTestingModule({
    controllers: [McpController, AdminMcpController],
    providers: [
      AuthGuard,
      { provide: AuthService, useValue: { validate: async (token: string) => token === adminToken ? { userId: '1' } : null } },
      AccountGuard,
      { provide: AccountService, useValue: { validate: async (token?: string) =>
        token === accountToken ? { id: 'account-a', email: 'http@example.com' }
          : token === otherToken ? { id: 'account-b', email: 'http-other@example.com' } : null,
      } },
      { provide: McpAccess, useValue: access },
      { provide: McpCaptcha, useValue: { verify: async () => {}, create: async () => ({}) } },
      { provide: CatalogService, useValue: {} },
    ],
  }).compile();
  const app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ logger: false }));
  app.enableVersioning({ type: VersioningType.URI });
  registerMcpEndpoint(app);
  await app.init();
  const http = app.getHttpAdapter().getInstance();
  const headers = { cookie: `admin_session=${adminToken}` };
  const accountHeaders = { cookie: `account_session=${accountToken}` };
  const otherHeaders = { cookie: `account_session=${otherToken}` };
  try {
    await apply(application('http-legacy@example.com'));
    const verification = await http.inject({ method: 'POST', url: '/v1/mcp/applications/verify', payload: { token: token('verify') } });
    assert.equal(verification.json().status, 'pending');
    for (const route of ['/v1/mcp/applications', '/v1/mcp/application/claim']) {
      assert.equal((await http.inject({ method: 'POST', url: route, payload: accountInput })).statusCode, 401);
      assert.equal((await http.inject({ method: 'POST', url: route, payload: accountInput, headers })).statusCode, 401);
    }
    assert.equal((await http.inject('/v1/mcp/application')).statusCode, 401);
    assert.deepEqual((await http.inject({ url: '/v1/mcp/application', headers: accountHeaders })).json(), { application: null });
    const sent = messages.length;
    for (const payload of [
      { ...accountInput, email: 'http-other@example.com' }, { ...accountInput, id: 'other' },
      { ...accountInput, captchaId: 'unused', captchaAnswer: 'unused' }, {},
    ]) {
      const invalid = await http.inject({ method: 'POST', url: '/v1/mcp/applications', payload, headers: accountHeaders });
      assert.equal(invalid.statusCode, 400);
      assert.equal(invalid.json().error.code, 'INVALID_MCP_INPUT');
    }
    assert.equal((await http.inject({ method: 'POST', url: '/v1/mcp/applications', payload: accountInput, headers: accountHeaders })).statusCode, 201);
    assert.equal((await http.inject({
      method: 'POST', url: '/v1/mcp/applications', payload: { ...accountInput, name: 'other account' }, headers: otherHeaders,
    })).statusCode, 201);
    assert.equal(messages.length, sent);
    const list = await http.inject({ method: 'GET', url: '/v1/admin/mcp/applications?status=pending', headers });
    const id = list.json().items.find((item: { email: string }) => item.email === 'http@example.com').id;
    const url = `/v1/admin/mcp/applications/${id}`;
    assert.equal((await http.inject({ method: 'POST', url: url + '/approve', payload: review })).statusCode, 401);
    assert.equal((await http.inject({ method: 'POST', url: url + '/approve', payload: review, headers })).statusCode, 201);
    const oldClaim = token('claim');
    const own = await http.inject({ url: '/v1/mcp/application', headers: accountHeaders });
    assert.equal(own.headers['cache-control'], 'no-store');
    assert.equal(own.json().application.canClaim, true);
    const other = (await http.inject({
      url: `/v1/mcp/application?email=http@example.com&id=${id}`, headers: otherHeaders,
    })).json().application;
    assert.equal(other.email, 'http-other@example.com');
    assert.equal(other.name, 'other account');
    assert.notEqual(other.id, id);
    assert.equal(other.canClaim, false);
    assert.equal((await http.inject({
      method: 'POST', url: `/v1/mcp/application/claim?email=http@example.com&id=${id}`,
      payload: { email: 'http@example.com', id }, headers: otherHeaders,
    })).statusCode, 400);
    const claimed = await http.inject({ method: 'POST', url: '/v1/mcp/application/claim', headers: accountHeaders });
    assert.equal(claimed.statusCode, 201);
    assert.equal(claimed.headers['cache-control'], 'no-store');
    const apiKey = claimed.json().apiKey;
    assert.match(apiKey, /^mcp_[A-Za-z0-9_-]{43}$/u);
    assert.equal((await http.inject({ method: 'POST', url: '/v1/mcp/applications/claim', payload: { token: oldClaim } })).statusCode, 400);
    assert.equal((await http.inject({ method: 'POST', url: '/v1/mcp/application/claim', headers: accountHeaders })).statusCode, 400);
    const legacy = await approved('http-legacy-claim@example.com');
    assert.equal((await http.inject({
      method: 'POST', url: '/v1/mcp/applications/claim', payload: { token: legacy.claim },
    })).statusCode, 201);
    const initialize = () => http.inject({
      method: 'POST', url: '/v1/mcp', headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'integration-test', version: '1' } } },
    });
    const initialized = await initialize();
    assert.equal(initialized.statusCode, 200);
    assert.ok(initialized.json().result.capabilities.tools);
    assert.equal((await http.inject({ method: 'POST', url: url + '/revoke', payload: {}, headers })).statusCode, 201);
    assert.equal((await initialize()).statusCode, 401);
  } finally {
    await app.close();
  }
});

integration('new and repeated application responses complete independently of SMTP delivery', async () => {
  for (const kind of ['apply', 'repeat'] as const) {
    if (kind === 'repeat') await apply(application('timing-recover@example.com'));
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    mailHook = () => { entered(); return held; };
    let completed = false;
    const request = (kind === 'apply' ? access.apply(application('timing-apply@example.com')) : access.apply(application('timing-recover@example.com')))
      .then(result => { completed = true; return result; });
    try {
      await started;
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(completed, true, `${kind} must not wait for SMTP`);
    } finally {
      release();
      await request;
      await access.beforeApplicationShutdown();
      mailHook = undefined;
    }
  }
});

integration('overlapping reapplications on two API instances cannot deliver a stale credential last', async () => {
  await apply(application('overlap@example.com'));
  const second = new McpAccess(db, mailer, limits);
  const sentBefore = messages.length;
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  mailHook = () => {
    if (!first) return Promise.resolve();
    first = false; entered(); return held;
  };
  const recovering = access.apply(application('overlap@example.com'));
  try {
    await started;
    await second.apply(application('overlap@example.com'));
    await second.beforeApplicationShutdown();
  } finally {
    release();
    await recovering;
    await access.beforeApplicationShutdown();
    mailHook = undefined;
  }
  assert.equal(messages.length - sentBefore, 1, 'overlapping notifications must coalesce across API instances');
  assert.deepEqual(await access.verify(token('verify')), { status: 'pending' });
});

integration('a duplicate public application does not wait for an in-flight notification transaction', async () => {
  const input = application('duplicate-timing@example.com');
  await apply(input);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  mailHook = () => { entered(); return held; };
  await access.apply(input);
  await started;
  const duplicate = access.apply(input);
  try {
    const timeout = AbortSignal.timeout(500);
    const result = await Promise.race([
      duplicate,
      new Promise<never>((_resolve, reject) => timeout.addEventListener('abort', () => reject(new Error('duplicate application waited for SMTP')), { once: true })),
    ]);
    assert.deepEqual(result, { ok: true });
  } finally {
    release();
    await duplicate;
    await access.beforeApplicationShutdown();
    mailHook = undefined;
  }
});

integration('reapplication status mail does not block an active key authentication or revocation', async () => {
  const { id, claim } = await approved('active-mail@example.com');
  const { apiKey } = await access.claim(claim);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  mailHook = () => { entered(); return held; };
  await access.apply(application('active-mail@example.com'));
  await started;
  const operation = (async () => {
    assert.equal((await access.authenticate(`Bearer ${apiKey}`)).id, id);
    await access.revoke(id, '1');
  })();
  try {
    const timeout = AbortSignal.timeout(500);
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => timeout.addEventListener('abort', () => reject(new Error('key operations waited for status SMTP')), { once: true })),
    ]);
  } finally {
    release();
    await operation;
    await access.beforeApplicationShutdown();
    mailHook = undefined;
  }
});

integration('review and reissue send a fresh decision after an overlapping status notification', async () => {
  for (const action of ['approve', 'reject', 'reissue'] as const) {
    const email = `transition-${action}@example.com`;
    const id = await pending(email);
    if (action === 'reissue') {
      await access.approve(id, review, '1');
      await access.claim(token('claim'));
    }
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    mailHook = () => { entered(); return held; };
    await access.apply(application(email));
    await started;
    const changing = action === 'reject' ? access.reject(id, '测试拒绝', '1') : access[action](id, review, '1');
    try {
      const deadline = Date.now() + 1000;
      for (;;) {
        const row = await db.selectFrom('mcp_applications').select(['status', 'key_hash']).where('id', '=', id).executeTakeFirstOrThrow();
        if (row.status === (action === 'reject' ? 'rejected' : 'approved') && row.key_hash === null) break;
        assert.ok(Date.now() < deadline, 'the review must commit without waiting for status SMTP');
      }
      await new Promise<void>(resolve => setImmediate(resolve));
    } finally {
      release();
      await changing;
      await access.beforeApplicationShutdown();
      mailHook = undefined;
    }
    if (action === 'reject') assert.equal(messages.at(-1)?.subject, 'MCP 申请审核结果');
    else {
      assert.equal(messages.at(-1)?.subject, 'MCP 申请已通过，请领取密钥');
      assert.equal((await access.claim(token('claim'))).requestsPerMinute, 60);
    }
  }
});

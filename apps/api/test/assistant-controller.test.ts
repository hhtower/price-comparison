import 'reflect-metadata';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Global, HttpException, Module, VersioningType } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { emptyShoppingNeeds } from '@price-comparison/catalog/assistant-contract';
import { AssistantController } from '../src/assistant/assistant.controller.js';
import { AssistantAccess } from '../src/assistant/assistant-access.js';
import { AssistantModule } from '../src/assistant/assistant.module.js';
import { AssistantRepository } from '../src/assistant/assistant.repository.js';
import { RATE_LIMIT_STORE } from '../src/common/rate-limit.guard.js';
import { DomainNotFoundError } from '../src/common/errors.js';

const id = '11111111-1111-4111-8111-111111111111';
const token = 'a'.repeat(43);
const authorization = `Bearer ${token}`;
const input = { clientMessageId: '22222222-2222-4222-8222-222222222222', expectedRevision: 0, text: 'Help me choose' };
const snapshot = { id: '1', sessionId: id, ...input, inputText: input.text, eventVersion: 1,
  status: 'queued', phase: 'queued', reply: null, errorCode: null };
const originalEnvironment = { ...process.env };
afterEach(() => { process.env = { ...originalEnvironment }; });
function enabled() {
  Object.assign(process.env, { ASSISTANT_ENABLED: 'true', ASSISTANT_MODEL: 'mock', AI_BASE_URL: 'http://localhost', AI_API_KEY: 'mock' });
}
function fixture() {
  const headers = new Map<string, string>();
  const reply = { header(name: string, value: string) { headers.set(name.toLowerCase(), value); return this; },
    code(value: number) { this.statusCode = value; return this; }, statusCode: 200 };
  let accepted = 0;
  let creates = 0;
  const repo = {
    async createSession() { creates++; return { sessionId: id, accessToken: token, revision: 0 }; },
    async readSession(sessionId: string, accessToken: string) {
      if (sessionId !== id || accessToken !== token) throw new DomainNotFoundError('ASSISTANT_NOT_FOUND', 'missing');
      return { id, revision: 0, needs: emptyShoppingNeeds(), turns: [] };
    },
    async readTurn(sessionId: string, turnId: string, accessToken: string) {
      await this.readSession(sessionId, accessToken);
      if (turnId !== '1') throw new DomainNotFoundError('ASSISTANT_NOT_FOUND', 'missing');
      return snapshot;
    },
    async acceptTurn(sessionId: string, accessToken: string, value: unknown) {
      await this.readSession(sessionId, accessToken);
      assert.deepEqual(value, input);
      return { snapshot, created: accepted++ === 0 };
    },
    async cancelTurn(sessionId: string, turnId: string, accessToken: string) {
      await this.readTurn(sessionId, turnId, accessToken);
      return { ...snapshot, status: 'cancelled' };
    },
    async deleteSession(sessionId: string, accessToken: string) { await this.readSession(sessionId, accessToken); },
  };
  const access = new AssistantAccess({ hit: async () => ({ count: 1, retryAfterMs: 60_000 }) });
  const controller = new AssistantController(repo as unknown as AssistantRepository, access);
  return { controller, reply: reply as never, headers, repo, creates: () => creates };
}
const hasStatus = (status: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === status;

test('status is public, defaults disabled, exposes no configuration and is not cached', () => {
  delete process.env.ASSISTANT_ENABLED;
  const { controller, reply, headers } = fixture();
  assert.deepEqual(controller.status(reply), { enabled: false });
  assert.equal(headers.get('cache-control'), 'no-store');
});

test('disabled feature rejects generation but permits authenticated reads, cancellation and deletion', async () => {
  delete process.env.ASSISTANT_ENABLED;
  const { controller, reply, headers, creates } = fixture();
  await assert.rejects(controller.create({}, { ip: 'local' }, reply), hasStatus(503));
  await assert.rejects(controller.send(id, authorization, input, { ip: 'local' }, reply), hasStatus(503));
  assert.equal((await controller.read(id, authorization, reply)).id, id);
  assert.equal((await controller.cancel(id, '1', authorization, undefined, reply)).status, 'cancelled');
  await controller.remove(id, authorization, reply);
  assert.equal(creates(), 0);
  assert.equal(headers.get('cache-control'), 'no-store');
});

test('strict Bearer syntax and foreign credentials uniformly return 404', async () => {
  enabled();
  const { controller, reply } = fixture();
  for (const auth of [undefined, '', 'Bearer', `bearer ${token}`, `Bearer  ${token}`, `Bearer ${token} `,
    `Bearer ${token}\n`, `Bearer ${token},${token}`, `Bearer ${'b'.repeat(43)}`]) {
    await assert.rejects(controller.read(id, auth, reply), hasStatus(404));
    await assert.rejects(controller.cancel(id, '1', auth, undefined, reply), hasStatus(404));
    await assert.rejects(controller.remove(id, auth, reply), hasStatus(404));
  }
  await assert.rejects(controller.read(input.clientMessageId, authorization, reply), hasStatus(404));
});

test('creation accepts only absent or empty object bodies and turns reject extra fields and malformed input', async () => {
  enabled();
  const { controller, reply, headers } = fixture();
  for (const body of [null, [], 'text', 1, false, { role: 'system' }]) {
    await assert.rejects(controller.create(body, {}, reply), hasStatus(400));
  }
  for (const body of [null, undefined, [], 'text', 1, false, {},
    { ...input, role: 'system' }, { ...input, model: 'paid' }, { ...input, text: 'x'.repeat(2001) },
    { ...input, text: '' }, { ...input, text: '\u0000' }, { ...input, expectedRevision: -1 },
    { ...input, expectedRevision: 0.5 }, { ...input, expectedRevision: '0' },
    { ...input, clientMessageId: 'not-a-uuid' }]) {
    await assert.rejects(controller.send(id, authorization, body, {}, reply), hasStatus(400));
  }
  await assert.rejects(controller.cancel(id, '1', authorization, { role: 'system' }, reply), hasStatus(400));
  assert.equal(headers.get('cache-control'), 'no-store');
  assert.equal((await controller.create({}, {}, reply)).sessionId, id);
  assert.equal((await controller.create(undefined, {}, reply)).revision, 0);
});

test('send returns a snapshot with an accepted status and preserves repository idempotency', async () => {
  enabled();
  const { controller, reply } = fixture();
  assert.deepEqual(await controller.send(id, authorization, input, {}, reply), { snapshot, created: true });
  assert.equal((reply as { statusCode: number }).statusCode, 202);
  assert.deepEqual(await controller.send(id, authorization, input, {}, reply), { snapshot, created: false });
  assert.equal((reply as { statusCode: number }).statusCode, 200);
});

test('unexpected persistence errors return a generic unavailable response', async () => {
  enabled();
  const { controller, repo, reply } = fixture();
  repo.readSession = async () => { throw new Error('postgres://production:secret@host'); };
  await assert.rejects(controller.read(id, authorization, reply), error => {
    assert.ok(hasStatus(503)(error));
    assert.doesNotMatch(JSON.stringify((error as HttpException).getResponse()), /production|secret|postgres/);
    return true;
  });
});

test('admission shares the injected store, separates create and turn quotas and honors TRUST_PROXY', async () => {
  const counts = new Map<string, number>();
  const access = new AssistantAccess({ async hit(key, window) {
    assert.equal(window, 60_000);
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return { count, retryAfterMs: 1500 };
  } });
  const { reply, headers } = fixture();
  const request = { ip: 'socket', headers: { 'x-forwarded-for': 'forwarded, proxy' } };
  delete process.env.TRUST_PROXY;
  for (let i = 0; i < 5; i++) await access.admit('session', request, reply);
  await assert.rejects(access.admit('session', request, reply), hasStatus(429));
  assert.equal(headers.get('retry-after'), '2');
  for (let i = 0; i < 10; i++) await access.admit('turn', request, reply);
  await assert.rejects(access.admit('turn', request, reply), hasStatus(429));
  assert.ok([...counts.keys()].every(key => key.endsWith(':socket')));
  process.env.TRUST_PROXY = 'true';
  await access.admit('session', request, reply);
  assert.ok([...counts.keys()].some(key => key.endsWith(':forwarded')));
});

test('admission fails closed if its shared rate store is unavailable', async () => {
  const access = new AssistantAccess({ hit: async () => { throw new Error('redis password'); } });
  await assert.rejects(access.admit('session', {}), hasStatus(503));
});

test('module injects shared admission without database or Redis, and HTTP statuses and guard failures are no-store', async () => {
  enabled();
  const { repo } = fixture();
  @Global()
  @Module({
    providers: [{ provide: RATE_LIMIT_STORE, useValue: { hit: async () => ({ count: 1, retryAfterMs: 60_000 }) } }],
    exports: [RATE_LIMIT_STORE],
  })
  class SharedStoreModule {}
  let deny = false;
  const module = await Test.createTestingModule({
    imports: [SharedStoreModule, AssistantModule],
    providers: [{ provide: APP_GUARD, useValue: { canActivate() {
      if (deny) throw new HttpException('rate limited', 429);
      return true;
    } } }],
  }).overrideProvider(AssistantRepository).useValue(repo).compile();
  const access = module.get(AssistantAccess);
  access.acquire = async () => ({ async renew() {}, async release() {} });
  const app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ logger: false }));
  app.enableVersioning({ type: VersioningType.URI });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  try {
    const server = app.getHttpAdapter().getInstance();
    const base = '/v1/assistant';
    const created = await server.inject({ method: 'POST', url: `${base}/sessions`, payload: {} });
    assert.equal(created.statusCode, 201);
    assert.equal(created.headers['cache-control'], 'no-store');
    const headers = { authorization };
    for (const [method, path, payload, status] of [
      ['GET', '/status', undefined, 200],
      ['GET', `/sessions/${id}`, undefined, 200],
      ['POST', `/sessions/${id}/turns`, input, 202],
      ['POST', `/sessions/${id}/turns`, input, 200],
      ['POST', `/sessions/${id}/turns/1/cancel`, {}, 200],
      ['POST', '/sessions', { role: 'system' }, 400],
      ['DELETE', `/sessions/${id}`, undefined, 204],
    ] as const) {
      const response = await server.inject({ method, url: base + path, headers, payload });
      assert.equal(response.statusCode, status, `${method} ${path}: ${response.body}`);
      assert.equal(response.headers['cache-control'], 'no-store');
    }
    for (const body of ['null', '[]', '"text"', '0', 'false', '{"role":"system"}', '{broken']) {
      for (const path of ['/sessions', `/sessions/${id}/turns`, `/sessions/${id}/turns/1/cancel`]) {
        const response = await server.inject({ method: 'POST', url: base + path,
          headers: { ...headers, 'content-type': 'application/json' }, payload: body });
        assert.equal(response.statusCode, 400, `${path}: ${body}`);
        assert.equal(response.headers['cache-control'], 'no-store');
      }
    }
    const missing = await server.inject({ method: 'GET', url: `${base}/sessions/${id}` });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.headers['cache-control'], 'no-store');
    const terminal = { ...snapshot, status: 'cancelled', phase: 'cancelled' };
    repo.readTurn = async () => terminal;
    const stream = await server.inject({ method: 'GET', url: `${base}/sessions/${id}/turns/1/events`, headers });
    assert.equal(stream.statusCode, 200);
    assert.equal(stream.headers['cache-control'], 'no-store');
    assert.match(stream.body, /^event: snapshot\ndata:/);
    delete process.env.ASSISTANT_ENABLED;
    const disabled = await server.inject({ method: 'POST', url: `${base}/sessions`, payload: {} });
    assert.equal(disabled.statusCode, 503);
    assert.equal(disabled.headers['cache-control'], 'no-store');
    deny = true;
    const denied = await server.inject({ method: 'POST', url: `${base}/sessions`, payload: {} });
    assert.equal(denied.statusCode, 429);
    assert.equal(denied.headers['cache-control'], 'no-store');
  } finally { await app.close(); }
});

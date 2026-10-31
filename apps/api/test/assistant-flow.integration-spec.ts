import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { Global, Module, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Redis } from 'ioredis';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import {
  emptyShoppingNeeds, validateSessionSnapshot, validateTurnSnapshot,
  type SessionSnapshot, type TurnSnapshot,
} from '@price-comparison/catalog/assistant-contract';
import { createAiConcurrencyCoordinator } from '../src/ai/ai-concurrency.js';
import { createStreamingCall } from '../src/ai/llm-runtime.js';
import { AssistantModule } from '../src/assistant/assistant.module.js';
import { AssistantRepository } from '../src/assistant/assistant.repository.js';
import { AssistantService } from '../src/assistant/assistant.service.js';
import type { CatalogService } from '../src/catalog/catalog.service.js';
import { RATE_LIMIT_STORE, RedisRateLimitStore } from '../src/common/rate-limit.guard.js';
import { DATABASE } from '../src/database/database.providers.js';
import { up } from '../src/database/migrations/027_assistant_20261031.js';
import type { DatabaseSchema } from '../src/database/types.js';
import { JobsRepository } from '../src/jobs/jobs.repository.js';
import { WorkerRuntime } from '../src/workers/worker-runtime.js';

function testServiceUrl(value: string | undefined, name: string): string {
  assert.ok(value, `Configure ${name} for a dedicated test service`);
  return value;
}

async function* snapshots(response: Response): AsyncGenerator<TurnSnapshot> {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/u);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      let end: number;
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (frame.startsWith(':')) continue;
        assert.match(frame, /^event: snapshot\n/u, 'stream must not fail or expose a different event');
        const data = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
        yield JSON.parse(data) as TurnSnapshot;
      }
      if (chunk.done) {
        assert.equal(pending, '', 'SSE must end on a complete frame');
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

test('real database HTTP/SSE flow uses shared worker and fragmented mock model, restores, cancels and deletes', { timeout: 30_000 }, async context => {
  const databaseUrl = testServiceUrl(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL');
  const redisUrl = testServiceUrl(process.env.TEST_REDIS_URL, 'TEST_REDIS_URL');
  const previousEnvironment = { ...process.env };
  const schema = `assistant_flow_${randomUUID().replaceAll('-', '')}`;
  const prefix = `test:${schema}`;
  const redisKeys = new Set<string>([`${prefix}:ai`]);
  const sessionIds = new Set<string>();
  const admin = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 2000, statement_timeout: 5000 });
  let db: Kysely<DatabaseSchema> | undefined;
  let redis: Redis | undefined;
  let app: NestFastifyApplication | undefined;
  let worker: WorkerRuntime | undefined;
  let unblockModel!: () => void;
  const modelUnblocked = new Promise<void>(resolve => { unblockModel = resolve; });
  context.after(async () => {
    unblockModel();
    try { await worker?.stop(); }
    finally {
      try { await app?.close(); }
      finally {
        try { await db?.destroy(); }
        finally {
          try {
            for (const sessionId of sessionIds) redisKeys.add(`assistant:streams:${sessionId}`);
            if (redis?.status === 'ready') await redis.del(...redisKeys);
          } finally {
            redis?.disconnect();
            try { await admin.query(`drop schema if exists "${schema}" cascade`); }
            finally { await admin.end(); process.env = previousEnvironment; }
          }
        }
      }
    }
  });

  Object.assign(process.env, {
    ASSISTANT_ENABLED: 'true', ASSISTANT_MODEL: 'flow-mock',
    AI_BASE_URL: 'http://model.invalid/v1', AI_API_KEY: 'local-mock-only', AI_TIMEOUT_MS: '5000',
    DATABASE_URL: databaseUrl, REDIS_URL: redisUrl, RATE_LIMIT_REDIS_URL: redisUrl,
  });
  await admin.query(`create schema "${schema}"`);
  const pool = new Pool({
    connectionString: databaseUrl, options: `-c search_path=${schema}`,
    max: 5, connectionTimeoutMillis: 2000, statement_timeout: 5000,
  });
  db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
  await up(db as unknown as Kysely<unknown>);
  redis = new Redis(redisUrl, { enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 2000, commandTimeout: 2000 });
  redis.on('error', () => undefined);
  if (redis.status !== 'ready') await once(redis, 'ready', { signal: AbortSignal.timeout(3000) });
  const sharedRates = new RedisRateLimitStore(redis);
  const rateStore = { hit(key: string, windowMs: number) {
    const isolatedKey = `${prefix}:${key}`;
    redisKeys.add(isolatedKey);
    return sharedRates.hit(isolatedKey, windowMs);
  } };
  @Global()
  @Module({ providers: [{ provide: DATABASE, useValue: db }, { provide: RATE_LIMIT_STORE, useValue: rateStore }],
    exports: [DATABASE, RATE_LIMIT_STORE] })
  class TestInfrastructureModule {}
  const module = await Test.createTestingModule({ imports: [TestInfrastructureModule, AssistantModule] }).compile();
  app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ logger: false }));
  app.enableVersioning({ type: VersioningType.URI });
  await app.listen(0, '127.0.0.1');
  const base = `${await app.getUrl()}/v1/assistant`;
  const repository = app.get(AssistantRepository);
  const jobs = new JobsRepository(db);
  const understanding = {
    intent: 'clarify', patch: { preferences: ['lower_price'] },
    evidence: [{ field: 'preferences', quote: '便宜一点' }],
    question: '主要用来做什么？', options: ['工作', '学习'],
  };
  const output = JSON.stringify(understanding);
  const contentParts = [output.slice(0, 12), output.slice(12, 39), output.slice(39)];
  assert.throws(() => JSON.parse(contentParts[0]), 'first content delta is incomplete JSON');
  const modelFrame = (content: string) => `data: ${JSON.stringify({
    id: 'flow-response', model: 'flow-mock', choices: [{ index: 0, delta: { content } }],
  })}\n\n`;
  let modelRequests = 0;
  let wireChunks = 0;
  let partialDelivered!: () => void;
  const modelStarted = new Promise<void>(resolve => { partialDelivered = resolve; });
  const mockFetch: typeof fetch = async (url, init) => {
    assert.match(String(url), /^http:\/\/model\.invalid\/v1\/chat\/completions$/u);
    assert.equal(++modelRequests, 1, 'idempotency and refresh must never issue another model call');
    const request = JSON.parse(String(init?.body));
    assert.equal(request.stream, true);
    assert.equal(request.model, 'flow-mock');
    assert.equal(request.messages.length, 2);
    assert.equal(JSON.parse(request.messages[1].content).userText, '便宜一点');
    return new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        const enqueue = (text: string) => {
          const bytes = new TextEncoder().encode(text);
          for (let index = 0; index < bytes.length; index += 11) {
            wireChunks++;
            controller.enqueue(bytes.slice(index, index + 11));
          }
        };
        enqueue(modelFrame(contentParts[0]));
        partialDelivered();
        await modelUnblocked;
        if (init?.signal?.aborted) { controller.error(init.signal.reason); return; }
        enqueue(contentParts.slice(1).map(modelFrame).join(''));
        enqueue(`data: ${JSON.stringify({
          id: 'flow-response', model: 'flow-mock',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        })}\n\ndata: [DONE]\n\n`);
        controller.close();
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  };
  const modelCall = createStreamingCall({
    AI_BASE_URL: 'http://model.invalid/v1', AI_API_KEY: 'local-mock-only', AI_TIMEOUT_MS: '5000',
  }, mockFetch);
  const service = new AssistantService(repository, {} as CatalogService, modelCall, 'flow-mock');
  let settled!: () => void;
  const workerSettled = new Promise<void>(resolve => { settled = resolve; });
  worker = new WorkerRuntime({
    kind: 'assistant_turn', workerId: `${prefix}:worker`, concurrency: 1, aiConcurrency: 1, aiStage: 'assistant',
    aiCoordinator: createAiConcurrencyCoordinator(redis, { concurrency: 1, key: `${prefix}:ai`, pollMs: 5 }),
    heartbeatMs: 100, leaseMs: 10_000,
    service: {
      claimNext: (...args) => jobs.claimNext(...args),
      claimAvailable: (...args) => jobs.claimAvailable(...args),
      heartbeat: (...args) => jobs.heartbeat(...args),
      complete: (...args) => jobs.complete(...args),
      fail: (...args) => jobs.fail(...args),
      requeue: (...args) => jobs.requeue(...args),
      onSettled: () => settled(),
    },
    handler: (job, signal) => service.runTurn(job, signal),
  });
  const http = async (method: string, path: string, status: number, body?: unknown, token?: string) => {
    const response = await fetch(base + path, {
      method, signal: AbortSignal.timeout(10_000), redirect: 'error',
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.status, status, `${method} ${path}: ${await (response.status !== status ? response.text() : Promise.resolve(''))}`);
    assert.equal(response.headers.get('cache-control'), 'no-store', `${method} ${path}`);
    return response;
  };

  assert.deepEqual(await (await http('GET', '/status', 200)).json(), { enabled: true });
  const credentials = await (await http('POST', '/sessions', 201, {})).json() as { sessionId: string; accessToken: string; revision: number };
  const { sessionId, accessToken } = credentials;
  sessionIds.add(sessionId);
  assert.equal(credentials.revision, 0);
  assert.match(accessToken, /^[A-Za-z0-9_-]{43}$/u);
  const path = `/sessions/${sessionId}`;
  const input = { clientMessageId: randomUUID(), expectedRevision: 0, text: '便宜一点' };
  const accepted = await (await http('POST', `${path}/turns`, 202, input, accessToken)).json() as { snapshot: TurnSnapshot; created: boolean };
  const repeated = await (await http('POST', `${path}/turns`, 200, input, accessToken)).json();
  assert.deepEqual(repeated, { snapshot: accepted.snapshot, created: false });
  assert.equal(accepted.created, true);
  assert.equal(accepted.snapshot.status, 'queued');
  assert.equal((await db.selectFrom('assistant_turns').select('id').execute()).length, 1);
  await http('POST', `${path}/turns`, 409, { ...input, text: 'different content' }, accessToken);

  const streamResponse = await http('GET', `${path}/turns/${accepted.snapshot.id}/events`, 200, undefined, accessToken);
  const stream = snapshots(streamResponse);
  const initial = await stream.next();
  assert.equal(initial.done, false);
  assert.deepEqual(initial.value, accepted.snapshot);
  assert.equal(await worker.runOnce(), 1);
  await Promise.race([modelStarted, workerSettled.then(() => { throw new Error('worker settled before mock model started'); })]);
  const partial = await db.selectFrom('assistant_turns').selectAll().where('session_id', '=', sessionId).executeTakeFirstOrThrow();
  assert.equal(partial.status, 'running');
  assert.equal(partial.reply, null);
  assert.equal(partial.requests_started, 1);
  assert.equal(partial.request_in_flight, true);
  const beforeCommit = await repository.readSession(sessionId, accessToken);
  assert.equal(beforeCommit.revision, 0);
  assert.deepEqual(beforeCommit.needs, emptyShoppingNeeds());
  assert.equal(await redis.hlen(`${prefix}:ai`), 1, 'model executes under the real shared Redis lease');
  unblockModel();
  const events: TurnSnapshot[] = [initial.value!];
  for await (const snapshot of stream) events.push(snapshot);
  await workerSettled;
  const final = events.at(-1)!;
  assert.equal(final.status, 'succeeded', JSON.stringify(final));
  assert.ok(events.length >= 2);
  assert.ok(events.every((snapshot, index) => index === 0 || snapshot.eventVersion > events[index - 1].eventVersion));
  assert.deepEqual(final.reply, {
    kind: 'question', text: understanding.question, options: understanding.options,
    needs: { ...emptyShoppingNeeds(), preferences: ['lower_price'] }, cards: [],
  });
  assert.ok(wireChunks > 3, 'both JSON deltas and wire/SSE frames are fragmented');
  assert.equal(modelRequests, 1);
  assert.equal(await redis.hlen(`${prefix}:ai`), 0, 'settled worker releases shared concurrency');
  assert.equal(await redis.zcard(`assistant:streams:${sessionId}`), 0, 'terminal stream releases its connection slot');
  const restored = await (await http('GET', path, 200, undefined, accessToken)).json() as SessionSnapshot;
  assert.equal(restored.revision, 1);
  assert.deepEqual(restored.turns, [final]);
  assert.deepEqual(restored.needs.preferences, ['lower_price']);
  const reconnect = snapshots(await http('GET', `${path}/turns/${final.id}/events`, 200, undefined, accessToken));
  const reconnectEvents: TurnSnapshot[] = [];
  for await (const snapshot of reconnect) reconnectEvents.push(snapshot);
  assert.deepEqual(reconnectEvents, [final], 'terminal reconnect returns stored result without rerunning');

  const secondInput = { clientMessageId: randomUUID(), expectedRevision: 1, text: '再问一次' };
  const second = await (await http('POST', `${path}/turns`, 202, secondInput, accessToken)).json() as { snapshot: TurnSnapshot };
  const cancelled = await (await http('POST', `${path}/turns/${second.snapshot.id}/cancel`, 200, {}, accessToken)).json() as TurnSnapshot;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.errorCode, 'CANCELLED', 'assert actual backend code without normalization');
  assert.equal(cancelled.reply, null);
  assert.deepEqual(await (await http('POST', `${path}/turns/${cancelled.id}/cancel`, 200, {}, accessToken)).json(), cancelled);
  assert.equal(await worker.runOnce(), 0, 'cancelled queued turn never reaches the model');

  const wrongToken = 'x'.repeat(43) === accessToken ? 'y'.repeat(43) : 'x'.repeat(43);
  for (const candidate of [undefined, wrongToken]) {
    for (const [method, endpoint] of [
      ['GET', path], ['GET', `${path}/turns/${final.id}/events`],
      ['POST', `${path}/turns/${cancelled.id}/cancel`], ['DELETE', path],
    ]) {
      await http(method, endpoint, 404, undefined, candidate);
    }
  }
  assert.equal((await (await http('GET', path, 200, undefined, accessToken)).json() as SessionSnapshot).revision, 1);
  const third = await (await http('POST', `${path}/turns`, 202,
    { clientMessageId: randomUUID(), expectedRevision: 1, text: '等待超时' }, accessToken)).json() as { snapshot: TurnSnapshot };
  await sql`update assistant_turns set deadline_at = now() - interval '1 second'
    where id = ${BigInt(third.snapshot.id)}`.execute(db);
  const timedOutSession = await (await http('GET', path, 200, undefined, accessToken)).json() as SessionSnapshot;
  const timedOut = timedOutSession.turns.at(-1)!;
  assert.equal(timedOut.status, 'failed');
  assert.equal(timedOut.errorCode, 'TURN_TIMEOUT', 'expiry uses the real backend code');
  assert.equal(timedOutSession.revision, 1);
  assert.equal(await worker.runOnce(), 0);
  assert.equal(modelRequests, 1);
  const deleted = await http('DELETE', path, 204, undefined, accessToken);
  assert.equal(await deleted.text(), '');
  await http('GET', path, 404, undefined, accessToken);
  await http('GET', `${path}/turns/${final.id}/events`, 404, undefined, accessToken);
  assert.equal((await db.selectFrom('assistant_sessions').select('id').execute()).length, 0);
  assert.equal((await db.selectFrom('assistant_turns').select('id').execute()).length, 0);

  // Run contract assertions after the full flow so one mismatch cannot hide cleanup or isolation failures.
  await context.test('successful SSE and restored history satisfy the shared validators', () => {
    for (const snapshot of events) assert.deepEqual(validateTurnSnapshot(snapshot), snapshot);
    assert.deepEqual(validateSessionSnapshot(restored), restored);
  });
  await context.test('actual CANCELLED snapshot satisfies the shared validator', () => {
    assert.deepEqual(validateTurnSnapshot(cancelled), cancelled);
  });
  await context.test('actual TURN_TIMEOUT snapshot and history satisfy the shared validators', () => {
    assert.deepEqual(validateTurnSnapshot(timedOut), timedOut);
    assert.deepEqual(validateSessionSnapshot(timedOutSession), timedOutSession);
  });
});

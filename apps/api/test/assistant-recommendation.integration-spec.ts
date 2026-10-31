import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { Redis } from 'ioredis';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { validateAssistantReply, validateSessionSnapshot } from '@price-comparison/catalog/assistant-contract';
import { migrationProvider } from '../scripts/migrate.js';
import { createAiConcurrencyCoordinator } from '../src/ai/ai-concurrency.js';
import { createStreamingCall } from '../src/ai/llm-runtime.js';
import { AssistantRepository } from '../src/assistant/assistant.repository.js';
import { AssistantService } from '../src/assistant/assistant.service.js';
import { createCache } from '../src/cache/cache.js';
import { CatalogRepository } from '../src/catalog/catalog.repository.js';
import { CatalogService } from '../src/catalog/catalog.service.js';
import type { DatabaseSchema } from '../src/database/types.js';
import { JobsRepository } from '../src/jobs/jobs.repository.js';
import { WorkerRuntime } from '../src/workers/worker-runtime.js';

function testServiceUrl(value: string | undefined, name: string): string {
  assert.ok(value, `Configure ${name} for a dedicated test service`);
  return value;
}

test('real catalog recommendation persists canonical UTC cards from PostgreSQL offset/microsecond JSON with distinct source and standard IDs',
  { timeout: 30_000 }, async context => {
    const databaseUrl = testServiceUrl(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL');
    const redisUrl = testServiceUrl(process.env.TEST_REDIS_URL, 'TEST_REDIS_URL');
    const schema = `assistant_recommendation_${randomUUID().replaceAll('-', '')}`;
    const concurrencyKey = `test:${schema}:ai`;
    const now = () => new Date('2026-10-31T12:00:00Z');
    const admin = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 2000, statement_timeout: 5000 });
    const cache = createCache();
    let database: Kysely<DatabaseSchema> | undefined;
    let redis: Redis | undefined;
    let worker: WorkerRuntime | undefined;
    context.after(async () => {
      try { await worker?.stop(); }
      finally {
        try { await cache.disconnect(); }
        finally {
          try { await database?.destroy(); }
          finally {
            try { if (redis?.status === 'ready') await redis.del(concurrencyKey); }
            finally {
              redis?.disconnect();
              try { await admin.query(`drop schema if exists "${schema}" cascade`); }
              finally { await admin.end(); }
            }
          }
        }
      }
    });
    await admin.query(`create schema "${schema}"`);
    database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: new Pool({
      connectionString: databaseUrl, options: `-c search_path=${schema},public -c timezone=Asia/Kolkata`,
      max: 5, connectionTimeoutMillis: 2000, statement_timeout: 5000,
    }) }) });
    const migration = await new Migrator({
      db: database, provider: migrationProvider, migrationTableSchema: schema,
    }).migrateToLatest();
    if (migration.error) throw migration.error;
    assert.ok(migration.results?.some(result => result.migrationName === '027_assistant_20261031' && result.status === 'Success'));

    const shop = await database.insertInto('shops').values({
      name: 'Recommendation fixture shop', platform: 'test', enabled: true,
      url: 'https://assistant-recommendation.invalid',
    }).returning('id').executeTakeFirstOrThrow();
    const standard = await database.insertInto('standard_products').values({
      name: 'Claude Pro', platform: 'anthropic', canonical_platform: 'anthropic',
      canonical_vendor: 'anthropic', canonical_family: 'claude', canonical_product: 'claude',
      canonical_tier: 'pro', verification_state: 'verified',
    }).returning('id').executeTakeFirstOrThrow();
    // Reserve a source ID so the two independent identity sequences cannot accidentally match.
    await database.insertInto('products').values({
      shop_id: shop.id, external_id: 'unpublished', name: 'Unpublished fixture', spec: '',
      url: 'https://assistant-recommendation.invalid/unpublished', normalized_key: 'unpublished',
    }).execute();
    const source = await database.insertInto('products').values({
      shop_id: shop.id, external_id: 'claude-pro', name: 'Claude Pro source fixture', spec: '1 month',
      url: 'https://assistant-recommendation.invalid/claude-pro', normalized_key: 'claude-pro',
    }).returning('id').executeTakeFirstOrThrow();
    assert.notEqual(String(source.id), String(standard.id));
    await database.insertInto('standard_product_members').values({
      standard_product_id: standard.id, product_id: source.id, publication_state: 'published',
    }).execute();
    await database.insertInto('product_tags').values([
      { name: 'access', value: 'dedicated' }, { name: 'duration', value: '1 month' },
      { name: 'warranty', value: 'covered' }, { name: 'warranty_days', value: '30' },
    ].map(tag => ({ product_id: source.id, ...tag }))).execute();
    const capturedAt = sql<Date>`timestamptz '2026-10-31T11:59:00.123456Z'`;
    await database.insertInto('offers').values({
      product_id: source.id, price: '49.00', currency: 'CNY', settlement_price: '49.00',
      settlement_quantity: 1, settlement_total_amount: '49.00', settlement_payment_method: 'alipay',
      captured_at: capturedAt, settlement_verified_at: capturedAt,
      stock_available: true, is_stale: false, idempotency_key: 'recommendation',
    }).execute();
    const catalog = new CatalogService(new CatalogRepository(database, { now: () => now().getTime(), ttlMs: 3_600_000 }), cache);
    const product = await catalog.resolvePublicProductIdentity({ platform: 'anthropic', product: 'claude', tier: 'pro' });
    assert.equal(product?.id, String(standard.id));
    const page = await catalog.getCatalog({
      standardProductId: String(standard.id), currency: 'CNY', detailKind: 'offers', detailPageSize: 20,
    });
    const detail = page.items[0]?.detail;
    assert.ok(detail?.kind === 'offers');
    assert.equal(detail.entries.length, 1);
    const rawOffer = detail.entries[0]!;
    assert.equal(rawOffer.productId, String(source.id));
    // Exercise PostgreSQL's actual JSON representation, not a JavaScript Date fixture.
    assert.match(rawOffer.capturedAt, /\.123456\+05:30$/u);
    assert.match(rawOffer.priceExpiresAt!, /\.123456\+05:30$/u);

    redis = new Redis(redisUrl, { enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 2000, commandTimeout: 2000 });
    redis.on('error', () => undefined);
    if (redis.status !== 'ready') await once(redis, 'ready', { signal: AbortSignal.timeout(3000) });
    const repository = new AssistantRepository(database);
    const jobs = new JobsRepository(database);
    const session = await repository.createSession();
    const accepted = await repository.acceptTurn(session.sessionId, session.accessToken, {
      clientMessageId: randomUUID(), expectedRevision: 0, text: 'anthropic coding',
    });
    const queued = await database.selectFrom('assistant_turns').select('deadline_at')
      .where('id', '=', BigInt(accepted.snapshot.id)).executeTakeFirstOrThrow();
    assert.ok(queued.deadline_at.getTime() > Date.now(), 'turn deadline remains on real database time');
    let requests = 0;
    const contentChunks: number[] = [];
    const service = new AssistantService(repository, catalog, createStreamingCall({
      AI_BASE_URL: 'http://model.invalid/v1', AI_API_KEY: 'local-mock-only', AI_TIMEOUT_MS: '5000',
    }, async (url, init) => {
      assert.equal(String(url), 'http://model.invalid/v1/chat/completions');
      const request = JSON.parse(String(init?.body));
      assert.equal(request.stream, true);
      assert.equal(request.model, 'recommendation-mock');
      const prompt = JSON.parse(request.messages.at(-1).content);
      const call = ++requests;
      assert.ok(call <= 2, 'one recommendation must not start a third model request');
      assert.equal(await redis!.hlen(concurrencyKey), 1, 'both model calls use the shared concurrency lease');
      let output: string;
      if (call === 1) {
        assert.equal(prompt.userText, 'anthropic coding');
        output = JSON.stringify({
          intent: 'recommend', patch: { platform: 'anthropic', purpose: 'coding' },
          evidence: [{ field: 'platform', quote: 'anthropic' }, { field: 'purpose', quote: 'coding' }],
          question: null, options: [],
        });
      } else {
        assert.equal(prompt.candidates.length, 1);
        const candidate = prompt.candidates[0];
        assert.equal(candidate.productId, String(source.id));
        assert.equal(candidate.name, 'Claude Pro');
        assert.ok(candidate.evidence.length > 0);
        output = JSON.stringify({ selections: [{
          productId: candidate.productId, evidenceIds: [candidate.evidence[0].id],
        }] });
      }
      const parts = [output.slice(0, 9), output.slice(9, 31), output.slice(31)];
      contentChunks.push(parts.length);
      const wire = parts.map(content => `data: ${JSON.stringify({
        id: `recommendation-${call}`, model: 'recommendation-mock', choices: [{ index: 0, delta: { content } }],
      })}\n\n`).join('') + `data: ${JSON.stringify({
        id: `recommendation-${call}`, model: 'recommendation-mock',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      })}\n\ndata: [DONE]\n\n`;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        const bytes = new TextEncoder().encode(wire);
        for (let offset = 0; offset < bytes.length; offset += 17) controller.enqueue(bytes.slice(offset, offset + 17));
        controller.close();
      } }), { headers: { 'content-type': 'text/event-stream' } });
    }), 'recommendation-mock', now);
    let resolveSettled!: () => void;
    const settled = new Promise<void>(resolve => { resolveSettled = resolve; });
    worker = new WorkerRuntime({
      kind: 'assistant_turn', workerId: schema, concurrency: 1, aiConcurrency: 1, aiStage: 'assistant',
      aiCoordinator: createAiConcurrencyCoordinator(redis, { concurrency: 1, key: concurrencyKey, pollMs: 5 }),
      heartbeatMs: 100, leaseMs: 10_000,
      service: {
        claimNext: (...args) => jobs.claimNext(...args), claimAvailable: (...args) => jobs.claimAvailable(...args),
        heartbeat: (...args) => jobs.heartbeat(...args), complete: (...args) => jobs.complete(...args),
        fail: (...args) => jobs.fail(...args), requeue: (...args) => jobs.requeue(...args),
        onSettled: () => resolveSettled(),
      },
      handler: (job, signal) => service.runTurn(job, signal),
    });
    assert.equal(await worker.runOnce(), 1);
    await settled;
    const restored = await repository.readSession(session.sessionId, session.accessToken);
    assert.equal(restored.turns[0]?.status, 'succeeded', JSON.stringify(restored));
    assert.deepEqual(validateSessionSnapshot(restored), restored);
    assert.equal(restored.revision, 1);
    assert.equal(restored.needs.purpose, 'coding');
    assert.equal(requests, 2);
    assert.deepEqual(contentChunks, [3, 3]);
    const reply = restored.turns[0]!.reply!;
    assert.equal(reply.kind, 'recommendation');
    assert.equal(reply.cards.length, 1);
    const card = reply.cards[0]!;
    assert.equal(card.standardProductId, String(standard.id));
    assert.equal(card.productId, String(source.id));
    assert.equal(card.shopId, String(shop.id));
    assert.equal(card.detailPath, `/products/${standard.id}`);
    assert.notEqual(card.detailPath, `/products/${source.id}`);
    assert.equal((await catalog.getProduct(card.standardProductId))?.id, card.standardProductId);
    assert.equal(card.price, '49.00');
    assert.equal(card.currency, 'CNY');
    assert.equal(card.capturedAt, '2026-10-31T11:59:00.123Z');
    assert.equal(card.priceExpiresAt, '2026-10-31T12:59:00.123Z');
    for (const field of ['capturedAt', 'priceExpiresAt'] as const) {
      assert.match(card[field], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.123Z$/u);
      assert.equal(Date.parse(card[field]), Date.parse(rawOffer[field]!));
    }
    assert.equal(Date.parse(card.priceExpiresAt) - Date.parse(card.capturedAt), 3_600_000);
    assert.ok(card.reasons.length > 0);
    assert.ok(card.caveats.length > 0);
    assert.ok(card.evidenceIds.length > 0);
    assert.throws(() => validateAssistantReply({
      ...reply, cards: [{ ...card, capturedAt: rawOffer.capturedAt, priceExpiresAt: rawOffer.priceExpiresAt }],
    }), /timestamp/u, 'passing actual catalog timestamps through unchanged must reproduce the original failure');
    const stored = await database.selectFrom('assistant_turns').selectAll()
      .where('id', '=', BigInt(accepted.snapshot.id)).executeTakeFirstOrThrow();
    assert.deepEqual(stored.reply, reply);
    assert.equal(stored.requests_started, 2);
    assert.equal(stored.request_in_flight, false);
    assert.ok(Array.isArray(stored.usage));
    assert.equal(stored.usage.length, 2);
    assert.equal(await redis.hlen(concurrencyKey), 0);
  });

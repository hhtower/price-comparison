import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { Test, type TestingModule } from '@nestjs/testing';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import '../src/config/env.js';
import { createApp } from '../src/main.js';
import { AppModule } from '../src/app.module.js';
import {
  createPostgresPool,
  DATABASE,
  DatabaseService,
  PG_POOL,
} from '../src/database/database.providers.js';
import type { DatabaseSchema } from '../src/database/types.js';
import { migrateToLatest } from '../scripts/migrate.js';
import {
  adminSessionKey,
  AuthService,
  createSessionStore,
  SESSION_TTL_SECONDS,
} from '../src/auth/auth.service.js';

const ADMIN_PASSWORD = `task7-auth-${Date.now()}`;

describe('authentication over real PostgreSQL and Redis', () => {
  let postgresContainer: StartedPostgreSqlContainer | undefined;
  let redisContainer: StartedTestContainer | undefined;
  let adminPool: Pool;
  let migrationDatabase: Kysely<DatabaseSchema>;
  let testingModule: TestingModule;
  let app: ReturnType<Awaited<ReturnType<typeof createApp>>>;
  let secondApp: ReturnType<Awaited<ReturnType<typeof createApp>>> | undefined;
  let redisUrl: string;
  let controlRedis: Redis;
  let schemaName: string;
  let sessionToken = '';

  before(async () => {
    process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
    if (process.env.TEST_DATABASE_URL) {
      process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    } else {
      postgresContainer = await new PostgreSqlContainer('postgres:16-alpine').start();
      process.env.DATABASE_URL = postgresContainer.getConnectionUri();
    }

    if (process.env.TEST_REDIS_URL) {
      redisUrl = process.env.TEST_REDIS_URL;
    } else {
      redisContainer = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
      redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
    }
    process.env.REDIS_URL = redisUrl;
    process.env.AUTH_SESSION_KEY_PREFIX = `task7-auth-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}:`;

    schemaName = `task7_auth_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    adminPool = new Pool({ connectionString: process.env.DATABASE_URL });
    await adminPool.query(`create schema "${schemaName}"`);
    process.env.PG_SCHEMA = schemaName;
    process.env.PG_POOL_MAX = '4';
    process.env.API_CONNECTIONS = '2';
    process.env.CRAWLER_CONNECTIONS = '1';
    process.env.AI_CONNECTIONS = '1';
    process.env.STANDARDIZATION_CONNECTIONS = '';
    process.env.PG_IDLE_TIMEOUT_MS = '5000';
    process.env.PG_CONNECTION_TIMEOUT_MS = '5000';
    process.env.PG_STATEMENT_TIMEOUT_MS = '10000';

    const migrationPool = createPostgresPool();
    migrationDatabase = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: migrationPool }) });
    controlRedis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });

    await migrateToLatest(migrationDatabase);
    const afterUpgrade = await sql<{ exists: boolean }>`select to_regclass(current_schema() || '.admin') is not null as exists`.execute(migrationDatabase);
    assert.equal(afterUpgrade.rows[0]?.exists, true, 'migration 005 must upgrade a 004 database');

    testingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = await createApp();
    await app.init();
  });

  after(async () => {
    await secondApp?.close();
    await app?.close();
    await testingModule?.close();
    await controlRedis?.del(adminSessionKey(sessionToken));
    await controlRedis?.quit();
    await migrationDatabase?.destroy();
    if (adminPool && schemaName) {
      await adminPool.query(`drop schema if exists "${schemaName}" cascade`);
      await adminPool.end();
    }
    await redisContainer?.stop();
    await postgresContainer?.stop();
    delete process.env.PG_SCHEMA;
  });

  test('missing Redis configuration fails closed instead of creating an in-process session map', () => {
    assert.throws(
      () => createSessionStore({ ...process.env, REDIS_URL: '' }),
      /REDIS_URL.*required/i,
    );
  });

  test('concurrent admin initialization is atomic, idempotent, and never stores the plaintext password', async () => {
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    await database.deleteFrom('admin').execute();
    const services = [0, 1].map(() => new AuthService(database, createSessionStore()));
    await Promise.all(services.map((service) => service.onModuleInit()));
    const rows = await database.selectFrom('admin').select(['id', 'password_hash']).execute();
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0]?.password_hash, ADMIN_PASSWORD);
    assert.match(rows[0]?.password_hash ?? '', /^scrypt\$32768\$8\$1\$/);

    await Promise.all(services.map((service) => service.onApplicationShutdown()));
  });

  test('login validation, failure, HTTP-only CSRF-safe cookie, and protected identity route', async () => {
    const missing = await app.getHttpAdapter().getInstance().inject({ method: 'POST', url: '/v1/auth/login', payload: {} });
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.headers['set-cookie'], undefined);

    const wrong = await app.getHttpAdapter().getInstance().inject({ method: 'POST', url: '/v1/auth/login', payload: { password: 'wrong' } });
    assert.equal(wrong.statusCode, 401);
    assert.equal(wrong.headers['set-cookie'], undefined);

    const unauthorized = await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: '/v1/auth/me' });
    assert.equal(unauthorized.statusCode, 401);

    const response = await app.getHttpAdapter().getInstance().inject({ method: 'POST', url: '/v1/auth/login', payload: { password: ADMIN_PASSWORD } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.payload), { ok: true });
    const cookie = response.headers['set-cookie']?.[0];
    assert.match(cookie ?? '', /^admin_session=[A-Za-z0-9_-]+; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=86400$/);
    sessionToken = cookie?.match(/admin_session=([^;]+)/)?.[1] ?? '';
    assert.ok(sessionToken);
    assert.equal(await controlRedis.exists(adminSessionKey(sessionToken)), 1);

    const identity = await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } });
    assert.equal(identity.statusCode, 200);
    assert.deepEqual(JSON.parse(identity.payload), { userId: '1' });
  });

  test('a second API instance validates the same Redis-backed session', async () => {
    secondApp = await createApp();
    await secondApp.init();
    const response = await secondApp.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: `admin_session=${sessionToken}` },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.payload), { userId: '1' });
  });

  test('session TTL expiry rejects the cookie even when its syntactic token remains valid', async () => {
    await controlRedis.pexpire(adminSessionKey(sessionToken), 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: `admin_session=${sessionToken}` },
    });
    assert.equal(response.statusCode, 401);
  });

  test('Redis read failure is fail closed rather than treated as an authenticated session', async () => {
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    const failingRedis = {
      get: async () => { throw new Error('redis unavailable'); },
      set: async () => 'OK',
      del: async () => 1,
    };
    assert.equal(await new AuthService(database, failingRedis).validate(sessionToken), null);
  });

  test('logout deletes the server session and expires the cookie consistently', async () => {
    const login = await app.getHttpAdapter().getInstance().inject({ method: 'POST', url: '/v1/auth/login', payload: { password: ADMIN_PASSWORD } });
    const cookie = login.headers['set-cookie']?.[0] ?? '';
    const token = cookie.match(/admin_session=([^;]+)/)?.[1] ?? '';
    assert.ok(token);
    assert.equal(await controlRedis.exists(adminSessionKey(token)), 1);

    const logout = await app.getHttpAdapter().getInstance().inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie } });
    assert.equal(logout.statusCode, 200);
    assert.deepEqual(JSON.parse(logout.payload), { ok: true });
    assert.match(logout.headers['set-cookie']?.[0] ?? '', /^admin_session=; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=0$/);
    assert.equal(await controlRedis.exists(adminSessionKey(token)), 0);

    const afterLogout = await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } });
    assert.equal(afterLogout.statusCode, 401);
    sessionToken = '';
  });

  test('the cookie TTL is derived from the same source as the Redis session TTL', () => {
    assert.equal(SESSION_TTL_SECONDS, 24 * 60 * 60);
  });
});


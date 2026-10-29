import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { AuthService } from '../src/auth/auth.service.js';
import { RateLimitGuard } from '../src/common/rate-limit.guard.js';
import { ProductsController } from '../src/products/products.controller.js';
import { ProductsRepository } from '../src/products/products.repository.js';
import { ProductsService } from '../src/products/products.service.js';

async function setup(t: TestContext, ids: bigint[], maxRequests = 60) {
  const active = new Set(ids);
  const deleted: bigint[] = [];
  const module = await Test.createTestingModule({
    controllers: [ProductsController],
    providers: [
      ProductsService, AuthGuard,
      { provide: AuthService, useValue: { validate: async (token?: string) => token === 'test-session' ? { id: 'admin' } : null } },
      { provide: ProductsRepository, useValue: {
        softDelete: async (id: bigint) => active.delete(id),
        softDeleteBatch: async (productIds: bigint[]) => {
          const success = productIds.filter(id => active.delete(id));
          deleted.push(...success);
          return success;
        },
        restoreBatch: async (productIds: bigint[]) => ({
          success: [...new Set(productIds)].filter(id => active.delete(id)).map(String), failures: [],
        }),
      } },
    ],
  }).compile();
  const app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ logger: false }));
  app.enableVersioning({ type: VersioningType.URI });
  const hits = new Map<string, number>();
  app.useGlobalGuards(new RateLimitGuard({
    async hit(key, windowMs) {
      const count = (hits.get(key) ?? 0) + 1;
      hits.set(key, count);
      return { count, retryAfterMs: windowMs };
    },
  }, { maxRequests, windowMs: 60_000 }));
  t.after(() => app.close());
  await app.init();
  const server = app.getHttpAdapter().getInstance();
  const headers = { cookie: 'admin_session=test-session' };
  const remove = (payload: unknown, authenticated = true) => server.inject({
    method: 'POST', url: '/v1/admin/products/batch-delete',
    headers: authenticated ? headers : {}, payload,
  });
  const restore = (payload: unknown, authenticated = true) => server.inject({
    method: 'POST', url: '/v1/admin/products/batch-restore',
    headers: authenticated ? headers : {}, payload,
  });
  return { active, deleted, server, headers, remove, restore };
}

test('53 products use one batch request even after single-delete rate budget is exhausted', async t => {
  const ids = Array.from({ length: 53 }, (_, index) => BigInt(index + 1));
  const { active, server, headers, remove } = await setup(t, ids, 1);
  assert.equal((await server.inject({ method: 'DELETE', url: '/v1/admin/products/999', headers })).statusCode, 404);
  assert.equal((await server.inject({ method: 'DELETE', url: '/v1/admin/products/1', headers })).statusCode, 429);
  const response = await remove({ productIds: ids.map(String) });
  assert.equal(response.statusCode, 201, response.payload);
  assert.deepEqual(response.json(), { success: ids.map(String), failures: [] });
  assert.equal(active.size, 0);
  const repeated = await remove({ productIds: ['1'] });
  assert.equal(repeated.statusCode, 429, 'batch endpoint must retain rate limiting');
  assert.ok(repeated.headers['retry-after']);
});

test('batch deletion deduplicates IDs, preserves bigint precision, and reports unavailable products', async t => {
  const { active, deleted, remove } = await setup(t, [1n, 2n, 9007199254740993n]);
  const response = await remove({ productIds: ['1', '9007199254740993', '1', '999'] });
  assert.equal(response.statusCode, 201, response.payload);
  assert.deepEqual(response.json(), {
    success: ['1', '9007199254740993'],
    failures: [{ id: '999', reason: '商品不存在或已删除' }],
  });
  assert.deepEqual(deleted, [1n, 9007199254740993n]);
  assert.deepEqual([...active], [2n]);
});

test('batch deletion validates the entire payload before changing products', async t => {
  const { active, deleted, remove } = await setup(t, [1n]);
  for (const payload of [
    {}, { productIds: [] }, { productIds: '1' }, { productIds: ['1', 2] },
    { productIds: ['1', '0'] }, { productIds: ['1', '-1'] },
    { productIds: ['1', 'bad'] }, { productIds: ['1', '9223372036854775808'] },
    { productIds: ['1'], extra: true },
  ]) {
    const response = await remove(payload);
    assert.equal(response.statusCode, 400, response.payload);
  }
  assert.deepEqual([...active], [1n]);
  assert.deepEqual(deleted, []);
});

test('batch deletion requires an authenticated admin session', async t => {
  const { active, remove } = await setup(t, [1n]);
  const response = await remove({ productIds: ['1'] }, false);
  assert.equal(response.statusCode, 401, response.payload);
  assert.deepEqual([...active], [1n]);
});

test('batch restoration accepts large string IDs and uses one rate-limited authenticated request', async t => {
  const ids = [...Array.from({ length: 53 }, (_, index) => BigInt(index + 1)), 9007199254740993n];
  const { active, restore } = await setup(t, ids, 1);
  const response = await restore({ productIds: [...ids.map(String), '1'] });
  assert.equal(response.statusCode, 201, response.payload);
  assert.deepEqual(response.json(), { success: ids.map(String), failures: [] });
  assert.equal(active.size, 0);
  assert.equal((await restore({ productIds: ['1'] })).statusCode, 429);
});

test('batch restoration rejects malformed or unauthenticated requests before changing products', async t => {
  const { active, restore } = await setup(t, [1n]);
  assert.equal((await restore({ productIds: ['1'] }, false)).statusCode, 401);
  for (const payload of [
    {}, { productIds: [] }, { productIds: '1' }, { productIds: ['1', 2] },
    { productIds: ['1', '0'] }, { productIds: ['1', '-1'] }, { productIds: ['1', 'bad'] },
    { productIds: ['1', '9223372036854775808'] }, { productIds: ['1'], extra: true },
  ]) assert.equal((await restore(payload)).statusCode, 400);
  assert.deepEqual([...active], [1n]);
});

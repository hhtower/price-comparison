import assert from 'node:assert/strict';
import test from 'node:test';
import { createCache } from 'cache-manager';
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery } from 'kysely';
import { CatalogController } from '../src/catalog/catalog.controller.js';
import { CatalogRepository } from '../src/catalog/catalog.repository.js';
import { CatalogService } from '../src/catalog/catalog.service.js';
import type { DatabaseSchema } from '../src/database/types.js';

test('coverage counts source shops and products in one snapshot without public-offer filtering', async () => {
  const queries: CompiledQuery[] = [];
  const expected = { shopCount: 1234, productCount: 3149999 };
  class Driver extends DummyDriver {
    async acquireConnection(): Promise<any> {
      return { executeQuery: async (query: CompiledQuery) => {
        queries.push(query);
        return { rows: [expected] };
      } };
    }
  }
  const database = new Kysely<DatabaseSchema>({ dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new Driver(),
    createIntrospector: db => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  } });
  try {
    assert.deepEqual(await new CatalogRepository(database).coverage(), expected);
    assert.equal(queries.length, 1);
    assert.match(queries[0]!.sql, /count\(\*\) from shops/u);
    assert.match(queries[0]!.sql, /count\(\*\) from products/u);
    assert.doesNotMatch(queries[0]!.sql, /\b(where|join|offers|standard_products)\b/iu);
    assert.deepEqual(queries[0]!.parameters, []);
  } finally {
    await database.destroy();
  }
});

test('public coverage coalesces reads in the existing cache and does not cache failures or expose database errors', async () => {
  let reads = 0;
  let fail = false;
  const expected = { shopCount: 1234, productCount: 3149999 };
  const repository = { coverage: async () => {
    reads += 1;
    if (fail) throw new Error('private database failure');
    return expected;
  } } as unknown as CatalogRepository;
  const cache = createCache();
  const service = new CatalogService(repository, cache);
  const controller = new CatalogController(service);
  const pages = await Promise.all([controller.getCoverage(), controller.getCoverage()]);
  assert.deepEqual(pages, [expected, expected]);
  assert.equal(reads, 1);
  await controller.getCoverage();
  assert.equal(reads, 1);

  await cache.del('catalog:coverage:v1');
  fail = true;
  await assert.rejects(controller.getCoverage(), error => {
    assert.equal((error as { getStatus(): number }).getStatus(), 503);
    assert.equal((error as Error).message, '数据覆盖统计暂时不可用');
    return true;
  });
  fail = false;
  assert.deepEqual(await controller.getCoverage(), expected);
  assert.equal(reads, 3);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery } from 'kysely';
import { CatalogRepository } from '../src/catalog/catalog.repository.js';
import { CatalogService } from '../src/catalog/catalog.service.js';
import type { DatabaseSchema } from '../src/database/types.js';
import type { Cache } from '../src/cache/cache.js';
import { DomainValidationError } from '../src/common/errors.js';

test('reference lookup uses one scoped read without catalog aggregates or freshness exclusions', async () => {
  const queries: CompiledQuery[] = [];
  class Driver extends DummyDriver {
    async acquireConnection(): Promise<any> {
      return { executeQuery: async (query: CompiledQuery) => { queries.push(query); return { rows: [] }; } };
    }
  }
  const db = new Kysely<DatabaseSchema>({ dialect: {
    createAdapter: () => new PostgresAdapter(), createDriver: () => new Driver(),
    createIntrospector: database => new PostgresIntrospector(database), createQueryCompiler: () => new PostgresQueryCompiler(),
  } });
  try {
    const service = new CatalogService(new CatalogRepository(db), {} as Cache);
    await service.getReferenceOffers({ standardProductId: '42', currency: 'CNY', priceMax: '80',
      tags: [{ name: 'duration', value: 30 }, { name: 'region', value: 'us' }, { name: 'region', value: 'jp' }] });
    assert.equal(queries.length, 1);
    const query = queries[0]!;
    assert.match(query.sql, /r.standard_product_id = \$\d+::bigint/u);
    assert.match(query.sql, /hidden = false.*merged_into_id is null.*verification_state = 'verified'/u);
    assert.match(query.sql, /publication_state = 'published'/u);
    assert.match(query.sql, /p.deleted_at is null/u);
    assert.match(query.sql, /sh.enabled = true and sh.deleted_at is null/u);
    assert.match(query.sql, /r.tags @>/u);
    assert.doesNotMatch(query.sql, /warranty_days/u);
    assert.doesNotMatch(query.sql, /count\(|offset |limit |captured_at >|available =|reviews/iu);
    assert.ok(query.parameters.includes('42'));
    assert.ok(query.parameters.includes('80.00'));
    assert.ok(query.parameters.includes('CNY'));
    assert.match(JSON.stringify(query.parameters), /duration/u);
    assert.throws(() => service.getReferenceOffers({}), DomainValidationError);
    assert.throws(() => service.getReferenceOffers({ standardProductId: '42;select 1' }), DomainValidationError);
  } finally { await db.destroy(); }
});

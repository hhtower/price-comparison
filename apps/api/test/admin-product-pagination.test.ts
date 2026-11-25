import assert from 'node:assert/strict';
import test from 'node:test';
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery } from 'kysely';
import { AdminRepository } from '../src/admin/admin.repository.js';
import { decodeIdCursor, encodeIdCursor } from '../src/common/pagination.js';
import type { DatabaseSchema } from '../src/database/types.js';

function fixture(rows: Record<string, unknown>[]) {
  const queries: CompiledQuery[] = [];
  class Driver extends DummyDriver {
    async acquireConnection(): Promise<any> {
      return { executeQuery: async (query: CompiledQuery) => {
        queries.push(query);
        return { rows };
      } };
    }
  }
  const database = new Kysely<DatabaseSchema>({ dialect: {
    createAdapter: () => new PostgresAdapter(), createDriver: () => new Driver(),
    createIntrospector: db => new PostgresIntrospector(db), createQueryCompiler: () => new PostgresQueryCompiler(),
  } });
  return { database, queries };
}

test('product numbered pages reuse a narrow materialized filter scope for exact counts and page IDs', async () => {
  const f = fixture([{ id: 11n, _total: '53' }]);
  try {
    const page = await new AdminRepository(f.database).listProducts({
      page: 2, limit: 10, shopId: 7n, standardProductId: 9n,
      keyword: 'sale_%', standardized: false, deleted: true, cursor: encodeIdCursor(3n),
    });
    assert.deepEqual(page, { items: [{ id: 11n }], total: 53, page: 2, pageSize: 10 });
    assert.equal(f.queries.length, 1);
    const { sql, parameters } = f.queries[0]!;
    assert.match(sql, /with "product_scope" as materialized \(select "products"\."id" from "products"/u);
    const scope = sql.slice(0, sql.indexOf('), "product_page"'));
    assert.ok(!scope.includes('source_data'));
    assert.ok(!scope.includes('jsonb_agg'));
    assert.match(scope, /"products"\."deleted_at" is not null/u);
    assert.match(scope, /"products"\."shop_id" = /u);
    assert.match(scope, /"member"\."standard_product_id" = /u);
    assert.match(scope, /"standard_member"\."product_id" is null/u);
    assert.match(scope, /"products"\."id" > /u);
    assert.match(sql, /select count\(\*\) as "_total" from "product_scope"/u);
    assert.match(sql, /"product_page" as \(select "id" from "product_scope" order by "id" asc limit .* offset/u);
    assert.ok(!sql.includes('count(*) over'));
    assert.ok(parameters.includes('%sale\\_\\%%'));
  } finally { await f.database.destroy(); }
});

for (const total of [0, 53]) {
  test(`an empty product page preserves total ${total} without a second eligibility query`, async () => {
    const f = fixture([{ id: null, _total: String(total) }]);
    try {
      const page = await new AdminRepository(f.database).listProducts({ page: 100, limit: 20 });
      assert.deepEqual(page, { items: [], total, page: 100, pageSize: 20 });
      assert.equal(f.queries.length, 1);
    } finally { await f.database.destroy(); }
  });
}

test('product cursor pagination retains ascending IDs and does not count the entire scope', async () => {
  const f = fixture([{ id: 11n }, { id: 12n }, { id: 13n }]);
  try {
    const page = await new AdminRepository(f.database).listProducts({ cursor: encodeIdCursor(10n), limit: 2 });
    assert.deepEqual(page.items.map(row => row.id), [11n, 12n]);
    assert.equal(decodeIdCursor(page.nextCursor!), 12n);
    assert.equal(page.total, undefined);
    assert.ok(!f.queries[0]!.sql.includes('count(*)'));
    assert.match(f.queries[0]!.sql, /order by "products"\."id" asc limit/u);
  } finally { await f.database.destroy(); }
});

test('pending numbered pages evaluate eligibility in the shared scope only once', async () => {
  const f = fixture([]);
  try {
    await new AdminRepository(f.database).listProducts({ pending: true, page: 1, limit: 20 });
    assert.equal(f.queries[0]!.sql, 'set local jit = off');
    assert.equal(f.queries.length, 2);
    const query = f.queries[1]!.sql;
    assert.equal(query.match(/from ai_standardization_results r/gu)?.length, 1);
    assert.match(query, /"product_scope" as materialized/u);
    assert.match(query, /null as "standardization_outcome"/u);
  } finally { await f.database.destroy(); }
});

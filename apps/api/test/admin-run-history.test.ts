import assert from 'node:assert/strict';
import test from 'node:test';
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery } from 'kysely';
import { AdminRepository, type AdminRunHistoryRow } from '../src/admin/admin.repository.js';
import { decodeIdCursor, encodeIdCursor } from '../src/common/pagination.js';
import type { DatabaseSchema } from '../src/database/types.js';
import { up, down } from '../src/database/migrations/023_fetch_run_history_20261027.js';

function row(id: bigint): AdminRunHistoryRow {
  return {
    id, shop_id: 1n, shop_name: 'History', started_at: new Date(), finished_at: null,
    status: 'queued', item_count: 0n, error: null, task_type: 'list', source_fetch_run_id: null, crawl_metrics: null,
  };
}

function fixture(rows: AdminRunHistoryRow[] = [], total = rows.length) {
  const queries: CompiledQuery[] = [];
  class Driver extends DummyDriver {
    async acquireConnection(): Promise<any> {
      return { executeQuery: async (query: CompiledQuery) => {
        queries.push(query);
        return { rows: query.sql.includes('count(*) as "total"') ? [{ total: String(total) }] : rows };
      } };
    }
  }
  const database = new Kysely<DatabaseSchema>({ dialect: {
    createAdapter: () => new PostgresAdapter(), createDriver: () => new Driver(),
    createIntrospector: db => new PostgresIntrospector(db), createQueryCompiler: () => new PostgresQueryCompiler(),
  } });
  return { database, queries };
}

test('run history orders by start time descending with ID as a stable tiebreaker and keeps the cursor on the last visible row', async () => {
  const f = fixture([row(3n), row(1n), row(2n)]);
  try {
    const page = await new AdminRepository(f.database).listRunHistory({ limit: 2 });
    assert.match(f.queries[0]!.sql, /order by "fetch_runs"\."started_at" desc, "fetch_runs"\."id" desc/u);
    assert.deepEqual(page.items.map(item => item.id), [3n, 1n]);
    assert.equal(decodeIdCursor(page.nextCursor!), 1n);
    assert.deepEqual(f.queries[0]!.parameters, [3]);
  } finally { await f.database.destroy(); }
});

test('run history page numbers include the filtered total and use the same start-time order', async () => {
  const f = fixture([row(2n)], 5);
  try {
    const page = await new AdminRepository(f.database).listRunHistory({ page: 2, limit: 2, shopId: 7n, status: 'failed' });
    assert.equal(page.total, 5);
    assert.equal(page.page, 2);
    assert.equal(page.pageSize, 2);
    assert.deepEqual(page.items.map(item => item.id), [2n]);
    const dataQuery = f.queries.find(query => query.sql.includes('limit'))!;
    const countQuery = f.queries.find(query => query.sql.includes('count(*)'))!;
    assert.match(dataQuery.sql, /order by "fetch_runs"\."started_at" desc, "fetch_runs"\."id" desc/u);
    assert.deepEqual(dataQuery.parameters, [7n, 'failed', 2, 2]);
    assert.match(countQuery.sql, /"fetch_runs"\."shop_id" = \$1 and "fetch_runs"\."status" = \$2/u);
    assert.deepEqual(countQuery.parameters, [7n, 'failed']);
    assert.doesNotMatch(countQuery.sql, /limit|offset|order by/u);
  } finally { await f.database.destroy(); }
});

for (const total of [0, 5]) {
  test(`an empty run history page preserves the actual total ${total}`, async () => {
    const f = fixture([], total);
    try {
      const page = await new AdminRepository(f.database).listRunHistory({ page: 4, limit: 2 });
      assert.deepEqual(page, { items: [], total, page: 4, pageSize: 2 });
    } finally { await f.database.destroy(); }
  });
}

test('run history cursor follows the exact database timestamp and ID while preserving shop and status filters', async () => {
  const f = fixture();
  try {
    await new AdminRepository(f.database).listRunHistory({ cursor: encodeIdCursor(42n), shopId: 7n, status: 'failed', limit: 2 });
    const query = f.queries[0]!;
    assert.match(query.sql, /\(fetch_runs\.started_at, fetch_runs\.id\) < \(select started_at, id from fetch_runs where id = \$3\)/u);
    assert.match(query.sql, /"fetch_runs"\."shop_id" = \$1 and "fetch_runs"\."status" = \$2/u);
    assert.deepEqual(query.parameters, [7n, 'failed', 42n, 3]);
  } finally { await f.database.destroy(); }
});

test('run history index supports the same descending time and ID order and can be removed', async () => {
  const f = fixture();
  try {
    await up(f.database as unknown as Kysely<unknown>);
    await down(f.database as unknown as Kysely<unknown>);
    assert.equal(f.queries[0]!.sql, 'create index fetch_runs_history_time on fetch_runs (started_at desc, id desc)');
    assert.equal(f.queries[1]!.sql, 'drop index fetch_runs_history_time');
  } finally { await f.database.destroy(); }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery } from 'kysely';
import { readAiTaskQueue } from '../src/ai/ai-task-queue.js';
import type { DatabaseSchema } from '../src/database/types.js';

for (const status of ['all', 'unfinished', 'attention']) {
  test(`${status} task queue omits the global isolation count and keeps manual protection in task queries`, async () => {
    const queries: CompiledQuery[] = [];
    class Driver extends DummyDriver {
      async acquireConnection(): Promise<any> {
        return { executeQuery: async (query: CompiledQuery) => {
          queries.push(query);
          if (query.sql.includes('select count(*) as total')) return { rows: [{
            total: 0n, unfinished: 0n, queued: 0n, running: 0n, paused: 0n, attention: 0n, pending_products: 0n,
          }] };
          if (query.sql.includes('from standardization_outbox o')) return { rows: [{ count: 1n }] };
          if (query.sql.includes('group by')) return { rows: [{ reason: 'technical_failure', count: 2 }] };
          if (query.sql.includes('from products p join shops')) return { rows: [{ count: 99n }] };
          return { rows: [] };
        } };
      }
    }
    const database = new Kysely<DatabaseSchema>({ dialect: {
      createAdapter: () => new PostgresAdapter(), createDriver: () => new Driver(),
      createIntrospector: db => new PostgresIntrospector(db), createQueryCompiler: () => new PostgresQueryCompiler(),
    } });
    try {
      const result = await readAiTaskQueue(database, { status, limit: 50 });
      assert.equal(queries.length, 4, 'no separate global product isolation query');
      assert.equal('manual_isolation' in result.summary.currentReasons, false);
      assert.equal(result.summary.currentReasons.technical_failure, 2);
      assert.equal(result.summary.pendingEvents, 1);
      assert.match(queries[0]!.sql, /product_standardization_decisions/u);
      assert.match(queries[0]!.sql, /content_fingerprint/u);
      assert.match(queries[0]!.sql, /assignment_source = 'human'/u);
      assert.ok(queries.every(query => !query.sql.includes("d.action in ('quarantine','exclude','unbind')")));
    } finally { await database.destroy(); }
  });
}

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
          if (query.sql === 'set local jit = off') return { rows: [] };
          queries.push(query);
          if (query.sql.startsWith('with report_unclassified')) return { rows: [{
            id: null, counts: { total: 0, unfinished: 0, queued: 0, running: 0, paused: 0, attention: 0, pending_products: 0 },
            reasons: [{ reason: 'technical_failure', count: 2 }],
          }] };
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
      assert.equal(queries.length, status === 'attention' ? 1 : 4, 'attention candidates are shared by the list and totals');
      assert.equal('manual_isolation' in result.summary.currentReasons!, false);
      assert.equal(result.summary.currentReasons!.technical_failure, 2);
      assert.equal(result.summary.pendingEvents, status === 'attention' ? 0 : 1);
      assert.match(queries[0]!.sql, /product_standardization_decisions/u);
      assert.match(queries[0]!.sql, /content_fingerprint/u);
      assert.match(queries[0]!.sql, /assignment\.publication_state = 'published'/u);
      assert.match(queries[0]!.sql, /standard\.verification_state = 'verified' and standard\.merged_into_id is null/u);
      assert.ok(queries.every(query => !query.sql.includes("d.action in ('quarantine','exclude','unbind')")));
    } finally { await database.destroy(); }
  });
}

for (const jobType of ['tag_extraction', 'membership_features', 'text_review']) {
test(`active ${jobType} summaries count unfinished members with the applicable eligibility guard`, async () => {
  const queries: CompiledQuery[] = [];
  class Driver extends DummyDriver {
    async acquireConnection(): Promise<any> {
      return { executeQuery: async (query: CompiledQuery) => {
        if (query.sql === 'set local jit = off') return { rows: [] };
        queries.push(query);
        return { rows: [{ items: [], summary: { total: 0, pendingProducts: 0 } }] };
      } };
    }
  }
  const database = new Kysely<DatabaseSchema>({ dialect: {
    createAdapter: () => new PostgresAdapter(), createDriver: () => new Driver(),
    createIntrospector: db => new PostgresIntrospector(db), createQueryCompiler: () => new PostgresQueryCompiler(),
  } });
  try {
    const result = await readAiTaskQueue(database, { jobType, status: 'unfinished', limit: 1 });
    assert.deepEqual(result.summary, { total: 0, pendingProducts: 0 });
    assert.equal(queries.length, 1);
    const query = queries[0]!.sql;
    assert.doesNotMatch(query, /eligible_products/u);
    if (jobType === 'membership_features') {
      assert.match(query, /is_ai_membership/u);
      assert.match(query, /publication_state='published'/u);
      assert.match(query, /verification_state='verified'/u);
    } else assert.doesNotMatch(query, /content_version|content_fingerprint|product_standardization_decisions|standard_product_members|from products/u);
    assert.match(query, /where j\.job_type=\$\d+ and j\.status in \('queued', 'running', 'paused', 'ready'\)/u);
    assert.ok(queries[0]!.parameters.includes(jobType));
    assert.ok(!queries[0]!.parameters.includes(jobType === 'tag_extraction' ? 'membership_features' : 'tag_extraction'));
    assert.match(query, /'pendingProducts',coalesce\(sum\(current_pending\),0\)/u);
    assert.match(query, /configuration_current and status in \('queued','running','paused','ready'\)/u);
  } finally { await database.destroy(); }
});
}

test('interactive task queries disable JIT on their transaction connection', async () => {
  let jitDisabled = false;
  class Driver extends DummyDriver {
    async acquireConnection(): Promise<any> {
      return { executeQuery: async (query: CompiledQuery) => {
        if (query.sql === 'set local jit = off') { jitDisabled = true; return { rows: [] }; }
        assert.ok(jitDisabled, 'task reports must not compile their expensive expression trees');
        return { rows: [{ items: [], summary: { total: 0 } }] };
      } };
    }
  }
  const db = new Kysely<DatabaseSchema>({ dialect: {
    createAdapter: () => new PostgresAdapter(), createDriver: () => new Driver(),
    createIntrospector: db => new PostgresIntrospector(db), createQueryCompiler: () => new PostgresQueryCompiler(),
  } });
  try { await readAiTaskQueue(db, { jobType: 'tag_extraction', totalOnly: true }); }
  finally { await db.destroy(); }
});

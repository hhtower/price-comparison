import assert from 'node:assert/strict';
import test from 'node:test';
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery } from 'kysely';
import { AdminRepository } from '../src/admin/admin.repository.js';
import type { DatabaseSchema } from '../src/database/types.js';
import { productProcessingSummary } from '../src/ai/product-standardization-state.js';

test('pending lists disable JIT only within their transaction and fetch summaries after pagination', async () => {
  const queries: CompiledQuery[] = [];
  class Driver extends DummyDriver {
    async acquireConnection(): Promise<any> {
      return { executeQuery: async (query: CompiledQuery) => {
        queries.push(query);
        if (query.sql.includes('as "processing_state"')) {
          return { rows: [{ id: 1n, processing_state: { reasonCode: 'request_outcome_unknown', requestError: 'timed out after 60000ms secret upstream body' } }] };
        }
        return { rows: query.sql.includes('from "products"') ? [{ id: 1n, _total: 3 }] : [] };
      } };
    }
  }
  const database = new Kysely<DatabaseSchema>({ dialect: {
    createAdapter: () => new PostgresAdapter(), createDriver: () => new Driver(),
    createIntrospector: db => new PostgresIntrospector(db), createQueryCompiler: () => new PostgresQueryCompiler(),
  } });
  try {
    const result = await new AdminRepository(database).listProducts({ pending: true, page: 1, limit: 1 });
    assert.equal(result.total, 3);
    assert.deepEqual(result.items[0]?.processing_summary, {
      reasonCode: 'request_outcome_unknown', processingDisposition: 'retry_available',
      reason: '模型请求超时（60 秒），结果未知',
    });
    assert.equal(queries[0]?.sql, 'set local jit = off');
    const summary = queries.find(query => query.sql.includes('as "processing_state"'))!;
    assert.deepEqual(summary.parameters, [1n]);
    assert.ok(queries.indexOf(summary) > queries.findIndex(query => query.sql.includes('limit')));
    queries.length = 0;
    await new AdminRepository(database).listProducts({ page: 1, limit: 1 });
    assert.equal(queries.length, 1, 'raw products do not change JIT or read failure histories');
    assert.ok(!queries[0]!.sql.includes('set local'));
  } finally { await database.destroy(); }
});

test('processing summaries distinguish stale evidence, manual protection and absent historical reasons', () => {
  assert.equal(productProcessingSummary({ reasonCode: 'source_changed', reason: 'old failure' }).reason,
    '商品资料或人工归类已变化，历史处理结果已过期。');
  assert.deepEqual(productProcessingSummary({ reasonCode: 'manual_decision_preserved', manualReason: '需人工核验' }), {
    reasonCode: 'manual_decision_preserved', processingDisposition: 'review_required', reason: '需人工核验',
  });
  assert.equal(productProcessingSummary({ reasonCode: 'provider_error' }).reason, '处理未完成，历史记录未提供具体原因。');
  assert.equal(productProcessingSummary({ reasonCode: 'review_rejected', reason: 'a\n'.repeat(300) }).reason.length, 240);
});

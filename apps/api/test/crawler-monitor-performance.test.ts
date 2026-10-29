import assert from 'node:assert/strict';
import test from 'node:test';
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery } from 'kysely';
import { DiagnosticsRepository } from '../src/crawler/diagnostics.repository.js';
import type { DatabaseSchema } from '../src/database/types.js';
import { JobsRepository } from '../src/jobs/jobs.repository.js';
import { up, down } from '../src/database/migrations/024_crawler_monitor_indexes_20261027.js';

test('monitor queries aggregate recent outcomes in SQL, filter active tasks and reuse current offer prices', async () => {
  const queries: CompiledQuery[] = [];
  class Driver extends DummyDriver {
    async acquireConnection(): Promise<any> {
      return { executeQuery: async (query: CompiledQuery) => {
        queries.push(query);
        if (query.sql.includes('as list_succeeded')) return { rows: [{ list_succeeded: '8', list_failed: '2', failed_recent: '3', settlement_failed: '1' }] };
        if (query.sql.includes('as oldest')) return { rows: [{ oldest: null, queued: '12', running: '2', deferred: '4', settlement_queued: '1', settlement_running: '0', settlement_deferred: '1' }] };
        if (query.sql.includes('as eligible')) return { rows: [{ eligible: '20', verified: '15' }] };
        return { rows: [] };
      } };
    }
  }
  const database = new Kysely<DatabaseSchema>({ dialect: {
    createAdapter: () => new PostgresAdapter(), createDriver: () => new Driver(),
    createIntrospector: db => new PostgresIntrospector(db), createQueryCompiler: () => new PostgresQueryCompiler(),
  } });
  try {
    const result = await new DiagnosticsRepository(database).snapshot();
    assert.deepEqual(result.instances, { queued: 12, running: 2, failedRecent: 3 });
    assert.equal(result.windowRuns, 10);
    assert.equal(result.listSucceeded, 8);
    assert.deepEqual(result.coverage, { eligible: 20, verified: 15 });
    assert.deepEqual(result.settlementQueue, { queued: 1, running: 0, deferred: 1, failedRecent: 1 });
    assert.equal('durations' in result, false);
    assert.equal('requests' in result, false);
    const active = queries.find(query => query.sql.includes('as oldest'))!.sql;
    assert.match(active, /where status in \('queued', 'running'\)/u);
    const recent = queries.find(query => query.sql.includes('as list_succeeded'))!.sql;
    assert.match(recent, /where status in \('succeeded', 'failed'\) and finished_at >=/u);
    assert.doesNotMatch(recent, /crawl_metrics|coalesce/iu);
    const coverage = queries.find(query => query.sql.includes('as eligible'))!.sql;
    assert.match(coverage, /catalog_read_offer_prices/u);
    assert.doesNotMatch(coverage, /join lateral/iu);
    const samples = queries.find(query => query.sql.includes('latest.crawl_metrics'))!.sql;
    assert.match(samples, /join lateral/u);
    assert.match(samples, /where shop_id = sh.id/u);
    assert.match(samples, /limit 1/u);
    assert.doesNotMatch(samples, /distinct on/iu);
    await new JobsRepository(database).fetchRunCounts();
    assert.match(queries.at(-1)!.sql, /where q.status in \('queued', 'running'\)\s+or \(q.status = 'failed' and q.finished_at >/u);
    await up(database as unknown as Kysely<unknown>);
    await down(database as unknown as Kysely<unknown>);
    const migrations = queries.slice(-4).map(query => query.sql);
    assert.match(migrations[0]!, /include \(status, task_type\) where status in \('succeeded', 'failed'\)/u);
    assert.match(migrations[1]!, /\(shop_id, finished_at desc nulls last, id desc\)/u);
    assert.match(migrations[1]!, /where task_type = 'list' and status = 'succeeded' and crawl_metrics is not null/u);
    assert.equal(migrations[2], 'drop index fetch_runs_latest_list_metrics');
    assert.equal(migrations[3], 'drop index fetch_runs_recent_outcomes');
  } finally { await database.destroy(); }
});

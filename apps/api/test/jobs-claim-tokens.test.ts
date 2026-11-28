import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler,
  type CompiledQuery, type DatabaseConnection, type QueryResult,
} from 'kysely';
import type { DatabaseSchema } from '../src/database/types.js';
import { JobsRepository } from '../src/jobs/jobs.repository.js';

function fixture(batch: Record<string, unknown>) {
  const queries: CompiledQuery[] = [];
  class Driver extends DummyDriver {
    async acquireConnection(): Promise<DatabaseConnection> {
      return {
        async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
          queries.push(query);
          const rows = query.sql.startsWith('select')
            ? [query.sql.includes('from "ai_jobs"') ? { id: 10n } : batch]
            : [];
          return { rows: rows as R[], numAffectedRows: 1n };
        },
        async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> { throw new Error('unexpected stream'); },
      };
    }
  }
  const database = new Kysely<DatabaseSchema>({ dialect: {
    createAdapter: () => new PostgresAdapter(), createDriver: () => new Driver(),
    createIntrospector: db => new PostgresIntrospector(db), createQueryCompiler: () => new PostgresQueryCompiler(),
  } });
  return { database, repository: new JobsRepository(database), queries };
}

const running = () => ({
  id: 1n, job_id: 10n, status: 'running', step: 'publish', claimed_by: 'worker',
  claim_token: 'new-claim', lease_until: new Date(Date.now() + 60_000),
  request_budget_used: 0, request_budget_limit: 2, confirmed_requests: 0, unknown_requests: 0,
});

test('old or missing claim tokens cannot complete, fail or requeue a newly claimed AI batch', async t => {
  for (const token of ['old-claim', undefined]) {
    for (const action of ['complete', 'fail', 'requeue'] as const) {
      await t.test(`${action}: ${token}`, async () => {
        const { database, repository, queries } = fixture(running());
        try {
          const transition = action === 'complete'
            ? repository.complete('ai_batch', 1n, 'worker', token)
            : action === 'fail'
              ? repository.fail('ai_batch', 1n, 'worker', 'late metrics failure', { retry: true, retryClass: 'local', claimToken: token })
              : repository.requeue('ai_batch', 1n, 'worker', 0, token);
          await assert.rejects(transition, /lease|claim/i, `${action}: ${token}`);
          assert.equal(queries.some(query => query.sql.startsWith('update')), false);
        } finally { await database.destroy(); }
      });
    }
  }
});

test('current AI claim can complete or retry publication and queued checkpoint completion stays idempotent', async () => {
  for (const action of ['complete', 'fail', 'requeue', 'checkpoint'] as const) {
    const { database, repository, queries } = fixture({
      ...running(), ...(action === 'checkpoint' ? { status: 'queued', claimed_by: null, claim_token: null } : {}),
    });
    try {
      if (action === 'complete' || action === 'checkpoint') await repository.complete('ai_batch', 1n, 'worker', 'new-claim');
      else if (action === 'fail') await repository.fail('ai_batch', 1n, 'worker', 'local failure', { retry: true, retryClass: 'local', claimToken: 'new-claim' });
      else await repository.requeue('ai_batch', 1n, 'worker', 0, 'new-claim');
      assert.equal(queries.filter(query => query.sql.startsWith('update')).length, action === 'checkpoint' ? 0 : 1);
    } finally { await database.destroy(); }
  }
});

test('fetch transitions and AI heartbeats fence SQL writes with the supplied claim token', async t => {
  for (const kind of ['fetch_run', 'ai_batch'] as const) {
    for (const action of (kind === 'fetch_run' ? ['heartbeat', 'complete', 'fail', 'requeue'] : ['heartbeat'])) {
      for (const token of ['old-claim', 'new-claim', undefined]) {
        await t.test(`${kind} ${action}: ${token}`, async () => {
          const { database, repository, queries } = fixture(running());
          try {
            if (action === 'heartbeat') await repository.heartbeat(kind, 1n, 'worker', 1000, token);
            else if (action === 'complete') await repository.complete(kind, 1n, 'worker', token);
            else if (action === 'fail') await repository.fail(kind, 1n, 'worker', 'failed', { claimToken: token });
            else await repository.requeue(kind, 1n, 'worker', 0, token);
            const update = queries.find(query => query.sql.trimStart().startsWith('update'))!;
            const predicate = update.sql.split('where')[1]!;
            const tokenParameter = /"?claim_token"? = \$(\d+)/.exec(predicate);
            assert.ok(tokenParameter, `${kind} ${action} must fence the write`);
            assert.equal(update.parameters[Number(tokenParameter[1]) - 1], token ?? '');
          } finally { await database.destroy(); }
        });
      }
    }
  }
});

import assert from 'node:assert/strict';
import { AsyncResource } from 'node:async_hooks';
import { once } from 'node:events';
import test from 'node:test';
import { Client, Pool, Query } from 'pg';
import { sql } from 'kysely';
import { DATABASE, PG_POOL, databaseProviders } from '../src/database/database.providers.js';
import { MetricsRegistry, instrumentPostgresPool } from '../src/observability/metrics.js';
import {
  StructuredLogger, getRequestContext, runWithRequestContext, runWithWorkerContext,
} from '../src/observability/request-context.js';

const failure = Object.assign(new Error('secret SQL and parameter details'), { code: '23505' });
const databaseCallbacks = new AsyncResource('offline-postgres');

// Exercise pg's real query normalization, callbacks, timeouts and pool release without a server.
class OfflineClient extends Client {
  connect(callback: (error?: Error) => void): void {
    process.nextTick(callback);
  }

  _pulseQueryQueue(): void {
    const query = this._queryQueue.shift();
    if (!query || query.text === 'select timeout') return;
    queueMicrotask(() => databaseCallbacks.runInAsyncScope(() => {
      if (query.text === 'select failure') query.handleError(failure, this.connection);
      else query.handleReadyForQuery(this.connection);
    }));
  }
}

function fixture(context: { after: (fn: () => Promise<void>) => void }, sink?: (line: string) => void) {
  const metrics = new MetricsRegistry();
  const lines: string[] = [];
  const logger = new StructuredLogger(sink ?? ((line) => lines.push(line)));
  const factory = databaseProviders.find((provider) => provider.provide === PG_POOL);
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://unused:unused@127.0.0.1/unused';
  let pool: Pool;
  try {
    pool = factory.useFactory(metrics, logger);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
  pool.Client = OfflineClient;
  context.after(() => pool.end());
  return { pool, metrics, lines, logger };
}

test('native pool promises count successes and failures once and preserve results/errors', async (context) => {
  const { pool, metrics, lines } = fixture(context);
  const result = await pool.query('select $1', ['secret-param']);
  assert.deepEqual(result.rows, []);
  await assert.rejects(pool.query('select failure'), (error) => error === failure);
  assert.equal(metrics.snapshot().database.queries, 2);
  assert.equal(pool.idleCount, 0, 'pg removes clients after query errors');
  const record = JSON.parse(lines.at(-1)!);
  assert.equal(record.message, 'database.query.failed');
  assert.equal(record.code, '23505');
  assert.equal(record.queryName, 'database.query');
  assert.match(record.queryFingerprint, /^[a-f0-9]{16}$/);
  assert.equal(JSON.stringify(lines).includes('secret'), false);
});

test('pool callback overloads retain void returns, errors and automatic release', async (context) => {
  const { pool, metrics } = fixture(context);
  await new Promise<void>((resolve, reject) => {
    const returned = pool.query('select $1', ['secret'], (error, result) => {
      if (error) return reject(error);
      assert.deepEqual(result.rows, []);
      assert.equal(pool.idleCount, 1);
      resolve();
    });
    assert.equal(returned, undefined);
  });
  await new Promise<void>((resolve) => {
    assert.equal(pool.query('select failure', (error) => {
      assert.equal(error, failure);
      resolve();
    }), undefined);
  });
  assert.equal(metrics.snapshot().database.queries, 2);
});

test('checked-out clients preserve callback config, promise and connect callback APIs', async (context) => {
  const { pool, metrics } = fixture(context);
  const client = await pool.connect();
  await client.query({ text: 'select $1', values: ['secret'], rowMode: 'array' });
  await new Promise<void>((resolve) => {
    const config = { text: 'select failure', callback(error: Error) {
      assert.equal(error, failure);
      resolve();
    } };
    const callback = config.callback;
    assert.equal(client.query(config), undefined);
    assert.equal(config.callback, callback, 'instrumentation must not mutate a plain query config');
  });
  client.release();
  await new Promise<void>((resolve, reject) => {
    assert.equal(pool.connect((error, connected, release) => {
      if (error) return reject(error);
      connected.query('select 1', (queryError) => {
        release();
        if (queryError) return reject(queryError);
        resolve();
      });
    }), undefined);
  });
  assert.equal(metrics.snapshot().database.queries, 3);
  assert.equal(pool.idleCount, 1);
});

test('client read timeouts and synchronous validation failures are measured once', async (context) => {
  const { pool, metrics, lines } = fixture(context);
  const client = await pool.connect();
  try {
    await assert.rejects(client.query({ text: 'select timeout', query_timeout: 5 }), /Query read timeout/);
    assert.throws(() => client.query(null), /null or undefined query/);
    await new Promise<void>((resolve) => {
      client.query({ text: 'select timeout', query_timeout: 5 }, (error) => {
        assert.equal(error.message, 'Query read timeout');
        resolve();
      });
    });
    assert.equal(metrics.snapshot().database.queries, 3);
    assert.deepEqual(lines.map((line) => JSON.parse(line).code), ['QUERY_TIMEOUT', 'QUERY_FAILED', 'QUERY_TIMEOUT']);
  } finally {
    client.release();
  }
});

test('Kysely and its transaction commands are counted at the client boundary only', async (context) => {
  const { pool, metrics, logger } = fixture(context);
  const factory = databaseProviders.find((provider) => provider.provide === DATABASE);
  const database = factory.useFactory(pool, metrics, logger);
  await sql`select 1`.execute(database);
  await assert.rejects(sql`select failure`.execute(database), (error) => error === failure);
  await database.transaction().execute(async (transaction) => {
    await sql`select 2`.execute(transaction);
  });
  assert.equal(metrics.snapshot().database.queries, 5, 'select, failure, begin, select, commit');
});

test('Query event and callback forms preserve identity and count completion only once', async (context) => {
  const { pool, metrics } = fixture(context);
  const client = await pool.connect();
  try {
    const query = new Query('select 1');
    const finished = once(query, 'end');
    assert.equal(client.query(query), query);
    await finished;
    const failed = new Query('select failure');
    const rejected = once(failed, 'end');
    assert.equal(client.query(failed), failed);
    await assert.rejects(rejected, (error) => error === failure);
    await new Promise<void>((resolve) => {
      const withCallback = new Query('select 1', function (error, result) {
        assert.equal(error, null);
        assert.equal(this, withCallback);
        assert.deepEqual(result.rows, []);
        resolve();
      });
      assert.equal(client.query(withCallback), withCallback);
    });
    assert.equal(metrics.snapshot().database.queries, 3);
  } finally {
    client.release();
  }
});

test('Query instrumentation does not swallow an unhandled error event or retain listeners', async (context) => {
  const { pool, metrics } = fixture(context);
  const client = await pool.connect();
  try {
    const query = new Query('select timeout');
    client.query(query);
    assert.equal(query.listenerCount('error'), 0);
    assert.throws(() => query.handleError(failure, client.connection), (error) => error === failure);
    assert.equal(query.listenerCount('end'), 0);
    assert.equal(metrics.snapshot().database.queries, 1);
  } finally {
    client.release();
  }
});

test('failing queries retain worker attribution without exposing prepared names, SQL or error details', async (context) => {
  const { pool, lines } = fixture(context);
  await runWithWorkerContext({ workerId: 'test', jobId: 7n, queryName: 'worker.test.claim' }, async () => {
    await assert.rejects(pool.query({
      name: 'secret-prepared-name',
      text: 'select failure',
      values: ['secret-param'],
    }));
  });
  const record = JSON.parse(lines[0]!);
  assert.equal(record.jobId, '7');
  assert.match(record.requestId, /^worker-test-/);
  assert.equal(record.queryName, 'worker.test.claim');
  assert.match(record.queryFingerprint, /^[a-f0-9]{16}$/);
  assert.equal(record.code, '23505');
  assert.equal(lines.join('').includes('secret'), false);
  assert.equal(lines.join('').includes('select failure'), false);
});

test('a broken log sink cannot replace a query error or prevent client release', async (context) => {
  const { pool, metrics } = fixture(context, () => { throw new Error('broken sink'); });
  await assert.rejects(pool.query('select failure'), (error) => error === failure);
  assert.equal(metrics.snapshot().database.queries, 1);
  assert.equal(pool.totalCount, 0);
});

test('slow query fingerprints ignore parameters and hide SQL literals and prepared names', async (context) => {
  let clock = 0;
  context.mock.method(performance, 'now', () => { clock += 1_000; return clock; });
  const { pool, metrics, lines } = fixture(context);
  const text = "select 'literal-secret', $1 /* secret-comment */";
  await pool.query({ text, values: ['first-secret'], name: 'secret-name' });
  await pool.query({ text, values: ['second-secret'], name: 'secret-name' });
  const records = lines.map((line) => JSON.parse(line));
  assert.equal(records.length, 2);
  assert.equal(records[0].message, 'database.query.slow');
  assert.equal(records[0].queryName, 'database.query');
  assert.equal(records[0].queryFingerprint, records[1].queryFingerprint);
  assert.match(records[0].queryFingerprint, /^[a-f0-9]{16}$/);
  assert.equal(records[0].duration, 1_000);
  assert.equal(metrics.snapshot().database.totalDurationMs, 2_000);
  assert.equal(lines.join('').includes('secret'), false);
  assert.equal(lines.join('').includes('select'), false);
});

test('slow and failed callback queries log their originating route outside its async context', async (context) => {
  let clock = 0;
  context.mock.method(performance, 'now', () => { clock += 1_000; return clock; });
  const { pool, metrics, lines } = fixture(context);
  const client = await pool.connect();
  try {
    for (const [route, text, expectedError] of [
      ['/v1/catalog', 'select $1', null],
      ['/v1/analytics', 'select failure', failure],
    ] as const) {
      await runWithRequestContext({ requestId: `request-${lines.length}`, queryName: route },
        () => new Promise<void>((resolve, reject) => {
          client.query(text, ['secret-param'], (error) => {
            try {
              assert.equal(error, expectedError);
              assert.equal(getRequestContext(), undefined, 'the driver callback runs outside the request context');
              resolve();
            } catch (assertionError) {
              reject(assertionError);
            }
          });
        }));
    }
  } finally {
    client.release();
  }
  const records = lines.map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => [record.message, record.requestId, record.queryName]), [
    ['database.query.slow', 'request-0', '/v1/catalog'],
    ['database.query.failed', 'request-1', '/v1/analytics'],
  ]);
  for (const record of records) assert.match(record.queryFingerprint, /^[a-f0-9]{16}$/);
  assert.equal(metrics.snapshot().database.queries, 2);
  assert.equal(lines.join('').includes('secret'), false);
});

test('duplicate pool instrumentation does not double count clients reused across checkouts', async (context) => {
  const { pool, metrics, logger } = fixture(context);
  instrumentPostgresPool(pool, metrics, logger);
  await pool.query('select 1');
  await pool.query('select 2');
  assert.equal(metrics.snapshot().database.queries, 2);
  assert.equal(pool.totalCount, 1);
});

test('unsafe database error codes are replaced and a broken slow log sink preserves success', async (context) => {
  const { pool, metrics, lines } = fixture(context);
  const client = await pool.connect();
  const original = failure.code;
  failure.code = 'secret-token-from-driver';
  try {
    await assert.rejects(client.query('select failure'), (error) => error === failure);
  } finally {
    failure.code = original;
    client.release();
  }
  assert.equal(JSON.parse(lines[0]!).code, 'QUERY_FAILED');
  assert.equal(lines.join('').includes('secret'), false);
  assert.equal(metrics.snapshot().database.queries, 1);

  let clock = 0;
  context.mock.method(performance, 'now', () => { clock += 1_000; return clock; });
  const broken = fixture(context, () => { throw new Error('broken sink'); });
  assert.deepEqual((await broken.pool.query('select 1')).rows, []);
  assert.equal(broken.pool.idleCount, 1);
  assert.equal(broken.metrics.snapshot().database.queries, 1);
});

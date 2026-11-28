import assert from 'node:assert/strict';
import test from 'node:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool, Query } from 'pg';
import { once } from 'node:events';
import { instrumentPostgresPool, MetricsRegistry } from '../src/observability/metrics.js';
import { StructuredLogger } from '../src/observability/request-context.js';

test('PostgreSQL query observability preserves native APIs, timeouts and Kysely counting', {
  skip: !process.env.TEST_DATABASE_URL,
}, async (context) => {
  const pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 2_000,
    statement_timeout: 100,
  });
  context.after(() => pool.end());
  const metrics = new MetricsRegistry();
  const lines: string[] = [];
  instrumentPostgresPool(pool, metrics, new StructuredLogger((line) => lines.push(line)), 0);

  assert.equal((await pool.query('select $1::text as value', ['secret-param'])).rows[0].value, 'secret-param');
  await new Promise<void>((resolve, reject) => {
    assert.equal(pool.query('select 1 as value', (error, result) => {
      if (error) return reject(error);
      assert.equal(result.rows[0].value, 1);
      resolve();
    }), undefined);
  });
  await assert.rejects(pool.query('select 1/0'), { code: '22012' });
  await new Promise<void>((resolve) => {
    pool.query('select 1/0', (error) => {
      assert.ok(error && 'code' in error);
      assert.equal(error.code, '22012');
      resolve();
    });
  });
  const client = await pool.connect();
  try {
    await client.query('select 2');
    await assert.rejects(client.query('select pg_sleep(1)'), { code: '57014' });
    await client.query('select 3');
    const query = new Query('select 4');
    const completed = once(query, 'end');
    assert.equal(client.query(query), query);
    await completed;
  } finally {
    client.release();
  }
  const database = new Kysely({ dialect: new PostgresDialect({ pool }) });
  await sql`select 5`.execute(database);
  await assert.rejects(sql`select 1/0`.execute(database), { code: '22012' });
  const timeoutQuery = { text: 'select pg_sleep(1)', query_timeout: 5 };
  await assert.rejects(pool.query(timeoutQuery), /Query read timeout/);
  assert.equal(metrics.snapshot().database.queries, 11);
  const records = lines.map((line) => JSON.parse(line));
  assert.equal(records.length, 11);
  assert.deepEqual(records.filter((record) => record.message === 'database.query.failed').map((record) => record.code),
    ['22012', '22012', '57014', '22012', 'QUERY_TIMEOUT']);
  assert.equal(lines.join('').includes('secret-param'), false);
  assert.equal(lines.join('').includes('select '), false);
});

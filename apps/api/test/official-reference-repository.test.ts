import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { Kysely, Migrator, PostgresDialect } from 'kysely';
import { migrationProvider } from '../scripts/migrate.js';
import { OfficialReferenceRepository } from '../src/official-reference/official-reference.repository.js';
import { REFERENCE_APPS, REFERENCE_REGIONS } from '../src/official-reference/official-reference.catalog.js';

test('reference queue isolates claims, atomically publishes, preserves failures and fences obsolete workers', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1, connectionTimeoutMillis: 10_000 });
  const schema = 'ref_test_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
  let database: Kysely<unknown> | undefined;
  try {
    await admin.query('create schema ' + schema);
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: '-c search_path=' + schema,
      max: 3, connectionTimeoutMillis: 10_000, statement_timeout: 10_000 });
    database = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
    const { error } = await new Migrator({ db: database, provider: migrationProvider, migrationTableSchema: schema }).migrateToLatest();
    if (error) throw error;
    const first = new OfficialReferenceRepository(pool); const second = new OfficialReferenceRepository(pool);
    await first.seed(); await first.seed();
    assert.equal(Number((await pool.query('select count(*) from official_reference_jobs')).rows[0].count), REFERENCE_APPS.length * REFERENCE_REGIONS.length + 1);
    assert.equal(Number((await pool.query("select count(*) from official_reference_jobs where country = 'cl'")).rows[0].count), 8);
    const [one, two] = await Promise.all([first.claimNext('fetch_run', 'one', 30_000), second.claimNext('fetch_run', 'two', 30_000)]);
    assert.ok(one); assert.ok(two); assert.notEqual(one.id, two.id);
    const fx = one.row.task_key === 'fx' ? one : two;
    const owner = fx === one ? first : second;
    const published = { date: '2026-09-27', cny: { cny: 1, usd: 0.14 } };
    await owner.publish(fx, published, new AbortController().signal);
    assert.deepEqual((await first.readPublished())[0].snapshot, published);
    await assert.rejects(owner.publish(fx, { date: 'bad' }, new AbortController().signal));
    await owner.fail('fetch_run', fx.id, fx.claimed_by, 'http://user:password@proxy', { retry: true, backoffMs: 0 });
    owner.onSettled('fetch_run', fx.id, fx.claimed_by);
    const saved = (await first.readPublished())[0];
    assert.deepEqual(saved.snapshot, published); assert.ok(saved.last_error); assert.ok(!saved.last_error.includes('password'));
    const retry = await owner.claimNext('fetch_run', 'retry', 30_000); assert.ok(retry); assert.equal(retry.id, fx.id);
    await pool.query("update official_reference_jobs set lease_until = clock_timestamp() - interval '1 second' where id = $1", [String(retry.id)]);
    const replacementOwner = new OfficialReferenceRepository(pool);
    const replacement = await replacementOwner.claimNext('fetch_run', 'replacement', 30_000); assert.ok(replacement); assert.equal(replacement.id, retry.id);
    await assert.rejects(owner.publish(retry, published, new AbortController().signal), /lease lost/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(replacementOwner.publish(replacement, published, controller.signal));
    await replacementOwner.publish(replacement, published, new AbortController().signal);
    await replacementOwner.complete('fetch_run', replacement.id, replacement.claimed_by);
    const state = (await pool.query('select status, attempts, available_at > now() as scheduled, last_error from official_reference_jobs where id = $1', [String(replacement.id)])).rows[0];
    assert.deepEqual({ ...state, attempts: String(state.attempts) }, { status: 'queued', attempts: '0', scheduled: true, last_error: null });

    // An outage can prevent lease release; the same live process must recover after DB reconnection.
    let unavailable = false;
    const recovering = new OfficialReferenceRepository({ query: (...args: unknown[]) => {
      if (unavailable) return Promise.reject(new Error('simulated DB outage'));
      return (pool.query as (...values: unknown[]) => unknown)(...args);
    } } as never);
    const interrupted = await recovering.claimNext('fetch_run', 'stable-worker', 30_000); assert.ok(interrupted);
    await pool.query("update official_reference_jobs set lease_until = clock_timestamp() - interval '1 second' where id = $1", [String(interrupted.id)]);
    const simultaneous = await recovering.claimNext('fetch_run', 'stable-worker', 30_000);
    assert.notEqual(simultaneous?.id, interrupted.id, 'do not duplicate an active local execution');
    unavailable = true;
    await assert.rejects(recovering.complete('fetch_run', interrupted.id, 'stable-worker'));
    unavailable = false;
    const beforeFinalFailure = await recovering.claimNext('fetch_run', 'stable-worker', 30_000);
    assert.notEqual(beforeFinalFailure?.id, interrupted.id, 'complete failure must retain ownership until the runtime finishes fail/requeue');
    unavailable = true;
    await assert.rejects(recovering.requeue('fetch_run', interrupted.id, 'stable-worker'));
    recovering.onSettled('fetch_run', interrupted.id, 'stable-worker');
    unavailable = false;
    const resumed = await recovering.claimNext('fetch_run', 'stable-worker', 30_000);
    assert.equal(resumed?.id, interrupted.id, 'reclaim after failed release without restarting the process');
  } finally {
    await database?.destroy();
    await admin.query('drop schema if exists ' + schema + ' cascade'); await admin.end();
  }
});

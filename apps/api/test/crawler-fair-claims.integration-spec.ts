import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { migrateToLatest } from '../scripts/migrate.js';
import { jsonb, type DatabaseSchema } from '../src/database/types.js';
import { JobsRepository } from '../src/jobs/jobs.repository.js';

describe('host-fair fetch claims', () => {
  let database: Kysely<DatabaseSchema>;
  let admin: Pool;
  let pool: Pool;
  let repository: JobsRepository;
  const schema = `fair_claims_${randomUUID().replaceAll('-', '')}`;
  const previousHostConcurrency = process.env.CRAWLER_HOST_CONCURRENCY;

  before(async () => {
    if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.CRAWLER_HOST_CONCURRENCY = '2';
    admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`create schema "${schema}"`);
    process.env.PG_SCHEMA = schema;
    pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path="${schema}",public`,
      max: 8,
    });
    database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    await migrateToLatest(database);
    repository = new JobsRepository(database);
  });

  beforeEach(async () => {
    process.env.CRAWLER_HOST_CONCURRENCY = '2';
    await database.deleteFrom('fetch_runs').execute();
    await database.deleteFrom('shops').execute();
  });

  after(async () => {
    await database?.destroy();
    await admin?.query(`drop schema if exists "${schema}" cascade`);
    await admin?.end();
    delete process.env.PG_SCHEMA;
    if (previousHostConcurrency === undefined) delete process.env.CRAWLER_HOST_CONCURRENCY;
    else process.env.CRAWLER_HOST_CONCURRENCY = previousHostConcurrency;
  });

  async function shop(url: string) {
    return (await database.insertInto('shops').values({
      platform: 'test', url: `${url}/${randomUUID()}`, name: randomUUID(),
    }).returning('id').executeTakeFirstOrThrow()).id;
  }

  async function task(shopId: bigint, taskType: 'list' | 'settlement' = 'list', age = 60_000) {
    return database.insertInto('fetch_runs').values({
      shop_id: shopId, task_type: taskType, status: 'queued',
      started_at: new Date(), available_at: new Date(Date.now() - age),
    }).returningAll().executeTakeFirstOrThrow();
  }

  async function burst(host: string, count: number, taskType: 'list' | 'settlement' = 'list', age = 60_000) {
    const rows = [];
    for (let i = 0; i < count; i++) rows.push(await task(await shop(host), taskType, age));
    return rows;
  }

  test('old host-A bursts cannot exclude host B or fill all 30 slots', async () => {
    const older = await burst('https://a.invalid', 35);
    const newer = await burst('https://b.invalid', 3, 'list', 30_000);
    const claims = await repository.claimAvailable('fetch', 'fair-worker', 30);
    assert.equal(claims.length, 4);
    assert.equal(claims.filter(claim => older.some(row => row.id === claim.id)).length, 2);
    assert.equal(claims.filter(claim => newer.some(row => row.id === claim.id)).length, 2);
  });

  test('one head per host is admitted before a second slot on an older host', async () => {
    await burst('https://a.invalid', 10);
    const newer = await burst('https://b.invalid', 2, 'list', 30_000);
    const claims = await repository.claimAvailable('fetch', 'fair-worker', 2);
    assert.equal(claims.length, 2);
    assert.equal(claims.filter(claim => newer.some(row => row.id === claim.id)).length, 1);
  });

  test('independent concurrent claimers share normalized host caps', async () => {
    await burst('https://CAP.invalid:443', 6);
    await burst('https://cap.invalid', 6);
    const batches = await Promise.all(Array.from({ length: 6 }, (_, index) =>
      new JobsRepository(database).claimAvailable('fetch', `worker-${index}`, 1)));
    assert.equal(batches.flat().length, 2);
    assert.equal(new Set(batches.flat().map(claim => claim.id)).size, 2);
    assert.equal((await repository.claimAvailable('fetch', 'later-worker', 30)).length, 0);
  });

  test('default HTTP ports share a cap while non-default ports remain independent', async () => {
    await burst('http://CAP.invalid:80', 3);
    await burst('http://cap.invalid', 3);
    const separate = await burst('http://cap.invalid:8080', 3);
    const claims = await repository.claimAvailable('fetch', 'ports-worker', 30);
    assert.equal(claims.length, 4);
    assert.equal(claims.filter(claim => separate.some(row => row.id === claim.id)).length, 2);
  });

  test('a shop cannot run list and settlement tasks together, including across claimers', async () => {
    const id = await shop('https://same-shop.invalid');
    const list = await task(id);
    const settlement = await task(id, 'settlement', 30_000);
    await task(id, 'list', 20_000);
    const claims = (await Promise.all([
      repository.claimAvailable('fetch', 'worker-a', 30),
      repository.claimAvailable('fetch', 'worker-b', 30),
    ])).flat();
    assert.deepEqual(claims.map(claim => claim.id), [list.id]);
    await repository.complete('fetch_run', list.id, claims[0]!.claimed_by);
    assert.equal((await repository.claimNext('fetch_run', 'worker-c', 5000))?.id, settlement.id);
  });

  test('list and settlement heads share admission within a batch', async () => {
    await burst('https://types.invalid', 8);
    const settlements = await burst('https://types.invalid', 4, 'settlement', 30_000);
    const claims = await repository.claimAvailable('fetch', 'types-worker', 2);
    assert.equal(claims.length, 2);
    assert.equal(claims.filter(claim => settlements.some(row => row.id === claim.id)).length, 1);
  });

  test('type admission accounts for running work across successive claims', async () => {
    await burst('https://types.invalid', 8);
    const settlements = await burst('https://types.invalid', 4, 'settlement', 30_000);
    const first = await repository.claimNext('fetch_run', 'list-worker', 5000);
    assert.equal(first?.row.task_type, 'list');
    const second = await repository.claimNext('fetch_run', 'settlement-worker', 5000);
    assert.ok(settlements.some(row => row.id === second?.id));
  });

  test('type fairness can select a newer type head from the same pending shop', async () => {
    const active = await task(await shop('https://types.invalid'));
    await repository.claimNext('fetch_run', 'list-worker', 5000);
    const id = await shop('https://types.invalid');
    await task(id);
    const settlement = await task(id, 'settlement', 30_000);
    assert.equal((await repository.claimNext('fetch_run', 'next-worker', 5000))?.id, settlement.id);
    assert.notEqual(active.id, settlement.id);
  });

  test('expired and null leases recover with fencing, attempts and lease failure counters', async () => {
    const expired = await task(await shop('https://recover.invalid'));
    const legacy = await task(await shop('https://recover.invalid'));
    await database.updateTable('fetch_runs').set({
      status: 'running', claimed_by: 'old-worker', claim_token: 'old-token', attempts: 3n,
      lease_until: new Date(Date.now() - 1000),
      crawl_metrics: jsonb({ version: 1, leaseFailures: 2 }),
    }).where('id', '=', expired.id).execute();
    await database.updateTable('fetch_runs').set({
      status: 'running', claimed_by: 'legacy-worker', lease_until: null,
    }).where('id', '=', legacy.id).execute();
    await task(expired.shop_id, 'settlement', 30_000);
    const claims = await repository.claimAvailable('fetch', 'recovery-worker', 30);
    assert.equal(claims.length, 2);
    const recovered = claims.find(claim => claim.id === expired.id)!;
    assert.equal(recovered.attempts, 4n);
    assert.notEqual(recovered.row.claim_token, 'old-token');
    assert.deepEqual(recovered.row.crawl_metrics, { version: 1, leaseFailures: 3 });
    assert.deepEqual(claims.find(claim => claim.id === legacy.id)?.row.crawl_metrics, { version: 1, leaseFailures: 1 });
    await assert.rejects(repository.complete('fetch_run', expired.id, 'old-worker'), /lease|owner/i);
  });

  test('future work is not claimable and configured host caps are honored', async () => {
    process.env.CRAWLER_HOST_CONCURRENCY = '1';
    await task(await shop('https://future.invalid'), 'list', -60_000);
    const due = await burst('https://due.invalid', 4);
    const claims = await repository.claimAvailable('fetch', 'bounded-worker', 30);
    assert.deepEqual(claims.map(claim => claim.id), [due[0]!.id]);
  });

  test('locked heads are skipped without blocking claims on other shops', async () => {
    const locked = await task(await shop('https://locked.invalid'));
    const unlocked = await task(await shop('https://unlocked.invalid'));
    const blocker = await pool.connect();
    let claiming: ReturnType<JobsRepository['claimAvailable']> | undefined;
    try {
      await blocker.query('begin');
      await blocker.query('select id from fetch_runs where id = $1 for update', [locked.id]);
      claiming = repository.claimAvailable('fetch', 'skip-worker', 2);
      const outcome = await Promise.race([
        claiming,
        new Promise<null>(resolve => setTimeout(() => resolve(null), 500)),
      ]);
      assert.ok(outcome, 'claim must not wait for a locked fetch row');
      assert.deepEqual(outcome.map(claim => claim.id), [unlocked.id]);
    } finally {
      await blocker.query('rollback');
      blocker.release();
      await claiming;
    }
    assert.equal((await sql<{ status: string }>`select status from fetch_runs where id = ${locked.id}`.execute(database)).rows[0]?.status, 'queued');
  });
});

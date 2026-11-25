import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { Kysely, PostgresDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool, type PoolClient } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';
import { AdminRepository } from '../src/admin/admin.repository.js';
import type { DatabaseSchema } from '../src/database/types.js';

const PREVIOUS = '060_statistics_query_indexes_20261125';
const CURRENT = '061_fetch_run_counts_20261125';
type Statement = [string, unknown[]];

describe('transactional admin fetch run counts', { concurrency: false }, () => {
  const schema = `fetch_counts_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let pool: Pool;
  let database: Kysely<DatabaseSchema>;
  let migrator: Migrator;
  let shops: bigint[];

  before(async () => {
    const connectionString = process.env.TEST_DATABASE_URL;
    assert.ok(connectionString, 'TEST_DATABASE_URL is required');
    admin = new Pool({ connectionString, statement_timeout: 10000 });
    await admin.query(`create schema "${schema}"`);
    pool = new Pool({
      connectionString, max: 5,
      options: `-c search_path=${schema},public -c statement_timeout=10000 -c lock_timeout=5000`,
    });
    database = new Kysely({ dialect: new PostgresDialect({ pool }) });
    migrator = new Migrator({ db: database, provider: migrationProvider, migrationTableSchema: schema });
    await migrate(PREVIOUS);
    shops = (await pool.query(`insert into shops(name, platform, url)
      values ('Counts A', 'test', 'https://counts-a.invalid'), ('Counts B', 'test', 'https://counts-b.invalid')
      returning id`)).rows.map(row => row.id);
    await pool.query(...insert(shops[0]!, 'queued', 3));
    await pool.query(...insert(shops[0]!, 'failed', 2));
    await pool.query(...insert(shops[1]!, 'running', 1));
    await migrate(CURRENT);
  });

  after(async () => {
    await database?.destroy();
    if (admin) {
      await admin.query(`drop schema if exists "${schema}" cascade`);
      await admin.end();
    }
  });

  async function migrate(target: string) {
    const result = await migrator.migrateTo(target);
    if (result.error) throw result.error;
  }

  function insert(shop: bigint, status: string, count = 1): Statement {
    return [`insert into fetch_runs(shop_id, status, started_at)
      select $1, $2, now() from generate_series(1, $3::int) returning id`, [shop, status, count]];
  }

  async function counts(client: Pick<PoolClient, 'query'> = pool) {
    return (await client.query(`select shop_id, status, run_count from fetch_run_counts
      order by shop_id, status collate "C"`)).rows;
  }

  async function assertExact(client: Pick<PoolClient, 'query'> = pool) {
    const result = await client.query(`with expected as (
      select shop_id, status, count(*) as run_count from fetch_runs group by shop_id, status
    ) select e.*, c.run_count as actual from expected e full join fetch_run_counts c using (shop_id, status)
      where coalesce(e.run_count, 0) is distinct from c.run_count or c.run_count < 0`);
    assert.deepEqual(result.rows, [], 'derived counts must match source rows in the same snapshot');
  }

  async function versions() {
    return (await pool.query(`select shop_id, status, run_count, xmin::text as xmin, ctid::text as ctid
      from fetch_run_counts order by shop_id, status collate "C"`)).rows;
  }

  async function waitBlocked(pid: number) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if ((await admin.query('select cardinality(pg_blocking_pids($1)) > 0 as blocked', [pid])).rows[0].blocked) return;
      await setTimeout(10);
    }
    assert.fail('competing writer did not enter a lock wait');
  }

  async function contend(first: Statement, second: Statement, commit: boolean) {
    const a = await pool.connect();
    const b = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await a.query('begin');
      await b.query('begin');
      const pid = (await b.query('select pg_backend_pid() as pid')).rows[0].pid as number;
      await a.query(...first);
      pending = b.query(...second).catch((error: unknown) => error);
      await waitBlocked(pid);
      await a.query(commit ? 'commit' : 'rollback');
      const result = await pending;
      if (result instanceof Error) throw result;
      await b.query('commit');
    } finally {
      await a.query('rollback');
      await pending;
      await b.query('rollback');
      a.release();
      b.release();
    }
  }

  test('backfills existing history and installs only statement triggers', async () => {
    assert.deepEqual(await counts(), [
      { shop_id: shops[0], status: 'failed', run_count: 2n },
      { shop_id: shops[0], status: 'queued', run_count: 3n },
      { shop_id: shops[1], status: 'running', run_count: 1n },
    ]);
    await assertExact();
    const triggers = (await pool.query(`select tgname, (tgtype::int & 1) = 0 as statement_level
      from pg_trigger where tgrelid = 'fetch_runs'::regclass and tgname like 'fetch_run_counts_%'`)).rows;
    assert.equal(triggers.length, 4);
    assert.ok(triggers.every(row => row.statement_level));
    await assert.rejects(pool.query(`insert into fetch_run_counts values ($1, 'invalid', -1)`, [shops[0]]), { code: '23514' });
  });

  describe('writes and reads', () => {
    beforeEach(async () => { await pool.query('truncate fetch_runs cascade'); });
    afterEach(async () => { await assertExact(); });

    test('aggregates batch inserts, all status changes, shop moves and deletes', async () => {
      await pool.query(...insert(shops[0]!, 'queued', 4));
      await pool.query(...insert(shops[1]!, 'queued', 2));
      for (const status of ['running', 'succeeded', 'deferred', 'failed', 'cancelled', 'queued']) {
        await pool.query('update fetch_runs set status = $1', [status]);
        await assertExact();
      }
      await pool.query('update fetch_runs set shop_id = $1, status = $2 where shop_id = $3', [shops[1], 'failed', shops[0]]);
      await assertExact();
      await pool.query(`delete from fetch_runs where status = 'queued'`);
      await assertExact();
      await pool.query('delete from fetch_runs');
      assert.ok((await counts()).every(row => row.run_count === 0n));
    });

    test('skips counts for unrelated updates, unchanged keys, empty statements and net-zero swaps', async () => {
      await pool.query(...insert(shops[0]!, 'queued'));
      await pool.query(...insert(shops[1]!, 'failed'));
      const original = await versions();
      await pool.query(`update fetch_runs set item_count = 10, error = 'retry', status = status`);
      await pool.query('update fetch_runs set status = status where false');
      await pool.query('delete from fetch_runs where false');
      await pool.query(`insert into fetch_runs(shop_id, status, started_at) select $1, 'queued', now() where false`, [shops[0]]);
      await pool.query(`update fetch_runs set shop_id = case when shop_id = $1 then $2::bigint else $1::bigint end,
        status = case when status = 'queued' then 'failed' else 'queued' end`, shops);
      assert.deepEqual(await versions(), original);
    });

    test('counts both transition sets of mixed insert/update upserts', async () => {
      const existing = (await pool.query(...insert(shops[0]!, 'queued'))).rows[0].id;
      await pool.query(`insert into fetch_runs(id, shop_id, status, started_at) values
        ($1, $2, 'failed', now()), (nextval(pg_get_serial_sequence('fetch_runs', 'id')), $3, 'running', now())
        on conflict (id) do update set shop_id = excluded.shop_id, status = excluded.status`,
      [existing, shops[1], shops[0]]);
      await assertExact();
      assert.deepEqual((await counts()).filter(row => row.run_count > 0n), [
        { shop_id: shops[0], status: 'running', run_count: 1n },
        { shop_id: shops[1], status: 'failed', run_count: 1n },
      ]);
    });

    test('rolls back deltas with source writes and hides uncommitted counts from other readers', async () => {
      const first = (await pool.query(...insert(shops[0]!, 'queued', 2))).rows;
      const original = await counts();
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(...insert(shops[1]!, 'failed', 3));
        await client.query(`update fetch_runs set shop_id = $1, status = 'running' where id = $2`, [shops[1], first[0].id]);
        await client.query('delete from fetch_runs where id = $1', [first[1].id]);
        await assertExact(client);
        assert.deepEqual(await counts(), original);
      } finally {
        await client.query('rollback');
        client.release();
      }
      assert.deepEqual(await counts(), original);
    });

    test('counts concurrent first arrivals and serializes last exits with arrivals on commit and rollback', async () => {
      for (const commit of [true, false]) {
        await pool.query('truncate fetch_runs cascade');
        await contend(insert(shops[0]!, 'queued', 2), insert(shops[0]!, 'queued', 3), commit);
        assert.equal((await counts())[0].run_count, commit ? 5n : 3n);
        await contend(['delete from fetch_runs', []], insert(shops[0]!, 'queued'), commit);
        assert.equal((await counts())[0].run_count, commit ? 1n : 4n);
      }
    });

    test('locks opposing shop/status moves in a consistent order', async () => {
      for (const otherShop of shops) {
        await pool.query('truncate fetch_runs cascade');
        const left = (await pool.query(...insert(shops[0]!, 'queued', 4))).rows.map(row => String(row.id));
        const right = (await pool.query(...insert(otherShop, 'failed', 4))).rows.map(row => String(row.id));
        for (let round = 0; round < 4; round++) {
          const a = await pool.connect();
          const b = await pool.connect();
          try {
            const targets = round % 2 === 0 ? [[otherShop, 'failed'], [shops[0], 'queued']] : [[shops[0], 'queued'], [otherShop, 'failed']];
            const results = await Promise.allSettled([a, b].map((client, i) => client.query(
              'update fetch_runs set shop_id = $1, status = $2 where id = any($3::bigint[])',
              [...targets[i]!, i === 0 ? left : right],
            )));
            for (const result of results) if (result.status === 'rejected') throw result.reason;
          } finally { a.release(); b.release(); }
          await assertExact();
          assert.deepEqual((await counts()).filter(row => row.run_count > 0n).map(row => row.run_count), [4n, 4n]);
        }
      }
    });

    test('handles cascading shop deletion without a competing counter foreign key', async () => {
      const shop = (await pool.query(`insert into shops(name, platform, url)
        values ('Cascade', 'test', 'https://counts-cascade.invalid') returning id`)).rows[0].id;
      await pool.query(...insert(shop, 'succeeded', 3));
      await pool.query('delete from shops where id = $1', [shop]);
      assert.equal((await counts()).find(row => row.shop_id === shop)?.run_count, 0n);
    });

    test('truncates transactionally and supports new inserts after a committed reset', async () => {
      await pool.query(...insert(shops[0]!, 'queued', 2));
      const original = await counts();
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('truncate fetch_runs cascade');
        assert.deepEqual(await counts(client), []);
        await assertExact(client);
      } finally {
        await client.query('rollback');
        client.release();
      }
      assert.deepEqual(await counts(), original);
      await pool.query('truncate fetch_runs cascade');
      assert.deepEqual(await counts(), []);
      await pool.query(...insert(shops[1]!, 'succeeded'));
      assert.equal((await counts())[0].run_count, 1n);
    });

    test('serializes truncate resets with concurrent arrivals on commit and rollback', async () => {
      for (const commit of [true, false]) {
        await pool.query('truncate fetch_runs cascade');
        await pool.query(...insert(shops[0]!, 'queued', 2));
        await contend(['truncate fetch_runs cascade', []], insert(shops[0]!, 'queued'), commit);
        assert.equal((await counts())[0].run_count, commit ? 1n : 3n);
      }
    });

    test('admin totals match every shop/status filter, cursor order and empty page immediately after writes', async () => {
      await pool.query(...insert(shops[0]!, 'queued', 3));
      await pool.query(...insert(shops[0]!, 'failed', 2));
      await pool.query(...insert(shops[1]!, 'queued', 1));
      const repository = new AdminRepository(database);
      for (const shopId of [undefined, shops[0], shops[1], 999999n]) {
        for (const status of [undefined, 'queued', 'failed', 'succeeded'] as const) {
          const cursor = await repository.listRunHistory({ shopId, status, limit: 100 });
          for (const page of [1, 2, 100]) {
            const result = await repository.listRunHistory({ shopId, status, page, limit: 2 });
            assert.equal(result.total, cursor.items.length);
            assert.deepEqual(result.items, cursor.items.slice((page - 1) * 2, page * 2));
          }
        }
      }
      await pool.query('delete from fetch_runs where shop_id = $1', [shops[0]]);
      assert.equal((await repository.listRunHistory({ page: 1 })).total, 1);
      await pool.query(`update fetch_runs set status = 'failed'`);
      assert.equal((await repository.listRunHistory({ page: 1, status: 'queued' })).total, 0);
      assert.equal((await repository.listRunHistory({ page: 1, status: 'failed' })).total, 1);
    });

    test('downgrades and rebuilds counts without changing history', async () => {
      await pool.query(...insert(shops[0]!, 'succeeded', 2));
      const source = async () => (await pool.query('select *, xmin::text as xmin from fetch_runs order by id')).rows;
      const original = await source();
      await migrate(PREVIOUS);
      assert.deepEqual(await source(), original);
      assert.equal((await pool.query(`select to_regclass($1) as name`, [`${schema}.fetch_run_counts`])).rows[0].name, null);
      assert.equal((await pool.query(`select count(*)::int as n from pg_trigger
        where tgrelid = 'fetch_runs'::regclass and tgname like 'fetch_run_counts_%'`)).rows[0].n, 0);
      await migrate(CURRENT);
      assert.deepEqual(await source(), original);
      await assertExact();
    });

    test('migration waits for active source writes and includes their committed changes in backfill', async () => {
      await migrate(PREVIOUS);
      const writer = await pool.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await writer.query('begin');
        await writer.query(...insert(shops[0]!, 'queued', 3));
        pending = migrate(CURRENT).catch((error: unknown) => error);
        const deadline = Date.now() + 3000;
        let blocked = false;
        while (Date.now() < deadline) {
          blocked = (await admin.query(`select exists(select 1 from pg_locks
            where relation = $1::regclass and mode = 'ShareRowExclusiveLock' and not granted) as blocked`,
          [`${schema}.fetch_runs`])).rows[0].blocked;
          if (blocked) break;
          await setTimeout(10);
        }
        assert.ok(blocked, 'backfill must wait for source writers');
        await writer.query('commit');
        const result = await pending;
        if (result instanceof Error) throw result;
        assert.equal((await counts())[0].run_count, 3n);
      } finally {
        await writer.query('rollback');
        await pending;
        writer.release();
      }
    });
  });
});

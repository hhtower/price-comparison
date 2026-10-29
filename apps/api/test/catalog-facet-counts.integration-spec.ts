import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { Kysely, Migrator, PostgresDialect } from 'kysely';
import { Pool, type PoolClient } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';

const PREVIOUS = '016_catalog_read_offers_20261023';
const CURRENT = '017_catalog_facet_counts_20261023';
const A = [{ name: 'region', value: 'us' }];
const B = [{ name: 'region', value: 'jp' }];
const MULTI = [
  { name: 'region', value: 'us' },
  { name: 'region', value: 'jp' },
  { name: 'access', value: 'shared' },
];
type Tags = typeof A;
type Statement = [string, unknown[]];

describe('exact global catalog facet counts', { concurrency: false }, () => {
  const schema = `facet_counts_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let pool: Pool;
  let database: Kysely<unknown>;
  let migrator: Migrator;
  let shop: string;

  before(async () => {
    const connectionString = process.env.TEST_DATABASE_URL;
    assert.ok(connectionString, 'TEST_DATABASE_URL is required');
    admin = new Pool({ connectionString, statement_timeout: 10000 });
    await admin.query(`create schema "${schema}"`);
    pool = new Pool({
      connectionString, max: 5,
      options: `-c search_path=${schema},public -c statement_timeout=10000 -c lock_timeout=5000`,
    });
    database = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
    migrator = new Migrator({ db: database, provider: migrationProvider, migrationTableSchema: schema });
    await migrate(PREVIOUS);
    shop = (await pool.query(`insert into shops (name, platform, url)
      values ('Facet counts', 'test', $1) returning id`, [`https://${randomUUID()}.invalid`])).rows[0].id;
    const ids = await products(4);
    await insertFacts(ids, [A, A, MULTI, []]);
    const result = await migrator.migrateTo(CURRENT);
    assert.equal(result.error, undefined, '017 must exist and install the facet counts migration');
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

  async function products(count: number): Promise<string[]> {
    const rows = (await pool.query(`insert into products (shop_id, external_id, name, normalized_key, url)
      select $1, $2 || n, 'Facet source', $2 || n, 'https://facet.invalid/' || $2 || n
      from generate_series(1, $3::int) n returning id`, [shop, randomUUID(), count])).rows;
    const ids = rows.map(row => String(row.id));
    // Product triggers create default facts; each test inserts its own explicit tag sets.
    await pool.query('delete from catalog_product_facts where product_id = any($1::bigint[])', [ids]);
    return ids;
  }

  function insertStatement(ids: string[], tags: Tags[]): Statement {
    return [`insert into catalog_product_facts (product_id, tags, tag_text)
      select product_id, tags, 'fixture' from jsonb_to_recordset($1::jsonb) as r(product_id bigint, tags jsonb)`,
    [JSON.stringify(ids.map((product_id, i) => ({ product_id, tags: tags[i] })))]];
  }

  async function insertFacts(ids: string[], tags: Tags[]) {
    await pool.query(...insertStatement(ids, tags));
  }

  function move(id: string, tags: Tags): Statement {
    return ['update catalog_product_facts set tags = $1::jsonb where product_id = $2', [JSON.stringify(tags), id]];
  }

  async function counts(client: Pick<PoolClient, 'query'> = pool) {
    return (await client.query(`select facet_tags, product_count from catalog_read_facet_counts
      order by facet_tags collate "C"`)).rows;
  }

  async function assertExact(client: Pick<PoolClient, 'query'> = pool) {
    // Compare in one snapshot, including empty tag sets and sources with no public membership or quote.
    const result = await client.query(`with expected as (
      select facet_tags, count(*)::bigint as product_count from catalog_product_facts group by facet_tags
    ) select coalesce(e.facet_tags, c.facet_tags) as facet_tags, e.product_count as expected, c.product_count as actual
      from expected e full join catalog_read_facet_counts c using (facet_tags)
      where e.product_count is distinct from c.product_count or c.product_count <= 0`);
    assert.deepEqual(result.rows, [], 'counts must equal all facts and omit zero-count sets');
  }

  async function versions() {
    return (await pool.query(`select facet_tags, product_count, xmin::text as xmin, ctid::text as ctid
      from catalog_read_facet_counts order by facet_tags collate "C"`)).rows;
  }

  async function waitBlocked(pid: number) {
    const deadline = Date.now() + 2000;
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

  async function simultaneous(statements: Statement[]) {
    const clients = await Promise.all(statements.map(() => pool.connect()));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    try {
      await Promise.all(clients.map(client => client.query('begin')));
      const writes = clients.map(async (client, i) => {
        await gate;
        try {
          await client.query(...statements[i]!);
          await client.query('commit');
        } catch (error) {
          await client.query('rollback');
          throw error;
        }
      });
      release();
      const results = await Promise.allSettled(writes);
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    } finally {
      release();
      await Promise.all(clients.map(async client => {
        await client.query('rollback');
        client.release();
      }));
    }
  }

  test('backfills every existing fact, including multi-value, empty and non-public quoteless sets', async () => {
    assert.equal((await pool.query('select count(*)::int as n from offers')).rows[0].n, 0);
    assert.equal((await pool.query('select count(*)::int as n from standard_product_members')).rows[0].n, 0);
    assert.deepEqual((await counts()).map(row => ({
      tags: JSON.parse(row.facet_tags), count: row.product_count,
    })), [
      { tags: [], count: 1n },
      { tags: [{ name: 'access', value: 'shared' }, { name: 'region', value: 'jp' }, { name: 'region', value: 'us' }], count: 1n },
      { tags: A, count: 2n },
    ]);
    await assertExact();
    await assert.rejects(pool.query(`insert into catalog_read_facet_counts values ('invalid', -1)`), { code: '23514' });
  });

  describe('source transactions', () => {
    beforeEach(async () => { await pool.query('truncate catalog_product_facts'); });
    afterEach(async () => { await assertExact(); });

    test('aggregates batch inserts, changed sets and deletes, deleting the final count row', async () => {
      const ids = await products(5);
      await insertFacts(ids, [A, A, B, MULTI, []]);
      await assertExact();
      await pool.query(`update catalog_product_facts set tags = $1::jsonb
        where product_id = any($2::bigint[])`, [JSON.stringify(B), ids.slice(0, 3)]);
      assert.deepEqual((await counts()).map(row => row.product_count).sort(), [1n, 1n, 3n]);
      await assertExact();
      await pool.query('delete from catalog_product_facts where product_id = any($1::bigint[])', [ids.slice(0, 4)]);
      assert.deepEqual(await counts(), [{ facet_tags: '[]', product_count: 1n }]);
      await pool.query('delete from catalog_product_facts');
      assert.deepEqual(await counts(), []);
    });

    test('does not rewrite counts for tag text, ignored tags, unchanged keys or zero-net batch swaps', async () => {
      const ids = await products(3);
      await insertFacts(ids.slice(0, 2), [A, B]);
      const original = await versions();
      await pool.query(`update catalog_product_facts set tag_text = 'new text',
        tags = tags || '[{"name":"internal_note","value":"changed"}]'::jsonb`);
      assert.deepEqual(await versions(), original);
      await pool.query('update catalog_product_facts set product_id = $1 where product_id = $2', [ids[2], ids[0]]);
      assert.deepEqual(await versions(), original, 'product ID changes must have zero facet delta');
      await pool.query(`update catalog_product_facts set tags = case when product_id = $1 then $2::jsonb else $3::jsonb end`,
        [ids[2], JSON.stringify(B), JSON.stringify(A)]);
      assert.deepEqual(await versions(), original, 'opposite moves in one statement must not touch counts');
      await pool.query('update catalog_product_facts set tags = tags where false');
      await pool.query('delete from catalog_product_facts where false');
      assert.deepEqual(await versions(), original);
    });

    test('rolls inserts, moves and deletes back with their source transaction and hides uncommitted deltas', async () => {
      const ids = await products(3);
      await insertFacts(ids.slice(0, 2), [A, B]);
      const original = await counts();
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(...insertStatement([ids[2]!], [MULTI]));
        await client.query(...move(ids[0]!, MULTI));
        await client.query('delete from catalog_product_facts where product_id = $1', [ids[1]]);
        await assertExact(client);
        assert.deepEqual((await counts(client)).map(row => row.product_count), [2n]);
        assert.deepEqual(await counts(), original);
      } finally {
        await client.query('rollback');
        client.release();
      }
      assert.deepEqual(await counts(), original);
    });

    test('orders opposing A-to-B and B-to-A batches before acquiring count locks', async () => {
      const ids = await products(8);
      await insertFacts(ids, [A, A, A, A, B, B, B, B]);
      for (let round = 0; round < 8; round++) {
        const swap = round % 2 === 0;
        await simultaneous([
          [`update catalog_product_facts set tags = $1::jsonb where product_id = any($2::bigint[])`,
            [JSON.stringify(swap ? B : A), ids.slice(0, 4)]],
          [`update catalog_product_facts set tags = $1::jsonb where product_id = any($2::bigint[])`,
            [JSON.stringify(swap ? A : B), ids.slice(4)]],
        ]);
        await assertExact();
        assert.deepEqual((await counts()).map(row => row.product_count), [4n, 4n]);
      }
    });

    test('serializes last-row exits with same-set arrivals on both commit and rollback', async () => {
      for (const commit of [true, false]) {
        await pool.query('truncate catalog_product_facts');
        const ids = await products(3);
        await insertFacts(ids.slice(0, 2), [A, B]);
        await contend(move(ids[0]!, B), move(ids[1]!, A), commit);
        await assertExact();
        assert.deepEqual((await counts()).map(row => row.product_count).sort(), commit ? [1n, 1n] : [2n]);
        await contend(
          ['delete from catalog_product_facts where product_id = any($1::bigint[])', [ids.slice(0, 2)]],
          insertStatement([ids[2]!], [A]), commit,
        );
        await assertExact();
        assert.deepEqual((await counts()).map(row => row.product_count).sort(), commit ? [1n] : [3n]);
      }
    });

    test('counts concurrent first arrivals into a previously absent set', async () => {
      const ids = await products(4);
      await simultaneous([
        insertStatement(ids.slice(0, 2), [MULTI, MULTI]),
        insertStatement(ids.slice(2), [MULTI, MULTI]),
      ]);
      assert.deepEqual((await counts()).map(row => row.product_count), [4n]);
    });

    test('truncates transactionally and rebuilds through down/up without changing business facts', async () => {
      const ids = await products(2);
      await insertFacts(ids, [A, MULTI]);
      const original = await counts();
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('truncate catalog_product_facts');
        assert.deepEqual(await counts(client), []);
        await client.query('rollback');
      } finally {
        await client.query('rollback');
        client.release();
      }
      assert.deepEqual(await counts(), original);
      await pool.query('truncate catalog_product_facts');
      assert.deepEqual(await counts(), []);
      await insertFacts(ids, [A, MULTI]);
      const source = async () => (await pool.query(`select to_jsonb(f) as fact, xmin::text as xmin
        from catalog_product_facts f order by product_id`)).rows;
      const facts = await source();
      await migrate(PREVIOUS);
      assert.deepEqual(await source(), facts);
      assert.equal((await pool.query('select to_regclass($1) as name', [`${schema}.catalog_read_facet_counts`])).rows[0].name, null);
      assert.equal((await pool.query(`select count(*)::int as n from pg_trigger t
        join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and t.tgname like 'catalog_read_facet_counts_%'`, [schema])).rows[0].n, 0);
      assert.equal((await pool.query(`select count(*)::int as n from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = $1 and p.proname like 'catalog_read_facet_counts_%'`, [schema])).rows[0].n, 0);
      assert.ok((await pool.query('select to_regclass($1) as name', [`${schema}.catalog_read_offers`])).rows[0].name);
      await migrate(CURRENT);
      assert.deepEqual(await source(), facts);
      assert.deepEqual(await counts(), original);
      await pool.query(...move(ids[0]!, MULTI));
      assert.deepEqual((await counts()).map(row => row.product_count), [2n]);
    });
  });
});

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { Kysely, PostgresDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool, type PoolClient } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';

const PREVIOUS = '061_fetch_run_counts_20261125';
const CURRENT = '062_ai_report_candidates_20261125';
const DERIVED_OBJECTS = [
  'ai_job_report_profiles', 'ai_job_report_rows', 'ai_job_report_rows_profile',
  'ai_members_report_attention', 'ai_jobs_shop_history', 'ai_jobs_identity_history',
  'ai_jobs_latest_identity', 'products_report_candidates', 'product_decisions_report_latest',
];
const FIELDS = 'job_type, status, prompt_version, rule_version, pipeline_versions';
type Group = {
  job_type: string; status: string; prompt_version: string; rule_version: string;
  pipeline_versions: Record<string, unknown>;
};
type Statement = [string, unknown[]];
const A: Group = {
  job_type: 'incremental', status: 'queued', prompt_version: 'prompt-a', rule_version: 'rule-a',
  pipeline_versions: { prompt: 'v1', schema: 'v1' },
};
const B: Group = {
  job_type: 'tag_extraction', status: 'failed', prompt_version: 'prompt-b', rule_version: 'rule-b',
  pipeline_versions: { prompt: 'v2', schema: 'v2' },
};
const groups: Group[] = [
  A, { ...A, job_type: B.job_type }, { ...A, status: B.status },
  { ...A, prompt_version: B.prompt_version }, { ...A, rule_version: B.rule_version },
  { ...A, pipeline_versions: { schema: 'v2', evidence: 'x'.repeat(6000) } },
];

describe('exact AI job counts migration', { concurrency: false }, () => {
  const schema = `ai_counts_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let pool: Pool;
  let database: Kysely<unknown>;
  let migrator: Migrator;
  let created = false;
  let sourceBeforeMigration: Record<string, unknown>[];

  before(async () => {
    const connectionString = process.env.TEST_DATABASE_URL;
    assert.ok(connectionString, 'TEST_DATABASE_URL is required');
    admin = new Pool({ connectionString, statement_timeout: 15000 });
    await admin.query(`create schema "${schema}"`);
    created = true;
    pool = new Pool({
      connectionString, max: 5,
      options: `-c search_path=${schema},public -c statement_timeout=15000 -c lock_timeout=5000`,
    });
    database = new Kysely({ dialect: new PostgresDialect({ pool }) });
    migrator = new Migrator({ db: database, provider: migrationProvider, migrationTableSchema: schema });
    await migrate(PREVIOUS);
    await pool.query(...insert([...groups, A]));
    sourceBeforeMigration = await sourceJobs();
    await migrate(CURRENT);
  });

  after(async () => {
    await database?.destroy();
    if (admin) {
      try { if (created) await admin.query(`drop schema "${schema}" cascade`); }
      finally { await admin.end(); }
    }
  });

  async function migrate(target: string) {
    const result = await migrator.migrateTo(target);
    if (result.error) throw result.error;
  }

  function insert(values: Group[]): Statement {
    return [`insert into ai_jobs (${FIELDS}, model, total)
      select ${FIELDS}, 'count-test', 0 from jsonb_to_recordset($1::jsonb)
        as r(job_type text, status text, prompt_version text, rule_version text, pipeline_versions jsonb)
      returning id`, [JSON.stringify(values)]];
  }

  function move(ids: bigint[], group: Group): Statement {
    return [`update ai_jobs set job_type=$1, status=$2, prompt_version=$3, rule_version=$4, pipeline_versions=$5::jsonb
      where id = any($6::bigint[])`,
    [group.job_type, group.status, group.prompt_version, group.rule_version, JSON.stringify(group.pipeline_versions), ids]];
  }

  async function memberships(client: Pick<PoolClient, 'query'> = pool) {
    return (await client.query('select * from ai_job_report_rows order by job_id')).rows;
  }

  async function sourceJobs() {
    return (await pool.query(`select *, xmin::text as xmin, xmax::text as xmax, ctid::text as ctid
      from ai_jobs order by id`)).rows;
  }

  async function profiles(client: Pick<PoolClient, 'query'> = pool) {
    return (await client.query(`select *, xmin::text as xmin, ctid::text as ctid
      from ai_job_report_profiles order by identity_hash`)).rows;
  }

  async function assertExact(client: Pick<PoolClient, 'query'> = pool) {
    const rows = await client.query(`with expected as (
      select id as job_id, sha256(convert_to(jsonb_build_array(${FIELDS})::text, 'UTF8')) as identity_hash,
        ${FIELDS} from ai_jobs
    ), actual as (
      select r.job_id, p.* from ai_job_report_rows r join ai_job_report_profiles p using (identity_hash)
    ) select e.job_id as expected_id, a.job_id as actual_id
      from expected e full join actual a using (job_id)
      where e.identity_hash is distinct from a.identity_hash
        or (e.job_type,e.status,e.prompt_version,e.rule_version,e.pipeline_versions)
          is distinct from (a.job_type,a.status,a.prompt_version,a.rule_version,a.pipeline_versions)`);
    assert.deepEqual(rows.rows, [], 'every job must have exactly its current report profile');
    const result = await client.query(`with expected as (
      select ${FIELDS}, count(*) as total from ai_jobs group by ${FIELDS}
    ), actual as (
      select ${FIELDS}, sum(member_count) as total from (
        select p.*, (select count(*) from ai_job_report_rows r where r.identity_hash=p.identity_hash) as member_count
        from ai_job_report_profiles p
      ) reports group by ${FIELDS}
    ) select e.*, a.total as actual from expected e full join actual a using (${FIELDS})
      where coalesce(e.total, 0) is distinct from a.total`);
    assert.deepEqual(result.rows, [], 'per-profile counts must match the complete source grouping');
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
      const deadline = Date.now() + 3000;
      let blocked = false;
      while (Date.now() < deadline) {
        blocked = (await pool.query('select cardinality(pg_blocking_pids($1)) > 0 as blocked', [pid])).rows[0].blocked;
        if (blocked) break;
        await setTimeout(10);
      }
      assert.ok(blocked, 'competing writer must wait for the first transaction');
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

  test('upgrades from 061, backfills all five grouping dimensions and uses 32-byte SHA256 keys', async () => {
    await assertExact();
    assert.deepEqual(await sourceJobs(), sourceBeforeMigration, 'backfill and FK validation must not rewrite or row-lock source jobs');
    const rows = await profiles();
    assert.equal(rows.length, 6);
    assert.equal((await memberships()).length, 7);
    for (const row of (await pool.query(`select identity_hash, jsonb_build_array(${FIELDS})::text as identity from ai_job_report_profiles`)).rows) {
      assert.equal(row.identity_hash.length, 32);
      assert.deepEqual(row.identity_hash, createHash('sha256').update(row.identity).digest());
    }
    const triggers = (await pool.query(`select tgname, (tgtype::int & 1) = 0 as statement_level
      from pg_trigger where tgrelid = 'ai_jobs'::regclass and tgname like 'ai_job_reports_%'`)).rows;
    assert.deepEqual(triggers.map(row => row.tgname).sort(), ['ai_job_reports_insert', 'ai_job_reports_update']);
    assert.ok(triggers.every(row => row.statement_level));
    assert.deepEqual((await pool.query(`select convalidated, confupdtype, confdeltype from pg_constraint
      where contype='f' and conrelid='ai_job_report_rows'::regclass and confrelid='ai_jobs'::regclass`)).rows,
    [{ convalidated: true, confupdtype: 'c', confdeltype: 'c' }]);
    for (const name of DERIVED_OBJECTS) {
      assert.ok((await pool.query('select to_regclass($1) as name', [`${schema}.${name}`])).rows[0].name);
    }
  });

  describe('transactional maintenance', () => {
    beforeEach(async () => { await pool.query('truncate ai_jobs cascade'); });
    afterEach(async () => { await assertExact(); });

    test('rekeying an empty job moves its membership without leaving an orphan or changing totals', async () => {
      const oldId = (await pool.query(...insert([A]))).rows[0].id;
      const original = (await memberships())[0];
      const retained = await profiles();
      const newId = (await pool.query(`select nextval(pg_get_serial_sequence('ai_jobs','id')) as id`)).rows[0].id;
      await pool.query('update ai_jobs set id=$1 where id=$2', [newId, oldId]);
      assert.deepEqual(await memberships(), [{ ...original, job_id: newId }]);
      await assertExact();
      assert.deepEqual(await profiles(), retained);
      await pool.query('delete from ai_jobs where id=$1', [newId]);
      assert.deepEqual(await memberships(), []);
      assert.deepEqual(await profiles(), retained);
    });

    test('tracks batch insert, independent profile-field moves and deletion while retaining profiles', async () => {
      const ids = (await pool.query(...insert([A, A, B]))).rows.map(row => row.id as bigint);
      for (const group of groups.slice(1)) {
        await pool.query(...move(ids.slice(0, 2), group));
        await assertExact();
      }
      await pool.query('delete from ai_jobs where id = any($1::bigint[])', [ids.slice(0, 2)]);
      await assertExact();
      const retained = await profiles();
      await pool.query('delete from ai_jobs');
      assert.deepEqual(await memberships(), []);
      assert.deepEqual(await profiles(), retained);
    });

    test('skips irrelevant metadata, empty statements and net-zero moves; JSON object order is immaterial', async () => {
      await pool.query(...insert([A, B]));
      const original = await profiles();
      const originalRows = await memberships();
      await pool.query(`update ai_jobs set model='changed', error='retry', processed=1, phase='complete', cancel_requested=true`);
      await pool.query(`update ai_jobs set pipeline_versions='{"schema":"v1","prompt":"v1"}'::jsonb where status='queued'`);
      await pool.query('update ai_jobs set status=status where false');
      await pool.query('delete from ai_jobs where false');
      await pool.query(...insert([]));
      assert.deepEqual(await memberships(), originalRows);
      await pool.query(`update ai_jobs set (job_type,status,prompt_version,rule_version,pipeline_versions) =
        (select r.job_type,r.status,r.prompt_version,r.rule_version,r.pipeline_versions
         from jsonb_to_record(case when ai_jobs.status='queued' then $1::jsonb else $2::jsonb end)
         as r(job_type text,status text,prompt_version text,rule_version text,pipeline_versions jsonb))`,
      [JSON.stringify(B), JSON.stringify(A)]);
      assert.deepEqual(await profiles(), original);
      assert.notDeepEqual(await memberships(), originalRows);
    });

    test('mixed upserts count inserted and updated rows exactly once', async () => {
      const id = (await pool.query(...insert([A]))).rows[0].id;
      await pool.query(`insert into ai_jobs(id,job_type,status,prompt_version,rule_version,pipeline_versions,model,total)
        values ($1,'incremental','failed','prompt-a','rule-a',$2::jsonb,'upsert',0),
          (nextval(pg_get_serial_sequence('ai_jobs','id')),'incremental','queued','prompt-a','rule-a',$2::jsonb,'upsert',0)
        on conflict(id) do update set status=excluded.status`, [id, JSON.stringify(A.pipeline_versions)]);
      await assertExact();
      assert.equal((await memberships()).length, 2);
    });

    test('source mutations, new profiles and memberships roll back together and remain invisible until commit', async () => {
      const ids = (await pool.query(...insert([A, A]))).rows.map(row => row.id as bigint);
      const original = await memberships();
      const originalProfiles = await profiles();
      const fresh = { ...B, prompt_version: randomUUID() };
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(...insert([fresh, fresh]));
        await client.query(...move(ids.slice(0, 1), fresh));
        await client.query('delete from ai_jobs where id=$1', [ids[1]]);
        await assertExact(client);
        assert.deepEqual(await memberships(), original);
        assert.deepEqual(await profiles(), originalProfiles);
      } finally { await client.query('rollback'); client.release(); }
      assert.deepEqual(await memberships(), original);
      assert.deepEqual(await profiles(), originalProfiles);
    });

    test('concurrent first arrivals into a new profile preserve commit and rollback semantics', async () => {
      for (const commit of [true, false]) {
        await pool.query('truncate ai_jobs cascade');
        const fresh = { ...A, prompt_version: randomUUID() };
        await contend(insert([fresh, fresh]), insert([fresh, fresh, fresh]), commit);
        assert.equal((await memberships()).length, commit ? 5 : 3);
      }
    });

    test('different jobs entering an existing profile both finish before the first transaction commits', async () => {
      for (const commit of [true, false]) {
        await pool.query('truncate ai_jobs cascade');
        const ids = (await pool.query(...insert([A, A, B]))).rows.map(row => row.id as bigint);
        await pool.query('delete from ai_jobs where id=$1', [ids[2]]);
        const originalProfiles = await profiles();
        const targetHash = originalProfiles.find(row => row.prompt_version === B.prompt_version
          && row.job_type === B.job_type && row.status === B.status)!.identity_hash;
        const a = await pool.connect();
        const b = await pool.connect();
        try {
          await a.query('begin');
          await b.query('begin');
          await b.query("set local lock_timeout='1500ms'");
          await a.query(...move(ids.slice(0, 1), B));
          await b.query(...move(ids.slice(1, 2), B));
          await b.query('commit');
          const visible = await memberships();
          assert.notDeepEqual(visible[0].identity_hash, targetHash, 'first transaction is still uncommitted');
          assert.deepEqual(visible[1].identity_hash, targetHash, 'second transaction committed independently');
          await assertExact();
          await a.query(commit ? 'commit' : 'rollback');
        } finally {
          await a.query('rollback'); await b.query('rollback');
          a.release(); b.release();
        }
        await assertExact();
        assert.deepEqual(await profiles(), originalProfiles, 'existing profile rows must not be rewritten');
        assert.equal((await memberships()).filter(row => row.identity_hash.equals(targetHash)).length, commit ? 2 : 1);
      }
    });

    test('TRUNCATE clears only memberships, retains profiles and rolls back with its source transaction', async () => {
      for (const commit of [true, false]) {
        await pool.query('truncate ai_jobs cascade');
        await pool.query(...insert([A, A]));
        const retained = await profiles();
        await contend(['truncate ai_jobs cascade', []], insert([A]), commit);
        assert.equal((await memberships()).length, commit ? 1 : 3);
        assert.deepEqual(await profiles(), retained);
      }
      const retained = await profiles();
      await pool.query('truncate ai_jobs cascade');
      assert.deepEqual(await memberships(), []);
      assert.deepEqual(await profiles(), retained);
    });

    test('a hash/full-identity mismatch rejects insert and update without partial source or membership changes', async () => {
      const ids = (await pool.query(...insert([A, B]))).rows.map(row => row.id as bigint);
      const hash = (await memberships())[1].identity_hash;
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(`update ai_job_report_profiles set rule_version='simulated-collision' where identity_hash=$1`, [hash]);
        const original = await memberships(client);
        const originalProfiles = await profiles(client);
        const source = (await client.query('select * from ai_jobs order by id')).rows;
        for (const statement of [insert([A, B]), move(ids.slice(0, 1), B)]) {
          await client.query('savepoint collision');
          await assert.rejects(client.query(...statement), /Task report identity collision/u);
          await client.query('rollback to savepoint collision');
          assert.deepEqual((await client.query('select * from ai_jobs order by id')).rows, source);
          assert.deepEqual(await memberships(client), original);
          assert.deepEqual(await profiles(client), originalProfiles);
          await client.query('release savepoint collision');
        }
      } finally { await client.query('rollback'); client.release(); }
    });

    test('separately inserted JSONB-equal numeric representations retain an exact summed count', async () => {
      const statement = insert([{ ...A, pipeline_versions: { n: 1 } }]);
      await pool.query(...statement);
      await pool.query(statement[0], [String(statement[1][0]).replace('"n":1', '"n":1.0')]);
      await assertExact();
      assert.equal((await memberships()).length, 2);
    });

    for (const backfill of [false, true]) {
      test(`${backfill ? 'backfill' : 'batch insert'} preserves numeric text buckets for separate deletions`, async () => {
        if (backfill) await migrate(PREVIOUS);
        const ids = (await pool.query(`insert into ai_jobs (${FIELDS}, model, total)
          select 'incremental', 'queued', 'numeric', 'rule', versions, 'count-test', 0
          from jsonb_array_elements('[{"n":1},{"n":1.0}]'::jsonb) as versions returning id`)).rows.map(row => row.id);
        if (backfill) await migrate(CURRENT);
        await assertExact();
        const rows = await memberships();
        assert.equal(rows.length, 2);
        assert.notDeepEqual(rows[0].identity_hash, rows[1].identity_hash);
        for (const [index, id] of ids.entries()) {
          await pool.query('delete from ai_jobs where id=$1', [id]);
          await assertExact();
          assert.equal((await memberships()).length, 1 - index);
        }
      });
    }

    test('an equal JSONB numeric rewrite does not break a later source deletion', async () => {
      await pool.query(...insert([{ ...A, pipeline_versions: { n: 1 } }]));
      await pool.query(`update ai_jobs set pipeline_versions='{"n":1.0}'::jsonb`);
      await assertExact();
      await pool.query('delete from ai_jobs');
      assert.deepEqual(await memberships(), []);
    });

    test('down/up removes derived objects and rebuilds without rewriting source jobs', async () => {
      await pool.query(...insert([A, A, B]));
      const original = await memberships();
      const jobs = await sourceJobs();
      await migrate(PREVIOUS);
      assert.deepEqual(await sourceJobs(), jobs);
      for (const name of DERIVED_OBJECTS) {
        assert.equal((await pool.query('select to_regclass($1) as name', [`${schema}.${name}`])).rows[0].name, null);
      }
      assert.equal((await pool.query(`select count(*)::int as n from pg_trigger
        where tgrelid='ai_jobs'::regclass and tgname like 'ai_job_reports_%'`)).rows[0].n, 0);
      await migrate(CURRENT);
      for (const name of DERIVED_OBJECTS) {
        assert.ok((await pool.query('select to_regclass($1) as name', [`${schema}.${name}`])).rows[0].name);
      }
      assert.deepEqual(await sourceJobs(), jobs);
      assert.deepEqual(await memberships(), original);
    });
  });
});

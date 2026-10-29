import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { DatabaseModule } from '../src/database/database.module.js';
import {
  createPostgresPool,
  DATABASE,
  PG_POOL,
} from '../src/database/database.providers.js';
import { jsonb, type DatabaseSchema } from '../src/database/types.js';
import { migrateToLatest } from '../scripts/migrate.js';
import { MetricsRegistry } from '../src/observability/metrics.js';

const expectedTables = [
  'ai_batch_identity_mappings',
  'ai_job_batches',
  'ai_job_input_members',
  'ai_job_inputs',
  'ai_jobs',
  'ai_publication_units',
  'ai_standardization_executions',
  'ai_standardization_results',
  'fetch_runs',
  'offers',
  'product_tags',
  'products',
  'shops',
  'standard_product_members',
  'standard_products',
];

describe('PostgreSQL database layer', () => {
  let container: StartedPostgreSqlContainer;
  let migrationPool: Pool;
  let migrationDatabase: Kysely<DatabaseSchema>;
  let testingModule: TestingModule;
  let schemaName: string;
  let adminPool: Pool;

  before(async () => {
    if (process.env.TEST_DATABASE_URL) {
      process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    } else {
      container = await new PostgreSqlContainer('postgres:16-alpine').start();
      process.env.DATABASE_URL = container.getConnectionUri();
    }
    schemaName = `task2_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    adminPool = new Pool({ connectionString: process.env.DATABASE_URL });
    await adminPool.query(`create schema "${schemaName}"`);
    process.env.PG_SCHEMA = schemaName;
    process.env.PG_POOL_MAX = '3';
    process.env.API_CONNECTIONS = '2';
    process.env.CRAWLER_CONNECTIONS = '1';
    process.env.AI_CONNECTIONS = '';
    process.env.STANDARDIZATION_CONNECTIONS = '';
    process.env.PG_IDLE_TIMEOUT_MS = '5000';
    process.env.PG_CONNECTION_TIMEOUT_MS = '5000';
    process.env.PG_STATEMENT_TIMEOUT_MS = '10000';

    migrationPool = createPostgresPool();
    migrationDatabase = new Kysely<DatabaseSchema>({
      dialect: new PostgresDialect({ pool: migrationPool }),
    });
    await migrateToLatest(migrationDatabase);

    testingModule = await Test.createTestingModule({ imports: [DatabaseModule] }).compile();
  });

  after(async () => {
    await testingModule?.close();
    await migrationDatabase?.destroy();
    await adminPool?.query(`drop schema if exists "${schemaName}" cascade`);
    await adminPool?.end();
    await container?.stop();
  });

  test('a clean migration creates every core table', async () => {
    const result = await sql<{ table_name: string }>`
      select table_name
      from information_schema.tables
      where table_schema = ${sql.val(schemaName)}
        and table_name = any(${sql.val(expectedTables)})
      order by table_name
    `.execute(migrationDatabase);

    assert.deepEqual(
      result.rows.map((row) => row.table_name),
      expectedTables,
    );
  });

  test('the schema enforces its foreign keys and business uniqueness rules', async () => {
    const foreignKeys = await sql<{ table_name: string; foreign_table_name: string }>`
      select tc.table_name, ccu.table_name as foreign_table_name
      from information_schema.table_constraints tc
      join information_schema.constraint_column_usage ccu
        on ccu.constraint_catalog = tc.constraint_catalog
       and ccu.constraint_schema = tc.constraint_schema
       and ccu.constraint_name = tc.constraint_name
      where tc.constraint_schema = ${sql.val(schemaName)}
        and tc.constraint_type = 'FOREIGN KEY'
    `.execute(migrationDatabase);
    const relations = new Set(
      foreignKeys.rows.map((row) => `${row.table_name}->${row.foreign_table_name}`),
    );

    for (const relation of [
      'products->shops',
      'standard_product_members->standard_products',
      'standard_product_members->products',
      'product_tags->products',
      'offers->products',
      'fetch_runs->shops',
      'ai_job_inputs->ai_jobs',
      'ai_job_batches->ai_jobs',
      'ai_publication_units->ai_job_batches',
      'ai_batch_identity_mappings->ai_job_batches',
      'ai_batch_identity_mappings->standard_products',
      'ai_standardization_executions->products',
      'ai_standardization_results->ai_jobs',
      'ai_standardization_results->products',
      'ai_standardization_results->ai_job_batches',
      'ai_standardization_results->standard_products',
    ]) {
      assert.ok(relations.has(relation), `missing foreign key ${relation}`);
    }

    const uniqueConstraints = await sql<{ table_name: string; columns: string[] }>`
      select tc.table_name, array_agg(kcu.column_name::text order by kcu.ordinal_position) as columns
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on kcu.constraint_catalog = tc.constraint_catalog
       and kcu.constraint_schema = tc.constraint_schema
       and kcu.constraint_name = tc.constraint_name
      where tc.constraint_schema = ${sql.val(schemaName)}
        and tc.constraint_type in ('PRIMARY KEY', 'UNIQUE')
      group by tc.table_name, tc.constraint_name
    `.execute(migrationDatabase);
    const uniqueKeys = new Set(
      uniqueConstraints.rows.map((row) => `${row.table_name}(${row.columns.join(',')})`),
    );

    for (const key of [
      'shops(url)',
      'products(shop_id,external_id)',
      'standard_product_members(product_id)',
      'product_tags(product_id,name,value)',
      'ai_job_inputs(job_id,input_id)',
      'ai_job_batches(job_id,batch_index)',
      'ai_publication_units(batch_id,unit_index)',
      'ai_batch_identity_mappings(batch_id,identity_ref)',
      'ai_standardization_executions(product_id,content_version,fingerprint)',
      'ai_standardization_results(job_id,product_id)',
    ]) {
      assert.ok(uniqueKeys.has(key), `missing unique key ${key}`);
    }
    const reviewIndexes = await sql<{ indexname: string; indexdef: string }>`select indexname,indexdef from pg_indexes where schemaname=${sql.val(schemaName)} and tablename='ai_job_inputs'`.execute(migrationDatabase);
    assert.equal(reviewIndexes.rows.some(row => row.indexname === 'ai_job_inputs_content_without_review'), false);
    assert.equal(reviewIndexes.rows.some(row => row.indexname === 'ai_job_inputs_content_with_review'), false);
  });

  test('the schema uses PostgreSQL-native time, JSON, boolean, partial, covering, and trigram indexes', async () => {
    const columns = await sql<{ table_name: string; column_name: string; data_type: string }>`
      select table_name, column_name, data_type
      from information_schema.columns
      where table_schema = ${sql.val(schemaName)}
    `.execute(migrationDatabase);
    const byColumn = new Map(
      columns.rows.map((row) => [`${row.table_name}.${row.column_name}`, row.data_type]),
    );

    for (const column of [
      'shops.last_fetch_at',
      'shops.deleted_at',
      'products.updated_at',
      'products.deleted_at',
      'standard_product_members.created_at',
      'offers.captured_at',
      'fetch_runs.started_at',
      'fetch_runs.finished_at',
      'ai_jobs.created_at',
      'ai_jobs.finished_at',
      'ai_job_batches.started_at',
      'ai_job_batches.finished_at',
      'ai_publication_units.created_at',
      'ai_publication_units.completed_at',
      'ai_batch_identity_mappings.created_at',
      'ai_standardization_executions.created_at',
      'ai_standardization_results.created_at',
    ]) {
      assert.equal(byColumn.get(column), 'timestamp with time zone', `${column} must be timestamptz`);
    }
    assert.equal(byColumn.get('products.source_data'), 'jsonb');
    assert.equal(byColumn.get('ai_job_inputs.payload'), 'jsonb');
    assert.equal(byColumn.get('ai_publication_units.product_ids'), 'jsonb');
    assert.equal(byColumn.get('ai_batch_identity_mappings.identity_snapshot'), 'jsonb');
    assert.equal(byColumn.get('ai_standardization_results.decision'), 'jsonb');
    assert.equal(byColumn.get('shops.enabled'), 'boolean');
    assert.equal(byColumn.get('products.standardization_locked'), 'boolean');
    assert.equal(byColumn.get('offers.stock_available'), 'boolean');

    const indexes = await sql<{ indexname: string; indexdef: string }>`
      select indexname, indexdef
      from pg_indexes
      where schemaname = ${sql.val(schemaName)}
    `.execute(migrationDatabase);
    const byName = new Map(indexes.rows.map((row) => [row.indexname, row.indexdef]));

    for (const name of [
      'offers_latest',
      'products_active_standardized',
      'ai_batch_claim',
      'ai_job_batches_window_claim',
      'ai_publication_units_claim',
      'ai_standardization_executions_job',
      'ai_standardization_results_status',
      'product_tags_product',
      'products_name_trgm',
      'standard_products_name_trgm',
    ]) {
      assert.ok(byName.has(name), `missing index ${name}`);
    }
    assert.match(byName.get('products_active_standardized')!, /WHERE .*deleted_at IS NULL.*standardization_locked = false/i);
    assert.match(byName.get('ai_publication_units_claim')!, /WHERE .*status.*queued.*running/i);
    assert.match(byName.get('offers_latest')!, /INCLUDE \(price, currency, is_stale, stock_available\)/i);
    assert.match(byName.get('products_name_trgm')!, /USING gin .*gin_trgm_ops/i);

    const extension = await sql<{ installed: boolean }>`
      select exists(select 1 from pg_extension where extname = 'pg_trgm') as installed
    `.execute(migrationDatabase);
    assert.equal(extension.rows[0]?.installed, true);
  });

  test('DatabaseModule exposes a bounded pool with all timeout controls', () => {
    const pool = testingModule.get<Pool>(PG_POOL);
    assert.equal(pool.options.max, 3);
    assert.equal(pool.options.idleTimeoutMillis, 5000);
    assert.equal(pool.options.connectionTimeoutMillis, 5000);
    assert.equal(pool.options.statement_timeout, 10000);
  });

  test('database rolls back every write when a transaction callback throws', async () => {
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);

    await assert.rejects(
      database.transaction().execute(async (transaction) => {
        await transaction
          .insertInto('shops')
          .values({ platform: 'rollback-test', url: 'https://rollback.invalid', name: 'rollback' })
          .execute();
        throw new Error('force rollback');
      }),
      /force rollback/,
    );

    const row = await database
      .selectFrom('shops')
      .select(({ fn }) => fn.countAll<bigint>().as('count'))
      .where('url', '=', 'https://rollback.invalid')
      .executeTakeFirstOrThrow();
    assert.equal(row.count, 0n);
  });

  test('Pool parses int8 values as bigint beyond Number.MAX_SAFE_INTEGER', async () => {
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    const hugeId = 9007199254740993n;
    await sql`insert into shops (id, platform, url, name) values (${hugeId}, 'int8', 'https://int8.invalid', 'int8')`.execute(database);
    const row = await database.selectFrom('shops').select('id').where('url', '=', 'https://int8.invalid').executeTakeFirstOrThrow();
    assert.equal(row.id, hugeId);
    assert.equal(typeof row.id, 'bigint');
  });

  test('JSONB helper round-trips objects, arrays, strings, and JSON null', async () => {
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    const values = [
      { name: 'object', source_data: jsonb({ vendor: 'acme', score: 1 }) },
      { name: 'array', source_data: jsonb([1, 'two', false]) },
      { name: 'string', source_data: jsonb('plain text') },
      { name: 'null', source_data: jsonb(null) },
    ] as const;
    const shop = await database.insertInto('shops').values({ platform: 'json', url: 'https://json.invalid', name: 'json' }).returning('id').executeTakeFirstOrThrow();
    await database.insertInto('products').values(values.map((value, index) => ({
      shop_id: shop.id,
      external_id: String(index),
      name: value.name,
      normalized_key: value.name,
      url: `https://json.invalid/${index}`,
      source_data: value.source_data,
    }))).execute();
    const rows = await database.selectFrom('products').select(['name', 'source_data']).where('shop_id', '=', shop.id).orderBy('id').execute();
    assert.deepEqual(rows.map((row) => row.source_data), [
      { vendor: 'acme', score: 1 },
      [1, 'two', false],
      'plain text',
      null,
    ]);
  });

  test('status columns reject values outside their state machines', async () => {
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    const shop = await database.insertInto('shops').values({ platform: 'status', url: 'https://status.invalid', name: 'status' }).returning('id').executeTakeFirstOrThrow();
    const product = await database.insertInto('products').values({ shop_id: shop.id, external_id: 'status', name: 'status', normalized_key: 'status', url: 'https://status.invalid/p' }).returning('id').executeTakeFirstOrThrow();
    const job = await database.insertInto('ai_jobs').values({ status: 'queued', total: 1n, model: 'test' }).returning('id').executeTakeFirstOrThrow();
    await database.insertInto('ai_job_inputs').values({ job_id: job.id, input_id: product.id, fingerprint: 'f', payload: jsonb({}), status: 'queued' }).execute();
    await assert.rejects(database.insertInto('fetch_runs').values({ shop_id: shop.id, started_at: new Date(), status: 'bogus' as never }).execute());
    await assert.rejects(database.updateTable('ai_jobs').set({ status: 'bogus' as never }).where('id', '=', job.id).execute());
    await assert.rejects(database.insertInto('ai_job_inputs').values({ job_id: job.id, input_id: 1n, fingerprint: 'f', payload: jsonb({}) , status: 'bogus' as never }).execute());
    await assert.rejects(database.insertInto('ai_standardization_results').values({ job_id: job.id, product_id: product.id, input_id: product.id, content_version: 0n, fingerprint: 'f', status: 'bogus' as never, reason_code: 'invalid', reason: 'r', decision: jsonb({}) }).execute());
  });

  test('Pool idle errors are handled and logged without connection details', async () => {
    const calls: unknown[][] = [];
    const pool = createPostgresPool(process.env, {
      error: (...args: unknown[]) => calls.push(args),
    });
    assert.doesNotThrow(() => pool.emit('error', Object.assign(new Error('server went away'), { code: '57P01', connectionString: process.env.DATABASE_URL }), undefined));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.[1], { code: '57P01', message: 'server went away' });
    assert.equal(JSON.stringify(calls[0]).includes(process.env.DATABASE_URL ?? ''), false);
    await pool.end();
  });

  test('Kysely queries update the shared database timing metrics', async () => {
    const metrics = testingModule.get(MetricsRegistry);
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    const before = metrics.snapshot().database.queries;

    await sql`select 1`.execute(database);

    assert.equal(metrics.snapshot().database.queries, before + 1);
  });
});

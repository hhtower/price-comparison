import { strict as assert } from 'node:assert';
import { after, before, describe, test } from 'node:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { createPostgresPool } from '../src/database/database.providers.js';
import { migrateToLatest } from '../scripts/migrate.js';
import type { DatabaseSchema } from '../src/database/types.js';
import { Pool } from 'pg';
import { up as upgradeSettlementQuantity, down as downgradeSettlementQuantity } from '../src/database/migrations/008_settlement_quantity_20261004.js';
import { up as upgradeResponseDiagnostic, down as downgradeResponseDiagnostic } from '../src/database/migrations/015_ai_response_diagnostic_20261023.js';

describe('AI standardization regroup migration', () => {
  let database: Kysely<DatabaseSchema>;
  let admin: Pool;
  const schema = `merge_migration_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  test('response diagnostics migrate forward and back with bounded object-only storage', async () => {
    await database.transaction().execute(async tx => {
      await sql`create temporary table ai_job_batches (id integer primary key) on commit drop`.execute(tx);
      await sql`insert into ai_job_batches values (1)`.execute(tx);
      await upgradeResponseDiagnostic(tx);
      await sql`update ai_job_batches set response_diagnostic = '{"phase":"schema"}'::jsonb`.execute(tx);
      for (const value of ['[]', JSON.stringify({ code: 'x'.repeat(17000) })]) {
        await sql`savepoint diagnostic_bound`.execute(tx);
        await assert.rejects(sql`update ai_job_batches set response_diagnostic = ${value}::jsonb`.execute(tx));
        await sql`rollback to savepoint diagnostic_bound`.execute(tx);
      }
      await downgradeResponseDiagnostic(tx);
      assert.deepEqual((await sql`select * from ai_job_batches`.execute(tx)).rows, [{ id: 1 }]);
    });
  });
  before(async () => {
    if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
    admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`create schema "${schema}"`);
    process.env.PG_SCHEMA = schema;
    const pool = createPostgresPool({ ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, PG_SCHEMA: schema });
    database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    await migrateToLatest(database);
  });
  after(async () => { await database?.destroy(); await admin?.query(`drop schema if exists "${schema}" cascade`); await admin?.end(); delete process.env.PG_SCHEMA; });

  test('single-unit metadata requires schema downgrade before legacy writers resume', async () => {
    await database.transaction().execute(async transaction => {
      // Shadow the real table to exercise upgrade/downgrade without altering the suite's schema.
      await sql`create temporary table offers (
        id integer primary key, settlement_price numeric(14,2),
        settlement_verified_at timestamptz, settlement_payment_method text
      ) on commit drop`.execute(transaction);
      await sql`insert into offers values (1, 10.30, now(), 'Alipay')`.execute(transaction);
      const migrationDb = transaction as unknown as Kysely<unknown>;
      await upgradeSettlementQuantity(migrationDb);
      await sql`update offers set settlement_price = 11.30 where id = 1`.execute(transaction);
      await sql`update offers set settlement_quantity = 1, settlement_total_amount = 11.30 where id = 1`.execute(transaction);
      for (const legacyWrite of [
        sql`update offers set settlement_price = 12.30 where id = 1`,
        sql`update offers set settlement_price = null, settlement_verified_at = null, settlement_payment_method = null where id = 1`,
      ]) {
        await sql`savepoint legacy_write`.execute(transaction);
        await assert.rejects(legacyWrite.execute(transaction), /offers_settlement_quantity_check/);
        await sql`rollback to savepoint legacy_write`.execute(transaction);
        await sql`release savepoint legacy_write`.execute(transaction);
      }
      await downgradeSettlementQuantity(migrationDb);
      await sql`update offers set settlement_price = 12.30 where id = 1`.execute(transaction);
      const result = await sql<{ settlement_price: string }>`select settlement_price from offers where id = 1`.execute(transaction);
      assert.equal(result.rows[0]?.settlement_price, '12.30');
      await sql`update offers set settlement_price = null, settlement_verified_at = null, settlement_payment_method = null where id = 1`.execute(transaction);
    });
  });

  test('creates durable request, decision, publication and version execution contracts', async () => {
    const tables = await sql<{ table_name: string }>`
      select table_name from information_schema.tables
      where table_schema = current_schema()
        and table_name in ('ai_publication_units', 'ai_batch_identity_mappings', 'ai_standardization_executions', 'ai_standardization_results')
    `.execute(database);
    assert.deepEqual(
      new Set(tables.rows.map((row) => row.table_name)),
      new Set(['ai_publication_units', 'ai_batch_identity_mappings', 'ai_standardization_executions', 'ai_standardization_results']),
    );

    const columns = await sql<{ table_name: string; column_name: string; is_nullable: string; column_default: string | null }>`
      select table_name, column_name, is_nullable, column_default
      from information_schema.columns
      where table_schema = current_schema() and (
        (table_name = 'ai_jobs' and column_name in ('classified', 'unclassified', 'rule_version', 'request_window_size', 'configuration_blocked'))
        or (table_name = 'ai_job_inputs' and column_name in ('round', 'content_version', 'missing_reprocess_count', 'reason_code'))
        or (table_name = 'ai_job_input_members' and column_name in ('content_version', 'fingerprint', 'payload', 'status', 'missing_reprocess_count', 'reason_code', 'output'))
        or (table_name = 'ai_job_batches' and column_name in ('round', 'step', 'reference_snapshot', 'reference_version', 'request_budget_limit', 'request_budget_used', 'confirmed_requests', 'unknown_requests', 'validated_decision', 'decision_hash', 'publication_plan', 'publication_cursor', 'error_source'))
      )
    `.execute(database);
    const names = new Set(columns.rows.map((row) => `${row.table_name}.${row.column_name}`));
    for (const name of [
      'ai_jobs.classified', 'ai_jobs.unclassified', 'ai_jobs.rule_version', 'ai_jobs.request_window_size', 'ai_jobs.configuration_blocked',
      'ai_job_inputs.round', 'ai_job_inputs.content_version', 'ai_job_inputs.missing_reprocess_count', 'ai_job_inputs.reason_code',
      'ai_job_input_members.content_version', 'ai_job_input_members.fingerprint', 'ai_job_input_members.payload', 'ai_job_input_members.status',
      'ai_job_input_members.missing_reprocess_count', 'ai_job_input_members.reason_code', 'ai_job_input_members.output',
      'ai_job_batches.round', 'ai_job_batches.step', 'ai_job_batches.reference_snapshot', 'ai_job_batches.reference_version',
      'ai_job_batches.request_budget_limit', 'ai_job_batches.request_budget_used', 'ai_job_batches.confirmed_requests',
      'ai_job_batches.unknown_requests', 'ai_job_batches.validated_decision', 'ai_job_batches.decision_hash',
      'ai_job_batches.publication_plan', 'ai_job_batches.publication_cursor', 'ai_job_batches.error_source',
    ]) assert.ok(names.has(name), `missing column ${name}`);

    const constraints = await sql<{ conname: string }>`
      select conname from pg_constraint where conname in (
        'ai_job_inputs_missing_reprocess_count_check',
        'ai_job_input_members_missing_reprocess_count_check',
        'ai_job_batches_request_budget_check',
        'ai_standardization_executions_product_version_fingerprint_key',
        'ai_publication_units_batch_id_unit_index_key'
      )
    `.execute(database);
    const constraintNames = new Set(constraints.rows.map((row) => row.conname));
    for (const name of [
      'ai_job_inputs_missing_reprocess_count_check',
      'ai_job_input_members_missing_reprocess_count_check',
      'ai_job_batches_request_budget_check',
      'ai_standardization_executions_product_version_fingerprint_key',
      'ai_publication_units_batch_id_unit_index_key',
    ]) assert.ok(constraintNames.has(name), `missing constraint ${name}`);
  });

  test('removes the superseded cache, audit, merge and review schema', async () => {
    const result = await sql<{ table_name: string }>`select table_name from information_schema.tables where table_schema = current_schema() and table_name in ('ai_results','ai_extraction_cache','ai_merge_runs','ai_merge_tasks','ai_merge_candidates','ai_merge_edges','ai_merge_groups','ai_merge_group_members','ai_result_reviews','ai_bulk_review_requests','ai_stage_tasks')`.execute(database);
    assert.deepEqual(result.rows, []);
    const columns = await sql<{ column_name: string }>`select column_name from information_schema.columns where table_schema=current_schema() and table_name='ai_jobs' and column_name in ('merge_run_id','merge_version','merge_finished_at')`.execute(database);
    assert.deepEqual(columns.rows, []);
  });

  test('creates performance foundation tables, columns, constraints and indexes', async () => {
    const tables = await sql<{ table_name: string }>`
      select table_name
      from information_schema.tables
      where table_schema = current_schema()
        and table_name in ('product_change_events', 'standardization_outbox', 'ai_job_progress', 'product_blocking_keys', 'standard_product_aliases', 'standardization_catalog_versions', 'catalog_index_changes')
    `.execute(database);
    assert.deepEqual(
      new Set(tables.rows.map((row) => row.table_name)),
      new Set(['product_change_events', 'standardization_outbox', 'ai_job_progress', 'standardization_catalog_versions', 'catalog_index_changes']),
    );

    const indexes = await sql<{ indexname: string }>`
      select indexname from pg_indexes
      where schemaname = current_schema()
        and indexname in ('standardization_outbox_claim', 'standardization_outbox_active_product_fingerprint', 'product_blocking_keys_lookup', 'ai_job_progress_job', 'catalog_index_changes_version_order')
    `.execute(database);
    for (const name of ['standardization_outbox_claim', 'standardization_outbox_active_product_fingerprint', 'ai_job_progress_job', 'catalog_index_changes_version_order']) {
      assert.ok(indexes.rows.some((row) => row.indexname === name), `missing index ${name}`);
    }
    assert.ok(!indexes.rows.some((row) => row.indexname === 'product_blocking_keys_lookup'));

    const catalogConstraints = await sql<{ conname: string }>`
      select conname from pg_constraint where conname in (
        'catalog_index_changes_version_standard_product_key',
        'catalog_index_changes_document_check'
      )
    `.execute(database);
    assert.deepEqual(
      new Set(catalogConstraints.rows.map(row => row.conname)),
      new Set(['catalog_index_changes_version_standard_product_key', 'catalog_index_changes_document_check']),
    );

    const columns = await sql<{
      table_name: string;
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: string;
      column_default: string | null;
    }>`
      select table_name, column_name, data_type, udt_name, is_nullable, column_default
      from information_schema.columns
      where table_schema = current_schema()
        and (
          (table_name = 'shops' and column_name in ('last_success_at', 'next_fetch_at', 'fetch_backoff_level', 'scheduler_lease_until'))
          or (table_name = 'products' and column_name in ('content_fingerprint', 'content_version', 'content_changed_at'))
          or (table_name = 'ai_jobs' and column_name in ('job_type', 'trigger_event_id', 'priority', 'input_bytes', 'estimated_tokens'))
          or (table_name = 'ai_job_inputs' and column_name in ('input_bytes', 'estimated_tokens', 'available_at'))
          or (table_name = 'ai_job_batches' and column_name in ('input_bytes', 'estimated_tokens', 'queued_at', 'first_content_at', 'response_completed_at', 'retry_class'))
        )
    `.execute(database);
    const byColumn = new Map(columns.rows.map((row) => [`${row.table_name}.${row.column_name}`, row]));
    const assertColumn = (table: string, column: string, dataType: string, required: boolean, defaultContains?: string) => {
      const row = byColumn.get(`${table}.${column}`);
      assert.ok(row, `missing column ${table}.${column}`);
      assert.equal(row?.data_type, dataType, `${table}.${column} type`);
      assert.equal(row?.is_nullable, required ? 'NO' : 'YES', `${table}.${column} nullability`);
      if (defaultContains) assert.match(row?.column_default ?? '', new RegExp(defaultContains, 'i'), `${table}.${column} default`);
    };

    assertColumn('shops', 'last_success_at', 'timestamp with time zone', false);
    assertColumn('shops', 'next_fetch_at', 'timestamp with time zone', true, 'now');
    assertColumn('shops', 'fetch_backoff_level', 'integer', true, '0');
    assertColumn('shops', 'scheduler_lease_until', 'timestamp with time zone', false);
    assertColumn('products', 'content_fingerprint', 'text', true);
    assertColumn('products', 'content_version', 'bigint', true, '0');
    assertColumn('products', 'content_changed_at', 'timestamp with time zone', true, 'now');
    assertColumn('ai_jobs', 'job_type', 'text', true, 'incremental');
    assertColumn('ai_jobs', 'trigger_event_id', 'bigint', false);
    assertColumn('ai_jobs', 'priority', 'integer', true, '50');
    assertColumn('ai_jobs', 'input_bytes', 'bigint', true, '0');
    assertColumn('ai_jobs', 'estimated_tokens', 'bigint', true, '0');
    assertColumn('ai_job_batches', 'input_bytes', 'bigint', true, '0');
    assertColumn('ai_job_batches', 'estimated_tokens', 'bigint', true, '0');
    assertColumn('ai_job_batches', 'queued_at', 'timestamp with time zone', true, 'now');
    assertColumn('ai_job_batches', 'first_content_at', 'timestamp with time zone', false);
    assertColumn('ai_job_batches', 'response_completed_at', 'timestamp with time zone', false);
    assertColumn('ai_job_batches', 'retry_class', 'text', false);
  });
});

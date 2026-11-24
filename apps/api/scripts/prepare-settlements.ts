import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { createPostgresPool } from '../src/database/database.providers.js';
import type { DatabaseSchema } from '../src/database/types.js';

export interface SettlementPreparationReport {
  applied: boolean;
  repaired: string[];
  invalidated: string[];
  historyDowngraded: number;
}
interface PreparationOptions {
  schema: string;
  apply?: boolean;
  beforeApply?: (backup: { report: SettlementPreparationReport; offers: string[]; history: string[] }) => void | Promise<void>;
}

/** Offline preparation only. Stop writers before running; never contact merchants or renew quote timestamps. */
export async function prepareSettlements(database: Kysely<DatabaseSchema>, options: PreparationOptions): Promise<SettlementPreparationReport> {
  assert.match(options.schema, /^[A-Za-z_][A-Za-z0-9_]*$/, 'A valid target schema is required');
  return database.transaction().execute(async tx => {
    const namespace = await sql<{ present: boolean }>`select exists (
      select 1 from pg_catalog.pg_namespace where nspname = ${options.schema}) as present`.execute(tx);
    assert.ok(namespace.rows[0]!.present, `Target schema does not exist: ${options.schema}`);
    await sql`select set_config('search_path', ${`"${options.schema}"`}, true)`.execute(tx);
    await sql`lock table products, offers, catalog_product_facts, standard_product_members,
      offer_price_history, fetch_runs, catalog_read_offers, catalog_read_offer_prices,
      catalog_cache_versions, kysely_migration in access exclusive mode nowait`.execute(tx);
    const migration = await sql<{ ready: boolean }>`select exists (
      select 1 from kysely_migration where name = '058_settlement_data_contract_20261124') as ready`.execute(tx);
    assert.ok(migration.rows[0]!.ready, 'Migrate to 058_settlement_data_contract_20261124 before preparing settlement data');
    const candidates = await sql<{ id: string; quantity: number | null; total: string | null; recoverable: boolean; backup: string }>`
      with missing as (
        select o.*, row_to_json(o)::text as backup,
          coalesce(o.settlement_quantity, case when h.quantity > 1 then h.quantity end) as quantity
        from offers o left join lateral (
          select h.quantity from offer_price_history h where h.product_id = o.product_id
            and h.verified_at = o.settlement_verified_at and h.price = o.settlement_price and h.currency = o.currency
          limit 1
        ) h on true
        where o.settlement_price is not null and (o.settlement_quantity is null or o.settlement_total_amount is null)
      ), totals as (
        select *, coalesce(settlement_total_amount,
          case when settlement_price >= 0 and settlement_price < 1000000000000
            then round(settlement_price * quantity, 2) end) as total from missing
      )
      select id::text, quantity, total::text, backup,
        coalesce(case when quantity between 1 and 2147483647 then
          total >= 0 and total < 1000000000000 and settlement_price * 1000000000000 =
            div(2 * total * 1000000000000 + quantity, 2::numeric * quantity)
          else false end, false) as recoverable
      from totals order by id`.execute(tx);
    // Old history also defaulted missing quantities to 1; that value cannot prove a single-unit purchase.
    const repaired = candidates.rows.filter(row => row.recoverable);
    const invalidated = candidates.rows.filter(row => !row.recoverable).map(row => row.id);
    const history = await sql<{ id: string; backup: string }>`select h.id::text, row_to_json(h)::text as backup
      from offer_price_history h where h.settlement_kind = 'verified' and exists (
        select 1 from offers o where o.id = any(${invalidated}::bigint[]) and o.product_id = h.product_id
          and o.settlement_verified_at = h.verified_at and o.settlement_price = h.price and o.currency = h.currency
      ) order by h.id`.execute(tx);
    const report: SettlementPreparationReport = {
      applied: false, repaired: repaired.map(row => row.id), invalidated, historyDowngraded: history.rows.length,
    };
    if (!options.apply || !candidates.rows.length) return report;
    // JSON documents remain strings so backups retain exact decimal amounts and timestamp microseconds.
    await options.beforeApply?.({ report, offers: candidates.rows.map(row => row.backup), history: history.rows.map(row => row.backup) });
    if (history.rows.length) await sql`update offer_price_history set settlement_kind = 'estimated'
      where id = any(${history.rows.map(row => row.id)}::bigint[])`.execute(tx);
    if (repaired.length) await sql`update offers o set settlement_quantity = v.quantity, settlement_total_amount = v.total::numeric
      from jsonb_to_recordset(${JSON.stringify(repaired.map(({ id, quantity, total }) => ({ id, quantity, total })))}::jsonb)
        as v(id text, quantity integer, total text) where o.id = v.id::bigint`.execute(tx);
    if (invalidated.length) await sql`update offers set settlement_price = null, settlement_verified_at = null,
      settlement_payment_method = null, settlement_quantity = null, settlement_total_amount = null,
      settlement_kind = 'estimated', settlement_refresh_at = clock_timestamp()
      where id = any(${invalidated}::bigint[])`.execute(tx);
    const remaining = await sql<{ count: number }>`select count(*)::int as count from offers
      where settlement_price is not null and (settlement_quantity is null or settlement_total_amount is null)`.execute(tx);
    assert.equal(remaining.rows[0]!.count, 0, 'Settlement preparation left incomplete quotes');
    await sql`update catalog_cache_versions set version = version + 1, updated_at = clock_timestamp() where id = 1`.execute(tx);
    report.applied = true;
    return report;
  });
}

async function main(): Promise<void> {
  assert.ok(process.argv.slice(2).every(arg => arg === '--apply'), 'Only --apply is supported; default is dry-run');
  await import('../src/config/env.js');
  const schema = process.env.PG_SCHEMA?.trim();
  assert.ok(schema, 'PG_SCHEMA is required for offline settlement preparation');
  const db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: createPostgresPool() }) });
  try {
    const report = await prepareSettlements(db, {
      schema,
      apply: process.argv.includes('--apply'),
      beforeApply: backup => {
        const directory = path.resolve('.local/settlement-preparation');
        mkdirSync(directory, { recursive: true });
        const filename = path.join(directory, `backup-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
        writeFileSync(filename, JSON.stringify(backup), { flag: 'wx', flush: true });
        console.info(`Backup: ${filename}`);
      },
    });
    console.info(JSON.stringify(report));
  } finally { await db.destroy(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}

import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`alter table offers add column settlement_refresh_at timestamptz`.execute(database);
  // The scheduler additionally checks the configured TTL; no deployment-time TTL is hard-coded.
  await sql`update offers set settlement_refresh_at = settlement_verified_at
    where settlement_price is not null and not is_stale and stock_available`.execute(database);
  await sql`create index offers_settlement_due on offers (settlement_refresh_at, product_id)
    where settlement_refresh_at is not null and not is_stale and stock_available`.execute(database);
  await sql`create index fetch_runs_active_shop on fetch_runs (shop_id, task_type, status)
    where status in ('queued', 'running')`.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`drop index fetch_runs_active_shop`.execute(database);
  await sql`drop index offers_settlement_due`.execute(database);
  await sql`alter table offers drop column settlement_refresh_at`.execute(database);
}

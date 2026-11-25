import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  // Keep the daily membership predicate distinct from the product/date index's leading key.
  await sql`create index offer_price_history_verified_daily on offer_price_history
    (standard_product_id, currency, ((verified_at at time zone 'Asia/Shanghai')::date),
      price, verified_at desc, (product_id + 0), id desc) include (product_id)
    where settlement_kind = 'verified'`.execute(database);
  await sql`analyze offer_price_history`.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`drop index offer_price_history_verified_daily`.execute(database);
}

import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  if (!database.isTransaction) return database.transaction().execute(up);
  // 036 can rebuild the price table, dropping 029's triggers but retaining its functions.
  for (const operation of ['insert', 'update', 'delete'] as const) {
    const name = `catalog_summary_changes_${operation}`;
    const transition = sql.raw(`${operation !== 'insert' ? 'old table as old_rows' : ''}
      ${operation !== 'delete' ? 'new table as new_rows' : ''}`);
    await sql`drop trigger if exists ${sql.id(name)} on catalog_read_offer_prices`.execute(database);
    await sql`create trigger ${sql.id(name)} after ${sql.raw(operation)} on catalog_read_offer_prices
      referencing ${transition} for each statement execute function ${sql.id(name)}()`.execute(database);
  }
  await sql`drop trigger if exists catalog_projection_truncated on catalog_read_offer_prices`.execute(database);
  await sql`create trigger catalog_projection_truncated before truncate on catalog_read_offer_prices
    for each statement execute function catalog_projection_truncated()`.execute(database);
  // Include abandoned standards so the worker also removes summaries with no remaining offers.
  await sql`insert into catalog_projection_changes (standard_product_id)
    select affected.standard_product_id from (
      select standard_product_id from catalog_read_shop_totals
      union select standard_product_id from catalog_read_offer_prices
    ) affected where not exists (
      select 1 from catalog_projection_changes pending
      where pending.standard_product_id = affected.standard_product_id
    )`.execute(database);
  await sql`update catalog_cache_versions set version = version + 1, updated_at = now() where id = 1`.execute(database);
}

export async function down(): Promise<void> {
  // This repairs 029's protection; rolling back 042 must not remove it again.
}

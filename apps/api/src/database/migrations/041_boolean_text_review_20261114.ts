import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  if (!database.isTransaction) return database.transaction().execute(up);
  // Recompute scores with the active review format without rewriting historical decisions.
  await sql`delete from catalog_shop_ratings where shop_id in (
    select shop_id from products where text_review is not null
  )`.execute(database);
  await sql`insert into catalog_projection_changes (shop_id)
    select distinct shop_id from products where text_review is not null`.execute(database);
  await sql`update catalog_cache_versions set version = version + 1, updated_at = now() where id = 1`.execute(database);
}

export const down = up;

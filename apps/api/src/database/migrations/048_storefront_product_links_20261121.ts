import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  if (!database.isTransaction) return database.transaction().execute(up);
  const updated = await sql`update products p
    set url = 'https://gpthub.ciyuanapi.ai/item/' || substring(p.url from length('https://gpthub.ciyuanapi.ai/products/') + 1)
    from shops s
    where p.shop_id = s.id and s.protocol = 'public-products-v1'
      and s.url in ('https://gpthub.ciyuanapi.ai', 'https://gpthub.ciyuanapi.ai/')
      and p.url like 'https://gpthub.ciyuanapi.ai/products/_%'
    returning p.id`.execute(database);
  if (updated.rows.length) {
    await sql`update catalog_cache_versions set version = version + 1, updated_at = now() where id = 1`.execute(database);
  }
}

export async function down(): Promise<void> {
  // Keep corrected links when rolling back; the old storefront paths return 404.
}

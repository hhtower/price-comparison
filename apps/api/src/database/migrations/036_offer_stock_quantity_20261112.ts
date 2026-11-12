import { sql, type Kysely } from 'kysely';
import { up as rebuildCatalogProjections } from './019_catalog_projection_rebuild_20261023.js';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`alter table offers add column stock_quantity bigint
    check (stock_quantity between 0 and 9007199254740991)`.execute(database);
  const source = await sql<{ body: string }>`select prosrc as body from pg_proc
    where oid = 'catalog_read_offers_offers_changed()'::regprocedure`.execute(database);
  const body = source.rows[0]?.body.replaceAll('stock_available, settlement_price', 'stock_available, stock_quantity, settlement_price');
  if (!body || body === source.rows[0]?.body) throw new Error('Could not extend catalog offer trigger for stock quantities');
  await sql.raw(`create or replace function catalog_read_offers_offers_changed() returns trigger
    language plpgsql set search_path from current as $function$${body}$function$`).execute(database);
  await rebuildCatalogProjections(database);
  await sql`select refresh_catalog_read_offers(array(select id from products order by id))`.execute(database);
}

export async function down(_database: Kysely<unknown>): Promise<void> {
  const source = await sql<{ body: string }>`select prosrc as body from pg_proc
    where oid = 'catalog_read_offers_offers_changed()'::regprocedure`.execute(_database);
  const body = source.rows[0]?.body.replaceAll('stock_available, stock_quantity, settlement_price', 'stock_available, settlement_price');
  if (!body || body === source.rows[0]?.body) throw new Error('Could not restore the catalog offer trigger without stock quantities');
  await sql.raw(`create or replace function catalog_read_offers_offers_changed() returns trigger
    language plpgsql set search_path from current as $function$${body}$function$`).execute(_database);
  await sql`alter table offers drop column stock_quantity`.execute(_database);
  await sql`select refresh_catalog_read_offers(array(select id from products order by id))`.execute(_database);
}

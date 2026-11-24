import { sql, type Kysely } from 'kysely';

const projectionEdits = [
  ['latest.settlement_payment_method, latest.settlement_quantity',
    'latest.settlement_payment_method, latest.settlement_kind, latest.settlement_quantity'],
  [', settlement_payment_method, settlement_quantity',
    ', settlement_payment_method, settlement_kind, settlement_quantity'],
  ['settlement_payment_method = excluded.settlement_payment_method',
    'settlement_payment_method = excluded.settlement_payment_method, settlement_kind = excluded.settlement_kind'],
  ['stored.settlement_payment_method, stored.settlement_quantity',
    'stored.settlement_payment_method, stored.settlement_kind, stored.settlement_quantity'],
  ['excluded.settlement_payment_method, excluded.settlement_quantity',
    'excluded.settlement_payment_method, excluded.settlement_kind, excluded.settlement_quantity'],
] as const;

async function updateProjectionFunctions(database: Kysely<unknown>, reverse = false): Promise<void> {
  // Extend in place so stock tracking, locks and later projection triggers survive.
  for (const signature of ['refresh_catalog_read_offers(bigint[])', 'catalog_read_offers_offers_changed()']) {
    const source = await sql<{ definition: string }>`select pg_get_functiondef(${signature}::regprocedure) as definition`.execute(database);
    let definition = source.rows[0]!.definition;
    const edits = signature.startsWith('refresh_') ? projectionEdits : [projectionEdits[1]];
    for (const [before, after] of edits) {
      const [from, to] = reverse ? [after, before] : [before, after];
      if (!definition.includes(from)) throw new Error(`Unexpected settlement projection definition: ${signature}`);
      definition = definition.replaceAll(from, to);
    }
    await sql.raw(definition).execute(database);
  }
}

export async function up(database: Kysely<unknown>): Promise<void> {
  if (!database.isTransaction) return database.transaction().execute(up);
  await sql`lock table products, offers, catalog_product_facts, standard_product_members
    in share row exclusive mode`.execute(database);
  for (const table of ['offers', 'catalog_read_offers', 'catalog_read_offer_prices']) {
    await sql`alter table ${sql.id(table)} add column settlement_kind text not null default 'verified'
      check (settlement_kind in ('verified', 'estimated'))`.execute(database);
  }
  await updateProjectionFunctions(database);
  await sql`update offers set settlement_kind = 'estimated'
    where settlement_payment_method like '%预估%'`.execute(database);
  await sql`alter table offer_price_history add column settlement_kind text not null default 'verified'
    check (settlement_kind in ('verified', 'estimated'))`.execute(database);
  await sql`update offer_price_history set settlement_kind = 'estimated'
    where payment_method like '%预估%'`.execute(database);
  await sql`select refresh_catalog_read_offers(array(select id from products order by id))`.execute(database);
  await sql`drop trigger offers_record_price_history on offers`.execute(database);
  await sql`create trigger offers_record_price_history after insert or update on offers
    for each row when (new.settlement_kind = 'verified')
    execute function record_offer_price_history()`.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  if (!database.isTransaction) return database.transaction().execute(down);
  await sql`lock table products, offers, catalog_product_facts, standard_product_members
    in share row exclusive mode`.execute(database);
  await sql`drop trigger offers_record_price_history on offers`.execute(database);
  await sql`create trigger offers_record_price_history after insert or update on offers
    for each row when (new.settlement_payment_method not like '%预估%')
    execute function record_offer_price_history()`.execute(database);
  await updateProjectionFunctions(database, true);
  await sql`alter table offer_price_history drop column settlement_kind`.execute(database);
  for (const table of ['catalog_read_offer_prices', 'catalog_read_offers', 'offers']) {
    await sql`alter table ${sql.id(table)} drop column settlement_kind`.execute(database);
  }
}

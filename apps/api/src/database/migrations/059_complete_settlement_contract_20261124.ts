import { sql, type Kysely } from 'kysely';

const functions = [
  ['refresh_catalog_read_offers(bigint[])',
    "(to_jsonb(latest)->>'stock_quantity')::bigint as stock_quantity", 'latest.stock_quantity'],
  ['record_offer_price_history()', 'coalesce(new.settlement_quantity, 1)', 'new.settlement_quantity'],
] as const;

async function updateFunctions(database: Kysely<unknown>, reverse = false): Promise<void> {
  for (const [signature, before, after] of functions) {
    const source = await sql<{ definition: string }>`select pg_get_functiondef(${signature}::regprocedure) as definition`.execute(database);
    const [from, to] = reverse ? [after, before] : [before, after];
    if (!source.rows[0]!.definition.includes(from)) throw new Error(`Unexpected function definition: ${signature}`);
    await sql.raw(source.rows[0]!.definition.replaceAll(from, to)).execute(database);
  }
}

export async function up(database: Kysely<unknown>): Promise<void> {
  if (!database.isTransaction) return database.transaction().execute(up);
  await sql`lock table products, offers, catalog_product_facts, standard_product_members,
    offer_price_history in share row exclusive mode`.execute(database);
  const incomplete = await sql<{ present: boolean }>`select exists (
    select 1 from offers where settlement_price is not null
      and (settlement_quantity is null or settlement_total_amount is null)) as present`.execute(database);
  if (incomplete.rows[0]!.present) throw new Error(
    'Incomplete settlement metadata: stop writers and run npm run db:prepare-settlements -- --apply before migrating');
  await sql`alter table offers add constraint offers_settlement_complete_check check (
    (settlement_price is null and settlement_quantity is null and settlement_total_amount is null)
    or (settlement_price is not null and settlement_quantity is not null and settlement_total_amount is not null)
  )`.execute(database);
  await updateFunctions(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  if (!database.isTransaction) return database.transaction().execute(down);
  await sql`lock table products, offers, catalog_product_facts, standard_product_members,
    offer_price_history in share row exclusive mode`.execute(database);
  await updateFunctions(database, true);
  await sql`alter table offers drop constraint offers_settlement_complete_check`.execute(database);
}

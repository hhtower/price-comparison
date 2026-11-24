import { sql, type Kysely } from 'kysely';

async function relabelClassicEstimates(database: Kysely<unknown>, from: string, to: string): Promise<void> {
  const classic = sql`(sh.protocol = 'dujiaoka' or (sh.protocol is null and lower(split_part(sh.url, '/', 3)) = 'ouvg.top'))`;
  // This old adapter copied the listing price; it never requested a settlement quote.
  await sql`update offers o set settlement_payment_method = ${to}
    from products p join shops sh on sh.id = p.shop_id
    where o.product_id = p.id and o.settlement_payment_method = ${from} and ${classic}`.execute(database);
  await sql`update offer_price_history h set payment_method = ${to}
    from products p join shops sh on sh.id = p.shop_id
    where h.product_id = p.id and h.payment_method = ${from} and ${classic}`.execute(database);
}

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`drop trigger offers_record_price_history on offers`.execute(database);
  await sql`create trigger offers_record_price_history after insert or update on offers
    for each row when (new.settlement_payment_method not like '%预估%')
    execute function record_offer_price_history()`.execute(database);
  await relabelClassicEstimates(database, '支付宝（无手续费）', '支付宝（无手续费，预估）');
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await relabelClassicEstimates(database, '支付宝（无手续费，预估）', '支付宝（无手续费）');
  await sql`drop trigger offers_record_price_history on offers`.execute(database);
  await sql`create trigger offers_record_price_history after insert or update on offers
    for each row execute function record_offer_price_history()`.execute(database);
}

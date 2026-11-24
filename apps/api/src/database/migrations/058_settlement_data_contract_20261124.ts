import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  if (!database.isTransaction) return database.transaction().execute(up);
  await sql`lock table products, offers, catalog_product_facts, standard_product_members,
    offer_price_history, fetch_runs in share row exclusive mode`.execute(database);
  const trigger = await sql<{ definition: string }>`select pg_get_functiondef(
    'catalog_read_offers_offers_changed()'::regprocedure) as definition`.execute(database);
  // Earlier projection rebuilds omitted stock-only changes from the offer trigger.
  await sql.raw(trigger.rows[0]!.definition.replaceAll('stock_available, settlement_price',
    'stock_available, stock_quantity, settlement_price')
    .replaceAll('settlement_payment_method, settlement_quantity, settlement_kind',
      'settlement_payment_method, settlement_kind, settlement_quantity')).execute(database);
  await sql`select refresh_catalog_read_offers(array(select id from products order by id))`.execute(database);
  // Some installations ran the earlier 057; normalize them once before starting the new workers.
  await sql`alter table offer_price_history add column if not exists settlement_kind text
    check (settlement_kind in ('verified', 'estimated'))`.execute(database);
  await sql`update offer_price_history h set settlement_kind = coalesce(
      (select o.settlement_kind from offers o where o.product_id = h.product_id
        and o.settlement_verified_at = h.verified_at order by o.captured_at desc, o.id desc limit 1),
      case when h.payment_method like '%预估%' then 'estimated' else 'verified' end)
    where h.settlement_kind is null`.execute(database);
  await sql`alter table offer_price_history alter column settlement_kind set not null,
    alter column settlement_kind set default 'verified'`.execute(database);
  await sql`with normalized as (
      select f.id, f.task_type, f.settlement_report as report,
        case when f.settlement_report ? 'estimated' then (f.settlement_report->>'estimated')::integer
          when sh.protocol = 'dujiaoka' or (sh.protocol is null and lower(split_part(sh.url, '/', 3)) = 'ouvg.top')
            then greatest(coalesce((f.settlement_report->>'verified')::integer, 0),
              coalesce((f.settlement_report#>>'{reasons,estimated}')::integer, 0))
          else coalesce((f.settlement_report#>>'{reasons,estimated}')::integer, 0) end as estimated
      from fetch_runs f join shops sh on sh.id = f.shop_id where f.settlement_report is not null
    )
    update fetch_runs f set settlement_report = n.report || jsonb_build_object(
      'estimated', n.estimated,
      'verified', case when n.report ? 'estimated' then (n.report->>'verified')::integer
        else greatest(0, coalesce((n.report->>'verified')::integer, 0) - n.estimated) end,
      'terminalEstimated', coalesce(n.report->'terminalEstimated',
        to_jsonb(case when n.task_type = 'settlement' then n.estimated else 0 end)),
      'terminalReasons', coalesce(n.report->'terminalReasons', '{}'::jsonb))
    from normalized n where f.id = n.id`.execute(database);
  await sql`drop trigger offers_record_price_history on offers`.execute(database);
  await sql`create trigger offers_record_price_history after insert or update on offers
    for each row when (new.settlement_kind = 'verified')
    execute function record_offer_price_history()`.execute(database);
}

export async function down(): Promise<void> {
  // 057 owns the column. Keep normalized data when rolling back this data-only repair.
}

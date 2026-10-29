import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`alter table offers
    alter column settlement_price type numeric,
    add column settlement_quantity integer,
    add column settlement_total_amount numeric(14,2),
    add constraint offers_settlement_quantity_check check (
      (settlement_quantity is null and settlement_total_amount is null)
      or (settlement_price is not null and settlement_quantity is not null and settlement_quantity > 0
        and settlement_total_amount is not null and settlement_total_amount >= 0
        and settlement_total_amount < 1000000000000
        and settlement_price * 1000000000000 = div(
          2 * settlement_total_amount * 1000000000000 + settlement_quantity, 2::numeric * settlement_quantity))
    )`.execute(database);
  // Existing quotes were requested for one unit; null metadata remains compatible with old writers.
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`do $$ begin
    lock table offers in access exclusive mode;
    if exists (select 1 from offers where settlement_quantity > 1) then
      raise exception 'multi-unit settlements prevent automatic downgrade; resolve bulk quotes before rolling back';
    end if;
  end $$`.execute(database);
  await sql`alter table offers drop constraint offers_settlement_quantity_check,
    drop column settlement_quantity, drop column settlement_total_amount,
    alter column settlement_price type numeric(14,2)`.execute(database);
}

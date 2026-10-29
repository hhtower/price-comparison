import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`alter table offers add column settlement_price numeric(14,2)`.execute(database);
  await sql`alter table offers add column settlement_verified_at timestamp with time zone`.execute(database);
  await sql`alter table offers add column settlement_payment_method text`.execute(database);
  await sql`alter table offers add constraint offers_settlement_price_check check (settlement_price is null or (settlement_price >= 0 and settlement_price < 1000000000000))`.execute(database);
  await sql`alter table offers add constraint offers_settlement_fields_check check ((settlement_price is null and settlement_verified_at is null and settlement_payment_method is null) or (settlement_price is not null and settlement_verified_at is not null and settlement_payment_method is not null and btrim(settlement_payment_method) <> ''))`.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`alter table offers drop constraint offers_settlement_fields_check`.execute(database);
  await sql`alter table offers drop constraint offers_settlement_price_check`.execute(database);
  await sql`alter table offers drop column settlement_payment_method`.execute(database);
  await sql`alter table offers drop column settlement_verified_at`.execute(database);
  await sql`alter table offers drop column settlement_price`.execute(database);
}

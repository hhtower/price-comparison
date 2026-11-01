import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`create table catalog_coverage (
    id integer primary key check (id = 1), shop_count bigint not null, product_count bigint not null
  )`.execute(database);
  await sql`insert into catalog_coverage values (1, 0, 0)`.execute(database);
  await sql`create table catalog_shop_ratings (
    shop_id bigint primary key references shops(id) on delete cascade,
    score text, details jsonb, computed_at timestamptz not null
  )`.execute(database);
  await sql`create table catalog_read_shop_totals (
    standard_product_id bigint not null, shop_id bigint not null, currency text not null,
    min_price numeric not null, latest_captured_at timestamptz not null,
    product_count integer not null, winner_id bigint not null,
    primary key (standard_product_id, currency, shop_id)
  )`.execute(database);
  // Append-only events avoid taking shop locks from product/offer writers.
  await sql`create table catalog_projection_changes (
    id bigint generated always as identity primary key,
    shop_id bigint, standard_product_id bigint, coverage boolean not null default false,
    check (num_nonnulls(shop_id, standard_product_id, nullif(coverage, false)) = 1)
  )`.execute(database);
  await sql`create index catalog_projection_changes_shop on catalog_projection_changes (shop_id, id) where shop_id is not null`.execute(database);
  await sql`create index catalog_projection_changes_standard on catalog_projection_changes (standard_product_id, id) where standard_product_id is not null`.execute(database);

  for (const operation of ['insert', 'update', 'delete'] as const) {
    const old = operation !== 'insert';
    const next = operation !== 'delete';
    const transition = sql.raw(`${old ? 'old table as old_rows' : ''} ${next ? 'new table as new_rows' : ''}`);
    const changedReviews = operation === 'update' ? sql`
      select n.shop_id from new_rows n join old_rows o using (id)
      where (n.shop_id, n.text_review_key) is distinct from (o.shop_id, o.text_review_key)
      union select o.shop_id from new_rows n join old_rows o using (id)
      where (n.shop_id, n.text_review_key) is distinct from (o.shop_id, o.text_review_key)`
      : sql`select shop_id from ${sql.table(next ? 'new_rows' : 'old_rows')} where text_review_key is not null`;
    await sql`create function ${sql.id(`catalog_review_changes_${operation}`)}() returns trigger
      language plpgsql set search_path from current as $function$
      begin
        insert into catalog_projection_changes (shop_id) select distinct shop_id from (${changedReviews}) changes;
        ${operation === 'update' ? sql`` : sql`if exists (select 1 from ${sql.table(next ? 'new_rows' : 'old_rows')}) then
          insert into catalog_projection_changes (coverage) values (true);
        end if;`}
        return null;
      end $function$`.execute(database);
    await sql`create trigger ${sql.id(`catalog_review_changes_${operation}`)} after ${sql.raw(operation)} on products
      referencing ${transition} for each statement execute function ${sql.id(`catalog_review_changes_${operation}`)}()`.execute(database);

    const changedStandards = operation === 'update' ? sql`
      select n.standard_product_id from new_rows n join old_rows o using (product_id)
      where (n.standard_product_id, n.shop_id, n.currency, n.price, n.available, n.captured_at)
        is distinct from (o.standard_product_id, o.shop_id, o.currency, o.price, o.available, o.captured_at)
      union select o.standard_product_id from new_rows n join old_rows o using (product_id)
      where (n.standard_product_id, n.shop_id, n.currency, n.price, n.available, n.captured_at)
        is distinct from (o.standard_product_id, o.shop_id, o.currency, o.price, o.available, o.captured_at)`
      : sql`select standard_product_id from ${sql.table(next ? 'new_rows' : 'old_rows')}`;
    await sql`create function ${sql.id(`catalog_summary_changes_${operation}`)}() returns trigger
      language plpgsql set search_path from current as $function$
      begin
        insert into catalog_projection_changes (standard_product_id)
          select distinct standard_product_id from (${changedStandards}) changes;
        return null;
      end $function$`.execute(database);
    await sql`create trigger ${sql.id(`catalog_summary_changes_${operation}`)} after ${sql.raw(operation)} on catalog_read_offer_prices
      referencing ${transition} for each statement execute function ${sql.id(`catalog_summary_changes_${operation}`)}()`.execute(database);
  }
  await sql`create function catalog_projection_truncated() returns trigger
    language plpgsql set search_path from current as $function$
    begin
      if tg_table_name = 'products' then
        insert into catalog_projection_changes (coverage) values (true);
        insert into catalog_projection_changes (shop_id)
          select distinct shop_id from products where text_review_key is not null;
      else
        insert into catalog_projection_changes (standard_product_id)
          select standard_product_id from catalog_read_shop_totals
          union select standard_product_id from catalog_read_offer_prices;
      end if;
      return null;
    end $function$`.execute(database);
  for (const table of ['products', 'catalog_read_offer_prices']) {
    await sql`create trigger catalog_projection_truncated before truncate on ${sql.table(table)}
      for each statement execute function catalog_projection_truncated()`.execute(database);
  }
  await sql`create function catalog_shop_projection_changed() returns trigger
    language plpgsql set search_path from current as $function$
    begin
      if tg_op in ('INSERT', 'DELETE') then
        insert into catalog_projection_changes (coverage) values (true);
      end if;
      if tg_op = 'DELETE' then return null; end if;
      if tg_op = 'INSERT' or new.rating_revision is distinct from old.rating_revision then
        insert into catalog_projection_changes (shop_id) values (new.id);
      end if;
      return null;
    end $function$`.execute(database);
  await sql`create trigger catalog_shop_projection_changed after insert or delete or update of rating_revision, url, protocol, platform, shop_rating, rating_manifest on shops
    for each row execute function catalog_shop_projection_changed()`.execute(database);
  await sql`insert into catalog_projection_changes (shop_id) select id from shops`.execute(database);
  await sql`insert into catalog_projection_changes (coverage) values (true)`.execute(database);
  await sql`insert into catalog_projection_changes (standard_product_id)
    select distinct standard_product_id from catalog_read_offer_prices`.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  for (const table of ['products', 'catalog_read_offer_prices']) {
    await sql`drop trigger catalog_projection_truncated on ${sql.table(table)}`.execute(database);
  }
  await sql`drop function catalog_projection_truncated()`.execute(database);
  await sql`drop trigger catalog_shop_projection_changed on shops`.execute(database);
  await sql`drop function catalog_shop_projection_changed()`.execute(database);
  for (const operation of ['insert', 'update', 'delete']) {
    for (const [prefix, table] of [['catalog_review_changes', 'products'], ['catalog_summary_changes', 'catalog_read_offer_prices']]) {
      await sql`drop trigger ${sql.id(`${prefix}_${operation}`)} on ${sql.table(table!)}`.execute(database);
      await sql`drop function ${sql.id(`${prefix}_${operation}`)}()`.execute(database);
    }
  }
  await sql`drop table catalog_projection_changes, catalog_read_shop_totals, catalog_shop_ratings, catalog_coverage`.execute(database);
}

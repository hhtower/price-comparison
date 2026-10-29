import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`create table offer_price_history (
    id bigint generated always as identity primary key,
    product_id bigint not null references products(id) on delete cascade,
    standard_product_id bigint references standard_products(id) on delete cascade,
    content_version bigint not null,
    name text not null, spec text not null,
    price numeric not null check (price >= 0 and price < 1000000000000),
    currency text not null check (currency ~ '^[A-Z]{3}$'),
    quantity integer not null check (quantity > 0),
    payment_method text not null check (btrim(payment_method) <> ''),
    verified_at timestamptz not null,
    recorded_at timestamptz not null default clock_timestamp(),
    unique (product_id, verified_at)
  )`.execute(database);
  await sql`create index offer_price_history_standard_date on offer_price_history
    (standard_product_id, currency, verified_at, product_id)`.execute(database);
  await sql`create function record_offer_price_history() returns trigger language plpgsql as $$
  begin
    if tg_op = 'UPDATE' then
      -- Cached quotes keep their original verification; never attach them to a newer SKU version.
      if new.settlement_verified_at is not distinct from old.settlement_verified_at then return new; end if;
    end if;
    if new.settlement_price is not null and new.settlement_price >= 0 and new.settlement_price < 1000000000000
      and new.price >= 0 and new.price < 'Infinity'::numeric
      and new.settlement_verified_at is not null and new.settlement_verified_at <= clock_timestamp()
      and nullif(btrim(new.settlement_payment_method), '') is not null
      and new.currency ~ '^[A-Z]{3}$' and not new.is_stale and new.stock_available then
      insert into offer_price_history (product_id, standard_product_id, content_version, name, spec,
        price, currency, quantity, payment_method, verified_at)
      select p.id, m.standard_product_id, p.content_version, p.name, p.spec,
        new.settlement_price, new.currency, coalesce(new.settlement_quantity, 1),
        new.settlement_payment_method, new.settlement_verified_at
      from products p left join standard_product_members m on m.product_id = p.id and m.publication_state = 'published'
      where p.id = new.product_id
      on conflict (product_id, verified_at) do nothing;
    end if;
    return new;
  end $$`.execute(database);
  await sql`create trigger offers_record_price_history after insert or update on offers
    for each row execute function record_offer_price_history()`.execute(database);
  // This is a baseline of real existing verification timestamps, not a reconstruction of past days.
  await sql`insert into offer_price_history (product_id, standard_product_id, content_version, name, spec,
      price, currency, quantity, payment_method, verified_at)
    select p.id, m.standard_product_id,
      p.content_version, p.name, p.spec, o.settlement_price, o.currency, coalesce(o.settlement_quantity, 1),
      o.settlement_payment_method, o.settlement_verified_at
    from (select distinct on (product_id) * from offers order by product_id, captured_at desc, id desc) o
    join products p on p.id = o.product_id
    left join standard_product_members m on m.product_id = p.id and m.publication_state = 'published'
    where o.settlement_price >= 0 and o.settlement_price < 1000000000000
      and o.price >= 0 and o.price < 'Infinity'::numeric
      and o.settlement_verified_at <= clock_timestamp()
      and o.settlement_verified_at >= p.content_changed_at
      and nullif(btrim(o.settlement_payment_method), '') is not null
      and o.currency ~ '^[A-Z]{3}$' and not o.is_stale and o.stock_available
    on conflict (product_id, verified_at) do nothing`.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`drop trigger offers_record_price_history on offers`.execute(database);
  await sql`drop function record_offer_price_history()`.execute(database);
  await sql`drop table offer_price_history`.execute(database);
}

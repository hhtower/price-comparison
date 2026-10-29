import { sql, type Kysely } from 'kysely';

const SOURCES = [
  { table: 'products', key: 'id',
    fields: 'id, shop_id, name, url, spec, normalized_key, deleted_at' },
  { table: 'offers', key: 'product_id',
    fields: 'id, product_id, price, currency, captured_at, is_stale, stock_available, settlement_price, settlement_verified_at, settlement_payment_method, settlement_quantity' },
  { table: 'catalog_product_facts', key: 'product_id',
    fields: 'product_id, tags, tag_text, facet_tags' },
  { table: 'standard_product_members', key: 'product_id',
    fields: 'product_id, standard_product_id, publication_state' },
] as const;

const COLUMNS = [
  'product_id', 'standard_product_id', 'shop_id', 'product_name', 'product_url', 'product_spec',
  'search_text', 'tags', 'facet_tags', 'listed_price', 'currency', 'captured_at', 'is_stale', 'stock_available',
  'settlement_price', 'settlement_verified_at', 'settlement_payment_method', 'settlement_quantity',
] as const;

const PRICE_COLUMNS = [
  'product_id', 'standard_product_id', 'shop_id', 'listed_price', 'currency', 'captured_at', 'is_stale',
  'stock_available', 'settlement_price', 'settlement_verified_at', 'settlement_payment_method', 'settlement_quantity',
] as const;

export async function up(database: Kysely<unknown>): Promise<void> {
  if (!database.isTransaction) return database.transaction().execute(up);
  // Block source writes until triggers and the initial projection become visible together.
  await sql`lock table products, offers, catalog_product_facts, standard_product_members
    in share row exclusive mode`.execute(database);
  await sql`create function catalog_read_offers_max_warranty_days(tags jsonb)
    returns integer language sql immutable parallel safe set search_path to 'pg_catalog' as $function$
      select max(case when days between -2147483648::bigint and 2147483647 then days::integer end)
      from (
        select case when value ~ '^[+-]?[0-9]+$'
          and length(ltrim(ltrim(value, '+-'), '0')) <= 10 then value::bigint end as days
        from (
          select regexp_replace(tag->>'value', '^[[:space:]]+|[[:space:]]+$', '', 'g') as value
          from jsonb_array_elements(case when jsonb_typeof(tags) = 'array' then tags else '[]'::jsonb end) entries(tag)
          where tag->>'name' = 'warranty_days'
        ) tag_values
      ) parsed
    $function$`.execute(database);
  await sql`create table catalog_read_offers (
    product_id bigint primary key references products(id) on delete cascade,
    standard_product_id bigint not null,
    shop_id bigint not null,
    product_name text not null,
    product_url text not null,
    product_spec text not null,
    search_text text not null,
    tags jsonb not null,
    warranty_days integer generated always as (catalog_read_offers_max_warranty_days(tags)) stored,
    facet_tags text not null,
    listed_price numeric not null,
    currency text not null,
    captured_at timestamptz not null,
    is_stale boolean not null,
    stock_available boolean not null,
    available boolean generated always as (
      not is_stale and stock_available and listed_price >= 0 and listed_price < 'Infinity'::numeric
    ) stored,
    settlement_price numeric,
    settlement_verified_at timestamptz,
    settlement_payment_method text,
    settlement_quantity integer
  )`.execute(database);
  await sql`create index catalog_read_offers_standard_product on catalog_read_offers (standard_product_id, product_id)`.execute(database);
  await sql`create index catalog_read_offers_shop on catalog_read_offers (shop_id, product_id)`.execute(database);
  await sql`create index catalog_read_offers_search_text_trgm
    on catalog_read_offers using gin (search_text public.gin_trgm_ops)`.execute(database);
  await sql`create index catalog_read_offers_tags on catalog_read_offers using gin (tags jsonb_path_ops)`.execute(database);
  await sql`create index catalog_read_offers_warranty_days on catalog_read_offers (warranty_days)
    where warranty_days is not null`.execute(database);
  await sql`create table catalog_read_offer_prices (
    product_id bigint primary key references products(id) on delete cascade,
    standard_product_id bigint not null,
    shop_id bigint not null,
    listed_price numeric not null,
    currency text not null,
    captured_at timestamptz not null,
    is_stale boolean not null,
    stock_available boolean not null,
    available boolean generated always as (
      not is_stale and stock_available and listed_price >= 0 and listed_price < 'Infinity'::numeric
    ) stored,
    settlement_price numeric,
    settlement_verified_at timestamptz,
    settlement_payment_method text,
    settlement_quantity integer,
    price numeric generated always as (
      case when settlement_price is not null and settlement_price >= 0 and settlement_price < 'Infinity'::numeric
        and settlement_verified_at is not null and nullif(btrim(settlement_payment_method), '') is not null
      then settlement_price else listed_price end
    ) stored,
    verification_at timestamptz generated always as (
      case when settlement_price is not null and settlement_price >= 0 and settlement_price < 'Infinity'::numeric
        and settlement_verified_at is not null and nullif(btrim(settlement_payment_method), '') is not null
      then least(captured_at, settlement_verified_at) else null end
    ) stored
  )`.execute(database);
  await sql`create index catalog_read_offer_prices_standard_product
    on catalog_read_offer_prices (standard_product_id, product_id)`.execute(database);

  await sql`create function refresh_catalog_read_offers(product_ids bigint[])
    returns void language plpgsql set jit to 'off' set search_path from current as $function$
    begin
      if coalesce(cardinality(product_ids), 0) = 0 then return; end if;
      -- Readers join parent fields live; parent locks here reverse the crawler shop-to-product lock order.
      -- Serialize every source writer before testing eligibility in the next SQL snapshot.
      perform p.id from products p where p.id = any(product_ids) order by p.id for no key update;
      -- Keep existing rows for removals; unpublished/quoteless first writes need no document refresh.
      select array_agg(c.product_id) into product_ids from (
        select r.product_id from catalog_read_offers r where r.product_id = any(product_ids)
        union
        select m.product_id from standard_product_members m
        where m.product_id = any(product_ids) and m.publication_state = 'published'
          and exists (select 1 from offers o where o.product_id = m.product_id)
      ) c;
      if coalesce(cardinality(product_ids), 0) = 0 then return; end if;
      -- A separate SQL statement gets a fresh READ COMMITTED snapshot after any lock wait.
      with candidates as materialized (
        select p.id as product_id, m.standard_product_id, p.shop_id,
          p.name as product_name, p.url as product_url, p.spec as product_spec,
          lower(normalize(concat_ws(' ', p.name, p.spec, p.normalized_key, facts.tag_text), NFKC)) as search_text,
          coalesce(facts.tags, '[]'::jsonb) as tags, coalesce(facts.facet_tags, '[]') as facet_tags,
          latest.price as listed_price, latest.currency, latest.captured_at, latest.is_stale,
          latest.stock_available, latest.settlement_price, latest.settlement_verified_at,
          latest.settlement_payment_method, latest.settlement_quantity
        from products p
        join standard_product_members m on m.product_id = p.id and m.publication_state = 'published'
        left join catalog_product_facts facts on facts.product_id = p.id
        cross join lateral (
          select o.* from offers o where o.product_id = p.id
          order by o.captured_at desc, o.id desc limit 1
        ) latest
        where p.id = any(product_ids) and p.deleted_at is null
      ), removed as (
        delete from catalog_read_offers r where r.product_id = any(product_ids)
          and not exists (select 1 from candidates c where c.product_id = r.product_id)
      )
      insert into catalog_read_offers as stored (${sql.raw(COLUMNS.join(', '))})
        select ${sql.raw(COLUMNS.join(', '))} from candidates order by product_id
      on conflict (product_id) do update set
        ${sql.raw(COLUMNS.slice(1).map(column => `${column} = excluded.${column}`).join(', '))}
      where (${sql.raw(COLUMNS.slice(1).map(column => `stored.${column}`).join(', '))})
        is distinct from (${sql.raw(COLUMNS.slice(1).map(column => `excluded.${column}`).join(', '))});
      -- Reuse the completed wide rows while still holding the same product locks.
      with removed as (
        delete from catalog_read_offer_prices r where r.product_id = any(product_ids)
          and not exists (select 1 from catalog_read_offers w where w.product_id = r.product_id)
      )
      insert into catalog_read_offer_prices as stored (${sql.raw(PRICE_COLUMNS.join(', '))})
        select ${sql.raw(PRICE_COLUMNS.join(', '))} from catalog_read_offers
        where product_id = any(product_ids) order by product_id
      on conflict (product_id) do update set
        ${sql.raw(PRICE_COLUMNS.slice(1).map(column => `${column} = excluded.${column}`).join(', '))}
      where (${sql.raw(PRICE_COLUMNS.slice(1).map(column => `stored.${column}`).join(', '))})
        is distinct from (${sql.raw(PRICE_COLUMNS.slice(1).map(column => `excluded.${column}`).join(', '))});
    end
    $function$`.execute(database);

  for (const source of SOURCES) {
    const functionName = `catalog_read_offers_${source.table}_changed`;
    await sql.raw(`create function ${functionName}() returns trigger
      language plpgsql set search_path from current as $function$
      declare product_ids bigint[];
      begin
        if tg_op = 'TRUNCATE' then
          select array_agg(product_id) into product_ids from catalog_read_offers;
        else
          if tg_op = 'INSERT' then
            select array_agg(distinct ${source.key}) into product_ids from new_rows;
          elsif tg_op = 'DELETE' then
            select array_agg(distinct ${source.key}) into product_ids from old_rows;
          else
            select array_agg(distinct ${source.key}) into product_ids from (
              (select ${source.fields} from new_rows except select ${source.fields} from old_rows)
              union
              (select ${source.fields} from old_rows except select ${source.fields} from new_rows)
            ) changed;
          end if;
        end if;
        perform refresh_catalog_read_offers(product_ids);
        return null;
      end
      $function$`).execute(database);
    for (const [event, transition] of [
      ['insert', 'referencing new table as new_rows'],
      ['update', 'referencing old table as old_rows new table as new_rows'],
      ['delete', 'referencing old table as old_rows'],
      ['truncate', ''],
    ]) {
      await sql.raw(`create trigger catalog_read_offers_${source.table}_${event}
        after ${event} on ${source.table} ${transition}
        for each statement execute function ${functionName}()`).execute(database);
    }
  }
  await sql`select refresh_catalog_read_offers(array(select id from products order by id))`.execute(database);
  await sql`analyze catalog_read_offers, catalog_read_offer_prices, standard_products, shops`.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  if (!database.isTransaction) return database.transaction().execute(down);
  for (const source of SOURCES) {
    for (const event of ['insert', 'update', 'delete', 'truncate']) {
      await sql.raw(`drop trigger catalog_read_offers_${source.table}_${event} on ${source.table}`).execute(database);
    }
    await sql.raw(`drop function catalog_read_offers_${source.table}_changed()`).execute(database);
  }
  await sql`drop function refresh_catalog_read_offers(bigint[])`.execute(database);
  await sql`drop table catalog_read_offer_prices`.execute(database);
  await sql`drop table catalog_read_offers`.execute(database);
  await sql`drop function catalog_read_offers_max_warranty_days(jsonb)`.execute(database);
}

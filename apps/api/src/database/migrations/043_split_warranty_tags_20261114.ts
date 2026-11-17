import { sql, type Kysely } from 'kysely';

// Freeze objective storage constraints independently of application policy.
const VALUES = {
  sms_verification: ['verified', 'unverified'],
  region: ['us', 'ph', 'jp', 'kr', 'ca', 'gb', 'de', 'fr', 'in', 'id', 'vn', 'br', 'cl', 'tr', 'ar', 'au', 'sg', 'hk', 'tw',
    'ru', 'th', 'my', 'mx', 'global', 'random', 'cn', 'eu', 'sea', 'co', 'za', 'nl', 'ng', 'pk', 'ua',
    'eg', 'bd', 'it', 'es', 'pl', 'pt', 'se', 'no', 'fi', 'ch', 'at', 'be', 'ie', 'nz', 'ae', 'sa', 'il', 'kz', 'pe', 'ke', 'ee'],
  access_channel: ['reverse_proxy', 'web', 'mirror', 'imap', 'pop3', 'graph', 'api'],
  subscription_override: ['无'],
  bulk_purchase: ['supported', 'required', 'bundle'],
};

export async function up(database: Kysely<unknown>): Promise<void> {
  if (!database.isTransaction) return database.transaction().execute(up);
  // Release partial locks before retrying so projection triggers cannot deadlock a concurrent writer.
  await sql`do $locks$
    begin
      for attempt in 1..40 loop
        begin
          lock table products, product_tags, offers, standard_product_members,
            catalog_product_facts, catalog_read_offers, catalog_read_offer_prices,
            catalog_read_facet_counts, catalog_projection_changes, catalog_cache_versions
            in access exclusive mode nowait;
          return;
        exception when lock_not_available then
          if attempt = 40 then
            raise exception 'Split warranty migration could not acquire table locks'
              using errcode = '55P03', hint = 'Pause application writers and workers, then retry the migration.';
          end if;
        end;
        perform pg_sleep(0.25);
      end loop;
    end
  $locks$`.execute(database);
  await sql`create or replace function catalog_valid_tag(name text, value jsonb)
    returns boolean language sql immutable parallel safe set search_path to 'pg_catalog'
    as $function$
      select coalesce(case when name = 'duration' then
        case jsonb_typeof(value)
          when 'number' then value > '0'::jsonb and value <= '36500'::jsonb
          when 'object' then case value->>'kind'
            when 'permanent' then value = '{"kind":"permanent"}'::jsonb
            when 'range' then value - array['kind', 'min', 'max'] = '{}'::jsonb
              and jsonb_typeof(value->'min') = 'number' and jsonb_typeof(value->'max') = 'number'
              and value->'min' > '0'::jsonb and value->'min' < value->'max' and value->'max' <= '36500'::jsonb
            else value->>'kind' in ('min', 'max', 'approx')
              and value - array['kind', 'days'] = '{}'::jsonb
              and jsonb_typeof(value->'days') = 'number'
              and value->'days' > '0'::jsonb and value->'days' <= '36500'::jsonb
          end
          else false
        end
      else jsonb_typeof(value) = 'string'
        and length(value #>> '{}') between 1 and 250
        and (value #>> '{}') !~ '^[[:space:]]|[[:space:]]$'
        and case name
          when 'supported_client' then length(value #>> '{}') <= 80 and value #>> '{}' = lower(value #>> '{}')
          when 'subscription_warranty' then true
          when 'usage_warranty' then true
          when 'warranty_terms' then true
          else (${sql.lit(JSON.stringify(VALUES))}::jsonb -> name) ? (value #>> '{}')
        end
      end, false)
    $function$`.execute(database);
  await sql`create or replace function catalog_readable_facets(tags jsonb)
    returns jsonb language sql immutable parallel safe set search_path from current
    as $function$
      select coalesce(jsonb_agg(jsonb_build_object('name', name, 'value', value) order by name, value), '[]'::jsonb)
      from (
        select distinct tag->>'name' as name, tag->'value' as value
        from jsonb_array_elements(case when jsonb_typeof(tags) = 'array' then tags else '[]'::jsonb end) tag
        where tag->>'name' <> 'warranty_terms' and catalog_valid_tag(tag->>'name', tag->'value')
      ) valid
    $function$`.execute(database);
  // Offer documents keep supporting terms; only short values enter facet counts.
  await sql`create or replace function refresh_catalog_product_facts(product_ids bigint[])
    returns void language plpgsql set jit to 'off' set search_path from current
    as $function$
    begin
      if coalesce(cardinality(product_ids), 0) = 0 then return; end if;
      perform p.id from products p where p.id = any(product_ids) order by p.id for no key update;
      insert into catalog_product_facts (product_id, tags, tag_text)
        select p.id, facts.tags,
          coalesce((select string_agg(t->>'value', ' ' order by t->>'name', t->'value')
            from jsonb_array_elements(facts.tags) t), '')
        from products p cross join lateral (
          select coalesce(jsonb_agg(jsonb_build_object('name', name, 'value', value) order by name, value), '[]'::jsonb) as tags
          from (select distinct name, value from product_tags
            where product_id = p.id and catalog_valid_tag(name, value)) valid
        ) facts where p.id = any(product_ids) order by p.id
      on conflict (product_id) do update set tags = excluded.tags, tag_text = excluded.tag_text;
    end
    $function$`.execute(database);
  await sql`update catalog_cache_versions set version = version + 1, updated_at = now() where id = 1`.execute(database);
}

export async function down(): Promise<void> {
  throw new Error('Split warranty tags cannot be downgraded; restore a pre-upgrade backup.');
}

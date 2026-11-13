import { sql, type Kysely } from 'kysely';

// Frozen storage validation: migrations must not change when application rules evolve.
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
  // Release partial locks before retrying; DDL and projection triggers must not upgrade locks mid-migration.
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
            raise exception 'Seven-dimension tag migration could not acquire table locks'
              using errcode = '55P03', hint = 'Pause application writers and workers, then retry the migration.';
          end if;
        end;
        perform pg_sleep(0.25);
      end loop;
    end
  $locks$`.execute(database);
  // Preserve legacy text as JSON strings; operations clears it separately, without semantic conversion.
  await sql`alter table product_tags alter column value type jsonb using to_jsonb(value)`.execute(database);
  await sql`drop index catalog_read_offers_warranty_days`.execute(database);
  await sql`alter table catalog_read_offers drop column warranty_days`.execute(database);
  await sql`drop function catalog_read_offers_max_warranty_days(jsonb)`.execute(database);
  await sql`create function catalog_valid_tag(name text, value jsonb)
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
          when 'warranty' then (value #>> '{}') !~* '^(none|covered|unknown|unspecified|有质保|有售后|无售后|无质保|不保|不质保|不提供售后|不提供质保|未说明|质保未说明)$'
            and (value #>> '{}') !~* '(质保|保修|保障)[[:space:]]*(已(经)?(过期|到期|失效|结束)|(过期|到期|失效|结束)(?![[:space:]]*(后|前|时|则)))|(warranty|guarantee|coverage)[[:space:]]*(has[[:space:]]+)?(expired|ended)'
            and exists (
              select 1 from regexp_split_to_table(value #>> '{}', '[,，;；。.!！?？' || chr(10) || ']') clauses(part)
              where part ~* '质保|保修|保(订阅|首登|首码)|仅保|包(赔|换|退)|换号|换货|退换|退款|维修|warranty|guarantee|coverage|replacement|refund|repair'
                and part !~* '(不享受|不享有|不提供|不承诺|不保证|不支持|不承担|没有|无|未提供|不|未)(任何)?(售后|质保|保修|保障|保订阅|保首登|保首码)|不(退款|退换|换货|换号|维修|包赔|包换|包退)|(^|[^a-z0-9_])(no|not|without|unavailable|expired|unknown)([^a-z0-9_]|$)'
            )
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
        where catalog_valid_tag(tag->>'name', tag->'value')
      ) valid
    $function$`.execute(database);
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
          select catalog_readable_facets(coalesce(jsonb_agg(
            jsonb_build_object('name', pt.name, 'value', pt.value)), '[]'::jsonb)) as tags
          from product_tags pt where pt.product_id = p.id
        ) facts where p.id = any(product_ids) order by p.id
      on conflict (product_id) do update set tags = excluded.tags, tag_text = excluded.tag_text;
    end
    $function$`.execute(database);
  // Existing fact triggers refresh generated facets, offer documents and facet counts atomically.
  await sql`select refresh_catalog_product_facts(array(select id from products order by id))`.execute(database);
  await sql`update catalog_cache_versions set version = version + 1, updated_at = now() where id = 1`.execute(database);
}

export async function down(): Promise<void> {
  throw new Error('Typed tags cannot be downgraded to the retired text protocol; restore a pre-upgrade backup.');
}

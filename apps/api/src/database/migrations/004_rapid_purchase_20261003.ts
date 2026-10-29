import { sql, type Kysely } from 'kysely';

// Immutable replacement of the prepared-fact function; only the rapid source rule changes.
const refreshFacts = String.raw`CREATE OR REPLACE FUNCTION refresh_catalog_product_facts(product_ids bigint[])
 RETURNS void
 LANGUAGE plpgsql
 SET jit TO 'off'
 SET search_path from current
AS $function$
    begin
      if coalesce(cardinality(product_ids), 0) = 0 then return; end if;
      -- Serialize evidence/tag writers for each product. The following statement
      -- takes a fresh READ COMMITTED snapshot after any contended lock is acquired.
      perform p.id from products p where p.id = any(product_ids) order by p.id for no key update;
      with eligible_skus as materialized (
        select p.id as product_id, normalize(concat_ws(' ; ', p.name, p.spec), NFKC) as evidence_text
        from products p where p.id = any(product_ids)
      ),
    raw_tags as materialized (
      select e.product_id, coalesce(E'{"sms":"sms_verification","sms_verification":"sms_verification","短信验证":"sms_verification","短信认证":"sms_verification","接码":"sms_verification","warranty":"warranty","warranty_status":"warranty","guarantee":"warranty","保修":"warranty","质保":"warranty","保障":"warranty","warranty_scope":"warranty_scope","guarantee_scope":"warranty_scope","质保范围":"warranty_scope","保障范围":"warranty_scope","warranty_days":"warranty_days","guarantee_days":"warranty_days","质保天数":"warranty_days","保修天数":"warranty_days","warranty_detail":"warranty_detail","intended_use":"intended_use","use":"intended_use","usage":"intended_use","适用场景":"intended_use","用途":"intended_use","access":"access","access_type":"access","访问方式":"access","权限":"access","delivery":"delivery","delivery_method":"delivery","delivery_type":"delivery","交付方式":"delivery","duration":"duration","subscription_duration":"duration","term":"duration","订阅时长":"duration","时长":"duration"}'::jsonb ->> lower(normalize(btrim(pt.name), NFKC)), lower(normalize(btrim(pt.name), NFKC))) as name, lower(normalize(btrim(pt.value), NFKC)) as value
        from "eligible_skus" e join product_tags pt on pt.product_id = e.product_id
      union all
      select e.product_id, r.name, r.value from "eligible_skus" e
        cross join (values (E'sms_verification', E'unverified', E'(未|尚未)(接码|接马|接馬)', E''), (E'sms_verification', E'verified', E'(已|已经)(接码|接马|接馬)', E''), (E'warranty', E'none', E'(无质保|不质保|不保售后|不包售后|没有质保)', E''), (E'warranty', E'first login', E'(质保首登|首登质保|仅保首登|只保首登)', E'(不保首登|无首登质保)'), (E'warranty', E'covered', E'(有质保|包售后|提供质保)', E'(没有质保|不包售后|不提供质保)'), (E'intended_use', E'rapid', E'(速刷|日抛)', E'((不要|不需要|无需|不想要|不支持|不提供|不适合|禁止|不能|不是|非|是否|可能|或许|不确定)[[:space:]]*(是|为)?[[:space:]]*(速刷|日抛)|(速刷|日抛号?)[[:space:]]*(状态)?[[:space:]]*(不支持|不提供|不可用|不确定|未说明|未知|不保证))'), (E'access', E'dedicated', E'(独享|独立账号)', E'(非独享|不支持独享)'), (E'access', E'shared', E'(共享|合租)', E'(不共享|非共享|不支持共享)'), (E'delivery', E'account', E'(成品账号|成品号)', E'(非成品号)'), (E'delivery', E'top_up', E'(代充|代充值)', E'(非代充|不支持代充)'), (E'delivery', E'redemption', E'(兑换码|激活码|redemption code|redeem code)', E'(非兑换码|不支持兑换码)')) r(name, value, pattern, negative)
        where e.evidence_text ~* r.pattern and (r.negative = '' or e.evidence_text !~* r.negative)
      union all
      select e.product_id, 'warranty', w.parts[2] || ' ' || w.parts[3] from "eligible_skus" e
        cross join lateral regexp_matches(e.evidence_text, '(质保|售后保障)[[:space:]:：]*([0-9]{1,5})[[:space:]]*(天|日|days?|个月|月|months?|年|years?)', 'gi') w(parts)
      union all
      select e.product_id, 'warranty', w.parts[1] || ' ' || w.parts[2] from "eligible_skus" e
        cross join lateral regexp_matches(e.evidence_text, '([0-9]{1,5})[[:space:]]*(天|日|days?|个月|月|months?|年|years?)[[:space:]]*质保', 'gi') w(parts)
    ), tag_inputs as materialized (
      select distinct name, value from raw_tags
    ), expanded_input as materialized (
      select t.*, case when t.name = E'sms_verification' and t.value = E'verified' then E'[{"name":"sms_verification","value":"verified"}]'::jsonb when t.name = E'sms_verification' and t.value = E'unverified' then E'[{"name":"sms_verification","value":"unverified"}]'::jsonb when t.name = E'sms_verification' and t.value = E'已接码' then E'[{"name":"sms_verification","value":"verified"}]'::jsonb when t.name = E'sms_verification' and t.value = E'已接马' then E'[{"name":"sms_verification","value":"verified"}]'::jsonb when t.name = E'sms_verification' and t.value = E'已验证' then E'[{"name":"sms_verification","value":"verified"}]'::jsonb when t.name = E'sms_verification' and t.value = E'verified sms' then E'[{"name":"sms_verification","value":"verified"}]'::jsonb when t.name = E'sms_verification' and t.value = E'sms verified' then E'[{"name":"sms_verification","value":"verified"}]'::jsonb when t.name = E'sms_verification' and t.value = E'未接码' then E'[{"name":"sms_verification","value":"unverified"}]'::jsonb when t.name = E'sms_verification' and t.value = E'未接马' then E'[{"name":"sms_verification","value":"unverified"}]'::jsonb when t.name = E'sms_verification' and t.value = E'未验证' then E'[{"name":"sms_verification","value":"unverified"}]'::jsonb when t.name = E'sms_verification' and t.value = E'unverified sms' then E'[{"name":"sms_verification","value":"unverified"}]'::jsonb when t.name = E'sms_verification' and t.value = E'sms unverified' then E'[{"name":"sms_verification","value":"unverified"}]'::jsonb when t.name = E'warranty' and t.value = E'有质保' then E'[{"name":"warranty","value":"covered"}]'::jsonb when t.name = E'warranty' and t.value = E'有保修' then E'[{"name":"warranty","value":"covered"}]'::jsonb when t.name = E'warranty' and t.value = E'covered' then E'[{"name":"warranty","value":"covered"}]'::jsonb when t.name = E'warranty' and t.value = E'warranted' then E'[{"name":"warranty","value":"covered"}]'::jsonb when t.name = E'warranty' and t.value = E'保修' then E'[{"name":"warranty","value":"covered"}]'::jsonb when t.name = E'warranty' and t.value = E'warranty' then E'[{"name":"warranty","value":"covered"}]'::jsonb when t.name = E'warranty' and t.value = E'none' then E'[{"name":"warranty","value":"none"}]'::jsonb when t.name = E'warranty' and t.value = E'无保修' then E'[{"name":"warranty","value":"none"}]'::jsonb when t.name = E'warranty' and t.value = E'no warranty' then E'[{"name":"warranty","value":"none"}]'::jsonb when t.name = E'warranty' and t.value = E'without warranty' then E'[{"name":"warranty","value":"none"}]'::jsonb when t.name = E'warranty' and t.value = E'not warranted' then E'[{"name":"warranty","value":"none"}]'::jsonb when t.name = E'warranty' and t.value = E'unknown' then E'[{"name":"warranty","value":"unknown"}]'::jsonb when t.name = E'warranty' and t.value = E'warranty unspecified' then E'[{"name":"warranty","value":"unknown"}]'::jsonb when t.name = E'warranty' and t.value = E'first login' then E'[{"name":"warranty","value":"covered"},{"name":"warranty_scope","value":"first_login"}]'::jsonb when t.name = E'warranty' and t.value = E'first login only' then E'[{"name":"warranty","value":"covered"},{"name":"warranty_scope","value":"first_login"}]'::jsonb when t.name = E'warranty' and t.value = E'first-login warranty' then E'[{"name":"warranty","value":"covered"},{"name":"warranty_scope","value":"first_login"}]'::jsonb when t.name = E'warranty' and t.value = E'1 hour first login' then E'[{"name":"warranty","value":"covered"},{"name":"warranty_scope","value":"first_login"}]'::jsonb when t.name = E'warranty' and t.value = E'质保首登' then E'[{"name":"warranty","value":"covered"},{"name":"warranty_scope","value":"first_login"}]'::jsonb when t.name = E'warranty' and t.value = E'首登质保' then E'[{"name":"warranty","value":"covered"},{"name":"warranty_scope","value":"first_login"}]'::jsonb when t.name = E'warranty' and t.value = E'首登' then E'[{"name":"warranty","value":"covered"},{"name":"warranty_scope","value":"first_login"}]'::jsonb when t.name = E'warranty' and t.value = E'首登保障' then E'[{"name":"warranty","value":"covered"},{"name":"warranty_scope","value":"first_login"}]'::jsonb when t.name = E'warranty' and t.value = E'质保订阅' then E'[{"name":"warranty","value":"covered"},{"name":"warranty_scope","value":"period"},{"name":"warranty_detail","value":"质保订阅"}]'::jsonb when t.name = E'warranty' and t.value = E'1 month' then E'[{"name":"warranty","value":"covered"},{"name":"warranty_scope","value":"period"},{"name":"warranty_detail","value":"1 month"}]'::jsonb when t.name = E'warranty' and t.value = E'质保不来码' then E'[{"name":"warranty","value":"none"}]'::jsonb when t.name = E'warranty' and t.value = E'included' then E'[{"name":"warranty","value":"covered"}]'::jsonb when t.name = E'warranty' and t.value = E'subscription coverage' then E'[{"name":"warranty","value":"covered"},{"name":"warranty_scope","value":"period"}]'::jsonb when t.name = E'warranty' and t.value = E'无售后' then E'[{"name":"warranty","value":"none"}]'::jsonb when t.name = E'warranty' and t.value = E'无质保' then E'[{"name":"warranty","value":"none"}]'::jsonb when t.name = E'warranty' and t.value = E'不质保' then E'[{"name":"warranty","value":"none"}]'::jsonb when t.name = E'warranty' and t.value = E'质保未说明' then E'[{"name":"warranty","value":"unknown"}]'::jsonb when t.name = E'warranty_scope' and t.value = E'质保首登' then E'[{"name":"warranty_scope","value":"first_login"}]'::jsonb when t.name = E'warranty_scope' and t.value = E'first login' then E'[{"name":"warranty_scope","value":"first_login"}]'::jsonb when t.name = E'warranty_scope' and t.value = E'first login only' then E'[{"name":"warranty_scope","value":"first_login"}]'::jsonb when t.name = E'warranty_scope' and t.value = E'period' then E'[{"name":"warranty_scope","value":"period"}]'::jsonb when t.name = E'warranty_scope' and t.value = E'按天' then E'[{"name":"warranty_scope","value":"period"}]'::jsonb when t.name = E'intended_use' and t.value = E'速刷' then E'[{"name":"intended_use","value":"rapid"}]'::jsonb when t.name = E'intended_use' and t.value = E'rapid' then E'[{"name":"intended_use","value":"rapid"}]'::jsonb when t.name = E'intended_use' and t.value = E'rapid delivery' then E'[{"name":"intended_use","value":"rapid"}]'::jsonb when t.name = E'access' and t.value = E'独享' then E'[{"name":"access","value":"dedicated"}]'::jsonb when t.name = E'access' and t.value = E'dedicated' then E'[{"name":"access","value":"dedicated"}]'::jsonb when t.name = E'access' and t.value = E'private' then E'[{"name":"access","value":"dedicated"}]'::jsonb when t.name = E'access' and t.value = E'private access' then E'[{"name":"access","value":"dedicated"}]'::jsonb when t.name = E'access' and t.value = E'独立账号' then E'[{"name":"access","value":"dedicated"}]'::jsonb when t.name = E'access' and t.value = E'共享' then E'[{"name":"access","value":"shared"}]'::jsonb when t.name = E'access' and t.value = E'shared' then E'[{"name":"access","value":"shared"}]'::jsonb when t.name = E'delivery' and t.value = E'成品账号' then E'[{"name":"delivery","value":"account"}]'::jsonb when t.name = E'delivery' and t.value = E'account' then E'[{"name":"delivery","value":"account"}]'::jsonb when t.name = E'delivery' and t.value = E'ready account' then E'[{"name":"delivery","value":"account"}]'::jsonb when t.name = E'delivery' and t.value = E'account ready' then E'[{"name":"delivery","value":"account"}]'::jsonb when t.name = E'delivery' and t.value = E'代充' then E'[{"name":"delivery","value":"top_up"}]'::jsonb when t.name = E'delivery' and t.value = E'代充值' then E'[{"name":"delivery","value":"top_up"}]'::jsonb when t.name = E'delivery' and t.value = E'top_up' then E'[{"name":"delivery","value":"top_up"}]'::jsonb when t.name = E'delivery' and t.value = E'topup' then E'[{"name":"delivery","value":"top_up"}]'::jsonb when t.name = E'delivery' and t.value = E'top-up' then E'[{"name":"delivery","value":"top_up"}]'::jsonb when t.name = E'delivery' and t.value = E'兑换码' then E'[{"name":"delivery","value":"redemption"}]'::jsonb when t.name = E'delivery' and t.value = E'redemption' then E'[{"name":"delivery","value":"redemption"}]'::jsonb when t.name = E'delivery' and t.value = E'redemption code' then E'[{"name":"delivery","value":"redemption"}]'::jsonb when t.name = E'delivery' and t.value = E'redeem code' then E'[{"name":"delivery","value":"redemption"}]'::jsonb when t.name = E'duration' and t.value = E'1个月' then E'[{"name":"duration","value":"1 month"}]'::jsonb when t.name = E'duration' and t.value = E'1 month' then E'[{"name":"duration","value":"1 month"}]'::jsonb when t.name = E'duration' and t.value = E'monthly' then E'[{"name":"duration","value":"1 month"}]'::jsonb when t.name = E'duration' and t.value = E'月卡' then E'[{"name":"duration","value":"1 month"}]'::jsonb else null end as rule_tags from tag_inputs t
    ), expanded_values as materialized (
      select t.name as input_name, t.value as input_value, fact->>'name' as name, fact->>'value' as value
      from expanded_input t
      cross join lateral jsonb_array_elements(case
        when case when t.name = 'warranty_days' and t.value ~ '^[0-9]{1,5}$' then t.value::int when t.name = 'warranty' then case when substring(t.value from '^([0-9]{1,5})[[:space:]]*(天|日|days?|d)$') is not null then (substring(t.value from '^([0-9]{1,5})[[:space:]]*(天|日|days?|d)$'))::int end end between 1 and 36500 then jsonb_build_array(
          jsonb_build_object('name', 'warranty', 'value', 'covered'),
          jsonb_build_object('name', 'warranty_scope', 'value', 'period'),
          jsonb_build_object('name', 'warranty_days', 'value', (case when t.name = 'warranty_days' and t.value ~ '^[0-9]{1,5}$' then t.value::int when t.name = 'warranty' then case when substring(t.value from '^([0-9]{1,5})[[:space:]]*(天|日|days?|d)$') is not null then (substring(t.value from '^([0-9]{1,5})[[:space:]]*(天|日|days?|d)$'))::int end end)::text))
        when t.rule_tags is not null then t.rule_tags
        when t.name = 'warranty' and t.value ~ '^([0-9]{1,5})[[:space:]]*(个月|月|months?|年|years?|小时|hours?)$' then jsonb_build_array(jsonb_build_object('name', 'warranty', 'value', 'covered'), jsonb_build_object('name', 'warranty_scope', 'value', 'period'), jsonb_build_object('name', 'warranty_detail', 'value', t.value))
        when t.name in ('warranty', 'warranty_days') then jsonb_build_array(jsonb_build_object('name', 'warranty_detail', 'value', t.value))
        when t.name = 'duration' and t.value ~ '^([0-9]{1,5})[[:space:]]*(个月|月|months?)$' then jsonb_build_array(jsonb_build_object('name', 'duration', 'value', substring(t.value from '^([0-9]{1,5})') || case when substring(t.value from '^([0-9]{1,5})')::int = 1 then ' month' else ' months' end))
        when t.name = 'duration' and t.value ~ '^([0-9]{1,5})[[:space:]]*(天|日|days?)$' then jsonb_build_array(jsonb_build_object('name', 'duration', 'value', substring(t.value from '^([0-9]{1,5})') || ' days'))
        else jsonb_build_array(jsonb_build_object('name', t.name, 'value', t.value)) end) fact
    ), expanded_tags as materialized (
      select distinct t.product_id, v.name, v.value from raw_tags t
      join expanded_values v on v.input_name = t.name and v.input_value = t.value
    ), tag_conflicts as materialized (
      select product_id, name from expanded_tags
      where name in ('sms_verification', 'warranty', 'warranty_scope', 'warranty_days', 'access', 'delivery', 'duration') and value <> 'unknown'
      group by product_id, name having count(distinct value) > 1
    ), known_tag_values as materialized (
      select distinct product_id, name from expanded_tags where value <> 'unknown'
    ), no_warranty_products as materialized (
      select distinct product_id from expanded_tags where name = 'warranty' and value = 'none'
    ), safe_tags as materialized (
      select distinct t.product_id, t.name, t.value from expanded_tags t
      left join tag_conflicts c on c.product_id = t.product_id and (c.name = t.name
        or (c.name in ('warranty', 'warranty_scope', 'warranty_days') and t.name in ('warranty', 'warranty_scope', 'warranty_days')))
      left join known_tag_values known on known.product_id = t.product_id and known.name = t.name and t.value = 'unknown'
      left join no_warranty_products n on n.product_id = t.product_id
      where c.product_id is null
        and not (t.name in ('warranty_scope', 'warranty_days') and n.product_id is not null)
        and (t.value <> 'unknown' or known.product_id is null)
    ), complete_tags as (
      select product_id, name, value from safe_tags
      union all
      select e.product_id, d.name, 'unknown' from "eligible_skus" e
      cross join (values ('sms_verification'), ('warranty'), ('access'), ('delivery'), ('intended_use')) d(name)
      where not exists (select 1 from safe_tags t where t.product_id = e.product_id and t.name = d.name)
    ), sku_tag_sets as materialized (
      select product_id, jsonb_agg(jsonb_build_object('name', name, 'value', value) order by name, value) as tags,
        string_agg(value, ' ' order by name, value) as tag_text
      from complete_tags group by product_id
    )
      insert into catalog_product_facts (product_id, tags, tag_text)
        select product_id, tags, tag_text from sku_tag_sets order by product_id
      on conflict (product_id) do update set tags = excluded.tags, tag_text = excluded.tag_text;
    end
    $function$;`;

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`lock table products, product_tags in share row exclusive mode`.execute(database);
  await sql.raw(refreshFacts).execute(database);
  // Merge stored synonyms once. Source descriptions and decision history stay unchanged.
  await sql`
    with candidates as (
      select id, name as original_name, value as original_value,
        lower(normalize(btrim(name), NFKC)) as name, lower(normalize(btrim(value), NFKC)) as value
      from product_tags
    ), migrated as (
      delete from product_tags where id in (
      select id from candidates
      where (name in ('account_lifecycle', 'account_type', 'duration', 'subscription_duration', 'term', '订阅时长', '时长')
        and value in (
          'disposable', '日抛', '日抛号', 'daily_disposable', 'daily disposable', 'daily (日抛)', 'daily throw', 'daily throwaway'
        )) or (name in ('intended_use', 'use', 'usage', '适用场景', '用途')
          and value in ('日抛', '日抛号', '速刷', 'rapid delivery', 'rapid')
          and (original_name <> 'intended_use' or original_value <> 'rapid'))
      )
      returning product_id
    ), inserted as (
      insert into product_tags (product_id, name, value)
      select distinct product_id, 'intended_use', 'rapid' from migrated
      on conflict (product_id, name, value) do nothing
    )
    update products set standardization_revision = standardization_revision + 1
    where id in (select product_id from migrated)
  `.execute(database);
  await sql`select refresh_catalog_product_facts(array(select id from products order by id))`.execute(database);
  await sql`update catalog_cache_versions set version = version + 1, updated_at = now() where id = 1`.execute(database);
}

export async function down(): Promise<void> {
  throw new Error('Rapid synonym consolidation is not reversible; restore the pre-migration backup instead.');
}

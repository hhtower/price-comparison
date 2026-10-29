import { sql, type Kysely } from 'kysely';

// Freeze migration rules so later UI changes cannot change an existing upgrade or rollback.
const LEGACY_VALUES = {
  access: ['dedicated', 'shared'],
  delivery: ['account', 'top_up', 'redemption'],
  duration: ['1 month'],
  warranty: ['covered', 'none', 'unknown'],
  intended_use: ['rapid'],
  warranty_scope: ['first_login', 'period', 'unspecified'],
  sms_verification: ['verified', 'unverified', 'unknown'],
};

async function replaceProjection(database: Kysely<unknown>, values: Record<string, readonly string[]>): Promise<void> {
  await sql`lock table catalog_product_facts in share row exclusive mode`.execute(database);
  await sql`create or replace function catalog_readable_facets(tags jsonb)
    returns jsonb language sql immutable parallel safe set search_path to 'pg_catalog'
    as $function$
      select coalesce(jsonb_agg(jsonb_build_object('name', name, 'value', value) order by name, value), '[]'::jsonb)
      from jsonb_to_recordset(tags) t(name text, value text)
      where coalesce((${sql.lit(JSON.stringify(values))}::jsonb -> name) ? value, false)
        or (name = 'warranty_days' and value ~ '^[1-9][0-9]{0,4}$')
        or (name = 'duration' and value ~ '^[1-9][0-9]{0,3} (months?|days)$')
    $function$`.execute(database);
  // Replacing an immutable function alone does not refresh stored generated columns.
  await sql`update catalog_product_facts set tags = tags
    where facet_tags is distinct from catalog_readable_facets(tags)::text`.execute(database);
  await sql`update catalog_cache_versions set version = version + 1, updated_at = now() where id = 1`.execute(database);
}

export async function up(database: Kysely<unknown>): Promise<void> {
  await replaceProjection(database, {
    ...LEGACY_VALUES,
    delivery_mode: ['automatic', 'manual', 'self_service'],
    region: ['us', 'ph', 'jp', 'hk', 'tw', 'tr', 'ar', 'cl', 'in', 'global', 'random'],
    renewable: ['有', '无'],
    account_lifecycle: ['new', 'aged'],
    '2fa': ['有', '无'],
    sms_required: ['有', '无'],
    kyc: ['verified', 'unverified'],
    kyc_required: ['有', '无'],
  });
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await replaceProjection(database, LEGACY_VALUES);
}

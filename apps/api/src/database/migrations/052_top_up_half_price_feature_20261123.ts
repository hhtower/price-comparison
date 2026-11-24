import { sql, type Kysely } from 'kysely';
import { MEMBERSHIP_POLICY_VERSION } from '@price-comparison/catalog/membership-policy';
import { currentMembershipKind } from '../../standardization/membership-classification.js';

export async function up(database: Kysely<unknown>): Promise<void> {
  if (!database.isTransaction) return database.transaction().execute(up);
  await sql`lock table shops, products in share row exclusive mode`.execute(database);
  // The installed trigger embeds the allowed kinds; refresh it from the shared policy.
  const compiled = currentMembershipKind().compile(database);
  const kind = sql.raw(compiled.sql.replace(/\$(\d+)/gu, (_match, index: string) => {
    const value = compiled.parameters[Number(index) - 1];
    return (Array.isArray(value)
      ? sql`array[${sql.join(value.map(item => sql.lit(item)))}]::text[]`
      : sql.lit(value)).compile(database).sql;
  }));
  const policy = sql.lit(MEMBERSHIP_POLICY_VERSION);
  await sql`create or replace function catalog_membership_kinds_changed() returns trigger
    language plpgsql set search_path from current as $function$
    begin
      if tg_op = 'UPDATE' and
        (new.membership_features, new.content_version, new.content_fingerprint, new.standardization_revision, new.shop_id)
        is not distinct from
        (old.membership_features, old.content_version, old.content_fingerprint, old.standardization_revision, old.shop_id)
      then return null; end if;
      insert into catalog_membership_kinds (product_id, kind, policy_version)
        select id, kind, ${policy} from (
          select p.id, ${kind} as kind from products p join shops sh on sh.id = p.shop_id where p.id = new.id
        ) current_features where kind is not null
        on conflict (product_id) do update set kind = excluded.kind, policy_version = excluded.policy_version;
      if not found then delete from catalog_membership_kinds where product_id = new.id; end if;
      return null;
    end $function$`.execute(database);
  await sql`delete from catalog_membership_kinds mk where not exists (
    select 1 from products p join shops sh on sh.id = p.shop_id
    where p.id = mk.product_id and ${kind} is not null
  )`.execute(database);
  await sql`insert into catalog_membership_kinds (product_id, kind, policy_version)
    select id, kind, ${policy} from (
      select p.id, ${kind} as kind from products p join shops sh on sh.id = p.shop_id
      where p.membership_features is not null
    ) current_features where kind is not null
    on conflict (product_id) do update set kind = excluded.kind, policy_version = excluded.policy_version
    where (catalog_membership_kinds.kind, catalog_membership_kinds.policy_version)
      is distinct from (excluded.kind, excluded.policy_version)`.execute(database);
  await sql`update catalog_cache_versions set version = version + 1, updated_at = now() where id = 1`.execute(database);
}

export async function down(): Promise<void> {
  // Preserve reviewed snapshots; an older application must rebuild its own projection.
}

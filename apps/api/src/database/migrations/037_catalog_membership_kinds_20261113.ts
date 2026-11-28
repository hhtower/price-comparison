import { sql, type Kysely } from 'kysely';
import { membershipKind037 as kind, membershipPolicy as policy } from './snapshots/membership-policy.js';

export async function up<DB>(database: Kysely<DB>): Promise<void> {
  if (!database.isTransaction) return database.transaction().execute(up);
  await sql`lock table shops, products in share row exclusive mode`.execute(database);
  await sql`create table catalog_membership_kinds (
    product_id bigint primary key references products(id) on delete cascade,
    kind text not null,
    policy_version text not null
  )`.execute(database);
  await sql`create function catalog_membership_kinds_changed() returns trigger
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
  await sql`create trigger catalog_membership_kinds_changed
    after insert or update of membership_features, content_version, content_fingerprint, standardization_revision, shop_id
    on products for each row execute function catalog_membership_kinds_changed()`.execute(database);
  await sql`insert into catalog_membership_kinds (product_id, kind, policy_version)
    select id, kind, ${policy} from (
      select p.id, ${kind} as kind from products p join shops sh on sh.id = p.shop_id
      where p.membership_features is not null
    ) current_features where kind is not null`.execute(database);
  await sql`analyze catalog_membership_kinds`.execute(database);
}

export async function down<DB>(database: Kysely<DB>): Promise<void> {
  await sql`drop trigger catalog_membership_kinds_changed on products`.execute(database);
  await sql`drop function catalog_membership_kinds_changed()`.execute(database);
  await sql`drop table catalog_membership_kinds`.execute(database);
}

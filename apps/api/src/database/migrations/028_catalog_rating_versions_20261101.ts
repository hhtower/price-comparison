import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`alter table shops add column rating_revision bigint not null default 0`.execute(database);
  await sql`create function catalog_rating_shop_changed() returns trigger
    language plpgsql set search_path from current as $function$
    begin
      if (new.url, new.protocol, new.platform, new.shop_rating, new.rating_manifest)
        is distinct from (old.url, old.protocol, old.platform, old.shop_rating, old.rating_manifest) then
        new.rating_revision := old.rating_revision + 1;
      end if;
      return new;
    end $function$`.execute(database);
  await sql`create trigger catalog_rating_shop_update before update of url, protocol, platform, shop_rating, rating_manifest on shops
    for each row execute function catalog_rating_shop_changed()`.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`drop trigger catalog_rating_shop_update on shops`.execute(database);
  await sql`drop function catalog_rating_shop_changed()`.execute(database);
  await sql`alter table shops drop column rating_revision`.execute(database);
}

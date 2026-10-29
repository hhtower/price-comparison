import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await database.schema.alterTable('shops').addColumn('shop_rating', 'jsonb').execute();
  await sql`create function clear_changed_shop_rating() returns trigger language plpgsql as $$
    begin
      if new.url is distinct from old.url or new.protocol is distinct from old.protocol or new.platform is distinct from old.platform then
        new.shop_rating := null;
      end if;
      return new;
    end $$`.execute(database);
  await sql`create trigger shops_clear_changed_rating before update of url, protocol, platform on shops
    for each row execute function clear_changed_shop_rating()`.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`drop trigger shops_clear_changed_rating on shops`.execute(database);
  await sql`drop function clear_changed_shop_rating()`.execute(database);
  await database.schema.alterTable('shops').dropColumn('shop_rating').execute();
}

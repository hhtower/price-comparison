import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await database.schema.alterTable('shops').addColumn('rating_manifest', 'jsonb').execute();
  await database.schema.alterTable('products').addColumn('text_review', 'jsonb').execute();
  await sql`create or replace function clear_changed_shop_rating() returns trigger language plpgsql as $$
    begin
      if new.url is distinct from old.url or new.protocol is distinct from old.protocol or new.platform is distinct from old.platform then
        new.shop_rating := null;
        new.rating_manifest := null;
      end if;
      return new;
    end $$`.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`create or replace function clear_changed_shop_rating() returns trigger language plpgsql as $$
    begin
      if new.url is distinct from old.url or new.protocol is distinct from old.protocol or new.platform is distinct from old.platform then
        new.shop_rating := null;
      end if;
      return new;
    end $$`.execute(database);
  await database.schema.alterTable('products').dropColumn('text_review').execute();
  await database.schema.alterTable('shops').dropColumn('rating_manifest').execute();
}

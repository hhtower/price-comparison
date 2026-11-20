import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`create index shops_catalog_visible on shops (id)
    where enabled = true and deleted_at is null`.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`drop index shops_catalog_visible`.execute(database);
}

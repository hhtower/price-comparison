import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`alter table standard_products add column catalog_definition text
    check (catalog_definition is null or (length(btrim(catalog_definition)) > 0 and length(catalog_definition) <= 10000))`.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`alter table standard_products drop column catalog_definition`.execute(database);
}

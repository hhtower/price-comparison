import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`alter table products add column deletion_source text`.execute(database);
  await sql`alter table products add constraint products_deletion_source_check
    check (deletion_source is null or deletion_source = any(array['manual', 'linked', 'crawler_missing', 'legacy']))`.execute(database);
  await sql`update products set deletion_source = 'legacy' where deleted_at is not null`.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`alter table products drop constraint products_deletion_source_check`.execute(database);
  await sql`alter table products drop column deletion_source`.execute(database);
}

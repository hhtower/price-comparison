import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`alter table fetch_runs add column settlement_report jsonb`.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`alter table fetch_runs drop column settlement_report`.execute(database);
}

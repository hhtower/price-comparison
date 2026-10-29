import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`create index fetch_runs_history_time on fetch_runs (started_at desc, id desc)`.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`drop index fetch_runs_history_time`.execute(database);
}

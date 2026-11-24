import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  // Archiving deletes old product_change_events / ai_jobs in bulk; these FKs are
  // ON DELETE SET NULL and probe their table per deleted parent row, so without
  // an index each probe scans the whole table and the delete hits statement timeout.
  await sql`create index if not exists ai_standardization_executions_event on ai_standardization_executions (event_id)
    where event_id is not null`.execute(database);
  await sql`create index if not exists ai_job_input_members_retry_source on ai_job_input_members (retry_source_job_id)
    where retry_source_job_id is not null`.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists ai_job_input_members_retry_source`.execute(database);
  await sql`drop index if exists ai_standardization_executions_event`.execute(database);
}

import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  // Deleting old fetch_runs rows probes the source_fetch_run_id self-FK per row;
  // without an index each probe scans the whole multi-GB table.
  await sql`create index if not exists fetch_runs_source_run_ref on fetch_runs (source_fetch_run_id)
    where source_fetch_run_id is not null`.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists fetch_runs_source_run_ref`.execute(database);
}

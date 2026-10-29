import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`alter table fetch_runs
    add column task_type text not null default 'list' check (task_type in ('list', 'settlement')),
    add column settlement_payload jsonb,
    add column source_fetch_run_id bigint references fetch_runs(id),
    add column crawl_metrics jsonb`.execute(database);
  await sql`create unique index fetch_runs_settlement_source on fetch_runs (source_fetch_run_id)
    where task_type = 'settlement'`.execute(database);
  await sql`create index fetch_runs_finished_metrics on fetch_runs (finished_at) where crawl_metrics is not null`.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`drop index fetch_runs_finished_metrics`.execute(database);
  await sql`drop index fetch_runs_settlement_source`.execute(database);
  await sql`alter table fetch_runs drop column crawl_metrics, drop column source_fetch_run_id,
    drop column settlement_payload, drop column task_type`.execute(database);
}

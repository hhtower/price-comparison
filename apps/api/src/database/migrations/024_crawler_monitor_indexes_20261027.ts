import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`create index fetch_runs_recent_outcomes on fetch_runs (finished_at)
    include (status, task_type) where status in ('succeeded', 'failed')`.execute(database);
  await sql`create index fetch_runs_latest_list_metrics on fetch_runs (shop_id, finished_at desc nulls last, id desc)
    where task_type = 'list' and status = 'succeeded' and crawl_metrics is not null`.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`drop index fetch_runs_latest_list_metrics`.execute(database);
  await sql`drop index fetch_runs_recent_outcomes`.execute(database);
}

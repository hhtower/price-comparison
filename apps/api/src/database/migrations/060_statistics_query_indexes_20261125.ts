import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`create index ai_batches_uncertain_requests on ai_job_batches (job_id, id desc)
    where step = 'request' and (unknown_requests > 0
      or request_budget_used > confirmed_requests + unknown_requests)`.execute(database);
  await sql`create index ai_jobs_unfinished on ai_jobs (id desc)
    where status in ('queued', 'running', 'paused', 'ready')`.execute(database);
  await sql`create index ai_jobs_type_history on ai_jobs (job_type, id desc)`.execute(database);
  await sql`analyze analytics_excluded_ips`.execute(database);
  await sql`analyze ai_jobs`.execute(database);
  await sql`analyze ai_job_batches`.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`drop index ai_jobs_type_history`.execute(database);
  await sql`drop index ai_jobs_unfinished`.execute(database);
  await sql`drop index ai_batches_uncertain_requests`.execute(database);
}

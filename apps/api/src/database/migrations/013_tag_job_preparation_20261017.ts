import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table ai_job_batches drop constraint ai_job_batches_step_check,
    add constraint ai_job_batches_step_check check (step in ('prepare','request','publish','done'))`.execute(db);
  await sql`create table ai_tag_job_requests (
    request_id uuid primary key,
    job_id bigint not null references ai_jobs(id) on delete cascade
  )`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table ai_tag_job_requests`.execute(db);
  await sql`alter table ai_job_batches drop constraint ai_job_batches_step_check,
    add constraint ai_job_batches_step_check check (step in ('request','publish','done'))`.execute(db);
}

import { sql, type Kysely } from 'kysely';

async function lockJobs(database: Kysely<unknown>): Promise<void> {
  await sql`do $locks$
    begin
      for attempt in 1..40 loop
        begin
          lock table ai_jobs in access exclusive mode nowait;
          return;
        exception when lock_not_available then
          if attempt = 40 then
            raise exception 'Tag workflow migration could not acquire ai_jobs lock'
              using errcode = '55P03', hint = 'Pause application writers and workers, then retry the migration.';
          end if;
        end;
        perform pg_sleep(0.25);
      end loop;
    end
  $locks$`.execute(database);
}

export async function up(database: Kysely<unknown>): Promise<void> {
  if (!database.isTransaction) return database.transaction().execute(up);
  await lockJobs(database);
  await sql`alter table ai_jobs drop constraint ai_jobs_job_type_check`.execute(database);
  await sql`alter table ai_jobs add constraint ai_jobs_job_type_check check
    (job_type in ('incremental', 'calibration', 'manual_full', 'tag_extraction', 'membership_features', 'text_review'))`.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  if (!database.isTransaction) return database.transaction().execute(down);
  await lockJobs(database);
  await sql`do $rollback$
    begin
      if exists (select 1 from ai_jobs where job_type = 'text_review') then
        raise exception 'Cannot roll back tag workflow while text review jobs exist'
          using errcode = '23514', hint = 'Keep this migration applied to preserve text review job history.';
      end if;
    end
  $rollback$`.execute(database);
  await sql`alter table ai_jobs drop constraint ai_jobs_job_type_check`.execute(database);
  await sql`alter table ai_jobs add constraint ai_jobs_job_type_check check
    (job_type in ('incremental', 'calibration', 'manual_full', 'tag_extraction', 'membership_features'))`.execute(database);
}

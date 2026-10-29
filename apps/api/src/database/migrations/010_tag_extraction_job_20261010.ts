import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  // Drop the check constraint only if it exists (it may not exist on all environments).
  await sql`ALTER TABLE ai_jobs DROP CONSTRAINT IF EXISTS ai_jobs_job_type_check`.execute(database);
  await sql`ALTER TABLE ai_jobs ADD CONSTRAINT ai_jobs_job_type_check
    CHECK (job_type = ANY (ARRAY['incremental'::text, 'calibration'::text, 'manual_full'::text, 'tag_extraction'::text]))`.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE ai_jobs DROP CONSTRAINT IF EXISTS ai_jobs_job_type_check`.execute(database);
  await sql`ALTER TABLE ai_jobs ADD CONSTRAINT ai_jobs_job_type_check
    CHECK (job_type = ANY (ARRAY['incremental'::text, 'calibration'::text, 'manual_full'::text]))`.execute(database);
}

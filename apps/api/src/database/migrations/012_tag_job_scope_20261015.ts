import { sql, type Kysely } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
 await sql`alter table ai_jobs add column parent_identity_job_id bigint references ai_jobs(id), add column requested_scope jsonb not null default '{}'::jsonb`.execute(db);
 await sql`create index ai_jobs_parent_identity on ai_jobs(parent_identity_job_id) where parent_identity_job_id is not null`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
 await sql`alter table ai_jobs drop column requested_scope, drop column parent_identity_job_id`.execute(db);
}

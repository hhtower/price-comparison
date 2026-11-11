import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`drop index ai_membership_feature_parent`.execute(database);
  await sql`create index ai_membership_feature_parent on ai_jobs(parent_identity_job_id)
    where job_type = 'membership_features' and parent_identity_job_id is not null`.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`drop index ai_membership_feature_parent`.execute(database);
  await sql`create unique index ai_membership_feature_parent on ai_jobs(parent_identity_job_id)
    where job_type = 'membership_features' and parent_identity_job_id is not null and retry_of_job_id is null`.execute(database);
}

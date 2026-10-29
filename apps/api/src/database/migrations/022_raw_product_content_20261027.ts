import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await database.schema.alterTable('products')
    .addColumn('source_name', 'text', column => column.notNull().defaultTo(''))
    .addColumn('source_description', 'text', column => column.notNull().defaultTo(''))
    .execute();
  // Same source title/body can legitimately produce distinct SKU inputs in one job.
  await database.schema.dropIndex('ai_job_inputs_content_without_review').execute();
  await database.schema.dropIndex('ai_job_inputs_content_with_review').execute();
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`create unique index ai_job_inputs_content_without_review on ai_job_inputs (job_id, fingerprint)
    where manual_decision_id is null`.execute(database);
  await sql`create unique index ai_job_inputs_content_with_review on ai_job_inputs (job_id, fingerprint, manual_decision_id)
    where manual_decision_id is not null`.execute(database);
  await database.schema.alterTable('products')
    .dropColumn('source_name').dropColumn('source_description').execute();
}

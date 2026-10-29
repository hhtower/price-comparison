import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`alter table ai_job_batches add column response_diagnostic jsonb,
    add constraint ai_batch_response_diagnostic_bounded check (
      response_diagnostic is null or (jsonb_typeof(response_diagnostic) = 'object'
        and octet_length(response_diagnostic::text) <= 16384))`.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`alter table ai_job_batches drop column response_diagnostic`.execute(database);
}

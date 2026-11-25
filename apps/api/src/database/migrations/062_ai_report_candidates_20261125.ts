import { sql, type Kysely } from 'kysely';

const fields = 'job_type, status, prompt_version, rule_version, pipeline_versions';
const qualified = (alias: string) => fields.split(', ').map(field => `${alias}.${field}`).join(', ');
const identity = (alias?: string) => `sha256(convert_to(jsonb_build_array(${alias ? qualified(alias) : fields})::text, 'UTF8'))`;

export async function up(database: Kysely<unknown>): Promise<void> {
  if (!database.isTransaction) return database.transaction().execute(up);
  await sql`lock table ai_jobs in share row exclusive mode`.execute(database);
  await sql`create table ai_job_report_profiles (
    identity_hash bytea primary key,
    job_type text not null, status text not null, prompt_version text not null, rule_version text not null,
    pipeline_versions jsonb not null
  )`.execute(database);
  await sql`create table ai_job_report_rows (
    job_id bigint primary key, identity_hash bytea not null references ai_job_report_profiles(identity_hash)
  )`.execute(database);
  await sql`create index ai_job_report_rows_profile on ai_job_report_rows (identity_hash, job_id)`.execute(database);
  // JSONB-equal numbers may retain different text (1 vs 1.0); keep their hash keys separate.
  await sql.raw(`insert into ai_job_report_profiles (identity_hash, ${fields})
    select ${identity()}, ${fields} from ai_jobs group by ${identity()}, ${fields}`).execute(database);
  await sql.raw(`insert into ai_job_report_rows select id, ${identity()} from ai_jobs`).execute(database);
  await sql`alter table ai_job_report_rows add constraint ai_job_report_rows_job
    foreign key (job_id) references ai_jobs(id) on update cascade on delete cascade`.execute(database);
  await sql.raw(`create function sync_ai_job_reports() returns trigger
    language plpgsql set search_path from current as $function$
    begin
      insert into ai_job_report_profiles (identity_hash, ${fields})
        select distinct on (identity_hash) identity_hash, ${fields}
        from (select ${identity()} as identity_hash, ${fields} from new_rows) profiles
        order by identity_hash on conflict (identity_hash) do nothing;
      if exists (select 1 from new_rows n join ai_job_report_profiles p on p.identity_hash=${identity('n')}
        where (${qualified('p')}) is distinct from (${qualified('n')}))
      then raise exception 'Task report identity collision'; end if;
      -- Per-job rows avoid a shared counter lock across unrelated job transactions.
      insert into ai_job_report_rows (job_id, identity_hash)
        select id, ${identity()} from new_rows order by id
        on conflict (job_id) do update set identity_hash=excluded.identity_hash
        where ai_job_report_rows.identity_hash is distinct from excluded.identity_hash;
      return null;
    end
    $function$`).execute(database);
  for (const event of ['insert', 'update']) {
    await sql.raw(`create trigger ai_job_reports_${event} after ${event} on ai_jobs
      referencing new table as new_rows for each statement execute function sync_ai_job_reports()`).execute(database);
  }
  await sql`create index ai_jobs_shop_history on ai_jobs (scope_shop_id, id)
    where scope_shop_id is not null`.execute(database);
  await sql`create index ai_jobs_identity_history on ai_jobs (prompt_version, rule_version, id desc)
    where job_type not in ('tag_extraction','membership_features','text_review')`.execute(database);
  await sql`create index ai_jobs_latest_identity on ai_jobs (id desc)
    where job_type not in ('tag_extraction','membership_features','text_review')`.execute(database);
  await sql`create index products_report_candidates on products (id)
    include (shop_id, content_version, standardization_revision, content_fingerprint)
    where deleted_at is null and not standardization_locked`.execute(database);
  await sql`create index product_decisions_report_latest on product_standardization_decisions (product_id, id desc)
    include (evidence_known, content_version, content_fingerprint)`.execute(database);
  // An indexed scalar also gives the planner statistics for the otherwise poorly estimated JSON OR.
  await sql`create index ai_members_report_attention on ai_job_input_members
    ((case when status in ('queued','processing') or output->>'outcome' in ('review','partial_success','failed')
      or coalesce(output->>'reasonCode',reason_code) = 'request_outcome_unknown'
      or coalesce(output->'rejectedTags','[]'::jsonb) <> '[]'::jsonb then 1 else 0 end), job_id, product_id)
    include (input_id, content_version, standardization_revision, fingerprint)`.execute(database);
  await sql`analyze ai_job_report_profiles`.execute(database);
  await sql`analyze ai_job_report_rows`.execute(database);
  await sql`analyze ai_job_input_members`.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  if (!database.isTransaction) return database.transaction().execute(down);
  await sql`lock table ai_jobs in share row exclusive mode`.execute(database);
  await sql`drop index ai_members_report_attention`.execute(database);
  await sql`drop index ai_jobs_shop_history`.execute(database);
  await sql`drop index ai_jobs_identity_history`.execute(database);
  await sql`drop index ai_jobs_latest_identity`.execute(database);
  await sql`drop index product_decisions_report_latest`.execute(database);
  await sql`drop index products_report_candidates`.execute(database);
  for (const event of ['insert', 'update']) {
    await sql.raw(`drop trigger ai_job_reports_${event} on ai_jobs`).execute(database);
  }
  await sql`drop function sync_ai_job_reports()`.execute(database);
  await sql`drop table ai_job_report_rows`.execute(database);
  await sql`drop table ai_job_report_profiles`.execute(database);
}

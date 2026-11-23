import { sql, type Kysely } from 'kysely';

async function lockDrainedWorkers(database: Kysely<unknown>): Promise<void> {
  await sql`do $migration$
    begin
      begin
        lock table ai_jobs in exclusive mode nowait;
        lock table ai_job_batches in exclusive mode nowait;
      exception when lock_not_available then
        raise exception 'Review stage migration requires exclusive access to AI job writers'
          using errcode = '55P03', hint = 'Pause and drain AI workers before retrying the migration.';
      end;
      -- A worker may hold a live request between database transactions.
      if exists (
        select 1 from ai_job_batches where status = 'running' and lease_until > clock_timestamp()
      ) then
        raise exception 'Review stage migration refused: an AI batch still has an effective running lease'
          using errcode = '55P03', hint = 'Pause and drain AI workers before retrying the migration.';
      end if;
    end
  $migration$`.execute(database);
}

export async function up(database: Kysely<unknown>): Promise<void> {
  if (!database.isTransaction) return database.transaction().execute(up);
  await lockDrainedWorkers(database);
  await sql`with converted as (
    select b.id,
      (b.reference_snapshot - array['tagStage', 'standardizationStage', 'extractionBatchId', 'generationBatchId'])
      || jsonb_build_object('reviewStage', coalesce(b.reference_snapshot->'reviewStage', to_jsonb(
        case
          when j.job_type in ('tag_extraction', 'membership_features', 'text_review') then
            case b.reference_snapshot->>'tagStage'
              when 'review' then 'review'
              when 'repair' then 'repair'
              when 'warranty' then 'warranty'
              else 'generate'
            end
          when b.reference_snapshot->>'standardizationStage' = 'review' then 'review'
          when b.reference_snapshot ? 'repairReviewBatchId' then 'repair'
          else 'generate'
        end
      )))
      || case
        when b.reference_snapshot ? 'proposalBatchId' then '{}'::jsonb
        when j.job_type in ('tag_extraction', 'membership_features', 'text_review')
          and b.reference_snapshot ? 'extractionBatchId'
          then jsonb_build_object('proposalBatchId', b.reference_snapshot->'extractionBatchId')
        when j.job_type in ('incremental', 'manual_full', 'calibration')
          and b.reference_snapshot ? 'generationBatchId'
          then jsonb_build_object('proposalBatchId', b.reference_snapshot->'generationBatchId')
        else '{}'::jsonb
      end as snapshot
    from ai_job_batches b join ai_jobs j on j.id = b.job_id
    where jsonb_typeof(b.reference_snapshot) = 'object'
  )
  update ai_job_batches b set reference_snapshot = c.snapshot
  from converted c where b.id = c.id and b.reference_snapshot is distinct from c.snapshot`.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  if (!database.isTransaction) return database.transaction().execute(down);
  await lockDrainedWorkers(database);
  await sql`with converted as (
    select b.id,
      (b.reference_snapshot - array['reviewStage', 'proposalBatchId'])
      || case
        when b.reference_snapshot ? 'reviewStage'
          and j.job_type in ('tag_extraction', 'membership_features', 'text_review')
          then jsonb_build_object('tagStage', case b.reference_snapshot->>'reviewStage'
            when 'generate' then 'extract' else b.reference_snapshot->>'reviewStage' end)
        when j.job_type in ('incremental', 'manual_full', 'calibration')
          and b.reference_snapshot->>'reviewStage' = 'review'
          then jsonb_build_object('standardizationStage', 'review')
        else '{}'::jsonb
      end
      || case
        when not (b.reference_snapshot ? 'proposalBatchId') then '{}'::jsonb
        when j.job_type in ('tag_extraction', 'membership_features', 'text_review')
          then jsonb_build_object('extractionBatchId', b.reference_snapshot->'proposalBatchId')
        else jsonb_build_object('generationBatchId', b.reference_snapshot->'proposalBatchId')
      end as snapshot
    from ai_job_batches b join ai_jobs j on j.id = b.job_id
    where b.reference_snapshot ?| array['reviewStage', 'proposalBatchId']
  )
  update ai_job_batches b set reference_snapshot = c.snapshot
  from converted c where b.id = c.id and b.reference_snapshot is distinct from c.snapshot`.execute(database);
}

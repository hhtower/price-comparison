import { sql, type Kysely, type Transaction } from 'kysely';
import type { DatabaseSchema } from '../database/types.js';

export interface ProgressSnapshot {
  jobId: string; version: string; phase: string; status: string;
  total: string; queued: string; running: string; processed: string; succeeded: string; failed: string;
  rawProductCount: number; uniqueInputCount: number;
  requests: { totalBatches: number; queuedBatches: number; runningBatches: number; succeededBatches: number; failedBatches: number; cancelledBatches: number; confirmed: number; unknown: number; budgetUsed: number; budgetLimit: number };
  publication: { totalUnits: number; queuedUnits: number; runningUnits: number; succeededUnits: number; blockedUnits: number; failedUnits: number; cancelledUnits: number; publishedMembers: number; pendingMembers: number };
  results: { classified: number; unclassified: number; unclassifiedReasons: Record<string, number>; standardProducts: number };
  missing: { scheduledInputs: number; reprocessedInputs: number };
  tagResults?: Record<string, number>;
  tagAcceptance?: { acceptedTags: number; rejectedTags: number; partialProducts: number };
  tagStages?: { extractionCompleted: number; reviewQueued: number; reviewRunning: number; reviewCompleted: number; publicationQueued: number };
  standardizationStages?: { generationCompleted: number; reviewQueued: number; reviewRunning: number; reviewCompleted: number; publicationQueued: number };
  updatedAt: string;
}

export interface ProgressDeltas { jobId: bigint; queued?: number; running?: number; processed?: number; succeeded?: number; failed?: number }

export function extractionProgressDelta(transition: 'initialize' | 'cached' | 'oversized' | 'claimed' | 'succeeded' | 'retry' | 'failed', productCount: number): Omit<ProgressDeltas, 'jobId'> {
  switch (transition) {
    case 'initialize': return { queued: productCount };
    case 'cached': return { queued: -productCount, processed: productCount, succeeded: productCount };
    case 'oversized': return { queued: -productCount, failed: productCount };
    case 'claimed': return { queued: -productCount, running: productCount };
    case 'succeeded': return { running: -productCount, processed: productCount, succeeded: productCount };
    case 'retry': return { running: -productCount, queued: productCount, failed: -productCount };
    case 'failed': return { running: -productCount, failed: productCount };
  }
}

type ProgressDb = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;

export async function incrementJobProgress(tx: ProgressDb, input: ProgressDeltas): Promise<ProgressSnapshot> {
  await sql`
    insert into ai_job_progress (job_id,total,queued,running,processed,succeeded,failed,version,updated_at)
    values (${input.jobId}, coalesce((select total from ai_jobs where id = ${input.jobId}), 0), ${BigInt(input.queued ?? 0)},
      ${BigInt(input.running ?? 0)}, ${BigInt(input.processed ?? 0)}, ${BigInt(input.succeeded ?? 0)}, ${BigInt(input.failed ?? 0)}, 1, clock_timestamp())
    on conflict (job_id) do update set
      queued = greatest(0, ai_job_progress.queued + excluded.queued), running = greatest(0, ai_job_progress.running + excluded.running),
      processed = greatest(0, ai_job_progress.processed + excluded.processed), succeeded = greatest(0, ai_job_progress.succeeded + excluded.succeeded),
      failed = greatest(0, ai_job_progress.failed + excluded.failed), version = ai_job_progress.version + 1, updated_at = clock_timestamp()
  `.execute(tx);
  await sql`select pg_notify('ai_job_progress_changed', ${input.jobId.toString()})`.execute(tx);
  return readProgress(tx, input.jobId);
}

export async function getJobProgress(db: ProgressDb, jobId: bigint, since?: bigint): Promise<ProgressSnapshot | null> {
  const row = await sql<Record<string, unknown>>`
    select j.job_type, members.*, p.job_id,p.version,j.phase,j.status,p.total,p.queued,p.running,p.processed,p.succeeded,p.failed,p.updated_at,
      inputs.unique_input_count,inputs.scheduled_missing,inputs.reprocessed_missing,
      batches.batch_total,batches.batch_queued,batches.batch_running,batches.batch_succeeded,batches.batch_failed,batches.batch_cancelled,
      batches.confirmed_requests,batches.unknown_requests,batches.request_budget_used,batches.request_budget_limit,
      batches.extraction_completed,batches.review_queued,batches.review_running,batches.review_completed,batches.publication_queued,
      publication.unit_total,publication.unit_queued,publication.unit_running,publication.unit_succeeded,
      publication.unit_blocked,publication.unit_failed,publication.unit_cancelled,publication.published_members,publication.pending_members,
      results.classified,results.unclassified,results.reason_counts,results.standard_products
    from ai_job_progress p join ai_jobs j on j.id=p.job_id
    left join lateral (
      select count(*)::int member_total,
        count(*) filter(where status='queued')::int member_queued,
        count(*) filter(where status='processing')::int member_running,
        coalesce(sum(jsonb_array_length(coalesce(output->'acceptedTags','[]'::jsonb)))
          filter(where j.job_type='tag_extraction' and status not in ('queued','processing')),0)::int tag_accepted,
        coalesce(sum(jsonb_array_length(coalesce(output->'rejectedTags','[]'::jsonb)))
          filter(where j.job_type='tag_extraction' and status not in ('queued','processing')),0)::int tag_rejected,
        count(*) filter(where j.job_type='tag_extraction' and status not in ('queued','processing')
          and output->>'outcome' in ('updated','review')
          and jsonb_array_length(coalesce(output->'acceptedTags','[]'::jsonb))>0
          and jsonb_array_length(coalesce(output->'rejectedTags','[]'::jsonb))>0)::int tag_partial,
        (select coalesce(jsonb_object_agg(outcome,n),'{}'::jsonb) from (
          select case when output->>'outcome' in ('updated','unchanged','empty','review','skipped','failed','cancelled') then output->>'outcome' else 'unrecorded' end outcome,count(*)::int n
          from ai_job_input_members where job_id=j.id and status not in ('queued','processing') group by 1
        ) outcomes) tag_counts
      from ai_job_input_members where job_id=j.id
    ) members on true
    left join lateral (
      select count(*)::int unique_input_count, count(*) filter (where round=1)::int scheduled_missing,
        count(*) filter (where missing_reprocess_count=1)::int reprocessed_missing from ai_job_inputs where job_id=j.id
    ) inputs on true
    left join lateral (
      select count(*)::int batch_total, count(*) filter (where status='queued')::int batch_queued,
        count(*) filter (where status='running')::int batch_running, count(*) filter (where status='succeeded')::int batch_succeeded,
        count(*) filter (where status='failed')::int batch_failed, count(*) filter (where status='cancelled')::int batch_cancelled,
        count(*) filter (where status='succeeded' and step='done' and stage is distinct from 'review')::int extraction_completed,
        count(*) filter (where status='queued' and step='request' and stage='review')::int review_queued,
        count(*) filter (where status='running' and step='request' and stage='review')::int review_running,
        count(*) filter (where status='succeeded' and stage='review')::int review_completed,
        count(*) filter (where status='queued' and step='publish' and stage='review')::int publication_queued,
        coalesce(sum(confirmed_requests),0)::int confirmed_requests, coalesce(sum(unknown_requests),0)::int unknown_requests,
        coalesce(sum(request_budget_used),0)::int request_budget_used, coalesce(sum(request_budget_limit),0)::int request_budget_limit
      from ai_job_batches
      cross join lateral (select reference_snapshot->>(case when j.job_type='tag_extraction' then 'tagStage' else 'standardizationStage' end) as stage) stage_marker
      where job_id=j.id and batch_index >= 0
    ) batches on true
    left join lateral (
      select count(*)::int unit_total, count(*) filter (where u.status='queued')::int unit_queued,
        count(*) filter (where u.status='running')::int unit_running, count(*) filter (where u.status='succeeded')::int unit_succeeded,
        count(*) filter (where u.status='blocked')::int unit_blocked, count(*) filter (where u.status='failed')::int unit_failed,
        count(*) filter (where u.status='cancelled')::int unit_cancelled,
        coalesce(sum(u.member_count) filter (where u.status='succeeded'),0)::int published_members,
        coalesce(sum(u.member_count) filter (where u.status not in ('succeeded','cancelled')),0)::int pending_members
      from ai_publication_units u join ai_job_batches b on b.id=u.batch_id where b.job_id=j.id
    ) publication on true
    left join lateral (
      select coalesce(sum(reason_count) filter (where status='classified'),0)::int classified,
        coalesce(sum(reason_count) filter (where status='unclassified'),0)::int unclassified,
        count(distinct standard_product_id) filter (where status='classified')::int standard_products,
        coalesce(jsonb_object_agg(reason_code, reason_count) filter (where reason_code is not null), '{}'::jsonb) reason_counts
      from (select status,standard_product_id,reason_code,count(*)::int reason_count from ai_standardization_results where job_id=j.id group by status,standard_product_id,reason_code) grouped
    ) results on true
    where p.job_id=${jobId} ${since === undefined ? sql`` : sql`and p.version > ${since}`} limit 1
  `.execute(db);
  return row.rows[0] ? progressSnapshotFromRow(row.rows[0]) : null;
}

async function readProgress(db: ProgressDb, jobId: bigint): Promise<ProgressSnapshot> {
  const result = await getJobProgress(db, jobId);
  if (!result) throw new Error('AI job progress row missing');
  return result;
}

export function progressSnapshotFromRow(row: Record<string, unknown>): ProgressSnapshot {
  const str = (value: unknown) => typeof value === 'bigint' ? value.toString() : String(value ?? 0);
  const num = (value: unknown) => Number(value ?? 0);
  const reasons = row.reason_counts && typeof row.reason_counts === 'object' && !Array.isArray(row.reason_counts)
    ? Object.fromEntries(Object.entries(row.reason_counts as Record<string, unknown>).map(([key, value]) => [key, num(value)])) : {};
  const tag = row.job_type === 'tag_extraction';
  const tagResults = Object.fromEntries(['updated','unchanged','empty','review','skipped','failed','cancelled','unrecorded'].map(key => [key, num((row.tag_counts as Record<string, unknown> | undefined)?.[key])]));
  const terminal = Object.values(tagResults).reduce((a,b)=>a+b,0);
  return {
    ...(tag ? { tagResults, tagAcceptance: { acceptedTags: num(row.tag_accepted), rejectedTags: num(row.tag_rejected), partialProducts: num(row.tag_partial) } } : {}),
    ...(tag ? { tagStages: { extractionCompleted: num(row.extraction_completed), reviewQueued: num(row.review_queued), reviewRunning: num(row.review_running), reviewCompleted: num(row.review_completed), publicationQueued: num(row.publication_queued) } } : {}),
    ...(!tag ? { standardizationStages: { generationCompleted: num(row.extraction_completed), reviewQueued: num(row.review_queued), reviewRunning: num(row.review_running), reviewCompleted: num(row.review_completed), publicationQueued: num(row.publication_queued) } } : {}),
    jobId: str(row.job_id), version: str(row.version), phase: String(row.phase ?? 'standardizing'), status: String(row.status),
    total: str(tag ? row.member_total : row.total), queued: str(tag ? row.member_queued : row.queued), running: str(tag ? row.member_running : row.running), processed: str(tag ? terminal : row.processed), succeeded: str(tag ? terminal - tagResults.failed! - tagResults.cancelled! - tagResults.unrecorded! : row.succeeded), failed: str(tag ? tagResults.failed : row.failed),
    rawProductCount: num(tag ? row.member_total : row.total), uniqueInputCount: num(row.unique_input_count),
    requests: { totalBatches: num(row.batch_total), queuedBatches: num(row.batch_queued), runningBatches: num(row.batch_running), succeededBatches: num(row.batch_succeeded), failedBatches: num(row.batch_failed), cancelledBatches: num(row.batch_cancelled), confirmed: num(row.confirmed_requests), unknown: num(row.unknown_requests), budgetUsed: num(row.request_budget_used), budgetLimit: num(row.request_budget_limit) },
    publication: { totalUnits: num(row.unit_total), queuedUnits: num(row.unit_queued), runningUnits: num(row.unit_running), succeededUnits: num(row.unit_succeeded), blockedUnits: num(row.unit_blocked), failedUnits: num(row.unit_failed), cancelledUnits: num(row.unit_cancelled), publishedMembers: num(row.published_members), pendingMembers: num(row.pending_members) },
    results: { classified: num(row.classified), unclassified: num(row.unclassified), unclassifiedReasons: reasons, standardProducts: num(row.standard_products) },
    missing: { scheduledInputs: num(row.scheduled_missing), reprocessedInputs: num(row.reprocessed_missing) },
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at ?? ''),
  };
}

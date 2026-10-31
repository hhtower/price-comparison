import { sql, type Kysely, type Transaction } from 'kysely';
import { Inject, Optional } from '@nestjs/common';
import { Pool } from 'pg';
import { DATABASE } from '../database/database.providers.js';
import { PG_POOL } from '../database/database.providers.js';
import type { DatabaseSchema } from '../database/types.js';
import { extractionProgressDelta, incrementJobProgress } from '../ai/ai-progress.repository.js';
import { finalizeOrScheduleMissing } from '../ai/standardization-finalizer.js';
import { IDENTITY_POLICY_VERSION } from '../standardization/identity-policy.js';
import { PgNotifications } from '../database/pg-notifications.js';
import { readAiConcurrency } from '../ai/ai-concurrency.js';
import { STANDARDIZATION_PROMPT_VERSION } from '../ai/standardization-request.js';
import { PIPELINE_VERSIONS } from '../ai/pipeline-versions.js';
import { readCrawlerConfig } from '../config/env.js';
import { readAiStandardizationFeatures } from '../ai/ai-standardization-features.js';
import { claimAssistantTurns, completeAssistantTurn, failAssistantTurn, heartbeatAssistantTurn } from './assistant-queue.js';

export const QUEUE_TABLES = {
  fetch_run: 'fetch_runs',
  ai_batch: 'ai_job_batches',
  assistant_turn: 'assistant_turns',
} as const;
export type QueueKind = keyof typeof QUEUE_TABLES;

/** Stable queue names used by the worker resource budget. */
export type QueueName = 'fetch' | 'ai_standardization' | 'assistant';

export interface ClaimedJob {
  readonly kind: QueueKind;
  readonly id: bigint;
  readonly attempts: bigint;
  readonly claimed_by: string;
  readonly lease_until: Date;
  readonly row: Record<string, unknown>;
}

export interface FailOptions {
  readonly retry?: boolean;
  readonly backoffMs?: number;
  readonly retryClass?: string | null;
  readonly claimToken?: string;
}

async function fairFetchClaimIds(transaction: Transaction<DatabaseSchema>, limit: number): Promise<bigint[]> {
  const { hostConcurrency } = readCrawlerConfig();
  // Separate statement: READ COMMITTED must refresh its snapshot after the lock wait.
  // ponytail: serialize short fetch admission only; partition locks if claim throughput becomes limiting.
  await sql`select pg_advisory_xact_lock(hashtext('crawler.fetch.claim'), 0)`.execute(transaction);
  const running = (await sql<{ shop_id: bigint; task_type: string; url: string }>`
    select q.shop_id, q.task_type, s.url
    from fetch_runs q join shops s on s.id = q.shop_id
    where q.status = 'running' and q.lease_until > now()
  `.execute(transaction)).rows;
  const candidates = (await sql<{ id: bigint; shop_id: bigint; task_type: string; url: string }>`
    with heads as (
      select distinct on (q.shop_id, q.task_type) q.id
      from fetch_runs q
      where q.available_at <= now()
        and (q.status = 'queued' or (q.status = 'running' and (q.lease_until is null or q.lease_until <= now())))
        and not exists (
          select 1 from fetch_runs active
          where active.shop_id = q.shop_id and active.status = 'running' and active.lease_until > now()
        )
      order by q.shop_id, q.task_type, q.available_at, q.id
    )
    select q.id, q.shop_id, q.task_type, s.url
    from heads h join fetch_runs q on q.id = h.id join shops s on s.id = q.shop_id
    order by q.available_at, q.id
    for update of q skip locked
  `.execute(transaction)).rows.map(row => ({ ...row, host: fetchHost(row.url) }));
  const hostLoad = new Map<string, number>();
  const typeLoad = new Map<string, number>();
  const occupiedShops = new Set<bigint>();
  for (const row of running) {
    const host = fetchHost(row.url);
    hostLoad.set(host, (hostLoad.get(host) ?? 0) + 1);
    typeLoad.set(row.task_type, (typeLoad.get(row.task_type) ?? 0) + 1);
    occupiedShops.add(row.shop_id);
  }
  const selected: bigint[] = [];
  // Re-rank after every admission so neither an old host burst nor one task type fills the batch.
  while (selected.length < limit) {
    let best: typeof candidates[number] | undefined;
    for (const candidate of candidates) {
      if (occupiedShops.has(candidate.shop_id)) continue;
      const load = hostLoad.get(candidate.host) ?? 0;
      if (load >= hostConcurrency) continue;
      const bestLoad = best ? hostLoad.get(best.host) ?? 0 : Infinity;
      if (!best || load < bestLoad ||
        (load === bestLoad && (typeLoad.get(candidate.task_type) ?? 0) < (typeLoad.get(best.task_type) ?? 0))) {
        best = candidate;
      }
    }
    if (!best) break;
    selected.push(best.id);
    occupiedShops.add(best.shop_id);
    hostLoad.set(best.host, (hostLoad.get(best.host) ?? 0) + 1);
    typeLoad.set(best.task_type, (typeLoad.get(best.task_type) ?? 0) + 1);
  }
  return selected;
}

function fetchHost(url: string): string {
  try { return new URL(url).host.toLowerCase(); }
  // Legacy malformed URLs still reach the handler's validation without breaking the whole queue.
  catch { return ''; }
}

function activeStandardizationBatch(windowSize: number) { return sql`exists (
  select 1 from ai_jobs j
  where j.id = q.job_id
    and (${readAiStandardizationFeatures().tagExtractionEnabled} or j.job_type <> 'tag_extraction')
    and j.prompt_version = ${STANDARDIZATION_PROMPT_VERSION}
    and j.rule_version = ${IDENTITY_POLICY_VERSION}
    and j.pipeline_versions @> ${JSON.stringify(PIPELINE_VERSIONS)}::jsonb
    and j.status not in ('paused','cancelled','failed','succeeded')
    and not j.pause_requested and not j.cancel_requested
    and q.batch_index < coalesce((
      select min(w.batch_index) from ai_job_batches w
      where w.job_id = q.job_id and w.round = q.round
        and w.step <> 'done' and w.status not in ('failed','cancelled')
    ), q.batch_index) + ${windowSize}
    and (
      q.step = 'prepare' or q.step = 'publish'
      or (q.step = 'request' and q.request_budget_used < q.request_budget_limit and q.unknown_requests = 0)
    )
)`; }

export function classifyRetryClass(error: string): string {
  const value = error.toLowerCase();
  const transientProviderFailure =
    value.includes('connection error') ||
    /\b(?:408|425|429|500|502|503|504|524|529)\b/.test(value) ||
    value.includes('rate limit') ||
    value.includes('too many requests') ||
    value.includes('upstream http/2') ||
    value.includes('upstream request failed') ||
    value.includes('stream_read_error') ||
    value.includes('temporarily unavailable') ||
    value.includes('系统繁忙') ||
    value.includes('timeout') ||
    value.includes('timed out');
  if (transientProviderFailure) return 'network';
  if (value.includes('cancel') || value === 'requeued') return 'cancelled';
  if (value.includes('json') || value.includes('response') || value.includes('truncated') || value.includes('incomplete')) return 'invalid_response';
  if (value.includes('network') || value.includes('fetch') || value.includes('econn') || value.includes('503')) return 'network';
  return 'business';
}
export class JobsRepository {
  constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>, @Optional() @Inject(PG_POOL) private readonly pool?: Pool) {}

  /** Claim a bounded batch in one transaction so a worker never serializes one-row polls. */
  async claimAvailable(queue: QueueName, workerId: string, limit: number, leaseMs = 30_000): Promise<ClaimedJob[]> {
    if (!workerId.trim()) throw new Error('workerId is required');
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit must be positive');
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error('leaseMs must be positive');
    if (queue === 'assistant') return claimAssistantTurns(this.database, workerId, limit, leaseMs);
    const table = queue === 'fetch' ? 'fetch_runs' : 'ai_job_batches';
    const windowSize = queue === 'ai_standardization' ? readAiConcurrency() : 0;
    const parentFilter = queue === 'ai_standardization'
      ? sql`and ${activeStandardizationBatch(windowSize)}`
      : sql``;
    const batchPriority = sql`case when q.step = 'publish' or q.reference_snapshot->>'tagStage' = 'review'
      or q.reference_snapshot->>'standardizationStage' = 'review' then 0 else 1 end`;
    const priority = queue === 'ai_standardization'
      ? sql`coalesce((select j.priority from ai_jobs j where j.id = q.job_id), 50) desc, ${batchPriority}, `
      : sql``;
    const eligibleBatch = sql`q.job_id = j.id
      and q.available_at <= now()
      and (q.status = 'queued' or (q.status = 'running' and (q.lease_until is null or q.lease_until <= now())))
      and ${activeStandardizationBatch(windowSize)}`;
    const claimTransaction = this.database.transaction();
    return (queue === 'fetch' ? claimTransaction.setIsolationLevel('read committed') : claimTransaction).execute(async (transaction) => {
      const fetchIds = queue === 'fetch' ? await fairFetchClaimIds(transaction, limit) : [];
      if (queue === 'fetch' && fetchIds.length === 0) return [];
      const claimableJobIds = queue === 'ai_standardization'
        ? (await sql<{ id: bigint }>`
            select j.id from ai_jobs j
            where exists (
              select 1 from ai_job_batches q
               where ${eligibleBatch}
            )
             order by j.priority desc,
               (select min(${batchPriority}) from ai_job_batches q where ${eligibleBatch}),
               j.id asc
            for update skip locked
            limit ${limit}
          `.execute(transaction)).rows.map(row => row.id)
        : [];
      if (queue === 'ai_standardization' && claimableJobIds.length === 0) return [];
      const parentConstraint = queue === 'ai_standardization'
        ? sql`and q.job_id in (${sql.join(claimableJobIds)})`
        : sql`and q.id in (${sql.join(fetchIds)})`;
      const result = await sql<Record<string, unknown>>`
      with due as (
        select q.id
        from ${sql.raw(table)} q
        where q.available_at <= now()
          and (q.status = 'queued' or (q.status = 'running' and (q.lease_until is null or q.lease_until <= now())))
          ${parentFilter}
          ${parentConstraint}
        order by ${priority} q.available_at asc, q.id asc
        for update skip locked
        limit ${limit}
      )
      update ${sql.raw(table)} q
      set status = 'running', claimed_by = ${workerId},
          lease_until = now() + (${leaseMs} * interval '1 millisecond'),
          claim_token = md5(random()::text || clock_timestamp()::text),
          attempts = q.attempts + 1, available_at = now()
          , started_at = coalesce(q.started_at, now()), finished_at = null
          ${queue === 'fetch' ? sql`, crawl_metrics = case when q.status = 'running' then
            coalesce(q.crawl_metrics, '{"version":1}'::jsonb) || jsonb_build_object('leaseFailures',
              coalesce((q.crawl_metrics->>'leaseFailures')::integer, 0) + 1)
            else q.crawl_metrics end` : sql``}
      from due
      where q.id = due.id
      returning q.* ${queue === 'ai_standardization' ? sql`, (select j.job_type from ai_jobs j where j.id = q.job_id) as job_type` : sql``}
    `.execute(transaction);
      if (queue === 'ai_standardization' && result.rows.length) {
        const byJob = new Map<string, { id: bigint; count: number }>();
        for (const row of result.rows) {
          const id = row.job_id as bigint;
          const current = byJob.get(id.toString()) ?? { id, count: 0 };
          current.count += Number(row.product_count ?? 0);
          byJob.set(id.toString(), current);
        }
        for (const parent of byJob.values()) {
          await transaction.updateTable('ai_jobs').set({ status: 'running', finished_at: null, request_window_size: windowSize }).where('id', '=', parent.id).execute();
          await incrementJobProgress(transaction, { jobId: parent.id, ...extractionProgressDelta('claimed', parent.count) });
        }
      }
      return result.rows.map((row) => ({
        kind: queue === 'fetch' ? 'fetch_run' : 'ai_batch',
        id: row.id as bigint,
        attempts: row.attempts as bigint,
        claimed_by: row.claimed_by as string,
        lease_until: row.lease_until as Date,
        row,
      }));
    });
  }

  /** Wake a worker on a PostgreSQL notification, with a one-second bounded wait. */
  async waitForWork(channel: string, signal: AbortSignal): Promise<void> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(channel)) throw new Error('invalid notification channel');
    if (signal.aborted) return;
    if (!this.pool) return abortableDelay(signal, 1_000);
    const listener = await PgNotifications.open(this.pool, channel);
    try {
      await listener.wait(signal);
    } finally {
      await listener.close();
    }
    listener.check();
  }

  async claimNext(kind: QueueKind, workerId: string, leaseMs: number): Promise<ClaimedJob | null> {
    return (await this.claimAvailable(kind === 'assistant_turn' ? 'assistant' : kind === 'fetch_run' ? 'fetch' : 'ai_standardization', workerId, 1, leaseMs))[0] ?? null;
  }

  async queueDepth(kind: QueueKind): Promise<number> {
    const table = QUEUE_TABLES[kind];
    const result = await sql<{ count: bigint }>`
      select count(*)::bigint as count
      from ${sql.raw(table)} q
      where q.available_at <= now()
        and (
          q.status = 'queued'
          or (q.status = 'running' and (q.lease_until is null or q.lease_until <= now()))
        )
        ${
          kind === 'ai_batch' ? sql`and ${activeStandardizationBatch(readAiConcurrency())}` : sql``
        }
    `.execute(this.database);
    return Number(result.rows[0]?.count ?? 0n);
  }

  /** 抓取实例概览：可领取（含过期租约可回收）、在途（租约有效）、最近 1 小时失败。 */
  async fetchRunCounts(): Promise<{ queued: number; running: number; failedRecent: number }> {
    const result = await sql<{ queued: bigint; running: bigint; failed_recent: bigint }>`
      select
        count(*) filter (
          where q.available_at <= now()
            and (q.status = 'queued' or (q.status = 'running' and (q.lease_until is null or q.lease_until <= now())))
        )::bigint as queued,
        count(*) filter (where q.status = 'running' and q.lease_until > now())::bigint as running,
        count(*) filter (where q.status = 'failed' and q.finished_at > now() - interval '1 hour')::bigint as failed_recent
      from ${sql.raw(QUEUE_TABLES.fetch_run)} q
      where q.status in ('queued', 'running')
        or (q.status = 'failed' and q.finished_at > now() - interval '1 hour')
    `.execute(this.database);
    const row = result.rows[0];
    return {
      queued: Number(row?.queued ?? 0n),
      running: Number(row?.running ?? 0n),
      failedRecent: Number(row?.failed_recent ?? 0n),
    };
  }

  async heartbeat(kind: QueueKind, id: bigint, workerId: string, leaseMs = 30_000, claimToken?: string): Promise<void> {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('leaseMs must be positive');
    if (kind === 'assistant_turn') return heartbeatAssistantTurn(this.database, id, workerId, leaseMs, claimToken);
    const result = await sql`
      update ${sql.raw(QUEUE_TABLES[kind])}
      set lease_until = now() + (${leaseMs} * interval '1 millisecond')
      where id = ${id} and status = 'running' and claimed_by = ${workerId} and lease_until > now()
    `.execute(this.database);
    if (result.numAffectedRows !== 1n) throw new Error('heartbeat: lease owner or lease expired');
  }

  async complete(kind: QueueKind, id: bigint, workerId: string): Promise<void> {
    if (kind === 'assistant_turn') return completeAssistantTurn(this.database, id, workerId);
    if (kind === 'ai_batch') return this.completeStandardizationBatch(id, workerId);
    await this.database.transaction().execute(async (transaction) => {
      const result = await transaction.updateTable('fetch_runs')
        .set({ status: 'succeeded', claimed_by: null, lease_until: null, finished_at: sql`now()`, error: null })
        .where('id', '=', id).where('status', '=', 'running').where('claimed_by', '=', workerId)
        .where('lease_until', '>', sql<Date>`now()`).executeTakeFirst();
      if (result.numUpdatedRows === 1n) return;
      const row = await transaction.selectFrom('fetch_runs').select('status').where('id', '=', id).executeTakeFirst();
      if (!row || !['succeeded', 'failed', 'cancelled'].includes(row.status)) throw new Error('lease owner or lease expired');
    });
  }

  private async completeStandardizationBatch(id: bigint, workerId: string): Promise<void> {
    await this.database.transaction().execute(async tx => {
      const located = await tx.selectFrom('ai_job_batches').select('job_id').where('id', '=', id).executeTakeFirstOrThrow();
      await tx.selectFrom('ai_jobs').select('id').where('id', '=', located.job_id).forUpdate().executeTakeFirstOrThrow();
      const batch = await tx.selectFrom('ai_job_batches').select(['status', 'step', 'claimed_by', 'lease_until'])
        .where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
      if (batch.status === 'succeeded' && batch.step === 'done') {
        await finalizeOrScheduleMissing(tx, located.job_id);
        return;
      }
      // Preparation commits its own fenced completion; an older claim may finish after resume.
      if (batch.step === 'prepare') return;
      if (batch.status === 'queued' && (batch.step === 'publish' || batch.step === 'done')) return;
      if (batch.status !== 'running' || batch.claimed_by !== workerId || batch.lease_until === null || batch.lease_until <= new Date()) {
        if (['failed', 'cancelled'].includes(batch.status)) return;
        throw new Error('lease owner or lease expired');
      }
      if (batch.step === 'request') throw new Error('batch request must save a complete decision before completion');
      if (batch.step === 'publish') {
        await tx.updateTable('ai_job_batches').set({ status: 'queued', claimed_by: null, claim_token: null, lease_until: null, available_at: sql`now()` }).where('id', '=', id).execute();
        return;
      }
      await tx.updateTable('ai_job_batches').set({ status: 'succeeded', claimed_by: null, claim_token: null, lease_until: null, finished_at: sql`now()`, error: null }).where('id', '=', id).execute();
      await finalizeOrScheduleMissing(tx, located.job_id);
    });
  }

  async fail(kind: QueueKind, id: bigint, workerId: string, error: string, options: FailOptions = {}): Promise<void> {
    if (kind === 'assistant_turn') return failAssistantTurn(this.database, id, workerId, error, options);
    const retry = options.retry ?? false;
    const backoffMs = Math.max(0, options.backoffMs ?? 0);
    if (kind === 'ai_batch') return this.failStandardizationBatch(id, workerId, error, options, backoffMs);
    await this.database.transaction().execute(async (transaction) => {
      const result = await transaction.updateTable('fetch_runs')
        .set({
          status: retry ? 'queued' : 'failed', error, claimed_by: null, lease_until: null,
          available_at: sql`now() + (${backoffMs} * interval '1 millisecond')`, finished_at: retry ? null : sql`now()`,
        })
        .where('id', '=', id).where('status', '=', 'running').where('claimed_by', '=', workerId)
        .where('lease_until', '>', sql<Date>`now()`).executeTakeFirst();
      if (result.numUpdatedRows === 1n) return;
      const row = await transaction.selectFrom('fetch_runs').select('status').where('id', '=', id).executeTakeFirst();
      if (!row || !['queued', 'succeeded', 'failed', 'cancelled'].includes(row.status)) throw new Error('lease owner or lease expired');
    });
  }

  private async failStandardizationBatch(
    id: bigint,
    workerId: string,
    error: string,
    options: FailOptions,
    backoffMs: number,
  ): Promise<void> {
    await this.database.transaction().execute(async tx => {
      const located = await tx.selectFrom('ai_job_batches').select('job_id').where('id', '=', id).executeTakeFirstOrThrow();
      await tx.selectFrom('ai_jobs').select('id').where('id', '=', located.job_id).forUpdate().executeTakeFirstOrThrow();
      const batch = await tx.selectFrom('ai_job_batches').select([
        'status', 'step', 'claimed_by', 'lease_until', 'request_budget_used', 'request_budget_limit',
        'confirmed_requests', 'unknown_requests',
      ]).where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
      if (['succeeded', 'failed', 'cancelled'].includes(batch.status)) {
        await finalizeOrScheduleMissing(tx, located.job_id);
        return;
      }
      if (batch.status === 'queued') return;
      if (batch.status !== 'running' || batch.claimed_by !== workerId || batch.lease_until === null || batch.lease_until <= new Date()) {
        throw new Error('lease owner or lease expired');
      }

      const interrupted = options.retryClass === 'interrupted';
      const completed = interrupted && batch.step === 'done';
      // A worker shutdown is a local interruption, not a provider error.
      // Only unpublished local work or a request not yet reserved can be
      // requeued. Never turn an uncertain/confirmed send into another call.
      const retryClass = interrupted
        ? completed ? null
          : batch.step === 'publish' || batch.request_budget_used === 0 ? 'local'
          : batch.unknown_requests > 0 || batch.confirmed_requests < batch.request_budget_used ? 'request_outcome_unknown'
          : 'result_not_saved'
        : options.retryClass ?? 'provider_terminal';
      const canRetryLocally = retryClass === 'local';
      const canRetryProvider = retryClass === 'provider_transient'
        && batch.step === 'request'
        && batch.unknown_requests === 0
        && batch.confirmed_requests === batch.request_budget_used
        && batch.request_budget_used < batch.request_budget_limit;
      const retry = options.retry === true && (canRetryLocally || canRetryProvider);
      await tx.updateTable('ai_job_batches').set({
        status: completed ? 'succeeded' : retry ? 'queued' : 'failed',
        error: completed ? null : error,
        error_source: retryClass,
        retry_class: retryClass,
        claimed_by: null,
        claim_token: null,
        lease_until: null,
        available_at: sql`now() + (${retry ? backoffMs : 0} * interval '1 millisecond')`,
        finished_at: retry ? null : sql`now()`,
      }).where('id', '=', id).execute();
      if (!retry && batch.step==='prepare') {
        await tx.updateTable('ai_jobs').set({status:'failed',phase:'completed',error,finished_at:sql`now()`}).where('id','=',located.job_id).execute();
        await incrementJobProgress(tx,{jobId:located.job_id});
      } else if (!retry) await finalizeOrScheduleMissing(tx, located.job_id);
    });
  }

  requeue(kind: QueueKind, id: bigint, workerId: string, backoffMs = 0, claimToken?: string): Promise<void> {
    return this.fail(kind, id, workerId, 'requeued', { retry: true, retryClass: 'interrupted', backoffMs, claimToken });
  }

}

function abortableDelay(signal: AbortSignal, ms: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

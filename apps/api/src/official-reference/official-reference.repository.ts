import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/database.providers.js';
import type { ClaimedJob, QueueKind } from '../jobs/jobs.repository.js';
import type { WorkerRuntimeService } from '../workers/worker-runtime.js';
import { REFERENCE_APPS, REFERENCE_REGIONS } from './official-reference.catalog.js';
import type { PublishedReferenceRow, ReferenceSnapshotReader } from './official-reference.service.js';
import { parseExchangeRates } from './official-reference.sources.js';
import { validateRegionSnapshot } from './official-reference.snapshot.js';

@Injectable()
export class OfficialReferenceRepository implements ReferenceSnapshotReader, WorkerRuntimeService {
  private readonly claims = new Map<bigint, string>();
  intervalMs = 2 * 60 * 60 * 1000;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async seed(): Promise<void> {
    const tasks: Array<{ task_key: string; app_id: string | null; country: string | null }> = [{ task_key: 'fx', app_id: null, country: null }];
    for (const app of REFERENCE_APPS) for (const [country] of REFERENCE_REGIONS) {
      tasks.push({ task_key: 'prices:' + app.id + ':' + country, app_id: app.id, country });
    }
    await this.pool.query('insert into official_reference_jobs (task_key, app_id, country) select task_key, app_id, country '
      + 'from jsonb_to_recordset($1::jsonb) as tasks(task_key text, app_id text, country text) on conflict (task_key) do nothing', [JSON.stringify(tasks)]);
  }

  async readPublished(): Promise<PublishedReferenceRow[]> {
    return (await this.pool.query<PublishedReferenceRow>('select task_key, snapshot, last_error from official_reference_jobs where snapshot is not null')).rows;
  }

  async claimNext(_kind: QueueKind, workerId: string, leaseMs: number): Promise<ClaimedJob | null> {
    const token = randomUUID();
    const result = await this.pool.query('with candidate as (select id from official_reference_jobs where not (id = any($4::bigint[])) and ('
      + "(status = 'queued' and available_at <= clock_timestamp()) or (status = 'running' and lease_until < clock_timestamp())) "
      + "order by (task_key = 'fx') desc, available_at, id for update skip locked limit 1) "
      + "update official_reference_jobs j set status = 'running', claimed_by = $1, claim_token = $2, "
      + "lease_until = clock_timestamp() + $3 * interval '1 millisecond', attempts = attempts + 1 from candidate c where j.id = c.id returning j.*",
    [workerId, token, leaseMs, [...this.claims.keys()].map(String)]);
    const row = result.rows[0];
    if (!row) return null;
    const id = BigInt(row.id);
    this.claims.set(id, token);
    return { kind: 'fetch_run', id, attempts: BigInt(row.attempts), claimed_by: workerId, lease_until: row.lease_until, row };
  }

  async heartbeat(_kind: QueueKind, id: bigint, workerId: string, leaseMs = 30_000): Promise<void> {
    const result = await this.pool.query("update official_reference_jobs set lease_until = clock_timestamp() + $4 * interval '1 millisecond' "
      + "where id = $1 and claimed_by = $2 and claim_token = $3 and status = 'running' and lease_until > clock_timestamp()",
    [String(id), workerId, this.claims.get(id), leaseMs]);
    if (!result.rowCount) throw new Error('Reference task lease lost');
  }

  async publish(job: ClaimedJob, snapshot: unknown, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (job.row.task_key === 'fx') parseExchangeRates(snapshot);
    else {
      const region = validateRegionSnapshot(snapshot);
      if (region.appId !== job.row.app_id || region.country !== job.row.country) throw new Error('Reference task identity mismatch');
    }
    // A single statement publishes the whole validated region. An expired claim can never overwrite newer data.
    const result = await this.pool.query('update official_reference_jobs set snapshot = $4::jsonb, last_success_at = clock_timestamp(), last_error = null '
      + "where id = $1 and claimed_by = $2 and claim_token = $3 and status = 'running' and lease_until > clock_timestamp()",
    [String(job.id), job.claimed_by, job.row.claim_token, JSON.stringify(snapshot)]);
    if (!result.rowCount) throw new Error('Reference task lease lost before publication');
  }

  async complete(_kind: QueueKind, id: bigint, workerId: string): Promise<void> {
    await this.release(id, workerId, this.intervalMs, null, true);
  }

  async markUnavailable(job: ClaimedJob, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (job.row.task_key === 'fx') throw new Error('Exchange rates cannot be unavailable');
    const result = await this.pool.query('update official_reference_jobs set snapshot = null, last_success_at = clock_timestamp(), last_error = null '
      + "where id = $1 and claimed_by = $2 and claim_token = $3 and status = 'running' and lease_until > clock_timestamp()",
    [String(job.id), job.claimed_by, job.row.claim_token]);
    if (!result.rowCount) throw new Error('Reference task lease lost before retirement');
  }

  async fail(_kind: QueueKind, id: bigint, workerId: string, _error: string, options?: { retry?: boolean; backoffMs?: number }): Promise<void> {
    // Never persist transport errors: proxy URLs can carry credentials.
    await this.release(id, workerId, options?.retry ? options.backoffMs ?? 30_000 : this.intervalMs,
      '官方来源本次更新失败，保留上次完整报价', !options?.retry);
  }

  async requeue(_kind: QueueKind, id: bigint, workerId: string, backoffMs = 0): Promise<void> {
    await this.release(id, workerId, backoffMs, undefined, false);
  }

  onSettled(_kind: QueueKind, id: bigint, _workerId: string): void {
    this.claims.delete(id);
  }

  private async release(id: bigint, workerId: string, delay: number, error: string | null | undefined, resetAttempts: boolean) {
    await this.pool.query("update official_reference_jobs set status = 'queued', claimed_by = null, claim_token = null, lease_until = null, "
      + "available_at = clock_timestamp() + $4 * interval '1 millisecond', attempts = case when $5 then 0 else attempts end, "
      + 'last_error = case when $6 then $7 else last_error end '
      + "where id = $1 and claimed_by = $2 and claim_token = $3 and status = 'running'",
    [String(id), workerId, this.claims.get(id), delay, resetAttempts, error !== undefined, error ?? null]);
  }
}

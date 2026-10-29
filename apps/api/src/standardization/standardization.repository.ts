import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely, type Selectable } from 'kysely';
import { DATABASE } from '../database/database.providers.js';
import type { DatabaseSchema, StandardizationOutboxTable } from '../database/types.js';
import { AiRepository } from '../ai/ai.repository.js';
import { recoverAbandonedStandardizationBatches, recoverStandardizationFinalization } from '../ai/standardization-finalizer.js';
import { cancelDeletedProductOutbox } from '../products/product-name-deletion.js';
import { reconcileNameConsensus } from './name-consensus-repair.js';

export type StandardizationOutboxRow = Selectable<StandardizationOutboxTable>;
export type OutboxClaim = Pick<StandardizationOutboxRow, 'id' | 'attempts' | 'claim_token'>;
export interface IncrementalJobInput { outbox: readonly OutboxClaim[]; workerId: string; priority: number; signal?: AbortSignal }
export interface CreatedIncrementalJob { id: bigint; sourceOutboxIds: bigint[] }

@Injectable()
export class StandardizationRepository {
  constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>, @Inject(AiRepository) private readonly ai: AiRepository) {}

  /** Abandoned batches must reach a terminal state before finalization rescans jobs in the same sweep. */
  async recoverFinalization(limit = 100): Promise<number> {
    await cancelDeletedProductOutbox(this.database);
    const abandoned = await recoverAbandonedStandardizationBatches(this.database, limit);
    const finalized = await recoverStandardizationFinalization(this.database, limit);
    return abandoned + finalized;
  }

  /** Same-name majority repair without model calls; skipped while live writers hold the tables. */
  async reconcileNameConsensus(): Promise<number> {
    try {
      return (await reconcileNameConsensus(this.database, { apply: true, beforeApply: async () => undefined })).changes.length;
    } catch (error) {
      // 55P03 lock_not_available, 40001 serialization_failure: retry on the next idle sweep.
      if (['55P03', '40001'].includes((error as { code?: string }).code ?? '')) return 0;
      throw error;
    }
  }

  async claimOutbox(workerId: string): Promise<StandardizationOutboxRow[]> {
    if (!workerId.trim()) throw new Error('workerId is required');
    // Claim one complete crawl/transaction group; AI request batching happens later.
    const groupAvailable = sql<boolean>`not exists (
      select 1 from standardization_outbox other join product_change_events origin on origin.id = other.event_id
      where origin.shop_id = e.shop_id
        and (origin.source_fetch_run_id = e.source_fetch_run_id or (origin.source_fetch_run_id is null and e.source_fetch_run_id is null and origin.created_at = e.created_at))
        and ((other.status = 'running' and other.lease_until > now()) or (other.status = 'queued' and other.available_at > now()))
    )`;
    return this.database.transaction().execute(async tx => {
      // Serialize group selection per shop, in crawler lock order. A fresh
      // statement after this lock sees a previous claimant's committed leases.
      const shop = await sql<{ id: bigint }>`
        select s.id from shops s join (
          select p.shop_id, min(o.id) as first_id from standardization_outbox o
          join products p on p.id = o.product_id
          join product_change_events e on e.id = o.event_id
          where p.deleted_at is null and o.available_at <= now()
            and (o.status = 'queued' or (o.status = 'running' and (o.lease_until is null or o.lease_until <= now())))
            and ${groupAvailable}
          group by p.shop_id
        ) pending on pending.shop_id = s.id
        where s.deleted_at is null and s.enabled = true
        order by pending.first_id for no key update of s skip locked limit 1
      `.execute(tx);
      if (!shop.rows.length) return [];
      const shopId = shop.rows[0]!.id;
      const seed = await sql<{ id: bigint; source_fetch_run_id: bigint | null }>`
        select o.id, e.source_fetch_run_id from standardization_outbox o
        join product_change_events e on e.id = o.event_id join products p on p.id = o.product_id
        where p.shop_id = ${shopId} and p.deleted_at is null and o.available_at <= now()
          and (o.status = 'queued' or (o.status = 'running' and (o.lease_until is null or o.lease_until <= now())))
          and ${groupAvailable}
        order by o.id limit 1
      `.execute(tx);
      if (!seed.rows.length) return [];
      const result = await sql<StandardizationOutboxRow>`
        with due as (
          select o.id from standardization_outbox o
          join product_change_events e on e.id = o.event_id
          join standardization_outbox first_outbox on first_outbox.id = ${seed.rows[0]!.id}
          join product_change_events first_event on first_event.id = first_outbox.event_id
          join products p on p.id = o.product_id
          where p.shop_id = ${shopId} and p.deleted_at is null and o.available_at <= now()
            and (o.status = 'queued' or (o.status = 'running' and (o.lease_until is null or o.lease_until <= now())))
            and (e.source_fetch_run_id = first_event.source_fetch_run_id or (e.source_fetch_run_id is null and first_event.source_fetch_run_id is null and e.created_at = first_event.created_at))
          order by o.id for update of o
        )
        update standardization_outbox o set status = 'running', claimed_by = ${workerId},
          lease_until = now() + interval '60 seconds', attempts = attempts + 1,
          claim_token = md5(random()::text || clock_timestamp()::text)
        from due where o.id = due.id returning o.*
      `.execute(tx);
      return result.rows;
    });
  }

  async failOutbox(claim: OutboxClaim, workerId: string, error: string): Promise<void> {
    await this.database.updateTable('standardization_outbox').set({ status: 'queued', last_error: error, claimed_by: null, lease_until: null, claim_token: null, available_at: new Date(Date.now() + 1000) })
      .where('id', '=', claim.id).where('status', '=', 'running').where('claimed_by', '=', workerId).where('attempts', '=', claim.attempts)
      .where('claim_token', 'is not distinct from', claim.claim_token).where('lease_until', '>', sql<Date>`clock_timestamp()`).execute();
  }

  /** Creating the shared AI job and consuming its exact outbox claims commit together. */
  async createIncrementalJob(input: IncrementalJobInput): Promise<CreatedIncrementalJob | null> {
    if (!input.workerId.trim()) throw new Error('workerId is required');
    if (!input.outbox.length) return null;
    const claims = new Map(input.outbox.map(claim => [claim.id, claim]));
    return this.database.transaction().execute(async tx => {
      input.signal?.throwIfAborted();
      const claimQuery = tx.selectFrom('standardization_outbox').select(['id', 'product_id', 'event_id', 'fingerprint', 'attempts', 'claim_token'])
        .where('id', 'in', [...claims.keys()]).where('status', '=', 'running').where('claimed_by', '=', input.workerId)
        .where('lease_until', '>', sql<Date>`clock_timestamp()`).orderBy('id');
      const candidates = (await claimQuery.execute()).filter(row => row.attempts === claims.get(row.id)!.attempts && row.claim_token === claims.get(row.id)!.claim_token);
      if (!candidates.length) return null;
      // Match crawler lock order, and leave outbox rows unlocked until product writers can finish.
      const shops = await tx.selectFrom('shops').select('id')
        .where('id', 'in', tx.selectFrom('products').select('shop_id').where('id', 'in', candidates.map(row => row.product_id)))
        .where('deleted_at', 'is', null).where('enabled', '=', true).orderBy('id').forShare().execute();
      const eligible = shops.length ? await tx.selectFrom('products').select(['id', 'content_fingerprint'])
        .where('id', 'in', candidates.map(row => row.product_id)).where('shop_id', 'in', shops.map(shop => shop.id))
        .where('deleted_at', 'is', null).orderBy('id').forShare().execute() : [];
      const rows = await claimQuery.where('id', 'in', candidates.map(row => row.id)).forUpdate().execute();
      input.signal?.throwIfAborted();
      const owned = rows.filter(row => row.attempts === claims.get(row.id)!.attempts && row.claim_token === claims.get(row.id)!.claim_token);
      if (!owned.length) return null;
      const eligibleIds = new Set(eligible.map(product => product.id));
      const unavailable = owned.filter(row => !eligibleIds.has(row.product_id));
      if (unavailable.length) await tx.updateTable('standardization_outbox').set({
        status: 'queued', claimed_by: null, lease_until: null, claim_token: null, last_error: 'product temporarily unavailable',
        available_at: sql<Date>`clock_timestamp() + interval '1 second'`,
      }).where('id', 'in', unavailable.map(row => row.id)).execute();
      const active = owned.filter(row => eligibleIds.has(row.product_id));
      if (!active.length) return null;
      const origins = await tx.selectFrom('product_change_events').select('source_fetch_run_id')
        .where('id', 'in', active.map(row => row.event_id)).execute();
      const runIds = new Set(origins.map(row => row.source_fetch_run_id));
      const job = await this.ai.createJob({
        model: process.env.AI_MODEL?.trim() ?? '', productIds: [...new Set(active.map(row => row.product_id))],
        scopeShopId: shops.length === 1 ? shops[0]!.id : null,
        sourceFetchRunId: origins.length === active.length && runIds.size === 1 ? origins[0]!.source_fetch_run_id : null,
        jobType: 'incremental', priority: input.priority, triggerEventId: active[0]!.event_id,
        sourceEvents: active.map(row => ({ productId: row.product_id, eventId: row.event_id })),
      }, tx);
      input.signal?.throwIfAborted();
      const ids = active.map(row => row.id);
      const acknowledged = await tx.updateTable('standardization_outbox').set({ status: 'succeeded', claimed_by: null, lease_until: null, claim_token: null, last_error: null })
        .where('id', 'in', ids).where('status', '=', 'running').where('claimed_by', '=', input.workerId)
        .where('lease_until', '>', sql<Date>`clock_timestamp()`).returning('id').execute();
      if (acknowledged.length !== ids.length) throw new Error('outbox lease expired while creating AI job');
      input.signal?.throwIfAborted();
      return { id: job.id, sourceOutboxIds: ids };
    });
  }
}

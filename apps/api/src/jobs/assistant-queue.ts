import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/types.js';
import type { ClaimedJob, FailOptions } from './jobs.repository.js';

export async function claimAssistantTurns(db: Kysely<DatabaseSchema>, workerId: string, limit: number, leaseMs: number): Promise<ClaimedJob[]> {
  return db.transaction().execute(async tx => {
    await sql`update assistant_turns set status = 'failed', finished_at = now(), lease_until = null,
      event_version = event_version + 1, error_code = case
        when deadline_at <= now() then 'TURN_TIMEOUT'
        when request_in_flight then 'REQUEST_OUTCOME_UNKNOWN' else 'RESULT_NOT_SAVED' end
      where status in ('queued','running') and (deadline_at <= now()
        or (status = 'running' and coalesce(lease_until, '-infinity'::timestamptz) <= now() and requests_started > 0))`.execute(tx);
    const result = await sql<Record<string, unknown>>`
      with due as (
        select q.id from assistant_turns q
        where q.available_at <= now() and q.deadline_at > now()
          and (q.status = 'queued' or (q.status = 'running' and coalesce(q.lease_until, '-infinity'::timestamptz) <= now() and q.requests_started = 0))
          and exists (select 1 from assistant_sessions s where s.id = q.session_id and s.expires_at > now())
        order by q.available_at, q.id for update skip locked limit ${limit}
      )
      update assistant_turns q set status = 'running', phase = 'understanding', event_version = event_version + 1,
        claimed_by = ${workerId}, claim_token = md5(random()::text || clock_timestamp()::text),
        lease_until = now() + (${leaseMs} * interval '1 millisecond'),
        attempts = attempts + 1, started_at = coalesce(started_at, now()), finished_at = null
      from due where q.id = due.id returning q.*
    `.execute(tx);
    return result.rows.map(row => ({
      kind: 'assistant_turn', id: row.id as bigint, attempts: row.attempts as bigint,
      claimed_by: row.claimed_by as string, lease_until: row.lease_until as Date, row,
    }));
  });
}

export async function completeAssistantTurn(db: Kysely<DatabaseSchema>, id: bigint, workerId: string): Promise<void> {
  const row = await db.selectFrom('assistant_turns').select(['status', 'claimed_by', 'reply']).where('id', '=', id).executeTakeFirst();
  if (row?.status === 'succeeded' && row.claimed_by === workerId && row.reply !== null) return;
  if (!row || row.status === 'cancelled' || row.status === 'failed') return;
  throw new Error('assistant complete requires an atomically saved reply');
}

export async function heartbeatAssistantTurn(db: Kysely<DatabaseSchema>, id: bigint, workerId: string, leaseMs: number, claimToken?: string) {
  await db.transaction().execute(async tx => {
    await tx.selectFrom('assistant_turns').select('id').where('id', '=', id).forUpdate().executeTakeFirst();
    const result = await tx.updateTable('assistant_turns')
      .set({ lease_until: sql`clock_timestamp() + (${leaseMs} * interval '1 millisecond')` })
      .where('id', '=', id).where('status', '=', 'running').where('claimed_by', '=', workerId)
      .where('claim_token', '=', claimToken ?? '').where('deadline_at', '>', sql<Date>`clock_timestamp()`)
      .where('lease_until', '>', sql<Date>`clock_timestamp()`).executeTakeFirst();
    if (result.numUpdatedRows !== 1n) throw new Error('heartbeat: assistant lease owner or lease expired');
  });
}

export async function failAssistantTurn(db: Kysely<DatabaseSchema>, id: bigint, workerId: string, error: string, options: FailOptions): Promise<void> {
  const knownErrors = ['MODEL_INVALID_RESPONSE', 'TURN_TIMEOUT', 'MODEL_UNAVAILABLE', 'INPUT_TOO_LARGE', 'EVIDENCE_TOO_LARGE'];
  const errorCode = knownErrors.includes(error) ? error : 'MODEL_UNAVAILABLE';
  // Once sent, a crash loses in-memory output. Never replay it as an automatic retry.
  await sql`update assistant_turns set
    status = case when ${options.retry ?? false} and requests_started = 0 and deadline_at > now() then 'queued' else 'failed' end,
    phase = case when ${options.retry ?? false} and requests_started = 0 and deadline_at > now() then 'queued' else phase end,
    error_code = case when ${options.retry ?? false} and requests_started = 0 and deadline_at > now() then null
      when deadline_at <= now() then 'TURN_TIMEOUT'
      when request_in_flight then 'REQUEST_OUTCOME_UNKNOWN' else ${errorCode} end,
    claimed_by = null, claim_token = null, lease_until = null,
    finished_at = case when ${options.retry ?? false} and requests_started = 0 and deadline_at > now() then null else now() end,
    available_at = now() + (${Math.max(0, options.backoffMs ?? 0)} * interval '1 millisecond'),
    event_version = event_version + 1
    where id = ${id} and status = 'running' and claimed_by = ${workerId}
      and claim_token = ${options.claimToken ?? null}
  `.execute(db);
}

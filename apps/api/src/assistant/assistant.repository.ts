import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely, type Selectable } from 'kysely';
import { emptyShoppingNeeds, validateAssistantReply, type AssistantReply, type ShoppingNeeds, type TurnSnapshot, type SessionSnapshot } from '@price-comparison/catalog/assistant-contract';
import { DATABASE } from '../database/database.providers.js';
import { jsonb, type DatabaseSchema, type AssistantTurnTable, type JsonValue } from '../database/types.js';
import { DomainConflictError, DomainNotFoundError, DomainValidationError } from '../common/errors.js';
import type { StreamingUsage } from '../ai/llm-runtime.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const turnIdPattern = /^[1-9][0-9]{0,18}$/u;
const missing = () => new DomainNotFoundError('ASSISTANT_NOT_FOUND', '导购会话不存在或已过期');
const conflict = () => new DomainConflictError('ASSISTANT_REVISION_CONFLICT', '会话版本已变化，请同步后再发送');
const encoded = (value: unknown) => jsonb(value as JsonValue);
type TurnRow = Selectable<AssistantTurnTable>;

export function turnSnapshot(row: TurnRow): TurnSnapshot {
  return {
    id: String(row.id), sessionId: row.session_id, clientMessageId: row.client_message_id,
    inputText: row.input_text, expectedRevision: row.expected_revision, eventVersion: row.event_version,
    status: row.status, phase: row.phase, reply: row.reply === null ? null : validateAssistantReply(row.reply),
    errorCode: row.error_code,
  };
}

@Injectable()
export class AssistantRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DatabaseSchema>) {}

  async createSession() {
    await this.cleanupExpired();
    const sessionId = randomUUID();
    const accessToken = randomBytes(32).toString('base64url');
    await this.db.insertInto('assistant_sessions').values({
      id: sessionId, access_hash: this.hash(accessToken), needs: encoded(emptyShoppingNeeds()),
      expires_at: new Date(Date.now() + 86_400_000),
    }).execute();
    return { sessionId, accessToken, revision: 0 };
  }

  private hash(token: string): string { return createHash('sha256').update(token).digest('hex'); }

  private session(id: string, token: string, db = this.db) {
    if (!uuid.test(id) || !/^[A-Za-z0-9_-]{43}$/u.test(token)) throw missing();
    return db.selectFrom('assistant_sessions').selectAll()
      .where('id', '=', id).where('access_hash', '=', this.hash(token)).where('expires_at', '>', sql<Date>`clock_timestamp()`);
  }

  async readSession(id: string, accessToken: string): Promise<SessionSnapshot> {
    if (!await this.session(id, accessToken).executeTakeFirst()) throw missing();
    await this.expireTurns(id);
    return this.db.transaction().setIsolationLevel('repeatable read').execute(async tx => {
      const session = await this.session(id, accessToken, tx).executeTakeFirst();
      if (!session) throw missing();
      const turns = await tx.selectFrom('assistant_turns').selectAll().where('session_id', '=', id).orderBy('id').execute();
      return { id, revision: session.revision, needs: session.needs as unknown as ShoppingNeeds, turns: turns.map(turnSnapshot) };
    });
  }

  async readTurn(id: string, turnId: string, token: string): Promise<TurnSnapshot> {
    if (!turnIdPattern.test(turnId) || BigInt(turnId) >= 2n ** 63n) throw missing();
    if (!await this.session(id, token).executeTakeFirst()) throw missing();
    await this.expireTurns(id);
    const row = await this.db.selectFrom('assistant_turns').selectAll().where('session_id', '=', id).where('id', '=', BigInt(turnId)).executeTakeFirst();
    if (!row) throw missing();
    return turnSnapshot(row);
  }

  async acceptTurn(id: string, token: string, input: { clientMessageId: string; expectedRevision: number; text: string }) {
    if (!input || Object.keys(input).some(key => !['clientMessageId', 'expectedRevision', 'text'].includes(key))
      || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2000
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.text)
      || typeof input.clientMessageId !== 'string' || !uuid.test(input.clientMessageId)
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new DomainValidationError('ASSISTANT_INVALID_INPUT', '请发送不超过2000字的完整问题');
    }
    this.session(id, token);
    return this.db.transaction().execute(async tx => {
      const session = await tx.selectFrom('assistant_sessions').selectAll()
        .where('id', '=', id).where('access_hash', '=', this.hash(token))
        .where('expires_at', '>', sql<Date>`clock_timestamp()`).forUpdate().executeTakeFirst();
      if (!session) throw missing();
      const previous = await tx.selectFrom('assistant_turns').selectAll().where('session_id', '=', id)
        .where('client_message_id', '=', input.clientMessageId).executeTakeFirst();
      if (previous) {
        if (previous.input_text !== input.text || previous.expected_revision !== input.expectedRevision) throw conflict();
        return { snapshot: turnSnapshot(previous), created: false };
      }
      if (session.revision !== input.expectedRevision) throw conflict();
      const rows = await tx.selectFrom('assistant_turns').select(['status']).where('session_id', '=', id).execute();
      if (rows.some(row => row.status === 'queued' || row.status === 'running')) throw conflict();
      if (rows.length >= 30) throw new DomainValidationError('ASSISTANT_SESSION_LIMIT', '本次会话已达到30轮，请重新开始');
      const turn = await tx.insertInto('assistant_turns').values({
        session_id: id, client_message_id: input.clientMessageId, expected_revision: input.expectedRevision,
        input_text: input.text, deadline_at: new Date(Date.now() + 90_000),
        model: null, error_code: null, claimed_by: null, claim_token: null, lease_until: null,
        started_at: null, finished_at: null,
      }).returningAll().executeTakeFirstOrThrow();
      await sql`select pg_notify('queue_assistant', '')`.execute(tx);
      return { snapshot: turnSnapshot(turn), created: true };
    });
  }

  async cancelTurn(id: string, turnId: string, token: string) {
    await this.readTurn(id, turnId, token);
    return this.db.transaction().execute(async tx => {
      // Session-first locking also orders deletion, submission and completion.
      const session = await tx.selectFrom('assistant_sessions').select('id').where('id', '=', id)
        .where('access_hash', '=', this.hash(token)).where('expires_at', '>', sql<Date>`clock_timestamp()`).forUpdate().executeTakeFirst();
      if (!session) throw missing();
      await tx.updateTable('assistant_turns').set({
        status: 'cancelled', error_code: 'CANCELLED', finished_at: sql`now()`, lease_until: null,
        event_version: sql`event_version + 1`,
      }).where('session_id', '=', id).where('id', '=', BigInt(turnId)).where('status', 'in', ['queued', 'running']).execute();
      const row = await tx.selectFrom('assistant_turns').selectAll().where('session_id', '=', id).where('id', '=', BigInt(turnId)).executeTakeFirstOrThrow();
      return turnSnapshot(row);
    });
  }

  async deleteSession(id: string, token: string): Promise<void> {
    this.session(id, token);
    const result = await this.db.deleteFrom('assistant_sessions').where('id', '=', id).where('access_hash', '=', this.hash(token)).executeTakeFirst();
    if (!result.numDeletedRows) throw missing();
  }

  async cleanupExpired(): Promise<number> {
    const result = await sql`delete from assistant_sessions where id in
      (select id from assistant_sessions where expires_at <= now() order by expires_at limit 100 for update skip locked)`.execute(this.db);
    await this.expireTurns();
    return Number(result.numAffectedRows);
  }

  private async expireTurns(sessionId?: string) {
    await sql`update assistant_turns set status = 'failed', error_code = 'TURN_TIMEOUT',
      finished_at = now(), lease_until = null, event_version = event_version + 1
      where status in ('queued','running') and deadline_at <= now()
      ${sessionId ? sql`and session_id = ${sessionId}::uuid` : sql``}`.execute(this.db);
  }

  private owned(turnId: string, workerId: string, claimToken: string) {
    return this.db.selectFrom('assistant_turns').selectAll().where('id', '=', BigInt(turnId))
      .where('status', '=', 'running').where('claimed_by', '=', workerId).where('claim_token', '=', claimToken)
      .where('lease_until', '>', sql<Date>`clock_timestamp()`).where('deadline_at', '>', sql<Date>`clock_timestamp()`);
  }

  async readTurnContext(turnId: string, workerId: string, claimToken: string) {
    const row = await this.owned(turnId, workerId, claimToken).executeTakeFirst();
    if (!row) throw new Error('assistant lease or deadline expired');
    const session = await this.db.selectFrom('assistant_sessions').selectAll().where('id', '=', row.session_id)
      .where('expires_at', '>', sql<Date>`clock_timestamp()`).executeTakeFirst();
    if (!session || session.revision !== row.expected_revision) throw conflict();
    const history = await this.db.selectFrom('assistant_turns').select(['input_text', 'reply']).where('session_id', '=', row.session_id)
      .where('status', '=', 'succeeded').orderBy('id', 'desc').limit(6).execute();
    return {
      snapshot: turnSnapshot(row), deadlineAt: row.deadline_at, needs: session.needs as unknown as ShoppingNeeds,
      history: history.reverse().map(item => ({ text: item.input_text, reply: validateAssistantReply(item.reply) })),
    };
  }

  async setPhase(turnId: string, workerId: string, claimToken: string, phase: 'understanding' | 'searching' | 'explaining') {
    const result = await this.db.updateTable('assistant_turns').set({ phase, event_version: sql`event_version + 1` })
      .where('id', '=', BigInt(turnId)).where('status', '=', 'running').where('claimed_by', '=', workerId).where('claim_token', '=', claimToken)
      .where('lease_until', '>', sql<Date>`clock_timestamp()`).where('deadline_at', '>', sql<Date>`clock_timestamp()`).executeTakeFirst();
    if (result.numUpdatedRows !== 1n) throw new Error('assistant lease or deadline expired');
  }

  async reserveModelRequest(turnId: string, workerId: string, claimToken: string, model: string) {
    await this.db.transaction().execute(async tx => {
      // A WHERE time predicate can run before a row-lock wait; lock first, then fence sending.
      await tx.selectFrom('assistant_turns').select('id').where('id', '=', BigInt(turnId)).forUpdate().executeTakeFirst();
      const result = await tx.updateTable('assistant_turns').set({
        requests_started: sql`requests_started + 1`, request_in_flight: true, model,
      }).where('id', '=', BigInt(turnId)).where('status', '=', 'running').where('claimed_by', '=', workerId).where('claim_token', '=', claimToken)
        .where('lease_until', '>', sql<Date>`clock_timestamp()`).where('deadline_at', '>', sql<Date>`clock_timestamp()`)
        .where('requests_started', '<', 2).where('request_in_flight', '=', false)
        .where('session_id', 'in', tx.selectFrom('assistant_sessions').select('id').where('expires_at', '>', sql<Date>`clock_timestamp()`))
        .executeTakeFirst();
      if (result.numUpdatedRows !== 1n) throw new Error('assistant request no longer allowed');
    });
  }

  async finishModelRequest(turnId: string, workerId: string, claimToken: string, usage: StreamingUsage | null) {
    const result = await this.db.updateTable('assistant_turns').set({
      request_in_flight: false, usage: sql`usage || ${JSON.stringify([usage])}::jsonb`,
    }).where('id', '=', BigInt(turnId)).where('status', '=', 'running').where('claimed_by', '=', workerId)
      .where('claim_token', '=', claimToken).where('request_in_flight', '=', true)
      .where('lease_until', '>', sql<Date>`clock_timestamp()`).where('deadline_at', '>', sql<Date>`clock_timestamp()`).executeTakeFirst();
    if (result.numUpdatedRows !== 1n) throw new Error('assistant request lost ownership');
  }

  async completeTurn(input: { turnId: string; workerId: string; claimToken: string; expectedRevision: number; reply: AssistantReply }) {
    const reply = validateAssistantReply(input.reply);
    return this.db.transaction().execute(async tx => {
      const located = await tx.selectFrom('assistant_turns').select('session_id').where('id', '=', BigInt(input.turnId)).executeTakeFirst();
      if (!located) throw missing();
      const session = await tx.selectFrom('assistant_sessions').selectAll().where('id', '=', located.session_id).forUpdate().executeTakeFirstOrThrow();
      const row = await tx.selectFrom('assistant_turns').selectAll().where('id', '=', BigInt(input.turnId)).forUpdate().executeTakeFirstOrThrow();
      if (row.status === 'succeeded' && row.claim_token === input.claimToken && row.claimed_by === input.workerId) return turnSnapshot(row);
      if (session.expires_at <= new Date() || session.revision !== input.expectedRevision || row.expected_revision !== input.expectedRevision
        || row.status !== 'running' || row.claimed_by !== input.workerId || row.claim_token !== input.claimToken
        || !row.lease_until || row.lease_until <= new Date() || row.deadline_at <= new Date()
        || row.request_in_flight || row.requests_started < 1) throw conflict();
      // Recheck against database time at the commit fence, not the model's start time.
      const saved = await tx.updateTable('assistant_turns').set({
        status: 'succeeded', reply: encoded(reply), finished_at: sql`now()`, error_code: null, event_version: sql`event_version + 1`,
      }).where('id', '=', row.id).where('deadline_at', '>', sql<Date>`clock_timestamp()`)
        .where('lease_until', '>', sql<Date>`clock_timestamp()`).returningAll().executeTakeFirst();
      if (!saved) throw conflict();
      await tx.updateTable('assistant_sessions').set({ needs: encoded(reply.needs), revision: session.revision + 1 }).where('id', '=', session.id).execute();
      return turnSnapshot(saved);
    });
  }
}

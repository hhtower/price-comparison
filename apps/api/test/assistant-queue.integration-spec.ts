import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { after, afterEach, before, test } from 'node:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { validateSessionSnapshot, validateTurnSnapshot } from '@price-comparison/catalog/assistant-contract';
import { AssistantRepository } from '../src/assistant/assistant.repository.js';
import { up } from '../src/database/migrations/027_assistant_20261031.js';
import type { DatabaseSchema } from '../src/database/types.js';
import { JobsRepository } from '../src/jobs/jobs.repository.js';

const schema = `assistant_queue_${randomUUID().replaceAll('-', '')}`;
let admin: Pool;
let pool: Pool;
let db: Kysely<DatabaseSchema>;
let repository: AssistantRepository;
let jobs: JobsRepository;

before(async () => {
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.ok(connectionString, 'TEST_DATABASE_URL is required; never use the production database');
  admin = new Pool({ connectionString, connectionTimeoutMillis: 2000, statement_timeout: 2000 });
  await admin.query(`create schema "${schema}"`);
  pool = new Pool({
    connectionString, max: 5, connectionTimeoutMillis: 2000,
    options: `-c search_path=${schema} -c lock_timeout=1000 -c statement_timeout=2000`,
  });
  db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
  await up(db as unknown as Kysely<unknown>);
  repository = new AssistantRepository(db);
  jobs = new JobsRepository(db);
});

afterEach(async () => {
  if (db) await db.deleteFrom('assistant_sessions').execute();
});

after(async () => {
  try {
    if (db) await db.destroy();
    else await pool?.end();
  } finally {
    try { await admin?.query(`drop schema if exists "${schema}" cascade`); }
    finally { await admin?.end(); }
  }
});

async function acceptedTurn() {
  const session = await repository.createSession();
  const accepted = await repository.acceptTurn(session.sessionId, session.accessToken, {
    clientMessageId: randomUUID(), expectedRevision: 0, text: 'Help me choose',
  });
  return { session, turn: accepted.snapshot };
}

async function claimedTurn() {
  const accepted = await acceptedTurn();
  const [claim] = await jobs.claimAvailable('assistant', 'same-process-worker', 1);
  assert.ok(claim);
  assert.equal(claim.id.toString(), accepted.turn.id);
  return { ...accepted, claim, claimToken: String(claim.row.claim_token) };
}

for (const transition of ['fail', 'requeue'] as const) {
  test(`stale ${transition} cannot alter a newer claim by the same worker`, async () => {
    const { claim: oldClaim, claimToken: oldToken } = await claimedTurn();
    await sql`update assistant_turns set lease_until = clock_timestamp() - interval '1 second'
      where id = ${oldClaim.id}`.execute(db);
    const [current] = await jobs.claimAvailable('assistant', oldClaim.claimed_by, 1);
    assert.ok(current);
    assert.equal(current.id, oldClaim.id);
    const currentToken = String(current.row.claim_token);
    assert.notEqual(currentToken, oldToken);
    await repository.reserveModelRequest(current.id.toString(), current.claimed_by, currentToken, 'mock');
    const before = await db.selectFrom('assistant_turns').selectAll().where('id', '=', current.id).executeTakeFirstOrThrow();

    if (transition === 'fail') {
      await jobs.fail('assistant_turn', oldClaim.id, oldClaim.claimed_by, 'MODEL_UNAVAILABLE', { claimToken: oldToken });
      await jobs.fail('assistant_turn', oldClaim.id, oldClaim.claimed_by, 'MODEL_UNAVAILABLE');
    } else {
      await jobs.requeue('assistant_turn', oldClaim.id, oldClaim.claimed_by, 0, oldToken);
      await jobs.requeue('assistant_turn', oldClaim.id, oldClaim.claimed_by);
    }
    assert.deepEqual(
      await db.selectFrom('assistant_turns').selectAll().where('id', '=', current.id).executeTakeFirstOrThrow(),
      before,
      'old or missing claim tokens must leave the current request and ownership unchanged',
    );

    await jobs.fail('assistant_turn', current.id, current.claimed_by, 'MODEL_UNAVAILABLE', { claimToken: currentToken });
    const failed = await db.selectFrom('assistant_turns').selectAll().where('id', '=', current.id).executeTakeFirstOrThrow();
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error_code, 'REQUEST_OUTCOME_UNKNOWN');
  });
}

test('heartbeat rejects an old or missing token after the same worker reclaims a turn', async () => {
  const { claim, claimToken } = await claimedTurn();
  await sql`update assistant_turns set lease_until = clock_timestamp() - interval '1 second'
    where id = ${claim.id}`.execute(db);
  const [current] = await jobs.claimAvailable('assistant', claim.claimed_by, 1);
  assert.ok(current);
  const currentToken = String(current.row.claim_token);
  assert.notEqual(currentToken, claimToken);
  await assert.rejects(jobs.heartbeat('assistant_turn', current.id, current.claimed_by, 1000, claimToken), /lease/u);
  await assert.rejects(jobs.heartbeat('assistant_turn', current.id, current.claimed_by, 1000), /lease/u);
  const unchanged = await db.selectFrom('assistant_turns').selectAll().where('id', '=', current.id).executeTakeFirstOrThrow();
  assert.equal(unchanged.lease_until?.getTime(), current.lease_until.getTime());
  await jobs.heartbeat('assistant_turn', current.id, current.claimed_by, 30_000, currentToken);
});

async function waitUntil(check: () => Promise<boolean>, message: string) {
  const deadline = performance.now() + 1000;
  while (performance.now() < deadline) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail(message);
}

async function waitPastExpiry(
  id: bigint, expiry: 'lease_until' | 'deadline_at', operation: () => Promise<void>,
) {
  const blocker = await pool.connect();
  let transactionOpen = false;
  let pending: Promise<{ error: unknown }> | undefined;
  try {
    await blocker.query('begin');
    transactionOpen = true;
    await sql`update assistant_turns set ${sql.ref(expiry)} = clock_timestamp() + interval '750 milliseconds'
      where id = ${id}`.execute(db);
    await blocker.query('select id from assistant_turns where id = $1 for update', [id.toString()]);
    const { rows: [{ pid }] } = await blocker.query<{ pid: number }>('select pg_backend_pid() as pid');
    pending = operation().then(() => ({ error: null }), error => ({ error }));
    await waitUntil(async () => {
      const result = await admin.query<{ blocked: boolean }>(
        'select exists(select 1 from pg_stat_activity where $1::int = any(pg_blocking_pids(pid))) as blocked', [pid],
      );
      return result.rows[0]!.blocked;
    }, 'operation never waited for the held row lock');
    const expired = async () => {
      const result = await blocker.query<{ expired: boolean }>(
        `select ${expiry} <= clock_timestamp() as expired from assistant_turns where id = $1`, [id.toString()],
      );
      return result.rows[0]!.expired;
    };
    assert.equal(await expired(), false, 'operation must start waiting before expiry');
    await waitUntil(expired, 'database time did not cross expiry within one second');
    await blocker.query('commit');
    transactionOpen = false;
    const result = await pending;
    assert.ok(result.error instanceof Error, 'operation must reject after its row-lock wait crosses expiry');
    return result.error;
  } finally {
    try {
      if (transactionOpen) await blocker.query('rollback');
    } finally {
      blocker.release();
      await pending;
    }
  }
}

for (const expiry of ['lease_until', 'deadline_at'] as const) {
  test(`request reservation rejects ${expiry} crossed while waiting for a row lock`, { timeout: 5000 }, async () => {
    const { claim, claimToken } = await claimedTurn();
    const error = await waitPastExpiry(claim.id, expiry,
      () => repository.reserveModelRequest(claim.id.toString(), claim.claimed_by, claimToken, 'mock'));
    assert.match(error.message, /request no longer allowed/u);
    const row = await db.selectFrom('assistant_turns').selectAll().where('id', '=', claim.id).executeTakeFirstOrThrow();
    assert.equal(row.requests_started, 0);
    assert.equal(row.request_in_flight, false);
    assert.equal(row.model, null);
  });

  test(`heartbeat rejects ${expiry} crossed while waiting for a row lock`, { timeout: 5000 }, async () => {
    const { claim, claimToken } = await claimedTurn();
    const error = await waitPastExpiry(claim.id, expiry,
      () => jobs.heartbeat('assistant_turn', claim.id, claim.claimed_by, 1000, claimToken));
    assert.match(error.message, /lease owner or lease expired/u);
    const row = await db.selectFrom('assistant_turns').selectAll().where('id', '=', claim.id).executeTakeFirstOrThrow();
    if (expiry === 'lease_until') assert.ok(row.lease_until! < new Date());
    else assert.equal(row.lease_until?.getTime(), claim.lease_until.getTime());
  });
}

test('cancelled turn and restored session pass the public snapshot validators', async () => {
  const { session, turn } = await acceptedTurn();
  const cancelled = await repository.cancelTurn(session.sessionId, turn.id, session.accessToken);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.errorCode, 'CANCELLED');
  assert.deepEqual(validateTurnSnapshot(cancelled), cancelled);
  const restored = await repository.readSession(session.sessionId, session.accessToken);
  assert.deepEqual(validateSessionSnapshot(restored), restored);
  assert.equal(restored.turns[0]?.status, 'cancelled');
  assert.equal(restored.revision, 0);
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import type { DatabaseSchema } from '../src/database/types.js';
import { up } from '../src/database/migrations/027_assistant_20261031.js';
import { AssistantRepository } from '../src/assistant/assistant.repository.js';
import { JobsRepository } from '../src/jobs/jobs.repository.js';
import { emptyShoppingNeeds, type AssistantReply } from '@price-comparison/catalog/assistant-contract';

const schema = `assistant_${randomUUID().replaceAll('-', '')}`;
let admin: Pool;
let db: Kysely<DatabaseSchema>;
let repository: AssistantRepository;
let jobs: JobsRepository;

before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required; never use the production database');
  admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public`, max: 5 });
  db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
  await up(db);
  repository = new AssistantRepository(db);
  jobs = new JobsRepository(db);
});

after(async () => {
  await db?.destroy();
  await admin?.query(`drop schema if exists "${schema}" cascade`);
  await admin?.end();
});

const input = (text = '便宜一点') => ({ clientMessageId: randomUUID(), expectedRevision: 0, text });
const reply = (): AssistantReply => ({
  kind: 'question', text: '主要用来做什么？', options: ['学习', '写代码'],
  needs: emptyShoppingNeeds(), cards: [],
});

test('session credentials are hashed and cannot access another session', async () => {
  const session = await repository.createSession();
  const other = await repository.createSession();
  const row = await db.selectFrom('assistant_sessions').selectAll().where('id', '=', session.sessionId).executeTakeFirstOrThrow();
  assert.notEqual(row.access_hash, session.accessToken);
  assert.equal(row.access_hash.length, 64);
  await assert.rejects(repository.readSession(session.sessionId, other.accessToken), error => Reflect.get(error as object, 'getStatus')?.call(error) === 404);
  assert.equal((await repository.readSession(session.sessionId, session.accessToken)).revision, 0);
});

test('message idempotency survives duplicate submission and rejects conflicting content', async () => {
  const session = await repository.createSession();
  const message = input();
  const accepted = await repository.acceptTurn(session.sessionId, session.accessToken, message);
  const repeated = await repository.acceptTurn(session.sessionId, session.accessToken, message);
  assert.equal(repeated.snapshot.id, accepted.snapshot.id);
  assert.equal(repeated.created, false);
  await assert.rejects(repository.acceptTurn(session.sessionId, session.accessToken, { ...message, text: '另一个问题' }));
});

test('only one concurrent turn is accepted per session', async () => {
  const session = await repository.createSession();
  const results = await Promise.allSettled([
    repository.acceptTurn(session.sessionId, session.accessToken, input('预算50元')),
    repository.acceptTurn(session.sessionId, session.accessToken, input('不要共享')),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
});

test('complete reply and needs commit together and duplicate completion is idempotent', async () => {
  const session = await repository.createSession();
  const accepted = await repository.acceptTurn(session.sessionId, session.accessToken, input());
  const claim = await claimTurn(accepted.snapshot.id);
  await repository.reserveModelRequest(claim.id.toString(), claim.claimed_by, String(claim.row.claim_token), 'mock');
  await repository.finishModelRequest(claim.id.toString(), claim.claimed_by, String(claim.row.claim_token), null);
  const finalReply = reply();
  finalReply.needs.preferences = ['lower_price'];
  const completion = { turnId: claim.id.toString(), workerId: claim.claimed_by, claimToken: String(claim.row.claim_token), expectedRevision: 0, reply: finalReply };
  await repository.completeTurn(completion);
  await repository.completeTurn(completion);
  const stored = await repository.readSession(session.sessionId, session.accessToken);
  assert.equal(stored.revision, 1);
  assert.deepEqual(stored.needs.preferences, ['lower_price']);
  assert.deepEqual(stored.turns[0]?.reply, finalReply);
  await assert.rejects(repository.acceptTurn(session.sessionId, session.accessToken, input()), error => Reflect.get(error as object, 'code') === 'ASSISTANT_REVISION_CONFLICT');
  await jobs.complete('assistant_turn', claim.id, claim.claimed_by);
});

test('failure while updating needs rolls back the previously written complete reply', async () => {
  const session = await repository.createSession();
  const accepted = await repository.acceptTurn(session.sessionId, session.accessToken, input());
  const claim = await claimTurn(accepted.snapshot.id);
  await repository.reserveModelRequest(claim.id.toString(), claim.claimed_by, String(claim.row.claim_token), 'mock');
  await repository.finishModelRequest(claim.id.toString(), claim.claimed_by, String(claim.row.claim_token), null);
  await sql`create function reject_assistant_revision() returns trigger language plpgsql as $$
    begin raise exception 'test commit failure'; end $$`.execute(db);
  await sql`create trigger reject_assistant_revision before update on assistant_sessions
    for each row execute function reject_assistant_revision()`.execute(db);
  try {
    await assert.rejects(repository.completeTurn({
      turnId: claim.id.toString(), workerId: claim.claimed_by, claimToken: String(claim.row.claim_token),
      expectedRevision: 0, reply: reply(),
    }), /test commit failure/u);
    const stored = await repository.readSession(session.sessionId, session.accessToken);
    assert.equal(stored.revision, 0);
    assert.equal(stored.turns[0]?.reply, null);
    assert.equal(stored.turns[0]?.status, 'running');
  } finally {
    await sql`drop trigger reject_assistant_revision on assistant_sessions; drop function reject_assistant_revision()`.execute(db);
  }
});

test('cancelled turns cannot commit late replies or be resurrected by runtime requeue', async () => {
  const session = await repository.createSession();
  const accepted = await repository.acceptTurn(session.sessionId, session.accessToken, input());
  const claim = await claimTurn(accepted.snapshot.id);
  await repository.cancelTurn(session.sessionId, claim.id.toString(), session.accessToken);
  await assert.rejects(repository.completeTurn({
    turnId: claim.id.toString(), workerId: claim.claimed_by, claimToken: String(claim.row.claim_token),
    expectedRevision: 0, reply: reply(),
  }));
  await jobs.requeue('assistant_turn', claim.id, claim.claimed_by);
  const stored = await repository.readSession(session.sessionId, session.accessToken);
  assert.equal(stored.turns[0]?.status, 'cancelled');
  assert.equal(stored.revision, 0);
  assert.equal(stored.turns[0]?.reply, null);
});

test('expired sessions reject access and cleanup deletes content', async () => {
  const session = await repository.createSession();
  await repository.acceptTurn(session.sessionId, session.accessToken, input());
  await sql`update assistant_sessions set expires_at = now() - interval '1 second' where id = ${session.sessionId}::uuid`.execute(db);
  await assert.rejects(repository.readSession(session.sessionId, session.accessToken));
  assert.ok(await repository.cleanupExpired() >= 1);
  assert.equal((await db.selectFrom('assistant_turns').select('id').where('session_id', '=', session.sessionId).execute()).length, 0);
});

test('sent requests with expired worker leases fail instead of being sent again', async () => {
  const session = await repository.createSession();
  const accepted = await repository.acceptTurn(session.sessionId, session.accessToken, input());
  const claim = await claimTurn(accepted.snapshot.id);
  await repository.reserveModelRequest(claim.id.toString(), claim.claimed_by, String(claim.row.claim_token), 'mock');
  await sql`update assistant_turns set lease_until = now() - interval '1 second' where id = ${claim.id}`.execute(db);
  await jobs.claimAvailable('assistant', 'recovery', 5);
  const stored = await repository.readTurn(session.sessionId, claim.id.toString(), session.accessToken);
  assert.equal(stored.status, 'failed');
  assert.equal(stored.errorCode, 'REQUEST_OUTCOME_UNKNOWN');
});

test('deleting a session revokes credentials and removes turns', async () => {
  const session = await repository.createSession();
  await repository.acceptTurn(session.sessionId, session.accessToken, input());
  await repository.deleteSession(session.sessionId, session.accessToken);
  await assert.rejects(repository.readSession(session.sessionId, session.accessToken));
});

async function claimTurn(id: string) {
  const claims = await jobs.claimAvailable('assistant', `worker-${id}`, 30);
  const claim = claims.find(row => row.id.toString() === id);
  assert.ok(claim);
  return claim;
}

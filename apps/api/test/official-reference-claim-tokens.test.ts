import assert from 'node:assert/strict';
import test from 'node:test';
import { OfficialReferenceRepository } from '../src/official-reference/official-reference.repository.js';
import { WorkerRuntime, type WorkerRuntimeService } from '../src/workers/worker-runtime.js';
import type { ClaimedJob } from '../src/jobs/jobs.repository.js';

async function overlappingClaims() {
  const claims = [Promise.withResolvers<{ rows: unknown[] }>(), Promise.withResolvers<{ rows: unknown[] }>()];
  const queries: Array<{ sql: string; args: unknown[] }> = [];
  let count = 0;
  const repository = new OfficialReferenceRepository({
    query: async (sql: string, args: unknown[]) => {
      queries.push({ sql, args });
      if (sql.startsWith('with candidate')) return claims[count++]?.promise ?? { rows: [] };
      return { rowCount: 1 };
    },
  } as never);
  // Both exclusion lists are captured before either database claim returns.
  const first = repository.claimNext('fetch_run', 'worker', 30_000);
  const second = repository.claimNext('fetch_run', 'worker', 30_000);
  for (const [index, pending] of claims.entries()) {
    pending.resolve({ rows: [{
      id: '1', attempts: String(index + 1), claim_token: queries[index]!.args[1],
      claimed_by: 'worker', lease_until: new Date(Date.now() + 30_000),
    }] });
    await (index === 0 ? first : second);
  }
  return { repository, queries, first: (await first)!, second: (await second)! };
}

for (const newerFirst of [false, true]) {
  test(`official-reference local exclusion survives ${newerFirst ? 'newer' : 'older'} claim settling first`, async () => {
    const { repository, queries, first, second } = await overlappingClaims();
    const [early, late] = newerFirst ? [second, first] : [first, second];
    repository.onSettled('fetch_run', early.id, early.claimed_by, String(early.row.claim_token));
    await repository.claimNext('fetch_run', 'worker', 30_000);
    assert.deepEqual(queries.at(-1)!.args[3], ['1'], 'unfinished claim must remain excluded');
    repository.onSettled('fetch_run', late.id, late.claimed_by, String(late.row.claim_token));
    await repository.claimNext('fetch_run', 'worker', 30_000);
    assert.deepEqual(queries.at(-1)!.args[3], [], 'last settlement must release local exclusion');
  });
}

test('official-reference transitions use the execution token even when a newer claim is cached', async () => {
  const { repository, queries, first, second } = await overlappingClaims();
  const token = String(first.row.claim_token);
  assert.notEqual(token, second.row.claim_token);
  await repository.heartbeat('fetch_run', first.id, first.claimed_by, 30_000, token);
  await repository.complete('fetch_run', first.id, first.claimed_by, token);
  await repository.fail('fetch_run', first.id, first.claimed_by, 'failed', { claimToken: token });
  await repository.requeue('fetch_run', first.id, first.claimed_by, 0, token);
  assert.deepEqual(queries.slice(2).map(query => query.args[2]), [token, token, token, token]);
});

test('runtime settlement forwards tokens for executed and abandoned claims', async () => {
  for (const abandon of [false, true]) {
    const pending = Promise.withResolvers<ClaimedJob | null>();
    const settled = Promise.withResolvers<string | undefined>();
    let available = true;
    const service: WorkerRuntimeService = {
      claimNext: async () => { if (!available) return null; available = false; return pending.promise; },
      heartbeat: async () => {}, complete: async () => {}, fail: async () => {}, requeue: async () => {},
      onSettled: (_kind, _id, _worker, token?: string) => settled.resolve(token),
    };
    const runtime = new WorkerRuntime({ service, kind: 'fetch_run', workerId: 'worker', handler: async () => {} });
    const run = runtime.runOnce();
    const stopping = abandon ? runtime.stop() : undefined;
    pending.resolve({
      id: 1n, kind: 'fetch_run', attempts: 1n, claimed_by: 'worker',
      lease_until: new Date(), row: { claim_token: 'execution-token' },
    });
    try {
      await run;
      assert.equal(await settled.promise, 'execution-token');
    } finally { await (stopping ?? runtime.stop()); }
  }
});

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Kysely, PostgresDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';
import { jsonb, type DatabaseSchema } from '../src/database/types.js';

let admin: Pool;
before(() => { assert.ok(process.env.TEST_DATABASE_URL); admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL }); });
after(async () => { await admin?.end(); });

async function withSchema(run: (database: Kysely<DatabaseSchema>, jobId: bigint) => Promise<void>) {
  const schema = `input_history_schema_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  await admin.query(`create schema ${schema}`);
  const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public` }) }) });
  try {
    const { error } = await new Migrator({ db: database, provider: migrationProvider, migrationTableSchema: schema }).migrateToLatest();
    if (error) throw error;
    const job = await database.insertInto('ai_jobs').values({ model: 'schema-only', status: 'succeeded', total: 1n }).returning('id').executeTakeFirstOrThrow();
    await database.insertInto('ai_job_inputs').values({ job_id: job.id, input_id: 1n, fingerprint: 'unchanged-content-fingerprint', payload: jsonb({ name: 'unchanged historical input' }), status: 'succeeded' }).execute();
    await run(database, job.id);
  } finally { await database.destroy(); await admin.query(`drop schema ${schema} cascade`); }
}

test('input identity permits distinct SKU inputs sharing one source hash and rejects duplicate input IDs', async () => {
  await withSchema(async (database, jobId) => {
    const seed = await database.selectFrom('ai_job_inputs').select(['fingerprint']).executeTakeFirstOrThrow();
    const decisions = await database.insertInto('product_standardization_decisions').values([
      { product_id: 2n, action: 'quarantine', evidence_known: false, reason: 'first historical review', source: 'application' },
      { product_id: 3n, action: 'exclude', evidence_known: false, reason: 'second historical review', source: 'application' },
    ]).returning('id').execute();
    const input = { job_id: jobId, fingerprint: seed.fingerprint, payload: jsonb({ name: 'equal content' }), status: 'queued' as const };
    await database.insertInto('ai_job_inputs').values(decisions.map((decision, index) => ({
      ...input, input_id: BigInt(index + 2), manual_decision_id: decision.id,
      previous_decision: jsonb({ reason: `${index === 0 ? 'first' : 'second'} historical review` }),
    }))).execute();
    await database.insertInto('ai_job_inputs').values({ ...input, input_id: 4n }).execute();
    await database.insertInto('ai_job_inputs').values({ ...input, input_id: 5n, manual_decision_id: decisions[0]!.id }).execute();
    await assert.rejects(database.insertInto('ai_job_inputs').values({ ...input, input_id: 4n }).execute(), { code: '23505' });
  });
});

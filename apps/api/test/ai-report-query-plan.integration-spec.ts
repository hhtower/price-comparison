import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';
import type { DatabaseSchema } from '../src/database/types.js';
import { hasLostMemberRequest } from '../src/ai/request-outcome.js';

test('lost-request reports avoid inspecting completed batches in a large task', async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'Dedicated TEST_DATABASE_URL required');
  const schema = `report_plan_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  const db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: new Pool({
    connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public`,
  }) }) });
  try {
    const migration = await new Migrator({ db, provider: migrationProvider, migrationTableSchema: schema }).migrateToLatest();
    if (migration.error) throw migration.error;
    const job = await db.insertInto('ai_jobs').values({ model: 'mock', status: 'failed', total: 3001n }).returning('id').executeTakeFirstOrThrow();
    await sql`insert into ai_job_batches(job_id,batch_index,product_ids,product_count,status,step,confirmed_requests,request_budget_used)
      select ${job.id}, n, jsonb_build_array(n::text), 1, 'succeeded', 'done', 1, 1
      from generate_series(1, 3000) n`.execute(db);
    await sql`insert into ai_job_batches(job_id,batch_index,product_ids,product_count,status,step,unknown_requests,request_budget_used)
      values (${job.id}, 3001, '["3001"]', 1, 'failed', 'request', 1, 1)`.execute(db);
    await sql`analyze ai_job_batches`.execute(db);
    const query = sql<{ lost: boolean }>`select ${hasLostMemberRequest()} as lost
      from (values (${job.id}::bigint, 3001::bigint)) m(job_id,input_id)`;
    assert.deepEqual((await query.execute(db)).rows, [{ lost: true }]);
    const plan = (await sql<{ 'QUERY PLAN': Array<{ Plan: Record<string, any> }> }>`
      explain (analyze, buffers, format json) ${query}`.execute(db)).rows[0]!['QUERY PLAN'][0]!.Plan;
    const nodes = (node: Record<string, any>): Array<Record<string, any>> => [node, ...(node.Plans ?? []).flatMap(nodes)];
    assert.ok(nodes(plan).every(node => (node['Rows Removed by Filter'] ?? 0) < 100),
      'completed batches must be excluded by the access path before JSON membership checks');
  } finally {
    await db.destroy();
    await admin.query(`drop schema "${schema}" cascade`);
    await admin.end();
  }
});

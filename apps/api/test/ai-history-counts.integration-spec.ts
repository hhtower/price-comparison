import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { CompiledQuery, Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';
import { readAiTaskQueue } from '../src/ai/ai-task-queue.js';
import { AiRepository } from '../src/ai/ai.repository.js';
import { pipelineVersionSnapshot, STANDARDIZATION_POLICY_VERSION } from '../src/ai/pipeline-versions.js';
import { STANDARDIZATION_PROMPT_VERSION } from '../src/ai/standardization-request.js';
import type { DatabaseSchema } from '../src/database/types.js';

test('standardization history counts avoid scanning unrelated task records and follow writes exactly', async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'Dedicated TEST_DATABASE_URL required');
  const schema = `history_counts_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  const queries: CompiledQuery[] = [];
  const db = new Kysely<DatabaseSchema>({
    dialect: new PostgresDialect({ pool: new Pool({
      connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public`,
    }) }),
    log: event => { queries.push(event.query); },
  });
  try {
    const migration = await new Migrator({ db, provider: migrationProvider, migrationTableSchema: schema }).migrateToLatest();
    if (migration.error) throw migration.error;
    await sql`insert into ai_jobs(model,total,status,job_type,prompt_version,rule_version,pipeline_versions)
      select 'mock',0,'succeeded','incremental','legacy','legacy',
        jsonb_build_object('oldVersion',n::text) from generate_series(1,5000) n`.execute(db);
    await sql`insert into ai_jobs(model,total,status,job_type,prompt_version,rule_version,pipeline_versions)
      select 'mock',0,'succeeded','incremental',${STANDARDIZATION_PROMPT_VERSION},${STANDARDIZATION_POLICY_VERSION},
        ${JSON.stringify(pipelineVersionSnapshot('mock'))}::jsonb from generate_series(1,100) n`.execute(db);
    await sql`insert into ai_jobs(model,total,status,job_type,prompt_version,rule_version,pipeline_versions)
      select 'mock',0,'succeeded','tag_extraction',${STANDARDIZATION_PROMPT_VERSION},${STANDARDIZATION_POLICY_VERSION},
        ${JSON.stringify(pipelineVersionSnapshot('mock'))}::jsonb from generate_series(1,3000) n`.execute(db);
    await sql`analyze ai_jobs`.execute(db);
    queries.length = 0;
    const page = await readAiTaskQueue(db, { status: 'all', totalOnly: true, limit: 10 });
    assert.equal(page.items.length, 10);
    assert.equal(page.summary.total, 100);
    const count = queries.find(q => q.sql.includes(' as total') && !q.sql.includes('page as'))!;
    const result = await db.executeQuery<{ 'QUERY PLAN': Array<{ Plan: Record<string, any> }> }>(
      CompiledQuery.raw(`explain (analyze, buffers, format json) ${count.sql}`, count.parameters),
    );
    const nodes = (node: Record<string, any>): Array<Record<string, any>> => [node, ...(node.Plans ?? []).flatMap(nodes)];
    assert.ok(nodes(result.rows[0]!['QUERY PLAN'][0]!.Plan).every(node => node['Relation Name'] !== 'ai_jobs'),
      'the global exact total must use compact version/status counts, not rescan task history');
    const listing = queries.find(q => q.sql.startsWith('select "j"."id"'))!;
    const listingPlan = await db.executeQuery<{ 'QUERY PLAN': Array<{ Plan: Record<string, any> }> }>(
      CompiledQuery.raw(`explain (analyze, buffers, format json) ${listing.sql}`, listing.parameters),
    );
    assert.ok(nodes(listingPlan.rows[0]!['QUERY PLAN'][0]!.Plan).every(node =>
      node['Relation Name'] !== 'ai_jobs' || (node['Rows Removed by Filter'] ?? 0) < 100),
    'newer attribute tasks must not force history pages to scan unrelated rows in descending ID order');
    queries.length = 0;
    await new AiRepository(db).adminStatus();
    const latest = queries[0]!;
    const latestPlan = await db.executeQuery<{ 'QUERY PLAN': Array<{ Plan: Record<string, any> }> }>(
      CompiledQuery.raw(`explain (analyze, buffers, format json) ${latest.sql}`, latest.parameters),
    );
    assert.ok(nodes(latestPlan.rows[0]!['QUERY PLAN'][0]!.Plan).every(node =>
      node['Relation Name'] !== 'ai_jobs' || (node['Rows Removed by Filter'] ?? 0) < 100),
    'the workbench latest-task request also needs an identity-only ordered access path');

    const id = BigInt(page.items[0]!.id);
    const shop = await db.insertInto('shops').values({ name: 'Scope', platform: 'test', url: 'https://scope.invalid' })
      .returning('id').executeTakeFirstOrThrow();
    await db.updateTable('ai_jobs').set({ scope_shop_id: shop.id }).where('id', '=', id).execute();
    queries.length = 0;
    const scoped = await readAiTaskQueue(db, { status: 'all', totalOnly: true, scopeShopId: shop.id, limit: 10 });
    assert.deepEqual(scoped.items.map(row => row.id), [String(id)]);
    assert.equal(scoped.summary.total, 1);
    const scopedCount = queries.find(q => q.sql.includes(' as total'))!;
    const scopedPlan = await db.executeQuery<{ 'QUERY PLAN': Array<{ Plan: Record<string, any> }> }>(
      CompiledQuery.raw(`explain (analyze, buffers, format json) ${scopedCount.sql}`, scopedCount.parameters),
    );
    assert.ok(nodes(scopedPlan.rows[0]!['QUERY PLAN'][0]!.Plan).every(node =>
      node['Relation Name'] !== 'ai_jobs' || (node['Rows Removed by Filter'] ?? 0) < 100),
    'shop history must select matching task IDs before counting, not inspect every task');
    await db.updateTable('ai_jobs').set({ status: 'paused' }).where('id', '=', id).execute();
    assert.equal((await readAiTaskQueue(db, { status: 'unfinished', totalOnly: true })).summary.total, 1);
    await assert.rejects(db.transaction().execute(async tx => {
      await tx.deleteFrom('ai_jobs').where('id', '=', id).execute();
      throw new Error('rollback count');
    }), /rollback count/);
    assert.equal((await readAiTaskQueue(db, { status: 'all', totalOnly: true })).summary.total, 100);
    await db.deleteFrom('ai_jobs').where('id', '=', id).execute();
    assert.equal((await readAiTaskQueue(db, { status: 'all', totalOnly: true })).summary.total, 99);
    await sql`update ai_jobs set pipeline_versions='{}'::jsonb where prompt_version=${STANDARDIZATION_PROMPT_VERSION}`.execute(db);
    queries.length = 0;
    assert.equal((await readAiTaskQueue(db, { status: 'all', totalOnly: true })).summary.total, 0);
    assert.ok(!queries.some(query => query.sql.startsWith('select "j"."id"')),
      'an empty compatible history must not scan all obsolete tasks looking for a page');
    await sql`truncate ai_jobs cascade`.execute(db);
    assert.equal((await readAiTaskQueue(db, { status: 'all', totalOnly: true })).summary.total, 0);
  } finally {
    await db.destroy();
    await admin.query(`drop schema "${schema}" cascade`);
    await admin.end();
  }
});

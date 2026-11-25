import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { CompiledQuery, Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';
import { readAiTaskQueue } from '../src/ai/ai-task-queue.js';
import { pipelineVersionSnapshot } from '../src/ai/pipeline-versions.js';
import { jsonb, type DatabaseSchema } from '../src/database/types.js';
import { seedUsableOffers } from './standardization-review-fixture.js';

test('attention history reads candidate member IDs before payloads and retains unsaved lost requests', async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'Dedicated TEST_DATABASE_URL required');
  const schema = `attention_plan_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  let query: CompiledQuery | undefined;
  const db = new Kysely<DatabaseSchema>({
    dialect: new PostgresDialect({ pool: new Pool({
      connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public`, max: 1,
    }) }),
    log: event => { if (event.query.sql.includes('current_members as')) query = event.query; },
  });
  try {
    const migration = await new Migrator({ db, provider: migrationProvider, migrationTableSchema: schema }).migrateToLatest();
    if (migration.error) throw migration.error;
    const shop = await db.insertInto('shops').values({ platform: 'test', name: 'Plan', url: 'https://plan.invalid' })
      .returningAll().executeTakeFirstOrThrow();
    const product = await db.insertInto('products').values({
      shop_id: shop.id, external_id: '1', name: 'ChatGPT Plus', normalized_key: 'plan', url: '',
      content_version: 1n, content_fingerprint: 'plan-fingerprint',
    }).returningAll().executeTakeFirstOrThrow();
    const standard = await db.insertInto('standard_products').values({
      name: 'ChatGPT Plus', canonical_family: 'openai', canonical_product: 'chatgpt', canonical_tier: 'plus',
      verification_state: 'verified',
    }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('standard_product_members').values({
      product_id: product.id, standard_product_id: standard.id, publication_state: 'published', assignment_source: 'ai',
    }).execute();
    await seedUsableOffers(db, [product.id]);
    const payload = jsonb({ shopSource: { url: shop.url, protocol: shop.protocol, platform: shop.platform }, warrantyEligible: true });
    await sql`insert into ai_jobs(model,total,status,job_type,pipeline_versions)
      select 'mock',1,'succeeded','tag_extraction',${JSON.stringify(pipelineVersionSnapshot('mock'))}::jsonb
      from generate_series(1,3000)`.execute(db);
    await sql`insert into ai_job_inputs(job_id,input_id,fingerprint,payload)
      select id,${product.id},${product.content_fingerprint},${payload} from ai_jobs`.execute(db);
    await sql`insert into ai_job_input_members(job_id,input_id,product_id,content_version,standardization_revision,fingerprint,payload,status,output)
      select id,${product.id},${product.id},${product.content_version},${product.standardization_revision},${product.content_fingerprint},
        ${payload},'classified',jsonb_build_object('outcome','updated','rejectedTags','[]'::jsonb,'diagnostic',repeat(md5(id::text),300))
      from ai_jobs`.execute(db);
    const last = await db.selectFrom('ai_jobs').select('id').orderBy('id', 'desc').executeTakeFirstOrThrow();
    await db.updateTable('ai_job_input_members').set({ output: jsonb({ outcome: 'review', rejectedTags: [] }) }).where('job_id', '=', last.id).execute();
    await sql`analyze ai_jobs`.execute(db);
    await sql`analyze ai_job_input_members`.execute(db);
    const input = { jobType: 'tag_extraction', status: 'attention', totalOnly: true, limit: 10 };
    const page = await readAiTaskQueue(db, input);
    assert.deepEqual(page.items.map(row => row.id), [String(last.id)]);
    assert.equal(page.summary.total, 1);
    assert.ok(query);
    const captured = query;
    await sql`set jit = off`.execute(db);
    const result = await db.executeQuery<{ 'QUERY PLAN': Array<{ Plan: Record<string, any> }> }>(
      CompiledQuery.raw(`explain (analyze, buffers, format json) ${captured.sql}`, captured.parameters),
    );
    const nodes = (node: Record<string, any>): Array<Record<string, any>> => [node, ...(node.Plans ?? []).flatMap(nodes)];
    const scans = nodes(result.rows[0]!['QUERY PLAN'][0]!.Plan).filter(node =>
      node['Relation Name'] === 'ai_job_input_members' && node['Node Type'] === 'Seq Scan'
      && (node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0) >= 100);
    assert.deepEqual(scans.map(node => ({ alias: node.Alias, rows: node['Actual Rows'], removed: node['Rows Removed by Filter'],
      loops: node['Actual Loops'], filter: node.Filter })), [],
    'completed benign members must be skipped before JSON and current-state evaluation');

    await db.updateTable('ai_job_input_members').set({ output: jsonb({ outcome: 'updated', rejectedTags: [] }) }).where('job_id', '=', last.id).execute();
    assert.equal((await readAiTaskQueue(db, input)).summary.total, 0);
    await sql`insert into ai_job_batches(job_id,batch_index,product_ids,product_count,status,step,unknown_requests,request_budget_used)
      values (${last.id},0,jsonb_build_array(${String(product.id)}::text),1,'failed','request',1,1)`.execute(db);
    assert.equal((await readAiTaskQueue(db, input)).summary.total, 1, 'lost requests also select members outside the stored-outcome index');
    await db.updateTable('ai_job_input_members').set({ output: jsonb({ outcome: 'review', rejectedTags: [] }) }).where('job_id', '=', last.id).execute();
    assert.equal((await readAiTaskQueue(db, input)).items[0]?.unclassified, 1, 'stored and unsaved failures must not double-count one member');
    await db.updateTable('ai_job_input_members').set({ output: jsonb({ outcome: 'updated', rejectedTags: [] }) }).where('job_id', '=', last.id).execute();
    await db.updateTable('ai_jobs').set({ status: 'running' }).where('id', '=', last.id).execute();
    await db.updateTable('ai_job_batches').set({ unknown_requests: 0, status: 'running', lease_until: new Date(Date.now() + 60000) })
      .where('job_id', '=', last.id).execute();
    assert.equal((await readAiTaskQueue(db, input)).summary.total, 0, 'a live request is not an unsaved failure');
    await db.updateTable('ai_job_batches').set({ lease_until: new Date(0) }).where('job_id', '=', last.id).execute();
    assert.equal((await readAiTaskQueue(db, input)).summary.total, 1);
    await db.updateTable('ai_job_batches').set({ unknown_requests: 0, confirmed_requests: 1 }).where('job_id', '=', last.id).execute();
    assert.equal((await readAiTaskQueue(db, input)).summary.total, 0);
    await db.updateTable('ai_job_input_members').set({ output: jsonb({ outcome: 'updated', rejectedTags: null }) }).where('job_id', '=', last.id).execute();
    await assert.rejects(readAiTaskQueue(db, input), { code: '22023' }, 'invalid current output must not disappear from validation');
  } finally {
    await db.destroy();
    await admin.query(`drop schema "${schema}" cascade`);
    await admin.end();
  }
});

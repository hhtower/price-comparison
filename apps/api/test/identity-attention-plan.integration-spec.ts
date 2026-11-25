import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { CompiledQuery, Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';
import { currentUnclassifiedQuery } from '../src/ai/ai-retry-pool.js';
import { PIPELINE_VERSIONS, pipelineVersionSnapshot } from '../src/ai/pipeline-versions.js';
import { jsonb, type DatabaseSchema } from '../src/database/types.js';

test('current identity results locate the matching member without rescanning its whole job', async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'Dedicated TEST_DATABASE_URL required');
  const schema = `identity_plan_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  const db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: new Pool({
    connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public`, max: 1,
  }) }) });
  try {
    const migration = await new Migrator({ db, provider: migrationProvider, migrationTableSchema: schema }).migrateToLatest();
    if (migration.error) throw migration.error;
    const shop = await db.insertInto('shops').values({ platform: 'test', name: 'Plan', url: 'https://identity.invalid' })
      .returning('id').executeTakeFirstOrThrow();
    const count = 300;
    await sql`insert into products(shop_id,external_id,name,normalized_key,url,content_version,content_fingerprint)
      select ${shop.id},n::text,'Product '||n,n::text,'',1,'fingerprint-'||n from generate_series(1,${count}) n`.execute(db);
    const job = await db.insertInto('ai_jobs').values({
      model: 'mock', job_type: 'manual_full', status: 'succeeded', total: BigInt(count),
      prompt_version: PIPELINE_VERSIONS.prompt, rule_version: PIPELINE_VERSIONS.standardizationPolicy,
      pipeline_versions: jsonb(pipelineVersionSnapshot('mock')),
    }).returning('id').executeTakeFirstOrThrow();
    await sql`insert into ai_job_inputs(job_id,input_id,fingerprint,payload)
      select ${job.id},id,content_fingerprint,'{}'::jsonb from products`.execute(db);
    await sql`insert into ai_job_input_members(job_id,input_id,product_id,content_version,standardization_revision,fingerprint,status)
      select ${job.id},id,id,content_version,standardization_revision,content_fingerprint,'unclassified' from products`.execute(db);
    await sql`insert into ai_standardization_results(job_id,input_id,product_id,content_version,fingerprint,status,reason_code,reason,decision)
      select ${job.id},id,id,content_version,content_fingerprint,'unclassified','unmatched','mock result','{}'::jsonb from products`.execute(db);
    await sql`analyze products,shops,ai_jobs,ai_job_input_members,ai_standardization_results`.execute(db);
    await sql`set jit = off`.execute(db);
    const query = currentUnclassifiedQuery(db).select(['p.id', 'r.job_id']).compile();
    assert.equal((await db.executeQuery(query)).rows.length, count);
    const result = await db.executeQuery<{ 'QUERY PLAN': Array<{ Plan: Record<string, any> }> }>(
      CompiledQuery.raw(`explain (analyze, buffers, format json) ${query.sql}`, query.parameters),
    );
    const nodes = (node: Record<string, any>): Array<Record<string, any>> => [node, ...(node.Plans ?? []).flatMap(nodes)];
    const scans = nodes(result.rows[0]!['QUERY PLAN'][0]!.Plan).filter(node =>
      node['Relation Name'] === 'ai_job_input_members' && node.Alias === 'member');
    assert.ok(scans.length);
    const visited = scans.reduce((sum, node) => sum +
      ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0)) * (node['Actual Loops'] ?? 0), 0);
    assert.ok(visited <= count * 2, `expected direct member lookups; visited ${visited} rows for ${count} results`);

    const missing = await db.selectFrom('products').select('id').orderBy('id').executeTakeFirstOrThrow();
    await db.deleteFrom('ai_standardization_results').where('product_id', '=', missing.id).execute();
    await db.insertInto('ai_job_batches').values({
      job_id: job.id, batch_index: 0, product_ids: jsonb([String(missing.id)]), product_count: 1n,
      status: 'failed', step: 'request', unknown_requests: 1n, request_budget_used: 1n,
    }).execute();
    await sql`insert into ai_jobs(model,total,status,job_type,prompt_version,rule_version,pipeline_versions)
      select 'mock',1,'succeeded',case when n<=50 then 'manual_full' else 'tag_extraction' end,
        ${PIPELINE_VERSIONS.prompt},${PIPELINE_VERSIONS.standardizationPolicy},
        ${JSON.stringify(pipelineVersionSnapshot('mock'))}::jsonb from generate_series(1,60) n`.execute(db);
    await sql`insert into ai_job_inputs(job_id,input_id,fingerprint,payload)
      select j.id,p.id,p.content_fingerprint,'{}'::jsonb from ai_jobs j cross join products p
      where j.id<>${job.id} and (j.job_type='tag_extraction' or p.id=${missing.id})`.execute(db);
    await sql`insert into ai_job_input_members(job_id,input_id,product_id,content_version,standardization_revision,fingerprint,status)
      select i.job_id,p.id,p.id,p.content_version,p.standardization_revision,p.content_fingerprint,'classified'
      from ai_job_inputs i join products p on p.id=i.input_id where i.job_id<>${job.id}`.execute(db);
    await sql`insert into ai_job_batches(job_id,batch_index,product_ids,product_count,status,step,unknown_requests,request_budget_used)
      select id,0,jsonb_build_array(${String(missing.id)}::text),1,'failed','request',1,1
      from ai_jobs where id<>${job.id} and job_type='manual_full'`.execute(db);
    await sql`analyze ai_jobs,ai_job_inputs,ai_job_input_members,ai_job_batches,ai_standardization_results`.execute(db);
    const withMissing = currentUnclassifiedQuery(db).select(['p.id', 'r.reason_code']).compile();
    const rows = (await db.executeQuery(withMissing)).rows;
    assert.equal(rows.length, count);
    assert.equal(rows.find(row => row.id === missing.id)?.reason_code, 'request_outcome_unknown');
    const missingPlan = await db.executeQuery<{ 'QUERY PLAN': Array<{ Plan: Record<string, any> }> }>(
      CompiledQuery.raw(`explain (analyze, buffers, format json) ${withMissing.sql}`, withMissing.parameters),
    );
    const fallbackScans = nodes(missingPlan.rows[0]!['QUERY PLAN'][0]!.Plan).filter(node =>
      node['Relation Name'] === 'ai_job_input_members' && node.Alias === 'm');
    assert.ok(fallbackScans.length);
    const fallbackVisits = fallbackScans.reduce((sum, node) => sum +
      ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0)) * (node['Actual Loops'] ?? 0), 0);
    assert.ok(fallbackVisits <= count * 2,
      `lost requests must skip unrelated attribute histories; visited ${fallbackVisits} member rows`);
  } finally {
    await db.destroy();
    await admin.query(`drop schema "${schema}" cascade`);
    await admin.end();
  }
});

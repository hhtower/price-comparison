import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { migrateToLatest } from '../scripts/migrate.js';
import { jsonb, type AiJobStatus, type DatabaseSchema } from '../src/database/types.js';
import { readAiTaskQueue } from '../src/ai/ai-task-queue.js';
import { PIPELINE_VERSIONS, pipelineVersionSnapshot } from '../src/ai/pipeline-versions.js';
import { STANDARDIZATION_PROMPT_VERSION } from '../src/ai/standardization-request.js';
import { IDENTITY_POLICY_VERSION } from '../src/standardization/identity-policy.js';
import { AiAdminController } from '../src/ai/ai-admin.controller.js';
import { AiRepository } from '../src/ai/ai.repository.js';

describe('normalization task queue over PostgreSQL', () => {
  let db: Kysely<DatabaseSchema>, admin: Pool, schema: string;
  let runningId: bigint, sourceRunId: bigint;
  before(async () => {
    const connectionString = process.env.TEST_DATABASE_URL;
    assert.ok(connectionString, 'a test database connection is required');
    schema = 'task_queue_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
    admin = new Pool({ connectionString });
    await admin.query('create schema "' + schema + '"');
    process.env.PG_SCHEMA = schema;
    db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, options: '-c search_path="' + schema + '",public', max: 4 }) }) });
    await migrateToLatest(db);
    const shop = await db.insertInto('shops').values({ platform: '16688', url: 'https://example.test/queue', name: '队列测试店', enabled: true }).returning('id').executeTakeFirstOrThrow();
    const run = await db.insertInto('fetch_runs').values({ shop_id: shop.id, status: 'succeeded', started_at: new Date() }).returning('id').executeTakeFirstOrThrow();
    sourceRunId = run.id;
    const currentConfig = { prompt_version: STANDARDIZATION_PROMPT_VERSION, rule_version: IDENTITY_POLICY_VERSION, pipeline_versions: jsonb(pipelineVersionSnapshot('mock')) };
    const states: AiJobStatus[] = ['queued', 'queued', 'running', 'paused', 'ready', 'failed', 'cancelled', 'ready_with_errors'];
    for (const status of states) {
      const row = await db.insertInto('ai_jobs').values({ status, total: 100n, model: 'mock', job_type: 'incremental', scope_shop_id: shop.id, source_fetch_run_id: run.id, ...currentConfig }).returning('id').executeTakeFirstOrThrow();
      if (status === 'running') runningId = row.id;
    }
    await db.insertInto('ai_jobs').values(Array.from({ length: 55 }, () => ({ status: 'succeeded' as const, total: 10n, processed: 10n, model: 'mock', unclassified: 0n, ...currentConfig }))).execute();
    await db.insertInto('ai_jobs').values({ status: 'succeeded', total: 10n, processed: 10n, unclassified: 2n, model: 'mock', ...currentConfig }).execute();
    // Version-expired jobs are display noise: they can never run again and must not be listed or counted.
    await db.insertInto('ai_jobs').values([
      { status: 'succeeded', total: 10n, processed: 10n, model: 'legacy', prompt_version: 'v6', rule_version: 'unversioned', pipeline_versions: jsonb({}) },
      { status: 'paused', total: 10n, model: 'legacy', prompt_version: 'v6', rule_version: 'unversioned', pipeline_versions: jsonb({}) },
    ]).execute();
    // Live publications are visible before the finalizer updates ai_jobs.processed.
    const product = await db.insertInto('products').values({ shop_id: shop.id, external_id: 'queue', name: 'Product', spec: '', normalized_key: 'product', url: 'https://example.test/product', content_version: 1n }).returningAll().executeTakeFirstOrThrow();
    await db.insertInto('ai_job_inputs').values({ job_id: runningId, input_id: product.id, fingerprint: 'queue-fingerprint', payload: jsonb({}), status: 'succeeded', input_bytes: 1n, estimated_tokens: 1n }).execute();
    await db.insertInto('ai_job_input_members').values({ job_id: runningId, input_id: product.id, product_id: product.id, content_version: 1n, standardization_revision: product.standardization_revision, status: 'unclassified' }).execute();
    await db.insertInto('ai_standardization_results').values({ job_id: runningId, product_id: product.id, input_id: product.id, content_version: 1n, fingerprint: 'queue-fingerprint', status: 'unclassified', reason_code: 'missing_identity', reason: 'mock', decision: jsonb({}) }).execute();
    const event = await db.insertInto('product_change_events').values({ product_id: product.id, shop_id: shop.id, content_version: 1n, fingerprint: 'queue-fingerprint', event_type: 'created', payload: jsonb({}), source_fetch_run_id: run.id }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('standardization_outbox').values({ product_id: product.id, event_id: event.id, fingerprint: 'queue-fingerprint', status: 'queued' }).execute();
  });
  after(async () => {
    await db?.destroy();
    if (admin && schema) await admin.query('drop schema if exists "' + schema + '" cascade');
    await admin?.end();
    delete process.env.PG_SCHEMA;
  });

  test('global totals include older unfinished jobs even when the newest 50 are completed', async () => {
    const first = await readAiTaskQueue(db, { status: 'all', limit: 50 });
    assert.equal(first.items.length, 50);
    assert.ok(first.items.every(row => row.status === 'succeeded'));
    assert.deepEqual(first.summary, { total: 64, unfinished: 5, queued: 2, running: 1, paused: 2, attention: 1, pendingProducts: 0, pendingEvents: 1,
      currentReasons: { technical_failure: 0, provider_policy_rejection: 0, insufficient_evidence: 1, not_sellable: 0, evidence_invalid: 0, attribute_conflict: 0, identity_conflict: 0, publication_blocked: 0, review_rejected: 0, other_unclassified: 0 } });
    assert.ok(first.nextCursor);
    const next = await readAiTaskQueue(db, { status: 'all', limit: 50, cursor: first.nextCursor });
    assert.equal(next.items.length, 14);
    assert.equal(next.nextCursor, null);
    const ids = [...first.items, ...next.items].map(row => BigInt(row.id));
    assert.equal(new Set(ids).size, 64);
    assert.ok(ids.every((id, index) => index === 0 || ids[index - 1]! > id));
    assert.deepEqual(next.summary, first.summary);
  });

  test('version-expired jobs stay off the board without changing totals', async () => {
    const all = await readAiTaskQueue(db, { status: 'all', limit: 100 });
    assert.equal(all.summary.total, 64, 'legacy jobs are not counted');
    assert.ok(all.items.every(row => row.model !== 'legacy'), 'legacy jobs are not listed');
    const unfinished = await readAiTaskQueue(db, { status: 'unfinished', limit: 100 });
    assert.equal(unfinished.summary.paused, 2, 'legacy paused job is not counted');
    assert.ok(unfinished.items.every(row => row.model !== 'legacy'));
  });

  test('unfinished tasks carry crawl provenance and current processed counts', async () => {
    const controller = new AiAdminController(new AiRepository(db));
    const page = await controller.taskQueue('50', undefined, 'unfinished');
    assert.equal(page.items.length, 5);
    const running = page.items.find(row => row.id === String(runningId));
    assert.equal(running?.processed, 1);
    assert.equal(running?.remaining, 0, 'historical total minus processed is not current product backlog');
    assert.equal(running?.sourceFetchRunId, String(sourceRunId));
    assert.equal(running?.shopName, '队列测试店');
    assert.doesNotThrow(() => JSON.stringify(page));
    const attention = await readAiTaskQueue(db, { status: 'attention', limit: 50 });
    assert.equal(attention.items.length, 1);
    assert.deepEqual(attention.items.map(row => row.id), [String(runningId)], 'only the current unresolved product creates attention');
  });

  test('invalid filters and cursors fail instead of silently showing a different queue', async () => {
    await assert.rejects(readAiTaskQueue(db, { status: 'invalid' }), { code: 'INVALID_TASK_FILTER' });
    await assert.rejects(readAiTaskQueue(db, { cursor: 'bad-cursor' }), { code: 'INVALID_CURSOR' });
  });

  test('explicit business refusals do not keep completed tasks in the attention queue', async () => {
    await db.updateTable('ai_standardization_results').set({ reason_code: 'not_sellable' }).where('job_id', '=', runningId).execute();
    assert.equal((await readAiTaskQueue(db, { status: 'attention' })).items.length, 0);
  });

  test('mixed-shop identity tasks scope pending, attention and reasons to selected products', async () => {
    const shops = await db.insertInto('shops').values(['A','B'].map(name => ({ platform:'test',name,url:`https://mixed.test/${name}`,enabled:true }))).returning('id').execute();
    const job = await db.insertInto('ai_jobs').values({ status:'running',total:3n,model:'mock',job_type:'manual_full',prompt_version:STANDARDIZATION_PROMPT_VERSION,rule_version:IDENTITY_POLICY_VERSION,pipeline_versions:jsonb(pipelineVersionSnapshot('mock')) }).returning('id').executeTakeFirstOrThrow();
    for (const [index, shop] of [shops[0]!,shops[1]!,shops[1]!].entries()) {
      const p = await db.insertInto('products').values({shop_id:shop.id,external_id:`mixed${index}`,name:'mixed',spec:'',normalized_key:`mixed${index}`,url:'https://mixed.test/p',content_version:1n}).returningAll().executeTakeFirstOrThrow();
      await db.insertInto('ai_job_inputs').values({job_id:job.id,input_id:p.id,fingerprint:'mixed'+index,payload:jsonb({}),input_bytes:1n,estimated_tokens:1n}).execute();
      await db.insertInto('ai_job_input_members').values({job_id:job.id,input_id:p.id,product_id:p.id,content_version:1n,standardization_revision:p.standardization_revision,status:index===2?'queued':index===1?'unclassified':'classified'}).execute();
      if(index===1) await db.insertInto('ai_standardization_results').values({job_id:job.id,product_id:p.id,input_id:p.id,content_version:1n,fingerprint:'mixed'+index,status:'unclassified',reason_code:'missing_identity',reason:'mock',decision:jsonb({})}).execute();
    }
    const clean = await readAiTaskQueue(db,{jobType:'identity',status:'all',scopeShopId:shops[0]!.id});
    assert.equal(clean.items[0]!.remaining,0);assert.equal(clean.items[0]!.unclassified,0);
    assert.equal(clean.summary.pendingProducts,0);assert.equal(clean.summary.currentReasons.insufficient_evidence,0);
    assert.equal((await readAiTaskQueue(db,{status:'attention',scopeShopId:shops[0]!.id})).items.length,0);
    const affected = await readAiTaskQueue(db,{status:'all',scopeShopId:shops[1]!.id});
    assert.equal(affected.summary.pendingProducts,1);assert.equal(affected.summary.currentReasons.insufficient_evidence,1);
    assert.equal(affected.items[0]!.unclassified,1);
  });
});

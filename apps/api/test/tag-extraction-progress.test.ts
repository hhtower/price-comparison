import assert from 'node:assert/strict';
import test from 'node:test';
import { Kysely, PostgresDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';
import { jsonb, type DatabaseSchema } from '../src/database/types.js';
import { getJobProgress, progressSnapshotFromRow } from '../src/ai/ai-progress.repository.js';
test('tag outcomes partition all members without trusting legacy counters',()=>{
 const p=progressSnapshotFromRow({job_type:'tag_extraction',member_total:12,member_queued:2,member_running:1,tag_counts:{updated:2,unchanged:1,empty:1,review:1,skipped:1,failed:1,cancelled:1,unrecorded:1},total:999,processed:999});
 assert.equal(p.rawProductCount,12); assert.equal(p.processed,'9');
 assert.equal(p.tagResults?.unrecorded,1); assert.equal(p.queued,'2');
});
test('stored acceptance counts remain separate from outcomes and failed request batches',()=>{
 const p=progressSnapshotFromRow({job_type:'tag_extraction',status:'succeeded',member_total:3,tag_counts:{updated:2,review:1},tag_accepted:5,tag_rejected:10,tag_partial:2,batch_total:1,batch_succeeded:1,batch_failed:0});
 assert.deepEqual(p.tagAcceptance,{acceptedTags:5,rejectedTags:10,partialProducts:2});
 assert.equal(p.tagResults?.updated,2); assert.equal(p.tagResults?.review,1);
 assert.equal(p.succeeded,'3'); assert.equal(p.failed,'0'); assert.equal(p.requests.failedBatches,0);
});
test('clean and legacy snapshots do not invent rejected tags',()=>{
 const p=progressSnapshotFromRow({job_type:'tag_extraction',member_total:2,tag_counts:{updated:1,unchanged:1},tag_accepted:3});
 assert.deepEqual(p.tagAcceptance,{acceptedTags:3,rejectedTags:0,partialProducts:0});
 assert.equal(progressSnapshotFromRow({job_type:'identity_extraction'}).tagAcceptance,undefined);
});
test('two-stage counts describe batches independently of terminal member outcomes', () => {
  const p = progressSnapshotFromRow({ job_type: 'tag_extraction', member_total: 8, tag_counts: { updated: 1 },
    extraction_completed: 3, review_queued: 2, review_running: 1, review_completed: 4, publication_queued: 5 });
  assert.deepEqual(p.tagStages, { extractionCompleted: 3, reviewQueued: 2, reviewRunning: 1, reviewCompleted: 4, publicationQueued: 5 });
  assert.equal(p.processed, '1');
  assert.equal(progressSnapshotFromRow({ job_type: 'identity_extraction', review_completed: 4 }).tagStages, undefined);
});

test('progress query counts stored acceptance for all completed members, excluding queued and processing output', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const schema = `tag_progress_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public` }) }) });
  try {
    await admin.query(`create schema "${schema}"`);
    const migration = await new Migrator({ db, provider: migrationProvider, migrationTableSchema: schema }).migrateToLatest();
    if (migration.error) throw migration.error;
    const shop = await db.insertInto('shops').values({ platform: 'test', name: 'test', url: 'https://test.invalid', enabled: true }).returning('id').executeTakeFirstOrThrow();
    const products = await db.insertInto('products').values(Array.from({ length: 9 }, (_, i) => ({
      shop_id: shop.id, external_id: String(i), name: '测试商品', spec: '一个月', source_category: '', source_data: jsonb({}), normalized_key: `progress-${i}`, url: 'https://test.invalid/p',
    }))).returning('id').execute();
    const job = await db.insertInto('ai_jobs').values({ total: 9n, model: 'mock', job_type: 'tag_extraction', status: 'running' }).returning('id').executeTakeFirstOrThrow();
    const inputId = products[0]!.id;
    await db.insertInto('ai_job_inputs').values({ job_id: job.id, input_id: inputId, fingerprint: 'test', payload: jsonb({}), content_version: 1n, input_bytes: 10n, estimated_tokens: 1n }).execute();
    const duration = { name: 'duration', value: '1 month', evidence: [{ path: 'spec', quote: '一个月' }] };
    const region = { name: 'region', value: 'US', evidence: [{ path: 'name', quote: '美区' }] };
    const rejected = { name: 'renewable', value: 'yes', evidence: [], reasonCode: 'citation_missing', reason: '缺少证据' };
    const cases = [
      { status: 'classified', output: { outcome: 'updated', acceptedTags: [duration, region], rejectedTags: [rejected, rejected, rejected] } },
      { status: 'classified', output: { outcome: 'review', acceptedTags: [duration], rejectedTags: [rejected, rejected] } },
      { status: 'classified', output: { outcome: 'updated', acceptedTags: [duration], rejectedTags: [] } },
      { status: 'classified', output: { outcome: 'unchanged', acceptedTags: [duration], rejectedTags: [] } },
      { status: 'classified', output: { outcome: 'empty', acceptedTags: [], rejectedTags: [] } },
      { status: 'classified', output: null },
      { status: 'queued', output: { outcome: 'updated', acceptedTags: [duration], rejectedTags: [rejected] } },
      { status: 'processing', output: { outcome: 'review', acceptedTags: [duration], rejectedTags: [rejected] } },
      { status: 'classified', output: { outcome: 'skipped', acceptedTags: [duration], rejectedTags: [rejected] } },
    ];
    await db.insertInto('ai_job_input_members').values(cases.map((item, i) => ({
      job_id: job.id, input_id: inputId, product_id: products[i]!.id, status: item.status, output: item.output ? jsonb(item.output) : null,
    }))).execute();
    const batches = [
      { status: 'succeeded', step: 'done', reference: null },
      { status: 'succeeded', step: 'done', reference: { tagStage: 'extract' } },
      { status: 'queued', step: 'request', reference: { tagStage: 'review' } },
      { status: 'running', step: 'request', reference: { tagStage: 'review' } },
      { status: 'succeeded', step: 'done', reference: { tagStage: 'review' } },
      { status: 'queued', step: 'publish', reference: { tagStage: 'review' } },
      { status: 'failed', step: 'request', reference: { tagStage: 'review' } },
      { status: 'cancelled', step: 'request', reference: { tagStage: 'review' } },
      { status: 'queued', step: 'request', reference: null },
      { status: 'running', step: 'publish', reference: { tagStage: 'review' } },
      { status: 'succeeded', step: 'request', reference: null },
    ] as const;
    await db.insertInto('ai_job_batches').values(batches.map((batch, i) => ({
      job_id: job.id, batch_index: i, round: 0, product_ids: jsonb([String(inputId)]), product_count: 1,
      status: batch.status, step: batch.step, reference_snapshot: batch.reference ? jsonb(batch.reference) : null,
    }))).execute();
    await db.insertInto('ai_job_batches').values({
      job_id: job.id, batch_index: -1, round: 0, product_ids: jsonb([]), product_count: 0,
      status: 'queued', step: 'request', reference_snapshot: jsonb({ tagStage: 'review' }),
    }).execute();
    await db.insertInto('ai_job_progress').values({ job_id: job.id, total: 9n }).execute();
    const p = await getJobProgress(db, job.id);
    assert.deepEqual(p?.tagAcceptance, { acceptedTags: 6, rejectedTags: 6, partialProducts: 2 });
    assert.deepEqual(p?.tagResults, { updated: 2, unchanged: 1, empty: 1, review: 1, skipped: 1, failed: 0, cancelled: 0, unrecorded: 1 });
    assert.equal(p?.processed, '7'); assert.equal(p?.queued, '1'); assert.equal(p?.running, '1');
    assert.equal(p?.failed, '0'); assert.equal(p?.requests.failedBatches, 1);
    assert.equal(p?.requests.totalBatches, 11);
    assert.deepEqual(p?.tagStages, { extractionCompleted: 2, reviewQueued: 1, reviewRunning: 1, reviewCompleted: 1, publicationQueued: 1 });
    const standardizationJob = await db.insertInto('ai_jobs').values({
      total: 9n, model: 'mock', job_type: 'manual_full', status: 'running',
    }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('ai_job_progress').values({ job_id: standardizationJob.id, total: 9n }).execute();
    await db.insertInto('ai_job_batches').values(batches.map((batch, i) => ({
      job_id: standardizationJob.id, batch_index: i, round: batch.reference?.tagStage === 'review' ? 1 : 0,
      product_ids: jsonb([String(inputId)]), product_count: 1, status: batch.status, step: batch.step,
      reference_snapshot: batch.reference ? jsonb({ standardizationStage: batch.reference.tagStage, generationBatchId: '1' }) : null,
    }))).execute();
    await db.insertInto('ai_job_batches').values([
      { job_id: standardizationJob.id, batch_index: -1, round: 1, product_ids: jsonb([]), product_count: 0,
        status: 'queued', step: 'request', reference_snapshot: jsonb({ standardizationStage: 'review' }) },
      { job_id: standardizationJob.id, batch_index: 20, round: 0, product_ids: jsonb([]), product_count: 0,
        status: 'queued', step: 'request', reference_snapshot: jsonb({ tagStage: 'review' }) },
    ]).execute();
    const standardization = await getJobProgress(db, standardizationJob.id);
    assert.deepEqual(standardization?.standardizationStages, {
      generationCompleted: 2, reviewQueued: 1, reviewRunning: 1, reviewCompleted: 1, publicationQueued: 1,
    });
    assert.equal(standardization?.tagStages, undefined);
    assert.equal(standardization?.results.classified, 0);
    assert.equal(standardization?.publication.publishedMembers, 0);
  } finally {
    await db.destroy();
    await admin.query(`drop schema if exists "${schema}" cascade`);
    await admin.end();
  }
});

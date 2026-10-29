import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { jsonb, type DatabaseSchema, type AiJobType } from '../src/database/types.js';
import { migrateToLatest } from '../scripts/migrate.js';
import { STANDARDIZATION_PROMPT_VERSION } from '../src/ai/standardization-request.js';
import { pipelineVersionSnapshot } from '../src/ai/pipeline-versions.js';
import { JobsRepository } from '../src/jobs/jobs.repository.js';
import { IDENTITY_POLICY_VERSION } from '../src/standardization/identity-policy.js';

describe('durable job queue leases', () => {
  let pool: Pool;
  let database: Kysely<DatabaseSchema>;
  let schemaName: string;
  let adminPool: Pool;
  let repository: JobsRepository;

  before(async () => {
    if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required for jobs integration tests');
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    schemaName = `jobs_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    adminPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await adminPool.query(`create schema "${schemaName}"`);
    process.env.PG_SCHEMA = schemaName;
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path="${schemaName}",public`, max: 4 });
    database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    await migrateToLatest(database);
    repository = new JobsRepository(database);
  });

  after(async () => {
    await database?.destroy();
    await adminPool?.query(`drop schema if exists "${schemaName}" cascade`);
    await adminPool?.end();
  });

  test('claims one queued AI batch when two workers race', async () => {
    const job = await database.insertInto('ai_jobs').values({ status: 'queued', total: 1n, model: 'test', prompt_version: STANDARDIZATION_PROMPT_VERSION, pipeline_versions: jsonb(pipelineVersionSnapshot('test')), rule_version: IDENTITY_POLICY_VERSION }).returning('id').executeTakeFirstOrThrow();
    const batch = await database.insertInto('ai_job_batches').values({ job_id: job.id, batch_index: 0n, product_ids: '[]' as never, product_count: 0n, status: 'queued' }).returning('id').executeTakeFirstOrThrow();
    const claims = await Promise.all([
      repository.claimNext('ai_batch', 'worker-a', 5000),
      repository.claimNext('ai_batch', 'worker-b', 5000),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(claims.find(Boolean)?.id, batch.id);
    assert.equal((await database.selectFrom('ai_jobs').select('status').where('id', '=', job.id).executeTakeFirstOrThrow()).status, 'running');
  });

  test('bulk AI claims skip a job whose parent row is locked', async () => {
    const job = await database.insertInto('ai_jobs').values({
      status: 'queued', total: 1n, model: 'test',
      prompt_version: STANDARDIZATION_PROMPT_VERSION, pipeline_versions: jsonb(pipelineVersionSnapshot('test')), rule_version: IDENTITY_POLICY_VERSION,
    }).returning('id').executeTakeFirstOrThrow();
    const batch = await database.insertInto('ai_job_batches').values({
      job_id: job.id, batch_index: 0n, product_ids: '[]' as never, product_count: 0n, status: 'queued',
    }).returning('id').executeTakeFirstOrThrow();
    const blocker = await pool.connect();
    let claimPromise: ReturnType<JobsRepository['claimAvailable']> | undefined;
    try {
      await blocker.query('begin');
      await blocker.query('select id from ai_jobs where id = $1 for update', [job.id]);
      claimPromise = repository.claimAvailable('ai_standardization', 'bulk-worker', 1, 5000);
      const outcome = await Promise.race([
        claimPromise.then(claims => ({ kind: 'claimed' as const, claims })),
        new Promise<{ kind: 'timeout' }>(resolve => setTimeout(() => resolve({ kind: 'timeout' }), 500)),
      ]);
      assert.deepEqual(outcome, { kind: 'claimed', claims: [] });
      assert.equal((await database.selectFrom('ai_job_batches').select('status').where('id', '=', batch.id).executeTakeFirstOrThrow()).status, 'queued');
    } finally {
      await blocker.query('rollback');
      blocker.release();
      await claimPromise?.catch(() => undefined);
      await database.updateTable('ai_job_batches').set({
        status: 'cancelled', claimed_by: null, claim_token: null, lease_until: null, finished_at: new Date(),
      }).where('id', '=', batch.id).execute();
    }
  });

  test('heartbeat only extends the current owner lease', async () => {
    const job = await database.insertInto('ai_jobs').values({ status: 'queued', total: 1n, model: 'test', prompt_version: STANDARDIZATION_PROMPT_VERSION, pipeline_versions: jsonb(pipelineVersionSnapshot('test')), rule_version: IDENTITY_POLICY_VERSION }).returning('id').executeTakeFirstOrThrow();
    const batch = await database.insertInto('ai_job_batches').values({ job_id: job.id, batch_index: 1n, product_ids: '[]' as never, product_count: 0n, status: 'queued' }).returning('id').executeTakeFirstOrThrow();
    const claim = await repository.claimNext('ai_batch', 'owner-a', 10_000);
    assert.ok(claim);
    await assert.rejects(repository.heartbeat('ai_batch', batch.id, 'owner-b'), /lease|owner/i);
    await repository.heartbeat('ai_batch', batch.id, 'owner-a');
    await assert.rejects(repository.complete('ai_batch', batch.id, 'owner-b'), /lease|owner/i);
    await database.updateTable('ai_job_batches').set({ step: 'done' }).where('id', '=', batch.id).execute();
    await repository.complete('ai_batch', batch.id, 'owner-a');
    await repository.complete('ai_batch', batch.id, 'owner-a');
  });

  test('expired leases can be reclaimed and stale owners cannot overwrite them', async () => {
    const shop = await database.insertInto('shops').values({ platform: 'lease', url: `https://lease-${Date.now()}.invalid`, name: 'lease' }).returning('id').executeTakeFirstOrThrow();
    const task = await database.insertInto('fetch_runs').values({ shop_id: shop.id, started_at: new Date(), status: 'queued' }).returning('id').executeTakeFirstOrThrow();
    const first = await repository.claimNext('fetch_run', 'crashed-worker', 1);
    assert.ok(first);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const recovered = await repository.claimNext('fetch_run', 'recovery-worker', 5000);
    assert.equal(recovered?.id, task.id);
    await assert.rejects(repository.complete('fetch_run', task.id, 'crashed-worker'), /lease|owner/i);
    await repository.fail('fetch_run', task.id, 'recovery-worker', 'temporary', { retry: true, backoffMs: 0 });
    const retried = await repository.claimNext('fetch_run', 'retry-worker', 5000);
    assert.equal(retried?.attempts, 3n);
  });

  test('kind-qualified transitions never cross identity tables', async () => {
    const shop = await database.insertInto('shops').values({ platform: 'same-id', url: `https://same-id-${Date.now()}.invalid`, name: 'same-id' }).returning('id').executeTakeFirstOrThrow();
    const job = await database.insertInto('ai_jobs').values({ status: 'queued', total: 1n, model: 'test', prompt_version: STANDARDIZATION_PROMPT_VERSION, pipeline_versions: jsonb(pipelineVersionSnapshot('test')), rule_version: IDENTITY_POLICY_VERSION }).returning('id').executeTakeFirstOrThrow();
    await database.insertInto('ai_job_batches').values({ id: 9001n, job_id: job.id, batch_index: 90n, product_ids: '[]' as never, product_count: 0n, status: 'queued', step: 'done' }).execute();
    await database.insertInto('fetch_runs').values({ id: 9001n, shop_id: shop.id, started_at: new Date(), status: 'queued' }).execute();
    await database.updateTable('ai_job_batches').set({ status: 'running', claimed_by: 'same-owner', lease_until: new Date(Date.now() + 5000) }).where('id', '=', 9001n).execute();
    await database.updateTable('fetch_runs').set({ status: 'running', claimed_by: 'same-owner', lease_until: new Date(Date.now() + 5000) }).where('id', '=', 9001n).execute();
    await repository.complete('ai_batch', 9001n, 'same-owner');
    assert.equal((await database.selectFrom('fetch_runs').select('status').where('id', '=', 9001n).executeTakeFirstOrThrow()).status, 'running');
    await repository.complete('fetch_run', 9001n, 'same-owner');
  });

  test('legacy running rows with null lease are recoverable', async () => {
    const shop = await database.insertInto('shops').values({ platform: 'legacy', url: `https://legacy-${Date.now()}.invalid`, name: 'legacy' }).returning('id').executeTakeFirstOrThrow();
    const task = await database.insertInto('fetch_runs').values({ shop_id: shop.id, started_at: new Date(), status: 'running', claimed_by: 'old-worker', lease_until: null }).returning('id').executeTakeFirstOrThrow();
    const claim = await repository.claimNext('fetch_run', 'new-worker', 5000);
    assert.equal(claim?.id, task.id);
  });

  test('throttled tag head keeps fresh batches outside its rolling window until it advances', async () => {
    await database.updateTable('ai_jobs').set({ status: 'cancelled' }).execute();
    const windowSize = Number(process.env.AI_CONCURRENCY || 2);
    const job = await database.insertInto('ai_jobs').values({
      status: 'queued', total: 2n, model: 'test', job_type: 'tag_extraction', priority: 9999,
      prompt_version: STANDARDIZATION_PROMPT_VERSION, pipeline_versions: jsonb(pipelineVersionSnapshot('test')),
      rule_version: IDENTITY_POLICY_VERSION,
    }).returning('id').executeTakeFirstOrThrow();
    const head = await database.insertInto('ai_job_batches').values({
      job_id: job.id, batch_index: 0n, product_ids: jsonb([]), product_count: 0n,
      status: 'queued', step: 'request', request_budget_used: 1, confirmed_requests: 1,
      error_source: 'provider_transient', available_at: new Date(Date.now() + 60_000),
    }).returning('id').executeTakeFirstOrThrow();
    const later = await database.insertInto('ai_job_batches').values({
      job_id: job.id, batch_index: BigInt(windowSize), product_ids: jsonb([]), product_count: 0n,
      status: 'queued', step: 'request',
    }).returning('id').executeTakeFirstOrThrow();
    assert.deepEqual(await repository.claimAvailable('ai_standardization', 'tag-backoff', windowSize, 5000), []);
    assert.equal(await repository.queueDepth('ai_batch'), 0);
    await database.updateTable('ai_job_batches').set({ available_at: new Date(0) }).where('id', '=', head.id).execute();
    const claims = await repository.claimAvailable('ai_standardization', 'tag-retry', windowSize, 5000);
    assert.deepEqual(claims.map(claim => claim.id), [head.id]);
    await database.updateTable('ai_job_batches').set({ status: 'succeeded', step: 'done' }).where('id', '=', head.id).execute();
    assert.equal((await repository.claimNext('ai_batch', 'tag-next', 5000))?.id, later.id);
  });

  async function queuedReviewJob(priority = 50, jobType: AiJobType = 'tag_extraction') {
    return database.insertInto('ai_jobs').values({
      status: 'queued', total: 1n, model: 'test', job_type: jobType, priority,
      prompt_version: STANDARDIZATION_PROMPT_VERSION, pipeline_versions: jsonb(pipelineVersionSnapshot('test')),
      rule_version: IDENTITY_POLICY_VERSION,
    }).returning('id').executeTakeFirstOrThrow();
  }

  test('disabling tag extraction keeps its batches queued while identity work remains claimable', async () => {
    const previous = process.env.AI_TAG_EXTRACTION_ENABLED;
    const tag = await queuedReviewJob(10000, 'tag_extraction');
    const identity = await queuedReviewJob(10000, 'manual_full');
    const batches = await database.insertInto('ai_job_batches').values([tag, identity].map(job => ({
      job_id: job.id, batch_index: 0n, product_ids: jsonb([]), product_count: 0n,
      status: 'queued' as const, step: 'request' as const,
    }))).returning(['id', 'job_id']).execute();
    try {
      process.env.AI_TAG_EXTRACTION_ENABLED = 'false';
      const claims = await repository.claimAvailable('ai_standardization', 'tags-disabled', 1, 5000);
      assert.deepEqual(claims.map(item => item.row.job_id), [identity.id]);
      assert.ok(claims.every(item => item.row.job_type !== 'tag_extraction'));
      assert.equal((await database.selectFrom('ai_job_batches').select('status').where('job_id', '=', tag.id).executeTakeFirstOrThrow()).status, 'queued');
      delete process.env.AI_TAG_EXTRACTION_ENABLED;
      assert.equal((await repository.claimNext('ai_batch', 'tags-enabled', 5000))?.id, batches.find(batch => batch.job_id === tag.id)!.id);
    } finally {
      if (previous === undefined) delete process.env.AI_TAG_EXTRACTION_ENABLED;
      else process.env.AI_TAG_EXTRACTION_ENABLED = previous;
      await database.updateTable('ai_jobs').set({ status: 'cancelled' }).where('id', 'in', [tag.id, identity.id]).execute();
    }
  });

  for (const jobType of ['tag_extraction', 'manual_full'] as const) {
    const reviewReference = jobType === 'tag_extraction'
      ? { tagStage: 'review', extractionBatchId: '1' }
      : { standardizationStage: 'review', generationBatchId: '1' };
    for (const stage of ['review', 'publish'] as const) test(`ready ${jobType} ${stage} precedes a thousand older generation batches`, async () => {
      await database.updateTable('ai_jobs').set({ status: 'cancelled' }).execute();
      const job = await queuedReviewJob(50, jobType);
      await database.insertInto('ai_job_batches').values(Array.from({ length: 1001 }, (_, index) => ({
        job_id: job.id, batch_index: BigInt(index), product_ids: jsonb([]), product_count: 0n,
        status: 'queued' as const, step: 'request' as const, available_at: new Date(0),
      }))).execute();
      const child = await database.insertInto('ai_job_batches').values({
        job_id: job.id, batch_index: 1001n, round: 1, product_ids: jsonb([]), product_count: 0n,
        status: 'queued', step: stage === 'publish' ? 'publish' : 'request',
        available_at: new Date(Date.now() - 1000),
        reference_snapshot: stage === 'review' ? jsonb(reviewReference) : null,
      }).returning('id').executeTakeFirstOrThrow();
      const claim = await repository.claimNext('ai_batch', `tag-${stage}-first`, 60000);
      assert.equal(claim?.id, child.id);
      assert.equal(await database.selectFrom('ai_job_batches').select('id').where('job_id', '=', job.id)
        .where('round', '=', 0).where('status', '=', 'running').executeTakeFirst(), undefined);
    });

    test(`${jobType} parent selection admits ready reviews but retains parent priority and FIFO`, async () => {
      await database.updateTable('ai_jobs').set({ status: 'cancelled' }).execute();
      const older = await queuedReviewJob(50, jobType);
      const newer = await queuedReviewJob(50, jobType);
      const higher = await queuedReviewJob(51, jobType);
      const createBatch = (jobId: bigint, review = false, index = 0) => database.insertInto('ai_job_batches').values({
        job_id: jobId, batch_index: review ? 1001n : BigInt(index), round: review ? 1 : 0, product_ids: jsonb([]), product_count: 0n,
        status: 'queued', step: 'request', available_at: new Date(review ? Date.now() - 1000 : 0),
        reference_snapshot: review ? jsonb(reviewReference) : null,
      }).returning('id').executeTakeFirstOrThrow();
      const extraction = await createBatch(older.id);
      const review = await createBatch(newer.id, true);
      const highPriority = await createBatch(higher.id);
      assert.equal((await repository.claimNext('ai_batch', 'parent-priority', 60000))?.id, highPriority.id);
      assert.equal((await repository.claimNext('ai_batch', 'review-priority', 60000))?.id, review.id);
      assert.equal((await repository.claimNext('ai_batch', 'extraction-next', 60000))?.id, extraction.id);
      const newest = await queuedReviewJob(50, jobType);
      const olderExtraction = await createBatch(older.id, false, 1);
      const newestExtraction = await createBatch(newest.id);
      await database.updateTable('ai_job_batches').set({ status: 'succeeded', step: 'done' }).where('id', '=', extraction.id).execute();
      assert.equal((await repository.claimNext('ai_batch', 'extraction-fifo', 60000))?.id, olderExtraction.id);
      assert.equal((await repository.claimNext('ai_batch', 'extraction-last', 60000))?.id, newestExtraction.id);
    });

    test(`${jobType} delayed and outside-window reviews do not boost their parent or bypass their own round window`, async () => {
      await database.updateTable('ai_jobs').set({ status: 'cancelled' }).execute();
      const older = await queuedReviewJob(50, jobType);
      const newer = await queuedReviewJob(50, jobType);
      const extractionIds = [];
      for (const job of [older, newer]) extractionIds.push((await database.insertInto('ai_job_batches').values({
        job_id: job.id, batch_index: 0n, product_ids: jsonb([]), product_count: 0n,
        status: 'queued', step: 'request', available_at: new Date(0),
      }).returning('id').executeTakeFirstOrThrow()).id);
      const head = await database.insertInto('ai_job_batches').values({
        job_id: newer.id, batch_index: 1001n, round: 1, product_ids: jsonb([]), product_count: 0n,
        status: 'queued', step: 'request', available_at: new Date(Date.now() + 60_000),
        reference_snapshot: jsonb(reviewReference),
      }).returning('id').executeTakeFirstOrThrow();
      const later = await database.insertInto('ai_job_batches').values({
        job_id: newer.id, batch_index: 1001n + BigInt(process.env.AI_CONCURRENCY || 2), round: 1,
        product_ids: jsonb([]), product_count: 0n, status: 'queued', step: 'request', available_at: new Date(0),
        reference_snapshot: jsonb(reviewReference),
      }).returning('id').executeTakeFirstOrThrow();
      assert.equal((await repository.claimNext('ai_batch', 'older-extraction', 60000))?.id, extractionIds[0]);
      assert.equal((await repository.claimNext('ai_batch', 'newer-extraction', 60000))?.id, extractionIds[1]);
      assert.equal(await repository.claimNext('ai_batch', 'blocked-review', 60000), null);
      await database.updateTable('ai_job_batches').set({ available_at: new Date(0) }).where('id', '=', head.id).execute();
      assert.equal((await repository.claimNext('ai_batch', 'review-head', 60000))?.id, head.id);
      await database.updateTable('ai_job_batches').set({ status: 'succeeded', step: 'done' }).where('id', '=', head.id).execute();
      assert.equal((await repository.claimNext('ai_batch', 'review-advanced', 60000))?.id, later.id);
    });
    }

    test('fetchRunCounts 汇总可领取、在途与最近失败的抓取实例', async () => {
      await database.deleteFrom('fetch_runs').execute();
      const shop = await database.insertInto('shops').values({ platform: 'counts', url: `https://counts-${Date.now()}.invalid`, name: 'counts' }).returning('id').executeTakeFirstOrThrow();
      const insertRun = (values: Record<string, unknown>) =>
        database.insertInto('fetch_runs').values({ shop_id: shop.id, started_at: new Date(), ...values } as never).execute();
      await insertRun({ status: 'queued' });
      await insertRun({ status: 'running', claimed_by: 'holder', lease_until: new Date(Date.now() + 60_000) });
      await insertRun({ status: 'running', claimed_by: 'crashed', lease_until: new Date(Date.now() - 60_000) });
      await insertRun({ status: 'failed', finished_at: new Date() });
      await insertRun({ status: 'failed', finished_at: new Date(Date.now() - 2 * 3_600_000) });
      await insertRun({ status: 'succeeded', finished_at: new Date() });
      assert.deepEqual(await repository.fetchRunCounts(), { queued: 2, running: 1, failedRecent: 1 });
    });
  });

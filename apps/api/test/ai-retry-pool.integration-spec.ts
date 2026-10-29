import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, test } from 'node:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { migrateToLatest } from '../scripts/migrate.js';
import { AiRepository } from '../src/ai/ai.repository.js';
import { JobsRepository } from '../src/jobs/jobs.repository.js';
import { AdminRepository } from '../src/admin/admin.repository.js';
import { jsonb, type DatabaseSchema } from '../src/database/types.js';
import { saveStandardizationThroughReview } from './standardization-review-fixture.js';

describe('global AI retry pool', () => {
  let db: Kysely<DatabaseSchema>;
  let admin: Pool;
  let schema: string;
  let repository: AiRepository;
  before(async () => {
    if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
    schema = `retry_pool_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
    admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`create schema "${schema}"`);
    process.env.PG_SCHEMA = schema;
    db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path="${schema}",public` }) }) });
    await migrateToLatest(db);
    repository = new AiRepository(db);
  });
  afterEach(async () => { await db.updateTable('shops').set({ enabled: false }).execute(); });
  after(async () => {
    await db?.destroy();
    if (admin && schema) await admin.query(`drop schema "${schema}" cascade`);
    await admin?.end(); delete process.env.PG_SCHEMA;
  });

  async function products(count: number) {
    const shop = await db.insertInto('shops').values({ name: 'pool shop', platform: 'test', url: `https://${randomUUID()}.invalid` }).returning('id').executeTakeFirstOrThrow();
    const ids: bigint[] = [];
    for (let index = 0; index < count; index++) {
      const product = await db.insertInto('products').values({ shop_id: shop.id, external_id: randomUUID(), name: `pool product ${index}`, spec: '', source_category: '', source_data: jsonb({}), normalized_key: randomUUID(), url: '', content_version: 1n }).returning('id').executeTakeFirstOrThrow();
      ids.push(product.id);
    }
    return ids;
  }
  async function fail(jobId: bigint, source = 'provider_unknown') {
    const batches = await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', jobId).execute();
    for (const batch of batches) {
      await db.updateTable('ai_job_batches').set({ status: 'running', claimed_by: 'test', lease_until: new Date(Date.now() + 60000) }).where('id', '=', batch.id).execute();
      await new JobsRepository(db).fail('ai_batch', batch.id, 'test', 'fixture failure', { retry: false, retryClass: source });
    }
  }
  async function failed(ids: bigint[], source = 'provider_unknown') {
    const job = await repository.createJob({ model: 'mock', productIds: ids });
    await fail(job.id, source);
    return job;
  }
  async function setReason(jobId: bigint, productId: bigint, reason: string) {
    await db.updateTable('ai_standardization_results').set({ reason_code: reason }).where('job_id', '=', jobId).where('product_id', '=', productId).execute();
  }
  const list = () => repository.listRetryPool({ limit: 100 });

  test('retry selection requires both result and member fingerprints to match current evidence', async () => {
    const ids = await products(1);
    const job = await failed(ids);
    assert.equal((await list()).total, 1);
    await db.updateTable('products').set({ content_fingerprint: 'new-source-fingerprint' }).where('id', '=', ids[0]!).execute();
    assert.equal((await list()).total, 0);
    await db.updateTable('ai_job_input_members').set({ fingerprint: 'new-source-fingerprint' }).where('job_id', '=', job.id).execute();
    assert.equal((await list()).total, 0);
    await db.updateTable('ai_standardization_results').set({ fingerprint: 'new-source-fingerprint' }).where('job_id', '=', job.id).execute();
    assert.equal((await list()).total, 1);
    const stale = await failed(ids);
    await db.updateTable('ai_standardization_results').set({ fingerprint: 'old-fingerprint' }).where('job_id', '=', stale.id).execute();
    await db.updateTable('ai_job_input_members').set({ fingerprint: 'old-fingerprint' }).where('job_id', '=', stale.id).execute();
    assert.equal((await list()).items[0]?.sourceJobId, String(job.id), 'a later stale result cannot hide a current failure');
  });

  test('combines three model failure reasons across tasks and excludes business results, manual edits and unavailable products', async () => {
    const ids = await products(9);
    const first = await failed(ids.slice(0, 5));
    const second = await failed(ids.slice(5));
    await setReason(first.id, ids[1]!, 'invalid_response');
    await setReason(first.id, ids[2]!, 'provider_error');
    await setReason(first.id, ids[3]!, 'not_sellable');
    await setReason(first.id, ids[4]!, 'insufficient_evidence');
    await db.updateTable('products').set({ standardization_revision: 1n }).where('id', '=', ids[6]!).execute();
    await db.updateTable('products').set({ standardization_locked: true }).where('id', '=', ids[7]!).execute();
    await db.updateTable('products').set({ deleted_at: new Date() }).where('id', '=', ids[8]!).execute();
    const page = await list();
    assert.equal(page.total, 4);
    assert.deepEqual(page.items.map(row => [row.productId, row.sourceJobId, row.reasonCode]), [
      [String(ids[0]), String(first.id), 'request_outcome_unknown'],
      [String(ids[1]), String(first.id), 'invalid_response'],
      [String(ids[2]), String(first.id), 'provider_error'],
      [String(ids[5]), String(second.id), 'request_outcome_unknown'],
    ]);
    const retry = await repository.retryPool({ model: 'mock', requestId: randomUUID() });
    assert.equal(retry.total, 4n);
    assert.equal(retry.retry_of_job_id, null, 'a mixed-source retry has no parent task');
    const members = await db.selectFrom('ai_job_input_members').select(['product_id', 'retry_source_job_id']).where('job_id', '=', retry.id).orderBy('product_id').execute();
    assert.deepEqual(members.map(row => [String(row.product_id), String(row.retry_source_job_id)]), page.items.map(row => [row.productId, row.sourceJobId]));
    assert.equal((await list()).total, 0);
  });

  test('uses newest task result even when older tasks finish late and paginates without duplicates', async () => {
    const ids = await products(4);
    const older = await failed(ids);
    const newer = await failed(ids.slice(0, 2), 'invalid_response');
    await setReason(newer.id, ids[0]!, 'insufficient_evidence');
    await db.updateTable('ai_standardization_results').set({ published_at: sql`now() + interval '1 day'` }).where('job_id', '=', older.id).execute();
    const first = await repository.listRetryPool({ limit: 1 });
    assert.equal(first.total, 3);
    assert.equal(first.items[0]?.sourceJobId, String(newer.id));
    const second = await repository.listRetryPool({ limit: 2, cursor: first.nextCursor! });
    assert.deepEqual([...first.items, ...second.items].map(row => row.productId), ids.slice(1).map(String));
    assert.equal(second.nextCursor, null);
  });

  test('excludes existing queued, running and paused work, including legacy retries, and returns failures to the same pool', async () => {
    const ids = await products(2);
    const original = await failed(ids);
    const legacy = await repository.createJob({ model: 'mock', productIds: [ids[0]!] });
    await db.updateTable('ai_jobs').set({ retry_of_job_id: original.id }).where('id', '=', legacy.id).execute();
    for (const status of ['queued', 'running', 'paused'] as const) {
      await db.updateTable('ai_jobs').set({ status }).where('id', '=', legacy.id).execute();
      assert.deepEqual((await list()).items.map(row => row.productId), [String(ids[1])]);
    }
    await db.updateTable('ai_jobs').set({ status: 'running' }).where('id', '=', legacy.id).execute();
    await fail(legacy.id, 'invalid_response');
    const page = await list();
    assert.equal(page.total, 2);
    assert.equal(page.items[0]?.sourceJobId, String(legacy.id));
    assert.equal(page.items[0]?.reasonCode, 'invalid_response');
  });

  test('a terminal batch failure enters the pool while other batches in that task still run', async () => {
    const ids = await products(2);
    const job = await repository.createJob({ model: 'mock', productIds: ids, batchSize: 1 });
    const batch = job.batches[0]!;
    await db.updateTable('ai_jobs').set({ status: 'running' }).where('id', '=', job.id).execute();
    await db.updateTable('ai_job_batches').set({ status: 'running', claimed_by: 'test', lease_until: new Date(Date.now() + 60000) }).where('id', '=', batch.id).execute();
    await new JobsRepository(db).fail('ai_batch', batch.id, 'test', 'stream interrupted', { retry: false, retryClass: 'provider_unknown' });
    const page = await list();
    assert.equal(page.total, 1);
    assert.equal(page.items[0]?.productId, String(batch.productIds[0]));
    const retry = await repository.retryPool({ model: 'mock', requestId: randomUUID() });
    assert.equal(retry.total, 1n);
    assert.equal((await db.selectFrom('ai_jobs').select('status').where('id', '=', job.id).executeTakeFirstOrThrow()).status, 'running');
    assert.equal((await db.selectFrom('ai_job_batches').select('status').where('id', '=', job.batches[1]!.id).executeTakeFirstOrThrow()).status, 'queued');
  });

  test('selected retries recheck eligibility and overlapping submissions never enqueue a product twice', async () => {
    const ids = await products(3);
    const original = await failed(ids);
    const history = await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', original.id).execute();
    await db.updateTable('products').set({ standardization_revision: 1n }).where('id', '=', ids[1]!).execute();
    const requestId = randomUUID();
    const [first, duplicate] = await Promise.all([
      repository.retryPool({ model: 'mock', requestId, productIds: ids.slice(0, 2) }),
      repository.retryPool({ model: 'mock', requestId, productIds: ids.slice(0, 2) }),
    ]);
    assert.equal(first.id, duplicate.id);
    assert.equal(first.total, 1n);
    const second = await repository.retryPool({ model: 'mock', requestId: randomUUID(), productIds: [ids[0]!, ids[2]!] });
    assert.equal(second.total, 1n);
    assert.deepEqual((await db.selectFrom('ai_job_input_members').select('product_id').where('job_id', '=', second.id).execute()).map(row => row.product_id), [ids[2]]);
    await assert.rejects(repository.retryPool({ model: 'mock', requestId: randomUUID() }), (error: { code?: string }) => error.code === 'AI_RETRY_NOT_FOUND');
    assert.deepEqual(await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', original.id).execute(), history);
    await fail(first.id, 'invalid_response');
    assert.equal((await list()).items[0]?.sourceJobId, String(first.id));
    assert.equal((await repository.retryPool({ model: 'mock', requestId, productIds: ids.slice(0, 2) })).id, first.id, 'a delayed duplicate cannot retry a fresh failure');
    const competing = await Promise.allSettled([
      repository.retryPool({ model: 'mock', requestId: randomUUID(), productIds: [ids[0]!] }),
      repository.retryPool({ model: 'mock', requestId: randomUUID(), productIds: [ids[0]!] }),
    ]);
    assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = competing.find(result => result.status === 'rejected');
    assert.equal(rejected?.status === 'rejected' && rejected.reason.code, 'AI_RETRY_NOT_FOUND');
  });

  test('successful retry leaves the pool and preserves a trace to the source result', async () => {
    const [id] = await products(1);
    await db.updateTable('products').set({ name: 'ChatGPT Plus account', source_data: jsonb({ description: 'delivered ChatGPT Plus account' }) }).where('id', '=', id!).execute();
    const source = await failed([id!]);
    const retry = await repository.retryPool({ model: 'mock', requestId: randomUUID() });
    const batch = await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', retry.id).executeTakeFirstOrThrow();
    const claim = { workerId: 'test', attempt: 1n, token: randomUUID() };
    await db.updateTable('ai_job_batches').set({ status: 'running', claimed_by: claim.workerId, attempts: claim.attempt,
      claim_token: claim.token, lease_until: new Date(Date.now() + 60000) }).where('id', '=', batch.id).execute();
    await repository.prepareBatch(batch.id);
    await repository.reserveBatchRequest(batch.id, claim);
    const evidence = [{ path: 'name', quote: 'ChatGPT Plus account' }];
    batch.id = await saveStandardizationThroughReview(db, repository, {
      jobId: retry.id, batchId: batch.id, claim, decision: {
        identities: [{ ref: 'i', family: 'openai', product: 'chatgpt', tier: 'plus', canonicalKey: 'openai|chatgpt|plus', reason: 'fixture', evidence }],
        items: [{ id: String(id), status: 'classified', identity: { kind: 'new', ref: 'i', canonicalKey: 'openai|chatgpt|plus' }, ruleIds: [], evidence, reasonCode: null, reason: 'fixture' }], missingIds: [],
      },
    });
    await db.updateTable('ai_job_batches').set({ status: 'running', claimed_by: 'test', lease_until: new Date(Date.now() + 60000) }).where('id', '=', batch.id).execute();
    await repository.publishBatch(batch.id);
    assert.equal((await list()).total, 0);
    assert.equal((await db.selectFrom('ai_standardization_results').select('status').where('job_id', '=', retry.id).executeTakeFirstOrThrow()).status, 'classified');
    assert.equal((await db.selectFrom('ai_job_input_members').select('retry_source_job_id').where('job_id', '=', retry.id).executeTakeFirstOrThrow()).retry_source_job_id, source.id);
  });

  test('oversized input requires review and cannot be retried with title-only evidence', async () => {
    const [id] = await products(1);
    const source = await failed([id!]);
    await setReason(source.id, id!, 'input_too_large');

    const page = await list();
    assert.equal(page.items.some(row => row.productId === String(id)), false);
    await assert.rejects(repository.retryPool({ model: 'mock', requestId: randomUUID(), productIds: [id!] }));
    const review = await repository.listGlobalResults({ limit: 100 });
    const current = review.items.find(row => row.productId === String(id));
    assert.equal(current?.processingDisposition, 'review_required');
  });

  test('business refusals are terminal while technical failures and missing publications remain pending', async () => {
    const ids = await products(5);
    const job = await failed(ids.slice(0, 4));
    await setReason(job.id, ids[0]!, 'not_sellable');
    await setReason(job.id, ids[1]!, 'insufficient_evidence');
    await setReason(job.id, ids[2]!, 'evidence_invalid');
    const standard = await db.insertInto('standard_products').values({ name: 'Lost publication' }).returning('id').executeTakeFirstOrThrow();
    await db.updateTable('ai_standardization_results').set({ status: 'classified', standard_product_id: standard.id, reason_code: null }).where('job_id', '=', job.id).where('product_id', '=', ids[3]!).execute();
    const admin = new AdminRepository(db);
    const pending = await admin.listProducts({ pending: true, limit: 100 });
    assert.deepEqual(pending.items.filter(row => ids.includes(row.id)).map(row => row.id), ids.slice(2));
    assert.equal(pending.items.find(row => row.id === ids[2])?.processing_summary?.reasonCode, 'evidence_invalid');
    assert.equal(pending.items.find(row => row.id === ids[2])?.processing_summary?.processingDisposition, 'retry_available');
    assert.equal(pending.items.find(row => row.id === ids[3])?.processing_summary?.reasonCode, 'unassigned');
    assert.equal(pending.items.find(row => row.id === ids[4])?.processing_summary?.reasonCode, 'not_processed');
    const completed = await admin.listProducts({ pending: false, limit: 100 });
    assert.deepEqual(completed.items.filter(row => ids.includes(row.id)).map(row => row.id), ids.slice(0, 2));
    assert.ok((await list()).items.some(row => row.productId === String(ids[2])));
    // Old refusals cannot hide changed evidence or a newer technical failure.
    await db.updateTable('products').set({ standardization_revision: 1n }).where('id', '=', ids[0]!).execute();
    await failed([ids[1]!]);
    const refreshed = await admin.listProducts({ pending: true, limit: 100 });
    assert.ok(ids.every(id => refreshed.items.some(row => row.id === id)));
    assert.equal(refreshed.items.find(row => row.id === ids[0])?.processing_summary?.reasonCode, 'source_changed');
    await setReason(job.id, ids[2]!, 'review_rejected');
    const review = await admin.listProducts({ pending: true, page: 1, limit: 100, shopId: pending.items.find(row => row.id === ids[2])!.shop_id });
    assert.equal(review.items.find(row => row.id === ids[2])?.processing_summary?.processingDisposition, 'review_required');
  });

  test('pending summaries use the same evidence snapshot as the listed products during concurrent updates', async () => {
    const [id] = await products(1);
    await failed([id!]);
    let changed = false;
    const connection = db.withPlugin({
      transformQuery: ({ node }) => node,
      async transformResult({ result }) {
        if (!changed && result.rows.some(row => row.id === id && 'standardization_outcome' in row)) {
          changed = true;
          await db.updateTable('products').set({ standardization_revision: sql`standardization_revision + 1` })
            .where('id', '=', id!).execute();
        }
        return result;
      },
    });
    const page = await new AdminRepository(connection).listProducts({ pending: true, limit: 100 });
    assert.equal(changed, true);
    assert.equal(page.items.find(row => row.id === id)?.processing_summary?.reasonCode, 'request_outcome_unknown');
    const refreshed = await new AdminRepository(db).listProducts({ pending: true, limit: 100 });
    assert.equal(refreshed.items.find(row => row.id === id)?.processing_summary?.reasonCode, 'source_changed');
  });

  test('backfill selects only missing current results and creates one shared job under concurrent submissions', async () => {
    const ids = await products(5);
    const completed = await failed([ids[1]!]);
    await setReason(completed.id, ids[1]!, 'not_sellable');
    await repository.createJob({ model: 'mock', productIds: [ids[2]!] });
    await db.updateTable('products').set({ standardization_locked: true }).where('id', '=', ids[3]!).execute();
    await db.updateTable('products').set({ deleted_at: new Date() }).where('id', '=', ids[4]!).execute();
    const preview = await repository.backfillMissingResults({ model: 'mock' });
    assert.deepEqual(preview.productIds, [String(ids[0])]);
    assert.equal(preview.jobId, null);
    const applied = await Promise.all([
      repository.backfillMissingResults({ model: 'mock', apply: true }),
      repository.backfillMissingResults({ model: 'mock', apply: true }),
    ]);
    assert.equal(applied.filter(result => result.jobId !== null).length, 1);
    assert.equal((await repository.backfillMissingResults({ model: 'mock' })).productIds.length, 0);
  });
});

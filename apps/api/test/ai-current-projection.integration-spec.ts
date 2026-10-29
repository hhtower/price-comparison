import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { migrateToLatest } from '../scripts/migrate.js';
import { jsonb, type DatabaseSchema } from '../src/database/types.js';
import { readAiTaskQueue } from '../src/ai/ai-task-queue.js';
import { readRetryPool } from '../src/ai/ai-retry-pool.js';
import { AiRepository } from '../src/ai/ai.repository.js';
import { pipelineVersionSnapshot } from '../src/ai/pipeline-versions.js';
import { STANDARDIZATION_PROMPT_VERSION } from '../src/ai/standardization-request.js';
import { IDENTITY_POLICY_VERSION } from '../src/standardization/identity-policy.js';

describe('current evidence queue projection', () => {
  let db: Kysely<DatabaseSchema>, admin: Pool, schema: string, shopId: bigint;
  before(async () => {
    assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required');
    schema = 'current_projection_' + Date.now();
    admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query('create schema "' + schema + '"');
    process.env.PG_SCHEMA = schema;
    db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: '-c search_path="' + schema + '",public' }) }) });
    await migrateToLatest(db);
    shopId = (await db.insertInto('shops').values({ platform: 'test', url: 'https://projection.invalid', name: 'projection', enabled: true }).returning('id').executeTakeFirstOrThrow()).id;
  });
  after(async () => { await db?.destroy(); if (admin && schema) await admin.query('drop schema "' + schema + '" cascade'); await admin?.end(); delete process.env.PG_SCHEMA; });

  async function result(name: string, reason = 'provider_error') {
    const product = await db.insertInto('products').values({ shop_id: shopId, external_id: name, name, normalized_key: name, url: '', content_version: 1n }).returningAll().executeTakeFirstOrThrow();
    const job = await db.insertInto('ai_jobs').values({
      status: 'succeeded', total: 1n, processed: 1n, unclassified: 1n, model: 'mock',
      prompt_version: STANDARDIZATION_PROMPT_VERSION, rule_version: IDENTITY_POLICY_VERSION,
      pipeline_versions: jsonb(pipelineVersionSnapshot('mock')),
    }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('ai_job_inputs').values({ job_id: job.id, input_id: product.id, fingerprint: 'fp', payload: jsonb({ name }), status: 'succeeded', input_bytes: 1n, estimated_tokens: 1n, content_version: 1n }).execute();
    await db.insertInto('ai_job_input_members').values({ job_id: job.id, input_id: product.id, product_id: product.id, content_version: 1n, standardization_revision: product.standardization_revision, fingerprint: 'fp', payload: jsonb({ name }), status: 'unclassified' }).execute();
    await db.insertInto('ai_standardization_results').values({ job_id: job.id, input_id: product.id, product_id: product.id, content_version: 1n, fingerprint: 'fp', status: 'unclassified', reason_code: reason, reason, decision: jsonb({}) }).execute();
    return { product, job };
  }

  test('stale content and already assigned products do not reenter retry pool or attention queue', async () => {
    const stale = await result('stale');
    const assigned = await result('assigned');
    const current = await result('current');
    await db.updateTable('products').set({ content_version: 2n }).where('id', '=', stale.product.id).execute();
    const standard = await db.insertInto('standard_products').values({ name: 'valid hidden assignment', hidden: true, verification_state: 'verified' }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('standard_product_members').values({ product_id: assigned.product.id, standard_product_id: standard.id, publication_state: 'published', assignment_source: 'ai' }).execute();
    const pool = await readRetryPool(db, { limit: 100 });
    assert.deepEqual(pool.items.map(row => row.productId), [String(current.product.id)]);
    const queue = await readAiTaskQueue(db, { status: 'attention', limit: 100 });
    assert.deepEqual(queue.items.map(row => row.id), [String(current.job.id)]);
    assert.equal(queue.summary.attention, 1);
  });

  test('current reasons distinguish policy, missing evidence and nonsellable decisions', async () => {
    await result('policy', 'provider_policy_rejection');
    await result('missing', 'insufficient_evidence');
    await result('notice', 'not_sellable');
    const queue = await readAiTaskQueue(db, { status: 'all', limit: 100 });
    assert.deepEqual(queue.summary.currentReasons, { technical_failure: 1, provider_policy_rejection: 1, insufficient_evidence: 1, not_sellable: 1, evidence_invalid: 0, attribute_conflict: 0, identity_conflict: 0, publication_blocked: 0, review_rejected: 0, other_unclassified: 0 });
    assert.equal((await readRetryPool(db, { limit: 100 })).total, 1, 'policy refusals are not an automatic replay pool');
  });

  test('manual isolation still protects current evidence without adding a global queue counter', async () => {
    const isolated = await result('unbound-review');
    await db.insertInto('product_standardization_decisions').values({ product_id: isolated.product.id, action: 'quarantine', source: 'application', reason: 'reviewed isolation', evidence_known: true, content_version: 1n, content_fingerprint: isolated.product.content_fingerprint, standardization_revision: isolated.product.standardization_revision, evidence_snapshot: jsonb({ name: 'unbound-review' }) }).execute();
    assert.equal((await readRetryPool(db, { limit: 100 })).total, 1);
    const queue = await readAiTaskQueue(db, { status: 'all' });
    assert.equal('manual_isolation' in queue.summary.currentReasons, false);
    assert.equal(queue.items.find(row => row.id === String(isolated.job.id))!.unclassified, 0);
    await db.updateTable('products').set({ content_version: 2n }).where('id', '=', isolated.product.id).execute();
    assert.equal((await readAiTaskQueue(db, { status: 'all' })).items.find(row => row.id === String(isolated.job.id))!.unclassified, 0);
  });

  test('pending product counts ignore stale members and already published AI assignments', async () => {
    const assigned = await result('pending-assigned');
    const stale = await result('pending-stale');
    const pending = await result('pending-current');
    for (const entry of [assigned, stale, pending]) {
      await db.updateTable('ai_jobs').set({ status: 'queued', processed: 0n }).where('id', '=', entry.job.id).execute();
      await db.updateTable('ai_job_input_members').set({ status: 'queued' }).where('job_id', '=', entry.job.id).execute();
    }
    await db.updateTable('products').set({ content_version: 2n }).where('id', '=', stale.product.id).execute();
    const standard = await db.insertInto('standard_products').values({ name: 'hidden published AI identity', hidden: true, verification_state: 'verified' }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('standard_product_members').values({ product_id: assigned.product.id, standard_product_id: standard.id, publication_state: 'published', assignment_source: 'ai' }).execute();
    const queue = await readAiTaskQueue(db, { status: 'unfinished', limit: 100 });
    assert.equal(queue.summary.pendingProducts, 1);
    assert.equal(queue.items.find(row => row.id === String(assigned.job.id))!.remaining, 0);
    assert.equal(queue.items.find(row => row.id === String(stale.job.id))!.remaining, 0);
    assert.equal(queue.items.find(row => row.id === String(pending.job.id))!.remaining, 1);
  });

  test('validation failures have separate current buckets without automatic replay', async () => {
    const before = await readRetryPool(db, { limit: 100 });
    for (const code of ['evidence_invalid', 'attribute_conflict', 'identity_conflict', 'publication_blocked']) await result(code, code);
    const { summary } = await readAiTaskQueue(db, { status: 'all' });
    for (const code of ['evidence_invalid', 'attribute_conflict', 'identity_conflict', 'publication_blocked']) assert.equal(summary.currentReasons[code], 1, code);
    const pool = await readRetryPool(db, { limit: 100 });
    assert.equal(pool.total, before.total + 2, 'citation and attribute failures remain available for explicit retry');
    assert.ok(!pool.items.some(row => ['identity_conflict', 'publication_blocked'].includes(row.reasonCode)));
  });

  test('unverified AI assignments remain unresolved but hiding a human assignment is not isolation', async () => {
    const unresolved = await result('quarantined-ai');
    const assigned = await result('hidden-human');
    const standard = await db.insertInto('standard_products').values({ name: 'quarantined', verification_state: 'quarantined' }).returning('id').executeTakeFirstOrThrow();
    const hidden = await db.insertInto('standard_products').values({ name: 'hidden-human', verification_state: 'verified', hidden: true }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('standard_product_members').values([
      { product_id: unresolved.product.id, standard_product_id: standard.id, publication_state: 'published', assignment_source: 'ai' },
      { product_id: assigned.product.id, standard_product_id: hidden.id, publication_state: 'published', assignment_source: 'human' },
    ]).execute();
    const pool = await readRetryPool(db, { limit: 100 });
    assert.ok(pool.items.some(item => item.productId === String(unresolved.product.id)));
    assert.ok(!pool.items.some(item => item.productId === String(assigned.product.id)));
    const queue = await readAiTaskQueue(db, { status: 'all' });
    assert.equal(queue.items.find(row => row.id === String(unresolved.job.id))!.unclassified, 1);
    assert.equal(queue.items.find(row => row.id === String(assigned.job.id))!.unclassified, 0);
  });

  test('global review shows the active merge target and excludes its retired source', async () => {
    const entry = await result('merged-assignment');
    const target = await db.insertInto('standard_products').values({ name: 'active target', verification_state: 'verified' }).returning('id').executeTakeFirstOrThrow();
    const merged = await db.insertInto('standard_products').values({ name: 'merged old row', verification_state: 'verified', merged_into_id: target.id }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('standard_product_members').values({ product_id: entry.product.id, standard_product_id: merged.id, assignment_source: 'ai', publication_state: 'published' }).execute();
    const repository = new AiRepository(db);
    const pending = await repository.listGlobalResults({ limit: 100 });
    const assignment = await db.selectFrom('standard_product_members').select('standard_product_id').where('product_id', '=', entry.product.id).executeTakeFirstOrThrow();
    assert.equal(assignment.standard_product_id, target.id, 'database merge routing assigns the active target');
    assert.ok(!pending.items.some(row => row.productId === String(entry.product.id)));
    assert.ok(!(await repository.listGlobalStandardProducts({ limit: 100 })).items.some(row => row.standardProductId === String(merged.id)));
    assert.equal((await repository.listGlobalStandardProductItems({ standardProductId: merged.id, limit: 100 })).items.length, 0);
  });
});

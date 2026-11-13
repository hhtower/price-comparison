import { tagRows } from './tag-fixtures.js';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { migrateToLatest } from '../scripts/migrate.js';
import { jsonb, type DatabaseSchema } from '../src/database/types.js';
import { AiRepository } from '../src/ai/ai.repository.js';
import { AiService } from '../src/ai/ai.service.js';
import { AiController } from '../src/ai/ai.controller.js';
import { AiAdminController } from '../src/ai/ai-admin.controller.js';
import { getJobProgress } from '../src/ai/ai-progress.repository.js';
import { AdminController } from '../src/admin/admin.controller.js';
import { AdminRepository } from '../src/admin/admin.repository.js';

let db: Kysely<DatabaseSchema>, admin: Pool, repository: AiRepository, controller: AiController;
const schema = `membership_feature_admin_${randomUUID().replaceAll('-', '')}`;
const previous = { ...process.env };
before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  Object.assign(process.env, { PG_SCHEMA: schema, AI_STANDARDIZATION_ENABLED: 'true', AI_TAG_EXTRACTION_ENABLED: 'false',
    AI_BASE_URL: 'http://localhost:1234/v1', AI_API_KEY: 'test', AI_MODEL: 'local-feature-test' });
  admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({
    connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public`,
  }) }) });
  await migrateToLatest(db);
  repository = new AiRepository(db);
  controller = new AiController(new AiService(repository), repository);
});
after(async () => {
  await db?.destroy();
  if (admin) { await admin.query(`drop schema if exists "${schema}" cascade`); await admin.end(); }
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  Object.assign(process.env, previous);
});

async function product() {
  const shop = await db.insertInto('shops').values({ name: 'feature admin', platform: 'test', enabled: true,
    url: `https://${randomUUID()}.invalid` }).returning('id').executeTakeFirstOrThrow();
  const item = await db.insertInto('products').values({
    shop_id: shop.id, external_id: '1', name: 'ChatGPT Plus 账号 保订阅', spec: '',
    normalized_key: randomUUID(), content_fingerprint: randomUUID(), url: '',
  }).returning('id').executeTakeFirstOrThrow();
  const standard = await db.insertInto('standard_products').values({ name: 'ChatGPT Plus',
    canonical_family: 'openai', canonical_product: 'chatgpt', canonical_tier: 'plus', verification_state: 'verified' })
    .returning('id').executeTakeFirstOrThrow();
  await db.insertInto('standard_product_members').values({ product_id: item.id, standard_product_id: standard.id,
    assignment_source: 'ai', publication_state: 'published' }).execute();
  return item;
}

test('feature admin previews published AI products, creates a separate job and exposes reviewed feature audits with tags disabled', async () => {
  const item = await product();
  const scope = { productIds: [String(item.id)] };
  const preview = await controller.previewFeatures(scope);
  assert.equal(preview.counts.eligible, 1);
  assert.equal(preview.model, 'local-feature-test');
  const created = await controller.createFeatures({ ...scope, requestId: randomUUID(), previewDigest: preview.previewDigest, acknowledgePossibleCharge: true });
  const jobId = BigInt(created.id);
  const job = await db.selectFrom('ai_jobs').selectAll().where('id', '=', jobId).executeTakeFirstOrThrow();
  assert.equal(job.job_type, 'membership_features');
  assert.equal(job.model, 'local-feature-test');
  assert.equal((await db.selectFrom('standard_product_members').select('publication_state')
    .where('product_id', '=', item.id).executeTakeFirstOrThrow()).publication_state, 'published');
  const queue = await new AiAdminController(repository).taskQueue('10', undefined, 'all', 'membership_features');
  assert.ok(queue.items.some(row => String(row.id) === String(jobId)));
  const classification = { kind: 'account', reason: 'llm_reviewed', durationSource: 'default', requiredWarrantyDays: null };
  const historicalOutput = {
    outcome: 'updated', classification, proposedMembershipKind: 'account', classificationReviewed: true,
    acceptedTags: Array.from({ length: 7 }, () => ({ name: 'warranty_scope', value: 'subscription', evidence: [{ path: 'name', quote: '保订阅' }] })),
    rejectedTags: [], diff: [], review: { mode: 'per_tag_binary', decisions: [true] },
  };
  await db.updateTable('ai_job_input_members').set({ status: 'classified', output: jsonb(historicalOutput) })
    .where('job_id', '=', jobId).where('product_id', '=', item.id).execute();
  const adminController = new AiAdminController(repository);
  const results = await adminController.featureResults(String(jobId), '10');
  assert.deepEqual(results.items[0]?.classification, classification);
  assert.equal(results.items[0]?.proposedMembershipKind, 'account');
  assert.equal(results.items[0]?.classificationReviewed, true);
  assert.equal(results.items[0]?.acceptedCount, 1, 'seven legacy facts represent one accepted product classification');
  assert.equal(results.items[0]?.rejectedCount, 0);
  assert.deepEqual((await getJobProgress(db, jobId))?.featureAcceptance, { acceptedProducts: 1, rejectedProducts: 0 });
  const member = await db.selectFrom('ai_job_input_members').select('input_id').where('job_id', '=', jobId).executeTakeFirstOrThrow();
  await db.updateTable('ai_job_batches').set({ validated_decision: jsonb({ items: [{
    productId: String(member.input_id), tags: [], rejectedTags: [], membershipKind: 'account',
  }] }) }).where('job_id', '=', jobId).execute();
  await db.insertInto('ai_job_batches').values({
    job_id: jobId, batch_index: 1, product_ids: jsonb([String(member.input_id)]), product_count: 1,
    reference_snapshot: jsonb({ tagStage: 'review' }),
    validated_decision: jsonb({ items: [{
      productId: String(member.input_id), tags: [], rejectedTags: [], membershipKind: 'account', reviewed: true, classificationReviewed: true,
    }] }),
  }).execute();
  const audit = await adminController.featureAudit(String(jobId), String(item.id));
  assert.deepEqual(audit.member.output.classification, classification);
  assert.equal(audit.member.output.acceptedTags[0].evidence[0].quote, '保订阅');
  assert.equal(audit.batches[0].proposed_membership_kind, 'account');
  assert.equal(audit.batches[0].classification_decision, null);
  assert.equal(audit.batches[1].proposed_membership_kind, 'account');
  assert.equal(audit.batches[1].classification_decision, true);
  for (const [output, accepted, rejected] of [
    [{ ...historicalOutput, classification: null }, 0, 0],
    [{ ...historicalOutput, outcome: 'skipped' }, 0, 0],
    [{ ...historicalOutput, outcome: 'failed', classification: null, classificationReviewed: false }, 0, 1],
  ] as const) {
    await db.updateTable('ai_job_input_members').set({ output: jsonb(output) }).where('job_id', '=', jobId).execute();
    const updated = await adminController.featureResults(String(jobId), '10');
    assert.equal(updated.items[0]?.acceptedCount, accepted);
    assert.equal(updated.items[0]?.rejectedCount, rejected);
    assert.deepEqual((await getJobProgress(db, jobId))?.featureAcceptance, { acceptedProducts: accepted, rejectedProducts: rejected });
  }
  await controller.cancel(String(jobId));
});

test('admin identifies unclassified AI quotes only from a published verified standard', async () => {
  const item = await product();
  const adminController = new AdminController(new AdminRepository(db));
  const read = async () => (await adminController.listProducts({})).items.find(row => row.id === String(item.id))!;
  assert.equal((await read()).isAiMembership, true);
  assert.equal((await read()).membershipFeatures, null);
  await db.insertInto('product_tags').values(tagRows({ product_id: item.id, name: 'region', value: 'us' })).execute();
  const tagged = await adminController.listTagProducts({ name: 'region', value: 'us' });
  assert.equal(tagged.items.find(row => row.id === String(item.id))?.isAiMembership, true);
  await db.updateTable('standard_product_members').set({ publication_state: 'provisional' }).where('product_id', '=', item.id).execute();
  assert.equal((await read()).isAiMembership, false);
  await db.updateTable('standard_product_members').set({ publication_state: 'published' }).where('product_id', '=', item.id).execute();
  const assignment = await db.selectFrom('standard_product_members').select('standard_product_id').where('product_id', '=', item.id).executeTakeFirstOrThrow();
  await db.updateTable('standard_products').set({ canonical_tier: 'free' }).where('id', '=', assignment.standard_product_id).execute();
  assert.equal((await read()).isAiMembership, false);
});

test('feature allPending creation uses the shared preparation and pause/resume/cancel paths without model calls', async () => {
  const item = await product();
  const created = await controller.createFeatures({ allPending: true, requestId: randomUUID(), acknowledgePossibleCharge: true });
  const jobId = BigInt(created.id);
  await controller.pause(String(jobId));
  assert.equal((await db.selectFrom('ai_jobs').select('status').where('id', '=', jobId).executeTakeFirstOrThrow()).status, 'paused');
  await controller.resume(String(jobId));
  const batch = await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', jobId).where('step', '=', 'prepare').executeTakeFirstOrThrow();
  const claim = { workerId: 'feature-admin-test', attempt: 1n, token: randomUUID() };
  await db.updateTable('ai_job_batches').set({ status: 'running', claimed_by: claim.workerId,
    claim_token: claim.token, attempts: claim.attempt, lease_until: new Date(Date.now() + 60_000) }).where('id', '=', batch.id).execute();
  await repository.prepareTagJob(batch.id, claim);
  assert.ok((await db.selectFrom('ai_job_input_members').select('product_id').where('job_id', '=', jobId).execute())
    .some(row => row.product_id === item.id));
  assert.ok((await db.selectFrom('ai_job_batches').select('request_budget_used').where('job_id', '=', jobId).execute())
    .every(row => row.request_budget_used === 0));
  await controller.cancel(String(jobId));
  assert.equal((await db.selectFrom('ai_jobs').select('status').where('id', '=', jobId).executeTakeFirstOrThrow()).status, 'cancelled');
});

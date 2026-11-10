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
  return db.insertInto('products').values({
    shop_id: shop.id, external_id: '1', name: 'ChatGPT Plus 账号 保订阅', spec: '',
    normalized_key: randomUUID(), content_fingerprint: randomUUID(), url: '',
  }).returning('id').executeTakeFirstOrThrow();
}

test('feature admin previews unassigned products, creates a separate job and exposes reviewed feature audits with tags disabled', async () => {
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
  assert.deepEqual(await db.selectFrom('standard_product_members').selectAll().where('product_id', '=', item.id).execute(), []);
  const queue = await new AiAdminController(repository).taskQueue('10', undefined, 'all', 'membership_features');
  assert.ok(queue.items.some(row => String(row.id) === String(jobId)));
  const classification = { kind: 'account', reason: 'llm_reviewed', durationSource: 'default', requiredWarrantyDays: null };
  await db.updateTable('ai_job_input_members').set({ status: 'classified', output: jsonb({
    outcome: 'updated', classification, proposedMembershipKind: 'account', classificationReviewed: true,
    acceptedTags: [{ name: 'warranty_scope', value: 'subscription', evidence: [{ path: 'name', quote: '保订阅' }] }],
    rejectedTags: [], diff: [], review: { mode: 'per_tag_binary', decisions: [true] },
  }) }).where('job_id', '=', jobId).where('product_id', '=', item.id).execute();
  const adminController = new AiAdminController(repository);
  const results = await adminController.featureResults(String(jobId), '10');
  assert.deepEqual(results.items[0]?.classification, classification);
  assert.equal(results.items[0]?.proposedMembershipKind, 'account');
  assert.equal(results.items[0]?.classificationReviewed, true);
  const audit = await adminController.featureAudit(String(jobId), String(item.id));
  assert.deepEqual(audit.member.output.classification, classification);
  assert.equal(audit.member.output.acceptedTags[0].evidence[0].quote, '保订阅');
  await controller.cancel(String(jobId));
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

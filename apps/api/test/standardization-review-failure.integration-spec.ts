import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Kysely, PostgresDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';
import { parseStandardizationProtocolResponse } from '../src/ai/ai.schemas.js';
import { finalizeOrScheduleMissing } from '../src/ai/standardization-finalizer.js';
import { jsonb, type DatabaseSchema, type JsonValue } from '../src/database/types.js';
import { seedMatchOnlyReviewFixture } from './standardization-review-fixture.js';

let db: Kysely<DatabaseSchema>, admin: Pool, schema: string;
before(async () => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url?.trim(), 'TEST_DATABASE_URL required');
  schema = `review_failure_${randomUUID().replaceAll('-', '')}`;
  admin = new Pool({ connectionString: url });
  await admin.query(`create schema "${schema}"`);
  db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({
    connectionString: url, options: `-c search_path=${schema},public`, max: 4,
  }) }) });
  const migrated = await new Migrator({ db, provider: migrationProvider, migrationTableSchema: schema }).migrateToLatest();
  if (migrated.error) throw migrated.error;
});
after(async () => {
  await db?.destroy();
  if (schema) await admin.query(`drop schema "${schema}" cascade`);
  await admin?.end();
});

const finalize = (jobId: bigint) => db.transaction().execute(tx => finalizeOrScheduleMissing(tx, jobId));

async function fixtureForFailure(errorSource = 'input_too_large') {
  const fixture = await seedMatchOnlyReviewFixture(db);
  const raw = { items: [
    fixture.raw.items[0]!,
    { ...fixture.raw.items[1]!, standardProductId: null },
  ] };
  fixture.proposals = parseStandardizationProtocolResponse(raw, fixture.inputs);
  await fixture.repo.persistBatchDecision(fixture.job.id, fixture.batch.id, fixture.proposals, {}, fixture.claim);
  const generation = await db.selectFrom('ai_job_batches').selectAll().where('id', '=', fixture.batch.id).executeTakeFirstOrThrow();
  const review = await db.updateTable('ai_job_batches').set({
    status: 'failed', error_source: errorSource, error: `Review ${errorSource}`,
    request_budget_used: errorSource === 'input_too_large' ? 0 : 1,
    confirmed_requests: errorSource === 'input_too_large' ? 0 : 1,
  }).where('job_id', '=', fixture.job.id).where('id', '!=', generation.id).returningAll().executeTakeFirstOrThrow();
  return { ...fixture, generation, review };
}

for (const errorSource of ['input_too_large', 'invalid_response', 'provider_error', 'request_outcome_unknown', 'result_not_saved']) {
  test(`${errorSource}: review failure produces technical outcomes for matched and unmatched proposals`, async () => {
    const fixture = await fixtureForFailure(errorSource);
    const standards = await db.selectFrom('standard_products').selectAll().orderBy('id').execute();
    await db.insertInto('standard_product_members').values(fixture.products.map(product => ({
      product_id: product.id, standard_product_id: fixture.standards[0]!.id,
      assignment_source: 'ai', publication_state: 'published' as const,
    }))).execute();
    const memberships = await db.selectFrom('standard_product_members').selectAll()
      .where('product_id', 'in', fixture.products.map(product => product.id)).orderBy('product_id').execute();
    await finalize(fixture.job.id);
    const results = await db.selectFrom('ai_standardization_results').selectAll()
      .where('job_id', '=', fixture.job.id).orderBy('product_id').execute();
    assert.equal(results.length, 2);
    assert.ok(results.every(row => row.status === 'unclassified' && row.reason_code === errorSource
      && row.standard_product_id === null && row.batch_id === fixture.review.id));
    for (const row of results) {
      assert.equal((row.decision as Record<string, JsonValue>).review, undefined);
      assert.equal(row.current_assignment_preserved, true);
    }
    assert.deepEqual(await db.selectFrom('standard_product_members').selectAll()
      .where('product_id', 'in', fixture.products.map(product => product.id)).orderBy('product_id').execute(), memberships);
    assert.deepEqual(await db.selectFrom('ai_batch_identity_mappings').selectAll()
      .where('batch_id', 'in', [fixture.generation.id, fixture.review.id]).execute(), []);
    assert.deepEqual(await db.selectFrom('standard_products').selectAll().orderBy('id').execute(), standards);
    assert.equal((await db.selectFrom('ai_jobs').select('status').where('id', '=', fixture.job.id).executeTakeFirstOrThrow()).status, 'ready_with_errors');
    await finalize(fixture.job.id);
    assert.deepEqual(await db.selectFrom('ai_standardization_results').selectAll()
      .where('job_id', '=', fixture.job.id).orderBy('product_id').execute(), results);
    assert.deepEqual(await db.selectFrom('ai_job_batches').selectAll()
      .where('job_id', '=', fixture.job.id).orderBy('batch_index').execute(), [fixture.generation, fixture.review]);
    const members = await db.selectFrom('ai_job_input_members').select('missing_reprocess_count')
      .where('job_id', '=', fixture.job.id).execute();
    assert.ok(members.every(member => member.missing_reprocess_count === 0));
  });
}
test('generation missing IDs throw before any checkpoint and remain technical failures on finalization', async () => {
  const fixture = await seedMatchOnlyReviewFixture(db);
  assert.throws(() => parseStandardizationProtocolResponse({ items: [fixture.raw.items[0]] }, fixture.inputs));
  assert.deepEqual(await db.selectFrom('ai_job_batches').selectAll().where('job_id', '=', fixture.job.id).execute(), [fixture.batch]);
  await db.updateTable('ai_job_batches').set({
    status: 'failed', error_source: 'invalid_response', error: 'Missing response ID',
  }).where('id', '=', fixture.batch.id).execute();
  await finalize(fixture.job.id);
  const results = await db.selectFrom('ai_standardization_results').select(['status', 'reason_code'])
    .where('job_id', '=', fixture.job.id).execute();
  assert.deepEqual(results, Array.from({ length: 2 }, () => ({ status: 'unclassified', reason_code: 'invalid_response' })));
  assert.equal((await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', fixture.job.id).execute()).length, 1);
});

test('review failure preserves the frozen source version after live evidence changes', async () => {
  const fixture = await fixtureForFailure('provider_error');
  await db.updateTable('products').set({ name: 'Changed source', content_version: 2n })
    .where('id', 'in', fixture.products.map(product => product.id)).execute();
  await finalize(fixture.job.id);
  const results = await db.selectFrom('ai_standardization_results').select(['content_version', 'fingerprint', 'reason_code'])
    .where('job_id', '=', fixture.job.id).orderBy('product_id').execute();
  assert.deepEqual(results, fixture.products.map(product => ({
    content_version: 1n, fingerprint: product.content_fingerprint, reason_code: 'provider_error',
  })));
});

for (const checkpoint of ['different job', 'unfinished', 'no decision', 'legacy identities', 'missing IDs']) {
  test(`review refuses a checkpoint with ${checkpoint} and finalization records only technical failure`, async () => {
    const fixture = await fixtureForFailure('invalid_response');
    if (checkpoint === 'different job') {
      const other = await db.insertInto('ai_jobs').values({ model: 'mock', status: 'running', total: 0n })
        .returning('id').executeTakeFirstOrThrow();
      await db.updateTable('ai_job_batches').set({ job_id: other.id }).where('id', '=', fixture.generation.id).execute();
    } else if (checkpoint === 'legacy identities' || checkpoint === 'missing IDs') {
      const invalid = checkpoint === 'legacy identities' ? { ...fixture.proposals, identities: [] }
        : { items: fixture.proposals.items.slice(0, 1), missingIds: [String(fixture.products[1]!.id)] };
      await db.updateTable('ai_job_batches').set({ validated_decision: jsonb(invalid as unknown as JsonValue) })
        .where('id', '=', fixture.generation.id).execute();
    } else {
      await db.updateTable('ai_job_batches').set(checkpoint === 'unfinished'
        ? { status: 'running', step: 'request' } : { validated_decision: null }).where('id', '=', fixture.generation.id).execute();
    }
    await assert.rejects(fixture.repo.getBatchRequest(fixture.review.id));
    assert.deepEqual(await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', fixture.job.id).execute(), []);
    await finalize(fixture.job.id);
    const results = await db.selectFrom('ai_standardization_results').select(['reason_code', 'standard_product_id'])
      .where('job_id', '=', fixture.job.id).execute();
    assert.deepEqual(results, Array.from({ length: 2 }, () => ({ reason_code: 'invalid_response', standard_product_id: null })));
  });
}

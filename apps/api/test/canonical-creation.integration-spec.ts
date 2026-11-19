import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';
import { jsonb, type DatabaseSchema, type JsonValue } from '../src/database/types.js';
import { StandardizationValidationError, type ParsedStandardizationResponse } from '../src/ai/ai.schemas.js';
import { saveStandardizationThroughReview, seedMatchOnlyReviewFixture } from './standardization-review-fixture.js';
import { DomainConflictError } from '../src/common/errors.js';
import { recordCandidateCatalogChanges } from '../src/catalog/catalog-version.repository.js';
import { IDENTITY_POLICY_VERSION } from '../src/standardization/identity-policy.js';
import { parseStandardizationProtocolResponse } from '../src/ai/ai.schemas.js';

let db: Kysely<DatabaseSchema>, admin: Pool;
const schema = 'canonical_creation_' + randomUUID().replaceAll('-', '');
before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required');
  admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: new Pool({
    connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path="${schema}",public`,
  }) }) });
  const migrated = await new Migrator({ db, provider: migrationProvider, migrationTableSchema: schema }).migrateToLatest();
  if (migrated.error) throw migrated.error;
});
after(async () => {
  await db?.destroy();
  await admin?.query(`drop schema if exists "${schema}" cascade`);
  await admin?.end();
});

type Fixture = Awaited<ReturnType<typeof seedMatchOnlyReviewFixture>>;
const review = (fixture: Fixture) => saveStandardizationThroughReview(db, fixture.repo, {
  jobId: fixture.job.id, batchId: fixture.batch.id, decision: fixture.proposals, claim: fixture.claim,
});
async function publish(fixture: Fixture, batchId: bigint) {
  await db.updateTable('ai_job_batches').set({
    status: 'running', lease_until: new Date(Date.now() + 60_000),
  }).where('id', '=', batchId).execute();
  await fixture.repo.publishBatch(batchId);
}
async function catalog() {
  return {
    standards: await db.selectFrom('standard_products').selectAll().orderBy('id').execute(),
    mappings: await db.selectFrom('ai_batch_identity_mappings').selectAll().orderBy('batch_id').orderBy('identity_ref').execute(),
  };
}

test('verified legacy standards without an approved definition are never retrieved as candidates', async () => {
  const fixture = await seedMatchOnlyReviewFixture(db, ['ChatGPT Plus']);
  const legacy = await db.insertInto('standard_products').values({
    name: 'ChatGPT Plus legacy', canonical_family: 'openai', canonical_product: 'chatgpt',
    canonical_tier: 'plus', verification_state: 'verified', catalog_definition: null,
  }).returning('id').executeTakeFirstOrThrow();
  const job = await fixture.repo.createJob({ model: 'mock', productIds: fixture.products.map(product => product.id) });
  const batchId = job.batches[0]!.id;
  await fixture.repo.prepareBatch(batchId);
  const request = await fixture.repo.getBatchRequest(batchId);
  assert.ok(request.candidates.length > 0);
  assert.ok(request.candidates.every(candidate => candidate.id !== String(legacy.id) && candidate.definition?.trim()));
  assert.ok(request.inputs.every(input => !input.candidateStandardProductIds.includes(String(legacy.id))));
  await fixture.repo.cancelJob(job.id);
});

test('reviewed SKU variants reuse one seeded standard without standard inserts or identity mapping writes', async () => {
  const fixture = await seedMatchOnlyReviewFixture(db, [
    'ChatGPT Plus monthly US', 'ChatGPT Plus annual EU', 'ChatGPT Plus shared account',
  ]);
  const before = await catalog();
  await admin.query(`create function "${schema}".forbid_identity_write() returns trigger language plpgsql as $$begin raise exception 'match-only identity write'; end$$`);
  await admin.query(`create trigger forbid_standard_creation before insert on "${schema}".standard_products for each row execute function "${schema}".forbid_identity_write()`);
  await admin.query(`create trigger forbid_identity_mapping before insert or update or delete on "${schema}".ai_batch_identity_mappings for each row execute function "${schema}".forbid_identity_write()`);
  try {
    const batchId = await review(fixture);
    await publish(fixture, batchId);
    const results = await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', fixture.job.id).orderBy('product_id').execute();
    assert.equal(results.length, 3);
    assert.ok(results.every(result => result.status === 'classified' && result.standard_product_id === fixture.standards[0]!.id));
    const memberships = await db.selectFrom('standard_product_members').selectAll()
      .where('product_id', 'in', fixture.products.map(product => product.id)).orderBy('product_id').execute();
    assert.equal(memberships.length, 3);
    await fixture.repo.publishBatch(batchId);
    assert.deepEqual(await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', fixture.job.id).orderBy('product_id').execute(), results);
    assert.deepEqual(await db.selectFrom('standard_product_members').selectAll()
      .where('product_id', 'in', fixture.products.map(product => product.id)).orderBy('product_id').execute(), memberships);
    assert.deepEqual(await catalog(), before);
  } finally {
    await admin.query(`drop trigger forbid_standard_creation on "${schema}".standard_products`);
    await admin.query(`drop trigger forbid_identity_mapping on "${schema}".ai_batch_identity_mappings`);
    await admin.query(`drop function "${schema}".forbid_identity_write()`);
  }
});

for (const shape of ['legacy identities array', 'new identity'] as const) {
  test(`${shape} cannot checkpoint or create a standard`, async () => {
    const fixture = await seedMatchOnlyReviewFixture(db, ['ChatGPT Plus']);
    const before = await catalog();
    const invalid = shape === 'legacy identities array'
      ? { ...fixture.proposals, identities: [] }
      : { ...fixture.proposals, items: fixture.proposals.items.map(item => ({
        ...item, identity: { kind: 'new', ref: 'invented', canonicalKey: 'invented:plan:standard' },
      })) };
    await assert.rejects(fixture.repo.persistBatchDecision(fixture.job.id, fixture.batch.id,
      invalid as unknown as ParsedStandardizationResponse, {}, fixture.claim));
    assert.deepEqual(await db.selectFrom('ai_job_batches').selectAll().where('job_id', '=', fixture.job.id).execute(), [fixture.batch]);
    assert.deepEqual(await catalog(), before);
  });

  test(`${shape} in a stored publication checkpoint is rejected atomically`, async () => {
    const fixture = await seedMatchOnlyReviewFixture(db, ['ChatGPT Plus']);
    const batchId = await review(fixture);
    const batch = await db.selectFrom('ai_job_batches').select('validated_decision').where('id', '=', batchId).executeTakeFirstOrThrow();
    const document = batch.validated_decision as unknown as ParsedStandardizationResponse;
    const invalid = shape === 'legacy identities array'
      ? { ...document, identities: [] }
      : { ...document, items: document.items.map(item => ({
        ...item, identity: { kind: 'new', ref: 'invented', canonicalKey: 'invented:plan:standard' },
      })) };
    await db.updateTable('ai_job_batches').set({ validated_decision: jsonb(invalid as unknown as JsonValue) }).where('id', '=', batchId).execute();
    const before = await catalog();
    await assert.rejects(publish(fixture, batchId));
    assert.deepEqual(await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', fixture.job.id).execute(), []);
    assert.deepEqual(await db.selectFrom('standard_product_members').selectAll().where('product_id', '=', fixture.products[0]!.id).execute(), []);
    assert.ok((await db.selectFrom('ai_publication_units').select('status').where('batch_id', '=', batchId).execute()).every(unit => unit.status === 'queued'));
    assert.deepEqual(await catalog(), before);
  });
}

test('a candidate frozen for another input cannot be mapped to this product', async () => {
  const fixture = await seedMatchOnlyReviewFixture(db);
  fixture.proposals.items[0]!.identity = { kind: 'existing', standardProductId: String(fixture.standards[1]!.id) };
  await assert.rejects(fixture.repo.persistBatchDecision(fixture.job.id, fixture.batch.id,
    fixture.proposals, {}, fixture.claim), (error: unknown) =>
    error instanceof StandardizationValidationError && error.diagnostic.code === 'unknown_candidate_id');
  assert.deepEqual(await db.selectFrom('ai_job_batches').selectAll().where('job_id', '=', fixture.job.id).execute(), [fixture.batch]);
  assert.deepEqual(await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', fixture.job.id).execute(), []);
});

test('all-rejected decisions cannot publish from a tampered generation-stage reference', async () => {
  const fixture = await seedMatchOnlyReviewFixture(db, ['ChatGPT Plus']);
  await db.insertInto('standard_product_members').values({
    product_id: fixture.products[0]!.id, standard_product_id: fixture.standards[0]!.id,
    assignment_source: 'ai', publication_state: 'published',
  }).execute();
  const batchId = await saveStandardizationThroughReview(db, fixture.repo, {
    jobId: fixture.job.id, batchId: fixture.batch.id, decision: fixture.proposals, claim: fixture.claim,
    approve: () => false,
  });
  const checkpoint = await db.selectFrom('ai_job_batches').selectAll().where('id', '=', batchId).executeTakeFirstOrThrow();
  const document = checkpoint.validated_decision as unknown as ParsedStandardizationResponse;
  assert.equal(document.items.length, 1);
  assert.equal(document.items[0]!.reasonCode, 'review_rejected');
  assert.deepEqual(document.items[0]!.review, { approved: false });
  const units = await db.selectFrom('ai_publication_units').selectAll().where('batch_id', '=', batchId).execute();
  const memberships = await db.selectFrom('standard_product_members').selectAll().where('product_id', '=', fixture.products[0]!.id).execute();
  const before = await catalog();
  await db.updateTable('ai_job_batches').set({ reference_snapshot: jsonb({
    ...fixture.batch.reference_snapshot as Record<string, JsonValue>, standardizationStage: 'generate',
  }) }).where('id', '=', batchId).execute();

  await assert.rejects(publish(fixture, batchId), /standardization publication requires reviewed decisions/);
  assert.deepEqual(await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', fixture.job.id).execute(), []);
  assert.deepEqual(await db.selectFrom('ai_publication_units').selectAll().where('batch_id', '=', batchId).execute(), units);
  assert.deepEqual(await db.selectFrom('standard_product_members').selectAll().where('product_id', '=', fixture.products[0]!.id).execute(), memberships);
  assert.deepEqual(await catalog(), before);
  assert.equal((await db.selectFrom('ai_job_batches').select('publication_cursor').where('id', '=', batchId).executeTakeFirstOrThrow()).publication_cursor, checkpoint.publication_cursor);

  await db.updateTable('ai_job_batches').set({ reference_snapshot: jsonb(checkpoint.reference_snapshot!) }).where('id', '=', batchId).execute();
  await publish(fixture, batchId);
  const result = await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', fixture.job.id).executeTakeFirstOrThrow();
  assert.equal(result.reason_code, 'review_rejected');
  assert.equal(result.current_assignment_preserved, true);
  assert.deepEqual(await db.selectFrom('standard_product_members').selectAll().where('product_id', '=', fixture.products[0]!.id).execute(), memberships);
});

for (const change of ['merged', 'quarantined', 'family', 'product', 'tier', 'name', 'missing definition', 'definition drift', 'missing candidate document'] as const) {
  test(`reviewed candidate ${change} blocks publication without alias or merge-chain fallback`, async () => {
    const fixture = await seedMatchOnlyReviewFixture(db, ['ChatGPT Plus']);
    const batchId = await review(fixture);
    const standardId = fixture.standards[0]!.id;
    if (change === 'merged') {
      const target = await db.insertInto('standard_products').values({
        name: 'ChatGPT Plus replacement', canonical_family: 'openai', canonical_product: 'chatgpt',
        canonical_tier: 'plus', verification_state: 'verified', catalog_definition: fixture.standards[0]!.catalog_definition,
      }).returning('id').executeTakeFirstOrThrow();
      await db.updateTable('standard_products').set({ merged_into_id: target.id }).where('id', '=', standardId).execute();
    } else if (change === 'missing candidate document') {
      await db.updateTable('ai_job_batches').set({ reference_snapshot: jsonb({
        ...fixture.batch.reference_snapshot as Record<string, JsonValue>, standardizationStage: 'review', candidates: [],
      }) }).where('id', '=', batchId).execute();
    } else {
      const update = change === 'quarantined' ? { verification_state: 'quarantined' as const }
        : change === 'missing definition' ? { catalog_definition: null }
          : change === 'definition drift' ? { catalog_definition: 'A different approved scope' }
            : change === 'name' ? { name: 'Changed approved name' }
        : change === 'family' ? { canonical_family: 'changed' }
          : change === 'product' ? { canonical_product: 'changed' } : { canonical_tier: 'changed' };
      await db.updateTable('standard_products').set(update).where('id', '=', standardId).execute();
    }
    const before = await catalog();
    if (change === 'missing candidate document') {
      await assert.rejects(publish(fixture, batchId), /snapshot|candidate/i);
      assert.deepEqual(await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', fixture.job.id).execute(), []);
      assert.deepEqual(await catalog(), before);
      return;
    }
    await publish(fixture, batchId);
    const result = await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', fixture.job.id).executeTakeFirstOrThrow();
    assert.equal(result.status, 'unclassified');
    assert.equal(result.reason_code, 'publication_blocked');
    assert.equal(result.standard_product_id, null);
    assert.equal(result.current_assignment_preserved, true);
    assert.deepEqual(await db.selectFrom('standard_product_members').selectAll().where('product_id', '=', fixture.products[0]!.id).execute(), []);
    assert.deepEqual(await catalog(), before);
  });
}

for (const strategyVersion of ['bounded-candidate-v1', 'evidence-canonical-candidate-v2']) {
  test(`legacy snapshot ${strategyVersion} cannot prepare or checkpoint match-only work`, async () => {
    const fixture = await seedMatchOnlyReviewFixture(db, ['ChatGPT Plus']);
    await db.updateTable('ai_job_batches').set({ reference_snapshot: jsonb({
      ...fixture.batch.reference_snapshot as Record<string, JsonValue>, strategyVersion,
    }) }).where('id', '=', fixture.batch.id).execute();
    await assert.rejects(fixture.repo.prepareBatch(fixture.batch.id), /snapshot.*stale|stale.*snapshot/i);
    await assert.rejects(fixture.repo.persistBatchDecision(fixture.job.id, fixture.batch.id, fixture.proposals, {}, fixture.claim));
    assert.deepEqual(await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', fixture.job.id).execute(), []);
  });
}

for (const previouslyLoaded of [false, true]) {
  test(`empty admitted catalog blocks preparation without consuming requests (${previouslyLoaded ? 'after last definition removed' : 'initial load'})`, async () => {
    await db.updateTable('standard_products').set({ catalog_definition: null }).execute();
    const fixture = await seedMatchOnlyReviewFixture(db, ['ChatGPT Plus']);
    await db.updateTable('standard_products').set({ catalog_definition: null }).where('id', '=', fixture.standards[1]!.id).execute();
    await db.updateTable('ai_job_batches').set({ reference_snapshot: null, request_budget_used: 0 }).where('id', '=', fixture.batch.id).execute();
    await db.insertInto('standard_product_members').values({
      product_id: fixture.products[0]!.id, standard_product_id: fixture.standards[0]!.id,
      assignment_source: 'ai', publication_state: 'published',
    }).execute();
    if (previouslyLoaded) {
      await fixture.repo.prepareBatch(fixture.batch.id);
      assert.equal((await fixture.repo.getBatchRequest(fixture.batch.id)).candidates.length, 1);
      await db.updateTable('ai_job_batches').set({ reference_snapshot: null }).where('id', '=', fixture.batch.id).execute();
    }
    await db.updateTable('standard_products').set({ catalog_definition: null }).where('id', '=', fixture.standards[0]!.id).execute();
    await recordCandidateCatalogChanges(db, [fixture.standards[0]!.id], IDENTITY_POLICY_VERSION);
    const before = await db.selectFrom('ai_job_batches').selectAll().where('id', '=', fixture.batch.id).executeTakeFirstOrThrow();
    const memberships = await db.selectFrom('standard_product_members').selectAll().where('product_id', '=', fixture.products[0]!.id).execute();
    await assert.rejects(fixture.repo.prepareBatch(fixture.batch.id), (error: unknown) =>
      error instanceof DomainConflictError && error.code === 'STANDARD_CATALOG_EMPTY');
    assert.equal(before.request_budget_used, 0);
    assert.deepEqual(await db.selectFrom('ai_job_batches').selectAll().where('id', '=', fixture.batch.id).executeTakeFirstOrThrow(), before);
    assert.deepEqual(await db.selectFrom('standard_product_members').selectAll().where('product_id', '=', fixture.products[0]!.id).execute(), memberships);
    assert.deepEqual(await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', fixture.job.id).execute(), []);
  });
}

test('nonempty admitted catalog allows unmatched when one input retrieves zero candidates', async () => {
  await db.updateTable('standard_products').set({ catalog_definition: null }).execute();
  const fixture = await seedMatchOnlyReviewFixture(db, ['zzzxvnooverlap999']);
  await db.updateTable('ai_job_batches').set({ reference_snapshot: null, request_budget_used: 0 }).where('id', '=', fixture.batch.id).execute();
  await fixture.repo.prepareBatch(fixture.batch.id);
  const request = await fixture.repo.getBatchRequest(fixture.batch.id);
  assert.deepEqual(request.inputs[0]!.candidateStandardProductIds, []);
  assert.deepEqual(request.candidates, []);
  assert.equal(await fixture.repo.reserveBatchRequest(fixture.batch.id, fixture.claim), 'reserved');
  fixture.proposals = parseStandardizationProtocolResponse({
    items: fixture.raw.items.map(item => ({ ...item, standardProductId: null })),
  }, [{ id: String(fixture.products[0]!.id), candidateStandardProductIds: [] }]);
  const batchId = await review(fixture);
  await publish(fixture, batchId);
  const result = await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', fixture.job.id).executeTakeFirstOrThrow();
  assert.equal(result.reason_code, 'unmatched');
  assert.deepEqual(result.evidence, fixture.raw.items[0]!.evidence);
});

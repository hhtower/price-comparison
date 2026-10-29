import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { migrateToLatest } from '../scripts/migrate.js';
import { AiRepository } from '../src/ai/ai.repository.js';
import { jsonb, type DatabaseSchema } from '../src/database/types.js';
import { recordManualDecisions } from '../src/standardization/decision-history.js';
import { hasActiveStandardizationWork, hasCurrentStandardizationResult, productStandardizationOutcome } from '../src/ai/product-standardization-state.js';

describe('global standard product review', () => {
  let db: Kysely<DatabaseSchema>;
  let admin: Pool;
  let schema: string;
  let repository: AiRepository;
  before(async () => {
    if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
    schema = `global_review_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
    admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`create schema "${schema}"`);
    process.env.PG_SCHEMA = schema;
    db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path="${schema}",public` }) }) });
    await migrateToLatest(db);
    repository = new AiRepository(db);
  });
  after(async () => {
    await db?.destroy();
    if (admin && schema) await admin.query(`drop schema "${schema}" cascade`);
    await admin?.end(); delete process.env.PG_SCHEMA;
  });
  async function product(name: string, enabled = true) {
    const shop = await db.insertInto('shops').values({ name, enabled, platform: 'test', url: `https://${randomUUID()}.invalid` }).returning('id').executeTakeFirstOrThrow();
    return db.insertInto('products').values({ shop_id: shop.id, external_id: randomUUID(), name, spec: '', source_category: '', source_data: jsonb({}), normalized_key: randomUUID(), url: '', content_version: 1n }).returningAll().executeTakeFirstOrThrow();
  }
  async function standard(name: string, verified = true) {
    return db.insertInto('standard_products').values({ name, platform: 'test', standard_key: null, verification_state: verified ? 'verified' : 'quarantined' }).returning('id').executeTakeFirstOrThrow();
  }
  async function result(productId: bigint, standardId: bigint | null, reasonCode = 'provider_error') {
    const job = await repository.createJob({ model: 'mock', productIds: [productId] });
    const input = await db.selectFrom('ai_job_input_members').selectAll().where('job_id', '=', job.id).executeTakeFirstOrThrow();
    await db.insertInto('ai_standardization_results').values({
      job_id: job.id, product_id: productId, input_id: input.input_id, content_version: input.content_version,
      fingerprint: input.fingerprint, status: standardId === null ? 'unclassified' : 'classified',
      standard_product_id: standardId, reason_code: standardId === null ? reasonCode : null,
      reason: `reason ${job.id}`, decision: jsonb({}), evidence: jsonb(['old evidence']),
      tags: jsonb([{ name: '周期', value: '旧标签' }]), published_at: new Date(),
    }).execute();
    await db.updateTable('ai_jobs').set({ status: 'succeeded' }).where('id', '=', job.id).execute();
    return job.id;
  }

  test('a different fingerprint cannot count as current results or active work at the same version', async () => {
    const p = await product('fingerprint cutover');
    const jobId = await result(p.id, null, 'not_sellable');
    const state = () => db.selectFrom('products as p').select([
      hasCurrentStandardizationResult().as('handled'),
      hasActiveStandardizationWork.as('active'),
      productStandardizationOutcome().as('outcome'),
    ]).where('p.id', '=', p.id).executeTakeFirstOrThrow();
    assert.equal((await state()).handled, true);
    assert.equal((await state()).outcome, 'cannot_process');
    await db.updateTable('ai_jobs').set({ status: 'queued' }).where('id', '=', jobId).execute();
    assert.equal((await state()).active, true);
    await db.updateTable('products').set({ content_fingerprint: 'new-source-fingerprint' }).where('id', '=', p.id).execute();
    assert.deepEqual(await state(), { handled: false, active: false, outcome: null });
    const pending = await repository.backfillMissingResults({ model: 'mock' });
    assert.ok(pending.productIds.includes(String(p.id)));
    await db.updateTable('ai_job_input_members').set({ fingerprint: 'new-source-fingerprint' }).where('job_id', '=', jobId).execute();
    assert.equal((await state()).handled, false, 'a stale result remains invalid even if its member matches');
    await db.updateTable('ai_jobs').set({ status: 'succeeded' }).where('id', '=', jobId).execute();
    const event = await db.insertInto('product_change_events').values({
      product_id: p.id, shop_id: p.shop_id, content_version: p.content_version,
      fingerprint: 'old-fingerprint', event_type: 'evidence_changed', payload: jsonb({}),
    }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('standardization_outbox').values({
      product_id: p.id, event_id: event.id, fingerprint: 'old-fingerprint',
    }).execute();
    assert.ok((await repository.backfillMissingResults({ model: 'mock' })).productIds.includes(String(p.id)),
      'an old-fingerprint event at the same version cannot block backfill');
    assert.equal((await repository.listGlobalResults({ limit: 100 })).items.find(item => item.productId === String(p.id))?.reasonCode,
      'source_changed');
    await db.updateTable('products').set({ deleted_at: new Date() }).where('id', '=', p.id).execute();
  });

  test('current members span tasks and manual assignments without duplicates or stale evidence', async () => {
    const a = await standard('global A');
    const b = await standard('global B');
    const p1 = await product('first');
    const p2 = await product('second');
    const manual = await product('manual');
    const disabled = await product('disabled', false);
    const deleted = await product('deleted');
    const j1 = await result(p1.id, a.id);
    const j2 = await result(p1.id, a.id);
    const j3 = await result(p2.id, a.id);
    await db.insertInto('standard_product_members').values([
      { product_id: p1.id, standard_product_id: a.id, assignment_source: 'ai', decision_version: j2 },
      { product_id: p2.id, standard_product_id: a.id, assignment_source: 'ai', decision_version: j3 },
      { product_id: manual.id, standard_product_id: b.id, assignment_source: 'human' },
      { product_id: disabled.id, standard_product_id: a.id },
      { product_id: deleted.id, standard_product_id: a.id },
    ]).execute();
    await db.updateTable('products').set({ deleted_at: new Date() }).where('id', '=', deleted.id).execute();
    await db.insertInto('product_tags').values({ product_id: p1.id, name: '周期', value: '当前标签' }).execute();
    const page = await repository.listGlobalStandardProducts({ limit: 1, includeTotal: true });
    assert.equal(page.total, 2);
    assert.equal(page.items[0]?.productCount, 2);
    assert.equal(page.items[0]?.shopCount, 2);
    const next = await repository.listGlobalStandardProducts({ limit: 1, cursor: page.nextCursor! });
    assert.equal(next.items[0]?.standardProductId, String(b.id));
    assert.equal(next.nextCursor, null);
    const first = await repository.listGlobalStandardProductItems({ standardProductId: a.id, limit: 1 });
    assert.equal(first.items[0]?.sourceJobId, String(j2));
    assert.notEqual(first.items[0]?.sourceJobId, String(j1));
    assert.deepEqual(first.items[0]?.tags, [{ name: '周期', value: '当前标签' }]);
    const second = await repository.listGlobalStandardProductItems({ standardProductId: a.id, limit: 1, cursor: first.nextCursor! });
    assert.equal(second.items[0]?.productId, String(p2.id));
    assert.equal(second.nextCursor, null);
    // A later failed task does not replace the evidence of the current assignment.
    await result(p1.id, null);
    assert.equal((await repository.listGlobalStandardProductItems({ standardProductId: a.id, limit: 10 })).items[0]?.sourceJobId, String(j2));
    // Human reassignment must not inherit any historical AI evidence or source task.
    await db.updateTable('standard_product_members').set({ standard_product_id: b.id, assignment_source: 'human', decision_version: 0n }).where('product_id', '=', p1.id).execute();
    const reassigned = await repository.listGlobalStandardProductItems({ standardProductId: b.id, limit: 10 });
    assert.deepEqual(reassigned.items.map(row => row.productId), [p1.id, manual.id].map(String));
    assert.equal(reassigned.items[0]?.sourceJobId, null);
    assert.deepEqual(reassigned.items[0]?.evidence, []);
    assert.equal(reassigned.items[0]?.assignmentSource, 'human');
    assert.equal((await repository.listGlobalResults({ limit: 100 })).items.length, 0);
  });

  test('unassigned products use the latest task, include never processed products, and leave after assignment', async () => {
    const a = await product('old unknown');
    const b = await product('business result');
    const c = await product('never processed');
    const changed = await product('changed');
    const older = await result(a.id, null, 'request_outcome_unknown');
    const newer = await result(a.id, null, 'invalid_response');
    await result(b.id, null, 'not_sellable');
    await result(changed.id, null, 'insufficient_evidence');
    await db.updateTable('products').set({ content_version: 2n, standardization_revision: 1n }).where('id', '=', changed.id).execute();
    await db.updateTable('ai_standardization_results').set({ published_at: sql`now() + interval '1 day'` }).where('job_id', '=', older).execute();
    const page = await repository.listGlobalResults({ limit: 2 });
    assert.deepEqual(page.items.map(row => [row.productId, row.reasonCode]), [[String(a.id), 'invalid_response'], [String(b.id), 'not_sellable']]);
    assert.equal(page.items[0]?.sourceJobId, String(newer));
    const next = await repository.listGlobalResults({ limit: 2, cursor: page.nextCursor! });
    assert.deepEqual(next.items.map(row => [row.productId, row.reasonCode]), [[String(c.id), 'not_processed'], [String(changed.id), 'source_changed']]);
    assert.equal(next.nextCursor, null);
    const target = await standard('assigned');
    await db.insertInto('standard_product_members').values({ product_id: a.id, standard_product_id: target.id, assignment_source: 'human' }).execute();
    assert.ok(!(await repository.listGlobalResults({ limit: 100 })).items.some(row => row.productId === String(a.id)));
    await db.updateTable('shops').set({ deleted_at: new Date() }).where('id', '=', b.shop_id).execute();
    assert.ok(!(await repository.listGlobalResults({ limit: 100 })).items.some(row => row.productId === String(b.id)));
  });

  test('manual isolation and exclusion leave pending until evidence changes or a later decision replaces them', async () => {
    const isolated = await product('reviewed isolation');
    const excluded = await product('reviewed exclusion');
    const legacy = await product('legacy manual isolation');
    const target = await standard('isolated target');
    await db.insertInto('standard_product_members').values({ product_id: legacy.id, standard_product_id: target.id,
      assignment_source: 'human', publication_state: 'quarantined' }).execute();
    for (const [p, action] of [[isolated, 'quarantine'], [excluded, 'exclude']] as const) {
      await db.transaction().execute(tx => recordManualDecisions(tx, [p.id], { action, standardProductId: null, reason: 'Reviewed current evidence' }));
    }
    const ids = [isolated.id, excluded.id, legacy.id];
    const pending = () => db.selectFrom('products as p').select('id').where('id', 'in', ids)
      .where(productStandardizationOutcome('p'), 'is', null).orderBy('id').execute();
    assert.deepEqual(await pending(), []);
    assert.ok(!(await repository.listGlobalResults({ limit: 100 })).items.some(row => ids.map(String).includes(row.productId)));
    await db.updateTable('products').set({ content_version: 2n, content_fingerprint: 'changed' }).where('id', '=', isolated.id).execute();
    await db.transaction().execute(tx => recordManualDecisions(tx, [legacy.id], { action: 'quarantine', standardProductId: target.id, reason: 'Review legacy evidence' }));
    await db.updateTable('products').set({ content_version: 2n, content_fingerprint: 'changed' }).where('id', '=', legacy.id).execute();
    await db.transaction().execute(tx => recordManualDecisions(tx, [excluded.id], { action: 'unbind', standardProductId: null, reason: 'Reopen review' }));
    assert.deepEqual((await pending()).map(row => row.id), [isolated.id, excluded.id, legacy.id]);
    const global = await repository.listGlobalResults({ limit: 100 });
    assert.ok(global.items.some(row => row.productId === String(isolated.id)));
    assert.ok(global.items.some(row => row.productId === String(excluded.id)));
    const unbound = global.items.find(row => row.productId === String(excluded.id));
    assert.equal(unbound?.reasonCode, 'manual_decision_preserved');
    assert.equal(unbound?.processingDisposition, 'review_required', 'manual unbinding protects evidence but leaves classification pending');
  });

  test('search escapes wildcard characters and totals include empty verified standards only', async () => {
    await standard('literal 100%_match');
    await standard('literal 100abmatch');
    await standard('literal 100%_match quarantined', false);
    const page = await repository.listGlobalStandardProducts({ query: '100%_', limit: 10, includeTotal: true });
    assert.equal(page.total, 1);
    assert.equal(page.items[0]?.standardName, 'literal 100%_match');
    assert.equal(page.items[0]?.productCount, 0);
    await assert.rejects(repository.listGlobalResults({ limit: 10, cursor: 'invalid' }));
  });

  test('current identity and publication conflicts require review without marking them handled or retryable', async () => {
    const reasons = ['identity_conflict', 'publication_blocked', 'invalid_response'] as const;
    const ids: bigint[] = [];
    for (const reason of reasons) {
      const p = await product(reason);
      ids.push(p.id);
      await result(p.id, null, reason);
    }
    const page = await repository.listGlobalResults({ limit: 100 });
    assert.deepEqual(page.items.filter(row => ids.map(String).includes(row.productId)).map(row => row.processingDisposition),
      ['review_required', 'review_required', 'retry_available']);
    const pending = await db.selectFrom('products as p').select('id').where('id', 'in', ids)
      .where(productStandardizationOutcome('p'), 'is', null).execute();
    assert.equal(pending.length, 3);
    const retry = await repository.listRetryPool({ limit: 100 });
    assert.ok(!retry.items.some(row => ids.slice(0, 2).map(String).includes(row.productId)));
    assert.ok(retry.items.some(row => row.productId === String(ids[2])));
    await db.updateTable('products').set({ standardization_revision: 1n }).where('id', '=', ids[0]!).execute();
    const stale = (await repository.listGlobalResults({ limit: 100 })).items.find(row => row.productId === String(ids[0]));
    assert.equal(stale?.reasonCode, 'source_changed');
    assert.equal(stale?.processingDisposition, 'pending');
  });
});

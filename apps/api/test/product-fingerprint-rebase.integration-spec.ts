import { tagRows } from './tag-fixtures.js';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';
import { rebaseProductFingerprints } from '../scripts/rebase-product-fingerprints.js';
import { jsonb, type DatabaseSchema, type JsonValue } from '../src/database/types.js';
import { productContentFingerprint } from '../src/standardization/fingerprint.js';
import { buildExtractionPayload } from '../src/ai/adaptive-batching.js';
import { buildMembershipFeatures, readCurrentMembershipFeatures } from '../src/standardization/membership-classification.js';
import { DISCLOSURE_KEYS, CONSISTENCY_KEYS, TEXT_REVIEW_VERSION, projectShopText } from '../src/shops/shop-text-review.js';

let admin: Pool;
before(() => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL must select a local disposable database');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.TEST_DATABASE_URL).hostname));
  admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL, connectionTimeoutMillis: 3000 });
});
after(async () => { await admin?.end(); });

async function withDatabase(run: (db: Kysely<DatabaseSchema>, schema: string) => Promise<void>) {
  const schema = `fp_rebase_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`create schema "${schema}"`);
  const db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: new Pool({
    connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public`, max: 3,
  }) }) });
  try {
    const { error } = await new Migrator({ db, provider: migrationProvider, migrationTableSchema: schema }).migrateToLatest();
    if (error) throw error;
    await run(db, schema);
  } finally { await db.destroy(); await admin.query(`drop schema "${schema}" cascade`); }
}

async function seed(db: Kysely<DatabaseSchema>, options: { stale?: boolean; pending?: boolean; sourceName?: string } = {}) {
  const name = 'ChatGPT Plus', description = '充值自己的账号,质保订阅30天';
  const sourceName = options.sourceName ?? name;
  const source = { url: 'https://fixture.invalid/shop', protocol: null, platform: 'fixture' };
  const rating = { unitId: 'sku', name, description, hash: 'a'.repeat(64) };
  const sourceData = { evidence: description, ratingText: rating };
  const old = createHash('sha256').update(JSON.stringify([sourceName, description, '月卡'])).digest('hex');
  const next = productContentFingerprint({ name: sourceName, description, spec: '月卡', sourceCategory: 'AI', sourceData });
  const shop = await db.insertInto('shops').values({ ...source, name: 'fixture' }).returningAll().executeTakeFirstOrThrow();
  const p = await db.insertInto('products').values({ shop_id: shop.id, external_id: randomUUID(), name,
    source_name: sourceName, source_description: description, spec: '月卡', source_category: 'AI', source_data: jsonb(sourceData),
    normalized_key: name, url: source.url, content_version: 5n, content_fingerprint: old, standardization_revision: 9n,
  }).returningAll().executeTakeFirstOrThrow();
  const legacyPayload = { id: '0', name, spec: '月卡', sourceData: { evidence: description }, shopText: projectShopText(p.source_data)!, category: 'AI' };
  const oldKey = createHash('sha256').update(JSON.stringify(legacyPayload)).digest('hex');
  const fact = { name: 'warranty', value: 'covered', evidence: [{ path: 'sourceData.evidence', quote: '质保订阅30天' }] };
  const features = { ...buildMembershipFeatures([fact], { ...p, shop_url: source.url, shop_protocol: null, shop_platform: source.platform }, [], 'top_up'),
    evidenceKey: options.stale ? 'stale-evidence-key' : oldKey, correctionReview: { reviewedFingerprint: old, note: 'keep audit' } };
  const judgment = { value: false, reason: 'fixture', evidence: [] };
  const textReview = { version: TEXT_REVIEW_VERSION, contentVersion: '5', fingerprint: old, source, textHash: rating.hash,
    review: { answers: Object.fromEntries(DISCLOSURE_KEYS.map(k => [k, judgment])), consistency: Object.fromEntries(CONSISTENCY_KEYS.map(k => [k, judgment])) } };
  await db.updateTable('products').set({ membership_features: jsonb(features as unknown as JsonValue), text_review: jsonb(textReview) }).where('id', '=', p.id).execute();
  const manual = await db.insertInto('product_standardization_decisions').values({ product_id: p.id, action: 'assign',
    content_version: p.content_version, content_fingerprint: old, standardization_revision: p.standardization_revision,
    evidence_known: false, source: 'direct_sql', reason: 'preserve manual protection' }).returning('id').executeTakeFirstOrThrow();
  const standard = await db.insertInto('standard_products').values({ name, canonical_family: 'openai', canonical_product: 'chatgpt',
    canonical_tier: 'plus', verification_state: 'verified', standard_key: randomUUID() }).returning('id').executeTakeFirstOrThrow();
  const jobs: bigint[] = [];
  for (const jobType of ['manual_full', 'tag_extraction', 'membership_features'] as const) {
    const job = await db.insertInto('ai_jobs').values({ model: 'fixture', job_type: jobType, total: 1n, processed: 1n,
      status: options.pending ? 'paused' : 'succeeded', phase: options.pending ? 'standardizing' : 'completed' }).returning('id').executeTakeFirstOrThrow();
    jobs.push(job.id);
    const payload = { ...legacyPayload, id: String(p.id), shopSource: source,
      ...(options.pending ? { sourceData: { evidence: description, merchant_attribute: 'excluded claim' } } : {}) };
    await db.insertInto('ai_job_inputs').values({ job_id: job.id, input_id: p.id, fingerprint: old, content_version: p.content_version,
      payload: jsonb(payload), status: options.pending ? 'queued' : 'succeeded', manual_decision_id: manual.id,
      previous_decision: jsonb({ fingerprint: old, contentVersion: '5', scope: 'historical_evidence_only' }) }).execute();
    await db.insertInto('ai_job_input_members').values({ job_id: job.id, input_id: p.id, product_id: p.id,
      fingerprint: old, content_version: p.content_version, standardization_revision: p.standardization_revision, payload: jsonb(payload),
      status: options.pending ? 'queued' : 'classified', output: options.pending ? null : jsonb({ outcome: 'updated', acceptedTags: [fact],
        versions: { fingerprint: old, contentVersion: '5', revision: '9', pipeline: {} } }) }).execute();
    if (jobType === 'manual_full') {
      await db.insertInto('ai_standardization_results').values({ job_id: job.id, input_id: p.id, product_id: p.id,
        content_version: p.content_version, fingerprint: old, status: 'classified', standard_product_id: standard.id,
        reason: 'reviewed', decision: jsonb({ status: 'classified', review: { approved: true }, evidence: [{ path: 'name', quote: name }] }) }).execute();
      await db.insertInto('ai_standardization_executions').values({ job_id: job.id, input_id: p.id, product_id: p.id,
        content_version: p.content_version, fingerprint: old, snapshot: jsonb(payload), status: options.pending ? 'registered' : 'completed' }).execute();
    }
  }
  await db.insertInto('standard_product_members').values({ product_id: p.id, standard_product_id: standard.id,
    assignment_source: 'ai', decision_version: jobs[0]! }).execute();
  await db.insertInto('product_tags').values(tagRows({ product_id: p.id, name: fact.name, value: fact.value })).execute();
  const event = await db.insertInto('product_change_events').values({ product_id: p.id, shop_id: shop.id,
    content_version: p.content_version, fingerprint: old, event_type: 'created',
    payload: jsonb({ sourceName, description, ...legacyPayload }) }).returning('id').executeTakeFirstOrThrow();
  await db.insertInto('standardization_outbox').values({ product_id: p.id, event_id: event.id, fingerprint: old, status: 'succeeded' }).execute();
  await db.insertInto('fetch_runs').values({ shop_id: shop.id, status: 'succeeded', started_at: new Date(), task_type: 'settlement',
    settlement_payload: jsonb({ source, products: [{ productId: String(p.id), contentVersion: '5', fingerprint: old, price: '10', capturedAt: 'fixture', verifiedAt: null },
      { productId: String(p.id), contentVersion: '4', fingerprint: old, price: '9', capturedAt: 'old', verifiedAt: null }] }) }).execute();
  return { p, old, next, features, jobs, manual, textReview };
}

async function snapshot(db: Kysely<DatabaseSchema>) {
  return { products: await db.selectFrom('products').selectAll().orderBy('id').execute(),
    inputs: await db.selectFrom('ai_job_inputs').selectAll().orderBy('job_id').execute(),
    members: await db.selectFrom('ai_job_input_members').selectAll().orderBy('job_id').execute(),
    jobs: await db.selectFrom('ai_jobs').selectAll().orderBy('id').execute(),
    results: await db.selectFrom('ai_standardization_results').selectAll().execute(),
    executions: await db.selectFrom('ai_standardization_executions').selectAll().execute(),
    manual: await db.selectFrom('product_standardization_decisions').selectAll().execute(),
    memberships: await db.selectFrom('standard_product_members').selectAll().execute(),
    tags: await db.selectFrom('product_tags').selectAll().execute(),
    events: await db.selectFrom('product_change_events').selectAll().execute(),
    outbox: await db.selectFrom('standardization_outbox').selectAll().execute(),
    fetch: await db.selectFrom('fetch_runs').selectAll().execute(),
    cache: await db.selectFrom('catalog_cache_versions').selectAll().execute() };
}

test('dry-run and apply preserve completed standard/tag/feature results, manual protection and versions; rerun is inert', async () => {
  await withDatabase(async db => {
    const fixture = await seed(db), before = await snapshot(db);
    const preview = await rebaseProductFingerprints(db);
    assert.equal(preview.products, 1); assert.deepEqual(preview.blocked, []);
    assert.deepEqual(await snapshot(db), before);
    const report = await rebaseProductFingerprints(db, { apply: true });
    assert.equal(report.applied, true);
    const after = await snapshot(db), p = after.products[0]!;
    assert.equal(p.content_fingerprint, fixture.next);
    assert.equal(p.content_version, 5n); assert.equal(p.standardization_revision, 9n);
    assert.equal(p.text_review_key, before.products[0]!.text_review_key);
    const expected = { ...fixture.features, fingerprint: fixture.next } as unknown as Record<string, JsonValue>;
    delete expected.evidenceKey;
    assert.deepEqual(p.membership_features, expected); assert.ok(readCurrentMembershipFeatures(p.membership_features, p));
    assert.deepEqual(after.jobs, before.jobs); assert.deepEqual(after.tags, before.tags); assert.deepEqual(after.memberships, before.memberships);
    for (const row of [...after.inputs, ...after.members, ...after.results, ...after.executions, ...after.events, ...after.outbox]) assert.equal(row.fingerprint, fixture.next);
    assert.equal(after.manual[0]!.content_fingerprint, fixture.next);
    for (const row of after.inputs) assert.equal((row.previous_decision as Record<string, JsonValue>).fingerprint, fixture.next);
    for (const row of after.members) assert.equal(((row.output as Record<string, JsonValue>).versions as Record<string, JsonValue>).fingerprint, fixture.next);
    assert.deepEqual(after.members.map(r => r.payload), before.members.map(r => r.payload));
    const items = (after.fetch[0]!.settlement_payload as { products: { fingerprint: string }[] }).products;
    assert.equal(items[0]!.fingerprint, fixture.next); assert.equal(items[1]!.fingerprint, fixture.old);
    assert.equal((await rebaseProductFingerprints(db, { apply: true })).products, 0);
    assert.deepEqual(await snapshot(db), after);
  });
});

test('old evidenceKey-only stale membership and stale text review stay invalid and unchanged', async () => {
  await withDatabase(async db => {
    const f = await seed(db, { stale: true });
    const staleText = { ...f.textReview, contentVersion: '4' };
    await db.updateTable('products').set({ text_review: jsonb(staleText) }).where('id', '=', f.p.id).execute();
    await rebaseProductFingerprints(db, { apply: true });
    const p = await db.selectFrom('products').selectAll().executeTakeFirstOrThrow();
    assert.deepEqual(p.membership_features, f.features); assert.equal(readCurrentMembershipFeatures(p.membership_features, p), null);
    assert.deepEqual(p.text_review, staleText); assert.equal(p.text_review_key, null);
  });
});

test('incompatible current frozen active inputs block apply without changing data', async () => {
  await withDatabase(async db => {
    await seed(db, { pending: true }); const before = await snapshot(db);
    const report = await rebaseProductFingerprints(db);
    assert.ok(report.blocked.some(b => b.reason === 'active_task'));
    await assert.rejects(rebaseProductFingerprints(db, { apply: true }), /active_task/);
    assert.deepEqual(await snapshot(db), before);
  });
});

test('failure after updates rolls back references, cache and disabled triggers', async () => {
  await withDatabase(async db => {
    await seed(db); const before = await snapshot(db);
    await sql`create function reject_rebase() returns trigger language plpgsql as $$ begin raise exception 'injected rollback'; end $$`.execute(db);
    await sql`create trigger reject_rebase after update of content_fingerprint on products for each row execute function reject_rebase()`.execute(db);
    await assert.rejects(rebaseProductFingerprints(db, { apply: true }), /injected rollback/);
    assert.deepEqual(await snapshot(db), before);
    const triggers = await sql<{ tgenabled: string }>`select tgenabled from pg_trigger where tgrelid in ('products'::regclass, 'product_standardization_decisions'::regclass)
      and tgname in ('invalidate_membership_features', 'prevent_standardization_history_rewrite')`.execute(db);
    assert.deepEqual(triggers.rows.map(r => r.tgenabled), ['O', 'O']);
  });
});

test('cancelled pending tasks stay frozen and unmapped while completed snapshots survive', async () => {
  await withDatabase(async db => {
    const f = await seed(db, { pending: true });
    await db.updateTable('ai_jobs').set({ status: 'cancelled' }).execute();
    await db.updateTable('ai_job_inputs').set({ status: 'cancelled' }).execute();
    await db.updateTable('ai_job_input_members').set({ status: 'cancelled' }).execute();
    await db.updateTable('ai_standardization_executions').set({ status: 'cancelled' }).execute();
    const before = await snapshot(db);
    await rebaseProductFingerprints(db, { apply: true });
    const after = await snapshot(db);
    assert.equal(after.products[0]!.content_fingerprint, f.next);
    assert.deepEqual(after.inputs, before.inputs); assert.deepEqual(after.members, before.members);
    assert.deepEqual(after.executions, before.executions); assert.deepEqual(after.results, before.results);
    assert.deepEqual(after.jobs, before.jobs);
  });
});

test('a live preparing job with no frozen member rows blocks apply', async () => {
  await withDatabase(async db => {
    await seed(db);
    await db.insertInto('ai_jobs').values({ model: 'fixture', job_type: 'membership_features', total: 1n, status: 'queued', phase: 'preparing' }).execute();
    const before = await snapshot(db);
    await assert.rejects(rebaseProductFingerprints(db, { apply: true }), /active_task/);
    assert.deepEqual(await snapshot(db), before);
  });
});

test('same old hash may split by product; grouped input maps only its representative and older versions stay stale', async () => {
  await withDatabase(async db => {
    const f = await seed(db);
    const { id: _id, text_review_key: _key, ...copy } = f.p;
    const other = await db.insertInto('products').values({ ...copy, external_id: randomUUID(), source_data: jsonb({ evidence: f.p.source_description,
      warranty_info: '额外质保条件' }), text_review: null, membership_features: null }).returningAll().executeTakeFirstOrThrow();
    const next = productContentFingerprint({ name: other.source_name, description: other.source_description,
      spec: other.spec, sourceCategory: other.source_category, sourceData: other.source_data });
    assert.notEqual(next, f.next);
    await db.insertInto('ai_job_input_members').values({ job_id: f.jobs[0]!, input_id: f.p.id, product_id: other.id,
      fingerprint: f.old, content_version: 5n, standardization_revision: 9n,
      payload: jsonb(buildExtractionPayload({ id: String(other.id), name: other.name, spec: other.spec, category: other.source_category,
        sourceData: other.source_data })), status: 'unclassified' }).execute();
    const staleJob = await db.insertInto('ai_jobs').values({ model: 'fixture', total: 1n, status: 'succeeded' }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('ai_job_inputs').values({ job_id: staleJob.id, input_id: f.p.id, fingerprint: f.old, content_version: 4n,
      payload: jsonb({ name: f.p.name }), status: 'succeeded' }).execute();
    await db.insertInto('ai_job_input_members').values({ job_id: staleJob.id, input_id: f.p.id, product_id: f.p.id,
      content_version: 4n, fingerprint: f.old, status: 'classified', standardization_revision: 8n }).execute();
    await rebaseProductFingerprints(db, { apply: true });
    const input = await db.selectFrom('ai_job_inputs').selectAll().where('job_id', '=', f.jobs[0]!).executeTakeFirstOrThrow();
    const member = await db.selectFrom('ai_job_input_members').selectAll().where('job_id', '=', f.jobs[0]!).where('product_id', '=', other.id).executeTakeFirstOrThrow();
    assert.equal(input.fingerprint, f.next); assert.equal(member.fingerprint, next);
    const stale = await db.selectFrom('ai_job_input_members').selectAll().where('job_id', '=', staleJob.id).executeTakeFirstOrThrow();
    assert.equal(stale.fingerprint, f.old); assert.equal(stale.content_version, 4n); assert.equal(stale.standardization_revision, 8n);
  });
});

for (const kind of ['execution', 'outbox'] as const) test(`${kind} unique collision aborts without discarding history`, async () => {
  await withDatabase(async db => {
    const f = await seed(db);
    if (kind === 'execution') {
      await db.insertInto('ai_standardization_executions').values({ product_id: f.p.id, job_id: f.jobs[0]!, input_id: f.p.id,
        content_version: 5n, fingerprint: f.next, snapshot: jsonb({ name: f.p.name }), status: 'completed' }).execute();
    } else {
      await db.updateTable('standardization_outbox').set({ status: 'queued' }).execute();
      const old = await db.selectFrom('standardization_outbox').selectAll().executeTakeFirstOrThrow();
      await db.insertInto('standardization_outbox').values({ product_id: old.product_id, event_id: old.event_id, fingerprint: f.next, status: 'queued' }).execute();
    }
    const before = await snapshot(db);
    const preview = await rebaseProductFingerprints(db);
    assert.ok(preview.blocked.some(b => b.reason === 'unique_fingerprint_conflict'));
    await assert.rejects(rebaseProductFingerprints(db, { apply: true }), /unique_fingerprint_conflict/);
    assert.deepEqual(await snapshot(db), before);
  });
});

test('NOWAIT rejects concurrent writers and does not hold partial locks', async () => {
  await withDatabase(async (db, schema) => {
    await seed(db);
    const connection = await admin.connect();
    try {
      await connection.query('begin');
      await connection.query(`lock table "${schema}".ai_jobs in row exclusive mode`);
      await assert.rejects(rebaseProductFingerprints(db, { apply: true }), { code: '55P03' });
      await connection.query(`lock table "${schema}".products in access exclusive mode nowait`);
    } finally { await connection.query('rollback'); connection.release(); }
    assert.equal((await rebaseProductFingerprints(db, { apply: true })).applied, true);
  });
});

test('uncited warranty changes rebase current products while preserving old task results as stale', async () => {
  await withDatabase(async db => {
    const f = await seed(db);
    await sql`update products set source_data=source_data || '{"warranty_info":"no warranty"}'::jsonb where id=${f.p.id}`.execute(db);
    const preview = await rebaseProductFingerprints(db);
    assert.ok(preview.stale.some(b => b.reason === 'completed_frozen_evidence_changed'));
    assert.deepEqual(preview.blocked, []);
    await rebaseProductFingerprints(db, { apply: true });
    const product = await db.selectFrom('products').selectAll().executeTakeFirstOrThrow();
    const member = await db.selectFrom('ai_job_input_members').selectAll().where('status', '=', 'classified').executeTakeFirstOrThrow();
    const execution = await db.selectFrom('ai_standardization_executions').selectAll().executeTakeFirstOrThrow();
    assert.notEqual(product.content_fingerprint, f.old);
    assert.equal(member.fingerprint, f.old);
    assert.equal(execution.fingerprint, f.old);
  });
});

test('category, usage and merchant attributes outside the four-field hash do not block completed tasks', async () => {
  await withDatabase(async db => {
    const f = await seed(db);
    await sql`update products set source_category='Changed category', source_data=source_data ||
      '{"usage_guide":"new usage","merchant_tags":["new tag"],"attributes":{"note":"new attribute"}}'::jsonb where id=${f.p.id}`.execute(db);
    const preview = await rebaseProductFingerprints(db);
    assert.deepEqual(preview.blocked, []);
    await rebaseProductFingerprints(db, { apply: true });
    const rows = await db.selectFrom('ai_job_input_members').selectAll().execute();
    assert.ok(rows.every(r => r.fingerprint === f.next && r.status === 'classified'));
    const p = await db.selectFrom('products').selectAll().executeTakeFirstOrThrow();
    // It was already stale under the old evidenceKey check; removal must not resurrect it.
    assert.equal(readCurrentMembershipFeatures(p.membership_features, p), null);
  });
});

for (const proof of [true, false]) test(`display title to original title requires a matching historical event (proof=${proof})`, async () => {
  await withDatabase(async db => {
    const f = await seed(db, { sourceName: '[原始标题] ChatGPT Plus' });
    if (!proof) await sql`update product_change_events set payload=payload-'sourceName'`.execute(db);
    if (proof) {
      const preview = await rebaseProductFingerprints(db);
      assert.deepEqual(preview.blocked, []);
      await rebaseProductFingerprints(db, { apply: true });
      const p = await db.selectFrom('products').selectAll().executeTakeFirstOrThrow();
      assert.equal(p.content_fingerprint, f.next); assert.ok(readCurrentMembershipFeatures(p.membership_features, p));
    } else {
      const before = await snapshot(db);
      const report = await rebaseProductFingerprints(db, { apply: true });
      assert.equal(report.applied, true);
      const product = await db.selectFrom('products').selectAll().executeTakeFirstOrThrow();
      const member = await db.selectFrom('ai_job_input_members').selectAll().where('status', '=', 'classified').executeTakeFirstOrThrow();
      assert.equal(product.content_fingerprint, f.next);
      assert.equal(member.fingerprint, f.old);
    }
  });
});

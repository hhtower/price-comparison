import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { migrateToLatest } from '../scripts/migrate.js';
import { ProductsRepository } from '../src/products/products.repository.js';
import { AdminRepository } from '../src/admin/admin.repository.js';
import { buildCanonicalStandardKey } from '../src/standardization/canonical-key.js';
import { jsonb, type DatabaseSchema } from '../src/database/types.js';
import { isManualDecisionForCurrentEvidence, readLatestManualDecisions, recordManualDecisions } from '../src/standardization/decision-history.js';
import { productContentFingerprint } from '../src/standardization/fingerprint.js';

let db: Kysely<DatabaseSchema>, admin: Pool, schema: string;
before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  schema = `decision_history_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema ${schema}`);
  process.env.PG_SCHEMA = schema;
  db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public` }) }) });
  await migrateToLatest(db);
});
after(async () => { await db?.destroy(); if (admin && schema) await admin.query(`drop schema ${schema} cascade`); await admin?.end(); delete process.env.PG_SCHEMA; });
async function fixture() {
  const shop = await db.insertInto('shops').values({ name: 'history', platform: 'test', url: `https://shop.invalid/${randomUUID()}` }).returning('id').executeTakeFirstOrThrow();
  const input = { shopId: shop.id, externalId: randomUUID(), name: 'ChatGPT Plus 账号', normalizedKey: randomUUID(), url: '', sourceData: { description: '自行接码', api_key: 'private-api-key' } };
  const repository = new ProductsRepository(db);
  const rows = await repository.upsertBatch([input]);
  const id = [...rows.values()][0]!;
  const identity = { family: 'openai', product: 'chatgpt', tier: 'plus' };
  const standard = await db.selectFrom('standard_products').select('id').where('standard_key', '=', buildCanonicalStandardKey(identity)).executeTakeFirst()
    ?? await db.insertInto('standard_products').values({ name: 'ChatGPT Plus', canonical_family: identity.family, canonical_product: identity.product, canonical_tier: identity.tier, standard_key: buildCanonicalStandardKey(identity), verification_state: 'verified' }).returning('id').executeTakeFirstOrThrow();
  return { id, standardId: standard.id, repository };
}
async function history(id: bigint) { return (await sql<Record<string, unknown>>`select * from product_standardization_decisions where product_id = ${id} order by id`.execute(db)).rows; }

test('manual assignment uses the same contradictory delivery gate without recording a partial review', async () => {
  const { id, standardId } = await fixture();
  const name = 'ChatGPT Plus 账号 首登质保2小时';
  const sourceData = { evidence: '提供Plus账号密码2FA。仅质保下单后1小时内首次登录。' };
  await db.updateTable('products').set({ name, source_data: jsonb(sourceData),
    content_fingerprint: productContentFingerprint({ name, sourceData }) }).where('id', '=', id).execute();
  const before = await db.selectFrom('products').select(['standardization_revision', 'content_fingerprint']).where('id', '=', id).executeTakeFirstOrThrow();
  await assert.rejects(db.transaction().execute(tx => recordManualDecisions(tx, [id], {
    action: 'assign', standardProductId: standardId, reason: 'Review current offer',
  })), { code: 'CATALOG_PUBLICATION_BLOCKED' });
  assert.deepEqual(await history(id), []);
  assert.deepEqual(await db.selectFrom('products').select(['standardization_revision', 'content_fingerprint']).where('id', '=', id).executeTakeFirstOrThrow(), before);
  await db.transaction().execute(tx => recordManualDecisions(tx, [id], {
    action: 'quarantine', standardProductId: null, reason: 'Contradictory first-login warranty',
  }));
  assert.equal((await history(id)).at(-1)?.action, 'quarantine');
});

test('application assignment and unbinding record sanitized review evidence without duplicate trigger rows', async () => {
  const { id, standardId, repository } = await fixture();
  const before = await repository.findById(id);
  await repository.assignStandardProduct(id, standardId);
  let rows = await history(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.action, 'assign');
  assert.equal(rows[0]?.evidence_known, true);
  assert.equal(JSON.stringify(rows[0]?.evidence_snapshot).includes('private-api-key'), false);
  assert.equal(rows[0]?.content_version, before!.content_version);
  assert.equal(rows[0]?.standardization_revision, before!.standardization_revision + 1n);
  await repository.assignStandardProduct(id, null);
  rows = await history(id);
  assert.deepEqual(rows.map(row => row.action), ['assign', 'unbind']);
  assert.equal(rows[1]?.previous_standard_product_id, standardId);
  assert.equal(rows[1]?.standard_product_id, null);
  assert.equal((await repository.findById(id))?.standardization_locked, false);
});

test('direct human quarantine captures the then-current version but never invents a reviewed snapshot', async () => {
  const { id, standardId, repository } = await fixture();
  await db.insertInto('standard_product_members').values({ product_id: id, standard_product_id: standardId, assignment_source: 'ai', publication_state: 'published' }).execute();
  const before = await repository.findById(id);
  await db.updateTable('standard_product_members').set({ assignment_source: 'human', publication_state: 'quarantined' }).where('product_id', '=', id).execute();
  const row = (await history(id))[0]!;
  assert.equal(row.action, 'quarantine');
  assert.equal(row.evidence_known, false);
  assert.equal(row.evidence_snapshot, null);
  assert.equal(row.content_version, before!.content_version);
  assert.equal((await repository.findById(id))!.standardization_revision, before!.standardization_revision + 1n);
  await repository.update(id, { name: 'ChatGPT Team 账号' });
  assert.equal((await history(id)).length, 1, 'content invalidation is not a new manual unbind');
  assert.equal((await db.selectFrom('standard_product_members').selectAll().where('product_id', '=', id).execute()).length, 0);
});

test('bulk binding reports contradictory evidence per item and binds only after admin confirmation', async () => {
  const blocked = await fixture(), clean = await fixture();
  const name = 'plus【已接马带rt不带帐密】 ,sub2 CPA格式 只能反代使用!!!';
  const sourceData = { evidence: '<p>发货为:账密2fa</p>' };
  await db.updateTable('products').set({ name, source_data: jsonb(sourceData),
    content_fingerprint: productContentFingerprint({ name, sourceData }) }).where('id', '=', blocked.id).execute();
  const repository = new AdminRepository(db);
  const first = await repository.bindProducts([blocked.id, clean.id], blocked.standardId, true);
  assert.deepEqual(first.success, [clean.id.toString()]);
  assert.equal(first.conflicts.length, 1);
  assert.match(first.conflicts[0]!.reason, /^发布证据冲突：credentials conflict/u);
  assert.deepEqual(await history(blocked.id), []);
  const forced = await repository.bindProducts([blocked.id], blocked.standardId, true, true);
  assert.deepEqual(forced.success, [blocked.id.toString()]);
  assert.equal((await history(blocked.id)).at(-1)?.action, 'assign');
});

test('bulk binding and merging save a decision per affected product with the target snapshot', async () => {
  const a = await fixture(), b = await fixture();
  const source = await db.insertInto('standard_products').values({ name: 'Manual merge source', canonical_family: 'fixture', canonical_product: 'source', canonical_tier: 'standard', verification_state: 'verified' }).returning('id').executeTakeFirstOrThrow();
  const target = await db.insertInto('standard_products').values({ name: 'Another manual standard', canonical_family: 'fixture', canonical_product: 'alternate', canonical_tier: 'standard', verification_state: 'verified' }).returning('id').executeTakeFirstOrThrow();
  const repository = new AdminRepository(db);
  await repository.bindProducts([a.id, b.id], source.id, true);
  assert.equal((await history(a.id))[0]?.evidence_known, true);
  assert.equal((await history(b.id))[0]?.action, 'assign');
  await repository.mergeStandardProducts([source.id], target.id);
  for (const id of [a.id, b.id]) {
    const rows = await history(id);
    assert.deepEqual(rows.map(row => row.action), ['assign', 'merge']);
    assert.equal(rows[1]?.standard_product_id, target.id);
    assert.equal((rows[1]?.target_snapshot as { product: string }).product, 'alternate');
  }
});

test('review decisions are append-only and never set a permanent lock', async () => {
  const { id, standardId, repository } = await fixture();
  await repository.assignStandardProduct(id, standardId);
  await repository.assignStandardProduct(id, null);
  assert.equal((await db.selectFrom('standard_product_members').selectAll().where('product_id', '=', id).execute()).length, 0);
  assert.deepEqual((await history(id)).map(row => row.action), ['assign', 'unbind']);
  assert.equal((await repository.findById(id))?.standardization_locked, false);
  await assert.rejects(sql`update product_standardization_decisions set reason='overwritten' where product_id=${id}`.execute(db), /append-only/);
  await assert.rejects(sql`delete from product_standardization_decisions where product_id=${id}`.execute(db), /append-only/);
});

test('editing canonical identity records the new target per member while preserving prior reviewed identity', async () => {
  const { id, standardId, repository } = await fixture();
  await repository.assignStandardProduct(id, standardId);
  await new AdminRepository(db).updateStandardProduct(standardId, { canonicalTier: 'team' });
  const rows = await history(id);
  assert.deepEqual(rows.map(row => row.action), ['assign', 'identity_update']);
  assert.equal((rows[0]?.target_snapshot as { tier: string }).tier, 'plus');
  assert.equal((rows[1]?.target_snapshot as { tier: string }).tier, 'team');
});

test('known reviews preserve the stored source fingerprint despite processed evidence changes', async () => {
  const { id, standardId, repository } = await fixture();
  const fingerprint = 'stored-source-hash';
  await db.updateTable('products').set({ content_fingerprint: fingerprint, spec: 'processed spec' }).where('id', '=', id).execute();
  await repository.assignStandardProduct(id, standardId);
  const current = (await repository.findById(id))!;
  const decision = (await readLatestManualDecisions(db, [id])).get(id)!;
  assert.equal(current.content_fingerprint, fingerprint);
  assert.equal(decision.content_fingerprint, fingerprint);
  assert.equal(isManualDecisionForCurrentEvidence(decision, { content_version: current.content_version, content_fingerprint: fingerprint }), true);
  assert.equal(isManualDecisionForCurrentEvidence(decision, { content_version: current.content_version + 1n, content_fingerprint: fingerprint }), false);
  assert.equal(isManualDecisionForCurrentEvidence(decision, { content_version: current.content_version, content_fingerprint: 'other' }), false);
});


async function contradictory() {
  const item = await fixture();
  const name = 'plus【已接马带rt不带帐密】 ,sub2 CPA格式 只能反代使用!!!';
  const sourceData = { evidence: '<p>发货为:账密2fa</p>' };
  await db.updateTable('products').set({ name, source_data: jsonb(sourceData),
    content_fingerprint: productContentFingerprint({ name, sourceData }) }).where('id', '=', item.id).execute();
  return item;
}

test('admin confirmation overrides the evidence gate when creating and merging standard products', async () => {
  const repository = new AdminRepository(db);
  const blocked = await contradictory();
  const identity = { family: 'fixture', product: `override ${randomUUID().slice(0, 8)}`, tier: 'standard' };
  await assert.rejects(repository.createStandardProduct(identity, '', [blocked.id]), (error: { code?: string; getResponse?: () => { error: { details?: { conflicts?: Array<{ id: string; reason: string }> } } } }) => {
    assert.equal(error.code, 'CATALOG_PUBLICATION_BLOCKED');
    const conflicts = error.getResponse?.().error.details?.conflicts ?? [];
    assert.deepEqual(conflicts.map(item => item.id), [blocked.id.toString()]);
    assert.match(conflicts[0]!.reason, /「.+」 vs 「.+」/u);
    return true;
  });
  assert.deepEqual(await history(blocked.id), []);
  const created = await repository.createStandardProduct(identity, '', [blocked.id], true);
  assert.equal((await history(blocked.id)).at(-1)?.action, 'assign');

  const target = await db.insertInto('standard_products').values({ name: 'Override target', canonical_family: 'fixture', canonical_product: `target ${randomUUID().slice(0, 8)}`, canonical_tier: 'standard', verification_state: 'verified' }).returning('id').executeTakeFirstOrThrow();
  const refused = await repository.mergeStandardProducts([created.id], target.id);
  assert.deepEqual(refused.success, []);
  assert.match(refused.conflicts[0]!.reason, new RegExp(`^发布证据冲突：\n  成员 #${blocked.id} credentials conflict`, 'u'));
  assert.equal((await db.selectFrom('standard_product_members').select('standard_product_id').where('product_id', '=', blocked.id).executeTakeFirstOrThrow()).standard_product_id, created.id);
  const merged = await repository.mergeStandardProducts([created.id], target.id, true);
  assert.deepEqual(merged.success, [created.id.toString()]);
  assert.equal((await history(blocked.id)).at(-1)?.action, 'merge');
});

test('admin confirmation overrides identity conflicts and unverified targets for one product', async () => {
  const { id, repository } = await fixture();
  const claude = { family: 'anthropic', product: 'claude', tier: 'pro' };
  const target = await db.insertInto('standard_products').values({ name: 'Claude Pro', canonical_family: claude.family, canonical_product: claude.product, canonical_tier: claude.tier, standard_key: `${buildCanonicalStandardKey(claude)}:${randomUUID()}`, verification_state: 'quarantined' }).returning('id').executeTakeFirstOrThrow();
  await assert.rejects(repository.assignStandardProduct(id, target.id), { code: 'STANDARD_PRODUCT_UNVERIFIED' });
  assert.deepEqual(await history(id), []);
  await repository.assignStandardProduct(id, target.id, undefined, true);
  assert.equal((await db.selectFrom('standard_product_members').select('standard_product_id').where('product_id', '=', id).executeTakeFirstOrThrow()).standard_product_id, target.id);
  assert.equal((await history(id)).at(-1)?.action, 'assign');
  const binding = await new AdminRepository(db).bindProducts([(await fixture()).id], target.id, true);
  assert.equal(binding.notice, '目标标准商品未通过身份验证或已隔离，绑定后不会在前台展示');
});

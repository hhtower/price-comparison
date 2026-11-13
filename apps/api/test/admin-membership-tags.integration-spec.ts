import { tagRows } from './tag-fixtures.js';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { migrateToLatest } from '../scripts/migrate.js';
import { jsonb, type DatabaseSchema, type JsonValue } from '../src/database/types.js';
import { AdminRepository } from '../src/admin/admin.repository.js';
import { buildCanonicalStandardKey } from '../src/standardization/canonical-key.js';
import { buildMembershipFeatures, readCurrentMembershipFeatures } from '../src/standardization/membership-classification.js';
import { suppressManualDecisionTrigger } from '../src/standardization/decision-history.js';

let db: Kysely<DatabaseSchema>, admin: Pool;
const schema = `admin_membership_tags_${randomUUID().replaceAll('-', '')}`;
const identity = { family: 'openai', product: 'chatgpt', tier: 'plus' };
const facts = [{ name: 'duration', value: 30 }, { name: 'region', value: 'us' }, { name: 'sms_verification', value: 'verified' }];

before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'Dedicated TEST_DATABASE_URL required');
  admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({
    connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public`,
  }) }) });
  process.env.PG_SCHEMA = schema;
  await migrateToLatest(db);
});
after(async () => {
  await db?.destroy();
  if (admin) { await admin.query(`drop schema if exists "${schema}" cascade`); await admin.end(); }
  delete process.env.PG_SCHEMA;
});

async function fixture(options: { human?: boolean; locked?: boolean; nonAi?: boolean; stale?: boolean; unclassified?: boolean; shortTerm?: boolean } = {}) {
  const shop = await db.insertInto('shops').values({ name: 'tag edit', platform: 'test', enabled: true,
    url: `https://test.invalid/${randomUUID()}` }).returning('id').executeTakeFirstOrThrow();
  const product = await db.insertInto('products').values({
    shop_id: shop.id, external_id: '1', name: `ChatGPT Plus tag edit ${randomUUID()}`, spec: '',
    normalized_key: randomUUID(), url: '', content_fingerprint: randomUUID(), standardization_locked: options.locked ?? false,
  }).returning('id').executeTakeFirstOrThrow();
  const targetIdentity = options.nonAi ? { family: 'microsoft', product: 'outlook', tier: 'standard' } : identity;
  const standardKey = buildCanonicalStandardKey(targetIdentity);
  const standard = await db.insertInto('standard_products').values({
    name: 'tag target', canonical_family: targetIdentity.family, canonical_product: targetIdentity.product,
    canonical_tier: targetIdentity.tier, standard_key: standardKey, verification_state: 'verified',
  }).onConflict(c => c.column('standard_key').where('standard_key', 'is not', null).doUpdateSet({ name: 'tag target' })).returning('id').executeTakeFirstOrThrow();
  await db.insertInto('standard_product_members').values({
    product_id: product.id, standard_product_id: standard.id, publication_state: options.stale || options.unclassified ? 'provisional' : 'published', assignment_source: options.human ? 'human' : 'ai',
  }).execute();
  await db.insertInto('product_tags').values(tagRows([...facts, { name: 'supported_client', value: 'codex' }].map(tag => ({ product_id: product.id, ...tag })))).execute();
  const current = await db.selectFrom('products').selectAll().where('id', '=', product.id).executeTakeFirstOrThrow();
  const features = options.nonAi || options.unclassified ? null : buildMembershipFeatures([], current, [], options.shortTerm ? 'short_term' : 'account');
  if (features && options.stale) features.fingerprint = 'old';
  await db.updateTable('products').set({
    membership_features: features ? jsonb(features as unknown as JsonValue) : null,
  }).where('id', '=', product.id).execute();
  const history = await db.selectFrom('product_standardization_decisions').selectAll().where('product_id', '=', product.id).orderBy('id').execute();
  return { ...current, membership_features: features, standardId: standard.id, history };
}

async function state(id: bigint) {
  return {
    product: await db.selectFrom('products').selectAll().where('id', '=', id).executeTakeFirstOrThrow(),
    member: await db.selectFrom('standard_product_members').selectAll().where('product_id', '=', id).executeTakeFirstOrThrow(),
    history: await db.selectFrom('product_standardization_decisions').selectAll().where('product_id', '=', id).orderBy('id').execute(),
  };
}

const edits = {
  bind: (repo: AdminRepository, id: bigint) => repo.bindTags([id], 'bulk_purchase', 'required'),
  delete: (repo: AdminRepository) => repo.deleteTag('sms_verification', 'verified'),
  rename: (repo: AdminRepository) => repo.renameTag('region', 'us', 'region', 'ph'),
  merge: (repo: AdminRepository) => repo.mergeTags('duration', 30, 'region', 'us'),
};
for (const [operation, edit] of Object.entries(edits)) {
  test(`${operation} of display labels preserves features, publication, manual ownership and locks`, async () => {
    const ai = await fixture(), human = await fixture({ human: true }), locked = await fixture({ locked: true }), nonAi = await fixture({ nonAi: true });
    const repo = new AdminRepository(db);
    if (operation === 'bind') {
      for (const item of [ai, human, locked, nonAi]) await edit(repo, item.id);
    } else await edit(repo, ai.id);
    for (const item of [ai, human, locked, nonAi]) {
      const after = await state(item.id);
      assert.equal(after.product.standardization_revision, item.standardization_revision + 1n);
      assert.equal(after.product.standardization_locked, item.standardization_locked);
      assert.equal(after.member.standard_product_id, item.standardId);
      assert.equal(after.member.assignment_source, item.id === human.id ? 'human' : 'ai');
      assert.equal(after.member.publication_state, 'published');
      assert.deepEqual(after.product.membership_features, item.membership_features
        ? { ...item.membership_features, revision: String(item.standardization_revision + 1n) } : null);
      assert.deepEqual(after.history, item.history);
    }
    assert.equal((await repo.listProducts({ pending: true, shopId: human.shop_id })).items.length, 0);
  });
}

test('display labels cannot supply missing feature evidence or enqueue classification work', async () => {
  const current = await fixture({ unclassified: true });
  const before = await state(current.id);
  const jobs = await db.selectFrom('ai_jobs').selectAll().orderBy('id').execute();
  const repo = new AdminRepository(db);
  await assert.rejects(repo.bindTags([current.id], '质保天数', '365'));
  await assert.rejects(repo.bindTags([current.id], 'membership_kind', 'account'));
  await repo.bindTags([current.id], 'warranty', '保订阅365天');
  const after = await state(current.id);
  assert.equal(after.product.membership_features, null);
  assert.deepEqual(after.member, before.member);
  assert.deepEqual(await db.selectFrom('ai_jobs').selectAll().orderBy('id').execute(), jobs);
});

test('adding warranty labels does not change features or split the shared identity', async () => {
  const account = await fixture(), current = await fixture({ shortTerm: true });
  const repo = new AdminRepository(db);
  await repo.bindTags([current.id], 'warranty', '保订阅365天，封号不保');
  const after = await state(current.id);
  assert.equal(after.member.standard_product_id, current.standardId);
  assert.equal(after.member.publication_state, 'published');
  const binding = await repo.bindProducts([current.id], account.standardId, true, true);
  assert.equal(current.standardId, account.standardId);
  assert.deepEqual(binding.skipped, [String(current.id)]);
  assert.deepEqual(binding.conflicts, []);
  assert.equal(readCurrentMembershipFeatures(after.product.membership_features, after.product)?.decision.kind, 'short_term');
});

test('unrelated tag edits keep a valid feature snapshot current; no-op binds do not change revision', async () => {
  const current = await fixture();
  const repo = new AdminRepository(db);
  await repo.bindTags([current.id], 'supported_client', 'codex');
  await repo.renameTag('supported_client', 'codex', 'supported_client', 'codex');
  await repo.mergeTags('supported_client', 'codex', 'supported_client', 'codex');
  assert.equal((await state(current.id)).product.standardization_revision, current.standardization_revision);
  for (const edit of [
    () => repo.bindTags([current.id], 'access_channel', 'web'),
    () => repo.renameTag('access_channel', 'web', 'access_channel', 'api'),
    () => repo.mergeTags('access_channel', 'api', 'supported_client', 'codex'),
    () => repo.deleteTag('supported_client', 'codex'),
  ]) {
    await edit();
    const after = await state(current.id);
    assert.equal(after.member.publication_state, 'published');
    assert.equal(readCurrentMembershipFeatures(after.product.membership_features, after.product)?.decision.kind, 'account');
  }
});

test('renaming into a retired alias is rejected without altering verified feature facts', async () => {
  const current = await fixture();
  const before = await state(current.id);
  await assert.rejects(new AdminRepository(db).renameTag('supported_client', 'codex', '订阅时长', '2 months'));
  assert.deepEqual(await state(current.id), before);
});

test('an unrelated edit cannot revive a stale membership snapshot', async () => {
  const current = await fixture({ stale: true });
  const before = await state(current.id);
  await new AdminRepository(db).bindTags([current.id], 'access_channel', 'web');
  const after = await state(current.id);
  assert.equal(after.member.publication_state, 'provisional');
  assert.deepEqual(after.member, before.member);
  assert.deepEqual(after.product.membership_features, current.membership_features);
  assert.equal(readCurrentMembershipFeatures(after.product.membership_features, after.product), null);
});

test('cosmetic standard edits retain current features', async () => {
  const current = await fixture();
  await new AdminRepository(db).updateStandardProduct(current.standardId, { name: 'Reviewed display name' });
  const after = await state(current.id);
  assert.deepEqual(after.product.membership_features, {
    ...current.membership_features, revision: String(after.product.standardization_revision),
  });
  assert.ok(readCurrentMembershipFeatures(after.product.membership_features, after.product));
});

test('display label edits preserve legacy human publication without inventing a review requirement', async () => {
  const current = await fixture();
  await db.transaction().execute(async tx => {
    await suppressManualDecisionTrigger(tx, [current.id]);
    await tx.updateTable('standard_product_members').set({ assignment_source: 'human' }).where('product_id', '=', current.id).execute();
  });
  const repo = new AdminRepository(db);
  await repo.bindTags([current.id], 'warranty', '购买后1小时内仅保首登');
  const pending = await repo.listProducts({ pending: true, shopId: current.shop_id });
  assert.equal(pending.items.length, 0);
  const after = await state(current.id);
  assert.deepEqual(after.history, []);
  assert.equal(after.member.assignment_source, 'human');
  assert.equal(after.member.publication_state, 'published');
  assert.equal(readCurrentMembershipFeatures(after.product.membership_features, after.product)?.decision.kind, 'account');
});

test('revision persistence failure rolls back display labels and the snapshot revision together', async () => {
  const current = await fixture({ human: true });
  const before = await state(current.id);
  const tags = await db.selectFrom('product_tags').selectAll().where('product_id', '=', current.id).orderBy('id').execute();
  let revisionWrite = false;
  const failingDb = db.withPlugin({
    transformQuery(args) { revisionWrite = args.node.kind === 'UpdateQueryNode'; return args.node; },
    async transformResult(args) {
      if (revisionWrite) throw new Error('forced revision persistence failure');
      return args.result;
    },
  });
  await assert.rejects(new AdminRepository(failingDb).bindTags([current.id], 'bulk_purchase', 'required'), /forced revision persistence failure/);
  assert.deepEqual(await state(current.id), before);
  assert.deepEqual(await db.selectFrom('product_tags').selectAll().where('product_id', '=', current.id).orderBy('id').execute(), tags);
});

test('concurrent binding and renaming cannot create two values for a single-valued dimension', async () => {
  const current = await fixture();
  const repo = new AdminRepository(db);
  const sourceValue = `race-${randomUUID()}`;
  await repo.bindTags([current.id], 'supported_client', sourceValue);
  await db.deleteFrom('product_tags').where('product_id', '=', current.id).where('name', '=', 'duration').execute();
  let release!: () => void, locked!: () => void;
  const ready = new Promise<void>(resolve => { locked = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let holderPid = 0;
  const holder = db.transaction().execute(async tx => {
    holderPid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(tx)).rows[0]!.pid;
    await tx.selectFrom('products').select('id').where('id', '=', current.id).forUpdate().execute();
    locked(); await held;
  });
  await ready;
  const binding = repo.bindTags([current.id], 'duration', 90);
  const renaming = repo.renameTag('supported_client', sourceValue, 'duration', 60);
  const outcomes = Promise.allSettled([binding, renaming]);
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      const blocked = (await sql<{ n: number }>`select count(*)::int as n from pg_stat_activity
        where ${holderPid} = any(pg_blocking_pids(pid))`.execute(db)).rows[0]!.n;
      if (blocked >= 2) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } finally { release(); }
  await holder;
  for (const result of await outcomes) {
    if (result.status === 'rejected') assert.equal(result.reason.code, 'TAG_CONFLICT', 'a conflict must not become a database deadlock');
  }
  const stored = await db.selectFrom('product_tags').select('value').where('product_id', '=', current.id).where('name', '=', 'duration').execute();
  assert.equal(stored.length, 1);
  assert.ok([60, 90].includes(stored[0]!.value as number));
});

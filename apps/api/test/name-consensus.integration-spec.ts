import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { migrateToLatest } from '../scripts/migrate.js';
import { jsonb, type DatabaseSchema, type JsonValue } from '../src/database/types.js';
import { reconcileNameConsensus } from '../src/standardization/name-consensus-repair.js';
import { chooseNameConsensus, readNameConsensusMembers, compatibleNameConsensus } from '../src/standardization/name-consensus.js';

let db: Kysely<DatabaseSchema>, admin: Pool, schema: string;
before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  schema = `name_consensus_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  process.env.PG_SCHEMA = schema;
  db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: new Pool({
    connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path="${schema}",public`,
  }) }) });
  await migrateToLatest(db);
});
after(async () => {
  await db?.destroy();
  if (admin && schema) await admin.query(`drop schema "${schema}" cascade`);
  await admin?.end();
  delete process.env.PG_SCHEMA;
});

async function standard(product: string, verified = true) {
  return db.insertInto('standard_products').values({ name: `microsoft / ${product} / standard`,
    canonical_family: 'microsoft', canonical_product: product, canonical_tier: 'standard',
    verification_state: verified ? 'verified' : 'quarantined',
  }).returning('id').executeTakeFirstOrThrow();
}
async function product(name: string, standardId: bigint, options: { source?: string; locked?: boolean; deleted?: boolean; enabled?: boolean; published?: boolean; spec?: string; evidence?: string; sourceData?: JsonValue } = {}) {
  const shop = await db.insertInto('shops').values({ name: 'Consensus test', platform: 'test',
    url: `https://${randomUUID()}.invalid`, enabled: options.enabled ?? true,
  }).returning('id').executeTakeFirstOrThrow();
  const row = await db.insertInto('products').values({ shop_id: shop.id, external_id: randomUUID(),
    name, spec: options.spec ?? '', source_data: jsonb(options.sourceData ?? { evidence: options.evidence ?? '邮箱账号' }), normalized_key: randomUUID(), url: '',
    standardization_locked: options.locked ?? false, deleted_at: options.deleted ? new Date() : null,
  }).returning('id').executeTakeFirstOrThrow();
  await db.insertInto('standard_product_members').values({ product_id: row.id, standard_product_id: standardId,
    assignment_source: options.source ?? 'ai', publication_state: options.published === false ? 'provisional' : 'published', decision_version: 42n,
  }).execute();
  return row;
}

test('repair changes minority AI members but preserves human decisions and persistent locks', async () => {
  const a = await standard('outlook');
  const b = await standard('outlook_account');
  const quarantined = await standard('outlook_unverified', false);
  const name = '微软邮箱长效 Outlook Hotmail OAuth2 双令牌';
  for (let n = 0; n < 4; n++) await product(name, a.id);
  const changed = await product(name, b.id);
  const human = await product(name, b.id, { source: 'human' });
  const locked = await product(name, b.id, { locked: true });
  const unrelated = await product('另外一款 Hotmail 邮箱商品', b.id);
  const excluded = [];
  for (let n = 0; n < 5; n++) {
    excluded.push(await product(name, b.id, { deleted: true }));
    excluded.push(await product(name, b.id, { enabled: false }));
    excluded.push(await product(name, b.id, { published: false }));
    excluded.push(await product(name, quarantined.id));
  }
  await db.insertInto('product_tags').values({ product_id: changed.id, name: 'duration', value: '1 month' }).execute();
  await db.insertInto('offers').values({ product_id: changed.id, price: '2.50', stock_available: false, idempotency_key: randomUUID() }).execute();
  const job = await db.insertInto('ai_jobs').values({ model: 'mock', status: 'succeeded', total: 1n }).returning('id').executeTakeFirstOrThrow();
  await db.insertInto('ai_job_inputs').values({ job_id: job.id, input_id: changed.id, fingerprint: 'historical', payload: jsonb({}), status: 'succeeded' }).execute();
  await db.insertInto('ai_standardization_results').values({ job_id: job.id, product_id: changed.id, input_id: changed.id,
    status: 'classified', standard_product_id: b.id, content_version: 0n, fingerprint: 'historical',
    tags: jsonb([]), evidence: jsonb([]), reason: 'original model result', decision: jsonb({ original: true }), current_assignment_preserved: false,
  }).execute();
  const productsBefore = await db.selectFrom('products').selectAll().orderBy('id').execute();
  const membershipsBefore = await db.selectFrom('standard_product_members').selectAll().orderBy('product_id').execute();
  const tags = await db.selectFrom('product_tags').selectAll().execute();
  const offers = await db.selectFrom('offers').selectAll().execute();
  const results = await db.selectFrom('ai_standardization_results').selectAll().execute();
  const version = (await db.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow()).version;
  const preview = await reconcileNameConsensus(db);
  const changedIds = [changed.id];
  assert.deepEqual(preview.changes.map(change => [change.productId, change.toStandardProductId, change.winningCount, change.runnerUpCount]), changedIds.map(id => [id, a.id, 4, 3]));
  assert.equal(preview.protectedProducts, 2);
  assert.deepEqual(await db.selectFrom('standard_product_members').selectAll().orderBy('product_id').execute(), membershipsBefore);
  await assert.rejects(reconcileNameConsensus(db, { apply: true, beforeApply: async () => { throw new Error('backup failed'); } }), /backup failed/);
  assert.deepEqual(await db.selectFrom('products').selectAll().orderBy('id').execute(), productsBefore);
  const applied = await reconcileNameConsensus(db, { apply: true, beforeApply: async plan => { assert.deepEqual(plan, preview); } });
  assert.equal(applied.changes.length, 1);
  const memberships = await db.selectFrom('standard_product_members').selectAll().orderBy('product_id').execute();
  assert.deepEqual(memberships, membershipsBefore.map(row => changedIds.includes(row.product_id) ? { ...row, standard_product_id: a.id } : row));
  assert.deepEqual(await db.selectFrom('products').selectAll().orderBy('id').execute(), productsBefore.map(row => changedIds.includes(row.id) ? { ...row, standardization_revision: row.standardization_revision + 1n } : row));
  assert.deepEqual(await db.selectFrom('product_tags').selectAll().execute(), tags);
  assert.deepEqual(await db.selectFrom('offers').selectAll().execute(), offers);
  assert.deepEqual(await db.selectFrom('ai_standardization_results').selectAll().execute(), results);
  assert.equal((await db.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow()).version, version + 1n);
  assert.ok(memberships.filter(row => [unrelated.id, ...excluded.map(p => p.id)].includes(row.product_id)).every(row => row.standard_product_id !== a.id));
  const again = await reconcileNameConsensus(db, { apply: true, beforeApply: async () => { assert.fail('no backup for no-op'); } });
  assert.equal(again.changes.length, 0);
  assert.equal((await db.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow()).version, version + 1n);
});

test('same-name relay voting retains endpoint evidence for long titles from the database', async () => {
  const alpha = await standard('alpha_relay');
  const beta = await standard('beta_relay');
  const name = '通用模型 API 中转服务 充值额度 长标题样本';
  const sourceData = (host: string) => ({ service: { name: 'Relay', url: `https://${host}.invalid/v1` }, evidence: '支持多种模型' });
  await product(name, alpha.id, { sourceData: sourceData('alpha') });
  await product(name, alpha.id, { sourceData: sourceData('alpha') });
  const separate = await product(name, beta.id, { sourceData: sourceData('beta') });
  const plan = await reconcileNameConsensus(db);
  assert.equal(plan.changes.find(change => change.productId === separate.id), undefined);
  await db.transaction().execute(async tx => {
    const members = await readNameConsensusMembers(tx, [name]);
    assert.equal(chooseNameConsensus(members).size, 2);
  });
});

test('an identical-evidence majority never overrides a proven identity contradiction', async () => {
  const wrong = await db.insertInto('standard_products').values({ name: 'ChatGPT Plus', canonical_family: 'openai', canonical_product: 'chatgpt', canonical_tier: 'plus', verification_state: 'verified' }).returning('id').executeTakeFirstOrThrow();
  const name = 'ChatGPT Pro 20x 长效独享账号';
  const description = '实际交付 ChatGPT Pro 20x 账号';
  await product(name, wrong.id, { evidence: description });
  await product(name, wrong.id, { evidence: description });
  await db.transaction().execute(async tx => {
    const members = await readNameConsensusMembers(tx, [name]);
    const winners = chooseNameConsensus(members);
    const resolved = compatibleNameConsensus({ name, spec: '', sourceCategory: null, sourceData: { evidence: description } }, winners);
    assert.equal(resolved, undefined);
  });
});

test('ties and distinct generic-title evidence keep their original assignments', async () => {
  const a = await standard('plan_a');
  const b = await standard('plan_b');
  const tied = '独立同名商品测试 票数相同保留原归属';
  await product(tied, a.id);
  await product(tied, b.id);
  await product('月卡', a.id, { evidence: '软件A' });
  await product('月卡', a.id, { evidence: '软件A' });
  const minority = await product('月卡', b.id, { evidence: '软件A' });
  await product('月卡', b.id, { evidence: '软件B' });
  await product('月卡', b.id, { evidence: '软件B' });
  await product('月卡', b.id, { evidence: '软件B' });
  const preview = await reconcileNameConsensus(db);
  assert.equal(preview.tiedGroups, 1);
  assert.deepEqual(preview.changes.filter(change => change.name === tied || change.name === '月卡').map(change => [change.productId, change.toStandardProductId]), [[minority.id, a.id]]);
});

test('identical ambiguous mailbox copy never proves a subscription through historical majority', async () => {
  const plus = await db.insertInto('standard_products').values({ name: 'openai / chatgpt / plus', canonical_family: 'openai',
    canonical_product: 'chatgpt', canonical_tier: 'plus', verification_state: 'verified',
  }).returning('id').executeTakeFirstOrThrow();
  const email = await standard('email');
  const name = '谷歌 iCloud 域名邮件 成品 Plus 质保首登';
  for (let n = 0; n < 3; n++) await product(name, plus.id, { evidence: '邮箱注册账号，登录邮箱收信' });
  const equalEvidence = await product(name, email.id, { evidence: '邮箱注册账号，登录邮箱收信' });
  const differentPlan = await product(name, email.id, { evidence: '实际交付 ChatGPT Team 5x account' });
  const preview = await reconcileNameConsensus(db);
  assert.equal(preview.changes.find(change => change.productId === equalEvidence.id), undefined);
  assert.equal(preview.changes.find(change => change.productId === differentPlan.id), undefined);
});

test('an existing writer aborts repair immediately before backup or mutation', async () => {
  const row = await db.selectFrom('products').select('id').orderBy('id').executeTakeFirstOrThrow();
  const before = await db.selectFrom('standard_product_members').selectAll().orderBy('product_id').execute();
  await db.transaction().execute(async writer => {
    await writer.selectFrom('products').select('id').where('id', '=', row.id).forUpdate().execute();
    await assert.rejects(reconcileNameConsensus(db, { apply: true, beforeApply: async () => { assert.fail('writer conflict precedes backup'); } }),
      (error: unknown) => (error as { code?: string }).code === '55P03');
  });
  assert.deepEqual(await db.selectFrom('standard_product_members').selectAll().orderBy('product_id').execute(), before);
});

test('unassigned products recover from consensus or explicit rules without AI history or tasks', async () => {
  const standardRow = await db.insertInto('standard_products').values({ name: 'Grok 普号', canonical_family: 'xai',
    canonical_product: 'grok', canonical_tier: 'free', verification_state: 'verified',
  }).returning('id').executeTakeFirstOrThrow();
  const source = await product('Grok 普号永久邮箱账号同名样本', standardRow.id, { evidence: '普通账号' });
  const missing = await product('Grok 普号永久邮箱账号同名样本', standardRow.id, { evidence: '普通账号' });
  const lockedMissing = await product('Grok 普号永久邮箱账号同名样本', standardRow.id, { evidence: '普通账号', locked: true });
  const rule = await product('Gro 普号新店独立名称账号', standardRow.id, { evidence: '普通账号' });
  const unresolved = await product('无法识别的无名独立商品', standardRow.id, { evidence: '没有品牌或档位' });
  const deleted = await product('Grok 普号永久邮箱账号同名样本', standardRow.id, { deleted: true, evidence: '普通账号' });
  await db.deleteFrom('standard_product_members').where('product_id', 'in', [missing.id, lockedMissing.id, rule.id, unresolved.id, deleted.id]).execute();
  const jobs = await db.selectFrom('ai_jobs').selectAll().execute();
  const results = await db.selectFrom('ai_standardization_results').selectAll().execute();
  const preview = await reconcileNameConsensus(db);
  assert.equal(preview.changes.find(change => change.productId === missing.id)?.method, 'same_name_majority');
  assert.equal(preview.changes.find(change => change.productId === rule.id)?.method, 'identity_rule');
  assert.equal(preview.changes.find(change => change.productId === unresolved.id), undefined);
  assert.equal(preview.changes.find(change => change.productId === deleted.id), undefined);
  assert.equal(preview.changes.find(change => change.productId === lockedMissing.id), undefined);
  await reconcileNameConsensus(db, { apply: true, beforeApply: async () => {} });
  const members = await db.selectFrom('standard_product_members').selectAll().where('product_id', 'in', [source.id, missing.id, rule.id]).orderBy('product_id').execute();
  assert.deepEqual(members.map(row => row.assignment_source), ['ai', 'consensus', 'rule']);
  assert.ok(members.every(row => row.standard_product_id === standardRow.id));
  assert.equal((await db.selectFrom('products').select('standardization_locked').where('id', '=', lockedMissing.id).executeTakeFirstOrThrow()).standardization_locked, true);
  assert.deepEqual(await db.selectFrom('ai_jobs').selectAll().execute(), jobs);
  assert.deepEqual(await db.selectFrom('ai_standardization_results').selectAll().execute(), results);
  assert.equal((await reconcileNameConsensus(db)).changes.length, 0);
});

test('rule fallback holds unassigned Team accounts with actual commercial conflicts', async () => {
  const target = await db.insertInto('standard_products').values({ name: 'Team 5X', canonical_family: 'openai', canonical_product: 'chatgpt',
    canonical_tier: 'team_5x', verification_state: 'verified' }).returning('id').executeTakeFirstOrThrow();
  const conflict = await product('Team 5X 独立成品账号 质保3小时', target.id, { evidence: 'Team 5X账号，账密2FA，仅用于反代，质保2小时。' });
  const clean = await product('Team 5X 另一款成品JSON', target.id, { evidence: 'Team 5X成品JSON，仅支持Sub2API。' });
  await db.deleteFrom('standard_product_members').where('product_id', 'in', [conflict.id, clean.id]).execute();
  const preview = await reconcileNameConsensus(db);
  assert.equal(preview.changes.find(row => row.productId === conflict.id), undefined);
  assert.equal(preview.changes.find(row => row.productId === clean.id)?.method, 'identity_rule');
});

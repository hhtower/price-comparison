import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { migrateToLatest } from '../scripts/migrate.js';
import { jsonb, type DatabaseSchema } from '../src/database/types.js';
import { ensureStandardServiceEvidence, isModelApiRelayEvidence, serviceEvidenceRequirement, serviceProviderCompatible } from '../src/standardization/provider-publication.js';
import { ProductsRepository } from '../src/products/products.repository.js';
import { AdminRepository } from '../src/admin/admin.repository.js';

let db: Kysely<DatabaseSchema>, admin: Pool, schema: string;
before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  schema = `provider_publication_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema ${schema}`); process.env.PG_SCHEMA = schema;
  db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public` }) }) });
  await migrateToLatest(db);
});
after(async () => { await db?.destroy(); if (admin && schema) await admin.query(`drop schema ${schema} cascade`); await admin?.end(); delete process.env.PG_SCHEMA; });
const listing = (host: string, seller = 'seller') => ({ name: '通用模型 API 中转充值', sourceData: { service: { name: 'Relay', url: `https://${host}.invalid/v1` }, user: { nickname: seller } } });
async function standard(product = 'api') { return db.insertInto('standard_products').values({ name: 'relay / api / standard', canonical_family: 'relay', canonical_product: product, canonical_tier: 'standard', verification_state: 'verified' }).returning('id').executeTakeFirstOrThrow(); }

test('Team credential clients and conversion endpoints cannot attach a relay provider profile', async () => {
  const target = await db.insertInto('standard_products').values({ name: 'Team 5X', canonical_family: 'openai', canonical_product: 'chatgpt',
    canonical_tier: 'team_5x', verification_state: 'verified' }).returning('id').executeTakeFirstOrThrow();
  for (const name of ['Team 5X成品JSON，仅支持Sub2API', 'Team 5X Gmail邮箱 账密2FA']) {
    const input = { name, sourceData: { evidence: 'Team 5X账号，转换格式服务地址：https://convert.invalid/v1；仅支持Sub2API。' } };
    assert.equal(isModelApiRelayEvidence(input), false);
    assert.equal(serviceEvidenceRequirement(input), null);
    assert.equal(await db.transaction().execute(tx => ensureStandardServiceEvidence(tx, target.id, input)), null);
  }
  assert.deepEqual((await db.selectFrom('standard_products').select('service_evidence').where('id', '=', target.id).executeTakeFirstOrThrow()).service_evidence, {});
});

test('two relays cannot publish to the same generic API identity while the same endpoint can cross sellers', async () => {
  const target = await standard();
  assert.equal(await db.transaction().execute(tx => ensureStandardServiceEvidence(tx, target.id, listing('alpha', '甲'))), null);
  assert.equal(await db.transaction().execute(tx => ensureStandardServiceEvidence(tx, target.id, listing('alpha', '乙'))), null);
  assert.equal(await db.transaction().execute(tx => ensureStandardServiceEvidence(tx, target.id, listing('beta'))), 'service_provider_conflict');
});

test('generic API products require an actual provider and SMS API delivery is not a model relay', async () => {
  assert.equal(serviceEvidenceRequirement({ name: '通用 API 充值' }), 'service_provider_missing');
  assert.equal(serviceEvidenceRequirement(listing('alpha')), null);
  assert.equal(serviceEvidenceRequirement({ name: 'Codex 短信 API 接码服务' }), null);
  const target = await standard();
  assert.equal(await db.transaction().execute(tx => ensureStandardServiceEvidence(tx, target.id, { name: '通用 API 充值', sourceData: { vendor: '卖家甲', description: '支持 OpenAI Claude Gemini' } })), 'service_provider_missing');
  const sms = await standard('codex_sms');
  assert.equal(await db.transaction().execute(tx => ensureStandardServiceEvidence(tx, sms.id, { name: 'Codex 短信 API 接码服务' })), null);
});

test('provider addresses preserve case-sensitive paths and tenant values', () => {
  assert.equal(isModelApiRelayEvidence({ name: '全模型通用额度', sourceData: { apiEndpoint: 'https://relay.invalid/v1' } }), true);
  assert.equal(isModelApiRelayEvidence({ name: 'Codex 短信 API 接码服务', sourceData: { apiEndpoint: 'https://sms.invalid/v1' } }), false);
  const evidence = (endpoint: string) => ({ endpoints: [endpoint], brands: ['Relay'] });
  assert.equal(serviceProviderCompatible(evidence('https://relay.invalid/A'), evidence('https://relay.invalid/a')), false);
  assert.equal(serviceProviderCompatible(evidence('https://relay.invalid/v1?tenant=A'), evidence('https://relay.invalid/v1?tenant=a')), false);
  assert.equal(serviceProviderCompatible(evidence('https://relay.invalid/v1'), { endpoints: ['https://relay.invalid/v1'], brands: ['Renamed Relay'] }), true);
});

test('bonus tutorial wording retains API credits while tutorials, SMS and mailboxes remain actual sale objects', async () => {
  const target = await standard('credits');
  await db.updateTable('standard_products').set({ service_evidence: jsonb({ state: 'verified', source: 'manual', endpoints: ['https://alpha.invalid/v1'], brands: [] }) }).where('id', '=', target.id).execute();
  const sourceData = { apiEndpoint: 'https://alpha.invalid/v1' };
  for (const name of ['全模型通用额度（附赠教程）', '模型 API 额度；附带登录教程']) {
    assert.equal(isModelApiRelayEvidence({ name, sourceData }), true, name);
    assert.equal(await db.transaction().execute(tx => ensureStandardServiceEvidence(tx, target.id, { name, sourceData })), null, name);
  }
  for (const name of ['模型 API 接入教程', 'Codex 短信 API 接码服务', 'iCloud 邮箱 API 取信服务']) {
    assert.equal(isModelApiRelayEvidence({ name, sourceData }), false, name);
    assert.equal(await db.transaction().execute(tx => ensureStandardServiceEvidence(tx, target.id, { name, sourceData })), 'service_sale_object_conflict', name);
  }
});


test('a saved provider survives the only raw listing being replaced and detached', async () => {
  const target = await standard();
  const shop = await db.insertInto('shops').values({ name: 'relay shop', platform: 'test', url: `https://shop.invalid/${randomUUID()}` }).returning('id').executeTakeFirstOrThrow();
  const repository = new ProductsRepository(db);
  const rows = await repository.upsertBatch([{ ...listing('alpha'), shopId: shop.id, externalId: 'one', normalizedKey: randomUUID(), url: '' }]);
  const productId = [...rows.values()][0]!;
  await db.transaction().execute(async tx => {
    assert.equal(await ensureStandardServiceEvidence(tx, target.id, listing('alpha')), null);
    await tx.insertInto('standard_product_members').values({ product_id: productId, standard_product_id: target.id, assignment_source: 'ai', publication_state: 'published' }).execute();
  });
  await repository.update(productId, { sourceData: listing('beta').sourceData });
  assert.equal((await db.selectFrom('standard_product_members').selectAll().where('product_id', '=', productId).execute()).length, 0);
  assert.equal(await db.transaction().execute(tx => ensureStandardServiceEvidence(tx, target.id, listing('beta'))), 'service_provider_conflict');
});

test('manual review can assign a model API relay listing after checking its sale evidence', async () => {
  const shop = await db.insertInto('shops').values({ name: 'manual provider', platform: 'test', url: `https://shop.invalid/${randomUUID()}` }).returning('id').executeTakeFirstOrThrow();
  const products = new ProductsRepository(db);
  const rows = await products.upsertBatch(['alpha', 'alpha', 'beta'].map((host, index) => ({ ...listing(host), shopId: shop.id, externalId: String(index), normalizedKey: randomUUID(), url: '' })));
  const ids = [...rows.values()];
  const target = await standard();
  const result = await new AdminRepository(db).bindProducts(ids.slice(0, 2), target.id, true);
  assert.deepEqual(result.success, ids.slice(0, 2).map(String).sort());
  assert.deepEqual(result.conflicts, []);
  const stored = await db.selectFrom('standard_products').select('service_evidence').where('id', '=', target.id).executeTakeFirstOrThrow();
  assert.notDeepEqual(stored.service_evidence, {});
  assert.equal((await db.selectFrom('standard_product_members').selectAll().where('product_id', 'in', ids.slice(0, 2)).execute()).length, 2);
  assert.equal((await db.selectFrom('product_standardization_decisions').selectAll().where('product_id', 'in', ids.slice(0, 2)).execute()).length, 2);
});

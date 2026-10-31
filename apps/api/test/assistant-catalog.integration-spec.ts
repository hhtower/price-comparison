import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test, type TestContext } from 'node:test';
import { Kysely, PostgresDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';
import { createPostgresPool } from '../src/database/database.providers.js';
import type { DatabaseSchema } from '../src/database/types.js';
import { createCache } from '../src/cache/cache.js';
import { CatalogRepository } from '../src/catalog/catalog.repository.js';
import { CatalogService } from '../src/catalog/catalog.service.js';
import { selectCandidates } from '../src/assistant/assistant-candidates.js';

// An explicit test URL is mandatory; never fall back to the configured DATABASE_URL.
describe('assistant public identity and real offers', { skip: !process.env.TEST_DATABASE_URL }, () => {
  const schema = `assistant_catalog_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let database: Kysely<DatabaseSchema>;
  let service: CatalogService;
  const cache = createCache();
  const now = new Date('2026-10-31T12:00:00Z');

  before(async () => {
    admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`create schema "${schema}"`);
    database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: createPostgresPool({
      DATABASE_URL: process.env.TEST_DATABASE_URL, PG_SCHEMA: schema,
    }) }) });
    const { error } = await new Migrator({ db: database, provider: migrationProvider, migrationTableSchema: schema }).migrateToLatest();
    if (error) throw error;
    service = new CatalogService(new CatalogRepository(database, { now: () => now.getTime(), ttlMs: 3_600_000 }), cache);
  });

  beforeEach(context => {
    (context as TestContext).mock.timers.enable({ apis: ['Date'], now: now.getTime() });
  });

  after(async () => {
    await cache.disconnect();
    await database?.destroy();
    if (admin) {
      await admin.query(`drop schema if exists "${schema}" cascade`);
      await admin.end();
    }
  });

  async function fixture(product: string) {
    const identity = { platform: 'fictional', product, tier: 'pro' };
    const shop = await database.insertInto('shops').values({
      platform: 'fictional', name: 'Fictional shop', url: `https://${product}.invalid/${randomUUID()}`, enabled: true,
    }).returning('id').executeTakeFirstOrThrow();
    const standard = await database.insertInto('standard_products').values({
      name: 'Fictional product', platform: 'Display platform', canonical_platform: identity.platform,
      canonical_family: 'fictional', canonical_product: product, canonical_tier: 'pro', verification_state: 'verified',
    }).returning('id').executeTakeFirstOrThrow();
    const source = await database.insertInto('products').values({
      shop_id: shop.id, external_id: product, name: 'Fictional source', spec: '',
      url: `https://${product}.invalid/item`, normalized_key: product,
    }).returning('id').executeTakeFirstOrThrow();
    await database.insertInto('standard_product_members').values({
      standard_product_id: standard.id, product_id: source.id, publication_state: 'published',
    }).execute();
    return { identity, shop, standard, source };
  }

  test('resolves only exact canonical identities and rejects ambiguous public matches', async () => {
    const { identity, standard } = await fixture('exact');
    assert.equal((await service.resolvePublicProductIdentity(identity))?.id, String(standard.id));
    for (const changed of [{ platform: 'Display platform' }, { platform: 'Fictional' },
      { product: 'exa' }, { tier: 'Pro' }, { product: "exact' OR true --" }, { tier: '' }]) {
      assert.equal(await service.resolvePublicProductIdentity({ ...identity, ...changed }), null);
    }
    const duplicate = await fixture('exact');
    assert.equal(await service.resolvePublicProductIdentity(identity), null);
    await database.updateTable('standard_products').set({ hidden: true }).where('id', '=', duplicate.standard.id).execute();
    assert.equal((await service.resolvePublicProductIdentity(identity))?.id, String(standard.id));
  });

  test('all public metadata paths expose the SQL platform group including canonical overrides', async () => {
    for (const [family, product, platform, platformGroup] of [
      ['google', 'email', 'Google', 'email'],
      ['network', 'ip', 'Claude', 'ip'],
      ['software', 'email', 'Google', 'other'],
      ['anthropic', 'claude', 'Claude', 'anthropic'],
      ['youtube', 'youtube', 'YouTube', 'google'],
    ]) {
      const sample = await fixture(`group-${platformGroup}`);
      await database.updateTable('standard_products').set({
        canonical_platform: family, canonical_family: family, canonical_product: product, platform,
      }).where('id', '=', sample.standard.id).execute();
      const identity = { ...sample.identity, platform: family, product };
      const resolved = await service.resolvePublicProductIdentity(identity);
      assert.equal(resolved?.platformGroup, platformGroup);
      assert.equal((await service.getProduct(String(sample.standard.id)))?.platformGroup, platformGroup);
      assert.equal((await service.getProducts()).items.find(item => item.id === String(sample.standard.id))?.platformGroup, platformGroup);
      await database.insertInto('offers').values({
        product_id: sample.source.id, price: '10.00', settlement_price: '10.00',
        settlement_quantity: 1, settlement_total_amount: '10.00', currency: 'CNY',
        idempotency_key: `group-${sample.standard.id}`, captured_at: now, settlement_verified_at: now,
        settlement_payment_method: 'alipay', stock_available: true, is_stale: false,
      }).execute();
      const page = await service.getCatalog({
        standardProductId: String(sample.standard.id), platform: platformGroup,
        detailKind: 'offers', detailPageSize: 20, currency: 'CNY',
      });
      const detail = page.items[0]?.detail;
      assert.ok(detail?.kind === 'offers');
      assert.ok(resolved);
      assert.equal(selectCandidates(detail.entries.map(offer => ({
        standardProduct: resolved, offer, capabilityEvidence: [],
      })), {
        purpose: null, platform: platformGroup, budget: null, requiredTags: [], warrantyDaysMin: null, preferences: [],
      }, now).length, 1);
    }
  });

  test('preserves hidden, verification, merge, publication, shop and source visibility boundaries', async () => {
    const { identity, standard, shop, source } = await fixture('visibility');
    for (const patch of [{ hidden: true }, { verification_state: 'provisional' }, { verification_state: 'quarantined' }] as const) {
      await database.updateTable('standard_products').set(patch).where('id', '=', standard.id).execute();
      assert.equal(await service.resolvePublicProductIdentity(identity), null);
      await database.updateTable('standard_products').set({ hidden: false, verification_state: 'verified' }).where('id', '=', standard.id).execute();
    }
    const target = await fixture('merge-target');
    await database.updateTable('standard_products').set({ merged_into_id: target.standard.id }).where('id', '=', standard.id).execute();
    assert.equal(await service.resolvePublicProductIdentity(identity), null);
    await database.updateTable('standard_products').set({ merged_into_id: null }).where('id', '=', standard.id).execute();
    for (const publication_state of ['provisional', 'quarantined'] as const) {
      await database.updateTable('standard_product_members').set({ publication_state }).where('product_id', '=', source.id).execute();
      assert.equal(await service.resolvePublicProductIdentity(identity), null);
    }
    await database.updateTable('standard_product_members').set({ publication_state: 'published' }).where('product_id', '=', source.id).execute();
    for (const patch of [{ enabled: false }, { deleted_at: now }]) {
      await database.updateTable('shops').set(patch).where('id', '=', shop.id).execute();
      assert.equal(await service.resolvePublicProductIdentity(identity), null);
      await database.updateTable('shops').set({ enabled: true, deleted_at: null }).where('id', '=', shop.id).execute();
    }
    await database.updateTable('products').set({ deleted_at: now }).where('id', '=', source.id).execute();
    assert.equal(await service.resolvePublicProductIdentity(identity), null);
    await database.updateTable('products').set({ deleted_at: null }).where('id', '=', source.id).execute();
    assert.ok(await service.resolvePublicProductIdentity(identity));
  });

  test('real catalog offers never combine one price with another SKU warranty', async () => {
    const { identity, standard, shop, source } = await fixture('offers');
    const covered = await database.insertInto('products').values({
      shop_id: shop.id, external_id: 'covered', name: 'Covered fictional source', spec: '',
      url: 'https://offers.invalid/covered', normalized_key: 'covered',
    }).returning('id').executeTakeFirstOrThrow();
    await database.insertInto('standard_product_members').values({
      standard_product_id: standard.id, product_id: covered.id, publication_state: 'published',
    }).execute();
    await database.insertInto('product_tags').values([
      { product_id: source.id, name: 'access', value: 'dedicated' },
      { product_id: covered.id, name: 'access', value: 'dedicated' },
      { product_id: covered.id, name: 'warranty_days', value: '30' },
    ]).execute();
    await database.insertInto('offers').values([
      { product_id: source.id, price: '5.00', settlement_price: '5.00', idempotency_key: 'cheap' },
      { product_id: covered.id, price: '20.00', settlement_price: '20.00', idempotency_key: 'covered' },
    ].map(offer => ({
      ...offer, currency: 'CNY', settlement_quantity: 1, settlement_total_amount: offer.price, captured_at: now,
      settlement_verified_at: now, settlement_payment_method: 'alipay', stock_available: true, is_stale: false,
    }))).execute();
    const standardProduct = await service.resolvePublicProductIdentity(identity);
    assert.ok(standardProduct);
    const page = await service.getCatalog({
      standardProductId: standardProduct.id, currency: 'CNY', detailKind: 'offers', detailPageSize: 20,
    });
    const detail = page.items[0]?.detail;
    assert.ok(detail?.kind === 'offers');
    assert.equal(detail.entries.length, 2);
    const needs = {
      purpose: null, platform: null, budget: { amount: '10.00', currency: 'CNY', basis: 'purchase' as const },
      requiredTags: [{ name: 'access', value: 'dedicated' }], warrantyDaysMin: 30, preferences: [],
    };
    const before = structuredClone(needs);
    assert.deepEqual(selectCandidates(detail.entries.map(offer => ({
      standardProduct, offer, capabilityEvidence: [],
    })), needs, now), []);
    assert.deepEqual(needs, before);
    assert.equal(selectCandidates(detail.entries.map(offer => ({
      standardProduct, offer, capabilityEvidence: [],
    })), { ...needs, budget: { ...needs.budget, amount: '20.00' } }, now)[0]?.offer.productId, String(covered.id));
  });
});

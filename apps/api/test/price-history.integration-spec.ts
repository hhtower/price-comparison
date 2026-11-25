import { withMembershipSource } from './membership-fixture.js';
import { MEMBERSHIP_GROUPS } from '@price-comparison/catalog/membership-policy';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { Kysely, PostgresDialect, sql, type CompiledQuery } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';
import { createPostgresPool } from '../src/database/database.providers.js';
import { jsonb, type DatabaseSchema, type JsonValue } from '../src/database/types.js';
import { buildMembershipFeatures } from '../src/standardization/membership-classification.js';
import type { MembershipKind } from '@price-comparison/catalog/membership-policy';
import { PriceHistoryRepository, type PriceHistoryScope } from '../src/catalog/price-history.repository.js';
import { CatalogService } from '../src/catalog/catalog.service.js';
import { CatalogRepository } from '../src/catalog/catalog.repository.js';
import { CatalogController } from '../src/catalog/catalog.controller.js';

const now = Date.parse('2026-10-14T12:00:00Z');
const schema = `price_history_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
let admin: Pool;
let db: Kysely<DatabaseSchema>;
let history: PriceHistoryRepository;
let standard: bigint;
let product: bigint;
let shop: bigint;
let lastQuery: CompiledQuery | undefined;

before(async () => {
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.ok(connectionString, 'TEST_DATABASE_URL is required');
  admin = new Pool({ connectionString });
  await admin.query(`create schema ${schema}`);
  db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: createPostgresPool({
    ...process.env, DATABASE_URL: connectionString, PG_SCHEMA: schema,
  }) }), log: event => { if (event.level === 'query') lastQuery = event.query; } });
  const { error } = await new Migrator({ db, provider: migrationProvider, migrationTableSchema: schema }).migrateToLatest();
  if (error) throw error;
  history = new PriceHistoryRepository(db, { now: () => now, ttlMs: 8100000 });
});
after(async () => {
  await db?.destroy();
  await admin?.query(`drop schema if exists ${schema} cascade`);
  await admin?.end();
});
beforeEach(async () => {
  await db.deleteFrom('products').execute();
  await db.deleteFrom('standard_products').execute();
  await db.deleteFrom('shops').execute();
  shop = (await db.insertInto('shops').values({ name: '历史商铺', platform: 'test', url: 'https://history.invalid' }).returning('id').executeTakeFirstOrThrow()).id;
  standard = (await db.insertInto('standard_products').values({ name: '测试会员', platform: 'openai', verification_state: 'verified' }).returning('id').executeTakeFirstOrThrow()).id;
  product = await addProduct('月付会员');
});
async function addProduct(name: string) {
  const row = await db.insertInto('products').values({ shop_id: shop, external_id: name, name, normalized_key: name, url: 'https://history.invalid/buy', content_changed_at: new Date('2026-09-01T00:00:00Z') }).returning('id').executeTakeFirstOrThrow();
  await db.insertInto('standard_product_members').values({ standard_product_id: standard, product_id: row.id, publication_state: 'published' }).execute();
  return row.id;
}
async function quote(id = product, price = '10.30', at = '2026-10-13T12:00:00Z', currency = 'CNY', quantity = 1, totalAmount = price) {
  return db.insertInto('offers').values({ product_id: id, idempotency_key: `history:${id}`, price: '12.00', currency,
    captured_at: new Date(at), settlement_price: price, settlement_verified_at: new Date(at), settlement_payment_method: 'Alipay',
    settlement_quantity: quantity, settlement_total_amount: totalAmount,
  }).returning('id').executeTakeFirstOrThrow();
}
async function points(productId?: string, currency = 'CNY') { return (await history.get(String(standard), productId, currency)).points; }

test('records inserts and re-verifications atomically without treating cached refreshes as new history', async () => {
  const offer = await quote();
  await db.updateTable('offers').set({ captured_at: new Date('2026-10-14T10:00:00Z') }).where('id', '=', offer.id).execute();
  assert.equal((await db.selectFrom('offer_price_history').selectAll().execute()).length, 1);
  await db.updateTable('offers').set({ settlement_price: '9.50', settlement_total_amount: '9.50', settlement_verified_at: new Date('2026-10-14T10:00:00Z') }).where('id', '=', offer.id).execute();
  assert.deepEqual((await points()).map(p => [p.date, p.price, p.quantity]), [['2026-10-13', '10.30', 1], ['2026-10-14', '9.50', 1]]);
  await assert.rejects(db.transaction().execute(async tx => {
    await tx.updateTable('offers').set({ settlement_price: '1.00', settlement_total_amount: '1.00', settlement_verified_at: new Date('2026-10-14T11:00:00Z') }).where('id', '=', offer.id).execute();
    throw new Error('rollback history');
  }), /rollback history/);
  assert.equal((await db.selectFrom('offer_price_history').selectAll().execute()).length, 2);
});

test('returns observed daily minima in Shanghai time and keeps quantities, versions and currencies separate', async () => {
  const offer = await quote(product, '10.30', '2026-10-12T15:59:59Z');
  await db.updateTable('offers').set({ settlement_price: '9.00', settlement_total_amount: '9.00', settlement_verified_at: new Date('2026-10-12T16:00:00Z') }).where('id', '=', offer.id).execute();
  const second = await addProduct('5件会员');
  await quote(second, '2.002', '2026-10-13T12:00:00Z', 'CNY', 5, '10.01');
  await db.updateTable('offers').set({ settlement_quantity: 5, settlement_total_amount: '10.01', settlement_verified_at: new Date('2026-10-13T12:01:00Z') }).where('product_id', '=', second).execute();
  const dollars = await addProduct('美元会员');
  await quote(dollars, '0.50', '2026-10-14T10:00:00Z', 'USD');
  await db.updateTable('products').set({ content_version: 2n, name: '新版会员' }).where('id', '=', product).execute();
  await db.updateTable('offers').set({ settlement_price: '8.00', settlement_total_amount: '8.00', settlement_verified_at: new Date('2026-10-14T10:00:00Z') }).where('id', '=', offer.id).execute();
  const daily = await points();
  const window = await history.get(String(standard));
  assert.equal(window.startDate, '2026-09-15');
  assert.equal(window.endDate, '2026-10-14');
  const nextDay = await new PriceHistoryRepository(db, { now: () => Date.parse('2026-10-14T16:00:00Z'), ttlMs: 8100000 }).get(String(standard));
  assert.equal(nextDay.startDate, '2026-09-16');
  assert.equal(nextDay.endDate, '2026-10-15');
  assert.deepEqual(daily.map(p => [p.date, p.price]), [['2026-10-12', '10.30'], ['2026-10-13', '2.002'], ['2026-10-14', '8.00']]);
  assert.equal(daily[1]!.quantity, 5);
  assert.equal(daily[1]!.name, '5件会员');
  const own = await points(String(product));
  assert.deepEqual(own.map(p => [p.price, p.contentVersion, p.name]), [['10.30', '0', '月付会员'], ['9.00', '0', '月付会员'], ['8.00', '2', '新版会员']]);
  assert.deepEqual((await points(undefined, 'USD')).map(p => p.price), ['0.50']);
});

test('estimates neither create verified history nor appear as historical verified minima', async () => {
  await db.insertInto('offers').values({
    product_id: product, idempotency_key: 'estimate', price: '12.00', currency: 'CNY',
    captured_at: new Date('2026-10-14T10:00:00Z'), settlement_price: '12.48',
    settlement_quantity: 1, settlement_total_amount: '12.48',
    settlement_verified_at: new Date('2026-10-14T10:00:00Z'),
    settlement_kind: 'estimated',
    settlement_payment_method: '支付价（预估：售价加4%）',
  }).execute();
  assert.equal((await db.selectFrom('offer_price_history').selectAll().execute()).length, 0);
  await quote(await addProduct('actual'), '13.00');
  // Keep legacy estimates for audit without treating them as verified observations.
  await db.insertInto('offer_price_history').values({
    product_id: product, standard_product_id: standard, content_version: 0n,
    name: 'legacy estimate', spec: '', price: '1.00', currency: 'CNY', quantity: 1,
    payment_method: '支付价（预估：售价）', settlement_kind: 'estimated', verified_at: new Date('2026-10-13T11:00:00Z'),
  }).execute();
  assert.deepEqual((await points()).map(point => point.price), ['13.00']);
  assert.equal((await db.selectFrom('offer_price_history').selectAll().execute()).length, 2);
});

test('excludes invalid, missing, future and outside-window settlements but preserves zero', async () => {
  const offer = await quote(product, '0', '2026-10-14T09:00:00Z');
  assert.equal((await points())[0]!.price, '0');
  await db.updateTable('offers').set({ settlement_price: null, settlement_quantity: null, settlement_total_amount: null, settlement_verified_at: null, settlement_payment_method: null }).where('id', '=', offer.id).execute();
  assert.equal((await points()).length, 1);
  await quote(await addProduct('旧报价'), '1.00', '2026-09-14T15:59:59Z');
  await quote(await addProduct('未来报价'), '1.00', '2026-10-15T12:00:00Z');
  await quote(await addProduct('边界报价'), '3.00', '2026-09-14T16:00:00Z');
  assert.deepEqual((await points()).map(p => p.date), ['2026-09-15', '2026-10-14']);
  const invalidId = await addProduct('异常标价');
  const invalid = await quote(invalidId, '4.00', '2026-10-13T12:00:00Z');
  await db.updateTable('offers').set({ price: 'NaN', settlement_price: '1.00', settlement_total_amount: '1.00', settlement_verified_at: new Date('2026-10-14T10:00:00Z') }).where('id', '=', invalid.id).execute();
  assert.equal((await db.selectFrom('offer_price_history').selectAll().where('product_id', '=', invalidId).execute()).length, 1);
});

test('daily winners order by numeric price, latest verification, then lowest product id and keep the winning snapshot', async () => {
  const second = await addProduct('second tie');
  const third = await addProduct('later verification');
  await quote(product, '9.00', '2026-10-13T10:00:00Z');
  await quote(second, '9.00', '2026-10-13T10:00:00Z');
  const offer = await quote(third, '10.00', '2026-10-13T11:00:00Z');
  assert.equal((await points())[0]!.productId, String(product), 'numeric price precedes verification time and product id breaks exact ties');
  await db.updateTable('products').set({ name: 'winning snapshot', spec: 'historical spec', content_version: 3n })
    .where('id', '=', third).execute();
  await db.updateTable('offers').set({ settlement_price: '9.00', settlement_total_amount: '18.00',
    settlement_quantity: 2, settlement_payment_method: 'Card', settlement_verified_at: new Date('2026-10-13T12:00:00Z') })
    .where('id', '=', offer.id).execute();
  await db.updateTable('products').set({ name: 'current name', spec: 'current spec', content_version: 4n })
    .where('id', '=', third).execute();
  await db.updateTable('shops').set({ name: 'current shop' }).where('id', '=', shop).execute();
  assert.deepEqual(await points(), [{
    date: '2026-10-13', price: '9.00', verifiedAt: '2026-10-13T12:00:00.000Z',
    productId: String(third), shop: 'current shop', name: 'winning snapshot', spec: 'historical spec',
    quantity: 2, contentVersion: '3', paymentMethod: 'Card',
  }]);
  assert.equal((await points(String(second)))[0]!.productId, String(second));
});

test('filters same-day future minima before choosing a winner and includes the exact current instant', async () => {
  const offer = await quote(product, '9.00', '2026-10-14T12:00:00Z');
  await quote(await addProduct('future minimum'), '0.00', '2026-10-14T12:00:01Z');
  await quote(await addProduct('previous instant'), '10.00', '2026-10-14T11:59:59Z');
  await db.updateTable('offers').set({
    settlement_price: '0.00', settlement_total_amount: '0.00', settlement_verified_at: new Date('2026-10-14T12:00:01Z'),
  }).where('id', '=', offer.id).execute();
  assert.deepEqual((await points()).map(point => [point.price, point.verifiedAt]), [['9.00', '2026-10-14T12:00:00.000Z']]);
  assert.deepEqual(await points(String(product)), await points());
});

test('reselects the daily minimum from currently visible products before fetching its details', async () => {
  const second = await addProduct('visible fallback');
  await quote(product, '1.00');
  await quote(second, '20.00');
  await db.updateTable('products').set({ deleted_at: new Date(now) }).where('id', '=', product).execute();
  assert.deepEqual((await points()).map(point => point.productId), [String(second)]);
  assert.deepEqual(await points(String(product)), []);
  await db.updateTable('shops').set({ deleted_at: new Date(now) }).where('id', '=', shop).execute();
  assert.deepEqual(await points(), []);
  await db.updateTable('shops').set({ deleted_at: null }).where('id', '=', shop).execute();
  await db.updateTable('standard_products').set({ verification_state: 'provisional' }).where('id', '=', standard).execute();
  assert.deepEqual(await points(), []);
  const target = (await db.insertInto('standard_products').values({ name: 'merge target', verification_state: 'verified' })
    .returning('id').executeTakeFirstOrThrow()).id;
  await db.updateTable('standard_products').set({ verification_state: 'verified', merged_into_id: target }).where('id', '=', standard).execute();
  assert.deepEqual(await points(), []);
});

test('retains unavailable price history but respects public membership, hidden products, disabled shops and reassignment', async () => {
  await quote();
  await db.updateTable('offers').set({ is_stale: true, stock_available: false }).execute();
  assert.equal((await points()).length, 1);
  await db.updateTable('shops').set({ enabled: false }).where('id', '=', shop).execute();
  assert.equal((await points()).length, 0);
  await db.updateTable('shops').set({ enabled: true }).where('id', '=', shop).execute();
  await db.updateTable('standard_products').set({ hidden: true }).where('id', '=', standard).execute();
  assert.equal((await points()).length, 0);
  await db.updateTable('standard_products').set({ hidden: false }).where('id', '=', standard).execute();
  await db.updateTable('standard_product_members').set({ publication_state: 'quarantined' }).where('product_id', '=', product).execute();
  assert.equal((await points()).length, 0);
  const other = (await db.insertInto('standard_products').values({ name: '另一商品', verification_state: 'verified' }).returning('id').executeTakeFirstOrThrow()).id;
  await db.updateTable('standard_product_members').set({ standard_product_id: other, publication_state: 'published' }).where('product_id', '=', product).execute();
  assert.equal((await history.get(String(other))).points.length, 0);
});

test('validates history parameters before querying and returns no private source data', async () => {
  const service = new CatalogService(new CatalogRepository(db, { now: () => now, ttlMs: 8100000 }), {} as never);
  for (const [id, productId, currency] of [['0', undefined, 'CNY'], [String(standard), 'bad', 'CNY'], [String(standard), undefined, 'cny']]) {
    await assert.rejects(async () => service.getPriceHistory(id!, productId, currency), { name: 'DomainValidationError' });
  }
  await quote();
  const controller = new CatalogController(service);
  assert.equal((await controller.getPriceHistory(String(standard), { productId: String(product), currency: 'CNY' })).points.length, 1);
  await db.updateTable('standard_products').set({ hidden: true }).where('id', '=', standard).execute();
  await assert.rejects(() => controller.getPriceHistory(String(standard), {}), error => (error as { getStatus(): number }).getStatus() === 404);
  await db.updateTable('standard_products').set({ hidden: false }).where('id', '=', standard).execute();
  const point = (await points())[0]!;
  assert.equal('source_data' in point, false);
});

test('history scopes separate membership daily minima and include only failed AI features as unclassified', async () => {
  await db.updateTable('standard_products').set({ canonical_family: 'openai', canonical_product: 'chatgpt', canonical_tier: 'plus' })
    .where('id', '=', standard).execute();
  const ids: Record<string, bigint> = { unknown: product };
  for (const [kind, price] of [['account', '40.00'], ['top_up', '30.00'], ['rental', '10.00'], ['short_term', '8.00']] as const) {
    const id = await addProduct(kind);
    ids[kind] = id;
    const current = await db.selectFrom('products').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    await db.updateTable('products').set({ membership_features: jsonb(buildMembershipFeatures([], await withMembershipSource(db, current), [], kind) as unknown as JsonValue) })
      .where('id', '=', id).execute();
    const offer = await quote(id, price);
    await db.updateTable('offers').set({ settlement_price: String(Number(price) - 1), settlement_total_amount: String(Number(price) - 1), settlement_verified_at: new Date('2026-10-14T10:00:00Z') })
      .where('id', '=', offer.id).execute();
  }
  await quote(product, '2.00');
  const staleId = await addProduct('stale-account');
  const staleProduct = await db.selectFrom('products').selectAll().where('id', '=', staleId).executeTakeFirstOrThrow();
  await db.updateTable('products').set({ membership_features: jsonb({ ...buildMembershipFeatures([], await withMembershipSource(db, staleProduct), [], 'account'),
    policyVersion: 'stale' } as unknown as JsonValue) }).where('id', '=', staleId).execute();
  await quote(staleId, '3.00', '2026-10-14T10:00:00Z');
  assert.deepEqual((await history.get(String(standard), undefined, 'CNY', { membershipKinds: ['unclassified'] })).points, []);
  const featureJob = await db.insertInto('ai_jobs').values({ status: 'failed', total: 2n, model: 'test', job_type: 'membership_features' })
    .returning('id').executeTakeFirstOrThrow();
  await sql`insert into ai_job_inputs (job_id, input_id, fingerprint, payload)
    select ${featureJob.id}, id, content_fingerprint, '{}'::jsonb from products where id in (${product}, ${staleId})`.execute(db);
  await sql`insert into ai_job_input_members (job_id, input_id, product_id, content_version, fingerprint,
    standardization_revision, payload, status)
    select ${featureJob.id}, p.id, p.id, p.content_version, p.content_fingerprint, p.standardization_revision,
      jsonb_build_object('shopSource', jsonb_build_object('url', sh.url, 'protocol', sh.protocol, 'platform', sh.platform)), 'unclassified'
    from products p join shops sh on sh.id = p.shop_id where p.id in (${product}, ${staleId})`.execute(db);
  const dollars = await addProduct('dollar-account');
  const dollarProduct = await db.selectFrom('products').selectAll().where('id', '=', dollars).executeTakeFirstOrThrow();
  await db.updateTable('products').set({ membership_features: jsonb(buildMembershipFeatures([], await withMembershipSource(db, dollarProduct), [], 'account') as unknown as JsonValue) })
    .where('id', '=', dollars).execute();
  await quote(dollars, '0.50', '2026-10-13T12:00:00Z', 'USD');

  const controller = new CatalogController(new CatalogService(new CatalogRepository(db, { now: () => now, ttlMs: 8100000 }), {} as never));
  const prices = async (scope: Record<string, unknown>) => (await controller.getPriceHistory(String(standard), scope)).points
    .map(point => [point.date, point.price]);
  assert.deepEqual(await prices({ membershipKind: 'account' }), [['2026-10-13', '40.00'], ['2026-10-14', '39']]);
  assert.deepEqual(await prices({ membershipKind: 'top_up' }), [['2026-10-13', '30.00'], ['2026-10-14', '29']]);
  assert.deepEqual(await prices({ membershipKind: 'rental' }), [['2026-10-13', '10.00'], ['2026-10-14', '9']]);
  assert.deepEqual(await prices({ membershipKind: 'short_term' }), [['2026-10-13', '8.00'], ['2026-10-14', '7']]);
  assert.deepEqual(await prices({ membershipKind: ['account', 'top_up'] }), [['2026-10-13', '30.00'], ['2026-10-14', '29']]);
  assert.deepEqual(await prices({ membershipKinds: ['account', 'top_up'] }), await prices({ membershipKind: ['account', 'top_up'] }));
  assert.deepEqual(await prices({ newcomer: 'true' }), [['2026-10-13', '30.00'], ['2026-10-14', '29']]);
  assert.deepEqual(await prices({ newcomer: 'true', membershipKind: ['rental', 'short_term'] }), [['2026-10-13', '8.00'], ['2026-10-14', '7']]);
  assert.deepEqual(await prices({ membershipKind: ['account'], productId: String(ids.rental) }), []);
  assert.deepEqual(await prices({ membershipKind: 'account', currency: 'USD', productId: String(dollars) }), [['2026-10-13', '0.50']]);
  assert.deepEqual(await prices({ membershipKind: 'short_term', productId: String(product) }), []);
  assert.deepEqual(await prices({ membershipKind: 'short_term', productId: String(staleId) }), []);
  assert.deepEqual(await prices({ membershipKind: 'unclassified', newcomer: true }), [['2026-10-13', '2.00'], ['2026-10-14', '3.00']]);
  assert.deepEqual(await prices({ membershipKind: ['account', 'unclassified'] }), [['2026-10-13', '2.00'], ['2026-10-14', '3.00']]);
  for (const status of ['queued', 'processing', 'cancelled', 'classified']) {
    await db.updateTable('ai_job_input_members').set({ status }).where('job_id', '=', featureJob.id).execute();
    assert.deepEqual(await prices({ membershipKind: 'unclassified' }), [], status);
    assert.deepEqual(await prices({ membershipKind: ['account', 'unclassified'] }), [['2026-10-13', '40.00'], ['2026-10-14', '39']], status);
  }
  await db.updateTable('ai_job_input_members').set({ status: 'failed' }).where('job_id', '=', featureJob.id).execute();
  assert.deepEqual(await prices({ membershipKind: 'unclassified' }), [['2026-10-13', '2.00'], ['2026-10-14', '3.00']]);
  assert.deepEqual(await prices({}), [['2026-10-13', '2.00'], ['2026-10-14', '3.00']]);
  assert.equal((await db.selectFrom('products').select('membership_features').where('id', '=', product).executeTakeFirstOrThrow()).membership_features, null);

  const current = await db.selectFrom('products').selectAll().where('id', '=', ids.account!).executeTakeFirstOrThrow();
  await db.updateTable('products').set({ membership_features: jsonb(buildMembershipFeatures([], await withMembershipSource(db, current), [], 'rental') as unknown as JsonValue) })
    .where('id', '=', ids.account!).execute();
  assert.deepEqual(await prices({ membershipKind: 'account', productId: String(ids.account) }), []);
  assert.deepEqual(await prices({ membershipKind: 'rental', productId: String(ids.account) }), [['2026-10-13', '40.00'], ['2026-10-14', '39']]);
  await db.updateTable('standard_product_members').set({ publication_state: 'provisional' }).where('product_id', '=', ids.account!).execute();
  assert.deepEqual(await prices({ membershipKind: 'rental', productId: String(ids.account) }), []);
});

test('newcomer history keeps non-AI products while explicit membership kinds exclude them', async () => {
  await db.updateTable('standard_products').set({ canonical_family: 'google', canonical_product: 'email', canonical_tier: 'standard' })
    .where('id', '=', standard).execute();
  await quote();
  assert.equal((await history.get(String(standard), undefined, 'CNY', { newcomer: true })).points.length, 1);
  const service = new CatalogService(new CatalogRepository(db, { now: () => now, ttlMs: 8100000 }), {} as never);
  assert.deepEqual((await service.getPriceHistory(String(standard), undefined, 'CNY', { membershipKind: 'unclassified' })).points, []);
  for (const kind of ['account', 'top_up', 'rental', 'short_term'] as MembershipKind[]) {
    assert.deepEqual((await history.get(String(standard), undefined, 'CNY', { membershipKinds: [kind], newcomer: true })).points, []);
  }
});

test('history rejects malformed membership and newcomer filters through the public service and controller', async () => {
  const service = new CatalogService(new CatalogRepository(db), {} as never);
  const controller = new CatalogController(service);
  for (const scope of [
    { membershipKind: 'unknown' }, { membershipKind: [] }, { membershipKind: ['account', 'unknown'] },
    { membershipKind: null }, { membershipKind: {} }, { membershipKind: Array(MEMBERSHIP_GROUPS.length + 1).fill('account') },
    { membershipKinds: 'account' }, { membershipKind: 'account', membershipKinds: ['rental'] },
    { newcomer: 'yes' }, { newcomer: ['true', 'false'] }, { newcomer: null },
  ]) {
    await assert.rejects(() => service.getPriceHistory(String(standard), undefined, 'CNY', scope), { name: 'DomainValidationError' });
    await assert.rejects(() => controller.getPriceHistory(String(standard), scope), { name: 'DomainValidationError' });
  }
});

test('daily index migration preserves history and can roll back and reapply', async () => {
  const migration = await import('../src/database/migrations/063_price_history_20261125.js');
  await quote();
  const previous = await points();
  const records = await db.selectFrom('offer_price_history').selectAll().execute();
  await migration.down(db as Kysely<unknown>);
  assert.deepEqual(await points(), previous);
  await migration.up(db as Kysely<unknown>);
  assert.deepEqual(await points(), previous);
  assert.deepEqual(await db.selectFrom('offer_price_history').selectAll().execute(), records);
});

for (const [productCount, observations] of [[200, 2000], [8000, 50]] as const) {
test(`daily history uses bounded index candidates with ${productCount} products and ${observations} observations each`, async t => {
  const excluded = productCount === 8000 ? 100 : 20;
  const highPriceStart = productCount * 0.9;
  await sql`insert into products (shop_id, external_id, name, normalized_key, url, deleted_at)
    select ${shop}, 'scale-' || n, 'scale-' || n, 'scale-' || n, 'https://history.invalid',
      case when n < ${excluded / 2} then now() end
    from generate_series(0, ${productCount - 1}) n`.execute(db);
  await sql`insert into standard_product_members (standard_product_id, product_id, publication_state)
    select ${standard}, id, case when external_id::text in
      (select 'scale-' || n from generate_series(${excluded / 2}::int, ${excluded - 1}::int) n) then 'quarantined' else 'published' end
    from products where external_id like 'scale-%'`.execute(db);
  await sql`insert into offer_price_history (product_id, standard_product_id, content_version, name, spec,
    price, currency, quantity, payment_method, settlement_kind, verified_at)
    select p.id, ${standard}, 0, p.name, '', substring(p.external_id from 7)::int + 1,
      'CNY', 1, 'Card', 'verified',
      '2026-09-14T16:00:00Z'::timestamptz + (n % 30) * interval '1 day' + n * interval '1 second'
        + substring(p.external_id from 7)::int * interval '1 millisecond'
    from products p cross join generate_series(0, ${observations - 1}) n where p.external_id like 'scale-%'`.execute(db);
  await db.updateTable('standard_products').set({
    canonical_family: 'openai', canonical_product: 'chatgpt', canonical_tier: 'plus',
  }).where('id', '=', standard).execute();
  const selected = await db.selectFrom('products').selectAll().where('external_id', '=', `scale-${productCount - 1}`).executeTakeFirstOrThrow();
  const features = buildMembershipFeatures([], await withMembershipSource(db, selected), [], 'account');
  if (productCount === 8000) {
    await sql`insert into standard_products (name, verification_state)
      select 'unrelated-' || n, 'verified' from generate_series(0, 99) n`.execute(db);
    await sql`insert into products (shop_id, external_id, name, normalized_key, url)
      select ${shop}, 'unrelated-' || n, 'unrelated-' || n, 'unrelated-' || n, 'https://history.invalid'
      from generate_series(0, 31999) n`.execute(db);
    await sql`insert into standard_product_members (standard_product_id, product_id, publication_state)
      select sp.id, p.id, 'published' from products p
      join standard_products sp on sp.name = 'unrelated-' || (substring(p.external_id from 11)::int % 100)
      where p.external_id like 'unrelated-%'`.execute(db);
    await sql`insert into offer_price_history (product_id, standard_product_id, content_version, name, spec,
      price, currency, quantity, payment_method, settlement_kind, verified_at)
      select p.id, m.standard_product_id, 0, p.name, '', 1, 'CNY', 1, 'Card', 'verified',
        '2026-09-14T16:00:00Z'::timestamptz + n * interval '1 day'
      from products p join standard_product_members m on m.product_id = p.id
      cross join generate_series(0, 4) n where p.external_id like 'unrelated-%'`.execute(db);
  }
  await sql`update products p set membership_features = ${jsonb(features as unknown as JsonValue)} ||
    jsonb_build_object('contentVersion', p.content_version::text, 'fingerprint', p.content_fingerprint,
      'revision', p.standardization_revision::text, 'decision', jsonb_build_object('reason', 'llm_reviewed',
        'kind', case when substring(p.external_id from 7)::int >= ${highPriceStart} then 'short_term' else 'account' end))
    where p.external_id like 'scale-%'`.execute(db);
  for (const table of ['products', 'standard_product_members', 'standard_products', 'offer_price_history']) {
    await sql`analyze ${sql.table(table)}`.execute(db);
  }
  type Plan = { [key: string]: any; Plans?: Plan[] };
  const nodes = (node: Plan): Plan[] => [node, ...(node.Plans ?? []).flatMap(nodes)];
  const cases: { name: string; productId?: string; scope?: PriceHistoryScope; price?: string }[] = [
    { name: 'all', price: String(excluded + 1) },
    { name: 'group', scope: { membershipKinds: ['account'] }, price: String(excluded + 1) },
    { name: 'single', productId: String(selected.id), price: String(productCount) },
    { name: 'high-price subset', scope: { membershipKinds: ['short_term'] }, price: String(highPriceStart + 1) },
    { name: 'empty membership', scope: { membershipKinds: ['rental'] } },
  ];
  const catalog = new CatalogRepository(db, { now: () => now, ttlMs: 8100000 });
  for (const scenario of cases) {
    const daily = (await history.get(String(standard), scenario.productId, 'CNY', scenario.scope)).points;
    assert.equal(daily.length, scenario.price ? 30 : 0);
    assert.ok(daily.every(point => point.price === scenario.price));
    const query = lastQuery!;
    const result = await db.executeQuery<{ 'QUERY PLAN': Array<{ Plan: Plan; 'Execution Time': number }> }>({
      ...query, sql: `explain (analyze, buffers, format json) ${query.sql}`,
    });
    const explain = result.rows[0]!['QUERY PLAN'][0]!;
    const scans = nodes(explain.Plan).filter(node => node['Relation Name'] === 'offer_price_history');
    const rejected = scans.reduce((sum, node) => sum + node['Actual Loops'] *
      ((node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Index Recheck'] ?? 0)), 0);
    const visited = rejected + scans.reduce((sum, node) => sum + node['Actual Loops'] * node['Actual Rows'], 0);
    t.diagnostic(`${scenario.name}: ${explain['Execution Time']} ms; ${visited} history candidates (${rejected} rejected); ` +
      `${explain.Plan['Shared Hit Blocks']} total buffer hits, ${explain.Plan['Shared Read Blocks']} reads; indexes ` +
      scans.map(node => `${node['Index Name']} (${node['Shared Hit Blocks']} hits, ${node['Shared Read Blocks']} reads)`).join(', '));
    if (scenario.productId) {
      const buffers = scans.reduce((sum, node) => sum + node['Shared Hit Blocks'] + node['Shared Read Blocks'], 0);
      assert.ok(buffers <= observations + 500, `single-product history must not walk other products' index pages: ${buffers}`);
      assert.ok(visited <= observations + 60, `single-product scans must stay within its own daily observations: ${visited}`);
    } else {
      assert.ok(visited <= 90, `history scans must stop at daily winners, visited ${visited}`);
      assert.ok(scans.some(node => node['Index Name'] === 'offer_price_history_verified_daily'));
    }
    const started = performance.now();
    const wrapped = await catalog.priceHistory(String(standard), scenario.productId, 'CNY', scenario.scope);
    t.diagnostic(`${scenario.name}: CatalogRepository.priceHistory ${(performance.now() - started).toFixed(3)} ms`);
    assert.deepEqual(wrapped.points, daily);
  }
});
}

test('migration seeds genuine existing quotes and downgrades without modifying offers', async t => {
  const migration = await import('../src/database/migrations/011_price_history_20261014.js');
  t.after(async () => {
    const contract = await import('../src/database/migrations/058_settlement_data_contract_20261124.js');
    await contract.up(db as Kysely<unknown>);
  });
  const stored = async () => (await sql<{ verified_at: Date }>`select verified_at from offer_price_history`.execute(db)).rows;
  await migration.down(db as Kysely<unknown>);
  await quote();
  await db.insertInto('offers').values({ idempotency_key: 'new-unverified', product_id: product, price: '12', captured_at: new Date('2026-10-14T09:00:00Z') }).execute();
  await migration.up(db as Kysely<unknown>);
  assert.equal((await stored()).length, 0);
  await db.deleteFrom('offers').where('idempotency_key', '=', 'new-unverified').execute();
  await db.updateTable('products').set({ name: '新版会员', content_version: 2n, content_changed_at: new Date('2026-10-14T09:00:00Z') }).where('id', '=', product).execute();
  await migration.down(db as Kysely<unknown>);
  await migration.up(db as Kysely<unknown>);
  assert.equal((await stored()).length, 0, 'older verification cannot be seeded as a newer product version');
  await db.updateTable('products').set({ name: '月付会员', content_version: 0n, content_changed_at: new Date('2026-09-01T00:00:00Z') }).where('id', '=', product).execute();
  await migration.down(db as Kysely<unknown>);
  await migration.up(db as Kysely<unknown>);
  assert.equal((await stored())[0]!.verified_at.toISOString(), '2026-10-13T12:00:00.000Z');
  await db.updateTable('offers').set({ captured_at: new Date('2026-10-14T10:00:00Z') }).execute();
  assert.equal((await db.selectFrom('offer_price_history').selectAll().execute()).length, 1);
});

test('verified-history migration can roll back and reapply without rewriting quotes or history', async t => {
  const migration = await import('../src/database/migrations/056_verified_price_history_20261124.js');
  t.after(async () => {
    const contract = await import('../src/database/migrations/058_settlement_data_contract_20261124.js');
    await contract.up(db as Kysely<unknown>);
  });
  await quote();
  await migration.down(db as Kysely<unknown>);
  const offer = await db.insertInto('offers').values({
    product_id: product, idempotency_key: 'legacy-estimate', price: '12.00', currency: 'CNY',
    captured_at: new Date('2026-10-14T10:00:00Z'), settlement_price: '12.00',
    settlement_quantity: 1, settlement_total_amount: '12.00',
    settlement_verified_at: new Date('2026-10-14T10:00:00Z'), settlement_payment_method: '支付价（预估：售价）', settlement_kind: 'estimated',
  }).returningAll().executeTakeFirstOrThrow();
  const previous = await db.selectFrom('offer_price_history').selectAll().orderBy('id').execute();
  assert.equal(previous.length, 2);
  await migration.up(db as Kysely<unknown>);
  assert.deepEqual(await db.selectFrom('offers').selectAll().where('id', '=', offer.id).executeTakeFirstOrThrow(), offer);
  assert.deepEqual(await db.selectFrom('offer_price_history').selectAll().orderBy('id').execute(), previous);
  await db.updateTable('offers').set({ settlement_verified_at: new Date('2026-10-14T11:00:00Z') }).where('id', '=', offer.id).execute();
  assert.deepEqual(await db.selectFrom('offer_price_history').selectAll().orderBy('id').execute(), previous);
});

test('migration labels identifiable legacy classic-store estimates without changing amounts or other adapters', async t => {
  const migration = await import('../src/database/migrations/056_verified_price_history_20261124.js');
  t.after(async () => {
    const contract = await import('../src/database/migrations/058_settlement_data_contract_20261124.js');
    await contract.up(db as Kysely<unknown>);
  });
  await migration.down(db as Kysely<unknown>);
  await db.updateTable('shops').set({ protocol: 'dujiaoka' }).where('id', '=', shop).execute();
  const offer = await db.insertInto('offers').values({
    product_id: product, idempotency_key: 'classic-estimate', price: '12.00', currency: 'CNY',
    captured_at: new Date('2026-10-14T10:00:00Z'), settlement_price: '12.00',
    settlement_quantity: 1, settlement_total_amount: '12.00',
    settlement_verified_at: new Date('2026-10-14T10:00:00Z'), settlement_payment_method: '支付宝（无手续费）',
  }).returningAll().executeTakeFirstOrThrow();
  const historical = await db.selectFrom('offer_price_history').selectAll().executeTakeFirstOrThrow();
  const otherShop = await db.insertInto('shops').values({
    name: 'Other adapter', protocol: 'acg-faka', platform: 'test', url: 'https://other.invalid',
  }).returning('id').executeTakeFirstOrThrow();
  const other = await addProduct('same channel label');
  await db.updateTable('products').set({ shop_id: otherShop.id }).where('id', '=', other).execute();
  await db.insertInto('offers').values({
    product_id: other, idempotency_key: 'actual-channel', price: '13.00', currency: 'CNY',
    captured_at: offer.captured_at, settlement_price: '13.00',
    settlement_quantity: 1, settlement_total_amount: '13.00',
    settlement_verified_at: offer.settlement_verified_at, settlement_payment_method: '支付宝（无手续费）',
  }).execute();
  assert.deepEqual((await points()).map(point => point.price), ['12.00']);
  await migration.up(db as Kysely<unknown>);
  assert.deepEqual(await db.selectFrom('offers').selectAll().where('id', '=', offer.id).executeTakeFirstOrThrow(),
    { ...offer, settlement_payment_method: '支付宝（无手续费，预估）' });
  assert.deepEqual(await db.selectFrom('offer_price_history').selectAll().where('id', '=', historical.id).executeTakeFirstOrThrow(),
    { ...historical, payment_method: '支付宝（无手续费，预估）' });
  assert.equal((await db.selectFrom('offer_price_history').selectAll().execute()).length, 2);
  await migration.down(db as Kysely<unknown>);
  assert.deepEqual(await db.selectFrom('offers').selectAll().where('id', '=', offer.id).executeTakeFirstOrThrow(), offer);
  assert.deepEqual(await db.selectFrom('offer_price_history').selectAll().where('id', '=', historical.id).executeTakeFirstOrThrow(), historical);
  // Host-based legacy configuration uses the same classification when no explicit protocol is stored.
  await db.updateTable('shops').set({ protocol: null, url: 'https://ouvg.top/' }).where('id', '=', shop).execute();
  await migration.up(db as Kysely<unknown>);
  assert.equal((await db.selectFrom('offers').select('settlement_payment_method')
    .where('id', '=', offer.id).executeTakeFirstOrThrow()).settlement_payment_method, '支付宝（无手续费，预估）');
});

import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { Kysely, Migrator, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';
import { createPostgresPool } from '../src/database/database.providers.js';
import type { DatabaseSchema } from '../src/database/types.js';
import { PriceHistoryRepository } from '../src/catalog/price-history.repository.js';
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

before(async () => {
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.ok(connectionString, 'TEST_DATABASE_URL is required');
  admin = new Pool({ connectionString });
  await admin.query(`create schema ${schema}`);
  db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: createPostgresPool({
    ...process.env, DATABASE_URL: connectionString, PG_SCHEMA: schema,
  }) }) });
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
async function quote(id = product, price = '10.30', at = '2026-10-13T12:00:00Z', currency = 'CNY') {
  return db.insertInto('offers').values({ product_id: id, idempotency_key: `history:${id}`, price: '12.00', currency,
    captured_at: new Date(at), settlement_price: price, settlement_verified_at: new Date(at), settlement_payment_method: 'Alipay',
  }).returning('id').executeTakeFirstOrThrow();
}
async function points(productId?: string, currency = 'CNY') { return (await history.get(String(standard), productId, currency)).points; }

test('records inserts and re-verifications atomically without treating cached refreshes as new history', async () => {
  const offer = await quote();
  await db.updateTable('offers').set({ captured_at: new Date('2026-10-14T10:00:00Z') }).where('id', '=', offer.id).execute();
  assert.equal((await db.selectFrom('offer_price_history').selectAll().execute()).length, 1);
  await db.updateTable('offers').set({ settlement_price: '9.50', settlement_verified_at: new Date('2026-10-14T10:00:00Z') }).where('id', '=', offer.id).execute();
  assert.deepEqual((await points()).map(p => [p.date, p.price, p.quantity]), [['2026-10-13', '10.30', 1], ['2026-10-14', '9.50', 1]]);
  await assert.rejects(db.transaction().execute(async tx => {
    await tx.updateTable('offers').set({ settlement_price: '1.00', settlement_verified_at: new Date('2026-10-14T11:00:00Z') }).where('id', '=', offer.id).execute();
    throw new Error('rollback history');
  }), /rollback history/);
  assert.equal((await db.selectFrom('offer_price_history').selectAll().execute()).length, 2);
});

test('returns observed daily minima in Shanghai time and keeps quantities, versions and currencies separate', async () => {
  const offer = await quote(product, '10.30', '2026-10-12T15:59:59Z');
  await db.updateTable('offers').set({ settlement_price: '9.00', settlement_verified_at: new Date('2026-10-12T16:00:00Z') }).where('id', '=', offer.id).execute();
  const second = await addProduct('5件会员');
  await quote(second, '2.002', '2026-10-13T12:00:00Z');
  await db.updateTable('offers').set({ settlement_quantity: 5, settlement_total_amount: '10.01', settlement_verified_at: new Date('2026-10-13T12:01:00Z') }).where('product_id', '=', second).execute();
  const dollars = await addProduct('美元会员');
  await quote(dollars, '0.50', '2026-10-14T10:00:00Z', 'USD');
  await db.updateTable('products').set({ content_version: 2n, name: '新版会员' }).where('id', '=', product).execute();
  await db.updateTable('offers').set({ settlement_price: '8.00', settlement_verified_at: new Date('2026-10-14T10:00:00Z') }).where('id', '=', offer.id).execute();
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

test('excludes invalid, missing, future and outside-window settlements but preserves zero', async () => {
  const offer = await quote(product, '0', '2026-10-14T09:00:00Z');
  assert.equal((await points())[0]!.price, '0');
  await db.updateTable('offers').set({ settlement_price: null, settlement_verified_at: null, settlement_payment_method: null }).where('id', '=', offer.id).execute();
  assert.equal((await points()).length, 1);
  await quote(await addProduct('旧报价'), '1.00', '2026-09-14T15:59:59Z');
  await quote(await addProduct('未来报价'), '1.00', '2026-10-15T12:00:00Z');
  await quote(await addProduct('边界报价'), '3.00', '2026-09-14T16:00:00Z');
  assert.deepEqual((await points()).map(p => p.date), ['2026-09-15', '2026-10-14']);
  const invalidId = await addProduct('异常标价');
  const invalid = await quote(invalidId, '4.00', '2026-10-13T12:00:00Z');
  await db.updateTable('offers').set({ price: 'NaN', settlement_price: '1.00', settlement_verified_at: new Date('2026-10-14T10:00:00Z') }).where('id', '=', invalid.id).execute();
  assert.equal((await db.selectFrom('offer_price_history').selectAll().where('product_id', '=', invalidId).execute()).length, 1);
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

test('migration seeds genuine existing quotes and downgrades without modifying offers', async () => {
  const migration = await import('../src/database/migrations/011_price_history_20261014.js');
  await migration.down(db as Kysely<unknown>);
  await quote();
  await db.insertInto('offers').values({ idempotency_key: 'new-unverified', product_id: product, price: '12', captured_at: new Date('2026-10-14T09:00:00Z') }).execute();
  await migration.up(db as Kysely<unknown>);
  assert.equal((await points()).length, 0);
  await db.deleteFrom('offers').where('idempotency_key', '=', 'new-unverified').execute();
  await db.updateTable('products').set({ name: '新版会员', content_version: 2n, content_changed_at: new Date('2026-10-14T09:00:00Z') }).where('id', '=', product).execute();
  await migration.down(db as Kysely<unknown>);
  await migration.up(db as Kysely<unknown>);
  assert.equal((await points()).length, 0, 'older verification cannot be seeded as a newer product version');
  await db.updateTable('products').set({ name: '月付会员', content_version: 0n, content_changed_at: new Date('2026-09-01T00:00:00Z') }).where('id', '=', product).execute();
  await migration.down(db as Kysely<unknown>);
  await migration.up(db as Kysely<unknown>);
  assert.equal((await points())[0]!.verifiedAt, '2026-10-13T12:00:00.000Z');
  await db.updateTable('offers').set({ captured_at: new Date('2026-10-14T10:00:00Z') }).execute();
  assert.equal((await db.selectFrom('offer_price_history').selectAll().execute()).length, 1);
});

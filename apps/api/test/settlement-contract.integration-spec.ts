import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';
import type { DatabaseSchema } from '../src/database/types.js';
import { PriceHistoryRepository } from '../src/catalog/price-history.repository.js';

async function fixture(t: TestContext, target: string) {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required');
  const schema = `settlement_contract_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  const db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({
    pool: new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public` }),
  }) });
  t.after(async () => {
    await db.destroy();
    await admin.query(`drop schema "${schema}" cascade`);
    await admin.end();
  });
  const migrator = new Migrator({ db, provider: migrationProvider, migrationTableSchema: schema });
  assert.ifError((await migrator.migrateTo(target)).error);
  const shop = (await sql<{ id: string }>`insert into shops (name, platform, protocol, url)
    values ('Settlement fixture', 'test', 'dujiaoka', 'https://fixture.invalid') returning id::text`.execute(db)).rows[0]!.id;
  const standard = (await sql<{ id: string }>`insert into standard_products (name, verification_state)
    values ('Widget', 'verified') returning id::text`.execute(db)).rows[0]!.id;
  const at = new Date(Date.now() - 60_000);
  async function offer(name: string, method: string) {
    const product = (await sql<{ id: string }>`insert into products (shop_id, external_id, name, normalized_key, url)
      values (${shop}::bigint, ${name}, ${name}, ${name}, 'https://fixture.invalid/item')
      returning id::text`.execute(db)).rows[0]!.id;
    await sql`insert into standard_product_members (standard_product_id, product_id, publication_state)
      values (${standard}::bigint, ${product}::bigint, 'published')`.execute(db);
    await sql`insert into offers (idempotency_key, product_id, price, stock_quantity,
      settlement_price, settlement_payment_method, settlement_verified_at, settlement_quantity, settlement_total_amount)
      values (${name}, ${product}::bigint, 10, 5, 10.4, ${method}, ${at}, 1, 10.4)`.execute(db);
    return product;
  }
  return { db, migrator, offer, shop, standard, at };
}

test('upgrade converts quotes, projections, history and reports without changing monetary evidence', async t => {
  const { db, migrator, offer, shop } = await fixture(t, '055_membership_decision_metadata_20261124');
  const actual = await offer('actual', 'Card');
  await offer('estimate', '支付价（预估：售价）');
  await offer('classic', '支付宝（无手续费）');
  const before = (await sql`select product_id, price, settlement_price, settlement_verified_at from offers order by product_id`.execute(db)).rows;
  const currentReport = { verified: 3, estimated: 2, failed: 1, skipped: 0, retryable: 1,
    terminalEstimated: 1, terminalReasons: {}, reasons: { request_failed: 1 } };
  const otherShop = (await sql<{ id: string }>`insert into shops (name, platform, protocol, url)
    values ('Native platform', 'test', 'liandong', 'https://native.invalid') returning id::text`.execute(db)).rows[0]!.id;
  await sql`insert into fetch_runs (shop_id, started_at, status, task_type, settlement_report) values
    (${otherShop}::bigint, now(), 'succeeded', 'list', '{"verified":25,"failed":0,"skipped":0,"retryable":0,"reasons":{"estimated":20}}'),
    (${otherShop}::bigint, now(), 'queued', 'settlement', '{"verified":25,"failed":0,"skipped":0,"retryable":0,"reasons":{"estimated":20}}'),
    (${shop}::bigint, now(), 'queued', 'settlement', ${JSON.stringify(currentReport)}::jsonb),
    (${shop}::bigint, now(), 'succeeded', 'list', '{"verified":1,"failed":0,"skipped":0,"retryable":0,"reasons":{}}'),
    (${shop}::bigint, now(), 'queued', 'settlement', '{"verified":1,"failed":0,"skipped":0,"retryable":0,"reasons":{}}')`.execute(db);
  assert.ifError((await migrator.migrateToLatest()).error);
  assert.deepEqual((await sql`select product_id, price, settlement_price, settlement_verified_at from offers order by product_id`.execute(db)).rows, before);
  for (const table of ['offers', 'catalog_read_offers', 'catalog_read_offer_prices', 'offer_price_history']) {
    const kinds = (await sql<{ settlement_kind: string }>`select settlement_kind from ${sql.id(table)} order by product_id`.execute(db)).rows;
    assert.deepEqual(kinds.map(row => row.settlement_kind), ['verified', 'estimated', 'estimated'], table);
  }
  const reports = (await sql<{ settlement_report: typeof currentReport }>`select settlement_report from fetch_runs order by id`.execute(db)).rows;
  assert.equal(reports[0]!.settlement_report.verified, 5);
  assert.equal(reports[0]!.settlement_report.estimated, 20);
  assert.equal(reports[1]!.settlement_report.terminalEstimated, 20);
  assert.deepEqual(reports[2]!.settlement_report, currentReport);
  assert.equal(reports[3]!.settlement_report.verified, 0);
  assert.equal(reports[3]!.settlement_report.estimated, 1);
  assert.equal(reports[4]!.settlement_report.terminalEstimated, 1);
  // Updating only the new field must invalidate both projections; stock-only writes must still work.
  await sql`update offers set settlement_kind = 'estimated' where product_id = ${actual}::bigint`.execute(db);
  await sql`update offers set stock_quantity = 3 where product_id = ${actual}::bigint`.execute(db);
  for (const table of ['catalog_read_offers', 'catalog_read_offer_prices']) {
    const row = (await sql<{ settlement_kind: string; stock_quantity: string }>`select settlement_kind, stock_quantity::text
      from ${sql.id(table)} where product_id = ${actual}::bigint`.execute(db)).rows[0]!;
    assert.deepEqual(row, { settlement_kind: 'estimated', stock_quantity: '3' });
  }
});

test('settlement migrations roll back and reapply without dropping projection dependents', async t => {
  const { db, migrator, offer } = await fixture(t, '056_verified_price_history_20261124');
  await offer('roundtrip', 'Card');
  const snapshot = async () => (await sql`select p.proname, p.prosrc from pg_proc p
    where p.oid in ('refresh_catalog_read_offers(bigint[])'::regprocedure,
      'catalog_read_offers_offers_changed()'::regprocedure) order by p.proname`.execute(db)).rows;
  const original = await snapshot();
  await sql`create view settlement_projection_consumer as select product_id from catalog_read_offers`.execute(db);
  assert.ifError((await migrator.migrateToLatest()).error);
  assert.ifError((await migrator.migrateTo('056_verified_price_history_20261124')).error);
  assert.deepEqual(await snapshot(), original);
  assert.ifError((await migrator.migrateToLatest()).error);
  assert.equal((await sql`select * from settlement_projection_consumer`.execute(db)).rows.length, 1);
});

for (const hasHistoryKind of [false, true]) test(`058 normalizes an already migrated database (history kind: ${hasHistoryKind})`, async t => {
  const { db, migrator, offer, standard, at } = await fixture(t, '057_settlement_kind_20261124');
  const actual = await offer('label-is-not-status', 'Card');
  await sql`update offers set settlement_payment_method = '预估字样已核实' where product_id = ${actual}::bigint`.execute(db);
  await sql`update offer_price_history set payment_method = '预估字样已核实'`.execute(db);
  const trigger = (await sql<{ definition: string }>`select pg_get_functiondef(
    'catalog_read_offers_offers_changed()'::regprocedure) as definition`.execute(db)).rows[0]!.definition;
  await sql.raw(trigger.replaceAll('stock_available, stock_quantity, settlement_price',
    'stock_available, settlement_price').replaceAll('settlement_payment_method, settlement_kind, settlement_quantity',
      'settlement_payment_method, settlement_quantity, settlement_kind')).execute(db);
  await sql`update offers set stock_quantity = 4 where product_id = ${actual}::bigint`.execute(db);
  if (!hasHistoryKind) await sql`alter table offer_price_history drop column settlement_kind`.execute(db);
  else {
    await sql`insert into offer_price_history (product_id, standard_product_id, content_version,
      name, spec, price, currency, quantity, payment_method, settlement_kind, verified_at)
      select product_id, standard_product_id, content_version, name, spec, 1, currency, quantity,
        'Card', 'estimated', verified_at - interval '1 second' from offer_price_history`.execute(db);
  }
  assert.ifError((await migrator.migrateToLatest()).error);
  const historyBeforeRollback = (await sql`select * from offer_price_history order by id`.execute(db)).rows;
  assert.ifError((await migrator.migrateTo('057_settlement_kind_20261124')).error);
  assert.deepEqual((await sql`select * from offer_price_history order by id`.execute(db)).rows, historyBeforeRollback);
  assert.ifError((await migrator.migrateToLatest()).error);
  assert.deepEqual((await sql`select * from offer_price_history order by id`.execute(db)).rows, historyBeforeRollback);
  for (const stock of [4, 2]) {
    await sql`update offers set stock_quantity = ${stock} where product_id = ${actual}::bigint`.execute(db);
    assert.equal((await sql<{ stock: number }>`select stock_quantity::int as stock from catalog_read_offer_prices
      where product_id = ${actual}::bigint`.execute(db)).rows[0]!.stock, stock);
  }
  const history = new PriceHistoryRepository(db);
  assert.equal((await history.get(standard)).points[0]!.productId, actual);
  assert.equal((await history.get(standard)).points[0]!.price, '10.4');
  const estimate = await offer('plain-label-estimate', 'Card');
  await sql`delete from offer_price_history where product_id = ${estimate}::bigint`.execute(db);
  await sql`update offers set settlement_kind = 'estimated', settlement_verified_at = ${new Date(at.getTime() + 1000)}
    where product_id = ${estimate}::bigint`.execute(db);
  assert.equal((await db.selectFrom('offer_price_history').selectAll().execute()).length, hasHistoryKind ? 2 : 1);
  await sql`update offers set settlement_verified_at = ${new Date(at.getTime() + 1000)}
    where product_id = ${actual}::bigint`.execute(db);
  assert.equal((await db.selectFrom('offer_price_history').selectAll().execute()).length, hasHistoryKind ? 3 : 2);
  assert.equal((await history.get(standard)).points[0]!.paymentMethod, '预估字样已核实');
  assert.ifError((await migrator.migrateTo('056_verified_price_history_20261124')).error);
});

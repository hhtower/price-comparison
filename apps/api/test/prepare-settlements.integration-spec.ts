import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';
import { prepareSettlements } from '../scripts/prepare-settlements.js';
import type { DatabaseSchema } from '../src/database/types.js';

test('offline preparation is atomic, preserves evidence and enables the strict contract', async t => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required');
  const schema = `prepare_settlements_${randomUUID().replaceAll('-', '')}`;
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
  assert.ifError((await migrator.migrateTo('058_settlement_data_contract_20261124')).error);
  const shop = (await sql<{ id: string }>`insert into shops (name, platform, url)
    values ('Offline fixture', 'test', 'https://fixture.invalid') returning id::text`.execute(db)).rows[0]!.id;
  const standard = (await sql<{ id: string }>`insert into standard_products (name, verification_state)
    values ('Widget', 'verified') returning id::text`.execute(db)).rows[0]!.id;
  async function add(name: string, amount: string) {
    const product = (await sql<{ id: string }>`insert into products (shop_id, external_id, name, normalized_key, url)
      values (${shop}::bigint, ${name}, ${name}, ${name}, 'https://fixture.invalid/item') returning id::text`.execute(db)).rows[0]!.id;
    await sql`insert into standard_product_members (standard_product_id, product_id, publication_state)
      values (${standard}::bigint, ${product}::bigint, 'published')`.execute(db);
    return (await sql<{ id: string }>`insert into offers (product_id, idempotency_key, price,
      settlement_price, settlement_verified_at, settlement_payment_method, settlement_kind)
      values (${product}::bigint, ${name}, 20, ${amount}::numeric,
        '2026-11-24T00:00:00.123456Z', 'Card', 'verified') returning id::text`.execute(db)).rows[0]!.id;
  }
  const single = await add('single', '10.30');
  const zero = await add('zero', '0');
  const bulk = await add('bulk', '3.336666666667');
  await sql`update offer_price_history h set quantity = 3
    from offers o where o.id = ${bulk}::bigint and h.product_id = o.product_id`.execute(db);
  await sql`update offer_price_history h set quantity = 2
    from offers o where o.id = ${zero}::bigint and h.product_id = o.product_id`.execute(db);
  const noHistory = await add('unknown-quantity', '10.30');
  await sql`delete from offer_price_history h using offers o
    where o.id = ${noHistory}::bigint and h.product_id = o.product_id`.execute(db);
  const ambiguous = await add('ambiguous', '3.333333333332');
  const complete = await add('complete', '10');
  await sql`update offers set settlement_quantity = 2, settlement_total_amount = 20 where id = ${complete}::bigint`.execute(db);
  const snapshot = async () => (await sql<{ document: string }>`select row_to_json(o)::text as document from offers o order by id`.execute(db)).rows;
  const before = await snapshot();
  const failed = await migrator.migrateToLatest();
  assert.match(String(failed.error), /db:prepare-settlements/);
  assert.deepEqual(await snapshot(), before, 'the application migration must reject, not repair, historical data');
  await assert.rejects(prepareSettlements(db, { schema: `${schema}_missing`, apply: true }), /Target schema does not exist/);
  const partial = `${schema}_partial`;
  await admin.query(`create schema "${partial}"`);
  try {
    await assert.rejects(prepareSettlements(db, { schema: partial, apply: true }), { code: '42P01' });
  } finally { await admin.query(`drop schema "${partial}"`); }
  assert.deepEqual(await snapshot(), before, 'invalid targets cannot fall back to the connection search path');
  const preview = await prepareSettlements(db, { schema });
  assert.deepEqual(preview, { applied: false, repaired: [zero, bulk], invalidated: [single, noHistory, ambiguous], historyDowngraded: 2 });
  assert.deepEqual(await snapshot(), before, 'dry-run must not write');
  await assert.rejects(prepareSettlements(db, { schema, apply: true, beforeApply: () => { throw new Error('backup failed'); } }), /backup failed/);
  assert.deepEqual(await snapshot(), before, 'failed backup must prevent writes');
  let backup: unknown;
  const result = await prepareSettlements(db, { schema, apply: true, beforeApply: data => { backup = data; } });
  assert.deepEqual(result, { ...preview, applied: true });
  assert.match(JSON.stringify(backup), /\.123456/);
  const repaired = (await sql<{ id: string; quantity: number; total: string; price: string; at: string }>`
    select id::text, settlement_quantity as quantity, settlement_total_amount::text as total, settlement_price::text as price,
      to_char(settlement_verified_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') as at
    from offers where id = any(${[zero, bulk]}::bigint[]) order by id`.execute(db)).rows;
  assert.deepEqual(repaired.map(row => [row.quantity, row.total, row.price]), [
    [2, '0.00', '0'], [3, '10.01', '3.336666666667'],
  ]);
  assert.ok(repaired.every(row => row.at === '2026-11-24 00:00:00.123456'));
  const unchanged = before.find(row => row.document.includes('"id":' + complete + ','));
  assert.ok(unchanged);
  assert.deepEqual((await snapshot()).find(row => row.document.includes('"id":' + complete + ',')), unchanged);
  const invalid = (await sql<{ price: string; kind: string; settlement_price: string | null; scheduled: boolean }>`
    select price::text, settlement_kind as kind, settlement_price, settlement_refresh_at is not null as scheduled
    from offers where id = ${ambiguous}::bigint`.execute(db)).rows[0]!;
  assert.deepEqual(invalid, { price: '20.00', kind: 'estimated', settlement_price: null, scheduled: true });
  assert.equal((await sql<{ kind: string }>`select h.settlement_kind as kind from offer_price_history h
    join offers o on o.product_id = h.product_id where o.id = ${ambiguous}::bigint`.execute(db)).rows[0]!.kind, 'estimated');
  assert.deepEqual(await prepareSettlements(db, { schema, apply: true }), {
    applied: false, repaired: [], invalidated: [], historyDowngraded: 0,
  });
  assert.ifError((await migrator.migrateToLatest()).error);
  await assert.rejects(sql`update offers set settlement_quantity = null, settlement_total_amount = null
    where id = ${complete}::bigint`.execute(db), { code: '23514' });
  const definitions = (await sql<{ definition: string }>`select pg_get_functiondef(oid) as definition from pg_proc
    where oid in ('refresh_catalog_read_offers(bigint[])'::regprocedure, 'record_offer_price_history()'::regprocedure)`.execute(db)).rows;
  assert.ok(definitions.every(row => !row.definition.includes('to_jsonb(latest)') && !row.definition.includes('coalesce(new.settlement_quantity')));
  await sql`update offers set stock_quantity = 7, settlement_price = 10.50, settlement_quantity = 1, settlement_total_amount = 10.50,
    settlement_verified_at = now() - interval '1 second' where id = ${complete}::bigint`.execute(db);
  assert.equal((await sql<{ quantity: number }>`select h.quantity from offer_price_history h join offers o
    on o.product_id = h.product_id and o.settlement_verified_at = h.verified_at where o.id = ${complete}::bigint`.execute(db)).rows[0]!.quantity, 1);
  assert.equal((await sql<{ stock: number }>`select r.stock_quantity::int as stock from catalog_read_offer_prices r
    join offers o on o.product_id = r.product_id where o.id = ${complete}::bigint`.execute(db)).rows[0]!.stock, 7);
});

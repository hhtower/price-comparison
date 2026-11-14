import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrateToLatest, migrationProvider } from '../scripts/migrate.js';
import type { DatabaseSchema } from '../src/database/types.js';
import { publishNextCatalogChange } from '../src/catalog/catalog-projection.js';
import { CatalogRepository } from '../src/catalog/catalog.repository.js';

async function databaseFixture(t: TestContext) {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required');
  const schema = `bootstrap_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  const previousSchema = process.env.PG_SCHEMA;
  process.env.PG_SCHEMA = schema;
  const database = new Kysely<DatabaseSchema>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public` }),
    }),
  });
  t.after(async () => {
    await database.destroy();
    await admin.query(`drop schema "${schema}" cascade`);
    await admin.end();
    if (previousSchema === undefined) delete process.env.PG_SCHEMA;
    else process.env.PG_SCHEMA = previousSchema;
  });
  return { database, schema };
}

test('empty database migrates completely, preserves NOT NULL and can migrate again without losing data', async t => {
  const { database, schema } = await databaseFixture(t);
  await migrateToLatest(database);
  const columns = await sql<{ table_name: string; column_name: string; is_nullable: string }>`
    select table_name, column_name, is_nullable from information_schema.columns
    where table_schema = ${schema} and table_name in ('admin', 'shops', 'products', 'offers')
  `.execute(database);
  for (const name of ['admin.password_hash', 'shops.name', 'products.shop_id', 'products.name', 'offers.product_id', 'offers.price']) {
    assert.equal(columns.rows.find(column => `${column.table_name}.${column.column_name}` === name)?.is_nullable, 'NO', name);
  }
  await assert.rejects(sql`insert into admin (id, password_hash) values (1, null)`.execute(database), { code: '23502' });
  const shop = await database.insertInto('shops').values({
    name: 'Bootstrap preservation', platform: 'test', url: 'https://bootstrap.example',
  }).returning(['id', 'name']).executeTakeFirstOrThrow();
  const before = await sql<{ name: string; timestamp: string }>`select name, timestamp from kysely_migration order by name`.execute(database);
  assert.deepEqual(before.rows.map(row => row.name), Object.keys(await migrationProvider.getMigrations()).sort());
  await migrateToLatest(database);
  assert.deepEqual((await sql`select name, timestamp from kysely_migration order by name`.execute(database)).rows, before.rows);
  assert.deepEqual(await database.selectFrom('shops').select(['id', 'name']).where('id', '=', shop.id).executeTakeFirstOrThrow(), shop);
});

test('an existing initial schema upgrades through later migrations while preserving shop data', async t => {
  const { database, schema } = await databaseFixture(t);
  const migrator = new Migrator({ db: database, provider: migrationProvider, migrationTableSchema: schema });
  const initial = await migrator.migrateTo('001_initial');
  assert.ifError(initial.error);
  const shop = await sql<{ id: bigint; name: string }>`
    insert into shops (name, platform, url) values ('Existing installation', 'test', 'https://upgrade.example')
    returning id, name
  `.execute(database);
  await migrateToLatest(database);
  assert.deepEqual((await sql`select id, name from shops where id = ${shop.rows[0]!.id}`.execute(database)).rows, shop.rows);
  const records = await sql<{ name: string }>`select name from kysely_migration order by name`.execute(database);
  assert.deepEqual(records.rows.map(row => row.name), Object.keys(await migrationProvider.getMigrations()).sort());
});

test('review-key migration backfills existing reviews and rolls back without changing their evidence', async t => {
  const { database, schema } = await databaseFixture(t);
  const migrator = new Migrator({ db: database, provider: migrationProvider, migrationTableSchema: schema });
  assert.ifError((await migrator.migrateTo('024_crawler_monitor_indexes_20261027')).error);
  const shop = await sql<{ id: bigint }>`insert into shops (name, platform, url)
    values ('Review migration', 'test', 'https://review-migration.invalid') returning id`.execute(database);
  const product = await sql<{ id: bigint; source_data: unknown; text_review: unknown }>`
    insert into products (shop_id, external_id, name, normalized_key, url, source_data, text_review)
    values (${shop.rows[0]!.id}, 'review', 'Review product', 'review', '',
      '{"ratingText":{"name":"Complete source","description":"Do not truncate"}}'::jsonb,
      '{"contentVersion":"0","fingerprint":"","review":{"evidence":"Original review"}}'::jsonb)
    returning id, source_data, text_review`.execute(database);
  const original = product.rows[0]!;
  const read = () => sql<{ id: bigint; source_data: unknown; text_review: unknown; text_review_key: string }>`
    select id, source_data, text_review, text_review_key from products where id = ${original.id}`.execute(database);
  assert.ifError((await migrator.migrateTo('025_shop_text_review_keys_20261030')).error);
  const upgraded = (await read()).rows[0]!;
  assert.match(upgraded.text_review_key, /^[a-f0-9]{64}$/u);
  assert.deepEqual({ id: upgraded.id, source_data: upgraded.source_data, text_review: upgraded.text_review }, original);
  assert.ifError((await migrator.migrateTo('024_crawler_monitor_indexes_20261027')).error);
  assert.deepEqual((await sql`select id, source_data, text_review from products where id = ${original.id}`
    .execute(database)).rows[0], original);
  assert.ifError((await migrator.migrateTo('025_shop_text_review_keys_20261030')).error);
  assert.deepEqual((await read()).rows[0], upgraded);
});


test('rating revision changes only for scoring inputs and survives rollback and reinstallation', async t => {
  const { database, schema } = await databaseFixture(t);
  const migrator = new Migrator({ db: database, provider: migrationProvider, migrationTableSchema: schema });
  const names = Object.keys(await migrationProvider.getMigrations()).sort();
  const previous = names[names.indexOf('028_catalog_rating_versions_20261101') - 1]!;
  assert.ifError((await migrator.migrateTo(previous)).error);
  const shop = await database.insertInto('shops').values({ name: 'Revision', platform: 'test', url: 'https://revision.invalid' })
    .returning('id').executeTakeFirstOrThrow();
  assert.ifError((await migrator.migrateTo('028_catalog_rating_versions_20261101')).error);
  const revision = async () => (await sql<{ revision: string }>`select rating_revision::text as revision from shops where id = ${shop.id}`.execute(database)).rows[0]!.revision;
  assert.equal(await revision(), '0');
  await database.updateTable('shops').set({ name: 'Renamed' }).where('id', '=', shop.id).execute();
  assert.equal(await revision(), '0');
  await database.updateTable('shops').set({ url: 'https://changed.invalid' }).where('id', '=', shop.id).execute();
  assert.equal(await revision(), '1');
  await database.updateTable('shops').set({ url: 'https://changed.invalid' }).where('id', '=', shop.id).execute();
  assert.equal(await revision(), '1');
  assert.ifError((await migrator.migrateTo(previous)).error);
  assert.equal((await database.selectFrom('shops').select('url').where('id', '=', shop.id).executeTakeFirstOrThrow()).url, 'https://changed.invalid');
  assert.ifError((await migrator.migrateTo('028_catalog_rating_versions_20261101')).error);
  assert.equal(await revision(), '0');
});

test('published results backfill asynchronously and survive migration rollback without changing source data', async t => {
  const { database, schema } = await databaseFixture(t);
  const migrator = new Migrator({ db: database, provider: migrationProvider, migrationTableSchema: schema });
  assert.ifError((await migrator.migrateTo('028_catalog_rating_versions_20261101')).error);
  const shop = await database.insertInto('shops').values({ name: 'Published', platform: 'test', url: 'https://published.invalid' })
    .returning('id').executeTakeFirstOrThrow();
  assert.ifError((await migrator.migrateTo('029_catalog_published_results_20261101')).error);
  assert.equal((await sql`select * from catalog_shop_ratings`.execute(database)).rows.length, 0);
  assert.equal(await publishNextCatalogChange(database), true);
  assert.equal((await sql`select * from catalog_shop_ratings`.execute(database)).rows.length, 0);
  while (await publishNextCatalogChange(database)) {}
  assert.equal((await sql`select * from catalog_shop_ratings`.execute(database)).rows.length, 1);
  assert.equal(await publishNextCatalogChange(database), false);
  await sql`insert into catalog_read_shop_totals values (99, ${shop.id}, 'CNY', 10, now(), 1, 99)`.execute(database);
  await sql`truncate catalog_read_offer_prices`.execute(database);
  while (await publishNextCatalogChange(database)) {}
  assert.equal((await sql`select * from catalog_read_shop_totals`.execute(database)).rows.length, 0);
  assert.ifError((await migrator.migrateTo('028_catalog_rating_versions_20261101')).error);
  assert.equal((await database.selectFrom('shops').select('name').where('id', '=', shop.id).executeTakeFirstOrThrow()).name, 'Published');
  assert.ifError((await migrator.migrateTo('029_catalog_published_results_20261101')).error);
  assert.equal(await publishNextCatalogChange(database), true);
});

test('boolean text review upgrade invalidates cached scores while retaining historical reviews', async t => {
  const { database, schema } = await databaseFixture(t);
  const migrator = new Migrator({ db: database, provider: migrationProvider, migrationTableSchema: schema });
  assert.ifError((await migrator.migrateTo('040_tag_structural_validation_20261114')).error);
  const shop = await database.insertInto('shops').values({
    name: 'Text review upgrade', platform: 'test', url: 'https://text-upgrade.invalid',
  }).returning('id').executeTakeFirstOrThrow();
  const product = (await sql<{ id: bigint; text_review: unknown }>`
    insert into products (shop_id, external_id, name, normalized_key, url, text_review)
    values (${shop.id}, 'old-text', 'Old text', 'old-text', '',
      '{"version":"shop-title-body-20261027-v1","review":{"answers":{"L1":{"value":null,"reason":"unknown","evidence":[]}}}}'::jsonb)
    returning id, text_review`.execute(database)).rows[0]!;
  await sql`delete from catalog_projection_changes`.execute(database);
  await sql`insert into catalog_shop_ratings (shop_id, score, details, computed_at)
    values (${shop.id}, '20.00', '{"text":{"reviewed":1}}'::jsonb, now())`.execute(database);
  const version = (await sql<{ version: string }>`select version::text from catalog_cache_versions where id = 1`.execute(database)).rows[0]!.version;
  await migrateToLatest(database);
  assert.equal((await sql`select shop_id from catalog_shop_ratings where shop_id = ${shop.id}`.execute(database)).rows.length, 0);
  assert.equal((await sql`select id from catalog_projection_changes where shop_id = ${shop.id}`.execute(database)).rows.length, 1);
  assert.deepEqual((await sql`select id, text_review from products where id = ${product.id}`.execute(database)).rows[0], product);
  assert.notEqual((await sql<{ version: string }>`select version::text from catalog_cache_versions where id = 1`.execute(database)).rows[0]!.version, version);
  while (await publishNextCatalogChange(database)) {}
  assert.equal((await sql<{ score: string | null }>`select score from catalog_shop_ratings where shop_id = ${shop.id}`.execute(database)).rows[0]!.score, null);
});

for (const legacyStockProjection of [false, true]) {
  test(`catalog summary trigger repair restores missing Team results from ${legacyStockProjection ? '035 without stock quantities' : '041 without summary triggers'}`, async t => {
    const { database, schema } = await databaseFixture(t);
    const migrator = new Migrator({ db: database, provider: migrationProvider, migrationTableSchema: schema });
    assert.ifError((await migrator.migrateTo(legacyStockProjection
      ? '035_attribute_jobs_after_standardization_20261112' : '041_boolean_text_review_20261114')).error);
    const shop = await database.insertInto('shops').values({
      name: 'Summary repair', platform: 'test', url: 'https://summary-repair.invalid',
    }).returning('id').executeTakeFirstOrThrow();
    const [team, plus, retired, soldOut] = await database.insertInto('standard_products').values([
      { name: 'ChatGPT Team', platform: 'openai', canonical_family: 'openai',
        canonical_product: 'chatgpt', canonical_tier: 'team', verification_state: 'verified' },
      { name: 'Plus', platform: 'test', verification_state: 'verified' },
      { name: 'Retired standard', platform: 'test', verification_state: 'verified' },
      { name: 'Sold out standard', platform: 'test', verification_state: 'verified' },
    ]).returning('id').execute();
    assert.ok(team && plus && retired && soldOut);
    const [winner, fallback, retiredWinner, soldOutWinner] = await database.insertInto('products').values(
      ['winner', 'fallback', 'retired', 'sold-out'].map(key => ({
        shop_id: shop.id, external_id: key, name: key, normalized_key: key, url: '',
      })),
    ).returning('id').execute();
    assert.ok(winner && fallback && retiredWinner && soldOutWinner);
    await database.insertInto('standard_product_members').values([
      { product_id: winner.id, standard_product_id: team.id, assignment_source: 'ai' },
      { product_id: fallback.id, standard_product_id: team.id, assignment_source: 'ai' },
      { product_id: retiredWinner.id, standard_product_id: retired.id, assignment_source: 'ai' },
      { product_id: soldOutWinner.id, standard_product_id: soldOut.id, assignment_source: 'ai' },
    ]).execute();
    await database.insertInto('offers').values([
      { product_id: winner.id, price: '5' }, { product_id: fallback.id, price: '10' },
      { product_id: retiredWinner.id, price: '20' }, { product_id: soldOutWinner.id, price: '30' },
    ].map(offer => ({ ...offer, idempotency_key: String(offer.product_id), currency: 'CNY',
      captured_at: new Date(), is_stale: false, stock_available: true }))).execute();
    const publish = async () => { while (await publishNextCatalogChange(database)) {} };
    const totals = async () => (await sql<{
      standard: string; winner: string; price: number; count: number;
    }>`select standard_product_id::text as standard, winner_id::text as winner,
      min_price::float8 as price, product_count as count
      from catalog_read_shop_totals order by standard_product_id`.execute(database)).rows;
    const queued = async () => (await sql<{ standard: string }>`
      select standard_product_id::text as standard from catalog_projection_changes
      where standard_product_id is not null order by standard_product_id`.execute(database)).rows.map(row => row.standard);
    const triggerNames = ['catalog_projection_truncated', 'catalog_summary_changes_delete',
      'catalog_summary_changes_insert', 'catalog_summary_changes_update'];
    const installed = async () => (await sql<{ tgname: string }>`
      select tgname from pg_trigger where tgrelid = 'catalog_read_offer_prices'::regclass
        and not tgisinternal and tgname in (${sql.join(triggerNames)}) and tgenabled = 'O'
      order by tgname`.execute(database)).rows.map(row => row.tgname);
    await publish();
    assert.equal((await totals()).find(row => row.standard === String(team.id))?.winner, String(winner.id));

    if (legacyStockProjection) {
      // Reproduce the deployed 035 shape so 036 must rebuild the projection tables.
      await sql`alter table catalog_read_offers drop column stock_quantity`.execute(database);
      await sql`alter table catalog_read_offer_prices drop column stock_quantity`.execute(database);
      assert.ifError((await migrator.migrateTo('041_boolean_text_review_20261114')).error);
    } else {
      for (const name of triggerNames) {
        await sql`drop trigger ${sql.id(name)} on catalog_read_offer_prices`.execute(database);
      }
    }
    assert.deepEqual(await installed(), []);
    await sql`delete from catalog_projection_changes`.execute(database);
    await database.updateTable('standard_product_members').set({ standard_product_id: plus.id })
      .where('product_id', 'in', [winner.id, retiredWinner.id]).execute();
    await database.updateTable('offers').set({ stock_available: false })
      .where('product_id', '=', soldOutWinner.id).execute();
    assert.equal((await sql`select id from catalog_projection_changes`.execute(database)).rows.length, 0);
    assert.equal(await publishNextCatalogChange(database), false);
    assert.equal((await totals()).find(row => row.standard === String(team.id))?.winner, String(winner.id));
    const repository = new CatalogRepository(database);
    assert.equal((await repository.search({ tags: [], limit: 20 })).items.some(item => item.id === String(team.id)), false);
    const version = (await sql<{ version: string }>`
      select version::text from catalog_cache_versions where id = 1`.execute(database)).rows[0]!.version;

    await migrateToLatest(database);
    assert.deepEqual(await installed(), triggerNames);
    // Retired exists only in the stale totals; Plus exists only in the current prices.
    assert.deepEqual(await queued(), [team, plus, retired, soldOut].map(row => String(row.id)));
    assert.ok(BigInt((await sql<{ version: string }>`
      select version::text from catalog_cache_versions where id = 1`.execute(database)).rows[0]!.version) > BigInt(version));
    const repair = (await migrationProvider.getMigrations())['042_restore_catalog_summary_triggers_20261114'];
    assert.ok(repair);
    await repair.up(database);
    assert.deepEqual(await installed(), triggerNames);
    assert.deepEqual(await queued(), [team, plus, retired, soldOut].map(row => String(row.id)));
    await publish();
    assert.deepEqual(await totals(), [
      { standard: String(team.id), winner: String(fallback.id), price: 10, count: 1 },
      { standard: String(plus.id), winner: String(winner.id), price: 5, count: 2 },
    ]);
    const restored = (await repository.search({ tags: [], limit: 20 })).items.find(item => item.id === String(team.id));
    assert.equal(restored?.offers[0]?.productId, String(fallback.id));

    assert.ifError((await migrator.migrateTo('041_boolean_text_review_20261114')).error);
    assert.deepEqual(await installed(), triggerNames, 'rollback must retain the protection originally installed by 029');
    await migrateToLatest(database);
    await publish();

    await database.updateTable('standard_product_members').set({ standard_product_id: team.id })
      .where('product_id', '=', winner.id).execute();
    assert.deepEqual(await queued(), [String(team.id), String(plus.id)], 'updates must refresh both old and new standards');
    await publish();
    assert.deepEqual(await totals(), [
      { standard: String(team.id), winner: String(winner.id), price: 5, count: 2 },
      { standard: String(plus.id), winner: String(retiredWinner.id), price: 20, count: 1 },
    ]);
    await database.updateTable('offers').set({ stock_available: false }).where('product_id', '=', winner.id).execute();
    assert.deepEqual(await queued(), [String(team.id)]);
    await publish();
    assert.equal((await totals()).find(row => row.standard === String(team.id))?.winner, String(fallback.id));

    await database.deleteFrom('standard_product_members').where('product_id', '=', retiredWinner.id).execute();
    assert.deepEqual(await queued(), [String(plus.id)], 'projection deletes must remove obsolete summaries');
    await publish();
    assert.deepEqual((await totals()).map(row => row.standard), [String(team.id)]);
    await database.insertInto('standard_product_members').values({
      product_id: retiredWinner.id, standard_product_id: plus.id, assignment_source: 'ai',
    }).execute();
    assert.deepEqual(await queued(), [String(plus.id)], 'projection inserts must republish summaries');
    await publish();
    assert.equal((await totals()).find(row => row.standard === String(plus.id))?.winner, String(retiredWinner.id));
    await sql`truncate catalog_read_offer_prices`.execute(database);
    assert.deepEqual(await queued(), [team, plus, soldOut].map(row => String(row.id)));
    await publish();
    assert.deepEqual(await totals(), []);
    assert.deepEqual((await repository.search({ tags: [], limit: 20 })).items, []);
  });
}

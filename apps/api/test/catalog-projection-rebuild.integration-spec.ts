import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Kysely, PostgresDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';

describe('catalog projection roll-forward rebuild', { concurrency: false }, () => {
  const schema = `projection_rebuild_${randomUUID().replaceAll('-', '')}`;
  const sentinel = `projection_sentinel_${randomUUID().replaceAll('-', '')}`;
  const table = (name: string, namespace = schema) => `"${namespace}"."${name}"`;
  let admin: Pool;
  let pool: Pool;
  let database: Kysely<unknown>;
  let migrator: Migrator;
  let connectionString: string;
  let sentinelCreated = false;
  let fixture: { product: unknown; standard: unknown; shop: unknown; offer: unknown };

  before(async () => {
    connectionString = process.env.TEST_DATABASE_URL || '';
    assert.ok(connectionString, 'TEST_DATABASE_URL is required');
    admin = new Pool({ connectionString });
    await admin.query(`create schema "${schema}"`);
    pool = new Pool({ connectionString, max: 4, options: `-c search_path=${schema},public -c statement_timeout=15000` });
    database = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
    migrator = new Migrator({ db: database, migrationTableSchema: schema, provider: {
      async getMigrations() {
        const migrations = await migrationProvider.getMigrations();
        // Test the projection migration lineage while excluding unrelated data cleanup.
        return Object.fromEntries(Object.entries(migrations).filter(([name]) =>
          name <= '017_catalog_facet_counts_20261023' || name === '019_catalog_projection_rebuild_20261023'));
      },
    } });
    await migrate('017_catalog_facet_counts_20261023');
    const shop = (await pool.query(`insert into ${table('shops')} (name, platform, url)
      values ('Parent shop', 'test', 'https://projection-rebuild.invalid') returning id`)).rows[0].id;
    const standard = (await pool.query(`insert into ${table('standard_products')} (name, verification_state)
      values ('Parent standard', 'verified') returning id`)).rows[0].id;
    const product = (await pool.query(`insert into ${table('products')} (shop_id, external_id, name, normalized_key, url)
      values ($1, 'rebuild', 'Product only', 'rebuild-key', 'https://projection-rebuild.invalid/item') returning id`, [shop])).rows[0].id;
    await pool.query(`insert into ${table('standard_product_members')} (product_id, standard_product_id, assignment_source)
      values ($1, $2, 'ai')`, [product, standard]);
    const offer = (await pool.query(`insert into ${table('offers')}
      (product_id, idempotency_key, price, captured_at, settlement_price, settlement_verified_at, settlement_payment_method)
      values ($1, 'rebuild-offer', 19.20, '2020-01-02T00:00:00Z', 17.25, '2020-01-01T00:00:00Z', 'card')
      returning id`, [product])).rows[0].id;
    await pool.query(`update ${table('catalog_product_facts')} set tags =
      '[{"name":"warranty_days","value":"7"},{"name":"warranty_days","value":"30"},{"name":"access","value":"dedicated"}]',
      tag_text = 'rebuild-facts' where product_id = $1`, [product]);
    fixture = { product, standard, shop, offer };
  });

  beforeEach(async () => { await migrate('017_catalog_facet_counts_20261023'); });

  after(async () => {
    await database?.destroy();
    if (admin) {
      if (sentinelCreated) await admin.query(`drop schema "${sentinel}" cascade`);
      await admin.query(`drop schema if exists "${schema}" cascade`);
      await admin.end();
    }
  });

  async function migrate(target?: string) {
    const result = target ? await migrator.migrateTo(target) : await migrator.migrateToLatest();
    if (result.error) throw result.error;
  }

  async function rebuild(target = database) {
    const migration = await import('../src/database/migrations/019_catalog_projection_rebuild_20261023.js');
    await migration.up(target);
  }

  async function sourceSnapshot() {
    const names = ['products', 'shops', 'standard_products', 'standard_product_members', 'catalog_product_facts',
      'offers', 'offer_price_history', 'product_standardization_decisions', 'catalog_cache_versions', 'catalog_read_facet_counts'];
    const parts = names.map(name => `'${name}', (select coalesce(jsonb_agg(row_value order by row_value::text), '[]'::jsonb)
      from (select to_jsonb(t) || jsonb_build_object('_xmin', t.xmin::text) as row_value from ${table(name)} t) rows)`);
    return (await pool.query(`select jsonb_build_object(${parts.join(', ')}) as snapshot`)).rows[0].snapshot;
  }

  async function projectionSnapshot() {
    return (await pool.query(`select
      (select jsonb_agg(to_jsonb(w) || jsonb_build_object('_xmin', w.xmin::text) order by product_id)
        from ${table('catalog_read_offers')} w) as wide,
      (select jsonb_agg(to_jsonb(p) || jsonb_build_object('_xmin', p.xmin::text) order by product_id)
        from ${table('catalog_read_offer_prices')} p) as prices`)).rows[0];
  }

  async function objectSnapshot(namespace = schema) {
    const functions = await pool.query(`select p.proname, pg_get_functiondef(p.oid) as definition
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = $1 and p.proname like 'catalog_read_%' order by p.proname`, [namespace]);
    const triggers = await pool.query(`select c.relname, t.tgname, pg_get_triggerdef(t.oid) as definition
      from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid = t.tgrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and not t.tgisinternal and t.tgname like 'catalog_read_%' order by c.relname, t.tgname`, [namespace]);
    const indexes = await pool.query(`select tablename, indexname, indexdef from pg_catalog.pg_indexes
      where schemaname = $1 order by indexname`, [namespace]);
    return { functions: functions.rows, triggers: triggers.rows, indexes: indexes.rows };
  }

  async function assertCanonical() {
    const attributes = await pool.query(`select c.relname, a.attname, a.attgenerated
      from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      join pg_catalog.pg_attribute a on a.attrelid = c.oid
      where n.nspname = $1 and c.relname in ('catalog_read_offers', 'catalog_read_offer_prices')
        and a.attnum > 0 and not a.attisdropped`, [schema]);
    const wide = attributes.rows.filter(row => row.relname === 'catalog_read_offers');
    const prices = attributes.rows.filter(row => row.relname === 'catalog_read_offer_prices');
    assert.ok(!wide.some(row => row.attname === 'shop_name'), 'draft parent metadata must be removed');
    for (const [columns, required] of [[wide, ['available', 'warranty_days']], [prices, ['available', 'price', 'verification_at']]] as const) {
      for (const name of required) assert.ok(columns.some(row => row.attname === name && row.attgenerated === 's'), name);
    }
    const parents = await pool.query(`select t.tgname from pg_catalog.pg_trigger t
      join pg_catalog.pg_class c on c.oid = t.tgrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relname in ('shops', 'standard_products')
        and t.tgname like 'catalog_read_offers_%'`, [schema]);
    assert.deepEqual(parents.rows, []);
    const refresh = (await pool.query(`select p.prosrc from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = $1 and p.proname = 'refresh_catalog_read_offers'`, [schema])).rows[0].prosrc;
    assert.doesNotMatch(refresh, /\b(?:shops|standard_products)\b|\bfor\s+share\b/iu);
    assert.match(refresh, /for\s+no\s+key\s+update/iu);
    const foreignKeys = await pool.query(`select target.relname from pg_catalog.pg_constraint k
      join pg_catalog.pg_class c on c.oid = k.conrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      join pg_catalog.pg_class target on target.oid = k.confrelid
      where n.nspname = $1 and c.relname in ('catalog_read_offers', 'catalog_read_offer_prices') and k.contype = 'f'`, [schema]);
    assert.deepEqual(foreignKeys.rows.map(row => row.relname).sort(), ['products', 'products']);
  }

  async function installLegacyParents(namespace = schema) {
    for (const parent of ['shops', 'standard_products']) {
      const name = `catalog_read_offers_${parent}_changed`;
      await pool.query(`create function ${table(name, namespace)}() returns trigger language plpgsql as $$
        begin return null; end $$`);
      for (const event of ['insert', 'update', 'delete', 'truncate']) {
        await pool.query(`create trigger "catalog_read_offers_${parent}_${event}" after ${event} on ${table(parent, namespace)}
          for each statement execute function ${table(name, namespace)}()`);
      }
    }
  }

  async function installLegacyRefresh() {
    await pool.query(`create or replace function ${table('refresh_catalog_read_offers')}(product_ids bigint[])
      returns void language plpgsql as $$ begin
        perform sh.id from ${table('shops')} sh join ${table('standard_products')} sp on true
          where sh.id = any(product_ids) for share;
      end $$`);
  }

  test('canonical up, down and up again preserve projection xmin and every source row', async () => {
    const source = await sourceSnapshot();
    const projections = await projectionSnapshot();
    await migrate();
    await rebuild();
    await assertCanonical();
    assert.deepEqual(await sourceSnapshot(), source);
    assert.deepEqual(await projectionSnapshot(), projections);
    const statistics = await pool.query(`select c.relname, c.reltuples::integer as rows
      from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relname in ('catalog_read_offers', 'catalog_read_offer_prices',
        'standard_products', 'shops', 'catalog_read_facet_counts') order by c.relname`, [schema]);
    assert.deepEqual(statistics.rows, ['catalog_read_facet_counts', 'catalog_read_offer_prices', 'catalog_read_offers',
      'shops', 'standard_products'].map(relname => ({ relname, rows: 1 })));
    await migrate('017_catalog_facet_counts_20261023');
    await migrate();
    assert.deepEqual(await sourceSnapshot(), source);
    assert.deepEqual(await projectionSnapshot(), projections);
  });

  test('repairs a deployed draft atomically while preserving sources, history, versions and 017 counts', async () => {
    await pool.query(`alter table ${table('catalog_read_offers')} add column shop_name text,
      drop column available`);
    await pool.query(`alter table ${table('catalog_read_offer_prices')} drop column available`);
    await installLegacyParents();
    await installLegacyRefresh();
    await pool.query(`create index catalog_product_facts_facet_tags on ${table('catalog_product_facts')} (facet_tags)`);
    const source = await sourceSnapshot();
    assert.equal(source.offer_price_history.length, 1, 'history preservation must cover a real recorded quote');
    const countsObjects = await objectSnapshot();
    await migrate();
    await assertCanonical();
    assert.deepEqual(await sourceSnapshot(), source);
    const afterObjects = await objectSnapshot();
    for (const kind of ['functions', 'triggers'] as const) {
      assert.deepEqual(afterObjects[kind].filter(row => (row.proname ?? row.tgname).startsWith('catalog_read_facet_counts_')),
        countsObjects[kind].filter(row => (row.proname ?? row.tgname).startsWith('catalog_read_facet_counts_')));
    }
    const projections = await projectionSnapshot();
    assert.equal(projections.wide[0].available, true);
    assert.equal(projections.wide[0].warranty_days, 30);
    assert.equal(projections.prices[0].price, 17.25);
    assert.equal(new Date(projections.prices[0].verification_at).toISOString(), '2020-01-01T00:00:00.000Z');
    assert.ok(!projections.wide[0].search_text.includes('parent shop'));
    assert.ok(!afterObjects.indexes.some(row => row.indexname === 'catalog_product_facts_facet_tags'));

    await pool.query(`update ${table('products')} set normalized_key = 'rebuilt-product' where id = $1`, [fixture.product]);
    assert.ok((await projectionSnapshot()).wide[0].search_text.includes('rebuilt-product'));
    await pool.query(`update ${table('offers')} set price = 24.50 where id = $1`, [fixture.offer]);
    assert.equal((await projectionSnapshot()).prices[0].listed_price, 24.5);
    await pool.query(`update ${table('catalog_product_facts')} set tags = '[{"name":"warranty_days","value":"90"}]',
      tag_text = 'updated-facts' where product_id = $1`, [fixture.product]);
    assert.equal((await projectionSnapshot()).wide[0].warranty_days, 90);
    const counts = await pool.query(`select facet_tags, count(*)::text as count from ${table('catalog_product_facts')} group by facet_tags`);
    assert.deepEqual((await pool.query(`select facet_tags, product_count::text as count from ${table('catalog_read_facet_counts')}`)).rows, counts.rows);
    await pool.query(`update ${table('standard_product_members')} set publication_state = 'quarantined' where product_id = $1`, [fixture.product]);
    assert.equal((await projectionSnapshot()).wide, null);
    await pool.query(`update ${table('standard_product_members')} set publication_state = 'published' where product_id = $1`, [fixture.product]);
    assert.ok((await projectionSnapshot()).wide);
  });

  test('detects legacy refresh code, parent triggers and foreign keys even when the columns look canonical', async () => {
    for (const change of [
      () => installLegacyRefresh(),
      () => installLegacyParents(),
      () => pool.query(`alter table ${table('catalog_read_offers')} add constraint legacy_parent
        foreign key (shop_id) references ${table('shops')} (id)`),
    ]) {
      await change();
      const source = await sourceSnapshot();
      await rebuild();
      await assertCanonical();
      assert.deepEqual(await sourceSnapshot(), source);
    }
  });

  test('missing projection objects never resolve to same-named sentinel objects later in search_path', async () => {
    await admin.query(`create schema "${sentinel}"`);
    sentinelCreated = true;
    for (const name of ['catalog_read_offers', 'catalog_read_offer_prices']) {
      await pool.query(`create table ${table(name, sentinel)} (marker text)`);
      await pool.query(`insert into ${table(name, sentinel)} values ('sentinel')`);
    }
    await pool.query(`create table ${table('catalog_product_facts', sentinel)} (facet_tags text)`);
    await pool.query(`create index catalog_product_facts_facet_tags on ${table('catalog_product_facts', sentinel)} (facet_tags)`);
    for (const parent of ['shops', 'standard_products']) await pool.query(`create table ${table(parent, sentinel)} (id bigint)`);
    await installLegacyParents(sentinel);
    await pool.query(`create function ${table('catalog_read_offers_max_warranty_days', sentinel)}(jsonb)
      returns integer language sql immutable as $$ select 999 $$`);
    const before = await objectSnapshot(sentinel);
    await pool.query(`drop table ${table('catalog_read_offer_prices')}`);
    const source = await sourceSnapshot();
    const isolated = new Kysely<unknown>({ dialect: new PostgresDialect({
      pool: new Pool({ connectionString, options: `-c search_path=${schema},${sentinel},public -c statement_timeout=15000` }),
    }) });
    try {
      await rebuild(isolated);
    } finally { await isolated.destroy(); }
    await assertCanonical();
    assert.deepEqual(await sourceSnapshot(), source);
    assert.deepEqual(await objectSnapshot(sentinel), before);
    for (const name of ['catalog_read_offers', 'catalog_read_offer_prices']) {
      assert.deepEqual((await pool.query(`select marker from ${table(name, sentinel)}`)).rows, [{ marker: 'sentinel' }]);
    }
  });

  test('partitioned projection objects cannot be rebuilt or lose their unknown payload', async () => {
    const source = await sourceSnapshot();
    await pool.query(`drop table ${table('catalog_read_offers')}`);
    await pool.query(`create table ${table('catalog_read_offers')}
      (product_id bigint not null, parallel_payload text) partition by range (product_id)`);
    await pool.query(`create table ${table('projection_partition')} partition of ${table('catalog_read_offers')}
      for values from (minvalue) to (maxvalue)`);
    await pool.query(`insert into ${table('catalog_read_offers')} values ($1, 'preserve-partition-data')`, [fixture.product]);
    try {
      await assert.rejects(rebuild(), /unsupported projection relation/iu);
      assert.deepEqual((await pool.query(`select parallel_payload from ${table('catalog_read_offers')}`)).rows,
        [{ parallel_payload: 'preserve-partition-data' }]);
      assert.deepEqual(await sourceSnapshot(), source);
    } finally {
      await pool.query(`drop table ${table('catalog_read_offers')}`);
      await rebuild();
    }
  });

  test('unknown projection columns or dependent views abort repair and preserve draft objects and data', async () => {
    await pool.query(`alter table ${table('catalog_read_offers')} add column shop_name text`);
    for (const projection of ['catalog_read_offers', 'catalog_read_offer_prices']) {
      await pool.query(`alter table ${table(projection)} add column parallel_payload jsonb`);
      await pool.query(`update ${table(projection)} set parallel_payload = '{"owner":"another-version"}'`);
      const source = await sourceSnapshot();
      const projections = await projectionSnapshot();
      const objects = await objectSnapshot();
      await assert.rejects(rebuild(), /unknown projection column/iu);
      assert.deepEqual(await sourceSnapshot(), source);
      assert.deepEqual(await projectionSnapshot(), projections);
      assert.deepEqual(await objectSnapshot(), objects);
      await pool.query(`alter table ${table(projection)} drop column parallel_payload`);
    }
    await pool.query(`create view ${table('unknown_projection_dependency')} as select product_id from ${table('catalog_read_offers')}`);
    const source = await sourceSnapshot();
    const projections = await projectionSnapshot();
    const objects = await objectSnapshot();
    await assert.rejects(rebuild(), { code: '2BP01' });
    assert.deepEqual(await sourceSnapshot(), source);
    assert.deepEqual(await projectionSnapshot(), projections);
    assert.deepEqual(await objectSnapshot(), objects);
    await pool.query(`drop view ${table('unknown_projection_dependency')}`);
    await rebuild();
    await assertCanonical();
    await migrate('015_ai_response_diagnostic_20261023');
    await migrate('017_catalog_facet_counts_20261023');
    await assertCanonical();
  });
});

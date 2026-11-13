import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { Kysely, PostgresDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';

const current = '038_seven_dimension_tags_20261113';

async function setup(t: TestContext) {
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.ok(connectionString, 'TEST_DATABASE_URL is required');
  const schema = `tag_locks_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString });
  await admin.query(`create schema "${schema}"`);
  const pool = new Pool({
    connectionString, max: 4,
    options: `-c search_path=${schema},public -c statement_timeout=15000 -c application_name=${schema}`,
  });
  const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
  const migrator = new Migrator({ db, provider: migrationProvider, migrationTableSchema: schema });
  t.after(async () => {
    await db.destroy();
    await admin.query(`drop schema "${schema}" cascade`);
    await admin.end();
  });
  const result = await migrator.migrateTo('037_catalog_membership_kinds_20261113');
  assert.ifError(result.error);
  const shop = await pool.query(`insert into shops (name, platform, url)
    values ('Lock test', 'test', 'https://tags.invalid') returning id`);
  const product = await pool.query(`insert into products (shop_id, external_id, name, normalized_key, url)
    values ($1, 'locks', 'Tag lock test', 'locks', 'https://tags.invalid/locks') returning id`, [shop.rows[0].id]);
  const standard = await pool.query(`insert into standard_products (name, platform, verification_state)
    values ('Tag plan', 'test', 'verified') returning id`);
  await pool.query(`insert into standard_product_members
    (product_id, standard_product_id, assignment_source, publication_state)
    values ($1, $2, 'human', 'published')`, [product.rows[0].id, standard.rows[0].id]);
  await pool.query(`insert into product_tags (product_id, name, value) values ($1, 'duration', '30')`, [product.rows[0].id]);
  await pool.query(`insert into offers (product_id, idempotency_key, price, currency)
    values ($1, 'locks', 10, 'CNY')`, [product.rows[0].id]);

  async function waitForContention() {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const activity = await admin.query(`select 1 from pg_stat_activity
        where application_name = $1 and state = 'active'
          and (wait_event_type = 'Lock' or wait_event = 'PgSleep')`, [schema]);
      if (activity.rowCount) return;
      await setTimeout(10);
    }
    assert.fail('migration did not encounter the held relation lock');
  }
  return { pool, migrator, waitForContention, schema };
}

for (const held of [
  'product_tags', 'catalog_read_offers', 'catalog_read_offer_prices',
  'catalog_read_facet_counts', 'catalog_cache_versions',
]) {
  test(`tag migration releases partial locks while ${held} is busy`, async t => {
    const { pool, migrator, waitForContention } = await setup(t);
    const writer = await pool.connect();
    let pending: ReturnType<typeof migrator.migrateTo> | undefined;
    try {
      await writer.query('begin');
      await writer.query('set local statement_timeout = 4000');
      await writer.query(`select 1 from ${held} for share`);
      pending = migrator.migrateTo(current);
      await waitForContention();
      // The offer trigger reads the projection before requesting its write lock.
      await writer.query(`update offers set settlement_price = 9,
        settlement_verified_at = now(), settlement_payment_method = 'card'`);
      await writer.query('commit');
      const result = await pending;
      assert.ifError(result.error);
      assert.equal(result.results?.find(row => row.migrationName === current)?.status, 'Success');
    } finally {
      await writer.query('rollback');
      writer.release();
      await pending;
    }
  });
}

test('tag migration contention leaves legacy data intact and allows retry', async t => {
  const { pool, migrator, schema } = await setup(t);
  const reader = await pool.connect();
  try {
    await reader.query('begin');
    await reader.query('select 1 from catalog_read_offers');
    const result = await migrator.migrateTo(current);
    assert.equal((result.error as { code?: string })?.code, '55P03');
    assert.match((result.error as { hint: string }).hint, /Pause application writers and workers/);
    assert.deepEqual((await pool.query('select name from kysely_migration where name = $1', [current])).rows, []);
    assert.deepEqual((await pool.query(`select data_type from information_schema.columns
      where table_schema = $1 and table_name = 'product_tags' and column_name = 'value'`, [schema])).rows,
    [{ data_type: 'text' }]);
    assert.deepEqual((await pool.query('select name, value from product_tags')).rows, [{ name: 'duration', value: '30' }]);
    assert.equal((await pool.query(`select to_regprocedure($1) is null as absent`,
      [`${schema}.catalog_valid_tag(text,jsonb)`])).rows[0].absent, true);
  } finally {
    await reader.query('rollback');
    reader.release();
  }
  assert.ifError((await migrator.migrateTo(current)).error);
});

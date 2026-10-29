import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { migrateToLatest } from '../scripts/migrate.js';
import type { DatabaseSchema } from '../src/database/types.js';
import { buildCanonicalStandardKey } from '../src/standardization/canonical-key.js';
import { resolveCanonicalIdentity } from '../src/standardization/canonical-resolution.js';
import type { Identity } from '../src/standardization/identity-policy.js';

let db: Kysely<DatabaseSchema>, admin: Pool;
const schema = 'canonical_creation_' + randomUUID().replaceAll('-', '');
before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required');
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
  await admin?.query(`drop schema if exists "${schema}" cascade`);
  await admin?.end();
  delete process.env.PG_SCHEMA;
});
const resolve = (identity: Identity) => db.transaction().execute(tx => resolveCanonicalIdentity(tx, identity));
const standard = (identity: Identity) => db.insertInto('standard_products').values({
  name: identity.product, platform: identity.family, standard_key: buildCanonicalStandardKey(identity),
  canonical_family: identity.family, canonical_product: identity.product, canonical_tier: identity.tier, verification_state: 'verified',
}).returning('id').executeTakeFirstOrThrow();

test('SKU-only tiers cannot create new standards but exact verified historical keys remain usable', async () => {
  const identity = { family: 'software', product: 'yunfan_protocol_card', tier: '月卡' };
  for (const tier of ['月卡', 'monthly_card', '1个月', 'USD 100', '5 accounts', '100', '10.5', '１００']) {
    assert.deepEqual(await resolve({ ...identity, tier }), { status: 'conflict', reason: 'sku_in_identity' }, tier);
  }
  const target = await standard(identity);
  const result = await resolve(identity);
  assert.equal(result.status, 'resolved');
  if (result.status === 'resolved') assert.equal(result.standardProductId, target.id);
  const numericIdentity = { ...identity, tier: '100' };
  const numericTarget = await standard(numericIdentity);
  const numericResult = await resolve(numericIdentity);
  assert.equal(numericResult.status, 'resolved');
  if (numericResult.status === 'resolved') assert.equal(numericResult.standardProductId, numericTarget.id);
  await db.updateTable('standard_products').set({ verification_state: 'quarantined' }).where('id', '=', target.id).execute();
  assert.deepEqual(await resolve(identity), { status: 'conflict', reason: 'identity_unavailable' });
});

test('only audited absent spellings reuse existing canonical targets with availability and key checks', async () => {
  const incoming = { family: 'apple', product: 'icloud_email', tier: 'standard' };
  const canonical = { family: 'apple', product: 'icloud_mail', tier: 'standard' };
  assert.deepEqual(await resolve(incoming), { status: 'conflict', reason: 'identity_unavailable' }, 'absent audited target is not invented');
  const target = await standard(canonical);
  const result = await resolve(incoming);
  assert.equal(result.status, 'resolved');
  if (result.status === 'resolved') {
    assert.equal(result.standardProductId, target.id);
    assert.deepEqual(result.identity, canonical);
  }
  const unreviewed = { family: 'apple', product: 'icloud_email', tier: 'pro' };
  assert.deepEqual(await resolve(unreviewed), { status: 'conflict', reason: 'invalid_identity' });
  await db.updateTable('standard_products').set({ canonical_tier: 'pro' }).where('id', '=', target.id).execute();
  assert.equal((await resolve(incoming)).status, 'conflict');
  await db.updateTable('standard_products').set({ canonical_tier: 'standard', verification_state: 'quarantined' }).where('id', '=', target.id).execute();
  assert.deepEqual(await resolve(incoming), { status: 'conflict', reason: 'identity_unavailable' });
});

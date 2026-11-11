import assert from 'node:assert/strict';
import test from 'node:test';
import { ValidationPipe } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants.js';
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery } from 'kysely';
import { AdminRepository } from '../src/admin/admin.repository.js';
import { AdminController } from '../src/admin/admin.controller.js';
import { ProductsRepository } from '../src/products/products.repository.js';
import type { DatabaseSchema } from '../src/database/types.js';
import { buildCanonicalStandardKey } from '../src/standardization/canonical-key.js';
import { buildMembershipFeatures } from '../src/standardization/membership-classification.js';

const identity = { family: 'openai', product: 'chatgpt', tier: 'plus' };
test('admin exposes confirmed AI membership eligibility independently of a feature snapshot', async () => {
  const repository = {
    listProducts: async () => ({ items: [{
      id: 1n, shop_id: 2n, external_id: 'sku', membership_features: null, is_ai_membership: true,
    }, {
      id: 3n, shop_id: 2n, external_id: 'ordinary', membership_features: null, is_ai_membership: false,
    }], nextCursor: null }),
  };
  const controller = new AdminController(repository as never);
  const result = await controller.listProducts({} as never);
  assert.deepEqual(result.items.map(item => item.isAiMembership), [true, false]);
  assert.ok(result.items.every(item => item.membershipFeatures === null));
});
const standard = (id: bigint) => ({
  id, name: 'ChatGPT Plus', canonical_family: 'openai', canonical_product: 'chatgpt', canonical_tier: 'plus',
  merged_into_id: null, aliases: [], platform: '', sort_order: 0n,
  verification_state: 'verified', standard_key: buildCanonicalStandardKey(identity),
});
const product = {
  id: 1n, name: 'ChatGPT Plus account', spec: '', source_category: '', source_data: {}, deleted_at: null,
  content_version: 2n, content_fingerprint: 'current', standardization_revision: 3n, membership_features: null,
};

function fixture(options: { standards?: ReturnType<typeof standard>[]; products?: object[]; members?: object[] } = {}) {
  const standards = options.standards ?? [standard(10n)];
  const products = options.products ?? [product];
  const members = options.members ?? [];
  const writes: CompiledQuery[] = [];
  class Driver extends DummyDriver {
    async acquireConnection(): Promise<any> {
      return { executeQuery: async (query: CompiledQuery) => {
        if (/^(insert|update|delete)/u.test(query.sql.trimStart())) {
          writes.push(query);
          if (query.sql.includes('catalog_cache_versions')) return { rows: [{ version: 2n }] };
          if (query.sql.includes('standardization_catalog_versions')) return { rows: [{ version: 2n }] };
          if (query.sql.startsWith('insert into "standard_products"')) return { rows: standards };
          if (query.sql.startsWith('update "standard_products"')) return { rows: standards, numAffectedRows: BigInt(standards.length) };
          return { rows: [], numAffectedRows: 1n };
        }
        if (query.sql.includes('from "standard_products"')) {
          if (query.sql.includes('"standard_key" =')) return { rows: [] };
          return { rows: standards };
        }
        if (query.sql.includes('from "standard_product_members"')) return { rows: members };
        if (query.sql.includes('from "products"')) return { rows: products };
        return { rows: [] };
      } };
    }
  }
  const db = new Kysely<DatabaseSchema>({ dialect: {
    createAdapter: () => new PostgresAdapter(), createDriver: () => new Driver(),
    createIntrospector: database => new PostgresIntrospector(database), createQueryCompiler: () => new PostgresQueryCompiler(),
  } });
  return { db, writes };
}

test('admin creates standard identity without product features', async t => {
  const f = fixture();
  t.after(() => f.db.destroy());
  const created = await new AdminRepository(f.db).createStandardProduct(identity, '', [1n]);
  assert.equal(created.id, 10n);
  const insert = f.writes.find(query => query.sql.startsWith('insert into "standard_products"'))!;
  assert.ok(insert);
  assert.equal(insert.sql.includes('membership_kind'), false);
});

test('both manual assignment paths accept absent product features', async t => {
  const f = fixture();
  t.after(() => f.db.destroy());
  assert.deepEqual(await new AdminRepository(f.db).bindProducts([1n], 10n, true),
    { success: ['1'], skipped: [], conflicts: [] });
  await new ProductsRepository(f.db).assignStandardProduct(1n, 10n, 'reviewed');
  assert.ok(f.writes.some(query => query.sql.startsWith('insert into "product_standardization_decisions"')));
  assert.ok(f.writes.some(query => query.sql.startsWith('insert into "standard_product_members"') && query.parameters.includes('human')));
  assert.ok(f.writes.every(query => !query.sql.includes('"standardization_locked" =')));
});

test('different product features share one standard and retain independent current snapshots', async t => {
  for (const kind of ['account', 'top_up', 'rental', 'short_term'] as const) {
    const row = { ...product, membership_features: buildMembershipFeatures([], product, [], kind) };
    const f = fixture({ products: [row] });
    t.after(() => f.db.destroy());
    assert.deepEqual((await new AdminRepository(f.db).bindProducts([row.id], 10n, true)).success, ['1']);
    const snapshotWrite = f.writes.find(query => query.sql.includes('"membership_features" ='))!;
    assert.deepEqual(JSON.parse(snapshotWrite.parameters[0] as string), { ...row.membership_features, revision: '4' });
    const history = f.writes.find(query => query.sql.startsWith('insert into "product_standardization_decisions"'))!;
    const target = history.parameters.filter(value => typeof value === 'string' && value.startsWith('{"family"')).map(value => JSON.parse(value as string))[0];
    assert.equal('membershipKind' in target, false);
  }
});

test('manual merge and identity edits do not require feature snapshots', async t => {
  const f = fixture({ standards: [standard(10n), standard(11n)], members: [{ product_id: 1n, standard_product_id: 11n }] });
  t.after(() => f.db.destroy());
  assert.deepEqual(await new AdminRepository(f.db).mergeStandardProducts([11n], 10n),
    { success: ['11'], skipped: [], conflicts: [] });
  await new AdminRepository(f.db).updateStandardProduct(10n, { canonicalTier: 'team' });
  assert.ok(f.writes.some(query => query.sql.startsWith('update "standard_products"') && query.parameters.includes('team')));
});

test('admin create and patch DTOs reject standard feature fields', async () => {
  for (const method of ['createStandardProduct', 'updateStandardProduct']) {
    const parameters = Reflect.getMetadata(ROUTE_ARGS_METADATA, AdminController, method) as Record<string, { pipes: ValidationPipe[] }>;
    const pipe = Object.values(parameters).flatMap(parameter => parameter.pipes).find(pipe => pipe instanceof ValidationPipe)!;
    const body = method === 'createStandardProduct' ? { ...identity, productIds: ['1'] } : { canonicalTier: 'team' };
    await pipe.transform(body, { type: 'body' });
    for (const membershipKind of ['rental', 'account', null]) {
      await assert.rejects(pipe.transform({ ...body, membershipKind }, { type: 'body' }));
    }
  }
});

test('cosmetic edits advance only current product features with the revision', async t => {
  for (const stale of [false, true]) {
    const features = { ...buildMembershipFeatures([], product, [], 'account'), ...(stale ? { fingerprint: 'old' } : {}) };
    const f = fixture({ products: [{ ...product, membership_features: features }], members: [{ product_id: 1n, standard_product_id: 10n }] });
    t.after(() => f.db.destroy());
    await new AdminRepository(f.db).updateStandardProduct(10n, { name: 'Reviewed display name' });
    const writes = f.writes.filter(query => query.sql.startsWith('update "products"'));
    assert.equal(writes.length, 1);
    const snapshots = writes.flatMap(query => query.parameters.filter(value => typeof value === 'string' && value.startsWith('{"contentVersion"')));
    assert.deepEqual(snapshots.map(value => JSON.parse(value as string)), stale ? [] : [{ ...features, revision: '4' }]);
  }
});

test('admin product responses expose only current membershipFeatures and standards expose none', async () => {
  const snapshot = buildMembershipFeatures([], product, [], 'account');
  const rows = [snapshot, { ...snapshot, revision: '1' }].map((membership_features, index) => ({
    ...product, id: BigInt(index + 1), shop_id: 1n, membership_features, is_ai_membership: true,
  }));
  const controller = new AdminController({ listProducts: async () => ({ items: rows }),
    listStandardProducts: async () => ({ items: [{ ...standard(10n), member_count: 2n, shop_count: 1n }] }),
  } as unknown as AdminRepository);
  const response = await controller.listProducts({});
  assert.deepEqual(response.items.map(item => item.membershipFeatures), [snapshot, null]);
  assert.ok(response.items.every(item => !('membershipClassification' in item)));
  const standards = await controller.listStandardProducts({});
  assert.equal('membershipKind' in standards.items[0]!, false);
});

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { createApp } from '../src/main.js';
import { AppModule } from '../src/app.module.js';
import {
  createPostgresPool,
  DATABASE,
} from '../src/database/database.providers.js';
import { jsonb, type DatabaseSchema } from '../src/database/types.js';
import { DomainConflictError } from '../src/common/errors.js';
import { buildCanonicalStandardKey } from '../src/standardization/canonical-key.js';
import { migrateToLatest } from '../scripts/migrate.js';
import { ShopsRepository } from '../src/shops/shops.repository.js';
import { ShopsService } from '../src/shops/shops.service.js';
import { AdminRepository } from '../src/admin/admin.repository.js';
import { ProductsRepository, productMapKey } from '../src/products/products.repository.js';
import { ProductsService } from '../src/products/products.service.js';
import { productContentFingerprint } from '../src/standardization/fingerprint.js';
import { StandardizationRepository } from '../src/standardization/standardization.repository.js';

const ADMIN_PASSWORD = `task3-admin-${Date.now()}`;

describe('shop, product, and offer repositories', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let adminPool: Pool;
  let migrationDatabase: Kysely<DatabaseSchema>;
  let testingModule: TestingModule;
  let schemaName: string;

  before(async () => {
    process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
    if (process.env.TEST_DATABASE_URL) {
      process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    } else {
      container = await new PostgreSqlContainer('postgres:16-alpine').start();
      process.env.DATABASE_URL = container.getConnectionUri();
    }

    schemaName = `task3_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    adminPool = new Pool({ connectionString: process.env.DATABASE_URL });
    await adminPool.query(`create schema "${schemaName}"`);
    process.env.PG_SCHEMA = schemaName;
    process.env.PG_POOL_MAX = '4';
    process.env.API_CONNECTIONS = '2';
    process.env.CRAWLER_CONNECTIONS = '1';
    process.env.AI_CONNECTIONS = '1';
    process.env.STANDARDIZATION_CONNECTIONS = '';
    process.env.PG_IDLE_TIMEOUT_MS = '5000';
    process.env.PG_CONNECTION_TIMEOUT_MS = '5000';
    process.env.PG_STATEMENT_TIMEOUT_MS = '10000';

    const migrationPool = createPostgresPool();
    migrationDatabase = new Kysely<DatabaseSchema>({
      dialect: new PostgresDialect({ pool: migrationPool }),
    });
    await migrateToLatest(migrationDatabase);
    testingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
  });

  beforeEach(async () => {
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    await sql`truncate table shops, product_standardization_decisions restart identity cascade`.execute(database);
  });

  after(async () => {
    await testingModule?.close();
    await migrationDatabase?.destroy();
    if (adminPool && schemaName) {
      await adminPool.query(`drop schema if exists "${schemaName}" cascade`);
      await adminPool.end();
    }
    await container?.stop();
    delete process.env.PG_SCHEMA;
  });

  test('shop upsert is idempotent and admin lists use keyset cursors', async () => {
    const repository = testingModule.get(ShopsRepository);
    const first = await repository.upsert({
      platform: '16688',
      url: 'https://shop-1.invalid',
      name: 'First',
      enabled: true,
    });
    const repeated = await repository.upsert({
      platform: '16688',
      url: 'https://shop-1.invalid',
      name: 'Renamed',
      enabled: false,
    });
    await repository.upsert({
      platform: 'liandong',
      url: 'https://shop-2.invalid',
      name: 'Second',
      enabled: true,
    });

    assert.equal(repeated.id, first.id);
    assert.equal(repeated.name, 'Renamed');
    assert.equal(repeated.enabled, false);

    const admin = testingModule.get(AdminRepository);
    const page1 = await admin.listShops({ limit: 1 });
    const page2 = await admin.listShops({ limit: 1, cursor: page1.nextCursor });
    assert.equal(page1.items.length, 1);
    assert.equal(page2.items.length, 1);
    assert.notEqual(page1.items[0]?.id, page2.items[0]?.id);
    assert.equal(page2.nextCursor, undefined);
  });

  test('product batch writes return every id and preserve source data', async () => {
    const shops = testingModule.get(ShopsRepository);
    const products = testingModule.get(ProductsRepository);
    const shop = await shops.upsert({
      platform: '16688',
      url: 'https://products.invalid',
      name: 'Products',
      enabled: true,
    });
    const input = [
      {
        shopId: shop.id,
        externalId: 'A',
        name: 'Alpha',
        normalizedKey: 'alpha',
        url: 'https://products.invalid/a',
        sourceData: { color: 'red' },
      },
      {
        shopId: shop.id,
        externalId: 'B',
        name: 'Beta',
        normalizedKey: 'beta',
        url: 'https://products.invalid/b',
        sourceData: { color: 'blue' },
      },
    ] as const;

    const inserted = await products.upsertBatch(input);
    const repeated = await products.upsertBatch([
      { ...input[0], name: 'Alpha updated', sourceData: { color: 'green' } },
      input[1],
    ]);

    assert.equal(inserted.size, 2);
    assert.equal(repeated.get(productMapKey(shop.id, 'A')), inserted.get(productMapKey(shop.id, 'A')));
    assert.equal(repeated.get(productMapKey(shop.id, 'B')), inserted.get(productMapKey(shop.id, 'B')));
    const rows = await testingModule
      .get<Kysely<DatabaseSchema>>(DATABASE)
      .selectFrom('products')
      .select(['external_id', 'name', 'source_data'])
      .orderBy('external_id')
      .execute();
    assert.deepEqual(rows, [
      { external_id: 'A', name: 'Alpha updated', source_data: { color: 'green' } },
      { external_id: 'B', name: 'Beta', source_data: { color: 'blue' } },
    ]);
  });

  test('batch imports version evidence and enqueue only new or changed products', async () => {
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    const products = testingModule.get(ProductsRepository);
    const shop = await testingModule.get(ShopsRepository).upsert({ platform: '16688', url: 'https://batch-audit.invalid', name: 'Batch audit', enabled: true });
    const first = { shopId: shop.id, externalId: 'new', name: 'OpenAI ChatGPT Plus', spec: 'monthly', sourceData: { vendor: 'OpenAI', price: 10 }, normalizedKey: 'chatgpt', url: 'https://batch-audit.invalid/new' };
    const ids = await products.upsertBatch([first]);
    const firstId = ids.get(productMapKey(shop.id, first.externalId))!;
    const standard = await database.insertInto('standard_products').values({ name: 'ChatGPT Plus', platform: 'openai' }).returning('id').executeTakeFirstOrThrow();
    await database.insertInto('standard_product_members').values({ standard_product_id: standard.id, product_id: firstId }).execute();
    await database.insertInto('product_tags').values({ product_id: firstId, name: 'duration', value: 'monthly' }).execute();
    const initialFingerprint = productContentFingerprint(first);
    const initial = await database.selectFrom('products').select(['content_fingerprint', 'content_version', 'standardization_revision']).execute();
    assert.deepEqual(initial, [{ content_fingerprint: initialFingerprint, content_version: 1n, standardization_revision: 1n }]);
    assert.deepEqual(await database.selectFrom('product_change_events').select(['product_id', 'event_type']).execute(), [{ product_id: firstId, event_type: 'created' }]);

    const cosmetic = { ...first, url: 'https://batch-audit.invalid/new-url', imageUrl: 'https://batch-audit.invalid/image.png', normalizedKey: 'new-key', sourceData: { vendor: 'OpenAI', price: 20 } };
    await products.upsertBatch([cosmetic]);
    assert.equal((await database.selectFrom('product_change_events').select('id').execute()).length, 1);
    assert.deepEqual(await database.selectFrom('products').select(['content_fingerprint', 'content_version', 'standardization_revision']).execute(), initial);
    assert.equal((await products.findById(firstId))!.url, cosmetic.url);
    assert.equal((await database.selectFrom('standard_product_members').select('product_id').execute()).length, 1);

    const changed = { ...cosmetic, description: 'yearly' };
    await products.upsertBatch([changed]);
    await products.upsertBatch([changed]);
    const changedFingerprint = productContentFingerprint(changed);
    assert.deepEqual(await database.selectFrom('products').select(['content_fingerprint', 'content_version', 'standardization_revision']).execute(), [
      { content_fingerprint: changedFingerprint, content_version: 2n, standardization_revision: 2n },
    ]);
    assert.deepEqual(await database.selectFrom('standard_product_members').select('product_id').execute(), []);
    assert.deepEqual(await database.selectFrom('product_tags').select('product_id').execute(), []);
    const events = await database.selectFrom('product_change_events').select(['id', 'product_id', 'event_type', 'fingerprint', 'content_version']).orderBy('id').execute();
    assert.deepEqual(events.map(({ id: _id, ...event }) => event), [
      { product_id: firstId, event_type: 'created', fingerprint: initialFingerprint, content_version: 1n },
      { product_id: firstId, event_type: 'evidence_changed', fingerprint: changedFingerprint, content_version: 2n },
    ]);
    assert.deepEqual(await database.selectFrom('standardization_outbox').select(['event_id', 'product_id', 'fingerprint', 'status']).orderBy('id').execute(), events.map(event => ({ event_id: event.id, product_id: event.product_id, fingerprint: event.fingerprint, status: 'queued' })));
  });

  test('concurrent first imports create one content version and one standardization event', async () => {
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    const products = testingModule.get(ProductsRepository);
    const shop = await testingModule.get(ShopsRepository).upsert({ platform: '16688', url: 'https://concurrent-import.invalid', name: 'Concurrent import', enabled: true });
    const input = [{ shopId: shop.id, externalId: 'same', name: 'OpenAI ChatGPT Plus', spec: 'monthly', normalizedKey: 'chatgpt', url: 'https://concurrent-import.invalid/same' }];
    const [first, second] = await Promise.all([products.upsertBatch(input), products.upsertBatch(input)]);
    assert.deepEqual(first, second);
    assert.deepEqual(await database.selectFrom('products').select('content_version').execute(), [{ content_version: 1n }]);
    assert.deepEqual(await database.selectFrom('product_change_events').select('event_type').execute(), [{ event_type: 'created' }]);
    assert.equal((await database.selectFrom('standardization_outbox').select('id').execute()).length, 1);
  });

  test('source evidence changes invalidate standardization identically for human and AI assignments', async () => {
    const shops = testingModule.get(ShopsRepository);
    const products = testingModule.get(ProductsRepository);
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    const shop = await shops.upsert({ platform: '16688', url: 'https://evidence.invalid', name: 'Evidence', enabled: true });
    const standard = await database.insertInto('standard_products').values({ name: 'Canonical', platform: '16688' }).returning('id').executeTakeFirstOrThrow();
    for (const path of ['batch', 'update', 'crawler'] as const) {
      for (const source of ['human', 'ai']) {
        const item = { shopId: shop.id, externalId: `${path}-${source}`, name: 'Old', spec: 'monthly', normalizedKey: 'old', url: 'https://evidence.invalid/item' };
        const ids = await products.upsertBatch([item]);
        const id = ids.get(productMapKey(shop.id, item.externalId))!;
        await database.insertInto('standard_product_members').values({ standard_product_id: standard.id, product_id: id, assignment_source: source }).execute();
        await database.insertInto('product_tags').values({ product_id: id, name: 'duration', value: 'monthly' }).execute();
        const beforeChange = await products.findById(id);
        if (path === 'batch') await products.upsertBatch([{ ...item, description: 'yearly' }]);
        else if (path === 'update') await products.update(id, { description: 'yearly' });
        else await database.transaction().execute(tx => products.upsertFetchedProducts(tx, [{ ...item, description: 'yearly' }]));
        assert.equal((await database.selectFrom('standard_product_members').select('product_id').where('product_id', '=', id).execute()).length, 0, `${path}/${source}`);
        assert.equal((await products.listTags(id)).length, 0, `${path}/${source}`);
        const current = await products.findById(id);
        assert.equal(current!.standardization_revision, beforeChange!.standardization_revision + 1n, `${path}/${source}`);
        assert.equal(current!.content_version, 2n, `${path}/${source}`);
      }
    }
  });

  test('quote-only refresh preserves assignment tags and standardization revision', async () => {
    const { shopId, productId } = await seedProduct();
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    const products = testingModule.get(ProductsRepository);
    const standard = await seedVerifiedStandard();
    await products.assignStandardProduct(productId, standard.id);
    await products.replaceTags(productId, [{ name: 'duration', value: 'monthly' }]);
    const before = await products.findById(productId);
    const changes = await database.transaction().execute(tx => products.upsertFetchedProducts(tx, [{ shopId, externalId: 'seed', name: 'Seed product', normalizedKey: 'seed-product', url: 'https://seed.invalid/product', price: '9.99', stockAvailable: false }]));
    assert.deepEqual(changes.changedProducts, []);
    assert.deepEqual(changes.quoteOnlyProducts, [productId]);
    assert.equal((await products.findById(productId))!.standardization_revision, before!.standardization_revision);
    assert.equal((await database.selectFrom('standard_product_members').select('product_id').where('product_id', '=', productId).execute()).length, 1);
    assert.deepEqual((await products.listTags(productId)).map(({ name, value }) => ({ name, value })), [{ name: 'duration', value: 'monthly' }]);
  });

  test('all write paths fingerprint canonical spec and invalidate spec-only changes', async () => {
    const db = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    const products = testingModule.get(ProductsRepository);
    const shop = await testingModule.get(ShopsRepository).upsert({
      platform: '16688', url: 'https://spec-contract.invalid', name: 'Spec', enabled: true,
    });
    const standard = await seedVerifiedStandard();
    for (const path of ['batch', 'update', 'crawler'] as const) {
      const item = { shopId: shop.id, externalId: path, name: 'Account', description: 'Body',
        spec: '期限：1个月 / 地区: 美区', normalizedKey: path, url: 'https://spec-contract.invalid/item' };
      const id = (await products.upsertBatch([item])).get(productMapKey(shop.id, path))!;
      const initial = (await products.findById(id))!;
      assert.equal(initial.spec, '地区: 美区 / 期限: 1个月');
      await products.assignStandardProduct(id, standard.id);
      await products.replaceTags(id, [{ name: 'duration', value: '1 month' }]);
      const before = (await products.findById(id))!;
      const members = await db.selectFrom('standard_product_members').selectAll().where('product_id', '=', id).execute();
      const decisions = await db.selectFrom('product_standardization_decisions').selectAll().where('product_id', '=', id).execute();
      const write = async (spec: string) => {
        if (path === 'batch') await products.upsertBatch([{ ...item, spec }]);
        else if (path === 'update') await products.update(id, { spec });
        else await db.transaction().execute(tx => products.upsertFetchedProducts(tx, [{ ...item, spec }]));
      };
      await write('地区: 美区 / 期限: 1个月');
      const formatted = (await products.findById(id))!;
      assert.equal(formatted.content_version, before.content_version);
      assert.equal(formatted.standardization_revision, before.standardization_revision);
      assert.deepEqual(await db.selectFrom('standard_product_members').selectAll().where('product_id', '=', id).execute(), members);
      assert.deepEqual((await products.listTags(id)).map(({ name, value }) => ({ name, value })), [{ name: 'duration', value: '1 month' }]);
      await write('期限: 1年 / 地区: 美区');
      const after = (await products.findById(id))!;
      assert.equal(after.content_version, before.content_version + 1n, path);
      assert.equal(after.standardization_revision, before.standardization_revision + 1n, path);
      assert.equal(after.source_name, initial.source_name);
      assert.equal(after.source_description, initial.source_description);
      assert.equal(after.content_fingerprint, productContentFingerprint({
        name: after.source_name, description: after.source_description, spec: after.spec,
      }));
      assert.deepEqual(await products.listTags(id), []);
      assert.deepEqual(await db.selectFrom('standard_product_members').selectAll().where('product_id', '=', id).execute(), []);
      assert.deepEqual(await db.selectFrom('product_standardization_decisions').selectAll().where('product_id', '=', id).execute(), decisions);
      if (path !== 'crawler') {
        const event = await db.selectFrom('product_change_events').select('fingerprint')
          .where('product_id', '=', id).orderBy('id', 'desc').executeTakeFirstOrThrow();
        assert.equal(event.fingerprint, after.content_fingerprint);
      }
    }
  });

  test('unchanged crawler evidence refreshes presentation fields without invalidating identity', async () => {
    const { shopId, productId } = await seedProduct();
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    const products = testingModule.get(ProductsRepository);
    const standard = await seedVerifiedStandard();
    await products.assignStandardProduct(productId, standard.id);
    await products.replaceTags(productId, [{ name: 'duration', value: 'monthly' }]);
    await database.updateTable('products').set({ updated_at: new Date('2020-01-01T00:00:00Z') }).where('id', '=', productId).execute();
    const before = (await products.findById(productId))!;
    const changes = await database.transaction().execute(tx => products.upsertFetchedProducts(tx, [{
      shopId, externalId: 'seed', name: 'Seed product', normalizedKey: 'new-display-key',
      url: 'https://seed.invalid/new-product', imageUrl: 'https://seed.invalid/new-image.png',
    }]));
    assert.deepEqual(changes.unchangedProducts, [productId]);
    assert.deepEqual(changes.changedProducts, []);
    const after = (await products.findById(productId))!;
    assert.equal(after.url, 'https://seed.invalid/new-product');
    assert.equal(after.image_url, 'https://seed.invalid/new-image.png');
    assert.equal(after.normalized_key, 'new-display-key');
    assert.ok(after.updated_at > before.updated_at);
    assert.equal(after.content_version, before.content_version);
    assert.equal(after.standardization_revision, before.standardization_revision);
    assert.equal((await database.selectFrom('standard_product_members').select('product_id').where('product_id', '=', productId).execute()).length, 1);
    assert.deepEqual((await products.listTags(productId)).map(({ name, value }) => ({ name, value })), [{ name: 'duration', value: 'monthly' }]);
    assert.equal((await database.selectFrom('product_change_events').select('id').where('product_id', '=', productId).execute()).length, 1);
  });

  test('tag edits assignments and withdrawals advance the same revision without changing source evidence', async () => {
    const { productId } = await seedProduct();
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    const products = testingModule.get(ProductsRepository);
    const standard = await seedVerifiedStandard();
    await products.assignStandardProduct(productId, standard.id);
    assert.equal((await products.findById(productId))!.standardization_revision, 1n);
    await products.replaceTags(productId, [{ name: 'duration', value: 'monthly' }]);
    assert.equal((await products.findById(productId))!.standardization_revision, 2n);
    await products.replaceTags(productId, []);
    assert.equal((await products.findById(productId))!.standardization_revision, 3n);
    await products.assignStandardProduct(productId, null);
    const current = await products.findById(productId);
    assert.equal(current!.standardization_revision, 4n);
    assert.equal(current!.content_version, 1n);
    assert.equal((await database.selectFrom('standard_product_members').select('product_id').where('product_id', '=', productId).execute()).length, 0);
    assert.equal((await database.selectFrom('product_change_events').select('id').where('product_id', '=', productId).execute()).length, 1);
  });

  test('deleted product evidence stays queued for review after restoration without reviving the product', async () => {
    const shops = testingModule.get(ShopsRepository);
    const products = testingModule.get(ProductsRepository);
    const shop = await shops.upsert({ platform: '16688', url: 'https://deleted.invalid', name: 'Deleted', enabled: true });
    const ids = await products.upsertBatch([{ shopId: shop.id, externalId: 'gone', name: 'Gone', normalizedKey: 'gone', url: 'https://deleted.invalid/gone' }]);
    const id = ids.get(productMapKey(shop.id, 'gone'))!;
    const original = (await products.findById(id))!;
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    await database.updateTable('standardization_outbox').set({ status: 'succeeded' }).where('product_id', '=', id).execute();
    await products.softDelete(id);
    await products.upsertBatch([{ shopId: shop.id, externalId: 'gone', name: 'Still gone', normalizedKey: 'still-gone', url: 'https://deleted.invalid/gone' }]);
    assert.equal(await products.findById(id), undefined);
    assert.equal((await database.selectFrom('product_change_events').select('id').where('product_id', '=', id).execute()).length, 2);
    assert.equal((await database.selectFrom('standardization_outbox').select('id').where('product_id', '=', id).execute()).length, 2);
    const standardization = testingModule.get(StandardizationRepository);
    assert.deepEqual(await standardization.claimOutbox('restored-product'), []);
    const deleted = await database.selectFrom('products').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    assert.ok(deleted.deleted_at);
    assert.equal(deleted.deletion_source, 'manual');
    assert.equal(deleted.content_version, original.content_version + 1n);
    assert.equal(deleted.standardization_revision, original.standardization_revision + 1n);
    const restored = await products.restore(id);
    assert.equal(restored!.content_version, deleted.content_version);
    assert.equal(restored!.standardization_revision, deleted.standardization_revision);
    const claims = await standardization.claimOutbox('restored-product');
    assert.equal(claims.length, 1);
    assert.equal(claims[0]!.product_id, id);
    assert.equal(claims[0]!.fingerprint, restored!.content_fingerprint);
  });

  test('batch soft deletion preserves distinct names and invalidates the catalog once', async () => {
    const { shopId, productId: untouchedId } = await seedProduct();
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    const products = testingModule.get(ProductsRepository);
    const inserted = await products.upsertBatch(Array.from({ length: 54 }, (_, index) => ({
      shopId, externalId: `batch-${index}`, name: `Batch ${index}`,
      normalizedKey: `batch-${index}`, url: `https://seed.invalid/batch-${index}`,
    })));
    const ids = [...inserted.values()];
    const alreadyDeleted = ids.pop()!;
    await products.softDelete(alreadyDeleted);
    await products.replaceTags(ids[0]!, [{ name: 'duration', value: 'monthly' }]);
    const readVersion = async () => (await database.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow()).version;
    const before = await readVersion();
    const deleted = await products.softDeleteBatch([...ids, ids[0]!, alreadyDeleted, 9223372036854775807n]);
    assert.deepEqual(new Set(deleted), new Set(ids));
    assert.equal(deleted.length, 53);
    assert.equal(await readVersion(), before + 1n);
    assert.ok(await products.findById(untouchedId));
    assert.equal(await products.findById(ids[0]!), undefined);
    assert.equal((await database.selectFrom('products').select('id').where('deleted_at', 'is not', null).execute()).length, 54);
    assert.deepEqual(await products.softDeleteBatch([...ids, alreadyDeleted]), []);
    assert.deepEqual(await products.softDeleteBatch([]), []);
    assert.equal(await readVersion(), before + 1n);
    const restored = await products.restore(ids[0]!);
    assert.equal(restored!.deleted_at, null);
    assert.deepEqual((await products.listTags(ids[0]!)).map(({ name, value }) => ({ name, value })), [{ name: 'duration', value: 'monthly' }]);
  });

  test('batch soft deletion rolls back if catalog invalidation fails', async () => {
    const { productId } = await seedProduct();
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    const products = testingModule.get(ProductsRepository);
    const version = await database.deleteFrom('catalog_cache_versions').where('id', '=', 1).returningAll().executeTakeFirstOrThrow();
    try {
      await assert.rejects(products.softDeleteBatch([productId]), /catalog cache version row is missing/);
      assert.ok(await products.findById(productId));
    } finally {
      await database.insertInto('catalog_cache_versions').values(version).execute();
    }
  });

  test('assignment validates live, missing and deleted products inside its transaction', async context => {
    const { productId } = await seedProduct('ChatGPT Plus transaction validation');
    const products = testingModule.get(ProductsRepository);
    const service = testingModule.get(ProductsService);
    const standard = await seedVerifiedStandard({ family: 'openai', product: 'chatgpt', tier: 'plus' });
    context.mock.method(products, 'findById', async () => assert.fail('assignment must not query before its validating transaction'));
    await service.assignStandardProduct(productId, standard.id);
    await service.assignStandardProduct(productId, null);
    await assert.rejects(service.assignStandardProduct(-1n, standard.id), { code: 'PRODUCT_NOT_FOUND' });
    await products.softDelete(productId);
    await assert.rejects(service.assignStandardProduct(productId, standard.id), { code: 'PRODUCT_NOT_FOUND' });
  });

  test('manual assignment rejects unverified or malformed standards without replacing the current publication', async () => {
    const { productId } = await seedProduct('ChatGPT Plus');
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    const products = testingModule.get(ProductsRepository);
    const identity = { family: 'openai', product: 'chatgpt', tier: 'plus' };
    const standard = await seedVerifiedStandard(identity);
    await products.assignStandardProduct(productId, standard.id);
    const before = await products.findById(productId);
    const membership = await database.selectFrom('standard_product_members').selectAll().where('product_id', '=', productId).execute();
    for (const changes of [
      { verification_state: 'provisional' as const },
      { verification_state: 'quarantined' as const },
      { canonical_family: null },
      { canonical_tier: 'unknown' },
      { canonical_tier: 'max_20x' },
      { standard_key: null },
      { standard_key: 'v3:incorrect' },
    ]) {
      await seedVerifiedStandard(identity);
      await database.updateTable('standard_products').set(changes).where('id', '=', standard.id).execute();
      await assert.rejects(products.assignStandardProduct(productId, standard.id), (error: unknown) => error instanceof DomainConflictError, JSON.stringify(changes));
      assert.equal((await products.findById(productId))!.standardization_revision, before!.standardization_revision);
      assert.deepEqual(await database.selectFrom('standard_product_members').selectAll().where('product_id', '=', productId).execute(), membership);
      await database.updateTable('standard_products').set({ standard_key: buildCanonicalStandardKey(identity) }).where('id', '=', standard.id).execute();
    }
  });

  test('manual assignment checks current brand plan and SMS evidence through the shared policy', async () => {
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    const products = testingModule.get(ProductsRepository);
    const standard = await seedVerifiedStandard({ family: 'openai', product: 'chatgpt', tier: 'plus' });
    for (const name of ['Claude Pro', 'ChatGPT Team', 'ChatGPT 接码服务', 'ChatGPT Pro']) {
      const { productId } = await seedProduct(name);
      await assert.rejects(products.assignStandardProduct(productId, standard.id), (error: unknown) => error instanceof DomainConflictError, name);
      assert.equal((await products.findById(productId))!.standardization_revision, 0n, name);
      assert.deepEqual(await database.selectFrom('standard_product_members').select('product_id').where('product_id', '=', productId).execute(), [], name);
    }
  });

  test('manual assignment and withdrawal preserve SKU tags and advance the product revision', async () => {
    const { productId } = await seedProduct('ChatGPT Plus 无需接码');
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    const products = testingModule.get(ProductsRepository);
    const standard = await seedVerifiedStandard({ family: 'openai', product: 'chatgpt', tier: 'plus' });
    await database.insertInto('product_tags').values({ product_id: productId, name: 'duration', value: 'monthly' }).execute();
    for (const [index, target] of [standard.id, null].entries()) {
      await products.assignStandardProduct(productId, target);
      assert.equal((await products.findById(productId))!.standardization_revision, BigInt(index + 1));
      assert.deepEqual((await products.listTags(productId)).map(({ name, value }) => ({ name, value })), [{ name: 'duration', value: 'monthly' }]);
      assert.equal((await database.selectFrom('standard_product_members').select('product_id').where('product_id', '=', productId).execute()).length, target === null ? 0 : 1);
    }
  });

  test('a product batch rolls back when any row violates a constraint', async () => {
    const products = testingModule.get(ProductsRepository);
    await assert.rejects(
      products.upsertBatch([
        {
          shopId: 999_999n,
          externalId: 'bad-1',
          name: 'Bad one',
          normalizedKey: 'bad-1',
          url: 'https://bad.invalid/1',
        },
        {
          shopId: 999_999n,
          externalId: 'bad-2',
          name: 'Bad two',
          normalizedKey: 'bad-2',
          url: 'https://bad.invalid/2',
        },
      ]),
    );

    const count = await testingModule
      .get<Kysely<DatabaseSchema>>(DATABASE)
      .selectFrom('products')
      .select(({ fn }) => fn.countAll<bigint>().as('count'))
      .executeTakeFirstOrThrow();
    assert.equal(count.count, 0n);
  });

  test('bulk refresh persists one queued fetch run per active shop', async () => {
    const service = testingModule.get(ShopsService, { strict: false });
    const first = await service.upsert({
      platform: '16688',
      url: 'https://refresh-1.invalid',
      name: 'One',
      enabled: true,
    });
    const second = await service.upsert({
      platform: '16688',
      url: 'https://refresh-2.invalid',
      name: 'Two',
      enabled: true,
    });

    const queued = await service.enqueueRefresh([first.id, second.id]);
    assert.equal(queued.length, 2);
    const rows = await testingModule
      .get<Kysely<DatabaseSchema>>(DATABASE)
      .selectFrom('fetch_runs')
      .select(['shop_id', 'status'])
      .orderBy('shop_id')
      .execute();
    assert.deepEqual(rows, [
      { shop_id: first.id, status: 'queued' },
      { shop_id: second.id, status: 'queued' },
    ]);
  });

  test('invalid controller DTO returns 400 without writing a shop', async () => {
    const app = await createApp();
    await app.init();
    try {
      const login = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { password: process.env.ADMIN_PASSWORD },
      });
      assert.equal(login.statusCode, 200, login.payload);
      const response = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: '/v1/admin/shops',
        headers: { cookie: login.headers['set-cookie']?.[0] },
        payload: { platform: '16688', url: 'not-a-url' },
      });
      assert.equal(response.statusCode, 400);
      const count = await testingModule
        .get<Kysely<DatabaseSchema>>(DATABASE)
        .selectFrom('shops')
        .select(({ fn }) => fn.countAll<bigint>().as('count'))
        .executeTakeFirstOrThrow();
      assert.equal(count.count, 0n);
      const { productId } = await seedProduct();
      for (const payload of [{ description: null }, { name: null }]) {
        const invalid = await app.getHttpAdapter().getInstance().inject({
          method: 'PATCH', url: `/v1/admin/products/${productId}`,
          headers: { cookie: login.headers['set-cookie']?.[0] }, payload,
        });
        assert.equal(invalid.statusCode, 400, invalid.payload);
      }
      const cleared = await app.getHttpAdapter().getInstance().inject({
        method: 'PATCH', url: `/v1/admin/products/${productId}`,
        headers: { cookie: login.headers['set-cookie']?.[0] }, payload: { description: '' },
      });
      assert.equal(cleared.statusCode, 200, cleared.payload);
      assert.equal(cleared.json().description, '');
    } finally {
      await app.close();
    }
  });

  async function seedVerifiedStandard(identity = { family: 'seed', product: 'seed', tier: 'base' }) {
    const values = { name: 'Verified standard', platform: identity.family, standard_key: buildCanonicalStandardKey(identity), canonical_family: identity.family, canonical_product: identity.product, canonical_tier: identity.tier, verification_state: 'verified' as const };
    return testingModule.get<Kysely<DatabaseSchema>>(DATABASE).insertInto('standard_products').values(values).onConflict(conflict => conflict.column('standard_key').where('standard_key', 'is not', null).doUpdateSet(values)).returning('id').executeTakeFirstOrThrow();
  }

  async function seedProduct(name = 'Seed product'): Promise<{ shopId: bigint; productId: bigint }> {
    const shops = testingModule.get(ShopsRepository);
    const products = testingModule.get(ProductsRepository);
    const shop = await shops.upsert({
      platform: '16688',
      url: `https://seed-${Date.now()}-${Math.random()}.invalid`,
      name: 'Seed',
      enabled: true,
    });
    const ids = await products.upsertBatch([
      {
        shopId: shop.id,
        externalId: 'seed',
        name,
        normalizedKey: 'seed-product',
        url: 'https://seed.invalid/product',
      },
    ]);
    return {
      shopId: shop.id,
      productId: ids.get(productMapKey(shop.id, 'seed'))!,
    };
  }
});

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import '../src/config/env.js';
import { createApp } from '../src/main.js';
import { AppModule } from '../src/app.module.js';
import { DatabaseModule } from '../src/database/database.module.js';
import { Test, type TestingModule } from '@nestjs/testing';
import { createPostgresPool, DATABASE, DatabaseService, PG_POOL } from '../src/database/database.providers.js';
import { jsonb, type DatabaseSchema, type PublicationState, type StandardVerificationState } from '../src/database/types.js';
import { migrateToLatest } from '../scripts/migrate.js';
import { ProtocolDetectionService } from '../src/platforms/protocol-detection.service.js';
import { ShopSubmissionsService } from '../src/shop-submissions/shop-submissions.service.js';
import { buildCanonicalStandardKey } from '../src/standardization/canonical-key.js';

const ADMIN_PASSWORD = `task7-admin-${Date.now()}`;

describe('admin lists over real PostgreSQL', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let adminPool: Pool;
  let migrationDatabase: Kysely<DatabaseSchema>;
  let testingModule: TestingModule;
  let app: Awaited<ReturnType<typeof createApp>>;
  let schemaName: string;
  let cookie = '';
  const ids: Record<string, bigint> = {};

  before(async () => {
    process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
    if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    else {
      container = await new PostgreSqlContainer('postgres:16-alpine').start();
      process.env.DATABASE_URL = container.getConnectionUri();
    }
    schemaName = `task7_admin_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
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
    process.env.AUTH_SESSION_KEY_PREFIX = `task7-admin-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}:`;

    const migrationPool = createPostgresPool();
    migrationDatabase = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: migrationPool }) });
    await migrateToLatest(migrationDatabase);
    testingModule = await Test.createTestingModule({ imports: [DatabaseModule] }).compile();
    app = await createApp();
    await app.init();
    const login = await app.getHttpAdapter().getInstance().inject({ method: 'POST', url: '/v1/auth/login', payload: { password: ADMIN_PASSWORD } });
    assert.equal(login.statusCode, 200);
    cookie = login.headers['set-cookie']?.[0] ?? '';
    assert.ok(cookie);
    await seed();
  });

  after(async () => {
    await app?.close();
    await testingModule?.close();
    await migrationDatabase?.destroy();
    if (adminPool && schemaName) {
      await adminPool.query(`drop schema if exists "${schemaName}" cascade`);
      await adminPool.end();
    }
    await container?.stop();
    delete process.env.PG_SCHEMA;
  });

  test('all admin list routes require authentication', async () => {
    for (const path of ['shops', 'products', 'standard-products', 'standard-products/platforms', 'tags', 'ai/jobs', 'run-history', 'shop-submissions/protocols']) {
      const response = await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: `/v1/admin/${path}` });
      assert.equal(response.statusCode, 401, path);
    }
  });

  test('public catalog product routes expose lightweight metadata without authentication or quotes', async () => {
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    const original = await database.selectFrom('standard_products').select('verification_state').where('id', '=', ids.standardBackup!).executeTakeFirstOrThrow();
    await database.updateTable('standard_products').set({ verification_state: 'verified' }).where('id', '=', ids.standardBackup!).execute();
    try {
      const server = app.getHttpAdapter().getInstance();
      const product = await server.inject('/v1/catalog/products/' + ids.standardBackup);
      assert.equal(product.statusCode, 200);
      assert.deepEqual(product.json(), { id: String(ids.standardBackup), name: 'Alpha Backup', platform: '16688', kind: '其他' });
      const list = await server.inject('/v1/catalog/products');
      assert.equal(list.statusCode, 200);
      assert.ok(list.json().items.some((item: { id: string }) => item.id === String(ids.standardBackup)));
      for (const id of ['999999', 'not-an-id', '9223372036854775808']) assert.equal((await server.inject('/v1/catalog/products/' + id)).statusCode, 404);
    } finally {
      await database.updateTable('standard_products').set(original).where('id', '=', ids.standardBackup!).execute();
    }
  });

  test('shops and products apply SQL-side filters and return explicit serializable camelCase DTOs', async () => {
    const shopQuery = new URLSearchParams({ status: 'active', keyword: 'Alpha', limit: '2' });
    const shops = await get(`shops?${shopQuery}`);
    assert.deepEqual(shops.items.map((item: { name: string }) => item.name), ['Alpha Shop']);
    assert.equal(shops.nextCursor, undefined);
    assert.deepEqual(Object.keys(shops.items[0]).sort(), ['enabled', 'id', 'lastError', 'lastFetchAt', 'name', 'platform', 'protocol', 'url']);
    assert.equal(shops.items[0].protocol, null);

    const productQuery = new URLSearchParams({ shopId: ids.shopAlpha!.toString(), keyword: 'Red', standardized: 'true', limit: '2' });
    const products = await get(`products?${productQuery}`);
    assert.equal(products.items.length, 1);
    assert.equal(products.items[0].name, 'Alpha Red');
    assert.equal(products.items[0].shopId, ids.shopAlpha!.toString());
    assert.equal(typeof products.items[0].sourceData, 'object');
    assert.deepEqual(Object.keys(products.items[0]).sort(), ['deletedAt', 'evidenceConflict', 'externalId', 'id', 'imageUrl', 'latestCurrency', 'latestPrice', 'name', 'normalizedKey', 'shopId', 'shopName', 'sourceCategory', 'sourceData', 'spec', 'standardProductName', 'standardizationOutcome', 'tags', 'updatedAt', 'url']);
    assert.equal(products.items[0].shopName, 'Alpha Shop');
    assert.equal(products.items[0].standardProductName, 'Alpha Standard');
    assert.deepEqual(products.items[0].tags, [{ name: 'brand', value: 'Acme' }, { name: 'color', value: 'Red' }]);
    assert.equal(products.items[0].latestPrice, '12.50');

    const pageOne = await get(`shops?${new URLSearchParams({ status: 'active', limit: '1', page: '1' })}`);
    const pageTwo = await get(`shops?${new URLSearchParams({ status: 'active', limit: '1', page: '2' })}`);
    assert.equal(pageOne.page, 1);
    assert.equal(pageTwo.page, 2);
    assert.equal(pageOne.pageSize, 1);
    assert.equal(pageOne.total, 1);
    assert.equal(pageTwo.items.length, 0);
  });

  test('standard products use database filtering and stable keyset cursors', async () => {
    const firstQuery = new URLSearchParams({ keyword: 'alpha', platform: '16688', limit: '1' });
    const first = await get(`standard-products?${firstQuery}`);
    assert.equal(first.items.length, 1);
    assert.deepEqual(first.items[0], { id: ids.standardAlpha!.toString(), name: 'Alpha Standard', platform: '16688', canonicalFamily: null, canonicalProduct: null, canonicalTier: null, aliases: [], sortOrder: '10', standardKey: 'alpha-key', hidden: false, mergedIntoId: null, memberCount: '1', shopCount: '1' });
    assert.ok(first.nextCursor);

    const second = await get(`standard-products?${new URLSearchParams({ ...Object.fromEntries(firstQuery), cursor: first.nextCursor! })}`);
    assert.equal(second.items.length, 1);
    assert.equal(second.items[0].name, 'Alpha Backup');
    assert.equal(second.nextCursor, undefined);

  });

  test('tags filter by product and tag identity in SQL', async () => {
    const query = new URLSearchParams({ productId: ids.productAlpha!.toString(), limit: '1' });
    const first = await get(`tags?${query}`);
    assert.deepEqual(first.items, [
      { id: ids.tagBrand!.toString(), productId: ids.productAlpha!.toString(), name: 'brand', value: 'Acme', productCount: '1', productIds: [ids.productAlpha!.toString()] },
    ]);
    assert.ok(first.nextCursor);

    const second = await get(`tags?${new URLSearchParams({ ...Object.fromEntries(query), cursor: first.nextCursor! })}`);
    assert.deepEqual(second.items, [
      { id: ids.tagColor!.toString(), productId: ids.productAlpha!.toString(), name: 'color', value: 'Red', productCount: '1', productIds: [ids.productAlpha!.toString()] },
    ]);
    assert.equal(second.nextCursor, undefined);
  });

  test('tag management pages use page numbers and tag member rows exclude deleted products', async () => {
    const tags = await get(`tags?${new URLSearchParams({ limit: '1', page: '1' })}`);
    assert.equal(tags.page, 1);
    assert.equal(tags.pageSize, 1);
    assert.equal(tags.total, 3);
    const members = await get(`tags/products?${new URLSearchParams({ name: 'color', value: 'Red', limit: '10', page: '1' })}`);
    assert.equal(members.items.length, 1);
    assert.equal(members.items[0].id, ids.productAlpha!.toString());
    assert.equal(members.items[0].name, 'Alpha Red');
    assert.equal(members.items[0].shopName, 'Alpha Shop');
  });

  test('AI jobs filter by status and shop while serializing every bigint', async () => {
    const query = new URLSearchParams({ status: 'succeeded', shopId: ids.shopAlpha!.toString(), limit: '10' });
    const jobs = await get(`ai/jobs?${query}`);
    assert.equal(jobs.items.length, 1);
    assert.equal(jobs.items[0].id, ids.jobSucceeded!.toString());
    assert.equal(jobs.items[0].total, '1');
    assert.equal(jobs.items[0].processed, '1');
    assert.equal(jobs.items[0].scopeShopId, ids.shopAlpha!.toString());
    assert.doesNotThrow(() => JSON.stringify(jobs));
    const fields = Object.keys(jobs.items[0]);
    assert.ok(fields.every((field) => !field.includes('_')));
  });

  test('run history returns shop names with filters and cursor pagination', async () => {
    const runs = await get(`run-history?${new URLSearchParams({ shopId: ids.shopAlpha!.toString(), status: 'succeeded', limit: '10' })}`);
    assert.equal(runs.items.length, 1);
    assert.equal(runs.items[0].id, ids.runSucceeded!.toString());
    assert.equal(runs.items[0].itemCount, '2');
    assert.equal(runs.items[0].shopName, 'Alpha Shop');

    const first = await get('run-history?limit=1');
    assert.equal(first.items[0].shopName, 'Alpha Shop');
    assert.ok(first.nextCursor);
    const second = await get(`run-history?${new URLSearchParams({ limit: '1', cursor: first.nextCursor })}`);
    assert.equal(second.items[0].shopId, ids.shopDeleted!.toString());
    assert.equal(second.items[0].shopName, 'Deleted Shop');
    assert.equal(second.nextCursor, undefined);
  });

  test('run history is newest first across pages even when IDs and sub-millisecond timestamps differ', async () => {
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    const shop = await database.insertInto('shops').values({
      name: 'History ordering', platform: 'history-test', url: 'https://history-order.example',
    }).returning('id').executeTakeFirstOrThrow();
    const runs = await database.insertInto('fetch_runs').values([
      { shop_id: shop.id, started_at: sql<Date>`${'2026-10-27T01:00:00.000002Z'}::timestamptz`, status: 'succeeded' },
      { shop_id: shop.id, started_at: sql<Date>`${'2026-10-27T01:00:00.000001Z'}::timestamptz`, status: 'succeeded' },
      { shop_id: shop.id, started_at: sql<Date>`${'2026-10-27T01:00:00.000002Z'}::timestamptz`, status: 'succeeded' },
    ]).returning('id').execute();
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ shopId: String(shop.id), limit: '1', ...(cursor ? { cursor } : {}) });
      const page = await get(`run-history?${query}`);
      seen.push(...page.items.map((item: { id: string }) => item.id));
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(seen, [runs[2]!.id, runs[0]!.id, runs[1]!.id].map(String));
  });

  test('run history numbered pages expose accurate filtered totals even past the last page', async () => {
    const query = new URLSearchParams({ shopId: String(ids.shopAlpha), status: 'succeeded', limit: '1' });
    const first = await get(`run-history?${query}&page=1`);
    assert.equal(first.total, 1);
    assert.equal(first.page, 1);
    assert.equal(first.pageSize, 1);
    assert.deepEqual(first.items.map((item: { id: string }) => item.id), [String(ids.runSucceeded)]);
    const empty = await get(`run-history?${query}&page=2`);
    assert.equal(empty.total, 1);
    assert.equal(empty.page, 2);
    assert.equal(empty.pageSize, 1);
    assert.deepEqual(empty.items, []);
  });

  test('bounded query DTOs reject invalid limits and IDs', async () => {
    const invalidLimit = await get(`tags?limit=101`, 400);
    assert.equal(invalidLimit.statusCode, 400);
    const invalidId = await get(`tags?productId=zero`, 400);
    assert.equal(invalidId.statusCode, 400);
    const invalidStatus = await get(`ai/jobs?status=unknown`, 400);
    assert.equal(invalidStatus.statusCode, 400);
  });

  test('platform rename and standard merge preserve revisions and invalidate catalog data', async () => {
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    const before = await database.selectFrom('products').select('standardization_revision').where('id', '=', ids.productAlpha!).executeTakeFirstOrThrow();
    const versionBefore = await database.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow();

    const collision = await mutate('PATCH', '/platforms/16688', { name: 'liandong' }, 400);
    assert.equal(collision.statusCode, 400);
    const renamed = await mutate('PATCH', '/platforms/16688', { name: 'marketx' });
    assert.equal(renamed.payload.name, 'marketx');
    const afterRename = await database.selectFrom('products').select('standardization_revision').where('id', '=', ids.productAlpha!).executeTakeFirstOrThrow();
    assert.equal(afterRename.standardization_revision, before.standardization_revision + 1n);
    assert.equal((await database.selectFrom('standard_products').select('platform').where('id', '=', ids.standardAlpha!).executeTakeFirstOrThrow()).platform, 'marketx');
    const versionAfterRename = await database.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow();
    assert.equal(versionAfterRename.version, versionBefore.version + 1n);

    const betaRevision = await database.selectFrom('products').select('standardization_revision').where('id', '=', ids.productBeta!).executeTakeFirstOrThrow();
    const merged = await mutate('POST', '/standard-products/merge', { sourceIds: [ids.standardBackup!.toString()], targetId: ids.standardAlpha!.toString() }, 201);
    assert.deepEqual(merged.payload.success, [ids.standardBackup!.toString()]);
    const mergedSource = await database.selectFrom('standard_products').select(['merged_into_id', 'hidden']).where('id', '=', ids.standardBackup!).executeTakeFirstOrThrow();
    assert.equal(mergedSource.merged_into_id, ids.standardAlpha);
    assert.equal(mergedSource.hidden, true);
    assert.equal((await database.selectFrom('products').select('standardization_revision').where('id', '=', ids.productBeta!).executeTakeFirstOrThrow()).standardization_revision, betaRevision.standardization_revision + 1n);
    assert.equal((await database.selectFrom('standard_product_members').select('standard_product_id').where('product_id', '=', ids.productBeta!).executeTakeFirstOrThrow()).standard_product_id, ids.standardAlpha);
    assert.equal((await database.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow()).version, versionAfterRename.version + 1n);
  });

  test('tag merge deduplicates relationships and advances affected product revisions', async () => {
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    const before = await database.selectFrom('products').select('standardization_revision').where('id', '=', ids.productAlpha!).executeTakeFirstOrThrow();
    const merged = await mutate('POST', '/tags/merge', { name: 'color', value: 'Red', nextName: 'brand', nextValue: 'Acme' }, 201);
    assert.deepEqual(merged.payload.skipped, [ids.productAlpha!.toString()]);
    assert.deepEqual(merged.payload.success, []);
    const tags = await database.selectFrom('product_tags').select(['name', 'value']).where('product_id', '=', ids.productAlpha!).orderBy('name').execute();
    assert.deepEqual(tags, [{ name: 'brand', value: 'Acme' }]);
    const after = await database.selectFrom('products').select('standardization_revision').where('id', '=', ids.productAlpha!).executeTakeFirstOrThrow();
    assert.equal(after.standardization_revision, before.standardization_revision + 1n);
  });

  test('pending selection validates existing ownership and batch binding reports conflicts and skips', async () => {
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    const pendingBeforeAiResult = await get('products?pending=true');
    assert.ok(pendingBeforeAiResult.items.some(item => item.id === ids.productAlpha!.toString()));
    assert.deepEqual(pendingBeforeAiResult.items.find(item => item.id === ids.productAlpha!.toString()).processingSummary, {
      reasonCode: 'manual_decision_preserved', processingDisposition: 'review_required',
      reason: '直接数据库人工修改；未提供审核证据快照',
    });
    const job = await database.insertInto('ai_jobs').values({ status: 'succeeded', total: 1n, processed: 1n, applied: 1n, model: 'test', scope_shop_id: ids.shopAlpha! }).returning('id').executeTakeFirstOrThrow();
    const product = await database.selectFrom('products').select(['content_version', 'content_fingerprint']).where('id', '=', ids.productBeta!).executeTakeFirstOrThrow();
    await database.insertInto('ai_job_inputs').values({ job_id: job.id, input_id: ids.productBeta!, fingerprint: product.content_fingerprint, payload: jsonb({}), status: 'succeeded', content_version: product.content_version }).execute();
    await database.insertInto('ai_job_input_members').values({ job_id: job.id, input_id: ids.productBeta!, product_id: ids.productBeta!, fingerprint: product.content_fingerprint, payload: jsonb({}), status: 'classified', content_version: product.content_version }).execute();
    await database.insertInto('ai_standardization_results').values({
      job_id: job.id, product_id: ids.productBeta!, input_id: ids.productBeta!, content_version: product.content_version,
      fingerprint: product.content_fingerprint, status: 'classified', standard_product_id: ids.standardBackup!,
      reason: 'integration fixture', decision: jsonb({ preserved: true }), tags: jsonb([{ name: 'ai', value: 'unchanged' }]), evidence: jsonb([]),
      reason_code: null, published_at: new Date(), batch_id: null,
    }).execute();
    const pending = await get('products?pending=true');
    assert.ok(pending.items.some(item => item.id === ids.productAlpha!.toString()));
    assert.ok(pending.items.some(item => item.id === ids.productBeta!.toString()), 'a classified result without a published assignment still requires processing');
    assert.ok(!pending.items.some(item => item.name === 'Deleted Product'));
    await database.updateTable('ai_standardization_results').set({ status: 'unclassified', standard_product_id: null, reason_code: 'llm_unclassified' }).where('product_id', '=', ids.productBeta!).where('content_version', '=', product.content_version).execute();
    const pendingAfterUnclassified = await get('products?pending=true');
    assert.ok(pendingAfterUnclassified.items.some(item => item.id === ids.productBeta!.toString()));
    await database.updateTable('ai_standardization_results').set({ status: 'classified', standard_product_id: ids.standardBackup, reason_code: null }).where('product_id', '=', ids.productBeta!).where('content_version', '=', product.content_version).execute();
    const recycled = await get('products?deleted=true');
    assert.deepEqual(recycled.items.map(item => item.name), ['Deleted Product']);

    await mutate('POST', '/standard-products', { name: 'Invalid', platform: 'marketx', productIds: [ids.productAlpha!.toString()] }, 400);
    const target = await database.insertInto('standard_products').values({ name: 'Manual Target', platform: 'marketx', standard_key: null }).returning('id').executeTakeFirstOrThrow();
    const revisionBefore = await database.selectFrom('products').select('standardization_revision').where('id', '=', ids.productBeta!).executeTakeFirstOrThrow();
    const versionBefore = await database.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow();
    const binding = await mutate('POST', '/products/standard-products/bind', {
      productIds: [ids.productAlpha!.toString(), ids.productBeta!.toString(), '999999'],
      standardProductId: target.id.toString(),
      confirmOwnershipChange: false,
    }, 201);
    assert.deepEqual(binding.payload.success, []);
    assert.deepEqual(binding.payload.conflicts.map((item: { id: string }) => item.id), [ids.productAlpha!.toString(), ids.productBeta!.toString(), '999999']);
    assert.equal((await database.selectFrom('products').select('standardization_revision').where('id', '=', ids.productBeta!).executeTakeFirstOrThrow()).standardization_revision, revisionBefore.standardization_revision);
    assert.equal((await database.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow()).version, versionBefore.version);

    const confirmed = await mutate('POST', '/products/standard-products/bind', {
      productIds: [ids.productBeta!.toString()], standardProductId: target.id.toString(), confirmOwnershipChange: true,
    }, 201);
    assert.deepEqual(confirmed.payload.success, [ids.productBeta!.toString()]);
    assert.ok((await get('products?pending=true')).items.some(item => item.id === ids.productBeta!.toString()), 'an unverified manual target still requires publication');
    await database.updateTable('standard_products').set({ verification_state: 'verified' }).where('id', '=', target.id).execute();
    assert.ok(!(await get('products?pending=true')).items.some(item => item.id === ids.productBeta!.toString()));
    const resultAfterBinding = await database.selectFrom('ai_standardization_results').select(['standard_product_id', 'tags', 'decision']).where('product_id', '=', ids.productBeta!).executeTakeFirstOrThrow();
    assert.deepEqual(resultAfterBinding.tags, [{ name: 'ai', value: 'unchanged' }]);
    assert.deepEqual(resultAfterBinding.decision, { preserved: true });
    assert.equal(resultAfterBinding.standard_product_id, ids.standardBackup);
    assert.equal((await database.selectFrom('products').select('standardization_revision').where('id', '=', ids.productBeta!).executeTakeFirstOrThrow()).standardization_revision, revisionBefore.standardization_revision + 1n);
    const repeated = await mutate('POST', '/products/standard-products/bind', {
      productIds: [ids.productBeta!.toString()], standardProductId: target.id.toString(), confirmOwnershipChange: false,
    }, 201);
    assert.deepEqual(repeated.payload.skipped, [ids.productBeta!.toString()]);
  });

  test('platform paging and disabled platform selection retain existing products', async () => {
    const pageOne = await get('platforms?limit=1&page=1');
    const pageTwo = await get('platforms?limit=1&page=2');
    assert.equal(pageOne.total, 2);
    assert.equal(pageOne.items.length, 1);
    assert.equal(pageTwo.items.length, 1);
    assert.notEqual(pageOne.items[0].name, pageTwo.items[0].name);

    await mutate('DELETE', '/platforms/marketx', undefined, 200);
    const standards = await get('standard-products?platform=marketx');
    assert.ok(standards.items.length > 0);
    await mutate('PATCH', `/standard-products/${ids.standardAlpha!.toString()}`, { name: 'Renamed Standard', platform: 'marketx' });
    await mutate('POST', '/standard-products', { name: 'New Standard', platform: 'marketx', productIds: ['999999'] }, 400);
  });

  test('alias API validates and normalizes hints without changing product identity', async () => {
    const id = ids.standardAlpha!.toString();
    const unchanged = await mutate('PATCH', '/standard-products/' + id, {});
    assert.equal(unchanged.payload.id, id);
    const updated = await mutate('PATCH', '/standard-products/' + id, { aliases: ['  小众名称 ', '小众 名称', 'Alternate'] });
    assert.deepEqual(updated.payload.aliases, ['小众名称', 'Alternate']);
    for (const aliases of ['invalid', [42], ['x'.repeat(81)], Array(21).fill('alias')]) {
      await mutate('PATCH', '/standard-products/' + id, { aliases }, 400);
    }
    assert.deepEqual((await get('standard-products?keyword=Renamed')).items.find(item => item.id === id)?.aliases, ['小众名称', 'Alternate']);
    const cleared = await mutate('PATCH', '/standard-products/' + id, { aliases: [] });
    assert.deepEqual(cleared.payload.aliases, []);
  });

  test('edits canonical family, product and tier and persists the reviewed identity', async () => {
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    const candidate = await database.insertInto('products').values({ shop_id: ids.shopAlpha!, external_id: 'identity-edit', name: 'Identity Edit', normalized_key: 'identity-edit', url: 'https://alpha.invalid/identity-edit', source_data: jsonb({}) }).returning('id').executeTakeFirstOrThrow();
    const created = await mutate('POST', '/standard-products', { family: 'edit-vendor', product: 'edit-service', tier: 'standard', platform: 'liandong', productIds: [candidate.id.toString()] }, 201);
    const identity = { canonicalFamily: 'edit-vendor', canonicalProduct: 'edit-service', canonicalTier: 'standard' };
    const before = await database.selectFrom('product_standardization_decisions').select('id').where('product_id', '=', candidate.id).execute();
    const unchanged = await mutate('PATCH', '/standard-products/' + created.payload.id, identity);
    assert.equal(unchanged.payload.name, created.payload.name);
    assert.deepEqual(await database.selectFrom('product_standardization_decisions').select('id').where('product_id', '=', candidate.id).execute(), before);
    for (const [field, value] of [['canonicalFamily', 'edited-vendor'], ['canonicalProduct', 'edited-service'], ['canonicalTier', 'premium']] as const) {
      identity[field] = value;
      const updated = await mutate('PATCH', `/standard-products/${created.payload.id}`, { ...identity, platform: 'liandong' });
      assert.equal(updated.payload[field], value);
      const stored = await database.selectFrom('standard_products').selectAll().where('id', '=', BigInt(created.payload.id)).executeTakeFirstOrThrow();
      assert.equal(stored.canonical_family, identity.canonicalFamily);
      assert.equal(stored.canonical_product, identity.canonicalProduct);
      assert.equal(stored.canonical_tier, identity.canonicalTier);
      const decision = await database.selectFrom('product_standardization_decisions').selectAll().where('product_id', '=', candidate.id).orderBy('id', 'desc').executeTakeFirstOrThrow();
      assert.equal(decision.action, 'identity_update');
      assert.equal(decision.target_snapshot?.family, identity.canonicalFamily);
      assert.equal(decision.target_snapshot?.product, identity.canonicalProduct);
      assert.equal(decision.target_snapshot?.tier, identity.canonicalTier);
    }
  });

  test('updates a standard product by ID without renaming peers and still rejects duplicate identities', async () => {
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    await database.insertInto('product_platforms').values({ name: 'openai', enabled: true }).onConflict(oc => oc.column('name').doNothing()).execute();
    const identities = [
      { family: 'codex', product: 'codex_credits', tier: 'standard', hidden: false },
      { family: 'codex', product: 'tutorial_video', tier: 'standard', hidden: true },
      { family: 'separate_vendor', product: 'codex_credits', tier: 'standard', hidden: false },
      { family: 'openai', product: 'tutorial_video', tier: 'standard', hidden: true },
    ];
    const standards = await database.insertInto('standard_products').values(identities.map(identity => ({
      name: `${identity.family} / ${identity.product} / ${identity.tier}`, platform: 'liandong',
      canonical_family: identity.family, canonical_product: identity.product, canonical_tier: identity.tier,
      standard_key: buildCanonicalStandardKey(identity), hidden: identity.hidden,
    }))).returning('id').execute();
    const targetId = standards[0]!.id;
    const standardIds = standards.map(row => row.id);
    const products = await database.insertInto('products').values(standards.map(standard => ({
      shop_id: ids.shopAlpha!, external_id: `scoped-edit-${standard.id}`, name: `Scoped Edit ${standard.id}`,
      normalized_key: `scoped-edit-${standard.id}`, url: `https://alpha.invalid/scoped-edit-${standard.id}`,
    }))).returning('id').execute();
    await database.insertInto('standard_product_members').values(products.map((product, index) => ({
      product_id: product.id, standard_product_id: standards[index]!.id, assignment_source: 'human' as const,
    }))).execute();
    const beforeStandards = await database.selectFrom('standard_products').selectAll().where('id', 'in', standardIds).orderBy('id').execute();
    const peerProductIds = products.slice(1).map(row => row.id);
    const beforePeers = await database.selectFrom('products').selectAll().where('id', 'in', peerProductIds).orderBy('id').execute();
    const beforeDecisions = await database.selectFrom('product_standardization_decisions').selectAll().where('product_id', 'in', peerProductIds).orderBy('id').execute();
    const body = { canonicalFamily: 'openai', canonicalProduct: 'codex_credits1', canonicalTier: 'standard1' };
    const updated = await mutate('PATCH', `/standard-products/${targetId}`, { ...body, platform: 'openai' });
    assert.equal(updated.payload.id, targetId.toString());
    assert.equal(updated.payload.name, 'openai / codex_credits1 / standard1');
    assert.equal(updated.payload.platform, 'openai');
    for (const [key, value] of Object.entries(body)) assert.equal(updated.payload[key], value);
    const saved = await database.selectFrom('standard_products').selectAll().where('id', 'in', standardIds).orderBy('id').execute();
    assert.equal(saved.find(row => row.id === targetId)!.name, 'openai / codex_credits1 / standard1');
    assert.deepEqual(saved.filter(row => row.id !== targetId), beforeStandards.filter(row => row.id !== targetId));
    assert.deepEqual(await database.selectFrom('products').selectAll().where('id', 'in', peerProductIds).orderBy('id').execute(), beforePeers);
    assert.deepEqual(await database.selectFrom('product_standardization_decisions').selectAll().where('product_id', 'in', peerProductIds).orderBy('id').execute(), beforeDecisions);
    await mutate('PATCH', `/standard-products/${targetId}`, body);
    const conflict = await mutate('PATCH', `/standard-products/${targetId}`, {
      canonicalFamily: ' OpenAI ', canonicalProduct: ' tutorial_video ', canonicalTier: ' STANDARD ',
    }, 400);
    assert.equal(conflict.payload.error.code, 'STANDARD_PRODUCT_KEY_CONFLICT');
    assert.deepEqual(await database.selectFrom('standard_products').selectAll().where('id', 'in', standardIds).orderBy('id').execute(), saved);
  });

  test('normalizes guide aliases without recording a redundant identity update', async () => {
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    await database.insertInto('product_platforms').values({ name: 'openai', enabled: true }).onConflict(oc => oc.column('name').doUpdateSet({ enabled: true })).execute();
    const candidate = await database.insertInto('products').values({ shop_id: ids.shopAlpha!, external_id: 'manual-guide', name: 'ChatGPT 使用教程', normalized_key: 'manual-guide', url: 'https://alpha.invalid/manual-guide', source_data: jsonb({}) }).returning('id').executeTakeFirstOrThrow();
    const created = await mutate('POST', '/standard-products', { family: 'openai', product: 'chatgpt_guide', tier: 'standard', platform: 'openai', productIds: [candidate.id.toString()] }, 201);
    const body = { platform: 'openai', canonicalFamily: 'openai', canonicalProduct: 'chatgpt', canonicalTier: 'guide' };
    const updated = await mutate('PATCH', `/standard-products/${created.payload.id}`, body);
    assert.equal(updated.payload.name, 'ChatGPT 教程');
    for (const [key, value] of Object.entries({ ...body, canonicalTier: 'tutorial' })) assert.equal(updated.payload[key], value);
    const stored = await database.selectFrom('standard_products').selectAll().where('id', '=', BigInt(created.payload.id)).executeTakeFirstOrThrow();
    assert.equal(stored.canonical_product, 'chatgpt');
    assert.equal(stored.canonical_tier, 'tutorial');
    assert.equal(stored.standard_key, updated.payload.standardKey);
    const decision = await database.selectFrom('product_standardization_decisions').selectAll().where('product_id', '=', candidate.id).orderBy('id', 'desc').executeTakeFirstOrThrow();
    assert.equal(decision.action, 'assign');
    assert.equal(decision.target_snapshot?.tier, 'tutorial');
    const member = await database.selectFrom('standard_product_members').select('standard_product_id').where('product_id', '=', candidate.id).executeTakeFirstOrThrow();
    assert.equal(member.standard_product_id, stored.id);
    for (const tier of ['', 'unknown', 'n/a', '不适用', 'not-applicable', 'not / applicable', 'n_a', 'n-a']) {
      await mutate('PATCH', `/standard-products/${created.payload.id}`, { ...body, canonicalTier: tier }, 400);
    }
    assert.equal((await database.selectFrom('standard_products').select('canonical_tier').where('id', '=', stored.id).executeTakeFirstOrThrow()).canonical_tier, 'tutorial');
    const duplicate = await mutate('POST', '/standard-products', { family: 'openai', product: 'chatgpt', tier: 'guide', platform: 'openai', productIds: [candidate.id.toString()] }, 400);
    assert.equal(duplicate.payload.error.code, 'STANDARD_PRODUCT_KEY_CONFLICT');
  });

  test('normalizes a manually reviewed course to the tutorial tier', async () => {
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    const candidate = await database.insertInto('products').values({ shop_id: ids.shopAlpha!, external_id: 'manual-course', name: 'Claude 使用课程', normalized_key: 'manual-course', url: 'https://alpha.invalid/manual-course', source_data: jsonb({}) }).returning('id').executeTakeFirstOrThrow();
    const created = await mutate('POST', '/standard-products', { family: 'anthropic', product: 'claude', tier: 'course', platform: 'liandong', productIds: [candidate.id.toString()] }, 201);
    assert.equal(created.payload.canonicalFamily, 'anthropic');
    assert.equal(created.payload.canonicalProduct, 'claude');
    assert.equal(created.payload.canonicalTier, 'tutorial');
    const member = await database.selectFrom('standard_product_members').select('standard_product_id').where('product_id', '=', candidate.id).executeTakeFirstOrThrow();
    assert.equal(member.standard_product_id.toString(), created.payload.id);
  });

  test('creates a standard product with canonical identity and a pending member', async () => {
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    const candidate = await database.insertInto('products').values({ shop_id: ids.shopAlpha!, external_id: 'pending-create', name: 'Pending Create', normalized_key: 'pending-create', url: 'https://alpha.invalid/pending-create', source_data: jsonb({}) }).returning('id').executeTakeFirstOrThrow();
    const body = { family: 'OpenAI', product: 'ChatGPT', tier: 'Plus', platform: 'liandong', productIds: [candidate.id.toString()] };
    const created = await mutate('POST', '/standard-products', body, 201);
    assert.equal(created.payload.name, 'ChatGPT Plus');
    assert.equal(created.payload.canonicalFamily, 'openai');
    assert.equal(created.payload.canonicalProduct, 'chatgpt');
    assert.equal(created.payload.canonicalTier, 'plus');
    assert.match(created.payload.standardKey, /^v3:/);
    const member = await database.selectFrom('standard_product_members').select('standard_product_id').where('product_id', '=', candidate.id).executeTakeFirstOrThrow();
    assert.equal(member.standard_product_id.toString(), created.payload.id);
    await mutate('POST', '/standard-products', { ...body, productIds: ['999999'] }, 400);
  });

  test('known identity writes use friendly names and unchanged identity preserves a manual name', async () => {
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    const candidate = await database.insertInto('products').values({ shop_id: ids.shopAlpha!, external_id: 'friendly-name', name: 'ChatGPT 普通账号', normalized_key: 'friendly-name', url: 'https://alpha.invalid/friendly-name' }).returning('id').executeTakeFirstOrThrow();
    const created = await mutate('POST', '/standard-products', { family: 'openai', product: 'chatgpt', tier: 'free', platform: 'liandong', productIds: [candidate.id.toString()] }, 201);
    assert.equal(created.payload.name, 'ChatGPT 普通账号');
    await mutate('PATCH', '/standard-products/' + created.payload.id, { name: '人工编辑的普通账号' });
    const unchanged = await mutate('PATCH', '/standard-products/' + created.payload.id, { canonicalFamily: 'OpenAI', canonicalProduct: 'ChatGPT', canonicalTier: 'Free' });
    assert.equal(unchanged.payload.name, '人工编辑的普通账号');
    const changed = await mutate('PATCH', '/standard-products/' + created.payload.id, { canonicalFamily: 'anthropic', canonicalProduct: 'claude', canonicalTier: 'max_20x' });
    assert.equal(changed.payload.name, 'Claude Max 20x');
  });

  for (const source of ['human', 'ai', 'unassigned'] as const) {
    test(`creates a standard product from ${source} products with AI history and preserves that history`, async () => {
      const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
      const candidate = await database.insertInto('products').values({
        shop_id: ids.shopAlpha!, external_id: `create-from-${source}`, name: `Create From ${source}`,
        normalized_key: `create-from-${source}`, url: `https://alpha.invalid/create-from-${source}`, source_data: jsonb({}), content_fingerprint: `create-from-${source}`,
      }).returning(['id', 'content_version', 'content_fingerprint', 'standardization_revision']).executeTakeFirstOrThrow();
      const previous = await database.insertInto('standard_products').values({ name: `Previous ${source}` }).returning('id').executeTakeFirstOrThrow();
      if (source !== 'unassigned') {
        await database.insertInto('standard_product_members').values({
          standard_product_id: previous.id, product_id: candidate.id, assignment_source: source,
        }).execute();
      }
      await database.insertInto('ai_job_inputs').values({
        job_id: ids.jobSucceeded!, input_id: candidate.id, fingerprint: candidate.content_fingerprint,
        payload: jsonb({}), status: 'succeeded', content_version: candidate.content_version,
      }).execute();
      await database.insertInto('ai_job_input_members').values({
        job_id: ids.jobSucceeded!, input_id: candidate.id, product_id: candidate.id, fingerprint: candidate.content_fingerprint,
        payload: jsonb({}), status: 'classified', content_version: candidate.content_version,
      }).execute();
      await database.insertInto('ai_standardization_results').values({
        job_id: ids.jobSucceeded!, input_id: candidate.id, product_id: candidate.id, content_version: candidate.content_version,
        fingerprint: candidate.content_fingerprint, status: 'classified', standard_product_id: previous.id,
        reason: 'historical AI decision', decision: jsonb({ preserved: true }), tags: jsonb([{ name: 'plan', value: 'old' }]),
        evidence: jsonb([]), reason_code: null, published_at: new Date(), batch_id: null,
      }).execute();
      const historyBefore = await database.selectFrom('ai_standardization_results').selectAll().where('product_id', '=', candidate.id).execute();
      const revisionBeforeCreate = await database.selectFrom('products').select('standardization_revision').where('id', '=', candidate.id).executeTakeFirstOrThrow();
      const versionBefore = await database.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow();
      const created = await mutate('POST', '/standard-products', {
        family: 'manual', product: `create-from-${source}`, tier: 'standard', platform: 'liandong',
        productIds: [candidate.id.toString(), candidate.id.toString()],
      }, 201);
      assert.equal(created.payload.memberCount, '1');
      const memberships = await database.selectFrom('standard_product_members').select(['standard_product_id', 'assignment_source', 'publication_state']).where('product_id', '=', candidate.id).execute();
      assert.deepEqual(memberships, [{ standard_product_id: BigInt(created.payload.id), assignment_source: 'human', publication_state: 'published' }]);
      assert.deepEqual(await database.selectFrom('ai_standardization_results').selectAll().where('product_id', '=', candidate.id).execute(), historyBefore);
      const updated = await database.selectFrom('products').select(['standardization_revision', 'content_version']).where('id', '=', candidate.id).executeTakeFirstOrThrow();
      assert.equal(updated.standardization_revision, revisionBeforeCreate.standardization_revision + 1n);
      assert.equal(updated.content_version, candidate.content_version);
      assert.ok((await database.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow()).version > versionBefore.version);
    });
  }

  test('invalid members leave existing ownership and the new standard unchanged', async () => {
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    const candidate = await database.insertInto('products').values({
      shop_id: ids.shopAlpha!, external_id: 'create-rollback', name: 'Create Rollback',
      normalized_key: 'create-rollback', url: 'https://alpha.invalid/create-rollback', source_data: jsonb({}),
    }).returning(['id', 'standardization_revision']).executeTakeFirstOrThrow();
    const previous = await database.insertInto('standard_products').values({ name: 'Rollback Previous' }).returning('id').executeTakeFirstOrThrow();
    await database.insertInto('standard_product_members').values({
      standard_product_id: previous.id, product_id: candidate.id, assignment_source: 'human',
    }).execute();
    const revisionBeforeInvalidCreate = await database.selectFrom('products').select('standardization_revision').where('id', '=', candidate.id).executeTakeFirstOrThrow();
    const deleted = await database.insertInto('products').values({
      shop_id: ids.shopAlpha!, external_id: 'create-deleted', name: 'Create Deleted',
      normalized_key: 'create-deleted', url: 'https://alpha.invalid/create-deleted', source_data: jsonb({}), deleted_at: new Date(),
    }).returning('id').executeTakeFirstOrThrow();
    const versionBefore = await database.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow();
    for (const invalidId of [deleted.id.toString(), '999999']) {
      const response = await mutate('POST', '/standard-products', {
        family: 'manual', product: 'create-rollback', tier: 'standard', platform: 'liandong',
        productIds: [candidate.id.toString(), invalidId],
      }, 400);
      assert.equal(response.payload.error.code, 'PRODUCT_STATE_CHANGED');
    }
    assert.equal((await database.selectFrom('standard_product_members').select('standard_product_id').where('product_id', '=', candidate.id).executeTakeFirstOrThrow()).standard_product_id, previous.id);
    assert.equal((await database.selectFrom('products').select('standardization_revision').where('id', '=', candidate.id).executeTakeFirstOrThrow()).standardization_revision, revisionBeforeInvalidCreate.standardization_revision);
    assert.equal((await database.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow()).version, versionBefore.version);
    assert.equal(await database.selectFrom('standard_products').select('id').where('canonical_product', '=', 'create-rollback').executeTakeFirst(), undefined);
  });

  test('pending products exclude effective human and AI ownership while retaining invalid assignments', async () => {
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    const cases: Array<{
      name: string; source: 'human' | 'ai'; publication: PublicationState; verification: StandardVerificationState;
      hidden?: boolean; merged?: boolean; pending: boolean;
    }> = [
      { name: 'human', source: 'human', publication: 'published', verification: 'verified', pending: false },
      { name: 'ai', source: 'ai', publication: 'published', verification: 'verified', pending: false },
      { name: 'hidden', source: 'human', publication: 'published', verification: 'verified', hidden: true, pending: false },
      { name: 'unpublished', source: 'ai', publication: 'provisional', verification: 'verified', pending: true },
      { name: 'quarantined-member', source: 'ai', publication: 'quarantined', verification: 'verified', pending: true },
      { name: 'unverified', source: 'human', publication: 'published', verification: 'provisional', pending: true },
      { name: 'quarantined-standard', source: 'human', publication: 'published', verification: 'quarantined', pending: true },
      { name: 'merged', source: 'human', publication: 'published', verification: 'verified', merged: true, pending: true },
    ];
    const pendingIds: string[] = [];
    for (const scenario of cases) {
      const product = await database.insertInto('products').values({
        shop_id: ids.shopAlpha!, external_id: `pending-membership-${scenario.name}`,
        name: `pending-membership-${scenario.name}`, normalized_key: `pending-membership-${scenario.name}`,
        url: `https://alpha.invalid/pending-membership-${scenario.name}`, source_data: jsonb({}),
      }).returning('id').executeTakeFirstOrThrow();
      const standard = await database.insertInto('standard_products').values({
        name: `Pending Membership ${scenario.name}`, verification_state: scenario.verification, hidden: scenario.hidden ?? false,
      }).returning('id').executeTakeFirstOrThrow();
      if (scenario.source === 'human') {
        const bound = await mutate('POST', '/products/standard-products/bind', {
          productIds: [product.id.toString()], standardProductId: standard.id.toString(), confirmOwnershipChange: false,
        }, 201);
        assert.deepEqual(bound.payload.success, [product.id.toString()]);
      } else {
        await database.insertInto('standard_product_members').values({
          product_id: product.id, standard_product_id: standard.id, assignment_source: 'ai', publication_state: scenario.publication,
        }).execute();
      }
      if (scenario.merged) {
        await database.updateTable('standard_products').set({ merged_into_id: ids.standardAlpha! }).where('id', '=', standard.id).execute();
      }
      // Current ownership remains effective even when older AI history is absent or the content version changes.
      await database.updateTable('products').set({ content_version: 2n }).where('id', '=', product.id).execute();
      if (scenario.pending) pendingIds.push(product.id.toString());
    }
    const pending = await get('products?pending=true&keyword=pending-membership&limit=100&page=1');
    assert.deepEqual(pending.items.map(item => item.id), pendingIds);
    assert.equal(pending.payload.total, 5);
    assert.equal((await get('products?keyword=pending-membership&limit=100')).items.length, 8);
  });

  test('pending products return after an effective manual assignment is removed', async () => {
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    const product = await database.insertInto('products').values({
      shop_id: ids.shopAlpha!, external_id: 'pending-unbind', name: 'Pending Unbind',
      normalized_key: 'pending-unbind', url: 'https://alpha.invalid/pending-unbind', source_data: jsonb({}),
    }).returning('id').executeTakeFirstOrThrow();
    const standard = await database.insertInto('standard_products').values({ name: 'Pending Unbind', verification_state: 'verified' }).returning('id').executeTakeFirstOrThrow();
    const query = 'products?pending=true&keyword=pending-unbind&limit=10&page=1';
    assert.deepEqual((await get(query)).items.map(item => item.id), [product.id.toString()]);
    await mutate('POST', '/products/standard-products/bind', {
      productIds: [product.id.toString()], standardProductId: standard.id.toString(), confirmOwnershipChange: false,
    }, 201);
    assert.deepEqual((await get(query)).items, []);
    await database.deleteFrom('standard_product_members').where('product_id', '=', product.id).execute();
    assert.deepEqual((await get(query)).items.map(item => item.id), [product.id.toString()]);
  });

  test('protocol review HTTP routes validate input and support automatic approval without a body', async () => {
    const protocols = await get('shop-submissions/protocols');
    assert.ok(protocols.items.some(item => item.id === 'public-products-v1'));
    const submission = await app.get(ShopSubmissionsService).create({ name: 'Protocol HTTP Shop', url: 'https://protocol-http.example/' });
    const path = `shop-submissions/${submission.id}`;
    const unauthorized = await app.getHttpAdapter().getInstance().inject({ method: 'POST', url: `/v1/admin/${path}/detect` });
    assert.equal(unauthorized.statusCode, 401);
    await mutate('POST', `${path}/detect`, { protocol: 123 }, 400);
    await mutate('POST', `${path}/approve`, { protocol: 'public-products-v1', unexpected: true }, 400);
    const detector = app.get(ProtocolDetectionService);
    const originalDetect = detector.detect;
    const selections: Array<string | undefined> = [];
    detector.detect = async (_url, protocol) => {
      selections.push(protocol);
      return { status: 'matched', protocol: 'public-products-v1', products: [], candidates: [], attempts: [] };
    };
    try {
      const detected = await mutate('POST', `${path}/detect`, undefined, 201);
      assert.equal(detected.payload.protocol, 'public-products-v1');
      const approved = await mutate('POST', `${path}/approve`, undefined, 201);
      assert.equal(approved.payload.status, 'approved');
      const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
      const shop = await database.selectFrom('shops').select('protocol').where('id', '=', BigInt(approved.payload.shopId)).executeTakeFirstOrThrow();
      assert.equal(shop.protocol, 'public-products-v1');
      assert.deepEqual(selections, [undefined, undefined]);
      await mutate('POST', `${path}/approve`, {}, 409);
    } finally { detector.detect = originalDetect; }
  });

  async function get(path: string, expectedStatus = 200): Promise<{ statusCode: number; payload: any; items: any[]; nextCursor?: string }> {
    const response = await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: `/v1/admin/${path}`, headers: { cookie } });
    assert.equal(response.statusCode, expectedStatus, `${path}: ${response.payload}`);
    const payload = response.payload ? JSON.parse(response.payload) : undefined;
    return { statusCode: response.statusCode, payload, ...payload };
  }

  async function mutate(method: 'POST' | 'PATCH' | 'DELETE', path: string, payload?: unknown, expectedStatus = 200): Promise<{ statusCode: number; payload: any }> {
    const response = await app.getHttpAdapter().getInstance().inject({
      method,
      url: `/v1/admin/${path.replace(/^\//, '')}`,
      headers: { cookie },
      ...(payload === undefined ? {} : { payload }),
    });
    assert.equal(response.statusCode, expectedStatus, `${path}: ${response.payload}`);
    return { statusCode: response.statusCode, payload: response.payload ? JSON.parse(response.payload) : undefined };
  }

  test('batch standard visibility deduplicates, preserves members and filters archived records', async () => {
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    const standards = await database.insertInto('standard_products').values([
      { name: 'Batch Cleanup Active' }, { name: 'Batch Cleanup Hidden', hidden: true },
      { name: 'Batch Cleanup Merged', hidden: true, merged_into_id: ids.standardAlpha! },
    ]).returning(['id']).execute();
    const [active, hidden, merged] = standards.map(row => row.id.toString());
    const member = await database.insertInto('products').values({ shop_id: ids.shopAlpha!, external_id: 'batch-cleanup', name: 'Batch cleanup member', normalized_key: 'batch-cleanup', url: 'https://alpha.invalid/cleanup' }).returning('id').executeTakeFirstOrThrow();
    await database.insertInto('standard_product_members').values({ standard_product_id: BigInt(active!), product_id: member.id }).execute();
    const versionBefore = await database.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow();
    const result = await mutate('POST', '/standard-products/batch-visibility', { ids: [active, active, hidden, merged, '999999999'], hidden: true }, 201);
    assert.deepEqual(result.payload, { success: [active], skipped: [hidden], conflicts: [
      { id: merged, reason: '标准商品已合并，不能修改展示状态' }, { id: '999999999', reason: '标准商品不存在' },
    ] });
    assert.equal((await database.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow()).version, versionBefore.version + 1n);
    assert.equal((await get('standard-products?keyword=Batch%20Cleanup&status=active&page=1')).total, 0);
    assert.equal((await get('standard-products?keyword=Batch%20Cleanup&status=hidden&page=1')).total, 2);
    assert.equal((await get('standard-products?keyword=Batch%20Cleanup&status=merged&page=1')).total, 1);
    assert.equal((await get('standard-products?keyword=Batch%20Cleanup&status=all&page=1')).total, 3);
    assert.equal((await database.selectFrom('standard_product_members').select('standard_product_id').where('product_id', '=', member.id).executeTakeFirstOrThrow()).standard_product_id, BigInt(active!));
    assert.equal((await database.selectFrom('products').select('deleted_at').where('id', '=', member.id).executeTakeFirstOrThrow()).deleted_at, null);
    await mutate('POST', '/standard-products/batch-visibility', { ids: [active, hidden], hidden: false }, 201);
    const page = await get('standard-products?keyword=Batch%20Cleanup&status=active&limit=1&page=1');
    assert.equal(page.total, 2);
    assert.equal(page.items.length, 1);
    const unchanged = await mutate('POST', '/standard-products/batch-visibility', { ids: [active, hidden], hidden: false }, 201);
    assert.deepEqual(unchanged.payload.skipped, [active, hidden]);
    assert.equal((await database.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow()).version, versionBefore.version + 2n);
  });

  test('batch visibility rolls back every selected standard when catalog invalidation fails', async () => {
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    const rows = await database.insertInto('standard_products').values([{ name: 'Rollback Batch A' }, { name: 'Rollback Batch B' }]).returning('id').execute();
    const version = await database.deleteFrom('catalog_cache_versions').where('id', '=', 1).returningAll().executeTakeFirstOrThrow();
    try {
      await mutate('POST', '/standard-products/batch-visibility', { ids: rows.map(row => row.id.toString()), hidden: true }, 500);
      assert.deepEqual((await database.selectFrom('standard_products').select('hidden').where('id', 'in', rows.map(row => row.id)).execute()).map(row => row.hidden), [false, false]);
    } finally { await database.insertInto('catalog_cache_versions').values(version).execute(); }
  });

  test('batch platform status preserves classifications and supports disabled filters', async () => {
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    await database.insertInto('product_platforms').values([{ name: 'Batch Platform A' }, { name: 'Batch Platform B', enabled: false }]).execute();
    const standard = await database.insertInto('standard_products').values({ name: 'Platform retained standard', platform: 'Batch Platform A' }).returning('id').executeTakeFirstOrThrow();
    const result = await mutate('POST', '/platforms/batch-status', { names: [' Batch Platform A ', 'Batch Platform A', 'Batch Platform B', 'Missing Platform'], enabled: false }, 201);
    assert.deepEqual(result.payload, { success: ['Batch Platform A'], skipped: ['Batch Platform B'], conflicts: [{ id: 'Missing Platform', reason: '商品平台不存在' }] });
    assert.equal((await get('platforms?keyword=Batch%20Platform&status=enabled&page=1')).total, 0);
    assert.equal((await get('platforms?keyword=Batch%20Platform&status=disabled&page=1')).total, 2);
    assert.equal((await database.selectFrom('standard_products').select(['platform', 'hidden']).where('id', '=', standard.id).executeTakeFirstOrThrow()).hidden, false);
    assert.equal((await database.selectFrom('standard_products').select('platform').where('id', '=', standard.id).executeTakeFirstOrThrow()).platform, 'Batch Platform A');
    await mutate('POST', '/platforms/batch-status', { names: ['Batch Platform A'], enabled: true }, 201);
    assert.equal((await get('platforms?keyword=Batch%20Platform&status=enabled&page=1')).total, 1);
  });

  test('batch management routes authenticate and reject malformed requests before changing data', async () => {
    for (const [path, payload] of [
      ['standard-products/batch-visibility', { ids: [ids.standardAlpha!.toString()], hidden: true }],
      ['platforms/batch-status', { names: ['liandong'], enabled: false }],
    ] as const) {
      const response = await app.getHttpAdapter().getInstance().inject({ method: 'POST', url: `/v1/admin/${path}`, payload });
      assert.equal(response.statusCode, 401);
    }
    for (const payload of [{ ids: [], hidden: true }, { ids: ['1'], hidden: 'false' }, { ids: ['1', '0'], hidden: true }, { ids: ['1'], hidden: null }, { ids: Array(1001).fill('1'), hidden: true }]) {
      await mutate('POST', '/standard-products/batch-visibility', payload, 400);
    }
    for (const payload of [{ names: [], enabled: false }, { names: ['liandong', ' '], enabled: false }, { names: ['liandong'], enabled: 'false' }, { names: ['x'.repeat(51)], enabled: false }, { names: Array(1001).fill('liandong'), enabled: false }]) {
      await mutate('POST', '/platforms/batch-status', payload, 400);
    }
    for (const path of ['platforms', 'standard-products']) {
      const response = await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: `/v1/admin/${path}?status=invalid`, headers: { cookie } });
      assert.equal(response.statusCode, 400);
    }
  });

  test('standard member drilldowns filter exact ownership and match live product and distinct shop counts', async () => {
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    const shops = await database.insertInto('shops').values([
      { platform: 'drilldown', name: 'Drill Active', url: 'https://drill-active.invalid', enabled: true },
      { platform: 'drilldown', name: 'Drill Disabled', url: 'https://drill-disabled.invalid', enabled: false },
      { platform: 'drilldown', name: 'Drill Deleted', url: 'https://drill-deleted.invalid', enabled: false, deleted_at: new Date() },
    ]).returning('id').execute();
    const standards = await database.insertInto('standard_products').values([
      { name: 'Drill Standard', platform: 'drilldown' }, { name: 'Drill Standard Other', platform: 'drilldown' },
    ]).returning('id').execute();
    const members = await database.insertInto('products').values([
      { shop_id: shops[0]!.id, external_id: 'drill-a', name: 'Drill A', normalized_key: 'drill-a', url: 'https://drill-active.invalid/a' },
      { shop_id: shops[0]!.id, external_id: 'drill-b', name: 'Drill B', normalized_key: 'drill-b', url: 'https://drill-active.invalid/b' },
      { shop_id: shops[1]!.id, external_id: 'drill-c', name: 'Drill C', normalized_key: 'drill-c', url: 'https://drill-disabled.invalid/c' },
      { shop_id: shops[2]!.id, external_id: 'drill-d', name: 'Drill D', normalized_key: 'drill-d', url: 'https://drill-deleted.invalid/d', deleted_at: new Date() },
      { shop_id: shops[0]!.id, external_id: 'drill-other', name: 'Drill Other', normalized_key: 'drill-other', url: 'https://drill-active.invalid/other' },
    ]).returning('id').execute();
    await database.insertInto('standard_product_members').values(members.map((member, i) => ({ product_id: member.id, standard_product_id: standards[i === 4 ? 1 : 0]!.id }))).execute();
    const standardProductId = standards[0]!.id.toString();
    const products = await get(`products?standardProductId=${standardProductId}&page=1&limit=2`);
    assert.equal(products.total, 3);
    assert.deepEqual(products.items.map((item: { id: string }) => item.id), members.slice(0, 2).map(item => item.id.toString()));
    const secondPage = await get(`products?standardProductId=${standardProductId}&page=2&limit=2`);
    assert.deepEqual(secondPage.items.map((item: { name: string }) => item.name), ['Drill C']);
    const filtered = await get(`products?standardProductId=${standardProductId}&shopId=${shops[0]!.id}&keyword=Drill%20B&page=1`);
    assert.deepEqual(filtered.items.map((item: { name: string }) => item.name), ['Drill B']);
    const recycled = await get(`products?standardProductId=${standardProductId}&deleted=true&page=1`);
    assert.deepEqual(recycled.items.map((item: { name: string }) => item.name), ['Drill D']);
    const boundShops = await get(`shops?standardProductId=${standardProductId}&page=1&limit=1`);
    assert.equal(boundShops.total, 2);
    const secondShop = await get(`shops?standardProductId=${standardProductId}&page=2&limit=1`);
    assert.deepEqual(secondShop.items.map((item: { name: string }) => item.name), ['Drill Disabled']);
    const shopSearch = await get(`shops?standardProductId=${standardProductId}&keyword=Disabled&page=1`);
    assert.equal(shopSearch.total, 1);
    const counts = (await get('standard-products?keyword=Drill%20Standard')).items.find((item: { id: string }) => item.id === standardProductId);
    assert.equal(counts.memberCount, String(products.total));
    assert.equal(counts.shopCount, String(boundShops.total));
    for (const route of ['products', 'shops']) {
      for (const invalid of ['0', '-1', 'invalid']) await get(`${route}?standardProductId=${invalid}`, 400);
      assert.deepEqual((await get(`${route}?standardProductId=999999999&page=1`)).items, []);
    }
  });

  test('standard picker searches current names, compact spellings and aliases without exposing merged binding targets', async () => {
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    const rows = await database.insertInto('standard_products').values([
      { name: 'ChatGPT Pro 20x', canonical_family: 'openai', canonical_product: 'chatgpt', canonical_tier: 'pro_20x', platform: 'picker-test' },
      { name: 'ChatGPT Pro 500', canonical_family: 'openai', canonical_product: 'chatgpt', canonical_tier: 'pro_500', aliases: ['五百档专用别名%_'], platform: 'picker-test' },
      { name: 'Picker Hidden', hidden: true, platform: 'picker-test' },
      { name: 'Picker Merged', hidden: true, merged_into_id: ids.standardAlpha!, platform: 'picker-test' },
      { name: 'Picker Merged Only', merged_into_id: ids.standardAlpha!, platform: 'picker-merged-only' },
    ]).returning('id').execute();
    try {
      for (const keyword of ['Chatgpt Pro 500', 'Chatgpt Pro500', 'ＣｈａｔＧＰＴ　Ｐｒｏ　５００', 'ChatGPT Pro 25x', 'openai pro_500', '五百档专用别名%_']) {
        const page = await get(`standard-products?${new URLSearchParams({ keyword, platform: 'picker-test', page: '1' })}`);
        assert.deepEqual(page.items.map((item: { id: string }) => item.id), [rows[1]!.id.toString()], keyword);
      }
      const currentName = await get('standard-products?platform=picker-test&page=1&keyword=ChatGPT%20Pro%20200');
      assert.equal(currentName.items[0]?.id, rows[0]!.id.toString());
      assert.equal(currentName.items[0]?.name, 'ChatGPT Pro 200');
      const literalWildcard = await get('standard-products?platform=picker-test&page=1&keyword=%25_');
      assert.deepEqual(literalWildcard.items.map((item: { id: string }) => item.id), [rows[1]!.id.toString()]);
      const first = await get('standard-products?platform=picker-test&status=unmerged&page=1&limit=2');
      const second = await get('standard-products?platform=picker-test&status=unmerged&page=2&limit=2');
      assert.equal(first.total, 3);
      assert.equal(second.total, 3);
      assert.deepEqual([...first.items, ...second.items].map(item => item.id), rows.slice(0, 3).map(row => row.id.toString()));
      assert.equal(second.items[0]?.hidden, true);
      assert.equal((await get('standard-products?platform=picker-test&status=all&page=1')).total, 4);
      const platforms = await get('standard-products/platforms?status=unmerged');
      assert.ok(platforms.items.includes('picker-test'), '未登记的平台也能作为分类浏览');
      assert.ok(!platforms.items.includes('picker-merged-only'));
      assert.ok((await get('standard-products/platforms?status=all')).items.includes('picker-merged-only'));
      const invalid = await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: '/v1/admin/standard-products/platforms?status=invalid', headers: { cookie } });
      assert.equal(invalid.statusCode, 400);
    } finally {
      await database.deleteFrom('standard_products').where('id', 'in', rows.map(row => row.id)).execute();
    }
  });

  test('standard picker ranks exact product identities ahead of related guides so Pro 500 appears on the first page', async () => {
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    const rows = await database.insertInto('standard_products').values([
      ...Array.from({ length: 12 }, (_, index) => ({ name: `ChatGPT Guide ${index}`, canonical_product: 'chatgpt_guide', platform: 'picker-ranking' })),
      { name: 'ChatGPT Pro 500', canonical_family: 'openai', canonical_product: 'chatgpt', canonical_tier: 'pro_500', platform: 'picker-ranking' },
    ]).returning('id').execute();
    try {
      const first = await get('standard-products?keyword=ChatGPT&platform=picker-ranking&status=unmerged&page=1&limit=10');
      assert.equal(first.items[0]?.id, rows[12]!.id.toString());
      assert.equal(first.total, 13);
      const second = await get('standard-products?keyword=ChatGPT&platform=picker-ranking&status=unmerged&page=2&limit=10');
      assert.equal(second.items.length, 3);
      assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 13);
    } finally {
      await database.deleteFrom('standard_products').where('id', 'in', rows.map(row => row.id)).execute();
    }
  });

  async function seed(): Promise<void> {
    const database = testingModule.get<Kysely<DatabaseSchema>>(DATABASE);
    await sql`truncate table shops, product_standardization_decisions restart identity cascade`.execute(database);
    const shops = await database.insertInto('shops').values([
      { platform: '16688', url: 'https://alpha.invalid', name: 'Alpha Shop', enabled: true },
      { platform: 'liandong', url: 'https://disabled.invalid', name: 'Disabled Shop', enabled: false },
      { platform: 'liandong', url: 'https://deleted.invalid', name: 'Deleted Shop', enabled: false, deleted_at: new Date() },
    ]).returning(['id', 'name']).execute();
    ids.shopAlpha = shops[0]!.id;
    ids.shopDeleted = shops[2]!.id;

    const products = await database.insertInto('products').values([
      { shop_id: ids.shopAlpha, external_id: 'alpha-red', name: 'Alpha Red', spec: 'Red', normalized_key: 'alpha-red', url: 'https://alpha.invalid/red', source_data: jsonb({ color: 'red' }) },
      { shop_id: ids.shopAlpha, external_id: 'beta-blue', name: 'Beta Blue', spec: 'Blue', normalized_key: 'beta-blue', url: 'https://alpha.invalid/blue', source_data: jsonb({ color: 'blue' }) },
      { shop_id: ids.shopDeleted, external_id: 'deleted', name: 'Deleted Product', normalized_key: 'deleted', url: 'https://deleted.invalid/product', deleted_at: new Date(), source_data: jsonb({}) },
    ]).returning(['id', 'name']).execute();
    ids.productAlpha = products[0]!.id;
    ids.productBeta = products[1]!.id;
    await database.insertInto('offers').values({ idempotency_key: 'admin-test-alpha-offer', product_id: ids.productAlpha, price: '12.50' }).execute();

    const standards = await database.insertInto('standard_products').values([
      { name: 'Alpha Standard', platform: '16688', sort_order: 10n, standard_key: 'alpha-key' },
      { name: 'Alpha Backup', platform: '16688', sort_order: 20n, standard_key: 'alpha-backup' },
    ]).returning(['id']).execute();
    ids.standardAlpha = standards[0]!.id;
    ids.standardBackup = standards[1]!.id;
    await database.insertInto('product_platforms').values([{ name: '16688', enabled: true }, { name: 'liandong', enabled: true }]).execute();
    await database.insertInto('standard_product_members').values({ standard_product_id: ids.standardAlpha, product_id: ids.productAlpha }).execute();
    await database.insertInto('standard_product_members').values({ standard_product_id: ids.standardBackup, product_id: ids.productBeta }).execute();

    const tags = await database.insertInto('product_tags').values([
      { product_id: ids.productAlpha, name: 'color', value: 'Red' },
      { product_id: ids.productAlpha, name: 'brand', value: 'Acme' },
      { product_id: products[1]!.id, name: 'color', value: 'Blue' },
    ]).returning(['id', 'name']).execute();
    ids.tagColor = tags[0]!.id;
    ids.tagBrand = tags[1]!.id;

    const jobs = await database.insertInto('ai_jobs').values([
      { status: 'succeeded', total: 1n, processed: 1n, applied: 1n, model: 'task7-model', scope_shop_id: ids.shopAlpha, finished_at: new Date() },
      { status: 'queued', total: 2n, model: 'other-model', scope_shop_id: ids.shopDeleted },
    ]).returning(['id', 'status']).execute();
    ids.jobSucceeded = jobs[0]!.id;
    ids.jobQueued = jobs[1]!.id;

    const runs = await database.insertInto('fetch_runs').values([
      { shop_id: ids.shopAlpha, started_at: new Date(), finished_at: new Date(), status: 'succeeded', item_count: 2n },
      { shop_id: ids.shopDeleted, started_at: new Date(Date.now() - 60_000), status: 'failed', item_count: 0n, error: 'ignored' },
    ]).returning(['id', 'status']).execute();
    ids.runSucceeded = runs[0]!.id;
  }
});





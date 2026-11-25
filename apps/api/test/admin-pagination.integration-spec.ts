import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { ValidationPipe } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants.js';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { migrateToLatest } from '../scripts/migrate.js';
import { AdminRepository, type ProductListFilter } from '../src/admin/admin.repository.js';
import { AdminController } from '../src/admin/admin.controller.js';
import { ListAiJobsQueryDto, ListPlatformsQueryDto } from '../src/admin/dto/admin-query.dto.js';
import { encodeIdCursor } from '../src/common/pagination.js';
import type { DatabaseSchema } from '../src/database/types.js';

describe('admin pagination bounds database reads and response payloads', () => {
  let admin: Pool;
  let db: Kysely<DatabaseSchema>;
  let schema: string;
  let controller: AdminController;
  let shopId: bigint;
  let jobIds: string[];
  const statements: string[] = [];

  test('sort order can be edited as an exact signed bigint without changing identity', async () => {
    const before = await db.selectFrom('standard_products').selectAll().orderBy('id').executeTakeFirstOrThrow();
    const parameters = Reflect.getMetadata(ROUTE_ARGS_METADATA, AdminController, 'updateStandardProduct') as Record<string, { pipes: ValidationPipe[] }>;
    const pipe = Object.values(parameters).flatMap(parameter => parameter.pipes).find(pipe => pipe instanceof ValidationPipe)!;
    const update = async (sortOrder: unknown) => controller.updateStandardProduct(String(before.id), await pipe.transform({ sortOrder }, { type: 'body' }));
    for (const sortOrder of ['-9223372036854775808', '9223372036854775807', '-10', '0']) {
      assert.equal((await update(sortOrder)).sortOrder, sortOrder);
      const stored = await db.selectFrom('standard_products').selectAll().where('id', '=', before.id).executeTakeFirstOrThrow();
      assert.equal(stored.sort_order, BigInt(sortOrder));
      assert.equal(stored.standard_key, before.standard_key);
      assert.equal(stored.verification_state, before.verification_state);
    }
    for (const sortOrder of ['', '1.5', '1e3', '9223372036854775808', '-9223372036854775809', 10, null]) {
      await assert.rejects(update(sortOrder));
    }
    await update(String(before.sort_order));
  });

  before(async () => {
    assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required');
    schema = `admin_pagination_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`create schema "${schema}"`);
    process.env.PG_SCHEMA = schema;
    db = new Kysely<DatabaseSchema>({
      dialect: new PostgresDialect({ pool: new Pool({
        connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public`,
      }) }),
      log: event => { if (event.level === 'query') statements.push(event.query.sql); },
    });
    await migrateToLatest(db);
    controller = new AdminController(new AdminRepository(db));
    shopId = (await db.insertInto('shops').values({
      name: 'Pagination shop', platform: 'audit', url: 'https://pagination.invalid', enabled: true,
    }).returning('id').executeTakeFirstOrThrow()).id;
    jobIds = (await db.insertInto('ai_jobs').values([1, 2, 3].map(i => ({
      status: 'succeeded' as const, model: `pagination-${i}`, total: 0n, processed: 0n,
      applied: 0n, auto_apply: false, scope_shop_id: shopId,
    }))).returning('id').execute()).map(row => String(row.id));
    await db.insertInto('product_platforms').values([0, 1, 2, 3, 4].map(i => ({
      name: `Audit-P${i}`, enabled: i !== 4,
    }))).execute();
    await db.insertInto('standard_products').values([
      { name: 'Audit standard one', platform: 'Audit-P0' },
      { name: 'Audit standard two', platform: 'Audit-P0' },
      { name: 'Audit standard three', platform: 'Audit-P1' },
    ]).execute();
    await sql`insert into products(shop_id, external_id, name, normalized_key, url)
      select ${shopId}, 'audit-' || n, 'Audit ' || n, 'audit-' || n,
        'https://pagination.invalid/' || n from generate_series(1, 200) n`.execute(db);
    await sql`insert into product_tags(product_id, name, value)
      select id, 'supported_client', to_jsonb('codex'::text) from products where shop_id = ${shopId}`.execute(db);
  });

  after(async () => {
    await db?.destroy();
    if (admin && schema) await admin.query(`drop schema "${schema}" cascade`);
    await admin?.end();
    delete process.env.PG_SCHEMA;
  });

  test('AI task page numbers select distinct rows and retain totals on empty pages', async () => {
    const filter = { shopId: String(shopId), limit: 1 };
    const first = await controller.listAiJobs({ ...filter, page: 1 });
    const second = await controller.listAiJobs({ ...filter, page: 2 });
    assert.deepEqual(first.items.map(row => row.id), [jobIds[0]]);
    assert.deepEqual(second.items.map(row => row.id), [jobIds[1]]);
    assert.equal(second.total, 3);
    assert.equal(second.page, 2);
    assert.equal(second.pageSize, 1);
    assert.equal('nextCursor' in second, false);
    const empty = await controller.listAiJobs({ ...filter, page: 4 });
    assert.deepEqual(empty.items, []);
    assert.equal(empty.total, 3);
    assert.equal((await controller.listAiJobs({ ...filter, status: 'failed' })).total, 0);
  });

  test('platform pages use bounded SQL and one count query rather than per-row lookups', async () => {
    statements.length = 0;
    const filter = { keyword: 'Audit-P', limit: 2 };
    const first = await controller.listPlatforms({ ...filter, page: 1 });
    assert.deepEqual(first.items.map(row => row.name), ['Audit-P0', 'Audit-P1']);
    assert.deepEqual(first.items.map(row => row.standardProductCount), ['2', '1']);
    assert.equal(statements.length, 2);
    assert.ok(statements.some(statement => /\blimit\b/iu.test(statement) && /\boffset\b/iu.test(statement)));
    assert.equal('nextCursor' in first, false);
    const second = await controller.listPlatforms({ ...filter, page: 2 });
    assert.deepEqual(second.items.map(row => row.name), ['Audit-P2', 'Audit-P3']);
    assert.equal(second.total, 5);
    assert.equal(second.page, 2);
    const empty = await controller.listPlatforms({ ...filter, page: 4 });
    assert.deepEqual(empty.items, []);
    assert.equal(empty.total, 5);
    const disabled = await controller.listPlatforms({ ...filter, status: 'disabled' });
    assert.deepEqual(disabled.items.map(row => row.name), ['Audit-P4']);
    assert.equal(disabled.total, 1);
  });

  test('numbered list endpoints reject cursor and pageSize parameters', async () => {
    for (const metatype of [ListAiJobsQueryDto, ListPlatformsQueryDto]) {
      const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
      const metadata = { type: 'query' as const, metatype };
      for (const value of [{ cursor: '1' }, { pageSize: '1' }]) {
        await assert.rejects(pipe.transform(value, metadata), error =>
          typeof (error as { getStatus?: () => number }).getStatus === 'function'
          && (error as { getStatus: () => number }).getStatus() === 400);
      }
      const valid = await pipe.transform({ page: '2', limit: '1' }, metadata);
      assert.equal(valid.page, 2);
      assert.equal(valid.limit, 1);
    }
  });

  test('tag summaries omit member arrays and existing member pagination retains all products', async () => {
    const query = { name: 'supported_client', value: 'codex', limit: 1, page: 1 };
    const tags = await controller.listTags(query);
    assert.equal(tags.items.length, 1);
    assert.equal(tags.items[0]!.productCount, '200');
    assert.equal('productIds' in tags.items[0]!, false);
    const first = await controller.listTagProducts({ ...query, limit: 100 });
    const second = await controller.listTagProducts({ ...query, limit: 100, page: 2 });
    assert.equal(first.total, 200);
    assert.equal(second.total, 200);
    assert.equal(new Set([...first.items, ...second.items].map(row => row.id)).size, 200);
  });

  test('product pages preserve filtered totals, complete details and cursor results as membership and visibility change', async () => {
    const repository = new AdminRepository(db);
    const shop = await db.insertInto('shops').values({
      name: 'Product page filters', platform: 'audit', url: 'https://product-pages.invalid', enabled: true,
    }).returning('id').executeTakeFirstOrThrow();
    const standard = await db.insertInto('standard_products').values({
      name: 'Verified page target', verification_state: 'verified',
    }).returning('id').executeTakeFirstOrThrow();
    const products = await db.insertInto('products').values([0, 1, 2, 3].map(i => ({
      shop_id: shop.id, external_id: `external-special-${i}`, name: i === 0 ? 'Literal_% product' : `Product ${i}`,
      normalized_key: `page-${i}`, url: `https://product-pages.invalid/${i}`,
      deleted_at: i === 3 ? new Date() : null,
      source_data: sql`jsonb_build_object('description', repeat('wide product details ', 400))`,
    }))).returning('id').execute();
    const ids = products.map(product => product.id);
    await db.insertInto('standard_product_members').values([
      { product_id: ids[1]!, standard_product_id: standard.id, publication_state: 'published', assignment_source: 'ai' },
      { product_id: ids[2]!, standard_product_id: standard.id, publication_state: 'provisional', assignment_source: 'ai' },
    ]).execute();
    await sql`insert into product_tags(product_id, name, value) values (${ids[0]}, 'region', '"us"'::jsonb)`.execute(db);
    await db.insertInto('offers').values([1, 2].map(i => ({
      product_id: ids[0]!, idempotency_key: `admin-page-offer-${i}`, price: `${i}.00`, currency: 'USD',
      captured_at: new Date('2026-11-01T00:00:00Z'),
    }))).execute();

    const cases: Array<[ProductListFilter, bigint[]]> = [
      [{}, ids.slice(0, 3)],
      [{ standardized: true }, [ids[1]!, ids[2]!]],
      [{ standardized: false }, [ids[0]!]],
      [{ pending: true }, [ids[0]!, ids[2]!]],
      [{ pending: false }, [ids[1]!]],
      [{ deleted: true, pending: true }, [ids[3]!]],
      [{ standardProductId: standard.id }, [ids[1]!, ids[2]!]],
      [{ standardProductId: standard.id, standardized: false }, []],
      [{ keyword: 'Literal_%' }, [ids[0]!]],
      [{ keyword: 'external-special-2' }, [ids[2]!]],
      [{ cursor: encodeIdCursor(ids[0]!) }, [ids[1]!, ids[2]!]],
    ];
    for (const [filter, expected] of cases) {
      const request = { ...filter, shopId: shop.id };
      const cursor = await repository.listProducts({ ...request, limit: 100 });
      assert.deepEqual(cursor.items.map(row => row.id), expected);
      const first = await repository.listProducts({ ...request, page: 1, limit: 2 });
      const second = await repository.listProducts({ ...request, page: 2, limit: 2 });
      assert.equal(first.total, expected.length);
      assert.equal(second.total, expected.length);
      assert.deepEqual([...first.items, ...second.items], cursor.items);
      const empty = await repository.listProducts({ ...request, page: 100, limit: 2 });
      assert.deepEqual(empty, { items: [], total: expected.length, page: 100, pageSize: 2 });
    }
    const first = await repository.listProducts({ shopId: shop.id, page: 1, limit: 1 });
    assert.equal(first.items[0]!.latest_price, '2.00');
    assert.equal(first.items[0]!.latest_currency, 'USD');
    assert.deepEqual(first.items[0]!.tags, [{ name: 'region', value: 'us' }]);
    assert.equal(first.items[0]!.shop_name, 'Product page filters');
    assert.ok(JSON.stringify(first.items[0]!.source_data).length > 8000);

    await db.updateTable('standard_product_members').set({ publication_state: 'published' })
      .where('product_id', '=', ids[2]!).execute();
    assert.equal((await repository.listProducts({ shopId: shop.id, pending: true, page: 1 })).total, 1);
    assert.equal((await repository.listProducts({ shopId: shop.id, pending: false, page: 1 })).total, 2);
    await db.updateTable('products').set({ deleted_at: new Date() }).where('id', '=', ids[0]!).execute();
    assert.equal((await repository.listProducts({ shopId: shop.id, page: 1 })).total, 2);
    assert.equal((await repository.listProducts({ shopId: shop.id, deleted: true, page: 1 })).total, 2);
    await db.updateTable('products').set({ deleted_at: null }).where('id', '=', ids[0]!).execute();
    assert.equal((await repository.listProducts({ shopId: shop.id, page: 1 })).total, 3);
  });

  test('run history totals remain exact for filters, partial and empty pages, and subsequent writes', async () => {
    const repository = new AdminRepository(db);
    const runs = await db.insertInto('fetch_runs').values([0, 1, 2, 3, 4].map(i => ({
      shop_id: shopId, started_at: new Date('2026-11-01T00:00:00Z'),
      status: i === 0 ? 'succeeded' as const : 'failed' as const,
    }))).returning('id').execute();
    const filter = { shopId, status: 'failed' as const, limit: 2 };
    for (const [page, expected] of [[1, [runs[4]!.id, runs[3]!.id]], [2, [runs[2]!.id, runs[1]!.id]], [3, []]] as const) {
      const result = await repository.listRunHistory({ ...filter, page });
      assert.equal(result.total, 4);
      assert.deepEqual(result.items.map(row => row.id), expected);
    }
    assert.equal((await repository.listRunHistory({ ...filter, status: 'succeeded', page: 1 })).total, 1);
    await db.updateTable('fetch_runs').set({ status: 'succeeded' }).where('id', '=', runs[4]!.id).execute();
    const partial = await repository.listRunHistory({ ...filter, page: 2 });
    assert.equal(partial.total, 3);
    assert.deepEqual(partial.items.map(row => row.id), [runs[1]!.id]);
    await db.deleteFrom('fetch_runs').where('shop_id', '=', shopId).execute();
    assert.equal((await repository.listRunHistory({ ...filter, page: 1 })).total, 0);
  });
});

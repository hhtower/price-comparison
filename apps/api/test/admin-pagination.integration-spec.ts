import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { ValidationPipe } from '@nestjs/common';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { migrateToLatest } from '../scripts/migrate.js';
import { AdminRepository } from '../src/admin/admin.repository.js';
import { AdminController } from '../src/admin/admin.controller.js';
import { ListAiJobsQueryDto, ListPlatformsQueryDto } from '../src/admin/dto/admin-query.dto.js';
import type { DatabaseSchema } from '../src/database/types.js';

describe('admin pagination bounds database reads and response payloads', () => {
  let admin: Pool;
  let db: Kysely<DatabaseSchema>;
  let schema: string;
  let controller: AdminController;
  let shopId: bigint;
  let jobIds: string[];
  const statements: string[] = [];

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
      select id, 'audit-common', 'shared' from products where shop_id = ${shopId}`.execute(db);
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
    const query = { name: 'audit-common', value: 'shared', limit: 1, page: 1 };
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
});

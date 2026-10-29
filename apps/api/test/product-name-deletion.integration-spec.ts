import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { migrateToLatest } from '../scripts/migrate.js';
import { jsonb, type DatabaseSchema } from '../src/database/types.js';
import { cancelDeletedProductOutbox, softDeleteProductNames } from '../src/products/product-name-deletion.js';
import { ProductsRepository } from '../src/products/products.repository.js';
import { ProductsService } from '../src/products/products.service.js';
import { reconcileDeletedProductNames } from '../src/products/product-name-deletion-repair.js';
import { StandardizationRepository } from '../src/standardization/standardization.repository.js';
import { AiRepository } from '../src/ai/ai.repository.js';
import { createTagJob, previewTagJob } from '../src/ai/tag-extraction-jobs.js';
import { productContentFingerprint } from '../src/standardization/fingerprint.js';

let db: Kysely<DatabaseSchema>, admin: Pool, schema: string, products: ProductsRepository;
before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  schema = `name_deletion_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  process.env.PG_SCHEMA = schema;
  db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: new Pool({
    connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path="${schema}",public`,
  }) }) });
  await migrateToLatest(db);
  products = new ProductsRepository(db);
});
after(async () => {
  await db?.destroy();
  if (admin && schema) await admin.query(`drop schema "${schema}" cascade`);
  await admin?.end();
  delete process.env.PG_SCHEMA;
});
async function seed(name: string, spec = '', deleted = false) {
  const shop = await db.insertInto('shops').values({ name: 'Deletion', platform: 'test', url: `https://${randomUUID()}.invalid`, enabled: true }).returning('id').executeTakeFirstOrThrow();
  return db.insertInto('products').values({ shop_id: shop.id, external_id: randomUUID(), name, spec, normalized_key: name, url: '', deleted_at: deleted ? new Date() : null }).returningAll().executeTakeFirstOrThrow();
}

test('deleting one name deletes all shops, specs and locked/manual members, preserving history', async () => {
  const first = await seed('ＡＢＣ  同名删除', '月卡');
  const peer = await seed('abc 同名删除', '年卡');
  const other = await seed('abc 同名删除另一个');
  await db.updateTable('products').set({ standardization_locked: true }).where('id', '=', peer.id).execute();
  const standard = await db.insertInto('standard_products').values({ name: 'Historical' }).returning('id').executeTakeFirstOrThrow();
  await db.insertInto('standard_product_members').values([
    { product_id: peer.id, standard_product_id: standard.id, assignment_source: 'human' },
    { product_id: other.id, standard_product_id: standard.id, assignment_source: 'human' },
  ]).execute();
  // Same catalog identity and cached key do not make different raw names equal.
  await db.updateTable('products').set({ normalized_key: first.normalized_key }).where('id', '=', other.id).execute();
  await db.insertInto('offers').values({ product_id: peer.id, price: '12.34', idempotency_key: randomUUID() }).execute();
  const reviewed = await db.selectFrom('products').select('standardization_revision').where('id', '=', peer.id).executeTakeFirstOrThrow();
  assert.equal(await products.softDelete(first.id), true);
  assert.equal(await products.findById(peer.id), undefined);
  assert.ok(await products.findById(other.id));
  assert.equal((await reconcileDeletedProductNames(db)).changes.some(change => change.productId === other.id), false);
  const saved = await db.selectFrom('products').selectAll().where('id', '=', peer.id).executeTakeFirstOrThrow();
  assert.equal(saved.standardization_locked, true);
  assert.equal(saved.standardization_revision, reviewed.standardization_revision);
  assert.equal((await db.selectFrom('standard_product_members').select('assignment_source').where('product_id', '=', peer.id).executeTakeFirstOrThrow()).assignment_source, 'human');
  assert.equal((await db.selectFrom('offers').select('id').where('product_id', '=', peer.id).execute()).length, 1);
});

test('a historical deleted name suppresses new imports, crawls and renamed listings', async () => {
  const deleted = await seed('历史删除商品 Plus 长名称', '', true);
  const shop = await seed('其他店铺占位');
  const item = { shopId: shop.shop_id, externalId: randomUUID(), name: deleted.name, normalizedKey: deleted.name, url: '' };
  const imported = await products.upsertBatch([item]);
  const importedId = [...imported.values()][0]!;
  assert.equal(await products.findById(importedId), undefined);
  const crawled = await db.transaction().execute(tx => products.upsertFetchedProducts(tx, [{ ...item, externalId: randomUUID() }]));
  const crawledId = [...crawled.productIds.values()][0]!;
  assert.equal(await products.findById(crawledId), undefined);
  assert.deepEqual(await new StandardizationRepository(db, new AiRepository(db)).claimOutbox('deleted-name-test'), []);
  await products.update(shop.id, { name: deleted.name });
  assert.equal(await products.findById(shop.id), undefined);
});

test('single restore cannot reactivate a name with deleted peers; sole product can restore', async () => {
  const first = await seed('有已删除同名记录', '', true);
  const peer = await seed(first.name, '', true);
  await assert.rejects(products.restore(peer.id), (error: any) => error.code === 'PRODUCT_NAME_DELETED');
  assert.equal(await products.findById(peer.id), undefined);
  const sole = await seed('唯一的独立删除商品', '', true);
  assert.ok(await products.restore(sole.id));
});

test('concurrent import and deletion cannot leave an active same-name peer', async () => {
  const first = await seed('并发导入删除同名');
  const shop = await seed('并发另外店铺');
  const item = { shopId: shop.shop_id, externalId: randomUUID(), name: first.name, normalizedKey: first.name, url: '' };
  await Promise.all([products.softDelete(first.id), products.upsertBatch([item])]);
  assert.equal((await db.selectFrom('products').select('id').where('name', '=', first.name).where('deleted_at', 'is', null).execute()).length, 0);
});

test('historical deletion repair previews, requires backup, preserves versions and is idempotent', async () => {
  const original = await seed('历史同名批量删除', '', true);
  const peer = await seed(original.name, '其它规格');
  await db.updateTable('shops').set({ enabled: false }).where('id', '=', peer.shop_id).execute();
  const preview = await reconcileDeletedProductNames(db);
  assert.ok(preview.changes.some(change => change.productId === peer.id));
  assert.ok(await products.findById(peer.id));
  await assert.rejects(reconcileDeletedProductNames(db, { apply: true, beforeApply: async () => { throw new Error('backup failed'); } }), /backup failed/);
  assert.ok(await products.findById(peer.id));
  await reconcileDeletedProductNames(db, { apply: true, beforeApply: async plan => assert.deepEqual(plan, preview) });
  assert.equal(await products.findById(peer.id), undefined);
  const saved = await db.selectFrom('products').selectAll().where('id', '=', peer.id).executeTakeFirstOrThrow();
  assert.equal(saved.content_version, peer.content_version);
  assert.equal(saved.standardization_revision, peer.standardization_revision);
  assert.deepEqual((await reconcileDeletedProductNames(db)).changes, []);
});

test('deletion cancels queued and running claims without requeueing unchanged restored products', async () => {
  const first = await seed('待标准化后删除');
  const peer = await seed(first.name);
  for (const [product, status] of [[first, 'queued'], [peer, 'running']] as const) {
    const event = await db.insertInto('product_change_events').values({ product_id: product.id, shop_id: product.shop_id,
      content_version: product.content_version, fingerprint: product.content_fingerprint, event_type: 'created', payload: jsonb({}) }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('standardization_outbox').values({ product_id: product.id, event_id: event.id,
      fingerprint: product.content_fingerprint, status, claimed_by: 'old-worker', claim_token: 'old-claim', lease_until: new Date(Date.now() + 60000) }).execute();
  }
  await products.softDelete(first.id);
  const cancelled = await db.selectFrom('standardization_outbox').select(['status', 'claimed_by', 'claim_token', 'lease_until'])
    .where('product_id', 'in', [first.id, peer.id]).execute();
  assert.deepEqual(cancelled, Array.from({ length: 2 }, () => ({ status: 'cancelled', claimed_by: null, claim_token: null, lease_until: null })));

  const sole = await seed('恢复未处理商品');
  await products.softDelete(sole.id);
  await products.restore(sole.id);
  assert.deepEqual(await db.selectFrom('standardization_outbox').select('id').where('product_id', '=', sole.id).execute(), []);
  assert.deepEqual(await db.selectFrom('product_change_events').select('id').where('product_id', '=', sole.id).execute(), []);
  assert.equal(await products.restore(sole.id), undefined);
});

test('crawler restoration does not restart an interrupted execution with unchanged evidence', async () => {
  const item = await seed('爬虫恢复未处理商品');
  await db.updateTable('products').set({ content_fingerprint: productContentFingerprint(item) }).where('id', '=', item.id).execute();
  const ai = new AiRepository(db);
  const original = await ai.createJob({ model: 'mock', productIds: [item.id], jobType: 'incremental' });
  await db.updateTable('ai_jobs').set({ status: 'cancelled', cancel_requested: true }).where('id', '=', original.id).execute();
  await db.transaction().execute(tx => softDeleteProductNames(tx, [item.id], 'crawler_missing'));
  await db.transaction().execute(tx => products.upsertFetchedProducts(tx, [{ shopId: item.shop_id, externalId: item.external_id,
    name: item.name, spec: item.spec, normalizedKey: item.normalized_key, url: '' }]));
  const queued = await db.selectFrom('standardization_outbox').selectAll().where('product_id', '=', item.id).where('status', '=', 'queued').execute();
  assert.equal(queued.length, 0);
  assert.equal((await products.findById(item.id))!.standardization_revision, item.standardization_revision);
  assert.equal((await ai.createJob({ model: 'mock', productIds: [item.id], jobType: 'incremental' })).total, 0n);
});

for (const path of ['single', 'batch', 'crawler'] as const) {
  test(`${path} restoration preserves completed identity and tag coverage for unchanged evidence`, async () => {
    const item = await seed(`ChatGPT Plus restore ${path}`, 'monthly');
    const fingerprint = productContentFingerprint(item);
    await db.updateTable('products').set({ content_fingerprint: fingerprint }).where('id', '=', item.id).execute();
    const ai = new AiRepository(db);
    const identity = await ai.createJob({ model: 'mock', productIds: [item.id], jobType: 'incremental' });
    await db.updateTable('ai_jobs').set({ status: 'succeeded', phase: 'completed' }).where('id', '=', identity.id).execute();
    await db.updateTable('ai_job_input_members').set({ status: 'classified' }).where('job_id', '=', identity.id).execute();
    const standard = await db.insertInto('standard_products').values({ name: `Restored ${path}`, verification_state: 'verified' }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('standard_product_members').values({ product_id: item.id, standard_product_id: standard.id,
      assignment_source: 'ai', publication_state: 'published' }).execute();
    const tag = await db.transaction().execute(tx => createTagJob(tx, { model: 'mock', productIds: [item.id], parentIdentityJobId: identity.id }));
    await db.updateTable('ai_jobs').set({ status: 'succeeded', phase: 'completed' }).where('id', '=', tag.id).execute();
    await db.updateTable('ai_job_input_members').set({ status: 'classified', output: jsonb({ outcome: 'updated' }) }).where('job_id', '=', tag.id).execute();
    await db.insertInto('product_tags').values({ product_id: item.id, name: 'duration', value: 'monthly' }).execute();
    const before = (await products.findById(item.id))!;
    const membership = await db.selectFrom('standard_product_members').selectAll().where('product_id', '=', item.id).execute();
    const tags = await products.listTags(item.id);
    assert.equal((await previewTagJob(db, { allPending: true, model: 'mock' })).productIds.includes(String(item.id)), false);

    await db.transaction().execute(tx => softDeleteProductNames(tx, [item.id], path === 'crawler' ? 'crawler_missing' : 'manual'));
    assert.equal(await products.findById(item.id), undefined);
    if (path === 'single') await products.restore(item.id);
    else if (path === 'batch') assert.deepEqual((await products.restoreBatch([item.id])).success, [String(item.id)]);
    else {
      const changes = await db.transaction().execute(tx => products.upsertFetchedProducts(tx, [{
        shopId: item.shop_id, externalId: item.external_id, name: item.name, spec: item.spec, normalizedKey: item.normalized_key, url: '',
      }]));
      assert.deepEqual(changes.changedProducts, []);
    }

    const restored = (await products.findById(item.id))!;
    assert.equal(restored.content_fingerprint, fingerprint);
    assert.equal(restored.content_version, before.content_version);
    assert.equal(restored.standardization_revision, before.standardization_revision);
    assert.deepEqual(await db.selectFrom('standard_product_members').selectAll().where('product_id', '=', item.id).execute(), membership);
    assert.deepEqual(await products.listTags(item.id), tags);
    assert.equal((await previewTagJob(db, { allPending: true, model: 'mock' })).productIds.includes(String(item.id)), false);
    assert.deepEqual(await db.selectFrom('standardization_outbox').select('id').where('product_id', '=', item.id).execute(), []);
    assert.deepEqual(await db.selectFrom('product_change_events').select('id').where('product_id', '=', item.id).execute(), []);
    assert.equal((await ai.createJob({ model: 'mock', productIds: [item.id], jobType: 'incremental' })).total, 0n);
  });
}

test('crawler retirement only deletes the missing listing and preserves same-name peers and their work', async () => {
  const missing = await seed('ＧＰＴ Plus 爬虫下架', '月卡');
  const peer = await seed('gpt plus 爬虫下架', '年卡');
  const event = await db.insertInto('product_change_events').values({ product_id: peer.id, shop_id: peer.shop_id,
    content_version: peer.content_version, fingerprint: peer.content_fingerprint, event_type: 'created', payload: jsonb({}) }).returning('id').executeTakeFirstOrThrow();
  const outbox = await db.insertInto('standardization_outbox').values({ product_id: peer.id, event_id: event.id,
    fingerprint: peer.content_fingerprint, status: 'running' }).returning('id').executeTakeFirstOrThrow();
  const deleted = await db.transaction().execute(tx => softDeleteProductNames(tx, [missing.id], 'crawler_missing'));
  assert.deepEqual(deleted, [missing.id]);
  const saved = await db.selectFrom('products').selectAll().where('id', '=', peer.id).executeTakeFirstOrThrow();
  assert.equal(saved.deleted_at, null);
  assert.equal(saved.standardization_revision, peer.standardization_revision);
  assert.equal((await db.selectFrom('standardization_outbox').select('status').where('id', '=', outbox.id).executeTakeFirstOrThrow()).status, 'running');
});

for (const source of ['crawler_missing', 'linked'] as const) {
  test(`${source} tombstones do not suppress imports, crawls, renames or historical repair`, async () => {
    const deleted = await seed(`非全局删除 ${source}`, '', true);
    await db.updateTable('products').set({ deletion_source: source }).where('id', '=', deleted.id).execute();
    const peer = await seed(deleted.name);
    assert.equal((await reconcileDeletedProductNames(db)).changes.some(change => change.productId === peer.id), false);
    const item = { shopId: peer.shop_id, externalId: randomUUID(), name: deleted.name, normalizedKey: deleted.name, url: '' };
    const imported = await products.upsertBatch([item]);
    assert.ok(await products.findById([...imported.values()][0]!));
    const crawled = await db.transaction().execute(tx => products.upsertFetchedProducts(tx, [{ ...item, externalId: randomUUID() }]));
    assert.ok(await products.findById([...crawled.productIds.values()][0]!));
    const renamed = await seed(`改名前 ${source}`);
    await products.update(renamed.id, { name: deleted.name });
    assert.ok(await products.findById(renamed.id));
  });

  test(`a ${source} peer does not block restoring a historically linked product`, async () => {
    const deleted = await seed(`恢复历史误删 ${source}`, '', true);
    const peer = await seed(deleted.name, '', true);
    await db.updateTable('products').set({ deletion_source: source }).where('id', '=', deleted.id).execute();
    await db.updateTable('products').set({ deletion_source: 'linked' }).where('id', '=', peer.id).execute();
    assert.ok(await products.restore(peer.id));
    assert.equal(await products.findById(deleted.id), undefined);
  });
}

test('crawler reappearance cannot restore a listing blocked by an intentional same-name deletion', async () => {
  const missing = await seed('爬虫恢复须保留手动同名删除');
  await db.transaction().execute(tx => softDeleteProductNames(tx, [missing.id], 'crawler_missing'));
  const manual = await seed(missing.name);
  await products.softDelete(manual.id);
  await db.transaction().execute(tx => products.upsertFetchedProducts(tx, [{ shopId: missing.shop_id, externalId: missing.external_id,
    name: missing.name, normalizedKey: missing.normalized_key, url: '' }]));
  assert.equal(await products.findById(missing.id), undefined);
  assert.equal((await db.selectFrom('standardization_outbox').select('id').where('product_id', '=', missing.id).where('status', 'in', ['queued', 'running']).execute()).length, 0);
});

test('imports suppressed by a deleted name never leave a live outbox claim', async () => {
  const deleted = await seed('禁止重新导入商品', '', true);
  const ids = await products.upsertBatch([{ shopId: deleted.shop_id, externalId: randomUUID(), name: deleted.name, normalizedKey: deleted.name, url: '' }]);
  const live = await db.selectFrom('standardization_outbox').select('id').where('product_id', 'in', [...ids.values()]).where('status', 'in', ['queued', 'running']).execute();
  assert.deepEqual(live, []);
});

test('historical outbox recovery skips a product currently being restored', async () => {
  const product = await seed('并发恢复历史队列', '', true);
  const event = await db.insertInto('product_change_events').values({ product_id: product.id, shop_id: product.shop_id,
    content_version: product.content_version, fingerprint: product.content_fingerprint, event_type: 'created', payload: jsonb({}) }).returning('id').executeTakeFirstOrThrow();
  const outbox = await db.insertInto('standardization_outbox').values({ product_id: product.id, event_id: event.id, fingerprint: product.content_fingerprint }).returning('id').executeTakeFirstOrThrow();
  await db.transaction().execute(async tx => {
    await tx.updateTable('products').set({ deleted_at: null }).where('id', '=', product.id).execute();
    await cancelDeletedProductOutbox(db);
    assert.equal((await tx.selectFrom('standardization_outbox').select('status').where('id', '=', outbox.id).executeTakeFirstOrThrow()).status, 'queued');
  });
  await db.updateTable('products').set({ deleted_at: new Date() }).where('id', '=', product.id).execute();
  await cancelDeletedProductOutbox(db);
  assert.equal((await db.selectFrom('standardization_outbox').select('status').where('id', '=', outbox.id).executeTakeFirstOrThrow()).status, 'cancelled');
});

test('batch restore restores only selected crawler and orphan linked tombstones, retaining intentional name blocks', async () => {
  const crawler = await seed('批量恢复爬虫商品', '', true);
  const linked = await seed(crawler.name, '', true);
  const unselected = await seed(crawler.name, '', true);
  await db.updateTable('products').set({ deletion_source: 'crawler_missing' }).where('id', '=', crawler.id).execute();
  await db.updateTable('products').set({ deletion_source: 'linked' }).where('id', 'in', [linked.id, unselected.id]).execute();
  const intentional = await seed('批量恢复保留同名黑名单', '', true);
  const blocked = await seed(intentional.name, '', true);
  await db.updateTable('products').set({ deletion_source: 'manual' }).where('id', '=', intentional.id).execute();
  await db.updateTable('products').set({ deletion_source: 'linked' }).where('id', '=', blocked.id).execute();
  const active = await seed('批量恢复活跃商品');
  const before = await db.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow();
  const service = new ProductsService(products);
  const result = await service.restoreBatch([crawler.id, linked.id, crawler.id, blocked.id, active.id, 9223372036854775807n]);
  assert.deepEqual(result, { success: [String(crawler.id), String(linked.id)], failures: [
    { id: String(blocked.id), reason: '存在已删除的同名商品，不能单独恢复' },
    { id: String(active.id), reason: '商品不存在或未删除' },
    { id: '9223372036854775807', reason: '商品不存在或未删除' },
  ] });
  assert.ok(await products.findById(crawler.id));
  assert.ok(await products.findById(linked.id));
  for (const product of [unselected, intentional, blocked]) assert.equal(await products.findById(product.id), undefined);
  const after = await db.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow();
  assert.equal(after.version, before.version + 1n);
  const queued = await db.selectFrom('standardization_outbox').select('product_id').where('product_id', 'in', [crawler.id, linked.id]).where('status', '=', 'queued').orderBy('product_id').execute();
  assert.deepEqual(queued, []);
  assert.deepEqual((await service.restoreBatch([crawler.id, linked.id])).success, []);
  assert.equal((await db.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow()).version, after.version);
});

test('batch restore rolls back visibility when catalog invalidation fails', async () => {
  const product = await seed('批量恢复事务回滚', '', true);
  await db.updateTable('products').set({ deletion_source: 'crawler_missing' }).where('id', '=', product.id).execute();
  await db.deleteFrom('catalog_cache_versions').where('id', '=', 1).execute();
  try {
    await assert.rejects(new ProductsService(products).restoreBatch([product.id]), /catalog cache version row is missing/);
    assert.equal(await products.findById(product.id), undefined);
    assert.deepEqual(await db.selectFrom('standardization_outbox').select('id').where('product_id', '=', product.id).execute(), []);
  } finally {
    await db.insertInto('catalog_cache_versions').values({ id: 1, version: 1n }).execute();
  }
});

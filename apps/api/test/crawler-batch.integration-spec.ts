import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect, type KyselyPlugin } from 'kysely';
import { Pool } from 'pg';
import { migrateToLatest } from '../scripts/migrate.js';
import { type DatabaseSchema, jsonb } from '../src/database/types.js';
import { ProductsRepository, productMapKey, type FetchedProduct } from '../src/products/products.repository.js';
import { softDeleteProductNames } from '../src/products/product-name-deletion.js';
import { normalizeSourceEvidence, productContentFingerprint } from '../src/standardization/fingerprint.js';

describe('crawler product batch persistence', () => {
  let db: Kysely<DatabaseSchema>;
  let admin: Pool;
  let schema: string;
  let queries = 0;
  let rejectOutbox = false;

  before(async () => {
    if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
    schema = `crawler_batch_${randomUUID().replaceAll('-', '')}`;
    admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`create schema "${schema}"`);
    process.env.PG_SCHEMA = schema;
    const plugin: KyselyPlugin = {
      transformQuery({ node }) {
        queries++;
        if (rejectOutbox && node.kind === 'InsertQueryNode' && node.into?.table.identifier.name === 'standardization_outbox') {
          throw new Error('abort evidence outbox');
        }
        return node;
      },
      async transformResult({ result }) { return result; },
    };
    db = new Kysely<DatabaseSchema>({
      dialect: new PostgresDialect({ pool: new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
        options: `-c search_path="${schema}",public`,
        max: 4,
      }) }),
      plugins: [plugin],
    });
    await migrateToLatest(db);
  });

  after(async () => {
    await db?.destroy();
    await admin?.query(`drop schema if exists "${schema}" cascade`);
    await admin?.end();
    delete process.env.PG_SCHEMA;
  });

  async function shop() {
    return db.insertInto('shops').values({
      platform: '16688', url: `https://example.invalid/${randomUUID()}`,
      name: randomUUID(), enabled: true,
    }).returning('id').executeTakeFirstOrThrow();
  }

  function row(shopId: bigint, externalId: string, extras: Partial<FetchedProduct> = {}): FetchedProduct {
    return { shopId, externalId, name: `Product ${externalId}`, description: `Original body ${externalId}`, spec: 'monthly',
      sourceData: { sku: externalId }, normalizedKey: externalId,
      url: `https://example.invalid/${externalId}`, price: '10.00', stockAvailable: true, ...extras };
  }

  async function upsert(rows: readonly FetchedProduct[]) {
    return db.transaction().execute(tx => new ProductsRepository(db).upsertFetchedProducts(tx, rows));
  }

  test('persists original title and complete body independently of display and evidence normalization', async () => {
    const { id: shopId } = await shop();
    const input = row(shopId, 'raw-bytes', {
      name: 'Displayed Plus monthly', sourceName: '  Ｐｌｕｓ\n', description: ' <p>Full  raw body</p>\n',
    });
    const created = await upsert([input]);
    const id = created.productIds.get(productMapKey(shopId, input.externalId))!;
    const original = await db.selectFrom('products').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    assert.equal(original.source_name, input.sourceName);
    assert.equal(original.source_description, input.description);
    assert.equal(original.content_fingerprint, productContentFingerprint({ name: input.sourceName!, description: input.description }));
    const repeated = await upsert([{ ...input, name: 'Different processed display', spec: 'annual',
      sourceData: { serviceEvidence: { brands: ['Derived'], endpoints: [] }, evidence: 'Changed projection' } }]);
    assert.deepEqual(repeated.changedProducts, []);
    const current = await db.selectFrom('products').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    assert.equal(current.content_fingerprint, original.content_fingerprint);
    assert.equal(current.content_version, original.content_version);
    assert.equal(current.source_name, original.source_name);
    assert.equal(current.source_description, original.source_description);
  });

  test('classifies raw content, quote and metadata changes without losing identity', async () => {
    const { id: shopId } = await shop();
    const initial = ['evidence', 'quote', 'metadata', 'unchanged'].map(key => row(shopId, key));
    const created = await upsert(initial);
    assert.equal(created.changedProducts.length, 4);
    const ids = created.productIds;
    await db.insertInto('offers').values(initial.map(item => ({
      product_id: ids.get(productMapKey(shopId, item.externalId))!,
      idempotency_key: randomUUID(),
      price: item.price!, stock_available: true, is_stale: false,
    }))).execute();
    const metadataId = ids.get(productMapKey(shopId, 'metadata'))!;
    const evidenceId = ids.get(productMapKey(shopId, 'evidence'))!;
    const before = await db.selectFrom('products').select(['id', 'content_version', 'standardization_revision'])
      .where('id', 'in', [...ids.values()]).execute();
    const old = new Map(before.map(product => [product.id, product]));
    const result = await upsert([
      row(shopId, 'evidence', { description: 'Changed original body' }),
      row(shopId, 'quote', { price: '11.00' }),
      row(shopId, 'metadata', { spec: 'yearly', sourceCategory: 'Other', sourceData: { processed: true } }),
      row(shopId, 'unchanged'),
    ]);
    assert.deepEqual(result.changedProducts, [evidenceId]);
    assert.deepEqual(result.quoteOnlyProducts, [ids.get(productMapKey(shopId, 'quote'))]);
    assert.deepEqual(result.unchangedProducts, [metadataId, ids.get(productMapKey(shopId, 'unchanged'))]);
    assert.deepEqual(result.productIds, ids);
    const after = await db.selectFrom('products').selectAll().where('id', 'in', [...ids.values()]).execute();
    for (const product of after) {
      assert.equal(product.content_version, old.get(product.id)!.content_version + (product.id === evidenceId ? 1n : 0n));
      assert.equal(product.standardization_revision, old.get(product.id)!.standardization_revision + (product.id === evidenceId ? 1n : 0n));
    }
    const migrated = after.find(product => product.id === metadataId)!;
    assert.equal(migrated.content_fingerprint, productContentFingerprint(row(shopId, 'metadata')));
    assert.deepEqual(migrated.source_data, { processed: true, evidence: 'Original body metadata' });
  });

  for (const path of ['crawler', 'batch'] as const) {
    test(`${path} preserves reviewed data when only specification or processed metadata changes`, async () => {
      const { id: shopId } = await shop();
      const repository = new ProductsRepository(db);
      const input = row(shopId, `sales-${path}`, {
        price: undefined, stockAvailable: undefined, description: 'Includes 100 credits.',
        sourceData: { evidence: 'Includes 100 credits.', sales_count: 3, sales_count_text: '3 buyers' },
      });
      const ids = await repository.upsertBatch([input]);
      const id = ids.get(productMapKey(shopId, input.externalId))!;
      const standard = await db.insertInto('standard_products').values({
        name: 'Example credits', canonical_family: 'example', canonical_product: 'credits',
        canonical_tier: 'standard', verification_state: 'verified',
      }).returning('id').executeTakeFirstOrThrow();
      await db.insertInto('standard_product_members').values({
        standard_product_id: standard.id, product_id: id, assignment_source: 'human', publication_state: 'published',
      }).execute();
      await db.insertInto('product_tags').values({ product_id: id, name: 'quantity', value: '100' }).execute();
      const state = async () => ({
        product: await db.selectFrom('products')
          .select(['content_version', 'standardization_revision', 'content_changed_at', 'standardization_locked'])
          .where('id', '=', id).executeTakeFirstOrThrow(),
        members: await db.selectFrom('standard_product_members').selectAll().where('product_id', '=', id).execute(),
        tags: await db.selectFrom('product_tags').selectAll().where('product_id', '=', id).execute(),
        decisions: await db.selectFrom('product_standardization_decisions').selectAll().where('product_id', '=', id).execute(),
        events: await db.selectFrom('product_change_events').selectAll().where('product_id', '=', id).execute(),
        outbox: await db.selectFrom('standardization_outbox').selectAll().where('product_id', '=', id).execute(),
      });
      const before = await state();
      assert.equal(before.events.length, 1);
      assert.equal(before.outbox.length, 1);
      const refreshed = {
        ...input, spec: 'yearly', sourceCategory: 'Other', sourceData: { evidence: 'Processed projection changed.', sales_count: 9, sales_count_text: '9 buyers' },
      };
      if (path === 'crawler') {
        const changes = await upsert([refreshed]);
        assert.deepEqual(changes.changedProducts, []);
        assert.deepEqual(changes.unchangedProducts, [id]);
      } else await repository.upsertBatch([refreshed]);
      assert.deepEqual(await state(), before);
      const migrated = await repository.findById(id);
      assert.equal(migrated!.content_fingerprint, productContentFingerprint(refreshed));
      assert.deepEqual(normalizeSourceEvidence(migrated!.source_data), { evidence: 'Includes 100 credits.' });
      const next = {
        ...refreshed, sourceData: { evidence: 'Includes 100 credits.', sales_count: 10, sales_count_text: '10 buyers' },
      };
      if (path === 'crawler') {
        const changes = await upsert([next]);
        assert.deepEqual(changes.changedProducts, []);
        assert.deepEqual(changes.unchangedProducts, [id]);
      } else await repository.upsertBatch([next]);
      assert.deepEqual(await state(), before);

      const changed = { ...next, description: 'Includes 200 credits.' };
      // The batch entrypoint owns invalidation and event/outbox creation in one transaction.
      rejectOutbox = true;
      try {
        await assert.rejects(repository.upsertBatch([changed]), /abort evidence outbox/);
      } finally {
        rejectOutbox = false;
      }
      assert.deepEqual(await state(), before);
      assert.equal((await repository.findById(id))!.content_fingerprint, migrated!.content_fingerprint);
      await repository.upsertBatch([changed]);
      const after = await state();
      assert.equal(after.product.content_version, before.product.content_version + 1n);
      assert.equal(after.product.standardization_revision, before.product.standardization_revision + 1n);
      assert.deepEqual(after.members, []);
      assert.deepEqual(after.tags, []);
      assert.deepEqual(after.decisions, before.decisions);
      assert.equal(after.events.length, before.events.length + 1);
      const event = after.events.find(event => event.event_type === 'evidence_changed')!;
      assert.ok(event);
      assert.equal(event.fingerprint, productContentFingerprint(changed));
      assert.equal(event.content_version, after.product.content_version);
      assert.equal(after.outbox.length, before.outbox.length + 1);
      const queued = after.outbox.find(row => row.event_id === event.id)!;
      assert.ok(queued);
      assert.equal(queued.product_id, id);
      assert.equal(queued.fingerprint, event.fingerprint);
      assert.equal(queued.status, 'queued');
    });
  }

  test('restores crawler tombstones while retaining manually deleted products', async () => {
    const { id: shopId } = await shop();
    const crawler = row(shopId, 'restore', { price: undefined, stockAvailable: undefined });
    const manual = row(shopId, 'manual', { price: undefined, stockAvailable: undefined });
    const ids = (await upsert([crawler, manual])).productIds;
    const restoreId = ids.get(productMapKey(shopId, 'restore'))!;
    const manualId = ids.get(productMapKey(shopId, 'manual'))!;
    await db.transaction().execute(tx => softDeleteProductNames(tx, [restoreId], 'crawler_missing'));
    await db.transaction().execute(tx => softDeleteProductNames(tx, [manualId], 'manual'));
    const result = await upsert([crawler, manual]);
    assert.deepEqual(result.unchangedProducts, [manualId, restoreId]);
    const state = await db.selectFrom('products').select(['id', 'deleted_at', 'deletion_source'])
      .where('id', 'in', [restoreId, manualId]).execute();
    assert.deepEqual(state.find(product => product.id === restoreId)?.deleted_at, null);
    assert.ok(state.find(product => product.id === manualId)?.deleted_at);
    assert.equal(state.find(product => product.id === manualId)?.deletion_source, 'manual');
  });

  test('keeps SQL growth bounded across unchanged products and update chunks', async () => {
    const { id: shopId } = await shop();
    const rows = Array.from({ length: 510 }, (_, index) => row(shopId, `bulk-${index}`));
    const first = await upsert(rows);
    await db.insertInto('offers').values(rows.map(item => ({
      product_id: first.productIds.get(productMapKey(shopId, item.externalId))!,
      idempotency_key: randomUUID(),
      price: item.price!, stock_available: true, is_stale: false,
    }))).execute();
    queries = 0;
    await upsert(rows.slice(0, 90));
    const smallCount = queries;
    queries = 0;
    const result = await upsert(rows);
    const count = queries;
    assert.equal(result.unchangedProducts.length, rows.length);
    assert.deepEqual(result.changedProducts, []);
    assert.deepEqual(result.quoteOnlyProducts, []);
    assert.ok(smallCount <= 25, `expected batched SQL, observed ${smallCount} statements for 90 rows`);
    assert.ok(count <= smallCount + 4, `SQL grew from ${smallCount} to ${count} statements for ${rows.length} rows`);
  });
});

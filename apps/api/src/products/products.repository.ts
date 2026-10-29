import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely, type Selectable, type Updateable } from 'kysely';
import { DATABASE } from '../database/database.providers.js';
import { recordManualDecisions, suppressManualDecisionTrigger } from '../standardization/decision-history.js';
import { jsonb, type DatabaseSchema, type JsonValue, type ProductTable } from '../database/types.js';
import { bumpCatalogVersion, recordCandidateCatalogChanges } from '../catalog/catalog-version.repository.js';
import { DomainConflictError, DomainNotFoundError } from '../common/errors.js';
import { hasBlockingProductNameDeletion, lockProductRowNames, propagateDeletedProductNames, restoreCrawlerProducts, softDeleteProductNames } from './product-name-deletion.js';
import { buildExtractionPayload } from '../ai/adaptive-batching.js';
import { buildCanonicalStandardKey } from '../standardization/canonical-key.js';
import { IDENTITY_POLICY_VERSION, identityEvidenceConflict, isValidCatalogIdentity } from '../standardization/identity-policy.js';
import { normalizeSpec, withoutSpecAliases } from './product-spec.js';
import {
  productContentFingerprint,
  normalizeProductEvidence,
} from '../standardization/fingerprint.js';

export type Product = Selectable<ProductTable>;

export interface ProductUpsert {
  readonly shopId: bigint;
  readonly externalId: string;
  readonly name: string;
  readonly sourceName?: string;
  readonly description?: string;
  readonly spec?: string;
  readonly sourceCategory?: string;
  readonly sourceData?: import('../database/types.js').JsonValue;
  readonly normalizedKey: string;
  readonly url: string;
  readonly imageUrl?: string | null;
}

export interface ProductUpdate {
  readonly name?: string;
  readonly description?: string;
  readonly spec?: string;
  readonly sourceCategory?: string;
  readonly sourceData?: import('../database/types.js').JsonValue;
  readonly normalizedKey?: string;
  readonly url?: string;
  readonly imageUrl?: string | null;
}

export interface FetchedProduct extends ProductUpsert {
  readonly price?: string;
  readonly stockAvailable?: boolean;
}

export interface FetchChangeSet {
  readonly changedProducts: readonly bigint[];
  readonly unchangedProducts: readonly bigint[];
  readonly quoteOnlyProducts: readonly bigint[];
  readonly productIds: ReadonlyMap<string, bigint>;
}

export interface ProductTag { readonly id: bigint; readonly product_id: bigint; readonly name: string; readonly value: string }

export function productMapKey(shopId: bigint, externalId: string): string {
  return `${shopId.toString()}:${externalId}`;
}

@Injectable()
export class ProductsRepository {
  constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  /** Upsert crawler rows against one caller-owned transaction and classify content changes. */
  async upsertFetchedProducts(
    transaction: Kysely<DatabaseSchema>,
    rows: readonly FetchedProduct[],
  ): Promise<FetchChangeSet> {
    if (rows.length === 0) return { changedProducts: [], unchangedProducts: [], quoteOnlyProducts: [], productIds: new Map() };
    const rowsByKey = new Map(rows.map(row => [productMapKey(row.shopId, row.externalId), row]));
    if (rowsByKey.size !== rows.length) throw new Error('duplicate product key in snapshot');
    const priorRows = await transaction.selectFrom('products').select('id')
      .where('shop_id', 'in', rows.map(row => row.shopId)).where('external_id', 'in', rows.map(row => row.externalId)).execute();
    await lockProductRowNames(transaction, priorRows.map(row => row.id), rows.map(row => row.name));
    const orderedRows = [...rowsByKey.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([, row]) => row);
    const createdIds = new Set<bigint>();
    for (let start = 0; start < orderedRows.length; start += 500) {
      const created = await upsertRows(transaction, orderedRows.slice(start, start + 500), true);
      created.forEach(row => createdIds.add(row.id));
    }
    // A competing first import may have created this external ID under another name.
    const committed = await transaction.selectFrom('products').select('id')
      .where('shop_id', 'in', rows.map(row => row.shopId)).where('external_id', 'in', rows.map(row => row.externalId)).execute();
    await lockProductRowNames(transaction, committed.map(row => row.id));
    const existing = await loadExistingProducts(transaction, orderedRows);
    const ids = new Map<string, bigint>();
    const changedProducts: bigint[] = [];
    const unchangedProducts: bigint[] = [];
    const quoteOnlyProducts: bigint[] = [];
    const invalidated: bigint[] = [];
    const existingIds = [...existing.values()].filter(row => !createdIds.has(row.id)).map(row => row.id);
    const latestOffers = new Map<bigint, { price: string; stock_available: boolean }>();
    for (let start = 0; start < existingIds.length; start += 500) {
      const offers = await transaction.selectFrom('offers')
        .distinctOn('product_id').select(['product_id', 'price', 'stock_available'])
        .where('product_id', 'in', existingIds.slice(start, start + 500))
        .where('is_stale', '=', false)
        .orderBy('product_id').orderBy('captured_at', 'desc').execute();
      offers.forEach(offer => latestOffers.set(offer.product_id, offer));
    }
    const updates: Array<{
      id: bigint; normalizedKey: string; url: string; imageUrl: string | null;
      name: string; spec: string; sourceCategory: string; sourceData: JsonValue;
      sourceName: string; description: string; fingerprint: string; changed: boolean;
    }> = [];
    for (const row of orderedRows) {
      const key = productMapKey(row.shopId, row.externalId);
      const previous = existing.get(key)!;
      const sourceName = row.sourceName ?? row.name, description = row.description ?? '';
      const fingerprint = productContentFingerprint({ name: sourceName, description, spec: row.spec });
      const normalized = normalizeProductEvidence({ ...row, sourceData: row.description === undefined ? row.sourceData
        : { ...(row.sourceData ?? {}) as Record<string, JsonValue>, evidence: row.description } });
      const id = previous.id;
      if (createdIds.has(id)) {
        changedProducts.push(id);
      } else {
        const changed = previous.content_fingerprint !== fingerprint;
        const current = latestOffers.get(id);
        const quoteChanged = (row.price !== undefined || row.stockAvailable !== undefined)
          && (!current || (row.price !== undefined && String(current.price) !== String(row.price))
            || (row.stockAvailable !== undefined && current.stock_available !== row.stockAvailable));
        if (changed) {
          changedProducts.push(id);
          invalidated.push(id);
        } else if (quoteChanged) quoteOnlyProducts.push(id);
        else unchangedProducts.push(id);
        updates.push({
          id, normalizedKey: row.normalizedKey, url: row.url, imageUrl: row.imageUrl ?? null,
          name: normalized.name, spec: normalized.spec, sourceCategory: normalized.sourceCategory,
          sourceData: normalized.sourceData as JsonValue, sourceName, description, fingerprint, changed,
        });
      }
      ids.set(key, id);
    }
    for (let start = 0; start < updates.length; start += 500) {
      const values = updates.slice(start, start + 500).map(row => sql`(
        ${row.id}::bigint, ${row.normalizedKey}, ${row.url}, ${row.imageUrl},
        ${row.name}, ${row.spec}, ${row.sourceCategory}, ${JSON.stringify(row.sourceData)}::jsonb,
        ${row.sourceName}, ${row.description}, ${row.fingerprint}, ${row.changed}::boolean
      )`);
      await sql`update products as p set
        normalized_key = v.normalized_key, url = v.url, image_url = v.image_url,
        updated_at = clock_timestamp(),
        name = v.name, spec = v.spec, source_category = v.source_category, source_data = v.source_data,
        source_name = v.source_name, source_description = v.source_description,
        content_fingerprint = v.fingerprint,
        content_version = case when v.changed then p.content_version + 1 else p.content_version end,
        content_changed_at = case when v.changed then clock_timestamp() else p.content_changed_at end,
        standardization_revision = case when v.changed then p.standardization_revision + 1 else p.standardization_revision end
      from (values ${sql.join(values)}) as v(
        id, normalized_key, url, image_url, name, spec, source_category, source_data,
        source_name, source_description, fingerprint, changed
      ) where p.id = v.id`.execute(transaction);
    }
    await clearStandardizationData(transaction, invalidated);
    await propagateDeletedProductNames(transaction, orderedRows.map(row => row.name));
    await restoreCrawlerProducts(transaction, [...ids.values()]);
    return { changedProducts, unchangedProducts, quoteOnlyProducts, productIds: ids };
  }

  async upsertBatch(input: readonly ProductUpsert[]): Promise<ReadonlyMap<string, bigint>> {
    if (input.length === 0) return new Map();
    const keys = input.map((item) => productMapKey(item.shopId, item.externalId));
    if (new Set(keys).size !== keys.length) throw new Error('duplicate product key in batch');
    const inputByKey = new Map(input.map(item => [productMapKey(item.shopId, item.externalId), item]));
    const orderedInput = [...inputByKey.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, item]) => item);
    return this.database.transaction().execute(async (transaction) => {
      // Create missing rows before locking and classifying; concurrent first imports now see the committed row.
      const priorRows = await transaction.selectFrom('products').select('id')
        .where('shop_id', 'in', input.map(row => row.shopId)).where('external_id', 'in', input.map(row => row.externalId)).execute();
      await lockProductRowNames(transaction, priorRows.map(row => row.id), input.map(row => row.name));
      const created = await upsertRows(transaction, orderedInput, true);
      const createdIds = new Set(created.map(row => row.id));
      const committed = await transaction.selectFrom('products').select('id')
        .where('shop_id', 'in', input.map(row => row.shopId)).where('external_id', 'in', input.map(row => row.externalId)).execute();
      await lockProductRowNames(transaction, committed.map(row => row.id));
      const existing = await loadExistingProducts(transaction, input);
      const updating = orderedInput.filter(item => !createdIds.has(existing.get(productMapKey(item.shopId, item.externalId))!.id));
      const rows = [
        ...created,
        ...(await upsertRows(transaction, updating, false)),
      ];
      if (rows.length !== input.length) throw new Error('database returned incomplete product batch');
      const changedIds: bigint[] = [];
      const events = rows.flatMap(row => {
        const key = productMapKey(row.shop_id, row.external_id);
        const previous = existing.get(key), item = inputByKey.get(key)!;
        const inserted = createdIds.has(row.id);
        const changed = inserted || previous!.content_fingerprint !== row.content_fingerprint;
        if (!changed) return [];
        if (!inserted && changed) changedIds.push(row.id);
        return [{
          product_id: row.id, shop_id: row.shop_id, content_version: row.content_version,
          fingerprint: row.content_fingerprint,
          event_type: inserted ? 'created' as const : 'evidence_changed' as const,
          payload: jsonb({ sourceName: item.sourceName ?? item.name, description: item.description ?? '',
            ...normalizeProductEvidence(item) } as unknown as JsonValue),
        }];
      });
      await clearStandardizationData(transaction, changedIds);
      if (events.length) {
        const inserted = await transaction.insertInto('product_change_events').values(events).returning(['id', 'product_id', 'fingerprint']).execute();
        await transaction.insertInto('standardization_outbox').values(inserted.map(event => ({
          product_id: event.product_id, event_id: event.id, fingerprint: event.fingerprint, status: 'queued',
        }))).onConflict(conflict => conflict.doNothing()).execute();
      }
      await propagateDeletedProductNames(transaction, input.map(row => row.name));
      await bumpCatalogVersion(transaction);
      return new Map(rows.map((row) => [productMapKey(row.shop_id, row.external_id), row.id]));
    });
  }

  async findById(id: bigint): Promise<Product | undefined> {
    return this.database
      .selectFrom('products')
      .selectAll()
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
  }

  async update(id: bigint, input: ProductUpdate): Promise<Product | undefined> {
    return this.database.transaction().execute(async (transaction) => {
      await lockProductRowNames(transaction, [id], input.name === undefined ? [] : [input.name]);
      const previous = await transaction
        .selectFrom('products')
        .selectAll()
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!previous) return undefined;
      const changes: Updateable<ProductTable> = {};
      if (input.name !== undefined) { changes.name = input.name; changes.source_name = input.name; }
      if (input.description !== undefined) changes.source_description = input.description;
      if (input.spec !== undefined) changes.spec = normalizeSpec(input.spec);
      if (input.sourceCategory !== undefined) changes.source_category = input.sourceCategory;
      if (input.sourceData !== undefined) changes.source_data = jsonb(withoutSpecAliases(input.sourceData as Record<string, JsonValue>));
      if (input.description !== undefined) changes.source_data = jsonb({
        ...withoutSpecAliases((input.sourceData ?? previous.source_data) as Record<string, JsonValue>),
        evidence: input.description,
      });
      if (input.normalizedKey !== undefined) changes.normalized_key = input.normalizedKey;
      if (input.url !== undefined) changes.url = input.url;
      if (input.imageUrl !== undefined) changes.image_url = input.imageUrl;
      changes.updated_at = new Date();
      const fingerprint = productContentFingerprint({
        name: input.name ?? previous.source_name,
        description: input.description ?? previous.source_description,
        spec: input.spec ?? previous.spec,
      });
      const changed = (input.name !== undefined || input.description !== undefined || input.spec !== undefined)
        && fingerprint !== previous.content_fingerprint;
      if (changed) {
        changes.content_fingerprint = fingerprint;
        changes.content_version = previous.content_version + 1n;
        changes.content_changed_at = changes.updated_at;
        changes.standardization_revision = previous.standardization_revision + 1n;
      }
      let updated = await transaction
        .updateTable('products')
        .set(changes)
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .returningAll()
        .executeTakeFirstOrThrow();
      await propagateDeletedProductNames(transaction, [updated.name]);
      updated = await transaction.selectFrom('products').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      if (changed && !updated.deleted_at) {
        await clearStandardizationData(transaction, [id]);
        const event = await transaction.insertInto('product_change_events').values({
          product_id: id, shop_id: updated.shop_id, content_version: updated.content_version,
          fingerprint, event_type: 'evidence_changed', payload: jsonb({
            sourceName: updated.source_name, description: updated.source_description,
            ...normalizeProductEvidence({ name: updated.name, spec: updated.spec, sourceCategory: updated.source_category, sourceData: updated.source_data }),
          } as unknown as JsonValue),
        }).returning('id').executeTakeFirstOrThrow();
        await transaction.insertInto('standardization_outbox').values({ product_id: id, event_id: event.id, fingerprint, status: 'queued' }).onConflict(c => c.doNothing()).execute();
      }
      await bumpCatalogVersion(transaction);
      return updated;
    });
  }

  async softDelete(id: bigint): Promise<boolean> {
    return this.database.transaction().execute(async (transaction) => {
      const ids = await softDeleteProductNames(transaction, [id]);
      if (ids.length) await bumpCatalogVersion(transaction);
      return ids.includes(id);
    });
  }

  async softDeleteBatch(ids: readonly bigint[]): Promise<bigint[]> {
    if (!ids.length) return [];
    return this.database.transaction().execute(async transaction => {
      const deletedIds = await softDeleteProductNames(transaction, ids);
      if (deletedIds.length) await bumpCatalogVersion(transaction);
      return deletedIds;
    });
  }

  async restore(id: bigint): Promise<Product | undefined> {
    return this.database.transaction().execute(async (transaction) => {
      await lockProductRowNames(transaction, [id]);
      const blocked = await transaction.selectFrom('products as p').select('p.id').where('p.id', '=', id)
        .where(hasBlockingProductNameDeletion('p')).executeTakeFirst();
      if (blocked) throw new DomainConflictError('PRODUCT_NAME_DELETED', '存在已删除的同名商品，不能单独恢复');
      const row = await transaction.updateTable('products').set({ deleted_at: null, deletion_source: null, updated_at: new Date() }).where('id', '=', id).where('deleted_at', 'is not', null).returningAll().executeTakeFirst();
      if (row) {
        await bumpCatalogVersion(transaction);
      }
      return row;
    });
  }

  async restoreBatch(ids: readonly bigint[]): Promise<{ success: string[]; failures: { id: string; reason: string }[] }> {
    if (!ids.length) return { success: [], failures: [] };
    const productIds = [...new Set(ids)];
    return this.database.transaction().execute(async transaction => {
      await lockProductRowNames(transaction, productIds);
      const deleted = await transaction.selectFrom('products as p').select(['p.id', hasBlockingProductNameDeletion('p').as('blocked')])
        .where('p.id', 'in', productIds).where('p.deleted_at', 'is not', null).orderBy('p.id').forUpdate('p').execute();
      const blockedIds = new Set(deleted.filter(product => product.blocked).map(product => product.id));
      const restorable = deleted.filter(product => !product.blocked).map(product => product.id);
      if (restorable.length) {
        await transaction.updateTable('products').set({ deleted_at: null, deletion_source: null, updated_at: new Date() })
          .where('id', 'in', restorable).execute();
        await bumpCatalogVersion(transaction);
      }
      const restoredIds = new Set(restorable);
      return {
        success: productIds.filter(id => restoredIds.has(id)).map(String),
        failures: productIds.filter(id => !restoredIds.has(id)).map(id => ({ id: String(id),
          reason: blockedIds.has(id) ? '存在已删除的同名商品，不能单独恢复' : '商品不存在或未删除' })),
      };
    });
  }

  async listTags(productId: bigint): Promise<readonly ProductTag[]> {
    return this.database.selectFrom('product_tags').selectAll().where('product_id', '=', productId).orderBy('name', 'asc').orderBy('value', 'asc').execute();
  }

  async replaceTags(productId: bigint, tags: readonly { name: string; value: string }[]): Promise<readonly ProductTag[]> {
    return this.database.transaction().execute(async (transaction) => {
      const product = await transaction.selectFrom('products').select('id').where('id', '=', productId).where('deleted_at', 'is', null).forNoKeyUpdate().executeTakeFirst();
      if (!product) throw new DomainNotFoundError('PRODUCT_NOT_FOUND', '商品不存在');
      await transaction.deleteFrom('product_tags').where('product_id', '=', productId).execute();
      if (tags.length) {
        await transaction.insertInto('product_tags').values(tags.map((tag) => ({ product_id: productId, name: tag.name, value: tag.value }))).onConflict((c) => c.doNothing()).execute();
      }
      await transaction.updateTable('products').set({ standardization_revision: sql`standardization_revision + 1`, updated_at: new Date() }).where('id', '=', productId).execute();
      await bumpCatalogVersion(transaction);
      return transaction.selectFrom('product_tags').selectAll().where('product_id', '=', productId).orderBy('name', 'asc').orderBy('value', 'asc').execute();
    });
  }

  async assignStandardProduct(productId: bigint, standardProductId: bigint | null, reason = '管理员审核当前商品归属', confirmEvidenceConflict = false): Promise<void> {
    await this.database.transaction().execute(async (transaction) => {
      const product = await transaction.selectFrom('products').select(['id', 'name', 'spec', 'source_category', 'source_data']).where('id', '=', productId).where('deleted_at', 'is', null).forNoKeyUpdate().executeTakeFirst();
      if (!product) throw new DomainNotFoundError('PRODUCT_NOT_FOUND', '商品不存在');
      if (standardProductId !== null) {
        const standard = await transaction.selectFrom('standard_products').select(['id', 'canonical_family', 'canonical_product', 'canonical_tier', 'standard_key', 'verification_state']).where('id', '=', standardProductId).forShare().executeTakeFirst();
        if (!standard) throw new DomainNotFoundError('STANDARD_PRODUCT_NOT_FOUND', '标准商品不存在');
        const identity = { family: standard.canonical_family ?? '', product: standard.canonical_product ?? '', tier: standard.canonical_tier ?? '' };
        if (!confirmEvidenceConflict && (standard.verification_state !== 'verified' || !isValidCatalogIdentity(identity) || standard.standard_key !== buildCanonicalStandardKey(identity))) {
          throw new DomainConflictError('STANDARD_PRODUCT_UNVERIFIED', '目标标准商品尚未通过当前身份规则验证');
        }
        const evidence = buildExtractionPayload({ id: String(productId), name: product.name, spec: product.spec, category: product.source_category, sourceData: product.source_data as JsonValue });
        // An admin who has read the conflict may confirm it; the decision history keeps the evidence snapshot.
        const conflict = confirmEvidenceConflict ? null : identityEvidenceConflict(identity, evidence);
        if (conflict) throw new DomainConflictError('STANDARD_PRODUCT_EVIDENCE_CONFLICT', '目标标准商品与当前商品证据冲突', { reason: conflict });
      }
      const previousMembership = await transaction.selectFrom('standard_product_members')
        .select('standard_product_id')
        .where('product_id', '=', productId)
        .where('publication_state', '=', 'published')
        .executeTakeFirst();
      await recordManualDecisions(transaction, [productId], { action: standardProductId === null ? 'unbind' : 'assign', standardProductId, reason, allowEvidenceConflict: confirmEvidenceConflict });
      await transaction.deleteFrom('standard_product_members').where('product_id', '=', productId).execute();
      if (standardProductId !== null) {
        await transaction.insertInto('standard_product_members').values({ standard_product_id: standardProductId, product_id: productId, publication_state: 'published', assignment_source: 'human' }).execute();
      }
      await bumpCatalogVersion(transaction);
      await recordCandidateCatalogChanges(
        transaction,
        [previousMembership?.standard_product_id, standardProductId].filter((id): id is bigint => id !== null && id !== undefined),
        IDENTITY_POLICY_VERSION,
      );
    });
  }

}

async function loadExistingProducts(
  database: Kysely<DatabaseSchema>,
  input: readonly ProductUpsert[],
) {
  const rows = await database.selectFrom('products')
    .select(['id', 'shop_id', 'external_id', 'name', 'spec', 'source_category', 'source_data', 'content_fingerprint', 'content_version'])
    .where('shop_id', 'in', input.map((item) => item.shopId))
    .where('external_id', 'in', input.map((item) => item.externalId))
    .orderBy('id').forNoKeyUpdate()
    .execute();
  return new Map(rows.map((row) => [productMapKey(row.shop_id, row.external_id), row]));
}

async function upsertRows(
  database: Kysely<DatabaseSchema>,
  input: readonly ProductUpsert[],
  insertOnly: boolean,
): Promise<readonly Pick<Product, 'id' | 'shop_id' | 'external_id' | 'deleted_at' | 'content_fingerprint' | 'content_version'>[]> {
  if (input.length === 0) return [];
  return database
    .insertInto('products')
    .values(
      input.map((item) => ({
        shop_id: item.shopId,
        external_id: item.externalId,
        name: item.name,
        source_name: item.sourceName ?? item.name,
        source_description: item.description ?? '',
        spec: normalizeSpec(item.spec),
        source_category: item.sourceCategory ?? '',
        source_data: jsonb(item.description === undefined ? withoutSpecAliases(item.sourceData as Record<string, JsonValue> | undefined)
          : { ...withoutSpecAliases(item.sourceData as Record<string, JsonValue> | undefined), evidence: item.description }),
        normalized_key: item.normalizedKey,
        url: item.url,
        image_url: item.imageUrl ?? null,
        updated_at: new Date(),
        deleted_at: null,
        content_fingerprint: productContentFingerprint({ name: item.sourceName ?? item.name, description: item.description, spec: item.spec }),
        content_version: 1n,
        content_changed_at: new Date(),
      })),
    )
    .onConflict((conflict) => insertOnly
      ? conflict.columns(['shop_id', 'external_id']).doNothing()
      : conflict.columns(['shop_id', 'external_id']).doUpdateSet(({ ref }) => ({
        name: ref('excluded.name'),
        source_name: ref('excluded.source_name'),
        source_description: ref('excluded.source_description'),
        spec: ref('excluded.spec'),
        source_category: ref('excluded.source_category'),
        source_data: ref('excluded.source_data'),
        normalized_key: ref('excluded.normalized_key'),
        url: ref('excluded.url'),
        image_url: ref('excluded.image_url'),
        updated_at: ref('excluded.updated_at'),
        content_fingerprint: ref('excluded.content_fingerprint'),
        content_version: sql<bigint>`case when products.content_fingerprint is distinct from excluded.content_fingerprint then products.content_version + 1 else products.content_version end`,
        content_changed_at: sql<Date>`case when products.content_fingerprint is distinct from excluded.content_fingerprint then excluded.content_changed_at else products.content_changed_at end`,
        standardization_revision: sql<bigint>`case when products.content_fingerprint is distinct from excluded.content_fingerprint then products.standardization_revision + 1 else products.standardization_revision end`,
      })),
    )
    .returning(['id', 'shop_id', 'external_id', 'deleted_at', 'content_fingerprint', 'content_version'])
    .execute();
}

async function clearStandardizationData(
  database: Kysely<DatabaseSchema>,
  productIds: readonly bigint[],
): Promise<void> {
  if (productIds.length === 0) return;
  await suppressManualDecisionTrigger(database, productIds);
  await database.deleteFrom('standard_product_members').where('product_id', 'in', productIds).execute();
  await database.deleteFrom('product_tags').where('product_id', 'in', productIds).execute();
}

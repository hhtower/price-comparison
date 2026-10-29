import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/types.js';
import { bumpCatalogVersion } from '../catalog/catalog-version.repository.js';
import { hasBlockingProductNameDeletion, normalizedProductName, propagateDeletedProductNames } from './product-name-deletion.js';

export interface ProductNameDeletionPlan {
  rule: 'blocking_same_name_deleted_v2';
  changes: { productId: bigint; name: string; previousRevision: bigint; contentVersion: bigint; previousUpdatedAt: Date }[];
}
type Options = { apply?: false } | { apply: true; beforeApply: (plan: ProductNameDeletionPlan) => Promise<void> };

export async function reconcileDeletedProductNames(database: Kysely<DatabaseSchema>, options: Options = {}): Promise<ProductNameDeletionPlan> {
  return database.transaction().setIsolationLevel('serializable').execute(async tx => {
    if (options.apply) await sql`lock table products, catalog_cache_versions in exclusive mode nowait`.execute(tx);
    const rows = await tx.selectFrom('products as p').select(['p.id', 'p.name', 'p.standardization_revision', 'p.content_version', 'p.updated_at'])
      .where('p.deleted_at', 'is', null).where(normalizedProductName('p.name'), '!=', '')
      .where(hasBlockingProductNameDeletion('p')).orderBy('p.id').execute();
    const plan: ProductNameDeletionPlan = { rule: 'blocking_same_name_deleted_v2', changes: rows.map(row => ({
      productId: row.id, name: row.name, previousRevision: row.standardization_revision, contentVersion: row.content_version, previousUpdatedAt: row.updated_at,
    })) };
    if (!options.apply || !rows.length) return plan;
    await options.beforeApply(plan);
    const changed = new Set(await propagateDeletedProductNames(tx));
    if (changed.size !== rows.length || rows.some(row => !changed.has(row.id))) throw new Error('Products changed during deletion repair');
    await bumpCatalogVersion(tx);
    return plan;
  });
}

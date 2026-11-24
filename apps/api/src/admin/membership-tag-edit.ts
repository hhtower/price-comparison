import { sql, type Transaction } from 'kysely';
import { jsonb, type DatabaseSchema, type JsonValue } from '../database/types.js';
import { readCurrentMembershipFeatures } from '../standardization/membership-classification.js';

export async function advanceAdminDisplayRevision(tx: Transaction<DatabaseSchema>, productIds: readonly bigint[]): Promise<void> {
  if (!productIds.length) return;
  const products = await tx.selectFrom('products')
    .innerJoin('shops', 'shops.id', 'products.shop_id')
    .select(['products.id', 'products.name', 'products.spec', 'products.source_category', 'products.source_data',
      'products.content_version', 'products.content_fingerprint', 'products.standardization_revision', 'products.membership_features',
      'shops.url as shop_url', 'shops.protocol as shop_protocol', 'shops.platform as shop_platform'])
    .where('products.id', 'in', [...new Set(productIds)]).orderBy('products.id').forUpdate('products').execute();
  for (const product of products) {
    const features = readCurrentMembershipFeatures(product.membership_features, product);
    // Display labels never replace the earlier validated feature evidence.
    await tx.updateTable('products').set({
      standardization_revision: sql`standardization_revision + 1`,
      ...(features ? { membership_features: jsonb({ ...features, revision: String(product.standardization_revision + 1n) } as unknown as JsonValue) } : {}),
    }).where('id', '=', product.id).execute();
  }
}

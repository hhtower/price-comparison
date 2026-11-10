import { sql, type Transaction } from 'kysely';
import { jsonb, type DatabaseSchema, type JsonValue } from '../database/types.js';
import { readCurrentMembershipFeatures } from '../standardization/membership-classification.js';

export async function advanceAdminDisplayRevision(tx: Transaction<DatabaseSchema>, productIds: readonly bigint[]): Promise<void> {
  if (!productIds.length) return;
  const products = await tx.selectFrom('products')
    .select(['id', 'name', 'spec', 'source_category', 'source_data', 'content_version', 'content_fingerprint',
      'standardization_revision', 'membership_features'])
    .where('id', 'in', [...new Set(productIds)]).orderBy('id').forUpdate().execute();
  for (const product of products) {
    const features = readCurrentMembershipFeatures(product.membership_features, product);
    // Display labels never replace the earlier validated feature evidence.
    await tx.updateTable('products').set({
      standardization_revision: sql`standardization_revision + 1`,
      ...(features ? { membership_features: jsonb({ ...features, revision: String(product.standardization_revision + 1n) } as unknown as JsonValue) } : {}),
    }).where('id', '=', product.id).execute();
  }
}

import { sql, type Kysely } from 'kysely';
import { up as refreshMembershipProjection } from './052_top_up_half_price_feature_20261123.js';

export async function up(database: Kysely<unknown>): Promise<void> {
  if (!database.isTransaction) return database.transaction().execute(up);
  await sql`lock table shops, products in share row exclusive mode`.execute(database);
  await sql`update products set membership_features = jsonb_set(
    membership_features, '{decision}',
    (membership_features->'decision') - 'durationSource' - 'requiredWarrantyDays')
    where jsonb_typeof(membership_features->'decision') = 'object'
      and (membership_features->'decision') ?| array['durationSource', 'requiredWarrantyDays']`.execute(database);
  await refreshMembershipProjection(database);
}

export async function down(): Promise<void> {
  // Removed assumptions cannot be reconstructed from current evidence.
}

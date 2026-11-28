import { sql, type Kysely } from 'kysely';
import { membershipKind055 } from './snapshots/membership-policy.js';
import { refreshMembershipProjection } from './snapshots/membership-projection.js';

export async function up<DB>(database: Kysely<DB>): Promise<void> {
  if (!database.isTransaction) return database.transaction().execute(up);
  await sql`lock table shops, products in share row exclusive mode`.execute(database);
  await sql`update products set membership_features = jsonb_set(
    membership_features, '{decision}',
    (membership_features->'decision') - 'durationSource' - 'requiredWarrantyDays')
    where jsonb_typeof(membership_features->'decision') = 'object'
      and (membership_features->'decision') ?| array['durationSource', 'requiredWarrantyDays']`.execute(database);
  await refreshMembershipProjection(database, membershipKind055);
}

export async function down(): Promise<void> {
  // Removed assumptions cannot be reconstructed from current evidence.
}

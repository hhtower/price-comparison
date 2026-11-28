import type { Kysely } from 'kysely';
import { membershipKind054 } from './snapshots/membership-policy.js';
import { refreshMembershipProjection } from './snapshots/membership-projection.js';

export async function up<DB>(database: Kysely<DB>): Promise<void> {
  await refreshMembershipProjection(database, membershipKind054);
}

export async function down(): Promise<void> {
  // Source validation must not be relaxed on rollback.
}

import type { Kysely } from 'kysely';
import { membershipKind052 } from './snapshots/membership-policy.js';
import { refreshMembershipProjection } from './snapshots/membership-projection.js';

export async function up<DB>(database: Kysely<DB>): Promise<void> {
  await refreshMembershipProjection(database, membershipKind052);
}

export async function down(): Promise<void> {
  // Preserve reviewed snapshots; an older application must rebuild its own projection.
}

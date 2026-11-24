import type { Kysely } from 'kysely';
import { up as refreshMembershipProjection } from './052_top_up_half_price_feature_20261123.js';

export async function up(database: Kysely<unknown>): Promise<void> {
  await refreshMembershipProjection(database);
}

export async function down(): Promise<void> {
  // Source validation must not be relaxed on rollback.
}

import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../src/database/types.js';

export async function withMembershipSource<T extends { shop_id: bigint }>(db: Kysely<DatabaseSchema>, product: T) {
  const source = await db.selectFrom('shops')
    .select(['url as shop_url', 'protocol as shop_protocol', 'platform as shop_platform'])
    .where('id', '=', product.shop_id).executeTakeFirstOrThrow();
  return { ...product, ...source };
}

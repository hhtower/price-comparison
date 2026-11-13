import { sql } from 'kysely';
import { CATALOG_EMAIL_PRODUCT_PATTERN, CATALOG_IP_PRODUCT_PATTERN, CATALOG_PLATFORMS } from '@price-comparison/catalog/platform-groups';

export function catalogPlatformGroup() {
  return sql<string>`case
    when lower(coalesce(sp.canonical_family, '')) in ('software', 'bundle', 'mirror') then 'other'
    when lower(coalesce(sp.canonical_product, '')) ~ ${CATALOG_EMAIL_PRODUCT_PATTERN} then 'email'
    when lower(coalesce(sp.canonical_product, '')) ~ ${CATALOG_IP_PRODUCT_PATTERN} then 'ip'
    ${sql.join(CATALOG_PLATFORMS.map(group =>
    sql`when lower(btrim(sp.platform)) in (${sql.join(group.aliases)}) then ${group.id}`,
  ), sql` `)} else 'other' end`;
}

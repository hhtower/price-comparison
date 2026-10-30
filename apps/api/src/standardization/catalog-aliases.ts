import { sql } from 'kysely';
import type { CatalogDatabase } from '../catalog/catalog-version.repository.js';
import { compactSearchText } from './text-features.js';

export const CATALOG_ALIAS_VERSION = 'catalog-aliases-20260928-v1';

export interface CatalogAlias {
  standard_product_id: bigint;
  alias: string;
  normalized_alias: string;
}

export function normalizeCatalogAliases(values: readonly string[]): string[] {
  const unique = new Map<string, string>();
  for (const value of values) {
    const alias = value.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim();
    const key = compactSearchText(alias);
    if (key && !unique.has(key)) unique.set(key, alias);
  }
  return [...unique.values()];
}

/** Published member names are display search hints, never confirmed aliases. */
export async function loadCandidateDisplayNames(
  database: CatalogDatabase,
  standards: readonly { id: bigint; name: string }[],
): Promise<Map<string, string>> {
  if (!standards.length) return new Map();
  // ponytail: sample 12 rows before dedup; page only if distinct-name recall needs it.
  const rows = (await sql<{ standard_product_id: bigint; member_names: string[] }>`
    select sp.id as standard_product_id, array(
      select p.name from standard_product_members member join products p on p.id = member.product_id
      where member.standard_product_id = sp.id and member.publication_state = 'published' and p.deleted_at is null
      order by p.id limit 12
    ) as member_names
    from standard_products sp
    where sp.id in (${sql.join(standards.map(row => row.id))})
      and sp.verification_state = 'verified' and sp.merged_into_id is null
  `.execute(database)).rows;
  const namesByStandard = new Map(rows.map(row => [String(row.standard_product_id),
    normalizeCatalogAliases(row.member_names).slice(0, 12)]));
  return new Map(standards.map(row => [String(row.id),
    [row.name, ...(namesByStandard.get(String(row.id)) ?? [])].join(' / ')]));
}

interface CatalogAliasRow {
  standard_product_id: bigint;
  aliases: string[];
  active: boolean;
}

export async function loadCatalogAliasRows(database: CatalogDatabase, ids?: readonly bigint[]): Promise<CatalogAliasRow[]> {
  if (ids?.length === 0) return [];
  return (await sql<CatalogAliasRow>`
    select sp.id as standard_product_id, sp.aliases,
      (sp.merged_into_id is null and sp.verification_state = 'verified') as active
    from standard_products sp
    where sp.aliases <> '{}'::text[]
      -- Keep global ownership checks, but return no aliases when the targets have none.
      ${ids === undefined ? sql`` : sql`and exists (
        select 1 from standard_products target
        where target.id in (${sql.join(ids)})
          and target.aliases <> '{}'::text[]
      )`}
    order by sp.id
  `.execute(database)).rows;
}

/** Search hints never establish identity; ambiguous aliases are not AI hints. */
export async function loadCatalogAliases(
  database: CatalogDatabase,
  ids?: readonly bigint[],
  snapshot?: readonly CatalogAliasRow[],
): Promise<CatalogAlias[]> {
  if (ids?.length === 0) return [];
  const rows = snapshot ?? await loadCatalogAliasRows(database, ids);
  const allowed = ids && new Set(ids.map(String));
  const aliases: CatalogAlias[] = [];
  const owners = new Map<string, Set<bigint>>();
  for (const row of rows) {
    if (!row.active) continue;
    const include = !allowed || allowed.has(String(row.standard_product_id));
    for (const alias of normalizeCatalogAliases(row.aliases)) {
      const key = compactSearchText(alias);
      const values = owners.get(key) ?? new Set<bigint>();
      values.add(row.standard_product_id);
      owners.set(key, values);
      if (include) aliases.push({ standard_product_id: row.standard_product_id, alias, normalized_alias: key });
    }
  }
  return aliases.filter(alias => owners.get(alias.normalized_alias)!.size === 1);
}

/** Refresh both owners when an alias becomes ambiguous or loses an owner. */
export async function relatedCatalogAliasOwners(
  database: CatalogDatabase,
  ids: readonly bigint[],
  snapshot?: readonly CatalogAliasRow[],
): Promise<bigint[]> {
  if (!ids.length) return [];
  const rows = snapshot ?? await loadCatalogAliasRows(database, ids);
  const selected = new Set(ids.map(String));
  const keys = new Set(rows.filter(row => selected.has(String(row.standard_product_id)))
    .flatMap(row => row.aliases.map(compactSearchText)));
  const related = rows.filter(row => row.aliases.some(alias => keys.has(compactSearchText(alias))));
  return [...new Set([...ids, ...related.map(row => row.standard_product_id)])]
    .sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

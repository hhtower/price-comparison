import { Inject, Injectable } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import { CATALOG_CACHE_TTL_MS } from '../cache/cache.module.js';
import { DATABASE } from '../database/database.providers.js';
import { jsonb, type DatabaseSchema, type JsonValue } from '../database/types.js';
import type { CandidateDocument } from '../standardization/candidate-index.js';
import { loadCandidateDisplayNames, loadCatalogAliases, relatedCatalogAliasOwners } from '../standardization/catalog-aliases.js';

export type CatalogDatabase = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;

export function catalogVersionBumpMinIntervalMs(environment: NodeJS.ProcessEnv = process.env): number {
  // Continuous crawler/worker writes bump ~once per second; that would invalidate
  // every catalog cache key before any entry can serve a hit. Coalesce to the
  // cache TTL: entries expire within that window regardless, so the delay adds
  // no staleness. 0 restores per-write invalidation for the test lane.
  const parsed = Number(environment.CATALOG_VERSION_BUMP_MIN_INTERVAL_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : CATALOG_CACHE_TTL_MS;
}

export async function bumpCatalogVersion(database: CatalogDatabase): Promise<bigint | null> {
  const row = await sql<{ version: bigint }>`
    update catalog_cache_versions
       set version = version + 1, updated_at = now()
     where id = 1 and updated_at <= now() - (${catalogVersionBumpMinIntervalMs()} * interval '1 millisecond')
 returning version
  `.execute(database);
  if (row.rows[0]) return row.rows[0].version;
  const existing = await sql<{ one: number }>`select 1 as one from catalog_cache_versions where id = 1`.execute(database);
  // A throttled skip is normal; a missing version row would silently disable all
  // cache invalidation, so keep failing those writes loudly.
  if (!existing.rows.length) throw new Error('catalog cache version row is missing');
  return null;
}

export interface CandidateCatalogChangeResult {
  readonly version: bigint;
  readonly aliasPolicyVersion: string;
  readonly changeCount: number;
}

export async function recordCandidateCatalogChanges(
  database: CatalogDatabase,
  affectedStandardProductIds: readonly bigint[],
  aliasPolicyVersion: string,
): Promise<CandidateCatalogChangeResult> {
  let ids = [...new Set(affectedStandardProductIds.map(String))]
    .map(BigInt)
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (ids.length === 0) {
    const current = await database.selectFrom('standardization_catalog_versions')
      .select(['version', 'alias_policy_version'])
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    return { version: current.version, aliasPolicyVersion: current.alias_policy_version, changeCount: 0 };
  }

  const versionResult = await sql<{ version: bigint; alias_policy_version: string }>`
    update standardization_catalog_versions
       set version = version + 1,
           alias_policy_version = ${aliasPolicyVersion},
           updated_at = now()
     where id = 1
 returning version, alias_policy_version
  `.execute(database);
  const version = versionResult.rows[0];
  if (!version) throw new Error('standardization catalog version row is missing');
  ids = await relatedCatalogAliasOwners(database, ids);

  const standards = await database.selectFrom('standard_products as sp')
    .select([
      'sp.id',
      'sp.name',
      'sp.canonical_family',
      'sp.canonical_product',
      'sp.canonical_tier',
      'sp.verification_state',
      'sp.merged_into_id',
      sql<boolean>`exists (
        select 1 from standard_product_members member join products p on p.id = member.product_id
         where member.standard_product_id = sp.id
           and member.publication_state = 'published'
           and p.deleted_at is null
      )`.as('has_published_member'),
    ])
    .where('sp.id', 'in', ids)
    .orderBy('sp.id')
    .execute();
  const aliases = await loadCatalogAliases(database, ids);
  const displayNames = await loadCandidateDisplayNames(database, standards);
  const aliasesByStandard = new Map<string, string[]>();
  for (const alias of aliases) {
    const key = alias.standard_product_id.toString();
    const values = aliasesByStandard.get(key) ?? [];
    values.push(alias.alias);
    aliasesByStandard.set(key, values);
  }
  const standardsById = new Map(standards.map(standard => [standard.id.toString(), standard]));
  const changes = ids.map(id => {
    const standard = standardsById.get(id.toString());
    if (standard?.verification_state === 'quarantined') {
      return { version: version.version, standard_product_id: id, operation: 'isolate' as const, document: null };
    }
    if (standard?.verification_state === 'verified' && standard.merged_into_id == null
      && standard.has_published_member
      && standard.canonical_family
      && standard.canonical_product
      && standard.canonical_tier) {
      const document: CandidateDocument = {
        id: id.toString(),
        family: standard.canonical_family,
        product: standard.canonical_product,
        tier: standard.canonical_tier,
        displayName: displayNames.get(id.toString()) ?? standard.name,
        aliases: aliasesByStandard.get(id.toString()) ?? [],
      };
      return {
        version: version.version,
        standard_product_id: id,
        operation: 'upsert' as const,
        document: jsonb(document as unknown as JsonValue),
      };
    }
    return { version: version.version, standard_product_id: id, operation: 'delete' as const, document: null };
  });
  await database.insertInto('catalog_index_changes').values(changes).execute();
  return { version: version.version, aliasPolicyVersion: version.alias_policy_version, changeCount: changes.length };
}

@Injectable()
export class CatalogVersionRepository {
  constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  async current(): Promise<bigint> {
    const row = await this.database
      .selectFrom('catalog_cache_versions')
      .select('version')
      .where('id', '=', 1)
      .executeTakeFirst();
    return row?.version ?? 1n;
  }
}

import { Kysely, PostgresDialect } from 'kysely';
import { createPostgresPool } from '../src/database/database.providers.js';
import '../src/config/env.js';
import { CatalogRepository } from '../src/catalog/catalog.repository.js';
import type { DatabaseSchema } from '../src/database/types.js';

// Facets intentionally read tags from every eligible SKU; offer history must stay indexed.
const PROTECTED_RELATIONS = new Set(['offers']);

export function sequentialScanRelations(plan: unknown): string[] {
  const relations = new Set<string>();
  walkPlan(normalizePlan(plan), relations);
  return [...relations];
}

export function assertCatalogPlan(plan: unknown): void {
  const offenders = sequentialScanRelations(plan)
    .filter((relation) => PROTECTED_RELATIONS.has(relation));
  if (offenders.length > 0) {
    throw new Error(
      `catalog plan uses sequential scans on protected relations: ${offenders.join(', ')}`,
    );
  }
}

function normalizePlan(plan: unknown): unknown {
  if (typeof plan !== 'string') return plan;
  try {
    return JSON.parse(plan) as unknown;
  } catch {
    throw new Error('EXPLAIN plan is not valid JSON');
  }
}

function walkPlan(value: unknown, relations: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) walkPlan(item, relations);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const node = value as Record<string, unknown>;
  if (node['Node Type'] === 'Seq Scan' && typeof node['Relation Name'] === 'string') {
    relations.add(node['Relation Name']);
  }
  for (const child of Object.values(node)) walkPlan(child, relations);
}

async function main(): Promise<void> {
  const schema = process.env.PERF_SCHEMA?.trim();
  if (!schema) throw new Error('PERF_SCHEMA is required');
  process.env.PG_SCHEMA = schema;
  const pool = createPostgresPool();
  const database = new Kysely<DatabaseSchema>({
    dialect: new PostgresDialect({ pool }),
  });
  try {
    const plan = await new CatalogRepository(database).explain({
      platform: 'performance',
      search: 'Performance product',
      tags: [],
      limit: 20,
    });
    assertCatalogPlan(plan);
    console.info(JSON.stringify({
      schema,
      sequentialScanRelations: sequentialScanRelations(plan),
    }));
  } finally {
    await database.destroy();
  }
}

if (process.argv[1]?.endsWith('catalog-plan.ts')) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

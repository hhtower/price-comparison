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

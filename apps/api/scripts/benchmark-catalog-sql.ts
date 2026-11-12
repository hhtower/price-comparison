import assert from 'node:assert/strict';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import '../src/config/env.js';
import { postgresPoolConfig } from '../src/database/database.providers.js';
import type { DatabaseSchema } from '../src/database/types.js';
import { CatalogRepository, type CatalogQuery } from '../src/catalog/catalog.repository.js';

const config = postgresPoolConfig();
const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: new Pool({
  ...config, max: 1, options: `${config.options ?? ''} -c default_transaction_read_only=on`,
}) }) });
const repository = new CatalogRepository(database);
const scenarios: { name: string; facets?: boolean; query: CatalogQuery }[] = [
  { name: 'home', query: { tags: [], limit: 20 } },
  { name: 'openai', query: { platform: 'openai', tags: [], limit: 20 } },
  { name: 'newcomer', query: { newcomer: true, tags: [], limit: 20 } },
  { name: 'facets', facets: true, query: { tags: [], limit: 20 } },
  { name: 'newcomer facets', facets: true, query: { newcomer: true, tags: [], limit: 20 } },
];

try {
  const counts = (await sql<{ offers: number; standards: number; shops: number }>`select
    count(*)::int as offers, count(distinct standard_product_id)::int as standards,
    count(distinct shop_id)::int as shops from catalog_read_offer_prices where available`.execute(database)).rows[0]!;
  assert.ok(counts.offers > 0, 'Benchmark requires representative catalog data');
  console.log(counts);
  const results = [];
  for (const scenario of scenarios) {
    const samples: { planning: number; execution: number; total: number }[] = [];
    for (let run = 0; run <= 20; run += 1) {
      const plan = await (scenario.facets ? repository.explainFacets(scenario.query) : repository.explain(scenario.query)) as
        { 'Planning Time': number; 'Execution Time': number }[];
      const planning = plan[0]?.['Planning Time'], execution = plan[0]?.['Execution Time'];
      assert.ok(Number.isFinite(planning) && Number.isFinite(execution), 'EXPLAIN must return database timings');
      // Warm PostgreSQL's buffers once; every measured iteration still executes the SQL.
      if (run > 0) samples.push({ planning: planning!, execution: execution!, total: planning! + execution! });
    }
    const percentile = (key: keyof typeof samples[number], fraction: number) =>
      Number(samples.map(sample => sample[key]).sort((a, b) => a - b)[Math.ceil(samples.length * fraction) - 1]!.toFixed(2));
    results.push({
      scenario: scenario.name, executionP50Ms: percentile('execution', 0.5),
      executionP95Ms: percentile('execution', 0.95), planningP95Ms: percentile('planning', 0.95),
      sqlP95Ms: percentile('total', 0.95), sqlMaxMs: percentile('total', 1),
    });
  }
  console.table(results);
  assert.ok(results.every(result => result.sqlP95Ms < 100), 'Catalog SQL P95 must be below 100ms, including planning');
} finally {
  await database.destroy();
}

import '../src/config/env.js';
import assert from 'node:assert/strict';
import { Kysely, PostgresDialect, type CompiledQuery } from 'kysely';
import { Pool } from 'pg';
import { postgresPoolConfig } from '../src/database/database.providers.js';
import { readAiTaskQueue } from '../src/ai/ai-task-queue.js';
import type { DatabaseSchema } from '../src/database/types.js';

type PlanNode = { Plans?: PlanNode[]; [key: string]: unknown };
const config = postgresPoolConfig();
const pool = new Pool({
  ...config, max: 1, application_name: 'tag-task-queue-readonly-benchmark',
  options: [config.options, '-c default_transaction_read_only=on -c statement_timeout=15000'].filter(Boolean).join(' '),
});
let captured: CompiledQuery | undefined;
const db = new Kysely<DatabaseSchema>({
  dialect: new PostgresDialect({ pool }),
  log(event) { if (event.level === 'query') captured = event.query; },
});

function verifyPlan(node: PlanNode) {
  // Count visited rows so a tiny nested-loop input is allowed but history-wide rescans fail.
  if (node['Node Type'] === 'CTE Scan') {
    const visited = Number(node['Actual Loops']) * (Number(node['Actual Rows']) + Number(node['Rows Removed by Filter'] || 0));
    assert.ok(visited <= 1_000_000, `Repeated ${node['CTE Name']} scan visited ${visited} rows`);
  }
  for (const child of node.Plans || []) verifyPlan(child);
}

try {
  for (const input of [
    { status: 'all', limit: 1 },
    { status: 'all', limit: 10 },
    { status: 'unfinished', limit: 10 },
    { status: 'attention', limit: 10 },
  ]) {
    const started = performance.now();
    const result = await readAiTaskQueue(db, { ...input, jobType: 'tag_extraction' });
    const elapsedMs = Math.round(performance.now() - started);
    assert.ok(result.items.length <= input.limit);
    assert.ok(captured);
    const explain = await pool.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + captured.sql, [...captured.parameters]);
    const plan = explain.rows[0]['QUERY PLAN'][0];
    verifyPlan(plan.Plan);
    console.log(JSON.stringify({
      ...input, elapsedMs, executionMs: plan['Execution Time'], total: result.summary.total,
      returned: result.items.length, jit: Boolean(plan.JIT),
    }));
  }
} finally { await db.destroy(); }

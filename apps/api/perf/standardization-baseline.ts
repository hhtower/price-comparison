import { readFile } from 'node:fs/promises';
import { auditStandardProductDuplicates } from '../src/standardization/duplicate-audit.js';

export interface BaselineInput { readonly uniqueInputs: number; readonly seed: number; readonly databaseUrl: string; readonly schema: string }
export interface BaselineReport {
  readonly rawInputs: number; readonly uniqueInputs: number; readonly directoryProducts: number; readonly evidenceBytes: number; readonly tagRows: number;
  readonly planningMs: number; readonly planningPeakBytes: number; readonly plannedPairCount: number; readonly taskCount: number;
  readonly candidateQueryMs: number; readonly duplicateAuditMs: number; readonly auditComparedPairs: number; readonly deterministicEdgeCount: number; readonly suspectedPairCount: number;
  readonly requestPreparationMs: number; readonly publicationMs: number; readonly terminalFinalizeMs: number;
  readonly sqlP95Ms: number; readonly lockWaitMs: number; readonly queueWaitP95: number; readonly progressRequestCount: number; readonly errorRate: number;
  readonly stages: Readonly<Record<string, { p50: number; p95: number; p99: number }>>; readonly requestCount: number;
}

const MAX_ITEMS = 32;
const MAX_INPUT_BYTES = 24_576;

export function planStubCandidates(uniqueInputs: number, seed: number): { taskCount: number; peakBytes: number; evidenceBytes: number } {
  const count = normalizedCount(uniqueInputs);
  let state = (seed >>> 0) || 1;
  let peakBytes = 0, evidenceBytes = 0, batchBytes = 0, batchItems = 0, taskCount = 0;
  for (let index = 0; index < count; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const inputBytes = 256 + (state % 1_024);
    evidenceBytes += inputBytes;
    if (batchItems === MAX_ITEMS || batchBytes + inputBytes > MAX_INPUT_BYTES) {
      peakBytes = Math.max(peakBytes, batchBytes); batchBytes = 0; batchItems = 0;
    }
    if (batchItems === 0) taskCount += 1;
    batchBytes += inputBytes; batchItems += 1;
  }
  return { taskCount, peakBytes: Math.max(peakBytes, batchBytes), evidenceBytes };
}

function syntheticDirectory(count: number): Array<{ id: string; family: string; product: string; tier: string }> {
  const families = ['openai', 'google', 'anthropic', 'microsoft', 'x', 'bytedance'];
  const tiers = ['plus', 'pro', 'standard', 'basic', 'team'];
  return Array.from({ length: count }, (_, index) => ({
    id: `baseline-${String(index).padStart(6, '0')}`,
    family: families[index % families.length]!,
    product: `product-${index % Math.max(1, Math.ceil(count * 0.7))}`,
    tier: tiers[Math.floor(index / families.length) % tiers.length]!,
  }));
}

export async function runStandardizationBaseline(input: BaselineInput): Promise<BaselineReport> {
  if (input.databaseUrl !== 'stub://local') throw new Error('standardization baseline only supports databaseUrl=stub://local');
  if (!input.schema.trim()) throw new Error('schema is required');
  const rawInputs = normalizedCount(input.uniqueInputs);
  const uniqueInputs = Math.max(0, Math.floor(rawInputs * 0.82));
  const directoryProducts = Math.max(1, Math.floor(uniqueInputs * 0.25));
  const planningStarted = performance.now();
  const plan = planStubCandidates(uniqueInputs, input.seed);
  const planningMs = Math.max(0, performance.now() - planningStarted);
  const auditStarted = performance.now();
  const audit = auditStandardProductDuplicates(syntheticDirectory(directoryProducts), [], {
    snapshotVersion: `baseline-${input.seed}-${directoryProducts}`, aliasVersion: 'none', maxReportedSuspectPairs: 10_000,
  });
  const duplicateAuditMs = Math.max(0, performance.now() - auditStarted);
  return {
    rawInputs, uniqueInputs, directoryProducts, evidenceBytes: plan.evidenceBytes, tagRows: uniqueInputs * 2,
    planningMs, planningPeakBytes: plan.peakBytes, plannedPairCount: audit.stats.comparedPairs, taskCount: plan.taskCount,
    candidateQueryMs: 0, duplicateAuditMs, auditComparedPairs: audit.stats.comparedPairs,
    deterministicEdgeCount: audit.deterministicGroups.reduce((sum, group) => sum + group.edges.length, 0),
    suspectedPairCount: audit.suspectedPairs.length, requestPreparationMs: planningMs, publicationMs: 0, terminalFinalizeMs: 0,
    sqlP95Ms: 0, lockWaitMs: 0, queueWaitP95: 0, progressRequestCount: 0, errorRate: 0, stages: {}, requestCount: 0,
  };
}

function normalizedCount(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('uniqueInputs must be non-negative');
  return Math.floor(value);
}
function parseArg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function checkBudgets(): Promise<void> {
  const budget = JSON.parse(await readFile(new URL('./standardization-performance-budget.json', import.meta.url), 'utf8')) as {
    environmentFingerprint: { nodeMajor: number; platform: string; arch: string };
    scenarios: Record<string, { maxPlanningMs: number; maxDuplicateAuditMs: number }>;
  };
  const fingerprint = { nodeMajor: Number(process.versions.node.split('.')[0]), platform: process.platform, arch: process.arch };
  if (JSON.stringify(fingerprint) !== JSON.stringify(budget.environmentFingerprint)) throw new Error(`performance environment mismatch: expected ${JSON.stringify(budget.environmentFingerprint)}, received ${JSON.stringify(fingerprint)}`);
  for (const size of [1_000, 5_000, 10_000]) {
    const report = await runStandardizationBaseline({ uniqueInputs: size, seed: 20260920, databaseUrl: 'stub://local', schema: 'baseline_stub' });
    const threshold = budget.scenarios[String(size)];
    if (!threshold) throw new Error(`missing performance budget for ${size}`);
    if (report.planningMs > threshold.maxPlanningMs) throw new Error(`${size} planning budget exceeded`);
    if (report.duplicateAuditMs > threshold.maxDuplicateAuditMs) throw new Error(`${size} duplicate audit budget exceeded`);
    if (report.auditComparedPairs > report.directoryProducts * 100) throw new Error(`${size} duplicate audit comparison bound exceeded`);
    if (report.requestCount !== 0) throw new Error(`${size} baseline attempted a provider request`);
    console.log(JSON.stringify(report));
  }
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/standardization-baseline.ts')) {
  if (process.argv.includes('--check')) checkBudgets().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
  else runStandardizationBaseline({ uniqueInputs: Number(parseArg('--unique-inputs', '1000')), seed: Number(parseArg('--seed', '20260920')), databaseUrl: parseArg('--database-url', 'stub://local'), schema: parseArg('--schema', 'baseline_stub') })
    .then(report => console.log(JSON.stringify(report))).catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}

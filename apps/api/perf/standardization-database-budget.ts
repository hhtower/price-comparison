import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  aggregateDatabaseBenchmarkRuns,
  validateExecutedDatabaseBenchmark,
  type DatabaseBenchmarkAggregate,
  type DatabaseBenchmarkReport,
} from './standardization-database-benchmark.js';

export interface DatabaseNumericBudgetPolicy {
  readonly maxLatencyRegressionPercent: number;
  readonly maxRssRegressionPercent: number;
  readonly minThroughputPercentOfBaseline: number;
  readonly maxLockWaitRegressionPercent: number;
  readonly maxSqlLatencyRegressionPercent: number;
  readonly maxSqlQueryRegressionPercent: number;
}

export interface DatabaseNumericBudgetEntry {
  readonly scenario: DatabaseBenchmarkAggregate['scenario'];
  readonly size: number;
  readonly concurrency: number;
  readonly catalogState: string;
  readonly stage: string;
  readonly throughputUnit: string;
  readonly rssMeasurement: DatabaseBenchmarkAggregate['rssMeasurement'];
  readonly baseline: {
    readonly p95Ms: number;
    readonly maxPeakRssBytes: number;
    readonly medianThroughputPerSecond: number;
    readonly p95LockWaitMs: number;
    readonly p95SqlMs: number;
    readonly maxSqlQueries: number;
  };
  readonly thresholds: {
    readonly maxP95Ms: number;
    readonly maxPeakRssBytes: number;
    readonly minMedianThroughputPerSecond: number;
    readonly maxP95LockWaitMs: number;
    readonly maxP95SqlMs: number;
    readonly maxSqlQueries: number;
  };
}

export interface DatabaseNumericBudget {
  readonly version: 'standardization-database-numeric-budget-v1';
  readonly status: 'candidate' | 'approved';
  readonly sourceReport: {
    readonly generatedAt: string;
    readonly sha256: string;
  };
  readonly environment: DatabaseBenchmarkReport['environment'];
  readonly configuration: DatabaseBenchmarkReport['configuration'];
  readonly policy: DatabaseNumericBudgetPolicy;
  readonly approval: null | {
    readonly approvedBy: string;
    readonly approvedAt: string;
    readonly rationale: string;
  };
  readonly entries: readonly DatabaseNumericBudgetEntry[];
}

export interface PendingDatabaseNumericBudget {
  readonly status: 'pending_target_container_measurement';
  readonly reason: string;
}

export interface StandardizationPerformanceBudget {
  readonly version: string;
  readonly environmentFingerprint: {
    readonly nodeMajor: number;
    readonly platform: string;
    readonly arch: string;
  };
  readonly seed: number;
  readonly structuralLimits: Readonly<Record<string, number>>;
  readonly scenarios: Readonly<Record<string, {
    readonly maxPlanningMs: number;
    readonly maxDuplicateAuditMs: number;
  }>>;
  readonly databaseNumeric: DatabaseNumericBudget | PendingDatabaseNumericBudget;
}

export interface DatabaseBenchmarkBaselineSource {
  readonly report: DatabaseBenchmarkReport;
  readonly rawJson: string;
}

function aggregateKey(value: Pick<DatabaseBenchmarkAggregate,
  'scenario' | 'size' | 'concurrency' | 'catalogState' | 'stage' | 'throughputUnit' | 'rssMeasurement'>): string {
  return JSON.stringify([
    value.scenario,
    value.size,
    value.concurrency,
    value.catalogState,
    value.stage,
    value.throughputUnit,
    value.rssMeasurement,
  ]);
}

function assertFiniteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a finite non-negative number`);
}

function validatePolicy(policy: DatabaseNumericBudgetPolicy): void {
  assertFiniteNonNegative(policy.maxLatencyRegressionPercent, 'maxLatencyRegressionPercent');
  assertFiniteNonNegative(policy.maxRssRegressionPercent, 'maxRssRegressionPercent');
  assertFiniteNonNegative(policy.maxLockWaitRegressionPercent, 'maxLockWaitRegressionPercent');
  assertFiniteNonNegative(policy.maxSqlLatencyRegressionPercent, 'maxSqlLatencyRegressionPercent');
  assertFiniteNonNegative(policy.maxSqlQueryRegressionPercent, 'maxSqlQueryRegressionPercent');
  assertFiniteNonNegative(policy.minThroughputPercentOfBaseline, 'minThroughputPercentOfBaseline');
  if (policy.minThroughputPercentOfBaseline > 100) {
    throw new Error('minThroughputPercentOfBaseline must not exceed 100');
  }
}

function roundUp(value: number): number {
  return Math.ceil(value * 1_000_000) / 1_000_000;
}

function roundDown(value: number): number {
  return Math.floor(value * 1_000_000) / 1_000_000;
}

function thresholdsFromBaseline(
  baseline: DatabaseNumericBudgetEntry['baseline'],
  policy: DatabaseNumericBudgetPolicy,
): DatabaseNumericBudgetEntry['thresholds'] {
  return {
    maxP95Ms: roundUp(baseline.p95Ms * (1 + policy.maxLatencyRegressionPercent / 100)),
    maxPeakRssBytes: Math.ceil(baseline.maxPeakRssBytes * (1 + policy.maxRssRegressionPercent / 100)),
    minMedianThroughputPerSecond: roundDown(
      baseline.medianThroughputPerSecond * policy.minThroughputPercentOfBaseline / 100,
    ),
    maxP95LockWaitMs: roundUp(baseline.p95LockWaitMs * (1 + policy.maxLockWaitRegressionPercent / 100)),
    maxP95SqlMs: roundUp(baseline.p95SqlMs * (1 + policy.maxSqlLatencyRegressionPercent / 100)),
    maxSqlQueries: Math.ceil(baseline.maxSqlQueries * (1 + policy.maxSqlQueryRegressionPercent / 100)),
  };
}

function matchingRawRuns(report: DatabaseBenchmarkReport, aggregate: DatabaseBenchmarkAggregate) {
  return report.rawRuns.filter(raw => aggregateKey(raw) === aggregateKey(aggregate));
}

function maxSqlQueries(report: DatabaseBenchmarkReport, aggregate: DatabaseBenchmarkAggregate): number {
  const runs = matchingRawRuns(report, aggregate);
  if (runs.length !== aggregate.runs) {
    throw new Error(`${aggregateKey(aggregate)} has ${runs.length} raw runs; expected ${aggregate.runs}`);
  }
  if (runs.some(run => run.error !== null)) {
    throw new Error(`${aggregateKey(aggregate)} contains failed raw runs`);
  }
  return Math.max(...runs.map(run => run.sqlQueries));
}

function assertCandidateSourceEligible(report: DatabaseBenchmarkReport): void {
  if (report.status !== 'executed') throw new Error('numeric budget requires an executed benchmark report');
  if (report.providerRequestCount !== 0) throw new Error('numeric budget source attempted a provider request');
  if (!report.environment.containerResources) {
    throw new Error('numeric budget source requires explicit container CPU and memory limits');
  }
  if (report.aggregates.length === 0) throw new Error('numeric budget source has no aggregates');
  const keys = new Set<string>();
  for (const aggregate of report.aggregates) {
    const key = aggregateKey(aggregate);
    if (keys.has(key)) throw new Error(`numeric budget source has duplicate aggregate: ${key}`);
    keys.add(key);
    if (!Number.isSafeInteger(aggregate.runs) || aggregate.runs < 1) {
      throw new Error(`${key} must contain at least one run`);
    }
    if (aggregate.failedRuns !== 0 || aggregate.succeededRuns !== aggregate.runs) {
      throw new Error(`${key} is not a complete successful aggregate`);
    }
    maxSqlQueries(report, aggregate);
  }
  assertAggregatesMatchRawRuns(report);
}

function assertAggregatesMatchRawRuns(report: DatabaseBenchmarkReport): void {
  const recomputed = new Map(
    aggregateDatabaseBenchmarkRuns(report.rawRuns).map(aggregate => [aggregateKey(aggregate), aggregate] as const),
  );
  if (recomputed.size !== report.aggregates.length) {
    throw new Error('database benchmark aggregates do not match raw runs');
  }
  for (const aggregate of report.aggregates) {
    const expected = recomputed.get(aggregateKey(aggregate));
    if (!expected || !isDeepStrictEqual(aggregate, expected)) {
      throw new Error('database benchmark aggregates do not match raw runs');
    }
  }
}

function entryFromAggregate(
  report: DatabaseBenchmarkReport,
  aggregate: DatabaseBenchmarkAggregate,
  policy: DatabaseNumericBudgetPolicy,
): DatabaseNumericBudgetEntry {
  const queryCount = maxSqlQueries(report, aggregate);
  const baseline: DatabaseNumericBudgetEntry['baseline'] = {
    p95Ms: aggregate.p95Ms,
    maxPeakRssBytes: aggregate.maxPeakRssBytes,
    medianThroughputPerSecond: aggregate.medianThroughputPerSecond,
    p95LockWaitMs: aggregate.p95LockWaitMs,
    p95SqlMs: aggregate.p95SqlMs,
    maxSqlQueries: queryCount,
  };
  return {
    scenario: aggregate.scenario,
    size: aggregate.size,
    concurrency: aggregate.concurrency,
    catalogState: aggregate.catalogState,
    stage: aggregate.stage,
    throughputUnit: aggregate.throughputUnit,
    rssMeasurement: aggregate.rssMeasurement,
    baseline,
    thresholds: thresholdsFromBaseline(baseline, policy),
  };
}

export function createDatabaseNumericBudgetCandidate(
  report: DatabaseBenchmarkReport,
  policy: DatabaseNumericBudgetPolicy,
  sourceReportSha256: string,
): DatabaseNumericBudget {
  validatePolicy(policy);
  if (!/^sha256:[a-f0-9]{64}$/iu.test(sourceReportSha256)) {
    throw new Error('source report SHA-256 must use the sha256:<digest> format');
  }
  assertCandidateSourceEligible(report);
  return {
    version: 'standardization-database-numeric-budget-v1',
    status: 'candidate',
    sourceReport: { generatedAt: report.generatedAt, sha256: sourceReportSha256 },
    environment: report.environment,
    configuration: report.configuration,
    policy,
    approval: null,
    entries: report.aggregates.map(aggregate => entryFromAggregate(report, aggregate, policy)),
  };
}

function assertApprovedBudget(budget: DatabaseNumericBudget): void {
  if (budget.status !== 'approved') throw new Error('database numeric budget is not approved');
  if (!budget.approval?.approvedBy.trim()
    || !budget.approval.rationale.trim()
    || !Number.isFinite(Date.parse(budget.approval.approvedAt))) {
    throw new Error('database numeric budget approval metadata is required');
  }
}

function measuredEntries(report: DatabaseBenchmarkReport): Map<string, {
  readonly aggregate: DatabaseBenchmarkAggregate;
  readonly maxSqlQueries: number;
}> {
  assertAggregatesMatchRawRuns(report);
  const result = new Map<string, { aggregate: DatabaseBenchmarkAggregate; maxSqlQueries: number }>();
  for (const aggregate of report.aggregates) {
    const key = aggregateKey(aggregate);
    if (result.has(key)) throw new Error(`database benchmark has duplicate aggregate: ${key}`);
    result.set(key, { aggregate, maxSqlQueries: maxSqlQueries(report, aggregate) });
  }
  return result;
}

function assertThreshold(value: number, name: string): void {
  assertFiniteNonNegative(value, name);
}

export function validateApprovedDatabaseBenchmarkBaseline(
  budget: DatabaseNumericBudget,
  baselineSource: DatabaseBenchmarkBaselineSource,
): void {
  assertApprovedBudget(budget);
  validatePolicy(budget.policy);
  const sha256 = `sha256:${createHash('sha256').update(baselineSource.rawJson).digest('hex')}`;
  if (sha256 !== budget.sourceReport.sha256) {
    throw new Error('source report SHA-256 does not match the approved budget');
  }
  if (!isDeepStrictEqual(JSON.parse(baselineSource.rawJson), baselineSource.report)) {
    throw new Error('baseline report content does not match its raw JSON');
  }
  assertCandidateSourceEligible(baselineSource.report);
  if (baselineSource.report.generatedAt !== budget.sourceReport.generatedAt
    || !isDeepStrictEqual(baselineSource.report.environment, budget.environment)
    || !isDeepStrictEqual(baselineSource.report.configuration, budget.configuration)
    || !isDeepStrictEqual(
      baselineSource.report.aggregates.map(aggregate => entryFromAggregate(baselineSource.report, aggregate, budget.policy)),
      budget.entries,
    )) {
    throw new Error('database numeric budget baseline entries do not match the source report');
  }
}

export function validateDatabaseNumericBudget(
  report: DatabaseBenchmarkReport,
  budget: DatabaseNumericBudget,
  baselineSource: DatabaseBenchmarkBaselineSource,
): void {
  validateApprovedDatabaseBenchmarkBaseline(budget, baselineSource);
  if (!isDeepStrictEqual(report.environment, budget.environment)) {
    throw new Error('database benchmark environment fingerprint does not match the approved budget');
  }
  if (!isDeepStrictEqual(report.configuration, budget.configuration)) {
    throw new Error('database benchmark configuration does not match the approved budget');
  }
  const measured = measuredEntries(report);
  const expectedKeys = new Set<string>();
  for (const entry of budget.entries) {
    const key = aggregateKey(entry);
    if (expectedKeys.has(key)) throw new Error(`database numeric budget has duplicate entry: ${key}`);
    expectedKeys.add(key);
    const current = measured.get(key);
    if (!current) throw new Error(`database numeric budget aggregate coverage does not match: missing ${key}`);
    const thresholds = entry.thresholds;
    if (!isDeepStrictEqual(thresholds, thresholdsFromBaseline(entry.baseline, budget.policy))) {
      throw new Error(`${key} thresholds do not match the approved policy`);
    }
    assertThreshold(thresholds.maxP95Ms, `${key}.maxP95Ms`);
    assertThreshold(thresholds.maxPeakRssBytes, `${key}.maxPeakRssBytes`);
    assertThreshold(thresholds.minMedianThroughputPerSecond, `${key}.minMedianThroughputPerSecond`);
    assertThreshold(thresholds.maxP95LockWaitMs, `${key}.maxP95LockWaitMs`);
    assertThreshold(thresholds.maxP95SqlMs, `${key}.maxP95SqlMs`);
    assertThreshold(thresholds.maxSqlQueries, `${key}.maxSqlQueries`);
    if (current.aggregate.p95Ms > thresholds.maxP95Ms) throw new Error(`${key} p95Ms exceeded the approved budget`);
    if (current.aggregate.maxPeakRssBytes > thresholds.maxPeakRssBytes) {
      throw new Error(`${key} maxPeakRssBytes exceeded the approved budget`);
    }
    if (current.aggregate.medianThroughputPerSecond < thresholds.minMedianThroughputPerSecond) {
      throw new Error(`${key} medianThroughputPerSecond fell below the approved budget`);
    }
    if (current.aggregate.p95LockWaitMs > thresholds.maxP95LockWaitMs) {
      throw new Error(`${key} p95LockWaitMs exceeded the approved budget`);
    }
    if (current.aggregate.p95SqlMs > thresholds.maxP95SqlMs) {
      throw new Error(`${key} p95SqlMs exceeded the approved budget`);
    }
    if (current.maxSqlQueries > thresholds.maxSqlQueries) {
      throw new Error(`${key} maxSqlQueries exceeded the approved budget`);
    }
  }
  if (measured.size !== expectedKeys.size) {
    const unexpected = [...measured.keys()].filter(key => !expectedKeys.has(key));
    throw new Error(`database numeric budget aggregate coverage does not match: unexpected ${unexpected.join(', ')}`);
  }
}

export function validateDatabaseBenchmarkAgainstBudget(
  report: DatabaseBenchmarkReport,
  budget: StandardizationPerformanceBudget,
  baselineSource: DatabaseBenchmarkBaselineSource,
): void {
  validateExecutedDatabaseBenchmark(report);
  if (budget.databaseNumeric.status === 'pending_target_container_measurement') {
    throw new Error(`database numeric budget is pending: ${budget.databaseNumeric.reason}`);
  }
  validateDatabaseNumericBudget(report, budget.databaseNumeric, baselineSource);
}

function optionValue(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  if (index < 0) return undefined;
  const value = arguments_[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function requiredOption(arguments_: readonly string[], name: string): string {
  const value = optionValue(arguments_, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredNumberOption(arguments_: readonly string[], name: string): number {
  const raw = requiredOption(arguments_, name);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}

async function readJson<T>(filePath: string): Promise<{ readonly parsed: T; readonly source: string }> {
  const source = await readFile(filePath, 'utf8');
  return { parsed: JSON.parse(source) as T, source };
}

async function writeNewFileExclusively(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value, { encoding: 'utf8', flag: 'wx' });
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  const reportPath = requiredOption(arguments_, '--report');
  const reportFile = await readJson<DatabaseBenchmarkReport>(reportPath);
  if (arguments_.includes('--write-candidate')) {
    validateExecutedDatabaseBenchmark(reportFile.parsed);
    const baseBudgetPath = requiredOption(arguments_, '--base-budget');
    const outputPath = requiredOption(arguments_, '--output');
    const baseBudget = (await readJson<StandardizationPerformanceBudget>(baseBudgetPath)).parsed;
    const candidate = createDatabaseNumericBudgetCandidate(reportFile.parsed, {
      maxLatencyRegressionPercent: requiredNumberOption(arguments_, '--max-latency-regression-percent'),
      maxRssRegressionPercent: requiredNumberOption(arguments_, '--max-rss-regression-percent'),
      minThroughputPercentOfBaseline: requiredNumberOption(arguments_, '--min-throughput-percent-of-baseline'),
      maxLockWaitRegressionPercent: requiredNumberOption(arguments_, '--max-lock-wait-regression-percent'),
      maxSqlLatencyRegressionPercent: requiredNumberOption(arguments_, '--max-sql-latency-regression-percent'),
      maxSqlQueryRegressionPercent: requiredNumberOption(arguments_, '--max-sql-query-regression-percent'),
    }, `sha256:${createHash('sha256').update(reportFile.source).digest('hex')}`);
    await writeNewFileExclusively(outputPath, `${JSON.stringify({ ...baseBudget, databaseNumeric: candidate }, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ status: 'candidate_written', outputPath, entries: candidate.entries.length })}\n`);
    return;
  }
  if (arguments_.includes('--check')) {
    const budgetPath = requiredOption(arguments_, '--budget');
    const baselinePath = requiredOption(arguments_, '--baseline-report');
    const budget = (await readJson<StandardizationPerformanceBudget>(budgetPath)).parsed;
    const baselineFile = await readJson<DatabaseBenchmarkReport>(baselinePath);
    validateDatabaseBenchmarkAgainstBudget(reportFile.parsed, budget, {
      report: baselineFile.parsed, rawJson: baselineFile.source,
    });
    process.stdout.write(`${JSON.stringify({ status: 'passed', entries: budget.databaseNumeric.status === 'approved' ? budget.databaseNumeric.entries.length : 0 })}\n`);
    return;
  }
  throw new Error('specify --write-candidate or --check');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

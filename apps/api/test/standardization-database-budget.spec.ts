import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createDatabaseNumericBudgetCandidate,
  validateDatabaseBenchmarkAgainstBudget,
  validateDatabaseNumericBudget,
  type DatabaseNumericBudget,
  type DatabaseNumericBudgetPolicy,
  type StandardizationPerformanceBudget,
} from '../perf/standardization-database-budget.js';
import type {
  DatabaseBenchmarkAggregate,
  DatabaseBenchmarkRawRun,
  DatabaseBenchmarkReport,
} from '../perf/standardization-database-benchmark.js';
import { aggregateDatabaseBenchmarkRuns } from '../perf/standardization-database-benchmark.js';

const policy: DatabaseNumericBudgetPolicy = {
  maxLatencyRegressionPercent: 20,
  maxRssRegressionPercent: 10,
  minThroughputPercentOfBaseline: 90,
  maxLockWaitRegressionPercent: 25,
  maxSqlLatencyRegressionPercent: 15,
  maxSqlQueryRegressionPercent: 0,
};
const sourceReportSha256 = `sha256:${createHash('sha256').update(JSON.stringify(report())).digest('hex')}`;

function aggregate(overrides: Partial<DatabaseBenchmarkAggregate> = {}): DatabaseBenchmarkAggregate {
  return {
    scenario: 'balanced', size: 1_000, uniqueInputs: 820, directoryProducts: 205,
    evidenceBytes: 1_024, logicalTagRows: 64, expandedTagRows: 128,
    concurrency: 1, catalogState: 'warm', stage: 'candidate_query',
    throughputUnit: 'inputs', rssMeasurement: 'sampled_peak', runs: 5,
    succeededRuns: 5, failedRuns: 0, medianMs: 100, p95Ms: 100,
    medianCpuMs: 50, p95SqlMs: 20, maxPeakRssBytes: 1_000,
    p95TransactionMs: 30, p95LockWaitMs: 8, p95QueueWaitMs: 4,
    medianThroughputPerSecond: 200, maxScanned: 20, maxCompared: 10,
    maxCandidateCount: 5, maxTruncatedCount: 0, maxSelectionVisits: 0,
    maxPeakScratchCandidates: 0, maxRetainedFeatureCount: 0,
    maxProcessedChangeCount: 0, maxRebuiltDocumentCount: 0, maxDeltaDocumentCount: 0,
    maxTombstoneCount: 0, maxCompactionCount: 0, maxChangedProducts: 0,
    maxRoutePostingsVisited: 0, maxDeterministicGroups: 0, maxDeterministicEdges: 0,
    maxSuspectedPairs: 0, totalProcessedItems: 100, totalWrittenRows: 0,
    totalWrittenTagRows: 0, totalWrittenBytes: 0,
    ...overrides,
  };
}

function rawRun(summary: DatabaseBenchmarkAggregate, sqlQueries: number, run = 1): DatabaseBenchmarkRawRun {
  return {
    scenario: summary.scenario, size: summary.size, uniqueInputs: summary.uniqueInputs,
    directoryProducts: summary.directoryProducts, evidenceBytes: summary.evidenceBytes,
    logicalTagRows: summary.logicalTagRows, expandedTagRows: summary.expandedTagRows,
    concurrency: summary.concurrency, catalogState: summary.catalogState, run,
    stage: summary.stage, durationMs: summary.p95Ms, cpuMs: summary.medianCpuMs,
    processId: 1, startRssBytes: 900, endRssBytes: 950,
    startHeapUsedBytes: 400, endHeapUsedBytes: 450,
    peakRssBytes: summary.maxPeakRssBytes, rssMeasurement: summary.rssMeasurement,
    sqlQueries, sqlP95Ms: summary.p95SqlMs, transactionMs: summary.p95TransactionMs,
    lockWaitMs: summary.p95LockWaitMs, queueWaitMs: summary.p95QueueWaitMs,
    throughputPerSecond: summary.medianThroughputPerSecond, processedItems: 20,
    throughputUnit: summary.throughputUnit, scanned: summary.maxScanned,
    compared: summary.maxCompared, candidateCount: summary.maxCandidateCount,
    truncatedCount: summary.maxTruncatedCount, selectionVisits: summary.maxSelectionVisits,
    peakScratchCandidates: summary.maxPeakScratchCandidates,
    retainedFeatureCount: summary.maxRetainedFeatureCount,
    processedChangeCount: summary.maxProcessedChangeCount,
    rebuiltDocumentCount: summary.maxRebuiltDocumentCount,
    deltaDocumentCount: summary.maxDeltaDocumentCount, tombstoneCount: summary.maxTombstoneCount,
    compactionCount: summary.maxCompactionCount, changedProducts: summary.maxChangedProducts,
    routePostingsVisited: summary.maxRoutePostingsVisited,
    deterministicGroups: summary.maxDeterministicGroups,
    deterministicEdges: summary.maxDeterministicEdges,
    suspectedPairs: summary.maxSuspectedPairs, writtenRows: 0, writtenTagRows: 0,
    writtenBytes: 0, error: null,
  };
}

function report(
  overrides: Partial<DatabaseBenchmarkAggregate> = {},
  sqlQueries = 3,
): DatabaseBenchmarkReport {
  const summary = aggregate(overrides);
  const rawRuns = Array.from(
    { length: summary.runs },
    (_, runIndex) => rawRun(summary, sqlQueries, runIndex + 1),
  );
  return {
    status: 'executed', generatedAt: '2026-09-21T01:00:00.000Z', schema: 'benchmark_schema',
    configuration: {
      sizes: [1_000], concurrencyLevels: [1], runsPerScenario: 5, scenarios: ['balanced'],
      connectionBudget: {
        poolMax: 10, applicationRoles: { api: 1, crawler: 1, ai: 1, standardization: 1 },
        applicationTotal: 4, adminConnections: 1, benchmarkConcurrency: 1,
        requiredConnections: 6, remainingConnections: 4,
      },
      seed: 20260920,
    },
    environment: {
      node: 'v24.13.1', platform: 'linux', release: '6.8.0', arch: 'x64',
      cpuModel: 'deployment-cpu', cpuCount: 4, totalMemoryBytes: 4_294_967_296,
      containerResources: { cpuLimit: 2, memoryLimitBytes: 4_294_967_296 },
      postgresVersion: '16.10', postgresSettings: { work_mem: '4MB' }, policyVersion: 'identity-v1',
    },
    rawRuns,
    aggregates: aggregateDatabaseBenchmarkRuns(rawRuns),
    explainPlans: {}, providerRequestCount: 0,
  };
}

function baselineSource(source: DatabaseBenchmarkReport) {
  return { report: source, rawJson: JSON.stringify(source) };
}

function approve(candidate: DatabaseNumericBudget): DatabaseNumericBudget {
  return {
    ...candidate,
    status: 'approved',
    approval: {
      approvedBy: 'performance-reviewer',
      approvedAt: '2026-09-21T02:00:00.000Z',
      rationale: 'Reviewed against the deployment container resource limits.',
    },
  };
}

function document(databaseNumeric: DatabaseNumericBudget): StandardizationPerformanceBudget {
  return {
    version: 'standardization-performance-20260920-v2',
    environmentFingerprint: { nodeMajor: 24, platform: 'win32', arch: 'x64' },
    seed: 20260920,
    structuralLimits: {
      maxInputItems: 32, maxInputBytes: 24_576, maxPostingsPerFeature: 256,
      maxComparedPerIdentity: 100, topSuspectsPerIdentity: 10, maxReportedSuspectPairs: 10_000,
    },
    scenarios: {},
    databaseNumeric,
  };
}

test('numeric budget candidate records explicit policy, report identity and hand-derived thresholds', () => {
  const source = report();
  const candidate = createDatabaseNumericBudgetCandidate(source, policy, sourceReportSha256);

  assert.equal(candidate.status, 'candidate');
  assert.equal(candidate.approval, null);
  assert.deepEqual(candidate.environment, source.environment);
  assert.deepEqual(candidate.configuration, source.configuration);
  assert.deepEqual(candidate.policy, policy);
  assert.deepEqual(candidate.sourceReport, {
    generatedAt: source.generatedAt,
    sha256: sourceReportSha256,
  });
  assert.deepEqual(candidate.entries[0]?.baseline, {
    p95Ms: 100,
    maxPeakRssBytes: 1_000,
    medianThroughputPerSecond: 200,
    p95LockWaitMs: 8,
    p95SqlMs: 20,
    maxSqlQueries: 3,
  });
  assert.deepEqual(candidate.entries[0]?.thresholds, {
    maxP95Ms: 120,
    maxPeakRssBytes: 1_100,
    minMedianThroughputPerSecond: 180,
    maxP95LockWaitMs: 10,
    maxP95SqlMs: 23,
    maxSqlQueries: 3,
  });
});

test('numeric budget candidate rejects an invalid report identity and incomplete aggregates', () => {
  const source = report();
  assert.throws(
    () => createDatabaseNumericBudgetCandidate(source, policy, 'sha256:a'),
    /source report SHA-256/u,
  );
  assert.throws(
    () => createDatabaseNumericBudgetCandidate({
      ...source,
      environment: { ...source.environment, containerResources: null },
    }, policy, sourceReportSha256),
    /explicit container CPU and memory limits/u,
  );
  assert.throws(
    () => createDatabaseNumericBudgetCandidate(
      {
        ...report(),
        rawRuns: [],
        aggregates: [aggregate({ runs: 0, succeededRuns: 0 })],
      },
      policy,
      sourceReportSha256,
    ),
    /must contain at least one run/u,
  );
});

test('approved numeric budget passes only for the same environment and configuration', () => {
  const source = report();
  const budget = approve(createDatabaseNumericBudgetCandidate(source, policy, sourceReportSha256));

  assert.doesNotThrow(() => validateDatabaseNumericBudget(source, budget, baselineSource(source)));
  assert.throws(
    () => validateDatabaseNumericBudget({
      ...source,
      environment: { ...source.environment, cpuCount: 8 },
    }, budget, baselineSource(source)),
    /environment fingerprint does not match/u,
  );
  assert.throws(
    () => validateDatabaseNumericBudget({
      ...source,
      configuration: { ...source.configuration, seed: 20260921 },
    }, budget, baselineSource(source)),
    /configuration does not match/u,
  );
});

test('numeric budget rejects latency, RSS, throughput, lock, SQL latency and query regressions', () => {
  const source = report();
  const budget = approve(createDatabaseNumericBudgetCandidate(source, policy, sourceReportSha256));
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly expected: RegExp;
    readonly aggregate: Partial<DatabaseBenchmarkAggregate>;
    readonly sqlQueries?: number;
  }> = [
    { name: 'latency', expected: /p95Ms exceeded/u, aggregate: { p95Ms: 121 } },
    { name: 'RSS', expected: /maxPeakRssBytes exceeded/u, aggregate: { maxPeakRssBytes: 1_101 } },
    { name: 'throughput', expected: /medianThroughputPerSecond fell below/u, aggregate: { medianThroughputPerSecond: 179 } },
    { name: 'lock', expected: /p95LockWaitMs exceeded/u, aggregate: { p95LockWaitMs: 11 } },
    { name: 'SQL latency', expected: /p95SqlMs exceeded/u, aggregate: { p95SqlMs: 24 } },
    { name: 'query count', expected: /maxSqlQueries exceeded/u, aggregate: {}, sqlQueries: 4 },
  ];

  for (const item of cases) {
    const measured = report(item.aggregate, item.sqlQueries ?? 3);
    assert.throws(
      () => validateDatabaseNumericBudget(measured, budget, baselineSource(source)),
      item.expected,
      item.name,
    );
  }
});

test('numeric budget rejects candidates, missing aggregates and unapproved approval records', () => {
  const source = report();
  const candidate = createDatabaseNumericBudgetCandidate(source, policy, sourceReportSha256);

  assert.throws(() => validateDatabaseNumericBudget(source, candidate, baselineSource(source)), /budget is not approved/u);
  assert.throws(
    () => validateDatabaseNumericBudget({ ...source, rawRuns: [], aggregates: [] }, approve(candidate), baselineSource(source)),
    /aggregate coverage does not match/u,
  );
  assert.throws(
    () => validateDatabaseNumericBudget(source, { ...candidate, status: 'approved' }, baselineSource(source)),
    /approval metadata is required/u,
  );
  const approved = approve(candidate);
  assert.throws(
    () => validateDatabaseNumericBudget(source, {
      ...approved,
      entries: [{
        ...approved.entries[0]!,
        thresholds: { ...approved.entries[0]!.thresholds, maxP95Ms: 999_999 },
      }],
    }, baselineSource(source)),
    /baseline entries do not match the source report/u,
  );
});

test('numeric budget rejects aggregate values that do not match raw runs', () => {
  const source = report();
  const tampered = {
    ...source,
    aggregates: [{ ...source.aggregates[0]!, p95Ms: 1 }],
  };

  assert.throws(
    () => createDatabaseNumericBudgetCandidate(tampered, policy, sourceReportSha256),
    /aggregates do not match raw runs/u,
  );
});

test('approved numeric budget rejects baseline values changed after source approval', () => {
  const source = report();
  const approved = approve(createDatabaseNumericBudgetCandidate(source, policy, sourceReportSha256));
  const altered = {
    ...approved,
    entries: [{
      ...approved.entries[0]!,
      baseline: { ...approved.entries[0]!.baseline, p95Ms: 1_000 },
      thresholds: { ...approved.entries[0]!.thresholds, maxP95Ms: 1_200 },
    }],
  };
  assert.throws(
    () => validateDatabaseNumericBudget(source, altered, { report: source, rawJson: JSON.stringify(source) }),
    /baseline entries do not match the source report/u,
  );
});

test('approved numeric budget rejects a source report whose content differs from its stored hash', () => {
  const source = report();
  const approved = approve(createDatabaseNumericBudgetCandidate(source, policy, sourceReportSha256));
  assert.throws(
    () => validateDatabaseNumericBudget(source, approved, {
      report: source,
      rawJson: `${JSON.stringify(source)}\n`,
    }),
    /source report SHA-256 does not match/u,
  );
});

test('combined budget check runs structural validation before numeric acceptance', () => {
  const source = report();
  const budget = document(approve(createDatabaseNumericBudgetCandidate(source, policy, sourceReportSha256)));
  const structurallyInvalid = { ...source, providerRequestCount: 1 } as unknown as DatabaseBenchmarkReport;

  assert.throws(
    () => validateDatabaseBenchmarkAgainstBudget(structurallyInvalid, budget, baselineSource(source)),
    /attempted a provider request/u,
  );
});

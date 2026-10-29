import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DATABASE_BENCHMARK_SCENARIOS,
  DATABASE_BENCHMARK_LOCAL_STAGES,
  aggregateDatabaseBenchmarkRuns,
  buildDatabaseBenchmarkFixturePreview,
  buildDatabaseBenchmarkScenarioMatrix,
  createDatabaseBenchmarkSchemaName,
  calculateDatabaseBenchmarkProgress,
  databaseBenchmarkConfiguration,
  databaseBenchmarkContainerResources,
  validateDatabaseBenchmarkContainerCgroup,
  databaseBenchmarkNotExecuted,
  databaseBenchmarkTotalStageUnits,
  formatDatabaseBenchmarkProgress,
  finalizeSampledMemoryMeasurement,
  planDatabaseBenchmarkResume,
  postgresShowValue,
  publishDatabaseBenchmarkCheckpoint,
  publishDatabaseBenchmarkReport,
  resumeFailedLocalDatabaseBenchmarkRuns,
  runDatabaseBenchmarkLocalStageInCurrentProcess,
  runDatabaseBenchmarkLocalScenario,
  validateDatabaseBenchmarkExplainPlans,
  validateDatabaseBenchmarkRunIds,
  validateDatabaseBenchmarkConnectionBudget,
  validateExecutedDatabaseBenchmark,
  validateDatabaseBenchmarkScenarioCoverage,
  type DatabaseBenchmarkReport,
  type DatabaseBenchmarkCheckpoint,
  type DatabaseBenchmarkRawRun,
} from '../perf/standardization-database-benchmark.js';
import type { StandardizationPerformanceBudget } from '../perf/standardization-database-budget.js';

function benchmarkRawRun(overrides: Partial<DatabaseBenchmarkRawRun> = {}): DatabaseBenchmarkRawRun {
  return {
    scenario: 'balanced', size: 1_000, uniqueInputs: 820, directoryProducts: 205, evidenceBytes: 1_024,
    logicalTagRows: 0, expandedTagRows: 0, concurrency: 1, catalogState: 'local',
    run: 1, stage: 'candidate_index_build', durationMs: 10, cpuMs: 5,
    processId: process.pid, startRssBytes: 900, endRssBytes: 950,
    startHeapUsedBytes: 400, endHeapUsedBytes: 450, peakRssBytes: 1_000,
    rssMeasurement: 'sampled_peak', sqlQueries: 0, sqlP95Ms: 0, transactionMs: 0,
    lockWaitMs: 0, queueWaitMs: 0, throughputPerSecond: 10, processedItems: 2,
    throughputUnit: 'inputs', scanned: 20, compared: 10, candidateCount: 5, truncatedCount: 1,
    selectionVisits: 0, peakScratchCandidates: 0, retainedFeatureCount: 0,
    processedChangeCount: 0, rebuiltDocumentCount: 0, deltaDocumentCount: 0, tombstoneCount: 0,
    compactionCount: 0, changedProducts: 0, routePostingsVisited: 0, deterministicGroups: 0,
    deterministicEdges: 0, suspectedPairs: 0, writtenRows: 0, writtenTagRows: 0,
    writtenBytes: 0, error: null,
    ...overrides,
  };
}

function benchmarkCheckpoint(rawRuns: readonly DatabaseBenchmarkRawRun[]): DatabaseBenchmarkCheckpoint {
  return {
    status: 'in_progress',
    generatedAt: '2026-09-21T00:15:00.000Z',
    startedAt: '2026-09-21T00:00:00.000Z',
    activeElapsedMs: 900_000,
    schema: 'old_schema',
    configuration: {
      sizes: [1_000, 5_000, 10_000],
      concurrencyLevels: [1, 2],
      runsPerScenario: 5,
      scenarios: DATABASE_BENCHMARK_SCENARIOS.map(scenario => scenario.name),
      connectionBudget: {} as DatabaseBenchmarkReport['configuration']['connectionBudget'],
      seed: 20260920,
    },
    environment: {
      node: 'v24.13.1', platform: 'win32', release: 'test', arch: 'x64',
      cpuModel: 'test-cpu', cpuCount: 8, totalMemoryBytes: 16_000,
      containerResources: null,
      postgresVersion: '18.4', postgresSettings: { work_mem: '4MB' }, policyVersion: 'identity-v1',
    },
    rawRuns,
    explainPlans: {},
    providerRequestCount: 0,
  };
}

test('database benchmark progress includes completed work, elapsed time and ETA', () => {
  assert.equal(databaseBenchmarkTotalStageUnits({
    matrixEntries: 15,
    runsPerScenario: 5,
    concurrencyLevels: [1, 2],
  }), 2_400);

  const progress = calculateDatabaseBenchmarkProgress({
    completedUnits: 600,
    totalUnits: 2_400,
    activeElapsedMs: 15 * 60_000,
    current: 'balanced/10000/input_grouping/run-2',
  });

  assert.deepEqual(progress, {
    type: 'standardization_benchmark_progress',
    completedUnits: 600,
    totalUnits: 2_400,
    percent: 25,
    elapsedMs: 900_000,
    etaMs: 2_700_000,
    current: 'balanced/10000/input_grouping/run-2',
  });
  assert.equal(
    formatDatabaseBenchmarkProgress(progress),
    '[standardization-benchmark] 600/2400 (25.00%) elapsed=00:15:00 eta=00:45:00 current=balanced/10000/input_grouping/run-2',
  );
});

test('database benchmark progress reports an unknown ETA before the first unit completes', () => {
  const progress = calculateDatabaseBenchmarkProgress({
    completedUnits: 0,
    totalUnits: 2_400,
    activeElapsedMs: 12_000,
    current: 'starting',
  });

  assert.equal(progress.etaMs, null);
  assert.match(formatDatabaseBenchmarkProgress(progress), /eta=calculating/u);
});

test('database benchmark resume retains successful local stages and reruns failed local stages', () => {
  const successful = benchmarkRawRun({ stage: 'candidate_index_build' });
  const failed = benchmarkRawRun({ stage: 'input_grouping', error: 'interrupted' });
  const checkpoint = benchmarkCheckpoint([successful, failed]);

  const plan = planDatabaseBenchmarkResume(checkpoint, {
    configuration: checkpoint.configuration,
    environment: checkpoint.environment,
  });

  assert.deepEqual(plan.rawRuns, [successful]);
  assert.equal(plan.completedUnits, 1);
  assert.equal(plan.activeElapsedMs, 900_000);
});

test('database benchmark resume retains complete database iterations and discards partial iterations', () => {
  const databaseStages = [
    'request_preparation', 'candidate_query', 'rolling_window_claim',
    'lock_contention', 'publication_commit', 'finalization',
  ];
  const complete = databaseStages.map(stage => benchmarkRawRun({
    stage, concurrency: 2, catalogState: 'warm', run: 1,
  }));
  const partial = databaseStages.slice(0, 3).map(stage => benchmarkRawRun({
    stage, concurrency: 1, catalogState: 'cold', run: 2,
  }));
  const checkpoint = benchmarkCheckpoint([...complete, ...partial]);

  const plan = planDatabaseBenchmarkResume(checkpoint, {
    configuration: checkpoint.configuration,
    environment: checkpoint.environment,
  });

  assert.deepEqual(plan.rawRuns, complete);
  assert.equal(plan.completedUnits, 6);
});

test('database benchmark resume rejects configuration and environment mismatches', () => {
  const checkpoint = benchmarkCheckpoint([]);
  assert.throws(() => planDatabaseBenchmarkResume(checkpoint, {
    configuration: { ...checkpoint.configuration, runsPerScenario: 6 },
    environment: checkpoint.environment,
  }), /configuration does not match/u);
  assert.throws(() => planDatabaseBenchmarkResume(checkpoint, {
    configuration: checkpoint.configuration,
    environment: { ...checkpoint.environment, cpuCount: 16 },
  }), /environment does not match/u);
});

test('local benchmark scenario exposes a recoverable boundary after every stage', async () => {
  const started: string[] = [];
  const completed: DatabaseBenchmarkRawRun[] = [];
  const runs = await runDatabaseBenchmarkLocalScenario({
    size: 1_000,
    scenario: 'balanced',
    seed: 20260920,
    run: 1,
  }, {
    runLocalStage: async input => benchmarkRawRun({
      size: input.size,
      scenario: input.scenario,
      run: input.run,
      stage: input.stage,
    }),
    onStageStart: input => { started.push(input.stage); },
    onStageComplete: run => { completed.push(run); },
  });

  assert.deepEqual(started, DATABASE_BENCHMARK_LOCAL_STAGES);
  assert.deepEqual(runs.map(run => run.stage), DATABASE_BENCHMARK_LOCAL_STAGES);
  assert.deepEqual(completed, runs);
});

test('database stage final memory is sampled once and included in peak RSS', () => {
  let reads = 0;
  const memoryUsage = (): NodeJS.MemoryUsage => {
    reads += 1;
    return {
      rss: 1_000 + reads * 100,
      heapTotal: 800,
      heapUsed: 600,
      external: 100,
      arrayBuffers: 50,
    };
  };

  const measurement = finalizeSampledMemoryMeasurement(1_050, memoryUsage);

  assert.equal(reads, 1);
  assert.equal(measurement.endMemory.rss, 1_100);
  assert.equal(measurement.peakRssBytes, 1_100);
});

test('checked database benchmark persists its report before surfacing validation failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'database-benchmark-report-'));
  const outputPath = join(directory, 'report.json');
  const invalidReport = {
    providerRequestCount: 0,
    configuration: {
      scenarios: ['balanced'],
      sizes: [1_000, 5_000, 10_000],
      concurrencyLevels: [1, 2],
      runsPerScenario: 5,
    },
    rawRuns: [],
    explainPlans: {},
  } as unknown as DatabaseBenchmarkReport;

  try {
    await assert.rejects(
      publishDatabaseBenchmarkReport(invalidReport, { check: true, outputPath }),
      /missing required scenarios/,
    );
    assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), invalidReport);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('database benchmark refuses a numeric budget unless structural checking is enabled', async () => {
  const invalidReport = {
    status: 'executed',
    providerRequestCount: 0,
    configuration: { scenarios: [], sizes: [], concurrencyLevels: [], runsPerScenario: 0 },
    rawRuns: [], aggregates: [], explainPlans: {},
  } as unknown as DatabaseBenchmarkReport;
  const performanceBudget = {
    databaseNumeric: {
      status: 'pending_target_container_measurement',
      reason: 'target container has not been measured',
    },
  } as unknown as StandardizationPerformanceBudget;

  await assert.rejects(
    publishDatabaseBenchmarkReport(invalidReport, { check: false, performanceBudget }),
    /performance budget requires --check/u,
  );
  await assert.rejects(
    publishDatabaseBenchmarkReport(invalidReport, { check: true, performanceBudget }),
    /performance budget requires a baseline report/u,
  );
});

test('database benchmark refuses to overwrite its approved baseline report', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import', 'tsx', 'apps/api/perf/standardization-database-benchmark.ts', '--check',
      '--performance-budget', 'approved-budget.json',
      '--baseline-report', 'baseline.json', '--output', 'baseline.json',
    ],
    { cwd: process.cwd(), env: process.env, encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--baseline-report must differ from --output or --resume/u);
});

test('database benchmark persists an interruption-safe checkpoint atomically', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'database-benchmark-checkpoint-'));
  const outputPath = join(directory, 'checkpoint.json');
  const checkpoint = benchmarkCheckpoint([benchmarkRawRun()]);

  try {
    await publishDatabaseBenchmarkCheckpoint(checkpoint, outputPath);
    assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), checkpoint);
    const updated = { ...checkpoint, activeElapsedMs: 960_000 };
    await publishDatabaseBenchmarkCheckpoint(updated, outputPath);
    assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), updated);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('database benchmark resume replaces only failed local runs and recomputes aggregates', async () => {
  const successful = await runDatabaseBenchmarkLocalStageInCurrentProcess({
    size: 200,
    scenario: 'balanced',
    seed: 20260920,
    run: 1,
    stage: 'candidate_index_compaction_rebuild',
  });
  const failed = { ...successful, error: 'old fixture failure' };
  const report = {
    status: 'executed',
    generatedAt: '2026-09-20T00:00:00.000Z',
    schema: 'already_dropped',
    configuration: {
      sizes: [1_000, 5_000, 10_000],
      concurrencyLevels: [1, 2],
      runsPerScenario: 5,
      scenarios: DATABASE_BENCHMARK_SCENARIOS.map(scenario => scenario.name),
      connectionBudget: {} as DatabaseBenchmarkReport['configuration']['connectionBudget'],
      seed: 20260920,
    },
    environment: { policyVersion: 'test' } as DatabaseBenchmarkReport['environment'],
    rawRuns: [failed],
    aggregates: aggregateDatabaseBenchmarkRuns([failed]),
    explainPlans: {},
    providerRequestCount: 0,
  } satisfies DatabaseBenchmarkReport;
  const calls: unknown[] = [];

  const resumed = await resumeFailedLocalDatabaseBenchmarkRuns(report, async input => {
    calls.push(input);
    return successful;
  });

  assert.deepEqual(calls, [{
    size: 200,
    scenario: 'balanced',
    seed: 20260920,
    run: 1,
    stage: 'candidate_index_compaction_rebuild',
  }]);
  assert.equal(resumed.rawRuns[0]!.error, null);
  assert.equal(resumed.aggregates[0]!.failedRuns, 0);
  assert.equal(resumed.aggregates[0]!.succeededRuns, 1);
  assert.notEqual(resumed.generatedAt, report.generatedAt);
});

test('database benchmark resume rejects failed database stages after their schema is gone', async () => {
  const report = {
    status: 'executed',
    generatedAt: '2026-09-20T00:00:00.000Z',
    schema: 'already_dropped',
    configuration: { seed: 20260920 },
    rawRuns: [{ stage: 'publication_commit', error: 'database failure' }],
    aggregates: [],
    explainPlans: {},
    providerRequestCount: 0,
  } as unknown as DatabaseBenchmarkReport;

  await assert.rejects(
    resumeFailedLocalDatabaseBenchmarkRuns(report),
    /cannot resume failed database stage publication_commit/,
  );
});

test('database benchmark reads PostgreSQL SHOW values from the setting-named column', () => {
  assert.equal(postgresShowValue({ server_version: '17.6' }, 'server_version'), '17.6');
  assert.equal(postgresShowValue({ shared_buffers: '128MB' }, 'shared_buffers'), '128MB');
  assert.equal(postgresShowValue({}, 'work_mem'), 'unknown');
});

test('database benchmark matrix covers every required data and contention profile at every size', () => {
  const matrix = buildDatabaseBenchmarkScenarioMatrix();
  assert.deepEqual(DATABASE_BENCHMARK_SCENARIOS.map(scenario => scenario.name), [
    'balanced',
    'high_duplication',
    'low_duplication',
    'retrieval_stress',
    'publication_stress',
  ]);
  assert.equal(matrix.length, 15);
  for (const size of [1_000, 5_000, 10_000]) {
    assert.deepEqual(matrix.filter(entry => entry.size === size).map(entry => entry.scenario), [
      'balanced',
      'high_duplication',
      'low_duplication',
      'retrieval_stress',
      'publication_stress',
    ]);
  }
  assert.doesNotThrow(() => validateDatabaseBenchmarkScenarioCoverage(DATABASE_BENCHMARK_SCENARIOS));
  assert.throws(
    () => validateDatabaseBenchmarkScenarioCoverage(DATABASE_BENCHMARK_SCENARIOS.filter(scenario => scenario.name !== 'publication_stress')),
    /missing required coverage: slow_publication, lock_contention/,
  );
});

test('database benchmark fixtures materially exercise duplication, retrieval and publication stress', () => {
  const balanced = buildDatabaseBenchmarkFixturePreview(1_000, 'balanced', 20260920);
  const highDuplication = buildDatabaseBenchmarkFixturePreview(1_000, 'high_duplication', 20260920);
  const lowDuplication = buildDatabaseBenchmarkFixturePreview(1_000, 'low_duplication', 20260920);
  const retrieval = buildDatabaseBenchmarkFixturePreview(1_000, 'retrieval_stress', 20260920);
  const publication = buildDatabaseBenchmarkFixturePreview(1_000, 'publication_stress', 20260920);

  assert.deepEqual(
    [balanced.uniqueInputs, highDuplication.uniqueInputs, lowDuplication.uniqueInputs],
    [820, 200, 980],
  );
  assert.ok(retrieval.evidenceBytes > balanced.evidenceBytes * 4);
  assert.ok(retrieval.highFrequencyInputCount >= 800);
  assert.ok(retrieval.unknownBrandInputCount >= 400);
  assert.ok(retrieval.mixedLanguageInputCount >= 400);
  assert.equal(publication.logicalTagRows, 0);
  assert.equal(publication.expandedTagRows, 0);
  assert.equal(publication.publicationDelayMs, 25);
  assert.equal(publication.lockHoldMs, 75);
  assert.equal(publication.incrementalChangedProducts, Math.max(1, Math.ceil(publication.directoryProducts * 0.01)));
});

test('local benchmark stages expose bounded candidate, grouping and full/incremental audit metrics', async () => {
  const runs = await runDatabaseBenchmarkLocalScenario({
    size: 200,
    scenario: 'retrieval_stress',
    seed: 20260920,
    run: 1,
  });
  assert.deepEqual(runs.map(run => run.stage), [
    'candidate_index_build',
    'candidate_index_full_rebuild_after_1pct_change',
    'candidate_index_delta_refresh_after_1pct_change',
    'candidate_index_compaction_rebuild',
    'input_grouping',
    'candidate_query_local',
    'directory_duplicate_audit_full',
    'directory_duplicate_audit_incremental',
  ]);
  assert.ok(runs.every(run => run.scenario === 'retrieval_stress'));
  assert.ok(runs.every(run => run.evidenceBytes > 0 && run.logicalTagRows >= 0 && run.expandedTagRows >= run.logicalTagRows));
  assert.ok(runs.every(run => run.error === null));
  assert.ok(runs.every(run => run.processedItems > 0 && run.throughputUnit.length > 0));
  assert.equal(new Set(runs.map(run => run.processId)).size, runs.length);
  assert.ok(runs.every(run => run.processId !== process.pid));
  assert.ok(runs.every(run => run.rssMeasurement === 'process_max_rss'));
  assert.ok(runs.every(run => Number.isSafeInteger(run.startRssBytes) && run.startRssBytes! > 0));
  assert.ok(runs.every(run => Number.isSafeInteger(run.endRssBytes) && run.endRssBytes! > 0));
  assert.ok(runs.every(run => Number.isSafeInteger(run.startHeapUsedBytes) && run.startHeapUsedBytes! > 0));
  assert.ok(runs.every(run => Number.isSafeInteger(run.endHeapUsedBytes) && run.endHeapUsedBytes! > 0));
  assert.ok(runs.every(run => run.peakRssBytes >= Math.max(run.startRssBytes!, run.endRssBytes!)));
  assert.ok(runs.every(run => Math.abs(
    run.throughputPerSecond - run.processedItems / Math.max(run.durationMs / 1_000, Number.EPSILON),
  ) < 1e-9));

  const query = runs.find(run => run.stage === 'candidate_query_local')!;
  assert.ok(query.scanned <= query.uniqueInputs * 2_000);
  assert.ok(query.compared <= query.uniqueInputs * 400);
  assert.ok(query.candidateCount <= query.uniqueInputs * 20);
  assert.ok(query.throughputPerSecond > 0);

  const grouping = runs.find(run => run.stage === 'input_grouping')!;
  assert.ok(grouping.selectionVisits! > 0);
  assert.ok(grouping.peakScratchCandidates! > 0);
  assert.ok(grouping.retainedFeatureCount! > 0);

  const delta = runs.find(run => run.stage === 'candidate_index_delta_refresh_after_1pct_change')!;
  assert.equal(delta.processedChangeCount, delta.changedProducts);
  assert.equal(delta.rebuiltDocumentCount, delta.changedProducts);
  assert.ok(delta.processedChangeCount < delta.directoryProducts);
  assert.equal(delta.compactionCount, 0);
  const compaction = runs.find(run => run.stage === 'candidate_index_compaction_rebuild')!;
  assert.equal(compaction.rebuiltDocumentCount, compaction.directoryProducts);
  assert.equal(compaction.compactionCount, 1);

  const full = runs.find(run => run.stage === 'directory_duplicate_audit_full')!;
  const incremental = runs.find(run => run.stage === 'directory_duplicate_audit_incremental')!;
  assert.ok(full.compared <= full.directoryProducts * 100);
  assert.ok(incremental.compared < full.compared);
  assert.ok(incremental.compared <= incremental.changedProducts * 100);
  assert.equal(incremental.changedProducts, Math.max(1, Math.ceil(incremental.directoryProducts * 0.01)));
  assert.equal(incremental.processedChangeCount, incremental.changedProducts);
  assert.ok(incremental.routePostingsVisited <= incremental.changedProducts * (100 + 1) * 4 * 40);
  assert.ok(full.routePostingsVisited > 0);
});

test('large-catalog one-percent duplicate audit stays on the incremental path', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import', 'tsx', 'apps/api/perf/standardization-local-stage-runner.ts',
      '--size', '10000',
      '--scenario', 'balanced',
      '--seed', '20260920',
      '--run', '1',
      '--stage', 'directory_duplicate_audit_incremental',
    ],
    { cwd: process.cwd(), env: process.env, encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  const run = JSON.parse(result.stdout) as DatabaseBenchmarkRawRun;
  assert.equal(run.error, null);
  assert.equal(run.changedProducts, 21);
  assert.equal(run.processedChangeCount, run.changedProducts);
  assert.ok(run.compared <= run.changedProducts * 100);
  assert.ok(run.routePostingsVisited <= run.changedProducts * (100 + 1) * 4 * 40);
});

test('large-catalog one-percent delta benchmark stays on the incremental path', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import', 'tsx', 'apps/api/perf/standardization-local-stage-runner.ts',
      '--size', '10000',
      '--scenario', 'balanced',
      '--seed', '20260920',
      '--run', '1',
      '--stage', 'candidate_index_delta_refresh_after_1pct_change',
    ],
    { cwd: process.cwd(), env: process.env, encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  const run = JSON.parse(result.stdout) as DatabaseBenchmarkRawRun;
  assert.equal(run.error, null);
  assert.equal(run.changedProducts, 21);
  assert.equal(run.processedChangeCount, run.changedProducts);
  assert.equal(run.rebuiltDocumentCount, run.changedProducts);
  assert.equal(run.compactionCount, 0);
});

test('large-catalog compaction benchmark crosses the delta threshold without blocking the target version', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import', 'tsx', 'apps/api/perf/standardization-local-stage-runner.ts',
      '--size', '10000',
      '--scenario', 'balanced',
      '--seed', '20260920',
      '--run', '1',
      '--stage', 'candidate_index_compaction_rebuild',
    ],
    { cwd: process.cwd(), env: process.env, encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  const run = JSON.parse(result.stdout) as DatabaseBenchmarkRawRun;
  assert.equal(run.error, null);
  assert.ok(run.changedProducts > Math.ceil(run.directoryProducts * 0.05));
  assert.equal(run.processedChangeCount, run.changedProducts);
  assert.equal(run.rebuiltDocumentCount, run.directoryProducts);
  assert.equal(run.compactionCount, 1);
});

test('database benchmark requires the explicit isolated test URL and never falls back to DATABASE_URL', () => {
  assert.throws(() => databaseBenchmarkConfiguration({ DATABASE_URL: 'postgres://development.invalid/db' }), /TEST_DATABASE_URL is required/);
  const report = databaseBenchmarkNotExecuted({ DATABASE_URL: 'postgres://development.invalid/db' });
  assert.equal(report.status, 'unexecuted');
  assert.equal(report.reasonCode, 'missing_test_database_url');
  assert.equal('databaseUrl' in report, false);
});

test('database benchmark connection budget accounts for roles, admin and measured concurrency', () => {
  const budget = validateDatabaseBenchmarkConnectionBudget({
    PG_POOL_MAX: '10', API_CONNECTIONS: '2', CRAWLER_CONNECTIONS: '1',
    AI_CONNECTIONS: '2', STANDARDIZATION_CONNECTIONS: '2',
  }, 2);
  assert.deepEqual(budget, {
    poolMax: 10,
    applicationRoles: { api: 2, crawler: 1, ai: 2, standardization: 2 },
    applicationTotal: 7,
    adminConnections: 1,
    benchmarkConcurrency: 2,
    requiredConnections: 10,
    remainingConnections: 0,
  });
  assert.throws(() => validateDatabaseBenchmarkConnectionBudget({
    PG_POOL_MAX: '10', API_CONNECTIONS: '2', CRAWLER_CONNECTIONS: '1',
    AI_CONNECTIONS: '2', STANDARDIZATION_CONNECTIONS: '2',
  }, 3), /requires 11 connections.*PG_POOL_MAX=10/i);
});

test('database benchmark configuration fixes isolated sizes, run count and deployment concurrency', () => {
  const config = databaseBenchmarkConfiguration({
    TEST_DATABASE_URL: 'postgres://isolated.invalid/test', PG_POOL_MAX: '10',
    API_CONNECTIONS: '2', CRAWLER_CONNECTIONS: '1', AI_CONNECTIONS: '2', STANDARDIZATION_CONNECTIONS: '2',
    AI_CONCURRENCY: '2', STANDARDIZATION_BENCHMARK_RUNS: '5',
  });
  assert.deepEqual(config.sizes, [1_000, 5_000, 10_000]);
  assert.deepEqual(config.concurrencyLevels, [1, 2]);
  assert.equal(config.runsPerScenario, 5);
  assert.deepEqual(config.scenarios, [
    'balanced',
    'high_duplication',
    'low_duplication',
    'retrieval_stress',
    'publication_stress',
  ]);
  assert.match(config.schema, /^standardization_bench_\d{8}_[a-f0-9]{12}$/);
  assert.equal(config.connectionBudget.requiredConnections, 10);
});

test('executed benchmark validation rejects reports that omit a required scenario', () => {
  const report = {
    providerRequestCount: 0,
    configuration: {
      scenarios: ['balanced', 'high_duplication', 'low_duplication', 'retrieval_stress'],
      sizes: [1_000, 5_000, 10_000],
      concurrencyLevels: [1, 2],
      runsPerScenario: 5,
    },
    rawRuns: [],
    explainPlans: {},
  } as unknown as DatabaseBenchmarkReport;
  assert.throws(
    () => validateExecutedDatabaseBenchmark(report),
    /missing required scenarios: publication_stress/,
  );
});

test('database benchmark fingerprints explicit container CPU and memory limits together', () => {
  assert.equal(databaseBenchmarkContainerResources({}), null);
  assert.deepEqual(databaseBenchmarkContainerResources({
    STANDARDIZATION_BENCHMARK_CPU_LIMIT: '2.5',
    STANDARDIZATION_BENCHMARK_MEMORY_LIMIT_BYTES: '4294967296',
  }), {
    cpuLimit: 2.5,
    memoryLimitBytes: 4_294_967_296,
  });
  assert.throws(() => databaseBenchmarkContainerResources({
    STANDARDIZATION_BENCHMARK_CPU_LIMIT: '2',
  }), /CPU_LIMIT and STANDARDIZATION_BENCHMARK_MEMORY_LIMIT_BYTES must be set together/u);
  assert.throws(() => databaseBenchmarkContainerResources({
    STANDARDIZATION_BENCHMARK_CPU_LIMIT: '0',
    STANDARDIZATION_BENCHMARK_MEMORY_LIMIT_BYTES: '4294967296',
  }), /CPU_LIMIT must be a positive number/u);
  assert.throws(() => databaseBenchmarkContainerResources({
    STANDARDIZATION_BENCHMARK_CPU_LIMIT: '2',
    STANDARDIZATION_BENCHMARK_MEMORY_LIMIT_BYTES: '4GB',
  }), /MEMORY_LIMIT_BYTES must be a positive integer/u);
});

test('deployment benchmark rejects cgroup limits that differ from the declared container limits', () => {
  const declared = { cpuLimit: 2.5, memoryLimitBytes: 4_294_967_296 };
  assert.doesNotThrow(() => validateDatabaseBenchmarkContainerCgroup(declared, {
    cpuMax: '250000 100000', memoryMax: '4294967296',
  }));
  assert.throws(() => validateDatabaseBenchmarkContainerCgroup(declared, {
    cpuMax: 'max 100000', memoryMax: '4294967296',
  }), /CPU limit does not match the cgroup quota/u);
  assert.throws(() => validateDatabaseBenchmarkContainerCgroup(declared, {
    cpuMax: '200000 100000', memoryMax: '4294967296',
  }), /CPU limit does not match the cgroup quota/u);
  assert.throws(() => validateDatabaseBenchmarkContainerCgroup(declared, {
    cpuMax: '250000 100000', memoryMax: '2147483648',
  }), /memory limit does not match the cgroup limit/u);
});

test('executed benchmark validation reports the original stage failure before derived metric errors', () => {
  const report = {
    providerRequestCount: 0,
    configuration: {
      scenarios: DATABASE_BENCHMARK_SCENARIOS.map(scenario => scenario.name),
      sizes: [1_000, 5_000, 10_000],
      concurrencyLevels: [1, 2],
      runsPerScenario: 5,
    },
    rawRuns: [{
      scenario: 'balanced',
      size: 5_000,
      stage: 'candidate_index_delta_refresh_after_1pct_change',
      error: 'original delta failure',
    }],
    explainPlans: {},
  } as unknown as DatabaseBenchmarkReport;

  assert.throws(
    () => validateExecutedDatabaseBenchmark(report),
    /balanced\/5000\/candidate_index_delta_refresh_after_1pct_change failed: original delta failure/,
  );
});

test('database benchmark aggregates raw runs with reproducible median, p95, writes and failures', () => {
  const run = (runNumber: number, durationMs: number, overrides: Partial<DatabaseBenchmarkRawRun> = {}): DatabaseBenchmarkRawRun => ({
    scenario: 'balanced', size: 1_000, uniqueInputs: 820, directoryProducts: 205, evidenceBytes: 1_024,
    logicalTagRows: 0, expandedTagRows: 0,
    concurrency: 2, catalogState: 'warm',
    run: runNumber, stage: 'publication_commit', durationMs, cpuMs: durationMs / 2,
    processId: process.pid, startRssBytes: 900, endRssBytes: 950,
    startHeapUsedBytes: 400, endHeapUsedBytes: 450,
    peakRssBytes: 1_000 + runNumber, rssMeasurement: 'sampled_peak', sqlQueries: 3, sqlP95Ms: durationMs / 3,
    transactionMs: durationMs, lockWaitMs: runNumber, queueWaitMs: 2, throughputPerSecond: 10,
    processedItems: 2, throughputUnit: 'published_members',
    scanned: 20, compared: 10, candidateCount: 5, truncatedCount: 1, changedProducts: 0,
    selectionVisits: 0, peakScratchCandidates: 0, retainedFeatureCount: 0,
    processedChangeCount: 0, rebuiltDocumentCount: 0, deltaDocumentCount: 0, tombstoneCount: 0, compactionCount: 0,
    routePostingsVisited: 0, deterministicGroups: 0, deterministicEdges: 0, suspectedPairs: 0,
    writtenRows: 32, writtenTagRows: 0, writtenBytes: 1_024, error: null,
    ...overrides,
  });
  const raw = [run(1, 10), run(2, 20), run(3, 30), run(4, 40), run(5, 100, { error: 'lock timeout' })];
  const [summary] = aggregateDatabaseBenchmarkRuns(raw);
  assert.deepEqual(summary, {
    scenario: 'balanced', size: 1_000, uniqueInputs: 820, directoryProducts: 205, evidenceBytes: 1_024,
    logicalTagRows: 0, expandedTagRows: 0,
    concurrency: 2, catalogState: 'warm', stage: 'publication_commit',
    throughputUnit: 'published_members', rssMeasurement: 'sampled_peak',
    runs: 5, succeededRuns: 4, failedRuns: 1, medianMs: 30, p95Ms: 100,
    medianCpuMs: 15, p95SqlMs: 100 / 3, maxPeakRssBytes: 1_005,
    p95TransactionMs: 100, p95LockWaitMs: 5, p95QueueWaitMs: 2, medianThroughputPerSecond: 10,
    maxScanned: 20, maxCompared: 10, maxCandidateCount: 5, maxTruncatedCount: 1,
    maxSelectionVisits: 0, maxPeakScratchCandidates: 0, maxRetainedFeatureCount: 0,
    maxProcessedChangeCount: 0, maxRebuiltDocumentCount: 0, maxDeltaDocumentCount: 0,
    maxTombstoneCount: 0, maxCompactionCount: 0,
    maxChangedProducts: 0, maxRoutePostingsVisited: 0, maxDeterministicGroups: 0,
    maxDeterministicEdges: 0, maxSuspectedPairs: 0, totalProcessedItems: 10,
    totalWrittenRows: 160, totalWrittenTagRows: 0, totalWrittenBytes: 5_120,
  });
});

test('database benchmark run validation requires each run id exactly once', () => {
  assert.doesNotThrow(() => validateDatabaseBenchmarkRunIds([1, 2, 3, 4, 5], 5, 'balanced/1000/local/input_grouping'));
  assert.throws(
    () => validateDatabaseBenchmarkRunIds([1, 1, 2, 3, 4], 5, 'balanced/1000/local/input_grouping'),
    /run ids must be exactly 1\.\.5/,
  );
});

test('database benchmark EXPLAIN validation rejects empty, unbounded, temporary and unindexed plans', () => {
  const indexedPlan = [{ Plan: {
    'Node Type': 'Index Scan',
    'Index Name': 'benchmark_index',
    'Actual Rows': 10,
    'Actual Loops': 1,
    'Temp Read Blocks': 0,
    'Temp Written Blocks': 0,
  } }];
  const completePlans = (candidateLookup: unknown = indexedPlan) => ({
    'balanced.candidate_lookup': candidateLookup,
    'balanced.rolling_window_claim': indexedPlan,
    'balanced.publication_unit': { batch_lock: indexedPlan, unit_claim: indexedPlan },
    'balanced.finalization': { job_lock: indexedPlan, result_counts: indexedPlan },
  }) as Parameters<typeof validateDatabaseBenchmarkExplainPlans>[0];
  assert.doesNotThrow(() => validateDatabaseBenchmarkExplainPlans(completePlans(), ['balanced']));
  assert.throws(
    () => validateDatabaseBenchmarkExplainPlans({ 'balanced.candidate_lookup': [] }, ['balanced']),
    /empty EXPLAIN plan/,
  );
  assert.throws(
    () => validateDatabaseBenchmarkExplainPlans(completePlans([
      { Plan: { 'Node Type': 'Index Scan', 'Actual Rows': 100_001, 'Actual Loops': 1 } },
    ]), ['balanced']),
    /exceeded actual row budget/,
  );
  assert.throws(
    () => validateDatabaseBenchmarkExplainPlans(completePlans([
      { Plan: { 'Node Type': 'Index Scan', 'Actual Rows': 1, 'Actual Loops': 1, 'Temp Written Blocks': 1 } },
    ]), ['balanced']),
    /used temporary blocks/,
  );
  assert.throws(
    () => validateDatabaseBenchmarkExplainPlans(completePlans([
      { Plan: { 'Node Type': 'Seq Scan', 'Actual Rows': 500, 'Actual Loops': 1 } },
    ]), ['balanced']),
    /has no index access/,
  );
  assert.throws(
    () => validateDatabaseBenchmarkExplainPlans(completePlans([
      { Plan: { 'Node Type': 'Index Scan' } },
    ]), ['balanced']),
    /has no actual row metrics/,
  );
});

test('database benchmark schema names are valid and unique', () => {
  const first = createDatabaseBenchmarkSchemaName(new Date('2026-09-20T00:00:00Z'), '12345678-1234-1234-1234-1234567890ab');
  const second = createDatabaseBenchmarkSchemaName(new Date('2026-09-20T00:00:00Z'), 'abcdefab-1234-1234-1234-1234567890ab');
  assert.equal(first, 'standardization_bench_20260920_123456781234');
  assert.notEqual(first, second);
});

test('database benchmark CLI emits a sanitized unexecuted report and exits nonzero without TEST_DATABASE_URL', () => {
  const environment: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: 'postgres://user:secret@development.invalid/app' };
  delete environment.TEST_DATABASE_URL;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'apps/api/perf/standardization-database-benchmark.ts', '--check'],
    { cwd: process.cwd(), env: environment, encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(report.status, 'unexecuted');
  assert.equal(report.reasonCode, 'missing_test_database_url');
  assert.equal('databaseUrl' in report, false);
  assert.equal(result.stdout.includes('secret'), false);
  assert.equal(result.stdout.includes('development.invalid'), false);
});

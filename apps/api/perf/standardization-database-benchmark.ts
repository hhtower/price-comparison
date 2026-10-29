import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  Kysely,
  PostgresDialect,
  sql,
  type KyselyPlugin,
  type QueryId,
  type QueryResult,
  type RootOperationNode,
  type UnknownRow,
} from 'kysely';
import { Pool } from 'pg';
import { migrateToLatest } from '../scripts/migrate.js';
import { AiRepository } from '../src/ai/ai.repository.js';
import type { ParsedStandardizationResponse } from '../src/ai/ai.schemas.js';
import { finalizeOrScheduleMissing } from '../src/ai/standardization-finalizer.js';
import { jsonb, type DatabaseSchema, type JsonValue } from '../src/database/types.js';
import { JobsRepository, type ClaimedJob } from '../src/jobs/jobs.repository.js';
import { getConnectionBudget } from '../src/observability/metrics.js';
import { buildCanonicalStandardKey } from '../src/standardization/canonical-key.js';
import { BoundedCandidateIndex, type CandidateDocument } from '../src/standardization/candidate-index.js';
import {
  auditStandardProductDuplicates,
  DUPLICATE_BLOCKING_ROUTES,
  VersionedDuplicateAuditIndex,
} from '../src/standardization/duplicate-audit.js';
import type { StandardProductIdentity } from '../src/standardization/duplicate-linkage.js';
import { productContentFingerprint } from '../src/standardization/fingerprint.js';
import { IDENTITY_POLICY_VERSION } from '../src/standardization/identity-policy.js';
import { planSimilarityGroups, type SimilarityGroupInput } from '../src/standardization/input-grouping.js';
import {
  VersionedCandidateIndex,
  type CatalogIndexChange,
} from '../src/standardization/versioned-candidate-index.js';
import type { DatabaseBenchmarkBaselineSource, StandardizationPerformanceBudget } from './standardization-database-budget.js';

const BENCHMARK_SIZES = [1_000, 5_000, 10_000] as const;
const MIN_RUNS_PER_SCENARIO = 5;
const EXPLAIN_PLAN_SCENARIOS: readonly DatabaseBenchmarkScenarioName[] = [
  'balanced',
  'retrieval_stress',
  'publication_stress',
];
const DATABASE_BENCHMARK_DATABASE_STAGE_UNITS = 6;
const DATABASE_BENCHMARK_CATALOG_STATES = 2;

export interface DatabaseBenchmarkProgress {
  readonly type: 'standardization_benchmark_progress';
  readonly completedUnits: number;
  readonly totalUnits: number;
  readonly percent: number;
  readonly elapsedMs: number;
  readonly etaMs: number | null;
  readonly current: string;
}

export function databaseBenchmarkTotalStageUnits(input: {
  readonly matrixEntries: number;
  readonly runsPerScenario: number;
  readonly concurrencyLevels: readonly number[];
}): number {
  const localUnits = input.matrixEntries * input.runsPerScenario * DATABASE_BENCHMARK_LOCAL_STAGES.length;
  const databaseUnits = input.matrixEntries
    * input.concurrencyLevels.length
    * DATABASE_BENCHMARK_CATALOG_STATES
    * input.runsPerScenario
    * DATABASE_BENCHMARK_DATABASE_STAGE_UNITS;
  return localUnits + databaseUnits;
}

export function calculateDatabaseBenchmarkProgress(input: {
  readonly completedUnits: number;
  readonly totalUnits: number;
  readonly activeElapsedMs: number;
  readonly current: string;
}): DatabaseBenchmarkProgress {
  const percent = input.totalUnits === 0 ? 100 : input.completedUnits / input.totalUnits * 100;
  const etaMs = input.completedUnits === 0
    ? null
    : input.activeElapsedMs * (input.totalUnits - input.completedUnits) / input.completedUnits;
  return {
    type: 'standardization_benchmark_progress',
    completedUnits: input.completedUnits,
    totalUnits: input.totalUnits,
    percent,
    elapsedMs: input.activeElapsedMs,
    etaMs,
    current: input.current,
  };
}

function formatBenchmarkDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor(totalSeconds % 3_600 / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map(value => String(value).padStart(2, '0')).join(':');
}

export function formatDatabaseBenchmarkProgress(progress: DatabaseBenchmarkProgress): string {
  const eta = progress.etaMs === null ? 'calculating' : formatBenchmarkDuration(progress.etaMs);
  return `[standardization-benchmark] ${progress.completedUnits}/${progress.totalUnits} `
    + `(${progress.percent.toFixed(2)}%) elapsed=${formatBenchmarkDuration(progress.elapsedMs)} `
    + `eta=${eta} current=${progress.current}`;
}

export type DatabaseBenchmarkCoverage =
  | 'high_duplication'
  | 'low_duplication'
  | 'high_frequency_terms'
  | 'unknown_brand'
  | 'mixed_language'
  | 'long_evidence'
  | 'slow_publication'
  | 'lock_contention';

export type DatabaseBenchmarkScenarioName =
  | 'balanced'
  | 'high_duplication'
  | 'low_duplication'
  | 'retrieval_stress'
  | 'publication_stress';

export interface DatabaseBenchmarkScenarioDefinition {
  readonly name: DatabaseBenchmarkScenarioName;
  readonly coverage: readonly DatabaseBenchmarkCoverage[];
  readonly uniqueRatio: number;
  readonly highFrequencyShare: number;
  readonly unknownBrandShare: number;
  readonly mixedLanguageShare: number;
  readonly longEvidenceBytes: number;
  readonly publicationDelayMs: number;
  readonly lockHoldMs: number;
}

export const DATABASE_BENCHMARK_SCENARIOS: readonly DatabaseBenchmarkScenarioDefinition[] = [
  {
    name: 'balanced', coverage: [], uniqueRatio: 0.82, highFrequencyShare: 0,
    unknownBrandShare: 0, mixedLanguageShare: 0, longEvidenceBytes: 0,
    publicationDelayMs: 0, lockHoldMs: 25,
  },
  {
    name: 'high_duplication', coverage: ['high_duplication'], uniqueRatio: 0.2, highFrequencyShare: 0,
    unknownBrandShare: 0, mixedLanguageShare: 0, longEvidenceBytes: 0,
    publicationDelayMs: 0, lockHoldMs: 25,
  },
  {
    name: 'low_duplication', coverage: ['low_duplication'], uniqueRatio: 0.98, highFrequencyShare: 0,
    unknownBrandShare: 0, mixedLanguageShare: 0, longEvidenceBytes: 0,
    publicationDelayMs: 0, lockHoldMs: 25,
  },
  {
    name: 'retrieval_stress',
    coverage: ['high_frequency_terms', 'unknown_brand', 'mixed_language', 'long_evidence'],
    uniqueRatio: 0.82, highFrequencyShare: 0.9, unknownBrandShare: 0.5,
    mixedLanguageShare: 0.5, longEvidenceBytes: 4_096,
    publicationDelayMs: 0, lockHoldMs: 25,
  },
  {
    name: 'publication_stress',
    coverage: ['slow_publication', 'lock_contention'],
    uniqueRatio: 0.82, highFrequencyShare: 0, unknownBrandShare: 0,
    mixedLanguageShare: 0, longEvidenceBytes: 0,
    publicationDelayMs: 25, lockHoldMs: 75,
  },
] as const;

const REQUIRED_DATABASE_BENCHMARK_COVERAGE: readonly DatabaseBenchmarkCoverage[] = [
  'high_duplication', 'low_duplication', 'high_frequency_terms', 'unknown_brand', 'mixed_language',
  'long_evidence', 'slow_publication', 'lock_contention',
];

export interface DatabaseBenchmarkConnectionBudget {
  readonly poolMax: number;
  readonly applicationRoles: {
    readonly api: number;
    readonly crawler: number;
    readonly ai: number;
    readonly standardization: number;
  };
  readonly applicationTotal: number;
  readonly adminConnections: 1;
  readonly benchmarkConcurrency: number;
  readonly requiredConnections: number;
  readonly remainingConnections: number;
}

export interface DatabaseBenchmarkConfiguration {
  readonly databaseUrl: string;
  readonly schema: string;
  readonly sizes: readonly [1_000, 5_000, 10_000];
  readonly concurrencyLevels: readonly number[];
  readonly runsPerScenario: number;
  readonly scenarios: readonly DatabaseBenchmarkScenarioName[];
  readonly connectionBudget: DatabaseBenchmarkConnectionBudget;
}

export interface DatabaseBenchmarkContainerResources {
  readonly cpuLimit: number;
  readonly memoryLimitBytes: number;
}

export interface DatabaseBenchmarkNotExecutedReport {
  readonly status: 'unexecuted';
  readonly reasonCode: 'missing_test_database_url';
  readonly message: string;
  readonly generatedAt: string;
}

export interface DatabaseBenchmarkRawRun {
  readonly scenario: DatabaseBenchmarkScenarioName;
  readonly size: number;
  readonly uniqueInputs: number;
  readonly directoryProducts: number;
  readonly evidenceBytes: number;
  readonly logicalTagRows: number;
  readonly expandedTagRows: number;
  readonly concurrency: number;
  readonly catalogState: string;
  readonly run: number;
  readonly stage: string;
  readonly durationMs: number;
  readonly cpuMs: number;
  readonly processId: number;
  readonly startRssBytes: number;
  readonly endRssBytes: number;
  readonly startHeapUsedBytes: number;
  readonly endHeapUsedBytes: number;
  readonly peakRssBytes: number;
  readonly rssMeasurement: 'process_max_rss' | 'sampled_peak';
  readonly sqlQueries: number;
  readonly sqlP95Ms: number;
  readonly transactionMs: number;
  readonly lockWaitMs: number;
  readonly queueWaitMs: number;
  readonly throughputPerSecond: number;
  readonly processedItems: number;
  readonly throughputUnit: string;
  readonly scanned: number;
  readonly compared: number;
  readonly candidateCount: number;
  readonly truncatedCount: number;
  readonly selectionVisits: number;
  readonly peakScratchCandidates: number;
  readonly retainedFeatureCount: number;
  readonly processedChangeCount: number;
  readonly rebuiltDocumentCount: number;
  readonly deltaDocumentCount: number;
  readonly tombstoneCount: number;
  readonly compactionCount: number;
  readonly changedProducts: number;
  readonly routePostingsVisited: number;
  readonly deterministicGroups: number;
  readonly deterministicEdges: number;
  readonly suspectedPairs: number;
  readonly writtenRows: number;
  readonly writtenTagRows: number;
  readonly writtenBytes: number;
  readonly error: string | null;
}

export interface DatabaseBenchmarkAggregate {
  readonly scenario: DatabaseBenchmarkScenarioName;
  readonly size: number;
  readonly uniqueInputs: number;
  readonly directoryProducts: number;
  readonly evidenceBytes: number;
  readonly logicalTagRows: number;
  readonly expandedTagRows: number;
  readonly concurrency: number;
  readonly catalogState: string;
  readonly stage: string;
  readonly throughputUnit: string;
  readonly rssMeasurement: 'process_max_rss' | 'sampled_peak';
  readonly runs: number;
  readonly succeededRuns: number;
  readonly failedRuns: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly medianCpuMs: number;
  readonly p95SqlMs: number;
  readonly maxPeakRssBytes: number;
  readonly p95TransactionMs: number;
  readonly p95LockWaitMs: number;
  readonly p95QueueWaitMs: number;
  readonly medianThroughputPerSecond: number;
  readonly maxScanned: number;
  readonly maxCompared: number;
  readonly maxCandidateCount: number;
  readonly maxTruncatedCount: number;
  readonly maxSelectionVisits: number;
  readonly maxPeakScratchCandidates: number;
  readonly maxRetainedFeatureCount: number;
  readonly maxProcessedChangeCount: number;
  readonly maxRebuiltDocumentCount: number;
  readonly maxDeltaDocumentCount: number;
  readonly maxTombstoneCount: number;
  readonly maxCompactionCount: number;
  readonly maxChangedProducts: number;
  readonly maxRoutePostingsVisited: number;
  readonly maxDeterministicGroups: number;
  readonly maxDeterministicEdges: number;
  readonly maxSuspectedPairs: number;
  readonly totalProcessedItems: number;
  readonly totalWrittenRows: number;
  readonly totalWrittenTagRows: number;
  readonly totalWrittenBytes: number;
}

export type DatabaseBenchmarkStage =
  | 'candidate_index_build'
  | 'candidate_index_full_rebuild_after_1pct_change'
  | 'candidate_index_delta_refresh_after_1pct_change'
  | 'candidate_index_compaction_rebuild'
  | 'input_grouping'
  | 'candidate_query_local'
  | 'directory_duplicate_audit_full'
  | 'directory_duplicate_audit_incremental'
  | 'request_preparation'
  | 'candidate_query'
  | 'rolling_window_claim'
  | 'lock_contention'
  | 'publication_commit'
  | 'finalization';

export type DatabaseBenchmarkLocalStage = Extract<DatabaseBenchmarkStage,
  | 'candidate_index_build'
  | 'candidate_index_full_rebuild_after_1pct_change'
  | 'candidate_index_delta_refresh_after_1pct_change'
  | 'candidate_index_compaction_rebuild'
  | 'input_grouping'
  | 'candidate_query_local'
  | 'directory_duplicate_audit_full'
  | 'directory_duplicate_audit_incremental'>;

export const DATABASE_BENCHMARK_LOCAL_STAGES: readonly DatabaseBenchmarkLocalStage[] = [
  'candidate_index_build',
  'candidate_index_full_rebuild_after_1pct_change',
  'candidate_index_delta_refresh_after_1pct_change',
  'candidate_index_compaction_rebuild',
  'input_grouping',
  'candidate_query_local',
  'directory_duplicate_audit_full',
  'directory_duplicate_audit_incremental',
] as const;

export const DATABASE_BENCHMARK_DATABASE_STAGES = [
  'request_preparation',
  'candidate_query',
  'rolling_window_claim',
  'lock_contention',
  'publication_commit',
  'finalization',
] as const satisfies readonly DatabaseBenchmarkStage[];

export interface DatabaseBenchmarkReport {
  readonly status: 'executed';
  readonly generatedAt: string;
  readonly schema: string;
  readonly configuration: {
    readonly sizes: readonly number[];
    readonly concurrencyLevels: readonly number[];
    readonly runsPerScenario: number;
    readonly scenarios: readonly DatabaseBenchmarkScenarioName[];
    readonly connectionBudget: DatabaseBenchmarkConnectionBudget;
    readonly seed: number;
  };
  readonly environment: {
    readonly node: string;
    readonly platform: string;
    readonly release: string;
    readonly arch: string;
    readonly cpuModel: string;
    readonly cpuCount: number;
    readonly totalMemoryBytes: number;
    readonly containerResources: DatabaseBenchmarkContainerResources | null;
    readonly postgresVersion: string;
    readonly postgresSettings: Readonly<Record<string, string>>;
    readonly policyVersion: string;
  };
  readonly rawRuns: readonly DatabaseBenchmarkRawRun[];
  readonly aggregates: readonly DatabaseBenchmarkAggregate[];
  readonly explainPlans: Readonly<Record<string, JsonValue>>;
  readonly providerRequestCount: 0;
}

export type DatabaseBenchmarkCheckpoint = Omit<DatabaseBenchmarkReport, 'status' | 'aggregates'> & {
  readonly status: 'in_progress';
  readonly startedAt: string;
  readonly activeElapsedMs: number;
};

export interface DatabaseBenchmarkResumePlan {
  readonly rawRuns: readonly DatabaseBenchmarkRawRun[];
  readonly explainPlans: Readonly<Record<string, JsonValue>>;
  readonly completedUnits: number;
  readonly activeElapsedMs: number;
  readonly startedAt: string;
}

function databaseBenchmarkIterationKey(run: DatabaseBenchmarkRawRun): string {
  return JSON.stringify([run.scenario, run.size, run.concurrency, run.catalogState, run.run]);
}

export function planDatabaseBenchmarkResume(
  checkpoint: DatabaseBenchmarkCheckpoint,
  current: {
    readonly configuration: DatabaseBenchmarkReport['configuration'];
    readonly environment: DatabaseBenchmarkReport['environment'];
  },
): DatabaseBenchmarkResumePlan {
  if (!isDeepStrictEqual(checkpoint.configuration, current.configuration)) {
    throw new Error('benchmark checkpoint configuration does not match the current run');
  }
  if (!isDeepStrictEqual(checkpoint.environment, current.environment)) {
    throw new Error('benchmark checkpoint environment does not match the current run');
  }

  const retained = new Set<DatabaseBenchmarkRawRun>();
  const databaseIterations = new Map<string, DatabaseBenchmarkRawRun[]>();
  for (const run of checkpoint.rawRuns) {
    if (DATABASE_BENCHMARK_LOCAL_STAGES.includes(run.stage as DatabaseBenchmarkLocalStage)) {
      if (run.error === null) retained.add(run);
      continue;
    }
    if (!DATABASE_BENCHMARK_DATABASE_STAGES.includes(run.stage as typeof DATABASE_BENCHMARK_DATABASE_STAGES[number])) {
      continue;
    }
    const key = databaseBenchmarkIterationKey(run);
    const group = databaseIterations.get(key) ?? [];
    group.push(run);
    databaseIterations.set(key, group);
  }

  for (const runs of databaseIterations.values()) {
    const stages = new Set(runs.filter(run => run.error === null).map(run => run.stage));
    if (runs.length !== DATABASE_BENCHMARK_DATABASE_STAGES.length
      || stages.size !== DATABASE_BENCHMARK_DATABASE_STAGES.length
      || !DATABASE_BENCHMARK_DATABASE_STAGES.every(stage => stages.has(stage))) {
      continue;
    }
    for (const run of runs) retained.add(run);
  }

  const rawRuns = checkpoint.rawRuns.filter(run => retained.has(run));
  return {
    rawRuns,
    explainPlans: checkpoint.explainPlans,
    completedUnits: rawRuns.length,
    activeElapsedMs: checkpoint.activeElapsedMs,
    startedAt: checkpoint.startedAt,
  };
}

interface SeededScenario {
  readonly scenario: DatabaseBenchmarkScenarioName;
  readonly rawProductIds: readonly bigint[];
  readonly uniqueInputs: number;
  readonly directoryProducts: number;
  readonly evidenceBytes: number;
  readonly logicalTagRows: number;
  readonly expandedTagRows: number;
  readonly publicationDelayMs: number;
  readonly lockHoldMs: number;
  readonly incrementalChangedProducts: number;
  readonly sampleStandardKey: string;
}

interface BenchmarkFixture {
  readonly preview: DatabaseBenchmarkFixturePreview;
  readonly rawProducts: readonly BenchmarkRawProduct[];
  readonly catalogProducts: readonly BenchmarkRawProduct[];
  readonly candidateDocuments: readonly CandidateDocument[];
  readonly directoryIdentities: readonly StandardProductIdentity[];
  readonly groupingInputs: readonly SimilarityGroupInput[];
}

interface BenchmarkRawProduct {
  readonly externalId: string;
  readonly name: string;
  readonly spec: string;
  readonly sourceCategory: string;
  readonly sourceData: JsonValue;
}

export interface DatabaseBenchmarkFixturePreview {
  readonly scenario: DatabaseBenchmarkScenarioName;
  readonly size: number;
  readonly uniqueInputs: number;
  readonly directoryProducts: number;
  readonly evidenceBytes: number;
  readonly logicalTagRows: number;
  readonly expandedTagRows: number;
  readonly highFrequencyInputCount: number;
  readonly unknownBrandInputCount: number;
  readonly mixedLanguageInputCount: number;
  readonly incrementalChangedProducts: number;
  readonly publicationDelayMs: number;
  readonly lockHoldMs: number;
}

export interface DatabaseBenchmarkScenarioMatrixEntry {
  readonly size: (typeof BENCHMARK_SIZES)[number];
  readonly scenario: DatabaseBenchmarkScenarioName;
}

interface QueryMetricsSnapshot {
  readonly queries: number;
  readonly p95Ms: number;
}

interface StageActionResult<T> {
  readonly value: T;
  readonly processedItems?: number;
  readonly throughputUnit?: string;
  readonly writtenRows?: number;
  readonly writtenTagRows?: number;
  readonly writtenBytes?: number;
  readonly lockWaitMs?: number;
  readonly transactionMs?: number;
  readonly queueWaitMs?: number;
  readonly scanned?: number;
  readonly compared?: number;
  readonly candidateCount?: number;
  readonly truncatedCount?: number;
  readonly selectionVisits?: number;
  readonly peakScratchCandidates?: number;
  readonly retainedFeatureCount?: number;
  readonly processedChangeCount?: number;
  readonly rebuiltDocumentCount?: number;
  readonly deltaDocumentCount?: number;
  readonly tombstoneCount?: number;
  readonly compactionCount?: number;
  readonly changedProducts?: number;
  readonly routePostingsVisited?: number;
  readonly deterministicGroups?: number;
  readonly deterministicEdges?: number;
  readonly suspectedPairs?: number;
}

interface StageMeasurement<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly raw: DatabaseBenchmarkRawRun;
}

type DatabaseStageActionResult<T> = StageActionResult<T> & {
  readonly processedItems: number;
  readonly throughputUnit: string;
};

export function createDatabaseBenchmarkSchemaName(
  now: Date = new Date(),
  nonce: string = randomUUID(),
): string {
  const date = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
  ].join('');
  const suffix = nonce.toLowerCase().replace(/[^a-f0-9]/g, '').slice(0, 12);
  if (suffix.length !== 12) throw new Error('benchmark schema nonce must contain at least 12 hexadecimal characters');
  return `standardization_bench_${date}_${suffix}`;
}

export function databaseBenchmarkNotExecuted(
  _environment: NodeJS.ProcessEnv = process.env,
): DatabaseBenchmarkNotExecutedReport {
  return {
    status: 'unexecuted',
    reasonCode: 'missing_test_database_url',
    message: 'TEST_DATABASE_URL is required; the database benchmark was not executed',
    generatedAt: new Date().toISOString(),
  };
}

export function validateDatabaseBenchmarkConnectionBudget(
  environment: NodeJS.ProcessEnv,
  benchmarkConcurrency: number,
): DatabaseBenchmarkConnectionBudget {
  const poolMax = positiveInteger(environment.PG_POOL_MAX, 10, 'PG_POOL_MAX');
  const roles = getConnectionBudget(environment);
  const applicationTotal = roles.api + roles.crawler + roles.ai + roles.standardization;
  const normalizedConcurrency = positiveInteger(String(benchmarkConcurrency), 1, 'benchmark concurrency');
  const requiredConnections = applicationTotal + 1 + normalizedConcurrency;
  if (requiredConnections > poolMax) {
    throw new Error(
      `database benchmark requires ${requiredConnections} connections ` +
      `(application=${applicationTotal}, admin=1, benchmark=${normalizedConcurrency}) but PG_POOL_MAX=${poolMax}`,
    );
  }
  return {
    poolMax,
    applicationRoles: roles,
    applicationTotal,
    adminConnections: 1,
    benchmarkConcurrency: normalizedConcurrency,
    requiredConnections,
    remainingConnections: poolMax - requiredConnections,
  };
}

export function databaseBenchmarkConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): DatabaseBenchmarkConfiguration {
  const databaseUrl = environment.TEST_DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required');
  const deploymentConcurrency = positiveInteger(environment.AI_CONCURRENCY, 1, 'AI_CONCURRENCY');
  const concurrencyLevels = [...new Set([1, deploymentConcurrency])];
  const requestedRuns = positiveInteger(
    environment.STANDARDIZATION_BENCHMARK_RUNS,
    MIN_RUNS_PER_SCENARIO,
    'STANDARDIZATION_BENCHMARK_RUNS',
  );
  return {
    databaseUrl,
    schema: createDatabaseBenchmarkSchemaName(),
    sizes: BENCHMARK_SIZES,
    concurrencyLevels,
    runsPerScenario: Math.max(MIN_RUNS_PER_SCENARIO, requestedRuns),
    scenarios: DATABASE_BENCHMARK_SCENARIOS.map(scenario => scenario.name),
    connectionBudget: validateDatabaseBenchmarkConnectionBudget(
      environment,
      Math.max(...concurrencyLevels),
    ),
  };
}

export function buildDatabaseBenchmarkScenarioMatrix(): DatabaseBenchmarkScenarioMatrixEntry[] {
  return BENCHMARK_SIZES.flatMap(size => DATABASE_BENCHMARK_SCENARIOS.map(scenario => ({
    size,
    scenario: scenario.name,
  })));
}

export function validateDatabaseBenchmarkScenarioCoverage(
  scenarios: readonly DatabaseBenchmarkScenarioDefinition[],
): void {
  const names = new Set<DatabaseBenchmarkScenarioName>();
  const coverage = new Set<DatabaseBenchmarkCoverage>();
  for (const scenario of scenarios) {
    if (names.has(scenario.name)) throw new Error(`duplicate database benchmark scenario: ${scenario.name}`);
    names.add(scenario.name);
    for (const item of scenario.coverage) coverage.add(item);
  }
  const missingCoverage = REQUIRED_DATABASE_BENCHMARK_COVERAGE.filter(item => !coverage.has(item));
  if (missingCoverage.length) throw new Error(`missing required coverage: ${missingCoverage.join(', ')}`);
  const missingScenarios = DATABASE_BENCHMARK_SCENARIOS
    .map(scenario => scenario.name)
    .filter(name => !names.has(name));
  if (missingScenarios.length) throw new Error(`missing required scenarios: ${missingScenarios.join(', ')}`);
}

function databaseBenchmarkScenario(name: DatabaseBenchmarkScenarioName): DatabaseBenchmarkScenarioDefinition {
  const scenario = DATABASE_BENCHMARK_SCENARIOS.find(candidate => candidate.name === name);
  if (!scenario) throw new Error(`unknown database benchmark scenario: ${name}`);
  return scenario;
}

function buildDatabaseBenchmarkFixture(
  size: number,
  scenarioName: DatabaseBenchmarkScenarioName,
  seed: number,
): BenchmarkFixture {
  if (!Number.isSafeInteger(size) || size < 1) throw new RangeError('database benchmark size must be a positive integer');
  const scenario = databaseBenchmarkScenario(scenarioName);
  const uniqueInputs = Math.max(1, Math.floor(size * scenario.uniqueRatio));
  const directoryProducts = Math.max(1, Math.floor(uniqueInputs * 0.25));
  const highFrequencyUnique = Math.ceil(uniqueInputs * scenario.highFrequencyShare);
  const unknownBrandUnique = Math.ceil(uniqueInputs * scenario.unknownBrandShare);
  const mixedLanguageUnique = Math.ceil(uniqueInputs * scenario.mixedLanguageShare);
  const longEvidence = scenario.longEvidenceBytes > 0 ? 'x'.repeat(scenario.longEvidenceBytes) : '';
  let evidenceBytes = 0;
  let highFrequencyInputCount = 0;
  let unknownBrandInputCount = 0;
  let mixedLanguageInputCount = 0;

  const uniqueProducts = Array.from({ length: uniqueInputs }, (_, uniqueIndex): BenchmarkRawProduct => {
    const highFrequency = uniqueIndex < highFrequencyUnique;
    const unknownBrand = uniqueIndex < unknownBrandUnique;
    const mixedLanguage = uniqueIndex < mixedLanguageUnique;
    const family = unknownBrand ? `UnknownBrand${uniqueIndex % 37}` : `BenchmarkBrand${uniqueIndex % 64}`;
    const product = mixedLanguage
      ? `Service 服务 ${uniqueIndex}`
      : `Service ${uniqueIndex}`;
    const name = `${family} ${product}${highFrequency ? ' popular common offer' : ''}`;
    const spec = `tier-${uniqueIndex % 7}; duration-${uniqueIndex % 12 + 1}`;
    const sourceCategory = `category-${uniqueIndex % 11}`;
    const sourceData = {
      title: name,
      selected: spec,
      seed,
      benchmarkEvidence: longEvidence,
    } satisfies JsonValue;
    return { externalId: `raw-unique-${uniqueIndex}`, name, spec, sourceCategory, sourceData };
  });
  const rawProducts = Array.from({ length: size }, (_, index): BenchmarkRawProduct => {
    const uniqueIndex = index % uniqueInputs;
    const product = uniqueProducts[uniqueIndex]!;
    if (uniqueIndex < highFrequencyUnique) highFrequencyInputCount += 1;
    if (uniqueIndex < unknownBrandUnique) unknownBrandInputCount += 1;
    if (uniqueIndex < mixedLanguageUnique) mixedLanguageInputCount += 1;
    evidenceBytes += Buffer.byteLength(JSON.stringify(product.sourceData));
    return { ...product, externalId: `raw-${index}` };
  });

  const directoryIdentities = Array.from({ length: directoryProducts }, (_, index): StandardProductIdentity => ({
    id: `standard-${String(index).padStart(6, '0')}`,
    family: `BenchmarkBrand${index % 64}`,
    product: `Service catalog ${index}`,
    tier: `tier-${index % 7}`,
  }));
  const candidateDocuments = directoryIdentities.map((identity, index): CandidateDocument => ({
    ...identity,
    aliases: [`benchmark catalog alias ${index}`],
  }));
  const catalogProducts = directoryIdentities.map((identity, index): BenchmarkRawProduct => {
    const name = `${identity.family} ${identity.product}`;
    const spec = identity.tier;
    const sourceData = { title: name, selected: spec, seed } satisfies JsonValue;
    return {
      externalId: `catalog-${index}`,
      name,
      spec,
      sourceCategory: 'catalog',
      sourceData,
    };
  });
  const groupingInputs = uniqueProducts.map((product, index): SimilarityGroupInput => ({
    id: `input-${String(index).padStart(6, '0')}`,
    text: `${product.name} ${product.spec} ${product.sourceCategory}`,
  }));
  const logicalTagRows = 0;
  const expandedTagRows = 0;
  const incrementalChangedProducts = Math.max(1, Math.ceil(directoryProducts * 0.01));
  return {
    preview: {
      scenario: scenario.name,
      size,
      uniqueInputs,
      directoryProducts,
      evidenceBytes,
      logicalTagRows,
      expandedTagRows,
      highFrequencyInputCount,
      unknownBrandInputCount,
      mixedLanguageInputCount,
      incrementalChangedProducts,
      publicationDelayMs: scenario.publicationDelayMs,
      lockHoldMs: scenario.lockHoldMs,
    },
    rawProducts,
    catalogProducts,
    candidateDocuments,
    directoryIdentities,
    groupingInputs,
  };
}

export function buildDatabaseBenchmarkFixturePreview(
  size: number,
  scenario: DatabaseBenchmarkScenarioName,
  seed: number,
): DatabaseBenchmarkFixturePreview {
  return buildDatabaseBenchmarkFixture(size, scenario, seed).preview;
}

const CANDIDATE_INDEX_OPTIONS = {
  maxPostingsPerFeature: 256,
  maxScanned: 2_000,
  maxCompared: 400,
  topK: 20,
  maxIndexBytes: 64 * 1024 * 1024,
} as const;
const DEFAULT_GROUP_SIZE = 32;
const DEFAULT_GROUPING_FEATURES = 256;

interface LocalStageDimensions {
  readonly fixture: BenchmarkFixture;
  readonly run: number;
  readonly stage: DatabaseBenchmarkStage;
}

async function measureLocalStage<T>(
  dimensions: LocalStageDimensions,
  processedItems: number,
  throughputUnit: string,
  action: () => StageActionResult<T> | Promise<StageActionResult<T>>,
): Promise<StageMeasurement<T>> {
  const startMemory = process.memoryUsage();
  const startedAt = performance.now();
  const cpuStart = process.cpuUsage();
  let result: StageActionResult<T> | undefined;
  let error: string | null = null;
  try {
    result = await action();
  } catch (candidate: unknown) {
    error = candidate instanceof Error ? candidate.message : String(candidate);
  }
  const durationMs = performance.now() - startedAt;
  const cpu = process.cpuUsage(cpuStart);
  const endMemory = process.memoryUsage();
  const peakRssBytes = Math.max(
    startMemory.rss,
    endMemory.rss,
    process.resourceUsage().maxRSS * 1_024,
  );
  const preview = dimensions.fixture.preview;
  return {
    ok: error === null,
    value: result?.value,
    raw: {
      scenario: preview.scenario,
      size: preview.size,
      uniqueInputs: preview.uniqueInputs,
      directoryProducts: preview.directoryProducts,
      evidenceBytes: preview.evidenceBytes,
      logicalTagRows: preview.logicalTagRows,
      expandedTagRows: preview.expandedTagRows,
      concurrency: 1,
      catalogState: 'local',
      run: dimensions.run,
      stage: dimensions.stage,
      durationMs,
      cpuMs: (cpu.user + cpu.system) / 1_000,
      processId: process.pid,
      startRssBytes: startMemory.rss,
      endRssBytes: endMemory.rss,
      startHeapUsedBytes: startMemory.heapUsed,
      endHeapUsedBytes: endMemory.heapUsed,
      peakRssBytes,
      rssMeasurement: 'process_max_rss',
      sqlQueries: 0,
      sqlP95Ms: 0,
      transactionMs: 0,
      lockWaitMs: 0,
      queueWaitMs: 0,
      throughputPerSecond: error === null ? processedItems / Math.max(durationMs / 1_000, Number.EPSILON) : 0,
      processedItems,
      throughputUnit,
      scanned: result?.scanned ?? 0,
      compared: result?.compared ?? 0,
      candidateCount: result?.candidateCount ?? 0,
      truncatedCount: result?.truncatedCount ?? 0,
      selectionVisits: result?.selectionVisits ?? 0,
      peakScratchCandidates: result?.peakScratchCandidates ?? 0,
      retainedFeatureCount: result?.retainedFeatureCount ?? 0,
      processedChangeCount: result?.processedChangeCount ?? 0,
      rebuiltDocumentCount: result?.rebuiltDocumentCount ?? 0,
      deltaDocumentCount: result?.deltaDocumentCount ?? 0,
      tombstoneCount: result?.tombstoneCount ?? 0,
      compactionCount: result?.compactionCount ?? 0,
      changedProducts: result?.changedProducts ?? 0,
      routePostingsVisited: result?.routePostingsVisited ?? 0,
      deterministicGroups: result?.deterministicGroups ?? 0,
      deterministicEdges: result?.deterministicEdges ?? 0,
      suspectedPairs: result?.suspectedPairs ?? 0,
      writtenRows: 0,
      writtenTagRows: 0,
      writtenBytes: 0,
      error,
    },
  };
}

function duplicateAuditMetrics(result: ReturnType<typeof auditStandardProductDuplicates>): Omit<StageActionResult<typeof result>, 'value'> {
  return {
    compared: result.stats.comparedPairs,
    routePostingsVisited: Object.values(result.stats.routes)
      .reduce((sum, route) => sum + route.scannedPostings, 0),
    deterministicGroups: result.deterministicGroups.length,
    deterministicEdges: result.deterministicGroups
      .reduce((sum, group) => sum + group.edges.length, 0),
    suspectedPairs: result.suspectedPairs.length,
    truncatedCount: result.stats.identitiesAtCompareLimit
      + Object.values(result.stats.routes).reduce((sum, route) => sum + route.truncatedFeatures, 0),
  };
}

export async function runDatabaseBenchmarkLocalStageInCurrentProcess(input: {
  readonly size: number;
  readonly scenario: DatabaseBenchmarkScenarioName;
  readonly seed: number;
  readonly run: number;
  readonly stage: DatabaseBenchmarkLocalStage;
}): Promise<DatabaseBenchmarkRawRun> {
  const fixture = buildDatabaseBenchmarkFixture(input.size, input.scenario, input.seed);
  const changedCount = fixture.preview.incrementalChangedProducts;
  const refreshedDocuments = () => fixture.candidateDocuments.map((document, index) => index < changedCount
    ? { ...document, product: `${document.product} revision` }
    : document);
  const refreshedIdentities = () => fixture.directoryIdentities.map((identity, index) => index < changedCount
    ? { ...identity, product: `${identity.product} revision` }
    : identity);
  const dimensions = { fixture, run: input.run, stage: input.stage };

  if (input.stage === 'candidate_index_build') {
    return (await measureLocalStage(
      dimensions,
      fixture.candidateDocuments.length,
      'documents',
      () => ({ value: new BoundedCandidateIndex(fixture.candidateDocuments, CANDIDATE_INDEX_OPTIONS) }),
    )).raw;
  }
  if (input.stage === 'candidate_index_full_rebuild_after_1pct_change') {
    const documents = refreshedDocuments();
    return (await measureLocalStage(dimensions, documents.length, 'documents', () => ({
      value: new BoundedCandidateIndex(documents, CANDIDATE_INDEX_OPTIONS),
      changedProducts: changedCount,
      rebuiltDocumentCount: documents.length,
    }))).raw;
  }
  if (input.stage === 'candidate_index_delta_refresh_after_1pct_change') {
    const index = VersionedCandidateIndex.build({
      version: 1n,
      aliasPolicyVersion: IDENTITY_POLICY_VERSION,
      documents: fixture.candidateDocuments,
    }, CANDIDATE_INDEX_OPTIONS);
    const changes: CatalogIndexChange[] = refreshedDocuments().slice(0, changedCount).map(document => ({
      version: 2n,
      standardProductId: document.id,
      operation: 'upsert',
      document,
    }));
    return (await measureLocalStage(dimensions, changes.length, 'changed_documents', () => {
      const result = index.applyChanges(changes, 2n, { aliasPolicyVersion: IDENTITY_POLICY_VERSION });
      if (!result.targetVersionReady || result.compaction.required) {
        throw new Error(`1% candidate delta unexpectedly requires compaction: ${result.compaction.reasons.join(', ')}`);
      }
      return {
        value: result,
        changedProducts: changedCount,
        processedChangeCount: result.processedChangeCount,
        rebuiltDocumentCount: result.rebuiltDocumentCount,
        deltaDocumentCount: result.deltaDocumentCount,
        tombstoneCount: result.tombstoneCount,
        compactionCount: 0,
      };
    })).raw;
  }
  if (input.stage === 'candidate_index_compaction_rebuild') {
    const index = VersionedCandidateIndex.build({
      version: 1n,
      aliasPolicyVersion: IDENTITY_POLICY_VERSION,
      documents: fixture.candidateDocuments,
    }, CANDIDATE_INDEX_OPTIONS);
    const compactionChangeCount = Math.min(
      fixture.candidateDocuments.length,
      Math.min(1_000, Math.ceil(fixture.candidateDocuments.length * 0.05)) + 1,
    );
    const documents = fixture.candidateDocuments.map((document, documentIndex) => documentIndex < compactionChangeCount
      ? { ...document, aliases: [...document.aliases, `compaction marker ${document.id}`] }
      : document);
    const changes: CatalogIndexChange[] = documents.slice(0, compactionChangeCount).map(document => ({
      version: 2n,
      standardProductId: document.id,
      operation: 'upsert',
      document,
    }));
    const applyResult = index.applyChanges(changes, 2n, { aliasPolicyVersion: IDENTITY_POLICY_VERSION });
    if (!applyResult.targetVersionReady) {
      throw new Error(`candidate compaction fixture blocked the target version: ${applyResult.compaction.reasons.join(', ')}`);
    }
    if (!index.needsCompaction().required) {
      throw new Error('candidate delta did not reach the compaction threshold');
    }
    return (await measureLocalStage(dimensions, documents.length, 'documents', () => ({
      value: VersionedCandidateIndex.build({
        version: 2n,
        aliasPolicyVersion: IDENTITY_POLICY_VERSION,
        documents,
      }, CANDIDATE_INDEX_OPTIONS),
      changedProducts: compactionChangeCount,
      processedChangeCount: applyResult.processedChangeCount,
      rebuiltDocumentCount: documents.length,
      deltaDocumentCount: applyResult.deltaDocumentCount,
      tombstoneCount: applyResult.tombstoneCount,
      compactionCount: 1,
    }))).raw;
  }
  if (input.stage === 'input_grouping') {
    return (await measureLocalStage(dimensions, fixture.groupingInputs.length, 'inputs', () => {
      const value = planSimilarityGroups(fixture.groupingInputs);
      return {
        value,
        scanned: value.stats.scanned,
        compared: value.stats.compared,
        candidateCount: value.stats.plannedPairCount,
        truncatedCount: value.stats.truncated ? 1 : 0,
        selectionVisits: value.stats.selectionVisits,
        peakScratchCandidates: value.stats.peakScratchCandidates,
        retainedFeatureCount: value.stats.retainedFeatureCount,
      };
    })).raw;
  }
  if (input.stage === 'candidate_query_local') {
    const candidateIndex = new BoundedCandidateIndex(refreshedDocuments(), CANDIDATE_INDEX_OPTIONS);
    return (await measureLocalStage(dimensions, fixture.groupingInputs.length, 'inputs', () => {
      let scanned = 0;
      let compared = 0;
      let candidateCount = 0;
      let truncatedCount = 0;
      for (const item of fixture.groupingInputs) {
        const result = candidateIndex.search({ text: item.text });
        scanned += result.stats.scanned;
        compared += result.stats.compared;
        candidateCount += result.candidates.length;
        if (result.stats.truncated) truncatedCount += 1;
      }
      return { value: true, scanned, compared, candidateCount, truncatedCount };
    })).raw;
  }
  if (input.stage === 'directory_duplicate_audit_full') {
    return (await measureLocalStage(dimensions, fixture.directoryIdentities.length, 'directory_products', () => {
      const value = auditStandardProductDuplicates(fixture.directoryIdentities, [], {
        snapshotVersion: `${input.seed}-${input.scenario}-${input.size}`,
        aliasVersion: 'benchmark-v1',
      });
      return { value, ...duplicateAuditMetrics(value) };
    })).raw;
  }
  const initialSnapshotVersion = `${input.seed}-${input.scenario}-${input.size}-v1`;
  const index = VersionedDuplicateAuditIndex.build({
    snapshotVersion: initialSnapshotVersion,
    aliasVersion: 'benchmark-v1',
    products: fixture.directoryIdentities,
    aliases: [],
  });
  const changed = refreshedIdentities().slice(0, changedCount);
  return (await measureLocalStage(dimensions, changedCount, 'changed_products', () => {
    const applied = index.applyChanges(
      changed.map(product => ({ productId: product.id, operation: 'upsert' as const, product })),
      `${input.seed}-${input.scenario}-${input.size}-v2`,
      { aliasVersion: 'benchmark-v1' },
    );
    const value = index.audit({ changedIds: changed.map(identity => identity.id) });
    return {
      value,
      ...duplicateAuditMetrics(value),
      changedProducts: changedCount,
      processedChangeCount: applied.processedChangeCount,
      rebuiltDocumentCount: 0,
    };
  })).raw;
}

export function databaseBenchmarkContainerResources(
  environment: NodeJS.ProcessEnv = process.env,
): DatabaseBenchmarkContainerResources | null {
  const cpuRaw = environment.STANDARDIZATION_BENCHMARK_CPU_LIMIT?.trim();
  const memoryRaw = environment.STANDARDIZATION_BENCHMARK_MEMORY_LIMIT_BYTES?.trim();
  if (!cpuRaw && !memoryRaw) return null;
  if (!cpuRaw || !memoryRaw) {
    throw new Error(
      'STANDARDIZATION_BENCHMARK_CPU_LIMIT and STANDARDIZATION_BENCHMARK_MEMORY_LIMIT_BYTES must be set together',
    );
  }
  const cpuLimit = Number(cpuRaw);
  if (!Number.isFinite(cpuLimit) || cpuLimit <= 0) {
    throw new Error('STANDARDIZATION_BENCHMARK_CPU_LIMIT must be a positive number');
  }
  const memoryLimitBytes = Number(memoryRaw);
  if (!Number.isSafeInteger(memoryLimitBytes) || memoryLimitBytes <= 0) {
    throw new Error('STANDARDIZATION_BENCHMARK_MEMORY_LIMIT_BYTES must be a positive integer');
  }
  return { cpuLimit, memoryLimitBytes };
}

export function validateDatabaseBenchmarkContainerCgroup(
  declared: DatabaseBenchmarkContainerResources,
  observed: { readonly cpuMax: string; readonly memoryMax: string },
): void {
  const [quotaRaw, periodRaw] = observed.cpuMax.trim().split(/\s+/u);
  const quota = Number(quotaRaw);
  const period = Number(periodRaw);
  if (!Number.isSafeInteger(quota) || quota <= 0 || !Number.isSafeInteger(period) || period <= 0
    || Math.abs(quota / period - declared.cpuLimit) > 1e-9) {
    throw new Error('declared container CPU limit does not match the cgroup quota');
  }
  const memoryLimit = Number(observed.memoryMax.trim());
  if (!Number.isSafeInteger(memoryLimit) || memoryLimit !== declared.memoryLimitBytes) {
    throw new Error('declared container memory limit does not match the cgroup limit');
  }
}

function failedLocalStageRun(
  input: {
    readonly size: number;
    readonly scenario: DatabaseBenchmarkScenarioName;
    readonly seed: number;
    readonly run: number;
    readonly stage: DatabaseBenchmarkLocalStage;
  },
  error: string,
): DatabaseBenchmarkRawRun {
  return {
    scenario: input.scenario,
    size: input.size,
    uniqueInputs: 0,
    directoryProducts: 0,
    evidenceBytes: 0,
    logicalTagRows: 0,
    expandedTagRows: 0,
    concurrency: 1,
    catalogState: 'local',
    run: input.run,
    stage: input.stage,
    durationMs: 0,
    cpuMs: 0,
    processId: 0,
    startRssBytes: 0,
    endRssBytes: 0,
    startHeapUsedBytes: 0,
    endHeapUsedBytes: 0,
    peakRssBytes: 0,
    rssMeasurement: 'process_max_rss',
    sqlQueries: 0,
    sqlP95Ms: 0,
    transactionMs: 0,
    lockWaitMs: 0,
    queueWaitMs: 0,
    throughputPerSecond: 0,
    processedItems: 0,
    throughputUnit: input.stage,
    scanned: 0,
    compared: 0,
    candidateCount: 0,
    truncatedCount: 0,
    selectionVisits: 0,
    peakScratchCandidates: 0,
    retainedFeatureCount: 0,
    processedChangeCount: 0,
    rebuiltDocumentCount: 0,
    deltaDocumentCount: 0,
    tombstoneCount: 0,
    compactionCount: 0,
    changedProducts: 0,
    routePostingsVisited: 0,
    deterministicGroups: 0,
    deterministicEdges: 0,
    suspectedPairs: 0,
    writtenRows: 0,
    writtenTagRows: 0,
    writtenBytes: 0,
    error,
  };
}

async function runDatabaseBenchmarkLocalStageChild(input: {
  readonly size: number;
  readonly scenario: DatabaseBenchmarkScenarioName;
  readonly seed: number;
  readonly run: number;
  readonly stage: DatabaseBenchmarkLocalStage;
}): Promise<DatabaseBenchmarkRawRun> {
  const runnerPath = fileURLToPath(new URL('./standardization-local-stage-runner.ts', import.meta.url));
  return await new Promise<DatabaseBenchmarkRawRun>((resolve) => {
    const child = spawn(process.execPath, [
      '--import', 'tsx', runnerPath,
      '--size', String(input.size),
      '--scenario', input.scenario,
      '--seed', String(input.seed),
      '--run', String(input.run),
      '--stage', input.stage,
    ], {
      cwd: path.dirname(fileURLToPath(import.meta.url)),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (raw: DatabaseBenchmarkRawRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(raw);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => finish(failedLocalStageRun(input, `child process error: ${error.message}`)));
    child.on('close', (code, signal) => {
      if (code !== 0 || signal) {
        finish(failedLocalStageRun(
          input,
          `child process exited code=${String(code)} signal=${signal ?? 'none'} stderr=${stderr.trim() || 'none'}`,
        ));
        return;
      }
      const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      if (lines.length !== 1) {
        finish(failedLocalStageRun(input, `child process emitted ${lines.length} JSON records; expected 1`));
        return;
      }
      try {
        const raw = JSON.parse(lines[0]!) as DatabaseBenchmarkRawRun;
        if (raw.stage !== input.stage || raw.scenario !== input.scenario || raw.run !== input.run) {
          finish(failedLocalStageRun(input, 'child process returned mismatched dimensions'));
          return;
        }
        finish(raw);
      } catch (error: unknown) {
        finish(failedLocalStageRun(input, `child process emitted invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(failedLocalStageRun(input, 'child process timed out after 600000ms'));
    }, 600_000);
    timeout.unref();
  });
}

export async function runDatabaseBenchmarkLocalScenario(input: {
  readonly size: number;
  readonly scenario: DatabaseBenchmarkScenarioName;
  readonly seed: number;
  readonly run: number;
}, options: {
  readonly stages?: readonly DatabaseBenchmarkLocalStage[];
  readonly runLocalStage?: DatabaseBenchmarkLocalStageRunner;
  readonly onStageStart?: (input: Parameters<DatabaseBenchmarkLocalStageRunner>[0]) => void;
  readonly onStageComplete?: (run: DatabaseBenchmarkRawRun) => void | Promise<void>;
} = {}): Promise<DatabaseBenchmarkRawRun[]> {
  const runLocalStage = options.runLocalStage ?? runDatabaseBenchmarkLocalStageChild;
  const stages = options.stages ?? DATABASE_BENCHMARK_LOCAL_STAGES;
  const runs: DatabaseBenchmarkRawRun[] = [];
  for (const stage of stages) {
    const stageInput = { ...input, stage };
    options.onStageStart?.(stageInput);
    const run = await runLocalStage(stageInput);
    runs.push(run);
    await options.onStageComplete?.(run);
  }
  return runs;
}

type DatabaseBenchmarkLocalStageRunner = (input: {
  readonly size: number;
  readonly scenario: DatabaseBenchmarkScenarioName;
  readonly seed: number;
  readonly run: number;
  readonly stage: DatabaseBenchmarkLocalStage;
}) => Promise<DatabaseBenchmarkRawRun>;

export async function resumeFailedLocalDatabaseBenchmarkRuns(
  report: DatabaseBenchmarkReport,
  runLocalStage: DatabaseBenchmarkLocalStageRunner = runDatabaseBenchmarkLocalStageChild,
): Promise<DatabaseBenchmarkReport> {
  const rawRuns = [...report.rawRuns];
  for (const [index, failed] of rawRuns.entries()) {
    if (failed.error === null) continue;
    if (!DATABASE_BENCHMARK_LOCAL_STAGES.includes(failed.stage as DatabaseBenchmarkLocalStage)) {
      throw new Error(`cannot resume failed database stage ${failed.stage}; run the complete benchmark again`);
    }
    const stage = failed.stage as DatabaseBenchmarkLocalStage;
    const input = {
      size: failed.size,
      scenario: failed.scenario,
      seed: report.configuration.seed,
      run: failed.run,
      stage,
    };
    const replacement = await runLocalStage(input);
    if (replacement.error !== null) {
      throw new Error(`resumed ${failed.scenario}/${failed.size}/${stage}/run-${failed.run} failed: ${replacement.error}`);
    }
    if (replacement.scenario !== failed.scenario || replacement.size !== failed.size
      || replacement.run !== failed.run || replacement.stage !== stage
      || replacement.concurrency !== failed.concurrency || replacement.catalogState !== failed.catalogState) {
      throw new Error(`resumed ${failed.scenario}/${failed.size}/${stage}/run-${failed.run} returned mismatched dimensions`);
    }
    rawRuns[index] = replacement;
  }
  return {
    ...report,
    generatedAt: new Date().toISOString(),
    rawRuns,
    aggregates: aggregateDatabaseBenchmarkRuns(rawRuns),
  };
}

export function aggregateDatabaseBenchmarkRuns(
  rawRuns: readonly DatabaseBenchmarkRawRun[],
): DatabaseBenchmarkAggregate[] {
  const groups = new Map<string, DatabaseBenchmarkRawRun[]>();
  for (const run of rawRuns) {
    const key = JSON.stringify([
      run.scenario,
      run.size,
      run.uniqueInputs,
      run.directoryProducts,
      run.evidenceBytes,
      run.logicalTagRows,
      run.expandedTagRows,
      run.concurrency,
      run.catalogState,
      run.stage,
      run.throughputUnit,
      run.rssMeasurement,
    ]);
    const group = groups.get(key);
    if (group) group.push(run);
    else groups.set(key, [run]);
  }

  return [...groups.values()].map((runs) => {
    const first = runs[0]!;
    const failedRuns = runs.filter((run) => run.error !== null).length;
    return {
      scenario: first.scenario,
      size: first.size,
      uniqueInputs: first.uniqueInputs,
      directoryProducts: first.directoryProducts,
      evidenceBytes: first.evidenceBytes,
      logicalTagRows: first.logicalTagRows,
      expandedTagRows: first.expandedTagRows,
      concurrency: first.concurrency,
      catalogState: first.catalogState,
      stage: first.stage,
      throughputUnit: first.throughputUnit,
      rssMeasurement: first.rssMeasurement,
      runs: runs.length,
      succeededRuns: runs.length - failedRuns,
      failedRuns,
      medianMs: percentile(runs.map((run) => run.durationMs), 0.5),
      p95Ms: percentile(runs.map((run) => run.durationMs), 0.95),
      medianCpuMs: percentile(runs.map((run) => run.cpuMs), 0.5),
      p95SqlMs: percentile(runs.map((run) => run.sqlP95Ms), 0.95),
      maxPeakRssBytes: Math.max(...runs.map((run) => run.peakRssBytes)),
      p95TransactionMs: percentile(runs.map((run) => run.transactionMs), 0.95),
      p95LockWaitMs: percentile(runs.map((run) => run.lockWaitMs), 0.95),
      p95QueueWaitMs: percentile(runs.map((run) => run.queueWaitMs), 0.95),
      medianThroughputPerSecond: percentile(runs.map((run) => run.throughputPerSecond), 0.5),
      maxScanned: Math.max(...runs.map((run) => run.scanned)),
      maxCompared: Math.max(...runs.map((run) => run.compared)),
      maxCandidateCount: Math.max(...runs.map((run) => run.candidateCount)),
      maxTruncatedCount: Math.max(...runs.map((run) => run.truncatedCount)),
      maxSelectionVisits: Math.max(...runs.map((run) => run.selectionVisits)),
      maxPeakScratchCandidates: Math.max(...runs.map((run) => run.peakScratchCandidates)),
      maxRetainedFeatureCount: Math.max(...runs.map((run) => run.retainedFeatureCount)),
      maxProcessedChangeCount: Math.max(...runs.map((run) => run.processedChangeCount)),
      maxRebuiltDocumentCount: Math.max(...runs.map((run) => run.rebuiltDocumentCount)),
      maxDeltaDocumentCount: Math.max(...runs.map((run) => run.deltaDocumentCount)),
      maxTombstoneCount: Math.max(...runs.map((run) => run.tombstoneCount)),
      maxCompactionCount: Math.max(...runs.map((run) => run.compactionCount)),
      maxChangedProducts: Math.max(...runs.map((run) => run.changedProducts)),
      maxRoutePostingsVisited: Math.max(...runs.map((run) => run.routePostingsVisited)),
      maxDeterministicGroups: Math.max(...runs.map((run) => run.deterministicGroups)),
      maxDeterministicEdges: Math.max(...runs.map((run) => run.deterministicEdges)),
      maxSuspectedPairs: Math.max(...runs.map((run) => run.suspectedPairs)),
      totalProcessedItems: runs.reduce((sum, run) => sum + run.processedItems, 0),
      totalWrittenRows: runs.reduce((sum, run) => sum + run.writtenRows, 0),
      totalWrittenTagRows: runs.reduce((sum, run) => sum + run.writtenTagRows, 0),
      totalWrittenBytes: runs.reduce((sum, run) => sum + run.writtenBytes, 0),
    };
  });
}

class BenchmarkQueryMetrics implements KyselyPlugin {
  private readonly startedAt = new WeakMap<QueryId, number[]>();
  private durations: number[] = [];

  transformQuery({ queryId, node }: { queryId: QueryId; node: RootOperationNode }): RootOperationNode {
    const samples = this.startedAt.get(queryId) ?? [];
    samples.push(performance.now());
    this.startedAt.set(queryId, samples);
    return node;
  }

  async transformResult({
    queryId,
    result,
  }: {
    queryId: QueryId;
    result: QueryResult<UnknownRow>;
  }): Promise<QueryResult<UnknownRow>> {
    const samples = this.startedAt.get(queryId);
    const startedAt = samples?.shift();
    if (startedAt !== undefined) this.durations.push(performance.now() - startedAt);
    return result;
  }

  reset(): void {
    this.durations = [];
  }

  snapshot(): QueryMetricsSnapshot {
    return {
      queries: this.durations.length,
      p95Ms: this.durations.length ? percentile(this.durations, 0.95) : 0,
    };
  }
}

export class DatabaseBenchmarkInterruptedError extends Error {
  constructor() {
    super('database benchmark interrupted at the latest recoverable boundary');
    this.name = 'DatabaseBenchmarkInterruptedError';
  }
}

export interface DatabaseBenchmarkRunOptions {
  readonly checkpoint?: DatabaseBenchmarkCheckpoint;
  readonly onCheckpoint?: (checkpoint: DatabaseBenchmarkCheckpoint) => void | Promise<void>;
  readonly onProgress?: (progress: DatabaseBenchmarkProgress) => void;
  readonly progressIntervalMs?: number;
  readonly shouldStop?: () => boolean;
}

function localBenchmarkStageKey(input: {
  readonly scenario: DatabaseBenchmarkScenarioName;
  readonly size: number;
  readonly run: number;
  readonly stage: string;
}): string {
  return JSON.stringify([input.scenario, input.size, input.run, input.stage]);
}

export async function runStandardizationDatabaseBenchmark(
  environment: NodeJS.ProcessEnv = process.env,
  options: DatabaseBenchmarkRunOptions = {},
): Promise<DatabaseBenchmarkReport> {
  const configuration = databaseBenchmarkConfiguration(environment);
  validateDatabaseBenchmarkScenarioCoverage(DATABASE_BENCHMARK_SCENARIOS);
  const seed = positiveInteger(environment.STANDARDIZATION_BENCHMARK_SEED, 20_260_920, 'STANDARDIZATION_BENCHMARK_SEED');
  const reportConfiguration: DatabaseBenchmarkReport['configuration'] = {
    sizes: configuration.sizes,
    concurrencyLevels: configuration.concurrencyLevels,
    runsPerScenario: configuration.runsPerScenario,
    scenarios: configuration.scenarios,
    connectionBudget: configuration.connectionBudget,
    seed,
  };
  const previousSchema = process.env.PG_SCHEMA;
  const admin = new Pool({ connectionString: configuration.databaseUrl, max: 1 });
  let database: Kysely<DatabaseSchema> | undefined;
  let pool: Pool | undefined;
  let schemaCreated = false;
  let progressTimer: NodeJS.Timeout | undefined;
  try {
    await admin.query(`create schema "${configuration.schema}"`);
    schemaCreated = true;
    process.env.PG_SCHEMA = configuration.schema;
    pool = new Pool({
      connectionString: configuration.databaseUrl,
      options: `-c search_path="${configuration.schema}",public`,
      max: Math.max(2, ...configuration.concurrencyLevels),
    });
    const queryMetrics = new BenchmarkQueryMetrics();
    database = new Kysely<DatabaseSchema>({
      dialect: new PostgresDialect({ pool }),
      plugins: [queryMetrics],
    });
    const originalInfo = console.info;
    console.info = () => undefined;
    try {
      await migrateToLatest(database);
    } finally {
      console.info = originalInfo;
    }

    const environmentReport = await readDatabaseBenchmarkEnvironment(pool, environment);
    const benchmarkEnvironment: DatabaseBenchmarkReport['environment'] = {
      ...environmentReport,
      policyVersion: IDENTITY_POLICY_VERSION,
    };
    const resumePlan = options.checkpoint
      ? planDatabaseBenchmarkResume(options.checkpoint, {
        configuration: reportConfiguration,
        environment: benchmarkEnvironment,
      })
      : undefined;
    const rawRuns: DatabaseBenchmarkRawRun[] = [...(resumePlan?.rawRuns ?? [])];
    const explainPlans: Record<string, JsonValue> = { ...(resumePlan?.explainPlans ?? {}) };
    let completedUnits = resumePlan?.completedUnits ?? 0;
    const activeElapsedBeforeSession = resumePlan?.activeElapsedMs ?? 0;
    const startedAt = resumePlan?.startedAt ?? new Date().toISOString();
    const sessionStartedAt = performance.now();
    const matrix = buildDatabaseBenchmarkScenarioMatrix();
    const totalUnits = databaseBenchmarkTotalStageUnits({
      matrixEntries: matrix.length,
      runsPerScenario: configuration.runsPerScenario,
      concurrencyLevels: configuration.concurrencyLevels,
    });
    let currentWork = 'initializing';
    const activeElapsedMs = (): number => activeElapsedBeforeSession + performance.now() - sessionStartedAt;
    const emitProgress = (): void => {
      options.onProgress?.(calculateDatabaseBenchmarkProgress({
        completedUnits,
        totalUnits,
        activeElapsedMs: activeElapsedMs(),
        current: currentWork,
      }));
    };
    const checkpoint = (): DatabaseBenchmarkCheckpoint => ({
      status: 'in_progress',
      generatedAt: new Date().toISOString(),
      startedAt,
      activeElapsedMs: activeElapsedMs(),
      schema: configuration.schema,
      configuration: reportConfiguration,
      environment: benchmarkEnvironment,
      rawRuns,
      explainPlans,
      providerRequestCount: 0,
    });
    const persistBoundary = async (): Promise<void> => {
      await options.onCheckpoint?.(checkpoint());
      if (options.shouldStop?.()) throw new DatabaseBenchmarkInterruptedError();
    };
    const throwIfInterrupted = (): void => {
      if (options.shouldStop?.()) throw new DatabaseBenchmarkInterruptedError();
    };
    const intervalMs = options.progressIntervalMs ?? 180_000;
    if (options.onProgress) {
      emitProgress();
      progressTimer = setInterval(emitProgress, intervalMs);
      progressTimer.unref();
    }
    await persistBoundary();

    const completedLocalStages = new Set(rawRuns
      .filter(run => run.error === null && DATABASE_BENCHMARK_LOCAL_STAGES.includes(run.stage as DatabaseBenchmarkLocalStage))
      .map(localBenchmarkStageKey));
    const completedDatabaseIterations = new Set(rawRuns
      .filter(run => DATABASE_BENCHMARK_DATABASE_STAGES.includes(run.stage as typeof DATABASE_BENCHMARK_DATABASE_STAGES[number]))
      .map(databaseBenchmarkIterationKey));

    for (const entry of matrix) {
      for (let run = 1; run <= configuration.runsPerScenario; run += 1) {
        const pendingStages = DATABASE_BENCHMARK_LOCAL_STAGES.filter(stage => !completedLocalStages.has(localBenchmarkStageKey({
          scenario: entry.scenario,
          size: entry.size,
          run,
          stage,
        })));
        throwIfInterrupted();
        await runDatabaseBenchmarkLocalScenario({
          size: entry.size,
          scenario: entry.scenario,
          seed,
          run,
        }, {
          stages: pendingStages,
          onStageStart: stageInput => {
            currentWork = `${entry.scenario}/${entry.size}/${stageInput.stage}/run-${run}`;
          },
          onStageComplete: async measured => {
            rawRuns.push(measured);
            if (measured.error === null) {
              completedUnits += 1;
              completedLocalStages.add(localBenchmarkStageKey(measured));
            }
            await persistBoundary();
          },
        });
      }

      const pendingIterations = configuration.concurrencyLevels.flatMap(concurrency => (
        (['cold', 'warm'] as const).flatMap(catalogState => (
          Array.from({ length: configuration.runsPerScenario }, (_, index) => ({
            concurrency,
            catalogState,
            run: index + 1,
          })).filter(iteration => !completedDatabaseIterations.has(JSON.stringify([
            entry.scenario, entry.size, iteration.concurrency, iteration.catalogState, iteration.run,
          ])))
        ))
      ));
      const needsExplainPlans = entry.size === 10_000
        && EXPLAIN_PLAN_SCENARIOS.includes(entry.scenario)
        && !EXPLAIN_PLAN_NAMES.every(name => `${entry.scenario}.${name}` in explainPlans);
      if (pendingIterations.length === 0 && !needsExplainPlans) continue;

      throwIfInterrupted();
      currentWork = `${entry.scenario}/${entry.size}/fixture`;
      const fixture = buildDatabaseBenchmarkFixture(entry.size, entry.scenario, seed);
      const seeded = await seedDatabaseBenchmarkScenario(database, fixture);
      if (needsExplainPlans) {
        currentWork = `${entry.scenario}/${entry.size}/explain-plans`;
        const scenarioPlans = await captureDatabaseBenchmarkPlans(database, pool, seeded);
        for (const [name, plan] of Object.entries(scenarioPlans)) {
          explainPlans[`${entry.scenario}.${name}`] = plan;
        }
        await persistBoundary();
      }
      for (const iteration of pendingIterations) {
        throwIfInterrupted();
        currentWork = `${entry.scenario}/${entry.size}/c${iteration.concurrency}/${iteration.catalogState}/run-${iteration.run}`;
        const measured = await runDatabaseBenchmarkIteration({
          database,
          admin,
          schema: configuration.schema,
          queryMetrics,
          seeded,
          size: entry.size,
          concurrency: iteration.concurrency,
          catalogState: iteration.catalogState,
          run: iteration.run,
        });
        rawRuns.push(...measured);
        await resetDatabaseBenchmarkWorkload(database);
        if (measured.length === DATABASE_BENCHMARK_DATABASE_STAGES.length
          && measured.every(run => run.error === null)) {
          completedUnits += DATABASE_BENCHMARK_DATABASE_STAGES.length;
          completedDatabaseIterations.add(databaseBenchmarkIterationKey(measured[0]!));
        }
        await persistBoundary();
      }
    }

    currentWork = 'complete';
    emitProgress();
    return {
      status: 'executed',
      generatedAt: new Date().toISOString(),
      schema: configuration.schema,
      configuration: reportConfiguration,
      environment: benchmarkEnvironment,
      rawRuns,
      aggregates: aggregateDatabaseBenchmarkRuns(rawRuns),
      explainPlans,
      providerRequestCount: 0,
    };
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    await database?.destroy();
    if (!database) await pool?.end();
    if (schemaCreated) await admin.query(`drop schema if exists "${configuration.schema}" cascade`);
    await admin.end();
    if (previousSchema === undefined) delete process.env.PG_SCHEMA;
    else process.env.PG_SCHEMA = previousSchema;
  }
}

export function postgresShowValue(
  row: Readonly<Record<string, unknown>> | undefined,
  settingName: string,
): string {
  return String(row?.[settingName] ?? 'unknown');
}

async function readDatabaseBenchmarkEnvironment(
  pool: Pool,
  environment: NodeJS.ProcessEnv,
): Promise<Omit<DatabaseBenchmarkReport['environment'], 'policyVersion'>> {
  const containerResources = databaseBenchmarkContainerResources(environment);
  if (containerResources) {
    if (process.platform !== 'linux') throw new Error('deployment container benchmark requires Linux cgroup v2');
    const [cpuMax, memoryMax] = await Promise.all([
      readFile('/sys/fs/cgroup/cpu.max', 'utf8'),
      readFile('/sys/fs/cgroup/memory.max', 'utf8'),
    ]);
    validateDatabaseBenchmarkContainerCgroup(containerResources, { cpuMax, memoryMax });
  }
  const version = await pool.query<Record<string, unknown>>('show server_version');
  const settings: Record<string, string> = {};
  for (const name of ['shared_buffers', 'work_mem', 'max_connections', 'effective_cache_size']) {
    const result = await pool.query<Record<string, unknown>>(`show ${name}`);
    settings[name] = postgresShowValue(result.rows[0], name);
  }
  return {
    node: process.version,
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    cpuModel: os.cpus()[0]?.model ?? 'unknown',
    cpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    containerResources,
    postgresVersion: postgresShowValue(version.rows[0], 'server_version'),
    postgresSettings: settings,
  };
}

async function seedDatabaseBenchmarkScenario(
  database: Kysely<DatabaseSchema>,
  fixture: BenchmarkFixture,
): Promise<SeededScenario> {
  const { preview } = fixture;
  await sql`truncate table ai_jobs, standard_products, products, shops restart identity cascade`.execute(database);
  const shop = await database.insertInto('shops').values({
    platform: 'benchmark',
    url: `https://benchmark.invalid/${preview.scenario}/${preview.size}`,
    name: `benchmark-${preview.scenario}-${preview.size}`,
    enabled: true,
    last_fetch_at: null,
    last_success_at: null,
    last_error: null,
    deleted_at: null,
  }).returning('id').executeTakeFirstOrThrow();
  const rawProductIds: bigint[] = [];
  const rawRows = fixture.rawProducts.map((product, index) => {
    const { name, spec, sourceCategory, sourceData } = product;
    return {
      shop_id: shop.id,
      external_id: product.externalId,
      name,
      spec,
      source_category: sourceCategory,
      source_data: jsonb(sourceData),
      normalized_key: `raw-${index}`,
      url: `https://benchmark.invalid/product/raw-${index}`,
      image_url: null,
      deleted_at: null,
      standardization_locked: false,
      content_version: 1n,
      content_fingerprint: productContentFingerprint({ name, spec, sourceCategory, sourceData }),
    };
  });
  for (const rows of chunked(rawRows, 500)) {
    const inserted = await database.insertInto('products').values(rows).returning('id').execute();
    rawProductIds.push(...inserted.map(row => row.id));
  }

  const catalogProductIds: bigint[] = [];
  const catalogRows = fixture.catalogProducts.map((product, index) => {
    const { name, spec, sourceCategory, sourceData } = product;
    return {
      shop_id: shop.id,
      external_id: product.externalId,
      name,
      spec,
      source_category: sourceCategory,
      source_data: jsonb(sourceData),
      normalized_key: `catalog-${index}`,
      url: `https://benchmark.invalid/product/catalog-${index}`,
      image_url: null,
      deleted_at: null,
      standardization_locked: false,
      content_version: 1n,
      content_fingerprint: productContentFingerprint({ name, spec, sourceCategory, sourceData }),
    };
  });
  for (const rows of chunked(catalogRows, 500)) {
    const inserted = await database.insertInto('products').values(rows).returning('id').execute();
    catalogProductIds.push(...inserted.map(row => row.id));
  }

  const standardRows = fixture.directoryIdentities.map((fields, index) => {
    return {
      name: `${fields.family} / ${fields.product} / ${fields.tier}`,
      platform: 'benchmark',
      standard_key: buildCanonicalStandardKey(fields),
      canonical_platform: 'benchmark',
      canonical_vendor: 'benchmark',
      canonical_family: fields.family,
      canonical_product: fields.product,
      canonical_tier: fields.tier,
      verification_state: 'verified' as const,
    };
  });
  const standardIds: bigint[] = [];
  for (const rows of chunked(standardRows, 500)) {
    const inserted = await database.insertInto('standard_products').values(rows).returning('id').execute();
    standardIds.push(...inserted.map(row => row.id));
  }
  for (let offset = 0; offset < standardIds.length; offset += 500) {
    await database.insertInto('standard_product_members').values(
      standardIds.slice(offset, offset + 500).map((standardProductId, innerIndex) => ({
        standard_product_id: standardProductId,
        product_id: catalogProductIds[offset + innerIndex]!,
        publication_state: 'published' as const,
        decision_version: 0n,
        assignment_source: 'benchmark_seed',
      })),
    ).execute();
  }
  return {
    scenario: preview.scenario,
    rawProductIds,
    uniqueInputs: preview.uniqueInputs,
    directoryProducts: preview.directoryProducts,
    evidenceBytes: preview.evidenceBytes,
    logicalTagRows: preview.logicalTagRows,
    expandedTagRows: preview.expandedTagRows,
    publicationDelayMs: preview.publicationDelayMs,
    lockHoldMs: preview.lockHoldMs,
    incrementalChangedProducts: preview.incrementalChangedProducts,
    sampleStandardKey: standardRows[0]!.standard_key,
  };
}

async function runDatabaseBenchmarkIteration(input: {
  readonly database: Kysely<DatabaseSchema>;
  readonly admin: Pool;
  readonly schema: string;
  readonly queryMetrics: BenchmarkQueryMetrics;
  readonly seeded: SeededScenario;
  readonly size: number;
  readonly concurrency: number;
  readonly catalogState: 'cold' | 'warm';
  readonly run: number;
}): Promise<DatabaseBenchmarkRawRun[]> {
  const { database, queryMetrics, seeded, size, concurrency, catalogState, run } = input;
  const rawRuns: DatabaseBenchmarkRawRun[] = [];
  const repository = new AiRepository(database);
  const jobs = new JobsRepository(database);
  const dimensions = {
    queryMetrics,
    scenario: seeded.scenario,
    size,
    uniqueInputs: seeded.uniqueInputs,
    directoryProducts: seeded.directoryProducts,
    evidenceBytes: seeded.evidenceBytes,
    logicalTagRows: seeded.logicalTagRows,
    expandedTagRows: seeded.expandedTagRows,
    concurrency,
    catalogState,
    run,
  } as const;
  const preparation = await measureDatabaseStage({ ...dimensions, stage: 'request_preparation' }, async () => {
    const transactionStartedAt = performance.now();
    const job = await repository.createJob({
      model: 'offline-database-benchmark',
      productIds: seeded.rawProductIds,
      batchSize: 32,
    });
    await database.updateTable('ai_jobs').set({ request_window_size: Math.min(64, concurrency) }).where('id', '=', job.id).execute();
    return {
      value: job,
      processedItems: job.inputs.length,
      throughputUnit: 'inputs',
      writtenRows: 1 + job.inputs.length + size + job.batches.length + size,
      writtenBytes: seeded.evidenceBytes,
      transactionMs: performance.now() - transactionStartedAt,
    };
  });
  rawRuns.push(preparation.raw);
  if (!preparation.ok || !preparation.value || preparation.value.batches.length === 0) return rawRuns;
  const job = preparation.value;

  const measuredBatchIndex = catalogState === 'warm' && job.batches.length > 1 ? 1 : 0;
  if (catalogState === 'warm') await repository.prepareBatch(job.batches[0]!.id);
  const candidate = await measureDatabaseStage({ ...dimensions, stage: 'candidate_query' }, async () => {
    const transactionStartedAt = performance.now();
    await repository.prepareBatch(job.batches[measuredBatchIndex]!.id);
    return {
      value: true,
      processedItems: job.batches[measuredBatchIndex]!.productIds.length,
      throughputUnit: 'inputs',
      writtenRows: 1,
      writtenBytes: 0,
      transactionMs: performance.now() - transactionStartedAt,
    };
  });
  rawRuns.push(candidate.raw);
  if (!candidate.ok) return rawRuns;

  const claim = await measureDatabaseStage({ ...dimensions, stage: 'rolling_window_claim' }, async () => {
    const transactionStartedAt = performance.now();
    const claimed = await jobs.claimAvailable('ai_standardization', `benchmark-request-${run}`, concurrency, 120_000);
    const queueWaits = claimed.map(claimedWorkQueueWaitMs);
    return {
      value: claimed,
      processedItems: claimed.length,
      throughputUnit: 'batches',
      writtenRows: claimed.length * 2,
      writtenBytes: 0,
      queueWaitMs: queueWaits.length ? percentile(queueWaits, 0.95) : 0,
      transactionMs: performance.now() - transactionStartedAt,
    };
  });
  rawRuns.push(claim.raw);
  if (!claim.ok || !claim.value?.length) return rawRuns;

  for (const work of claim.value) {
    await repository.prepareBatch(work.id);
    const claimIdentity = claimFor(work);
    await repository.reserveBatchRequest(work.id, claimIdentity);
    await repository.recordBatchRequestOutcome(work.id, 'confirmed');
    const request = await repository.getBatchRequest(work.id);
    await repository.persistBatchDecision(
      request.jobId,
      work.id,
      benchmarkDecision(request.inputs.map(item => item.productId), work.id),
      { firstContentMs: 0, responseMs: 0, outputBytes: 0, retryClass: null },
      claimIdentity,
    );
  }
  const publicationClaims = await jobs.claimAvailable('ai_standardization', `benchmark-publish-${run}`, concurrency, 120_000);
  const lock = await measureDatabaseStage({ ...dimensions, stage: 'lock_contention' }, async () => {
    const first = publicationClaims[0];
    if (!first) return { value: true, processedItems: 0, throughputUnit: 'locked_rows', lockWaitMs: 0 };
    const lockWaitMs = await measureControlledLockContention(
      input.admin,
      input.schema,
      first.id,
      seeded.lockHoldMs,
      () => database.transaction().execute(async transaction => {
        await transaction.selectFrom('ai_job_batches').select('id').where('id', '=', first.id).forUpdate().executeTakeFirstOrThrow();
      }),
    );
    return { value: true, processedItems: 1, throughputUnit: 'locked_rows', lockWaitMs, transactionMs: lockWaitMs };
  });
  rawRuns.push(lock.raw);
  if (!lock.ok) return rawRuns;

  const publication = await measureDatabaseStage({ ...dimensions, stage: 'publication_commit' }, async () => {
    if (seeded.publicationDelayMs > 0) await delay(seeded.publicationDelayMs);
    const transactionStartedAt = performance.now();
    await Promise.all(publicationClaims.map(work => repository.publishBatch(work.id, claimFor(work))));
    const transactionMs = performance.now() - transactionStartedAt;
    const publishedMembers = publicationClaims.reduce((sum, work) => sum + Number(work.row.product_count ?? 0), 0);
    return {
      value: true,
      processedItems: publishedMembers,
      throughputUnit: 'published_members',
      writtenRows: publishedMembers * 4 + publicationClaims.length * 3,
      writtenTagRows: 0,
      writtenBytes: publishedMembers * 512,
      transactionMs,
    };
  });
  rawRuns.push(publication.raw);
  if (!publication.ok) return rawRuns;

  await database.updateTable('ai_job_batches').set({
    status: 'failed',
    error_source: 'provider_terminal',
    error: 'offline benchmark terminal fixture',
    claimed_by: null,
    claim_token: null,
    lease_until: null,
    finished_at: sql`now()`,
  }).where('job_id', '=', job.id).where('status', 'in', ['queued', 'running']).execute();
  const finalization = await measureDatabaseStage({ ...dimensions, stage: 'finalization' }, async () => {
    const transactionStartedAt = performance.now();
    await database.transaction().execute(tx => finalizeOrScheduleMissing(tx, job.id));
    const transactionMs = performance.now() - transactionStartedAt;
    const count = await database.selectFrom('ai_standardization_results')
      .select(sql<number>`count(*)::int`.as('count')).where('job_id', '=', job.id).executeTakeFirstOrThrow();
    return {
      value: true,
      processedItems: count.count,
      throughputUnit: 'results',
      writtenRows: count.count * 4 + 1,
      writtenBytes: count.count * 384,
      transactionMs,
    };
  });
  rawRuns.push(finalization.raw);
  return rawRuns;
}

async function measureDatabaseStage<T>(
  dimensions: {
    readonly queryMetrics: BenchmarkQueryMetrics;
    readonly scenario: DatabaseBenchmarkScenarioName;
    readonly size: number;
    readonly uniqueInputs: number;
    readonly directoryProducts: number;
    readonly evidenceBytes: number;
    readonly logicalTagRows: number;
    readonly expandedTagRows: number;
    readonly concurrency: number;
    readonly catalogState: string;
    readonly run: number;
    readonly stage: DatabaseBenchmarkStage;
  },
  action: () => Promise<DatabaseStageActionResult<T>>,
): Promise<StageMeasurement<T>> {
  dimensions.queryMetrics.reset();
  const startMemory = process.memoryUsage();
  const startedAt = performance.now();
  const cpuStart = process.cpuUsage();
  let peakRssBytes = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }, 5);
  sampler.unref();
  let result: DatabaseStageActionResult<T> | undefined;
  let error: string | null = null;
  try {
    result = await action();
  } catch (candidate: unknown) {
    error = candidate instanceof Error ? candidate.message : String(candidate);
  } finally {
    clearInterval(sampler);
  }
  const durationMs = performance.now() - startedAt;
  const cpu = process.cpuUsage(cpuStart);
  const finalMemory = finalizeSampledMemoryMeasurement(peakRssBytes);
  const querySnapshot = dimensions.queryMetrics.snapshot();
  return {
    ok: error === null,
    value: result?.value,
    raw: {
      scenario: dimensions.scenario,
      size: dimensions.size,
      uniqueInputs: dimensions.uniqueInputs,
      directoryProducts: dimensions.directoryProducts,
      evidenceBytes: dimensions.evidenceBytes,
      logicalTagRows: dimensions.logicalTagRows,
      expandedTagRows: dimensions.expandedTagRows,
      concurrency: dimensions.concurrency,
      catalogState: dimensions.catalogState,
      run: dimensions.run,
      stage: dimensions.stage,
      durationMs,
      cpuMs: (cpu.user + cpu.system) / 1_000,
      processId: process.pid,
      startRssBytes: startMemory.rss,
      endRssBytes: finalMemory.endMemory.rss,
      startHeapUsedBytes: startMemory.heapUsed,
      endHeapUsedBytes: finalMemory.endMemory.heapUsed,
      peakRssBytes: finalMemory.peakRssBytes,
      rssMeasurement: 'sampled_peak',
      sqlQueries: querySnapshot.queries,
      sqlP95Ms: querySnapshot.p95Ms,
      transactionMs: result?.transactionMs ?? 0,
      lockWaitMs: result?.lockWaitMs ?? 0,
      queueWaitMs: result?.queueWaitMs ?? 0,
      throughputPerSecond: error === null
        ? (result?.processedItems ?? 0) / Math.max(durationMs / 1_000, Number.EPSILON)
        : 0,
      processedItems: result?.processedItems ?? 0,
      throughputUnit: result?.throughputUnit ?? dimensions.stage,
      scanned: result?.scanned ?? 0,
      compared: result?.compared ?? 0,
      candidateCount: result?.candidateCount ?? 0,
      truncatedCount: result?.truncatedCount ?? 0,
      selectionVisits: result?.selectionVisits ?? 0,
      peakScratchCandidates: result?.peakScratchCandidates ?? 0,
      retainedFeatureCount: result?.retainedFeatureCount ?? 0,
      processedChangeCount: result?.processedChangeCount ?? 0,
      rebuiltDocumentCount: result?.rebuiltDocumentCount ?? 0,
      deltaDocumentCount: result?.deltaDocumentCount ?? 0,
      tombstoneCount: result?.tombstoneCount ?? 0,
      compactionCount: result?.compactionCount ?? 0,
      changedProducts: result?.changedProducts ?? 0,
      routePostingsVisited: result?.routePostingsVisited ?? 0,
      deterministicGroups: result?.deterministicGroups ?? 0,
      deterministicEdges: result?.deterministicEdges ?? 0,
      suspectedPairs: result?.suspectedPairs ?? 0,
      writtenRows: result?.writtenRows ?? 0,
      writtenTagRows: result?.writtenTagRows ?? 0,
      writtenBytes: result?.writtenBytes ?? 0,
      error,
    },
  };
}

export function finalizeSampledMemoryMeasurement(
  peakRssBytes: number,
  memoryUsage: () => NodeJS.MemoryUsage = process.memoryUsage,
): { readonly endMemory: NodeJS.MemoryUsage; readonly peakRssBytes: number } {
  const endMemory = memoryUsage();
  return {
    endMemory,
    peakRssBytes: Math.max(peakRssBytes, endMemory.rss),
  };
}

function claimFor(work: ClaimedJob): { workerId: string; attempt: bigint; token: string } {
  const token = work.row.claim_token;
  if (typeof token !== 'string' || !token) throw new Error('benchmark claim did not include a claim token');
  return { workerId: work.claimed_by, attempt: work.attempts, token };
}

function benchmarkDecision(
  productIds: readonly bigint[],
  batchId: bigint,
): ParsedStandardizationResponse {
  const fields = { family: `benchmark-run-${batchId}`, product: 'service', tier: 'standard' };
  const canonicalKey = buildCanonicalStandardKey(fields);
  const ref = `benchmark-${batchId}`;
  return {
    identities: [{
      ref,
      ...fields,
      canonicalKey,
      reason: 'offline database benchmark fixture',
      evidence: [{ path: 'name', quote: 'Service' }],
    }],
    items: productIds.map(productId => ({
      id: productId.toString(),
      status: 'classified' as const,
      identity: { kind: 'new' as const, ref, canonicalKey },
      ruleIds: ['offline-benchmark'],
      evidence: [{ path: 'name', quote: 'Service' }],
      reasonCode: null,
      reason: 'offline database benchmark fixture',
    })),
    missingIds: [],
  };
}

async function measureControlledLockContention(
  admin: Pool,
  schema: string,
  batchId: bigint,
  lockHoldMs: number,
  waitForLock: () => Promise<void>,
): Promise<number> {
  const client = await admin.connect();
  try {
    await client.query('begin');
    await client.query(`set local search_path to "${schema}", public`);
    await client.query('select id from ai_job_batches where id = $1 for update', [batchId.toString()]);
    const startedAt = performance.now();
    const waiter = waitForLock();
    await delay(lockHoldMs);
    await client.query('commit');
    await waiter;
    return performance.now() - startedAt;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function claimedWorkQueueWaitMs(work: ClaimedJob): number {
  const row = (work as ClaimedJob & { row: Record<string, unknown> }).row;
  const startedAt = timestampMillis(row.started_at);
  const queuedAt = timestampMillis(row.queued_at);
  return startedAt === null || queuedAt === null ? 0 : Math.max(0, startedAt - queuedAt);
}

function timestampMillis(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function delay(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function resetDatabaseBenchmarkWorkload(database: Kysely<DatabaseSchema>): Promise<void> {
  await sql`delete from ai_jobs`.execute(database);
  await sql`delete from product_tags`.execute(database);
  await sql`delete from standard_product_members where assignment_source = 'ai'`.execute(database);
  await sql`delete from standard_products where canonical_family like 'benchmark-run-%'`.execute(database);
}

async function captureDatabaseBenchmarkPlans(
  database: Kysely<DatabaseSchema>,
  pool: Pool,
  seeded: SeededScenario,
): Promise<Record<string, JsonValue>> {
  const repository = new AiRepository(database);
  const job = await repository.createJob({
    model: 'offline-database-benchmark-plan',
    productIds: seeded.rawProductIds.slice(0, 32),
    batchSize: 32,
  });
  const batchId = job.batches[0]!.id;
  await database.insertInto('ai_publication_units').values({
    batch_id: batchId,
    unit_index: 0,
    product_ids: jsonb(job.inputs.slice(0, 1).map(input => input.productId.toString())),
    member_count: 1,
    tag_count: 0,
    payload_bytes: 1n,
    status: 'queued',
  }).execute();
  try {
    return {
      candidate_lookup: await explainQuery(pool, `
        select sp.id from standard_products sp
        where sp.standard_key = $1
          and exists (
            select 1 from standard_product_members m
            where m.standard_product_id = sp.id and m.publication_state = 'published'
          )
      `, [seeded.sampleStandardKey]),
      rolling_window_claim: await explainQuery(pool, `
        select q.id from ai_job_batches q
        where q.status = 'queued' and q.available_at <= now()
          and exists (
            select 1 from ai_jobs j where j.id = q.job_id
              and q.batch_index < coalesce((
                select min(w.batch_index) from ai_job_batches w
                where w.job_id = q.job_id and w.round = q.round
                  and w.step <> 'done' and w.status not in ('failed','cancelled')
              ), q.batch_index) + j.request_window_size
          )
        order by q.available_at, q.id limit 1 for update skip locked
      `),
      publication_unit: {
        batch_lock: await explainQuery(pool, `
          select id from ai_job_batches where id = $1 for update
        `, [batchId.toString()]),
        unit_list: await explainQuery(pool, `
          select id from ai_publication_units
          where batch_id = $1 and status in ('queued','running') order by unit_index
        `, [batchId.toString()]),
        unit_claim: await explainQuery(pool, `
          select id from ai_publication_units
          where batch_id = $1 and status in ('queued','running')
          order by unit_index limit 1 for update
        `, [batchId.toString()]),
        member_lock: await explainQuery(pool, `
          select product_id from ai_job_input_members
          where job_id = $1 order by product_id limit 32 for update
        `, [job.id.toString()]),
        pending_units: await explainQuery(pool, `
          select id from ai_publication_units
          where batch_id = $1 and status <> 'succeeded' limit 1
        `, [batchId.toString()]),
      },
      finalization: {
        job_lock: await explainQuery(pool, `
          select id from ai_jobs where id = $1 for update
        `, [job.id.toString()]),
        active_batch: await explainQuery(pool, `
          select id from ai_job_batches
          where job_id = $1 and status in ('queued','running') limit 1
        `, [job.id.toString()]),
        failed_batches: await explainQuery(pool, `
          select id, product_ids, error_source from ai_job_batches
          where job_id = $1 and status = 'failed' order by id
        `, [job.id.toString()]),
        missing_inputs: await explainQuery(pool, `
          select m.input_id, m.product_id, i.input_bytes, i.estimated_tokens
          from ai_job_input_members m
          join ai_job_inputs i on i.job_id = m.job_id and i.input_id = m.input_id
          where m.job_id = $1 and m.reason_code = 'missing_id'
            and m.missing_reprocess_count = 0 and i.round = 0
          order by m.input_id, m.product_id
        `, [job.id.toString()]),
        result_counts: await explainQuery(pool, `
          select status, count(*)::int from ai_standardization_results
          where job_id = $1 group by status
        `, [job.id.toString()]),
        job_update: await explainQuery(pool, `
          update ai_jobs set status = status where id = $1
        `, [job.id.toString()]),
      },
    };
  } finally {
    await database.deleteFrom('ai_jobs').where('id', '=', job.id).execute();
  }
}

async function explainQuery(pool: Pool, statement: string, parameters: readonly unknown[] = []): Promise<JsonValue> {
  const result = await pool.query<{ 'QUERY PLAN': JsonValue }>(
    `explain (analyze, buffers, format json) ${statement}`,
    [...parameters],
  );
  return result.rows[0]?.['QUERY PLAN'] ?? [];
}

export function validateDatabaseBenchmarkRunIds(
  runIds: readonly number[],
  expectedRuns: number,
  context: string,
): void {
  const actual = [...runIds].sort((left, right) => left - right);
  const expected = Array.from({ length: expectedRuns }, (_, index) => index + 1);
  if (actual.length !== expected.length || actual.some((run, index) => run !== expected[index])) {
    throw new Error(`${context} run ids must be exactly 1..${expectedRuns}`);
  }
}

const EXPLAIN_PLAN_NAMES = ['candidate_lookup', 'rolling_window_claim', 'publication_unit', 'finalization'] as const;
const EXPLAIN_ACTUAL_ROW_BUDGET = 100_000;
const EXPLAIN_SMALL_SEQUENTIAL_SCAN_BUDGET = 128;

function jsonObject(value: JsonValue): Record<string, JsonValue> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : null;
}

function explainDocuments(value: JsonValue, key: string): JsonValue[][] {
  if (Array.isArray(value)) {
    if (value.length === 0) throw new Error(`${key} has an empty EXPLAIN plan`);
    const first = jsonObject(value[0]!);
    if (first && 'Plan' in first) return [value];
    return value.flatMap((item, index) => explainDocuments(item, `${key}[${index}]`));
  }
  const object = jsonObject(value);
  if (!object || Object.keys(object).length === 0) throw new Error(`${key} has an empty EXPLAIN plan`);
  return Object.entries(object).flatMap(([name, plan]) => explainDocuments(plan, `${key}.${name}`));
}

function validateExplainDocument(document: readonly JsonValue[], key: string): void {
  const envelope = jsonObject(document[0]!);
  const root = envelope ? jsonObject(envelope.Plan) : null;
  if (!root) throw new Error(`${key} has an empty EXPLAIN plan`);
  let hasIndexAccess = false;
  let hasActualMetrics = false;
  let maxActualRows = 0;
  let temporaryBlocks = 0;
  const visit = (node: Record<string, JsonValue>): void => {
    const nodeType = typeof node['Node Type'] === 'string' ? node['Node Type'] : '';
    if (/index|bitmap/i.test(nodeType)) hasIndexAccess = true;
    const actualRows = typeof node['Actual Rows'] === 'number' ? node['Actual Rows'] : 0;
    const actualLoops = typeof node['Actual Loops'] === 'number' ? node['Actual Loops'] : 0;
    if (typeof node['Actual Rows'] === 'number' && typeof node['Actual Loops'] === 'number') hasActualMetrics = true;
    maxActualRows = Math.max(maxActualRows, actualRows * actualLoops);
    const tempRead = typeof node['Temp Read Blocks'] === 'number' ? node['Temp Read Blocks'] : 0;
    const tempWritten = typeof node['Temp Written Blocks'] === 'number' ? node['Temp Written Blocks'] : 0;
    temporaryBlocks += tempRead + tempWritten;
    const children = node.Plans;
    if (Array.isArray(children)) {
      for (const child of children) {
        const childNode = jsonObject(child);
        if (childNode) visit(childNode);
      }
    }
  };
  visit(root);
  if (!hasActualMetrics) throw new Error(`${key} has no actual row metrics`);
  if (maxActualRows > EXPLAIN_ACTUAL_ROW_BUDGET) {
    throw new Error(`${key} exceeded actual row budget: ${maxActualRows}`);
  }
  if (temporaryBlocks > 0) throw new Error(`${key} used temporary blocks: ${temporaryBlocks}`);
  if (!hasIndexAccess && maxActualRows > EXPLAIN_SMALL_SEQUENTIAL_SCAN_BUDGET) {
    throw new Error(`${key} has no index access for ${maxActualRows} actual rows`);
  }
}

export function validateDatabaseBenchmarkExplainPlans(
  plans: Readonly<Record<string, JsonValue>>,
  scenarios: readonly string[] = EXPLAIN_PLAN_SCENARIOS,
): void {
  for (const scenario of scenarios) {
    for (const name of EXPLAIN_PLAN_NAMES) {
      const key = `${scenario}.${name}`;
      if (!(key in plans)) throw new Error(`missing EXPLAIN plan: ${key}`);
      for (const [index, document] of explainDocuments(plans[key]!, key).entries()) {
        validateExplainDocument(document, `${key}[${index}]`);
      }
    }
  }
}

export function validateExecutedDatabaseBenchmark(report: DatabaseBenchmarkReport): void {
  if (report.providerRequestCount !== 0) throw new Error('database benchmark attempted a provider request');
  validateDatabaseBenchmarkScenarioCoverage(DATABASE_BENCHMARK_SCENARIOS);
  const expectedScenarios = DATABASE_BENCHMARK_SCENARIOS.map(scenario => scenario.name);
  const actualScenarios = report.configuration.scenarios;
  const missingScenarios = expectedScenarios.filter(scenario => !actualScenarios.includes(scenario));
  if (missingScenarios.length) throw new Error(`missing required scenarios: ${missingScenarios.join(', ')}`);
  const unexpectedScenarios = actualScenarios.filter(scenario => !expectedScenarios.includes(scenario));
  if (unexpectedScenarios.length) throw new Error(`unexpected scenarios: ${unexpectedScenarios.join(', ')}`);
  if (new Set(actualScenarios).size !== actualScenarios.length) throw new Error('database benchmark report has duplicate scenarios');
  if (report.configuration.sizes.length !== BENCHMARK_SIZES.length
    || BENCHMARK_SIZES.some((size, index) => report.configuration.sizes[index] !== size)) {
    throw new Error(`database benchmark sizes must be ${BENCHMARK_SIZES.join(', ')}`);
  }
  if (report.configuration.runsPerScenario < MIN_RUNS_PER_SCENARIO) {
    throw new Error(`database benchmark requires at least ${MIN_RUNS_PER_SCENARIO} runs per scenario`);
  }
  if (!report.configuration.concurrencyLevels.includes(1)) {
    throw new Error('database benchmark must include concurrency 1');
  }
  const fixturePreviews = new Map<string, DatabaseBenchmarkFixturePreview>(buildDatabaseBenchmarkScenarioMatrix().map(entry => {
    const preview = buildDatabaseBenchmarkFixturePreview(entry.size, entry.scenario, report.configuration.seed);
    return [`${entry.scenario}:${entry.size}`, preview] as const;
  }));
  for (const raw of report.rawRuns) {
    const preview = fixturePreviews.get(`${raw.scenario}:${raw.size}`);
    if (!preview) throw new Error(`unexpected benchmark dimensions: ${raw.scenario}/${raw.size}`);
    if (raw.error !== null) {
      throw new Error(`${raw.scenario}/${raw.size}/${raw.stage} failed: ${raw.error}`);
    }
    if (raw.uniqueInputs !== preview.uniqueInputs || raw.directoryProducts !== preview.directoryProducts
      || raw.evidenceBytes !== preview.evidenceBytes || raw.logicalTagRows !== preview.logicalTagRows
      || raw.expandedTagRows !== preview.expandedTagRows) {
      throw new Error(`benchmark fixture dimensions changed for ${raw.scenario}/${raw.size}`);
    }
    if (raw.run < 1 || raw.run > report.configuration.runsPerScenario) {
      throw new Error(`invalid run number for ${raw.scenario}/${raw.size}/${raw.stage}: ${raw.run}`);
    }
    if (!Number.isFinite(raw.processedItems) || raw.processedItems < 0 || !raw.throughputUnit) {
      throw new Error(`${raw.scenario}/${raw.size}/${raw.stage} has invalid processed item metrics`);
    }
    if (!Number.isSafeInteger(raw.selectionVisits) || raw.selectionVisits < 0
      || !Number.isSafeInteger(raw.peakScratchCandidates) || raw.peakScratchCandidates < 0
      || !Number.isSafeInteger(raw.retainedFeatureCount) || raw.retainedFeatureCount < 0) {
      throw new Error(`${raw.scenario}/${raw.size}/${raw.stage} has invalid grouping structure metrics`);
    }
    const expectedRssMeasurement = raw.catalogState === 'local' ? 'process_max_rss' : 'sampled_peak';
    if (raw.rssMeasurement !== expectedRssMeasurement) {
      throw new Error(`${raw.scenario}/${raw.size}/${raw.stage} has invalid RSS measurement type`);
    }
    if (!Number.isSafeInteger(raw.processId) || raw.processId < 1
      || !Number.isSafeInteger(raw.startRssBytes) || raw.startRssBytes < 1
      || !Number.isSafeInteger(raw.endRssBytes) || raw.endRssBytes < 1
      || !Number.isSafeInteger(raw.startHeapUsedBytes) || raw.startHeapUsedBytes < 1
      || !Number.isSafeInteger(raw.endHeapUsedBytes) || raw.endHeapUsedBytes < 1
      || raw.peakRssBytes < Math.max(raw.startRssBytes, raw.endRssBytes)) {
      throw new Error(`${raw.scenario}/${raw.size}/${raw.stage} has invalid process resource metrics`);
    }
    if (raw.writtenTagRows < 0 || raw.writtenTagRows > raw.expandedTagRows) {
      throw new Error(`${raw.scenario}/${raw.size}/${raw.stage} has invalid written tag rows`);
    }
    const expectedThroughput = raw.error === null
      ? raw.processedItems / Math.max(raw.durationMs / 1_000, Number.EPSILON)
      : 0;
    if (Math.abs(raw.throughputPerSecond - expectedThroughput) > Math.max(1e-9, expectedThroughput * 1e-12)) {
      throw new Error(`${raw.scenario}/${raw.size}/${raw.stage} throughput does not match processed items`);
    }
    if (raw.stage === 'input_grouping' || raw.stage === 'candidate_query_local') {
      if (raw.scanned > raw.uniqueInputs * CANDIDATE_INDEX_OPTIONS.maxScanned) {
        throw new Error(`${raw.scenario}/${raw.size}/${raw.stage} exceeded scan budget`);
      }
      if (raw.compared > raw.uniqueInputs * CANDIDATE_INDEX_OPTIONS.maxCompared) {
        throw new Error(`${raw.scenario}/${raw.size}/${raw.stage} exceeded compare budget`);
      }
    }
    if (raw.stage === 'input_grouping') {
      if (raw.selectionVisits > raw.uniqueInputs * (4 * DEFAULT_GROUP_SIZE + 2)) {
        throw new Error(`${raw.scenario}/${raw.size}/${raw.stage} exceeded selection visit budget`);
      }
      if (raw.peakScratchCandidates > raw.uniqueInputs * DEFAULT_GROUP_SIZE) {
        throw new Error(`${raw.scenario}/${raw.size}/${raw.stage} exceeded scratch candidate budget`);
      }
      if (raw.retainedFeatureCount > raw.uniqueInputs * DEFAULT_GROUPING_FEATURES) {
        throw new Error(`${raw.scenario}/${raw.size}/${raw.stage} exceeded retained feature budget`);
      }
    }
    if (raw.stage === 'candidate_query_local'
      && raw.candidateCount > raw.uniqueInputs * CANDIDATE_INDEX_OPTIONS.topK) {
      throw new Error(`${raw.scenario}/${raw.size}/${raw.stage} exceeded candidate budget`);
    }
    if (raw.stage === 'directory_duplicate_audit_full'
      || raw.stage === 'directory_duplicate_audit_incremental') {
      if (raw.compared > raw.directoryProducts * 100) {
        throw new Error(`${raw.scenario}/${raw.size}/${raw.stage} exceeded duplicate audit compare budget`);
      }
      if (raw.suspectedPairs > 10_000) {
        throw new Error(`${raw.scenario}/${raw.size}/${raw.stage} exceeded duplicate audit report budget`);
      }
    }
    if (raw.stage === 'candidate_index_full_rebuild_after_1pct_change'
      || raw.stage === 'candidate_index_delta_refresh_after_1pct_change'
      || raw.stage === 'directory_duplicate_audit_incremental') {
      if (raw.changedProducts !== preview.incrementalChangedProducts) {
        throw new Error(`${raw.scenario}/${raw.size}/${raw.stage} did not measure the fixed 1% change set`);
      }
    }
    if (raw.stage === 'candidate_index_delta_refresh_after_1pct_change') {
      if (raw.processedChangeCount !== preview.incrementalChangedProducts
        || raw.rebuiltDocumentCount !== preview.incrementalChangedProducts
        || raw.rebuiltDocumentCount >= raw.directoryProducts
        || raw.compactionCount !== 0) {
        throw new Error(`${raw.scenario}/${raw.size}/${raw.stage} did not remain bounded by the 1% change set`);
      }
    }
    if (raw.stage === 'directory_duplicate_audit_incremental') {
      if (raw.processedChangeCount !== preview.incrementalChangedProducts
        || raw.compared > preview.incrementalChangedProducts * 100
        || raw.routePostingsVisited > preview.incrementalChangedProducts * (100 + 1) * DUPLICATE_BLOCKING_ROUTES.length * 40) {
        throw new Error(`${raw.scenario}/${raw.size}/${raw.stage} did not remain bounded by the 1% change set`);
      }
    }
    if (raw.stage === 'candidate_index_compaction_rebuild') {
      if (raw.rebuiltDocumentCount !== raw.directoryProducts || raw.compactionCount !== 1) {
        throw new Error(`${raw.scenario}/${raw.size}/${raw.stage} did not record a full compaction rebuild`);
      }
    }
  }
  const expectedLocalStages: readonly DatabaseBenchmarkStage[] = [
    'candidate_index_build',
    'candidate_index_full_rebuild_after_1pct_change',
    'candidate_index_delta_refresh_after_1pct_change',
    'candidate_index_compaction_rebuild',
    'input_grouping',
    'candidate_query_local',
    'directory_duplicate_audit_full',
    'directory_duplicate_audit_incremental',
  ];
  const expectedDatabaseStages: readonly DatabaseBenchmarkStage[] = [
    'request_preparation',
    'candidate_query',
    'rolling_window_claim',
    'lock_contention',
    'publication_commit',
    'finalization',
  ];
  for (const scenario of report.configuration.scenarios) {
    for (const size of report.configuration.sizes) {
      for (const stage of expectedLocalStages) {
        const runs = report.rawRuns.filter(raw => raw.scenario === scenario && raw.size === size
          && raw.concurrency === 1 && raw.catalogState === 'local' && raw.stage === stage);
        if (runs.length !== report.configuration.runsPerScenario) {
          throw new Error(`${scenario}/${size}/local/${stage} has ${runs.length} runs; expected ${report.configuration.runsPerScenario}`);
        }
        validateDatabaseBenchmarkRunIds(
          runs.map(run => run.run),
          report.configuration.runsPerScenario,
          `${scenario}/${size}/local/${stage}`,
        );
        const failure = runs.find(run => run.error !== null);
        if (failure) throw new Error(`${scenario}/${size}/local/${stage} failed: ${failure.error}`);
      }
      for (const concurrency of report.configuration.concurrencyLevels) {
        for (const catalogState of ['cold', 'warm']) {
          for (const stage of expectedDatabaseStages) {
            const runs = report.rawRuns.filter(raw => raw.scenario === scenario && raw.size === size
              && raw.concurrency === concurrency && raw.catalogState === catalogState && raw.stage === stage);
            if (runs.length !== report.configuration.runsPerScenario) {
              throw new Error(`${scenario}/${size}/${concurrency}/${catalogState}/${stage} has ${runs.length} runs; expected ${report.configuration.runsPerScenario}`);
            }
            validateDatabaseBenchmarkRunIds(
              runs.map(run => run.run),
              report.configuration.runsPerScenario,
              `${scenario}/${size}/${concurrency}/${catalogState}/${stage}`,
            );
            const failure = runs.find(run => run.error !== null);
            if (failure) throw new Error(`${scenario}/${size}/${concurrency}/${catalogState}/${stage} failed: ${failure.error}`);
          }
        }
      }
    }
  }
  validateDatabaseBenchmarkExplainPlans(report.explainPlans);
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) result.push(items.slice(offset, offset + size));
  return result;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) throw new Error('cannot calculate a percentile without values');
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index]!;
}

function positiveInteger(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function commandLineOptionValue(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  if (index < 0) return undefined;
  const value = arguments_[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

async function writeReportAtomically(outputPath: string, serialized: string): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, outputPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function publishDatabaseBenchmarkCheckpoint(
  checkpoint: DatabaseBenchmarkCheckpoint,
  outputPath: string,
): Promise<void> {
  await writeReportAtomically(outputPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
}

export async function publishDatabaseBenchmarkReport(
  report: DatabaseBenchmarkReport,
  options: {
    readonly check: boolean;
    readonly outputPath?: string;
    readonly writeStdout?: (serialized: string) => void;
    readonly performanceBudget?: StandardizationPerformanceBudget;
    readonly baselineSource?: DatabaseBenchmarkBaselineSource;
  },
): Promise<void> {
  if (options.performanceBudget && !options.check) {
    throw new Error('database performance budget requires --check');
  }
  if (options.performanceBudget && !options.baselineSource) {
    throw new Error('database performance budget requires a baseline report');
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.outputPath) await writeReportAtomically(options.outputPath, serialized);
  else (options.writeStdout ?? (value => process.stdout.write(value)))(serialized);
  if (options.check) validateExecutedDatabaseBenchmark(report);
  if (options.performanceBudget && options.baselineSource) {
    const { validateDatabaseNumericBudget } = await import('./standardization-database-budget.js');
    if (options.performanceBudget.databaseNumeric.status === 'pending_target_container_measurement') {
      throw new Error(`database numeric budget is pending: ${options.performanceBudget.databaseNumeric.reason}`);
    }
    validateDatabaseNumericBudget(report, options.performanceBudget.databaseNumeric, options.baselineSource);
  }
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  const resumePath = commandLineOptionValue(arguments_, '--resume');
  const outputPath = commandLineOptionValue(arguments_, '--output') ?? resumePath;
  const performanceBudgetPath = commandLineOptionValue(arguments_, '--performance-budget');
  const baselinePath = commandLineOptionValue(arguments_, '--baseline-report');
  const check = arguments_.includes('--check');
  if (performanceBudgetPath && !check) throw new Error('--performance-budget requires --check');
  if (performanceBudgetPath && !baselinePath) throw new Error('--performance-budget requires --baseline-report');
  if (baselinePath && outputPath && path.resolve(baselinePath) === path.resolve(outputPath)) {
    throw new Error('--baseline-report must differ from --output or --resume');
  }
  const performanceBudget = performanceBudgetPath
    ? JSON.parse(await readFile(performanceBudgetPath, 'utf8')) as StandardizationPerformanceBudget
    : undefined;
  const baselineJson = baselinePath ? await readFile(baselinePath, 'utf8') : undefined;
  const baselineSource: DatabaseBenchmarkBaselineSource | undefined = baselineJson === undefined
    ? undefined
    : { report: JSON.parse(baselineJson) as DatabaseBenchmarkReport, rawJson: baselineJson };
  if (performanceBudget && baselineSource) {
    if (performanceBudget.databaseNumeric.status === 'pending_target_container_measurement') {
      throw new Error(`database numeric budget is pending: ${performanceBudget.databaseNumeric.reason}`);
    }
    const { validateApprovedDatabaseBenchmarkBaseline } = await import('./standardization-database-budget.js');
    validateApprovedDatabaseBenchmarkBaseline(performanceBudget.databaseNumeric, baselineSource);
  }
  if (!resumePath && !process.env.TEST_DATABASE_URL?.trim()) {
    console.log(JSON.stringify(databaseBenchmarkNotExecuted(process.env)));
    process.exitCode = 1;
    return;
  }
  let report: DatabaseBenchmarkReport;
  let checkpoint: DatabaseBenchmarkCheckpoint | undefined;
  if (resumePath) {
    const parsed = JSON.parse(await readFile(resumePath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('--resume requires a database benchmark report or checkpoint');
    }
    const status = (parsed as { status?: unknown }).status;
    if (status === 'executed') {
      report = await resumeFailedLocalDatabaseBenchmarkRuns(parsed as DatabaseBenchmarkReport);
      await publishDatabaseBenchmarkReport(report, {
        check,
        outputPath,
        performanceBudget,
        baselineSource,
      });
      return;
    }
    if (status !== 'in_progress') {
      throw new Error('--resume requires a database benchmark report or checkpoint');
    }
    checkpoint = parsed as DatabaseBenchmarkCheckpoint;
  }

  let interruptRequested = false;
  let interruptCount = 0;
  const onSigint = (): void => {
    interruptCount += 1;
    interruptRequested = true;
    if (interruptCount > 1) process.exit(130);
    const checkpointMessage = outputPath
      ? `saving checkpoint to ${outputPath}`
      : 'no --output checkpoint path is configured';
    process.stderr.write(`[standardization-benchmark] interrupt requested; finishing the current recoverable unit, ${checkpointMessage}\n`);
  };
  process.on('SIGINT', onSigint);
  try {
    report = await runStandardizationDatabaseBenchmark(process.env, {
      checkpoint,
      onCheckpoint: outputPath
        ? value => publishDatabaseBenchmarkCheckpoint(value, outputPath)
        : undefined,
      onProgress: progress => { process.stderr.write(`${formatDatabaseBenchmarkProgress(progress)}\n`); },
      progressIntervalMs: 180_000,
      shouldStop: () => interruptRequested,
    });
  } catch (error: unknown) {
    if (error instanceof DatabaseBenchmarkInterruptedError) {
      process.stderr.write(`[standardization-benchmark] stopped at a recoverable boundary${outputPath ? `; resume with --resume ${outputPath}` : ''}\n`);
      process.exitCode = 130;
      return;
    }
    throw error;
  } finally {
    process.off('SIGINT', onSigint);
  }
  await publishDatabaseBenchmarkReport(report, {
    check,
    outputPath,
    performanceBudget,
    baselineSource,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

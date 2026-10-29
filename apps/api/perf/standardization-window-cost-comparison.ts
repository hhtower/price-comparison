export interface TokenCategories {
  readonly system: number;
  readonly rules: number;
  readonly evidence: number;
  readonly candidates: number;
  readonly schema: number;
  readonly estimatedOutput: number;
}

export interface WorkflowStageEstimate {
  readonly name: string;
  readonly requestCount: number;
  readonly confirmedRetries: number;
  readonly tokensPerRequest: TokenCategories;
}

export interface PriceSnapshot {
  readonly capturedAt: string;
  readonly model: string;
  readonly inputUsdPerMillion: { readonly low: number; readonly high: number };
  readonly outputUsdPerMillion: { readonly low: number; readonly high: number };
}

export interface WorkflowCostInput {
  readonly priceSnapshot: PriceSnapshot;
  readonly oldStages: readonly WorkflowStageEstimate[];
  readonly newStages: readonly WorkflowStageEstimate[];
}

interface WorkflowTotals {
  readonly logicalRequests: { readonly planned: number; readonly confirmedRetries: number; readonly total: number };
  readonly tokens: TokenCategories & { readonly inputTotal: number; readonly total: number };
  readonly estimatedUsd: { readonly low: number; readonly high: number };
  readonly stages: readonly { readonly name: string; readonly requestCount: number; readonly confirmedRetries: number }[];
}

export interface WorkflowCostComparison {
  readonly priceSnapshot: PriceSnapshot;
  readonly old: WorkflowTotals;
  readonly new: WorkflowTotals;
  readonly delta: {
    readonly logicalRequests: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly estimatedUsd: { readonly low: number; readonly high: number };
  };
  readonly providerRequestCount: 0;
}

interface SimulationBatch {
  readonly id: string;
  readonly durationMs: number;
  readonly outcome: 'success' | 'failure';
  readonly createsIdentity: boolean;
  readonly candidateTokensPerIdentity: number;
}

type VisibilityMetric =
  | { readonly numerator: number; readonly denominator: 0; readonly value: 'unknown' }
  | { readonly numerator: number; readonly denominator: number; readonly value: number };

export interface WindowStrategyResult {
  readonly logicalRequestCount: number;
  readonly candidateVisibilityRate: VisibilityMetric;
  readonly averageWaitMs: number;
  readonly p95WaitMs: number;
  readonly totalCompletionMs: number;
  readonly throughputPerSecond: number;
  readonly catalogRefreshCount: number;
  readonly additionalCandidateTokens: number;
  readonly maxObservedConcurrency: number;
}

export interface WindowScenarioResult {
  readonly batchCount: number;
  readonly strategies: {
    readonly fully_frozen: WindowStrategyResult;
    readonly window_1: WindowStrategyResult;
    readonly window_2: WindowStrategyResult;
    readonly deployment_concurrency: WindowStrategyResult;
  };
}

export interface WindowCostComparisonReport {
  readonly promptVersion: string;
  readonly tokenEstimatorVersion: string;
  readonly deploymentConcurrency: number;
  readonly costs: WorkflowCostComparison;
  readonly scenarios: {
    readonly early_success: WindowScenarioResult;
    readonly slow_batch: WindowScenarioResult;
    readonly early_failure: WindowScenarioResult;
    readonly newly_published_identity: WindowScenarioResult;
  };
  readonly providerRequestCount: 0;
}

const TOKEN_KEYS = ['system', 'rules', 'evidence', 'candidates', 'schema', 'estimatedOutput'] as const;

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative integer`);
  return value;
}

function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be a finite non-negative number`);
  return value;
}

function totalWorkflow(stages: readonly WorkflowStageEstimate[], price: PriceSnapshot): WorkflowTotals {
  const tokens: Record<(typeof TOKEN_KEYS)[number], number> = {
    system: 0,
    rules: 0,
    evidence: 0,
    candidates: 0,
    schema: 0,
    estimatedOutput: 0,
  };
  let planned = 0;
  let confirmedRetries = 0;
  for (const stage of stages) {
    if (!stage.name.trim()) throw new Error('workflow stage name is required');
    const requestCount = nonNegativeInteger(stage.requestCount, `${stage.name}.requestCount`);
    const retries = nonNegativeInteger(stage.confirmedRetries, `${stage.name}.confirmedRetries`);
    planned += requestCount;
    confirmedRetries += retries;
    const attempts = requestCount + retries;
    for (const key of TOKEN_KEYS) {
      tokens[key] += nonNegativeInteger(stage.tokensPerRequest[key], `${stage.name}.${key}`) * attempts;
    }
  }
  const inputTotal = tokens.system + tokens.rules + tokens.evidence + tokens.candidates + tokens.schema;
  const total = inputTotal + tokens.estimatedOutput;
  const low = (inputTotal * finiteNonNegative(price.inputUsdPerMillion.low, 'input low price')
    + tokens.estimatedOutput * finiteNonNegative(price.outputUsdPerMillion.low, 'output low price')) / 1_000_000;
  const high = (inputTotal * finiteNonNegative(price.inputUsdPerMillion.high, 'input high price')
    + tokens.estimatedOutput * finiteNonNegative(price.outputUsdPerMillion.high, 'output high price')) / 1_000_000;
  if (low > high) throw new Error('price snapshot low estimate cannot exceed high estimate');
  return {
    logicalRequests: { planned, confirmedRetries, total: planned + confirmedRetries },
    tokens: { ...tokens, inputTotal, total },
    estimatedUsd: { low, high },
    stages: stages.map(stage => ({ name: stage.name, requestCount: stage.requestCount, confirmedRetries: stage.confirmedRetries })),
  };
}

export function compareWorkflowCosts(input: WorkflowCostInput): WorkflowCostComparison {
  if (!input.priceSnapshot.capturedAt.trim() || !input.priceSnapshot.model.trim()) throw new Error('price snapshot date and model are required');
  const oldWorkflow = totalWorkflow(input.oldStages, input.priceSnapshot);
  const newWorkflow = totalWorkflow(input.newStages, input.priceSnapshot);
  return {
    priceSnapshot: input.priceSnapshot,
    old: oldWorkflow,
    new: newWorkflow,
    delta: {
      logicalRequests: newWorkflow.logicalRequests.total - oldWorkflow.logicalRequests.total,
      inputTokens: newWorkflow.tokens.inputTotal - oldWorkflow.tokens.inputTotal,
      outputTokens: newWorkflow.tokens.estimatedOutput - oldWorkflow.tokens.estimatedOutput,
      estimatedUsd: {
        low: newWorkflow.estimatedUsd.low - oldWorkflow.estimatedUsd.low,
        high: newWorkflow.estimatedUsd.high - oldWorkflow.estimatedUsd.high,
      },
    },
    providerRequestCount: 0,
  };
}

function percentile95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
}

function simulateWindow(batches: readonly SimulationBatch[], concurrency: number, frozen: boolean): WindowStrategyResult {
  const limit = Math.max(1, Math.min(nonNegativeInteger(concurrency, 'concurrency'), Math.max(1, batches.length)));
  const active: Array<{ readonly batch: SimulationBatch; readonly index: number; readonly startMs: number; readonly endMs: number }> = [];
  const completedIdentities: Array<{ readonly sourceIndex: number; readonly completedAt: number }> = [];
  const waits: number[] = [];
  let nextIndex = 0;
  let now = 0;
  let visible = 0;
  let additionalCandidateTokens = 0;
  let maxObservedConcurrency = 0;

  const startAvailable = () => {
    while (nextIndex < batches.length && active.length < limit) {
      const batch = batches[nextIndex]!;
      const eligible = completedIdentities.filter(identity => identity.sourceIndex < nextIndex);
      const visibleCount = frozen ? 0 : eligible.length;
      visible += visibleCount;
      additionalCandidateTokens += visibleCount * batch.candidateTokensPerIdentity;
      waits.push(now);
      active.push({ batch, index: nextIndex, startMs: now, endMs: now + batch.durationMs });
      nextIndex += 1;
      maxObservedConcurrency = Math.max(maxObservedConcurrency, active.length);
    }
  };

  startAvailable();
  while (active.length > 0) {
    now = Math.min(...active.map(item => item.endMs));
    const completed = active.filter(item => item.endMs === now);
    for (const item of completed) {
      active.splice(active.indexOf(item), 1);
      if (item.batch.outcome === 'success' && item.batch.createsIdentity) {
        completedIdentities.push({ sourceIndex: item.index, completedAt: now });
      }
    }
    startAvailable();
  }

  const averageWaitMs = waits.length === 0 ? 0 : waits.reduce((sum, value) => sum + value, 0) / waits.length;
  const opportunities = completedIdentities.reduce((sum, identity) => sum + Math.max(0, batches.length - identity.sourceIndex - 1), 0);
  const visibility: VisibilityMetric = opportunities === 0
    ? { numerator: 0, denominator: 0, value: 'unknown' }
    : { numerator: visible, denominator: opportunities, value: visible / opportunities };
  return {
    logicalRequestCount: batches.length,
    candidateVisibilityRate: visibility,
    averageWaitMs,
    p95WaitMs: percentile95(waits),
    totalCompletionMs: now,
    throughputPerSecond: batches.length / (now / 1_000),
    catalogRefreshCount: completedIdentities.length,
    additionalCandidateTokens,
    maxObservedConcurrency,
  };
}

function batch(id: string, durationMs: number, outcome: 'success' | 'failure', createsIdentity = false): SimulationBatch {
  return { id, durationMs, outcome, createsIdentity, candidateTokensPerIdentity: 48 };
}

function simulateScenario(batches: readonly SimulationBatch[], deploymentConcurrency: number): WindowScenarioResult {
  return {
    batchCount: batches.length,
    strategies: {
      fully_frozen: simulateWindow(batches, deploymentConcurrency, true),
      window_1: simulateWindow(batches, 1, false),
      window_2: simulateWindow(batches, Math.min(2, deploymentConcurrency), false),
      deployment_concurrency: simulateWindow(batches, deploymentConcurrency, false),
    },
  };
}

function defaultCostComparison(): WorkflowCostComparison {
  return compareWorkflowCosts({
    priceSnapshot: {
      capturedAt: '2026-09-20',
      model: 'offline-reference-range',
      inputUsdPerMillion: { low: 0.5, high: 15 },
      outputUsdPerMillion: { low: 1.5, high: 60 },
    },
    oldStages: [
      { name: 'extract', requestCount: 8, confirmedRetries: 1, tokensPerRequest: { system: 900, rules: 180, evidence: 4_000, candidates: 0, schema: 600, estimatedOutput: 1_600 } },
      { name: 'audit', requestCount: 4, confirmedRetries: 0, tokensPerRequest: { system: 700, rules: 180, evidence: 1_600, candidates: 1_200, schema: 500, estimatedOutput: 900 } },
      { name: 'merge', requestCount: 2, confirmedRetries: 0, tokensPerRequest: { system: 600, rules: 140, evidence: 800, candidates: 1_600, schema: 400, estimatedOutput: 700 } },
    ],
    newStages: [
      { name: 'standardize', requestCount: 8, confirmedRetries: 1, tokensPerRequest: { system: 1_100, rules: 260, evidence: 4_000, candidates: 1_000, schema: 700, estimatedOutput: 1_900 } },
    ],
  });
}

export function runStandardizationWindowCostComparison(options: { readonly deploymentConcurrency: number }): WindowCostComparisonReport {
  const deploymentConcurrency = nonNegativeInteger(options.deploymentConcurrency, 'deploymentConcurrency');
  if (deploymentConcurrency < 1) throw new RangeError('deploymentConcurrency must be at least 1');
  return {
    promptVersion: 'standardization-regroup-20260920-v1',
    tokenEstimatorVersion: 'utf8-category-estimator-20260920-v1',
    deploymentConcurrency,
    costs: defaultCostComparison(),
    scenarios: {
      early_success: simulateScenario([
        batch('early-1', 20, 'success', true), batch('early-2', 100, 'success'),
        batch('early-3', 40, 'success'), batch('early-4', 40, 'success'),
      ], deploymentConcurrency),
      slow_batch: simulateScenario([
        batch('slow-1', 200, 'success', true), batch('slow-2', 20, 'success'),
        batch('slow-3', 20, 'success'), batch('slow-4', 20, 'success'),
      ], deploymentConcurrency),
      early_failure: simulateScenario([
        batch('failure-1', 20, 'failure'), batch('failure-2', 40, 'success'),
        batch('failure-3', 40, 'success'), batch('failure-4', 40, 'success'),
      ], deploymentConcurrency),
      newly_published_identity: simulateScenario([
        batch('identity-1', 20, 'success', true), batch('identity-2', 40, 'success'),
        batch('identity-3', 40, 'success'), batch('identity-4', 40, 'success'),
      ], deploymentConcurrency),
    },
    providerRequestCount: 0,
  };
}

function parsePositiveArgument(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  const raw = index >= 0 ? process.argv[index + 1] : undefined;
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function checkReport(report: WindowCostComparisonReport): void {
  if (report.providerRequestCount !== 0 || report.costs.providerRequestCount !== 0) throw new Error('offline comparison attempted a provider request');
  for (const scenario of Object.values(report.scenarios)) {
    if (scenario.strategies.window_1.maxObservedConcurrency > 1) throw new Error('window 1 exceeded its concurrency limit');
    if (scenario.strategies.window_2.maxObservedConcurrency > 2) throw new Error('window 2 exceeded its concurrency limit');
    if (scenario.strategies.deployment_concurrency.maxObservedConcurrency > report.deploymentConcurrency) throw new Error('deployment concurrency exceeded');
  }
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/standardization-window-cost-comparison.ts')) {
  try {
    const report = runStandardizationWindowCostComparison({ deploymentConcurrency: parsePositiveArgument('--concurrency', Number(process.env.AI_CONCURRENCY ?? 4)) });
    if (process.argv.includes('--check')) checkReport(report);
    console.log(JSON.stringify(report, null, 2));
  } catch (error: unknown) {
    console.error(error);
    process.exitCode = 1;
  }
}

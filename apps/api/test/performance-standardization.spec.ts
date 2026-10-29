import test from 'node:test';
import assert from 'node:assert/strict';
import { planStubCandidates, runStandardizationBaseline } from '../perf/standardization-baseline.js';
import {
  compareWorkflowCosts,
  runStandardizationWindowCostComparison,
} from '../perf/standardization-window-cost-comparison.js';

test('baseline reports bounded planning, duplicate audit, publication and finalization metrics without paid AI calls', async () => {
  const report = await runStandardizationBaseline({ uniqueInputs: 1_000, seed: 20260920, databaseUrl: 'stub://local', schema: 'baseline_stub' });
  for (const metric of ['planningMs', 'planningPeakBytes', 'plannedPairCount', 'candidateQueryMs', 'duplicateAuditMs', 'requestPreparationMs', 'publicationMs', 'terminalFinalizeMs', 'sqlP95Ms', 'lockWaitMs', 'queueWaitP95', 'progressRequestCount', 'errorRate'] as const) assert.equal(typeof report[metric], 'number', metric);
  assert.equal(report.rawInputs, 1_000);
  assert.ok(report.uniqueInputs < report.rawInputs);
  assert.ok(report.directoryProducts < report.uniqueInputs);
  assert.ok(report.plannedPairCount <= report.directoryProducts * 100);
  assert.equal(report.requestCount, 0);
  assert.deepEqual(report.stages, {});
  assert.ok(!('reviewP95' in report));
  assert.ok(!('bulkReviewMs' in report));
});

test('baseline packing remains bounded while N, U and D all scale', async () => {
  let previous = { rawInputs: 0, uniqueInputs: 0, directoryProducts: 0 };
  for (const inputCount of [1_000, 5_000, 10_000] as const) {
    const plan = planStubCandidates(Math.floor(inputCount * 0.82), 20260920);
    assert.ok(plan.peakBytes <= 24_576);
    assert.ok(plan.taskCount > 0);
    const report = await runStandardizationBaseline({ uniqueInputs: inputCount, seed: 20260920, databaseUrl: 'stub://local', schema: 'baseline_stub' });
    assert.ok(report.rawInputs > previous.rawInputs);
    assert.ok(report.uniqueInputs > previous.uniqueInputs);
    assert.ok(report.directoryProducts > previous.directoryProducts);
    previous = report;
  }
});

test('offline workflow comparison keeps logical requests and token categories independently auditable', () => {
  const report = compareWorkflowCosts({
    priceSnapshot: {
      capturedAt: '2026-09-20',
      model: 'offline-test-range',
      inputUsdPerMillion: { low: 1, high: 2 },
      outputUsdPerMillion: { low: 3, high: 4 },
    },
    oldStages: [
      { name: 'extract', requestCount: 2, confirmedRetries: 1, tokensPerRequest: { system: 10, rules: 2, evidence: 20, candidates: 0, schema: 3, estimatedOutput: 5 } },
      { name: 'audit', requestCount: 1, confirmedRetries: 0, tokensPerRequest: { system: 4, rules: 1, evidence: 6, candidates: 8, schema: 2, estimatedOutput: 3 } },
    ],
    newStages: [
      { name: 'standardize', requestCount: 2, confirmedRetries: 0, tokensPerRequest: { system: 12, rules: 3, evidence: 20, candidates: 5, schema: 4, estimatedOutput: 6 } },
    ],
  });

  assert.deepEqual(report.old.logicalRequests, { planned: 3, confirmedRetries: 1, total: 4 });
  assert.deepEqual(report.old.tokens, { system: 34, rules: 7, evidence: 66, candidates: 8, schema: 11, estimatedOutput: 18, inputTotal: 126, total: 144 });
  assert.deepEqual(report.new.logicalRequests, { planned: 2, confirmedRetries: 0, total: 2 });
  assert.deepEqual(report.new.tokens, { system: 24, rules: 6, evidence: 40, candidates: 10, schema: 8, estimatedOutput: 12, inputTotal: 88, total: 100 });
  assert.deepEqual(report.old.estimatedUsd, { low: 0.00018, high: 0.000324 });
  assert.deepEqual(report.new.estimatedUsd, { low: 0.000124, high: 0.000224 });
  assert.equal(report.providerRequestCount, 0);
  assert.equal(report.priceSnapshot.model, 'offline-test-range');
});

test('window comparison exposes visibility, waiting, throughput and refresh tradeoffs for every required timing case', () => {
  const report = runStandardizationWindowCostComparison({ deploymentConcurrency: 4 });
  assert.deepEqual(Object.keys(report.scenarios), ['early_success', 'slow_batch', 'early_failure', 'newly_published_identity']);

  for (const scenario of Object.values(report.scenarios)) {
    assert.deepEqual(Object.keys(scenario.strategies), ['fully_frozen', 'window_1', 'window_2', 'deployment_concurrency']);
    assert.equal(
      scenario.strategies.fully_frozen.candidateVisibilityRate.value,
      scenario.strategies.fully_frozen.candidateVisibilityRate.denominator === 0 ? 'unknown' : 0,
    );
    assert.ok(scenario.strategies.window_1.maxObservedConcurrency <= 1);
    assert.ok(scenario.strategies.window_2.maxObservedConcurrency <= 2);
    assert.ok(scenario.strategies.deployment_concurrency.maxObservedConcurrency <= 4);
    for (const result of Object.values(scenario.strategies)) {
      assert.equal(result.logicalRequestCount, scenario.batchCount);
      assert.ok(result.averageWaitMs >= 0);
      assert.ok(result.p95WaitMs >= result.averageWaitMs || result.p95WaitMs === 0);
      assert.ok(result.throughputPerSecond > 0);
    }
  }

  const early = report.scenarios.early_success.strategies;
  assert.equal(early.window_1.candidateVisibilityRate.value, 1);
  assert.ok(early.window_2.candidateVisibilityRate.value > early.fully_frozen.candidateVisibilityRate.value);
  assert.ok(early.window_1.totalCompletionMs > early.window_2.totalCompletionMs);

  const slow = report.scenarios.slow_batch.strategies;
  assert.ok(slow.window_2.candidateVisibilityRate.value < slow.window_1.candidateVisibilityRate.value);
  assert.ok(slow.window_2.totalCompletionMs < slow.window_1.totalCompletionMs);

  for (const result of Object.values(report.scenarios.early_failure.strategies)) {
    assert.equal(result.catalogRefreshCount, 0);
    assert.equal(result.additionalCandidateTokens, 0);
    assert.equal(result.candidateVisibilityRate.denominator, 0);
    assert.equal(result.candidateVisibilityRate.value, 'unknown');
  }

  assert.ok(report.scenarios.newly_published_identity.strategies.window_1.additionalCandidateTokens > 0);
  assert.equal(report.providerRequestCount, 0);
});

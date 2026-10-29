import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { standardizationFlowCatalog, standardizationFlowControls } from './fixtures/standardization-flow-controls-20261008.js';

const modulePath = '../src/standardization/flow-evaluation.js';
const loadFlow = async () => {
  const api = await import(modulePath).catch(error => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return {};
  });
  assert.equal(typeof api.evaluateStandardizationFlow, 'function', 'real pure-function flow evaluator must exist');
  return api.evaluateStandardizationFlow;
};

for (const control of standardizationFlowControls) {
  test('current public-safe flow control: ' + control.id, async () => {
    const evaluate = await loadFlow();
    const row = evaluate([control], standardizationFlowCatalog).controls[0];
    if (!control.inputBudgetBytes) {
      assert.equal(Boolean(row.identityConflict.raw), control.expectedIdentityConflict ?? false, 'raw identity guard');
      assert.equal(Boolean(row.identityConflict.text), control.expectedIdentityConflict ?? false, 'frozen identity guard');
    }
    assert.equal(Boolean(row.publicationConflict.raw), control.expectedPublicationConflict ?? false, 'raw publication guard');
    assert.equal(Boolean(row.publicationConflict.text), control.expectedPublicationConflict ?? false, 'frozen publication guard');
    assert.equal(row.protocolReasonCode, null, 'control proposal must be structurally valid');
    assert.equal(row.finalDisposition, control.expectedDisposition, 'actual final validator disposition');
    assert.deepEqual(row.finalTags, control.expectedTags ?? {}, 'only semantically supported tags survive');
    if (control.expectedReasonCode) assert.equal(row.finalReasonCode, control.expectedReasonCode);
    if (control.expectedDisposition === 'release') assert.deepEqual(row.finalIdentity, control.expectedIdentity);
    if (control.expectedIdentity && !control.inputBudgetBytes) {
      assert.ok(row.recalledCandidateIds.includes(row.candidateTargetId), 'actual candidate recall');
    }
    if (control.inputBudgetBytes) {
      assert.equal(row.frozenEvidenceLength, control.body.length, 'oversized input keeps full body');
      assert.equal(row.planned, false, 'no title-only batch');
    }
  });
}

test('synthetic controls do not become observed model accuracy and regressions remain visible', async () => {
  const evaluate = await loadFlow();
  const report = evaluate(standardizationFlowControls, standardizationFlowCatalog);
  assert.equal(report.mode, 'synthetic-pure-function-controls');
  assert.equal(report.providerRequests, 0);
  assert.equal(report.metrics.modelSemanticQuality, 'unknown');
  assert.deepEqual(report.metrics.modelProposalCorrectness, { numerator: 0, denominator: 0, value: null });
  assert.equal(report.metrics.identityRuleFalseRejection.value, 0);
  assert.equal(report.metrics.candidateRecallMiss.value, 0);
  assert.equal(report.metrics.finalErroneousRelease.value, 0);
  assert.deepEqual(report.failedControlIds, []);
  assert.ok(report.groupedCoverage.groups < standardizationFlowControls.length, 'alternate proposals share their full-evidence group');
  assert.equal(report.groupedCoverage.reviewedIdentityGroups + report.groupedCoverage.noReviewedIdentityGroups, report.groupedCoverage.groups);
  assert.deepEqual(report.tagRegression, { missingExpectedValues: 0, unsupportedOrContradictoryValues: 0 });
  const sameEvidence = report.evidenceGroups.find(group => group.controlIds.includes('pro-price-not-tier'));
  assert.ok(sameEvidence?.controlIds.includes('pro-price-wrong-tier'));
});

test('checked-in control facts contain no private URLs, contact details or credential values', () => {
  const copy = JSON.stringify(standardizationFlowControls);
  assert.doesNotMatch(copy, /https?:\/\/|www\.|[\w.+-]+@[\w.-]+\.[a-z]{2,}|sk-[a-z0-9]{12,}|-----/iu);
  assert.equal(new Set(standardizationFlowControls.map(row => row.id)).size, standardizationFlowControls.length);
  assert.ok(standardizationFlowControls.every(row => row.soldObject && row.body));
});

test('multiple delivery formats cannot hide the erroneous credentials proposal behind a valid JSON sibling', async () => {
  const evaluate = await loadFlow();
  const control = standardizationFlowControls.find(row => row.id === 'rt-wrong-credentials')!;
  const report = evaluate([control], standardizationFlowCatalog);
  assert.deepEqual(report.controls[0].proposedTags, { delivery_format: ['credentials', 'json'] });
  assert.deepEqual(report.metrics.syntheticProposalCorrectness, { numerator: 0, denominator: 1, value: 0 });
  assert.deepEqual(report.controls[0].finalTags, { delivery_format: 'json' });
});

test('offline CLI reports current controls separately from historical mocked accuracy', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'apps/api/scripts/evaluate-standardization.ts'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.ok(report.currentFlowControls, 'CLI must include current pure-function controls');
  assert.equal(report.modelSemanticQuality, 'unknown', 'overall report has no real model observations');
  assert.equal(report.modelAccuracy, null);
  assert.equal(report.currentFlowControls.mode, 'synthetic-pure-function-controls');
  assert.equal(report.currentFlowControls.controls.length, standardizationFlowControls.length);
  assert.equal(report.currentFlowControls.metrics.modelProposalCorrectness.value, null);
  assert.match(report.metricRegression.purpose, /not production accuracy/u);
});

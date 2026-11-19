import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { standardizationFlowCatalog, standardizationFlowControls } from './fixtures/standardization-flow-controls-20261008.js';
import { isCanonicalProductTag } from '@price-comparison/catalog/product-tag-policy';

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
    assert.deepEqual(row.mockMatchReview, control.mockMatchReview);
    assert.equal(row.protocolReasonCode, control.proposalIdentity ? null : 'unmatched');
    assert.deepEqual(row.finalEvidence, [{ path: 'name', quote: control.name.normalize('NFKC') }], 'review retains literal frozen evidence');
    assert.equal(row.finalDisposition, control.expectedDisposition, 'actual final validator disposition');
    assert.deepEqual(row.finalTags, control.expectedTags ?? {}, 'mock review decisions pass through objective validation');
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
  assert.ok(standardizationFlowControls.flatMap(row => row.proposalTags ?? []).every(isCanonicalProductTag),
    'label controls use current typed vocabulary even when their cited meaning is deliberately wrong');
});

test('explicit mock review rejects one client while retaining its approved sibling', async () => {
  const evaluate = await loadFlow();
  const control = standardizationFlowControls.find(row => row.id === 'rt-wrong-client')!;
  const report = evaluate([control], standardizationFlowCatalog);
  assert.deepEqual(report.controls[0].proposedTags, { supported_client: ['codex', 'sub2api'] });
  assert.deepEqual(report.metrics.syntheticProposalCorrectness, { numerator: 0, denominator: 1, value: 0 });
  assert.deepEqual(report.controls[0].finalTags, { supported_client: 'sub2api' });
});

test('flow evaluation requires explicit mock votes and does not infer tag semantics from evidence', async () => {
  const evaluate = await loadFlow();
  const control = standardizationFlowControls.find(row => row.id === 'team-ban-not-capability')!;
  assert.throws(() => evaluate([{ ...control, mockTagReview: undefined }], standardizationFlowCatalog));
  assert.throws(() => evaluate([{ ...control, mockTagReview: { accepted: [], complete: true } }], standardizationFlowCatalog));
  const approved = evaluate([{ ...control, mockTagReview: { accepted: [true], complete: true } }], standardizationFlowCatalog);
  assert.deepEqual(approved.controls[0].finalTags, { access_channel: 'reverse_proxy' });
  assert.equal(approved.controls[0].matchesExpected, false);
  assert.equal(approved.tagRegression.unsupportedOrContradictoryValues, 1);
  assert.equal(approved.metrics.modelSemanticQuality, 'unknown');
});

test('flow evaluation requires binary match review and never substitutes local semantic heuristics', async () => {
  const evaluate = await loadFlow();
  const control = standardizationFlowControls.find(row => row.id === 'team-tool-not-subscription')!;
  assert.throws(() => evaluate([{ ...control, mockMatchReview: undefined }], standardizationFlowCatalog));
  assert.throws(() => evaluate([{ ...control, mockMatchReview: { approved: 'true' } }], standardizationFlowCatalog));
  const rejected = evaluate([control], standardizationFlowCatalog).controls[0];
  assert.equal(rejected.finalDisposition, 'review');
  assert.equal(rejected.finalReasonCode, 'review_rejected');
  const approved = evaluate([{ ...control, mockMatchReview: { approved: true } }], standardizationFlowCatalog);
  assert.equal(approved.controls[0].finalDisposition, 'release');
  assert.equal(approved.controls[0].matchesExpected, false);
  assert.equal(approved.metrics.finalErroneousRelease.value, 1);
});

test('flow evaluation keeps unmatched evidence without inventing a candidate or identity', async () => {
  const evaluate = await loadFlow();
  const control = standardizationFlowControls.find(row => row.id === 'unknown-full-evidence')!;
  const row = evaluate([control], standardizationFlowCatalog).controls[0];
  assert.equal(row.protocolReasonCode, 'unmatched');
  assert.equal(row.finalReasonCode, 'unmatched');
  assert.equal(row.finalIdentity, null);
  assert.deepEqual(row.finalEvidence, [{ path: 'name', quote: control.name }]);
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
  assert.equal(report.mockProtocol.passed, report.mockProtocol.cases);
  assert.equal(report.mockProtocol.providerRequests, 0);
  assert.ok(report.mockProtocol.cases >= 6, 'match, unmatched, schema, missing ID, candidate and citation controls');
});

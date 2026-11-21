import assert from 'node:assert/strict';
import test from 'node:test';
import * as versions from '../src/ai/pipeline-versions.js';
import { productProcessingSummary } from '../src/ai/product-standardization-state.js';
import { isManualDecisionForCurrentEvidence, type ManualDecision } from '../src/standardization/decision-history.js';
import { IDENTITY_POLICY_VERSION } from '../src/standardization/identity-policy.js';

test('match-only task policy rejects the former identity rule and snapshots without its boundary', () => {
  const policy = versions.STANDARDIZATION_POLICY_VERSION;
  assert.notEqual(policy, IDENTITY_POLICY_VERSION);
  const snapshot = versions.pipelineVersionSnapshot('mock') as Record<string, string>;
  const job = { prompt_version: versions.PIPELINE_VERSIONS.prompt, rule_version: policy, pipeline_versions: snapshot };
  assert.doesNotThrow(() => versions.assertCurrentPipeline(job));
  assert.throws(() => versions.assertCurrentPipeline({ ...job, rule_version: IDENTITY_POLICY_VERSION }), { code: 'AI_POLICY_STALE' });
  const previous = { ...snapshot };
  delete previous.standardizationPolicy;
  assert.equal(versions.isCurrentPipeline(previous), false);
  assert.throws(() => versions.assertCurrentPipeline({ ...job, pipeline_versions: previous }), { code: 'AI_POLICY_STALE' });
  assert.equal(versions.isCurrentPipeline({ ...snapshot, standardizationPolicy: 'old' }), false);
});

test('canonical resolution and admission policy no longer determine task validity', () => {
  const snapshot = versions.pipelineVersionSnapshot('mock') as Record<string, string>;
  delete snapshot.resolution;
  delete snapshot.identityPolicy;
  assert.equal(versions.isCurrentPipeline(snapshot), true);
});

test('historical membership retrieval and identity publication validation snapshots are stale', () => {
  const snapshot = versions.pipelineVersionSnapshot('mock') as Record<string, string>;
  assert.equal(versions.isCurrentPipeline({ ...snapshot, retrieval: 'weighted-member-name-display-20261007-v2' }), false);
  assert.equal(versions.isCurrentPipeline({ ...snapshot, validation: 'evidence-identity-publication-20261025-v11' }), false);
});

test('manual decisions require known matching version and fingerprint', () => {
  const decision: ManualDecision = {
    id: 1n, product_id: 11n, action: 'exclude', standard_product_id: null, previous_standard_product_id: null,
    target_snapshot: null, content_version: 2n, content_fingerprint: 'current', standardization_revision: 1n,
    evidence_known: true, evidence_snapshot: {}, reason: 'reviewed', source: 'application', created_at: new Date(),
  };
  const current = { content_version: 2n, content_fingerprint: 'current' };
  assert.equal(isManualDecisionForCurrentEvidence(decision, current), true);
  for (const changed of [
    { ...decision, evidence_known: false }, { ...decision, content_version: null },
    { ...decision, content_fingerprint: null }, { ...decision, content_version: 1n },
    { ...decision, content_fingerprint: 'old' }, undefined,
  ]) assert.equal(isManualDecisionForCurrentEvidence(changed, current), false);
});

test('unmatched is pending work with existing retry controls, never a handled refusal', () => {
  assert.deepEqual(productProcessingSummary({ reasonCode: 'unmatched', reason: 'No matching candidate' }), {
    reasonCode: 'unmatched', reason: 'No matching candidate', processingDisposition: 'retry_available',
  });
});

test('old model refusal reasons are never handled outcomes', () => {
  for (const reasonCode of ['insufficient_evidence', 'not_sellable', 'missing_identity']) {
    assert.equal(productProcessingSummary({ reasonCode }).processingDisposition, 'pending');
  }
});

test('only the local relay exclusion is a handled result', () => {
  assert.equal(productProcessingSummary({ reasonCode: 'api_relay_excluded' }).processingDisposition, 'handled');
  const snapshot = versions.pipelineVersionSnapshot('mock') as Record<string, string>;
  assert.equal(versions.isCurrentPipeline({ ...snapshot, standardizationPolicy: 'standardization-match-only-20261119-v2' }), false);
});

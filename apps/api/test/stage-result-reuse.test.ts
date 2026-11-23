import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as versions from '../src/ai/pipeline-versions.js';

test('result projections exclude shared execution versions and unrelated stages', () => {
  assert.equal(typeof versions.taskResultVersions, 'function');
  const stages = {
    standardization: ['contentFingerprint', 'prompt', 'schema', 'projection', 'retrieval', 'mapping',
      'standardizationPolicy', 'validation', 'standardizationReviewPrompt'],
    tag_extraction: ['contentFingerprint', 'projection', 'tagPrompt', 'tagProtocol', 'tagReviewPrompt',
      'tagWarrantyPrompt', 'tagValidation'],
    membership_features: ['contentFingerprint', 'projection', 'membershipPolicy', 'membershipFeaturePrompt',
      'membershipFeatureReviewPrompt'],
  } as const;
  for (const [kind, expectedKeys] of Object.entries(stages)) {
    const required = versions.taskResultVersions(kind as keyof typeof stages);
    assert.deepEqual(Object.keys(required).sort(), [...expectedKeys].sort());
    for (const key of Object.keys(versions.PIPELINE_VERSIONS)) {
      const historical = { ...versions.PIPELINE_VERSIONS, [key]: 'older' };
      const reusable = Object.entries(required).every(([name, value]) => historical[name as keyof typeof historical] === value);
      assert.equal(reusable, !(expectedKeys as readonly string[]).includes(key), `${kind}: ${key}`);
      const executionKind = kind === 'standardization' ? 'manual_full' : kind as 'tag_extraction' | 'membership_features';
      assert.equal(versions.isCurrentPipeline(historical, executionKind),
        reusable && !['reviewWorkflow', 'offerEligibility', 'attributeOrder'].includes(key), `execution ${kind}: ${key}`);
    }
  }
  for (const kind of ['incremental', 'manual_full', 'calibration'] as const) {
    assert.deepEqual(versions.taskResultVersions(kind), versions.taskResultVersions('standardization'));
  }
  assert.deepEqual(versions.taskResultVersions('text_review'), versions.PIPELINE_VERSIONS);
});

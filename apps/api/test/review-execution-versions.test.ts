import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as versions from '../src/ai/pipeline-versions.js';

const kinds = ['incremental', 'manual_full', 'calibration', 'tag_extraction', 'membership_features', 'text_review'] as const;
const shared = ['reviewWorkflow', 'offerEligibility', 'attributeOrder'];

for (const kind of kinds) {
  test(`${kind} execution only invalidates its own result and shared execution versions`, () => {
    const required = kind === 'text_review' ? Object.keys(versions.PIPELINE_VERSIONS)
      : [...Object.keys(versions.taskResultVersions(kind)), ...shared];
    for (const key of Object.keys(versions.PIPELINE_VERSIONS)) {
      assert.equal(versions.isCurrentPipeline({ ...versions.PIPELINE_VERSIONS, [key]: 'older' }, kind),
        !required.includes(key), `${kind}: ${key}`);
    }
    assert.equal(versions.isCurrentPipeline(null, kind), false);
    assert.equal(versions.isCurrentPipeline([], kind), false);
    assert.equal(versions.isCurrentPipeline({}, kind), false);
  });

  test(`${kind} exposes the same execution projection used by snapshot checks`, () => {
    assert.equal(typeof versions.taskExecutionVersions, 'function');
    const expected = kind === 'text_review' ? versions.PIPELINE_VERSIONS : {
      ...versions.taskResultVersions(kind),
      reviewWorkflow: versions.PIPELINE_VERSIONS.reviewWorkflow,
      offerEligibility: versions.PIPELINE_VERSIONS.offerEligibility,
      attributeOrder: versions.PIPELINE_VERSIONS.attributeOrder,
    };
    assert.deepEqual(versions.taskExecutionVersions(kind), expected);
    assert.equal(versions.isCurrentPipeline(expected, kind), true);
    for (const key of Object.keys(expected)) {
      const missing = { ...expected };
      delete missing[key as keyof typeof missing];
      assert.equal(versions.isCurrentPipeline(missing, kind), false, `missing ${key}`);
    }
  });

  test(`${kind} enforces standardization headers only for identity and text jobs`, () => {
    const job = {
      job_type: kind, prompt_version: versions.PIPELINE_VERSIONS.prompt,
      rule_version: versions.STANDARDIZATION_POLICY_VERSION,
      pipeline_versions: versions.pipelineVersionSnapshot('mock'),
    };
    assert.doesNotThrow(() => versions.assertCurrentPipeline(job));
    for (const key of ['prompt_version', 'rule_version'] as const) {
      const old = { ...job, [key]: 'older' };
      if (kind === 'tag_extraction' || kind === 'membership_features') {
        assert.doesNotThrow(() => versions.assertCurrentPipeline(old));
      } else assert.throws(() => versions.assertCurrentPipeline(old), { code: 'AI_POLICY_STALE' });
    }
    for (const key of shared) {
      assert.throws(() => versions.assertCurrentPipeline({
        ...job, pipeline_versions: { ...versions.PIPELINE_VERSIONS, [key]: 'older' },
      }), { code: 'AI_POLICY_STALE' });
    }
  });
}

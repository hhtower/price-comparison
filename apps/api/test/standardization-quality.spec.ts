import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildCanonicalStandardKey } from '../src/standardization/canonical-key.js';
import { evaluateStandardizationQuality } from '../src/standardization/quality-evaluation.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/standardization-quality.json', import.meta.url), 'utf8')) as {
  version: string;
  modelSemanticQuality: string;
  samples: Array<{ id: string; shouldClassify: boolean; identity: null | { family: string; product: string; tier: string }; tags: Record<string, string>; sameIdentityGroup?: string; differentFrom?: string[]; unclassifiedReason?: string }>;
};
const recordedResponses = JSON.parse(await readFile(new URL('./fixtures/standardization-recorded-responses.json', import.meta.url), 'utf8'));

test('quality fixture covers required classification and duplicate-risk boundaries', () => {
  const ids = new Set(fixture.samples.map(sample => sample.id));
  for (const required of ['chatgpt-plus-default', 'other-brand-plus', 'chatgpt-pro', 'chatgpt-sms', 'outlook-fields', 'tiktok-cn', 'x-premium-alias', 'x-premium-plus', 'duration-shared-variant', 'transitive-a', 'transitive-b', 'transitive-c', 'missing-evidence', 'non-sale-notice', 'zero-price-real-item', 'long-tail-conflict']) assert.ok(ids.has(required), required);
  assert.equal(fixture.modelSemanticQuality, 'unknown');
  assert.ok(fixture.samples.some(sample => sample.unclassifiedReason === 'insufficient_evidence'));
  assert.ok(fixture.samples.some(sample => sample.unclassifiedReason === 'non_sale_item'));
});

test('identity labels encode same and different canonical expectations without using tags', () => {
  const byId = new Map(fixture.samples.map(sample => [sample.id, sample]));
  const groups = new Map<string, Set<string>>();
  for (const sample of fixture.samples) {
    if (!sample.shouldClassify) {
      assert.equal(sample.identity, null);
      continue;
    }
    assert.ok(sample.identity);
    const key = buildCanonicalStandardKey(sample.identity!);
    if (sample.sameIdentityGroup) {
      const keys = groups.get(sample.sameIdentityGroup) ?? new Set<string>();
      keys.add(key);
      groups.set(sample.sameIdentityGroup, keys);
    }
    for (const otherId of sample.differentFrom ?? []) {
      const other = byId.get(otherId);
      assert.ok(other?.identity, `${sample.id} references missing ${otherId}`);
      assert.notEqual(key, buildCanonicalStandardKey(other!.identity!), `${sample.id} must differ from ${otherId}`);
    }
  }
  for (const [group, keys] of groups) assert.equal(keys.size, 1, group);
});

test('recorded responses calculate candidate, identity, classification, and tag quality without a model call', () => {
  const report = evaluateStandardizationQuality(fixture, recordedResponses);

  assert.equal(report.fixtureVersion, fixture.version);
  assert.deepEqual(report.sampleCoverage, {
    evaluated: 16,
    total: 16,
    missingResponseIds: [],
  });
  assert.deepEqual(
    pickRatio(report.candidateRecall),
    { numerator: 12, denominator: 13, value: 12 / 13 },
  );
  assert.equal(report.candidateRecall.coldStartCount, 1);
  assert.deepEqual(
    pickRatio(report.budgetTruncationLoss),
    { numerator: 1, denominator: 13, value: 1 / 13 },
  );
  assert.deepEqual(
    pickRatio(report.classificationCoverage),
    { numerator: 13, denominator: 14, value: 13 / 14 },
  );
  assert.deepEqual(
    pickRatio(report.falseMergeRate),
    { numerator: 3, denominator: 6, value: 0.5 },
  );
  assert.deepEqual(report.falseMergeRate.pairs, [
    ['chatgpt-plus-default', 'long-tail-conflict'],
    ['transitive-a', 'transitive-c'],
    ['x-premium-alias', 'x-premium-plus'],
  ]);
  assert.deepEqual(
    pickRatio(report.identitySplitRate),
    { numerator: 4, denominator: 6, value: 4 / 6 },
  );
  assert.deepEqual(
    pickRatio(report.nonSaleFalsePositiveRate),
    { numerator: 1, denominator: 1, value: 1 },
  );
  assert.equal(report.unclassifiedReasons.insufficient_evidence, 2);
  assert.deepEqual(report.tagFields.duration, {
    comparisons: 5,
    errors: 1,
    missing: 1,
    wrongValue: 0,
    unexpected: 0,
    rate: 0.2,
  });
  assert.deepEqual(report.tagFields.access, {
    comparisons: 3,
    errors: 2,
    missing: 0,
    wrongValue: 2,
    unexpected: 0,
    rate: 2 / 3,
  });
  assert.deepEqual(report.tagFields.region, {
    comparisons: 2,
    errors: 1,
    missing: 0,
    wrongValue: 0,
    unexpected: 1,
    rate: 0.5,
  });
  assert.ok(report.classificationCoverage.wilson95);
  assert.ok(report.classificationCoverage.wilson95!.low < report.classificationCoverage.value!);
  assert.ok(report.classificationCoverage.wilson95!.high > report.classificationCoverage.value!);
});

test('quality metrics stay unknown when there is no eligible denominator', () => {
  const report = evaluateStandardizationQuality(
    { version: 'empty', samples: [] },
    { version: 'empty-responses', fixtureVersion: 'empty', catalog: [], outcomes: [] },
  );
  assert.deepEqual(pickRatio(report.candidateRecall), {
    numerator: 0,
    denominator: 0,
    value: null,
  });
  assert.equal(report.candidateRecall.wilson95, null);
});

function pickRatio(metric: { numerator: number; denominator: number; value: number | null }) {
  return {
    numerator: metric.numerator,
    denominator: metric.denominator,
    value: metric.value,
  };
}

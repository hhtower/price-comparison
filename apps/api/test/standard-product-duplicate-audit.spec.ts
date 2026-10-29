import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { auditStandardProductDuplicates, VersionedDuplicateAuditIndex } from '../src/standardization/duplicate-audit.js';
import { DUPLICATE_LINKAGE_POLICY } from '../src/standardization/duplicate-linkage-policy.js';
import { classifyDuplicatePair, extractDuplicateFeatures } from '../src/standardization/duplicate-linkage.js';
import { calibrateDuplicateLinkage, checkDuplicateLinkageCalibration } from '../perf/calibrate-standard-product-linkage.js';
import { buildDuplicateAuditReport, loadDuplicateQualityGates } from '../perf/standard-product-duplicate-audit.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/standard-product-duplicate-pairs.json', import.meta.url), 'utf8')) as {
  version: string;
  truthGroups: Array<{ id: string; members: string[] }>;
  pairs: Array<{ id: string; partition: string; label: 'match' | 'non_match'; confirmedAlias: boolean; hardConflictReason: string | null; left: Product; right: Product }>;
};
type Product = { id: string; family: string; product: string; tier: string; canonicalKey?: string };

test('linkage decisions preserve deterministic edges and hard conflicts', () => {
  for (const pair of fixture.pairs) {
    const features = extractDuplicateFeatures(pair.left, pair.right, DUPLICATE_LINKAGE_POLICY);
    if (pair.confirmedAlias) features.confirmedAlias = true;
    const decision = classifyDuplicatePair(features, DUPLICATE_LINKAGE_POLICY);
    if (pair.confirmedAlias || pair.id.includes('same-key')) assert.equal(decision.conclusion, 'deterministic_match', pair.id);
    if (pair.hardConflictReason) {
      assert.equal(decision.conclusion, 'distinct', pair.id);
      assert.ok(decision.hardConflicts.includes(pair.hardConflictReason), pair.id);
    }
    assert.equal(decision.policyVersion, DUPLICATE_LINKAGE_POLICY.version);
    assert.ok(decision.contributions.length > 0);
  }
});

test('audit emits linear deterministic classes and never closes semantic transitivity', () => {
  const products = fixture.pairs.flatMap(pair => [pair.left, pair.right]).filter((item, index, all) => all.findIndex(candidate => candidate.id === item.id) === index);
  const aliases = fixture.pairs.filter(pair => pair.confirmedAlias).map(pair => ({ fromId: pair.left.id, toId: pair.right.id, confirmed: true }));
  const result = auditStandardProductDuplicates(products, aliases, { snapshotVersion: 'snapshot-1', aliasVersion: 'aliases-1' });
  const edgeCount = result.deterministicGroups.reduce((sum, group) => sum + group.edges.length, 0);
  assert.equal(edgeCount, products.length - result.deterministicGroups.length);
  assert.ok(result.deterministicGroups.some(group => group.members.includes('sp-003') && group.members.includes('sp-004')));
  assert.ok(!result.deterministicGroups.some(group => group.members.includes('sp-011') && group.members.includes('sp-013')));
  assert.ok(result.stats.comparedPairs <= products.length * result.limits.maxComparedPerIdentity);
  for (const route of Object.values(result.stats.routes)) assert.ok(route.scannedPostings <= route.scanLimit);
});

test('incremental audit equals the full result subset and cursor rejects version changes', () => {
  const products = fixture.pairs.flatMap(pair => [pair.left, pair.right]).filter((item, index, all) => all.findIndex(candidate => candidate.id === item.id) === index);
  const options = { snapshotVersion: 'snapshot-2', aliasVersion: 'aliases-2', maxReportedSuspectPairs: 1 };
  const first = auditStandardProductDuplicates(products, [], options);
  assert.ok(first.nextCursor);
  const pages = [first];
  let cursor = first.nextCursor;
  while (cursor !== null) {
    pages.push(auditStandardProductDuplicates(products, [], { ...options, cursor }));
    cursor = pages.at(-1)!.nextCursor;
  }
  const pagedKeys = pages.flatMap(page => page.suspectedPairs.map(pair => pair.pairKey));
  assert.equal(new Set(pagedKeys).size, pagedKeys.length);
  assert.throws(() => auditStandardProductDuplicates(products, [], { ...options, snapshotVersion: 'changed', cursor: first.nextCursor! }), /cursor version mismatch/u);

  const changedIds = ['sp-011'];
  const full = auditStandardProductDuplicates(products, [], { ...options, maxReportedSuspectPairs: 100 });
  assert.deepEqual(pagedKeys, full.suspectedPairs.map(pair => pair.pairKey));
  const incremental = auditStandardProductDuplicates(products, [], { ...options, maxReportedSuspectPairs: 100, changedIds });
  assert.deepEqual(incremental.allCandidatePairs.map(pair => pair.pairKey), full.allCandidatePairs.filter(pair => changedIds.some(id => pair.ids.includes(id))).map(pair => pair.pairKey));
});

test('one-percent duplicate audit only evaluates changed identities against the full directory', () => {
  const products = Array.from({ length: 500 }, (_, index): Product => ({
    id: `catalog-${index.toString().padStart(4, '0')}`,
    family: `vendor-${index % 10}`,
    product: `shared service ${index % 25}`,
    tier: `tier-${index % 4}`,
    canonicalKey: `catalog-key-${index}`,
  }));
  const changedIds = products.slice(0, 5).map(product => product.id);
  const options = {
    snapshotVersion: 'large-snapshot',
    aliasVersion: 'large-aliases',
    maxReportedSuspectPairs: 10_000,
  };

  const full = auditStandardProductDuplicates(products, [], options);
  const incremental = auditStandardProductDuplicates(products, [], { ...options, changedIds });
  const expectedPairKeys = full.allCandidatePairs
    .filter(pair => pair.ids.some(id => changedIds.includes(id)))
    .map(pair => pair.pairKey);

  assert.deepEqual(incremental.allCandidatePairs.map(pair => pair.pairKey), expectedPairKeys);
  assert.equal(incremental.stats.processedIdentityCount, changedIds.length);
  assert.ok(incremental.stats.comparedPairs <= changedIds.length * incremental.limits.maxComparedPerIdentity);
  assert.ok(incremental.stats.comparedPairs < full.stats.comparedPairs);
});

test('incremental audit counts reciprocal posting reads used by mutual selection', () => {
  const index = VersionedDuplicateAuditIndex.build({
    snapshotVersion: 'reciprocal-1',
    aliasVersion: 'aliases-1',
    products: [
      { id: 'reciprocal-a', family: 'Vendor', product: 'Shared Service', tier: 'Basic', canonicalKey: 'key-a' },
      { id: 'reciprocal-b', family: 'Vendor', product: 'Shared Service', tier: 'Premium', canonicalKey: 'key-b' },
    ],
    aliases: [],
  }, {
    maxScannedPerRoutePerIdentity: 1,
    disabledRoutes: ['productTier', 'characterNgram', 'combinedToken'],
  });

  const incremental = index.audit({ changedIds: ['reciprocal-a'] });

  assert.equal(incremental.stats.routes.familyProduct.scannedPostings, 2);
  assert.equal(incremental.stats.routes.familyProduct.scanLimit, 2);
});

test('versioned duplicate audit updates only changed postings and preserves candidate-decision equivalence', () => {
  const products = Array.from({ length: 500 }, (_, index): Product => ({
    id: `versioned-${index.toString().padStart(4, '0')}`,
    family: `vendor-${index % 10}`,
    product: `shared service ${index % 25}`,
    tier: `tier-${index % 4}`,
    canonicalKey: `versioned-key-${index}`,
  }));
  const changed = products.slice(0, 5).map(product => ({ ...product, product: `${product.product} revision` }));
  const changedIds = changed.map(product => product.id);
  const index = VersionedDuplicateAuditIndex.build({
    snapshotVersion: 'versioned-1',
    aliasVersion: 'aliases-1',
    products,
    aliases: [],
  });

  const applied = index.applyChanges(
    changed.map(product => ({ productId: product.id, operation: 'upsert' as const, product })),
    'versioned-2',
    { aliasVersion: 'aliases-1' },
  );
  const full = index.audit();
  const incremental = index.audit({ changedIds });

  assert.equal(applied.processedChangeCount, changedIds.length);
  assert.ok(applied.updatedPostingCount > 0);
  assert.ok(applied.updatedPostingCount < products.length);
  assert.deepEqual(
    incremental.allCandidatePairs.map(pair => pair.pairKey),
    full.allCandidatePairs.filter(pair => pair.ids.some(id => changedIds.includes(id))).map(pair => pair.pairKey),
  );
  assert.equal(incremental.stats.processedIdentityCount, changedIds.length);
  assert.ok(incremental.stats.comparedPairs < full.stats.comparedPairs);
  assert.throws(
    () => index.applyChanges([], 'versioned-3', { aliasVersion: 'aliases-2' }),
    /alias version changed/u,
  );
});

test('versioned duplicate audit leaves the previous snapshot intact when change preparation fails', () => {
  const products: Product[] = [
    { id: 'atomic-a', family: 'vendor', product: 'service alpha', tier: 'basic', canonicalKey: 'atomic-a' },
    { id: 'atomic-b', family: 'vendor', product: 'service beta', tier: 'basic', canonicalKey: 'atomic-b' },
  ];
  const index = VersionedDuplicateAuditIndex.build({
    snapshotVersion: 'atomic-1',
    aliasVersion: 'aliases-1',
    products,
    aliases: [],
  });
  const before = index.audit();
  const invalidProduct = {
    id: 'atomic-a',
    get family(): string { throw new Error('feature preparation failed'); },
    product: 'service alpha revision',
    tier: 'basic',
    canonicalKey: 'atomic-a-revision',
  };

  assert.throws(
    () => index.applyChanges([
      { productId: invalidProduct.id, operation: 'upsert', product: invalidProduct },
    ], 'atomic-2'),
    /feature preparation failed/u,
  );

  assert.equal(index.snapshotVersion, 'atomic-1');
  assert.equal(index.size, products.length);
  assert.deepEqual(index.audit(), before);
});

test('versioned duplicate audit refreshes deterministic groups after canonical-key updates and deletion', () => {
  const products: Product[] = [
    { id: 'group-a', family: 'vendor', product: 'alpha', tier: 'basic', canonicalKey: 'shared-a' },
    { id: 'group-b', family: 'vendor', product: 'alpha alias', tier: 'basic', canonicalKey: 'shared-a' },
    { id: 'group-c', family: 'vendor', product: 'charlie', tier: 'pro', canonicalKey: 'shared-c' },
  ];
  const index = VersionedDuplicateAuditIndex.build({
    snapshotVersion: 'groups-1',
    aliasVersion: 'aliases-1',
    products,
    aliases: [],
  });

  index.applyChanges([{
    productId: 'group-b',
    operation: 'upsert',
    product: { ...products[1]!, canonicalKey: 'shared-c' },
  }], 'groups-2');
  assert.deepEqual(
    index.audit().deterministicGroups.map(group => group.members),
    [['group-a'], ['group-b', 'group-c']],
  );

  index.applyChanges([{ productId: 'group-b', operation: 'delete' }], 'groups-3');
  const afterDelete = index.audit();
  assert.deepEqual(afterDelete.deterministicGroups.map(group => group.members), [['group-a'], ['group-c']]);
  assert.ok(afterDelete.allCandidatePairs.every(pair => !pair.ids.includes('group-b')));
  assert.throws(() => index.audit({ changedIds: ['group-b'] }), /not in the duplicate audit snapshot/u);
});

test('versioned duplicate audit rejects duplicate changes before mutating the snapshot', () => {
  const product: Product = {
    id: 'duplicate-change', family: 'vendor', product: 'service', tier: 'basic', canonicalKey: 'key-1',
  };
  const index = VersionedDuplicateAuditIndex.build({
    snapshotVersion: 'duplicate-change-1',
    aliasVersion: 'aliases-1',
    products: [product],
    aliases: [],
  });

  assert.throws(() => index.applyChanges([
    { productId: product.id, operation: 'upsert', product },
    { productId: product.id, operation: 'delete' },
  ], 'duplicate-change-2'), /duplicate audit change id/u);
  assert.equal(index.snapshotVersion, 'duplicate-change-1');
  assert.equal(index.size, 1);
});

test('per-identity top-K keeps the strongest suspected pair before stable pagination ordering', () => {
  const mutablePolicy = DUPLICATE_LINKAGE_POLICY as { suspectedThreshold: number };
  const originalThreshold = mutablePolicy.suspectedThreshold;
  mutablePolicy.suspectedThreshold = 1;
  try {
    const products: Product[] = [
      { id: 'a', family: 'twitter', product: 'premium account', tier: 'basic monthly', canonicalKey: 'a' },
      { id: 'b', family: 'x', product: 'premium account', tier: 'basic', canonicalKey: 'b' },
      { id: 'z', family: 'x', product: 'premium account', tier: 'basic', canonicalKey: 'z' },
    ];
    const result = auditStandardProductDuplicates(products, [], {
      snapshotVersion: 'ranking-snapshot',
      aliasVersion: 'ranking-aliases',
      topSuspectsPerIdentity: 1,
    });

    assert.deepEqual(result.suspectedPairs.map(pair => pair.ids), [['b', 'z']]);
  } finally {
    mutablePolicy.suspectedThreshold = originalThreshold;
  }
});

test('development and holdout identities do not leak across fixture partitions', () => {
  const ownership = new Map<string, string>();
  for (const pair of fixture.pairs) for (const product of [pair.left, pair.right]) {
    const previous = ownership.get(product.id);
    assert.ok(!previous || previous === pair.partition, `${product.id} occurs in both ${previous} and ${pair.partition}`);
    ownership.set(product.id, pair.partition);
  }
});

test('frozen linkage policy matches development-only calibration', async () => {
  await checkDuplicateLinkageCalibration();
});

test('tier anchors separate a missing cadence from a conflicting named tier', () => {
  const compatible = fixture.pairs.find(pair => pair.id === 'dev-transitive-ab')!;
  const conflicting = fixture.pairs.find(pair => pair.id === 'dev-transitive-bc')!;

  const compatibleDecision = classifyDuplicatePair(
    extractDuplicateFeatures(compatible.left, compatible.right, DUPLICATE_LINKAGE_POLICY),
    DUPLICATE_LINKAGE_POLICY,
  );
  const conflictingDecision = classifyDuplicatePair(
    extractDuplicateFeatures(conflicting.left, conflicting.right, DUPLICATE_LINKAGE_POLICY),
    DUPLICATE_LINKAGE_POLICY,
  );

  assert.equal(compatibleDecision.conclusion, 'suspected_duplicate');
  assert.equal(conflictingDecision.conclusion, 'distinct');
  assert.ok(conflictingDecision.hardConflicts.includes('tier_conflict'));
  assert.ok(compatibleDecision.score > conflictingDecision.score);
});

test('tier core removes cadence and access qualifiers without erasing identity terms', () => {
  const base = { family: 'OpenAI', product: 'ChatGPT' };
  const cadenceAndAccess = extractDuplicateFeatures(
    { id: 'base', ...base, tier: 'Pro' },
    { id: 'qualified', ...base, tier: 'Pro monthly shared' },
    DUPLICATE_LINKAGE_POLICY,
  );
  const differentSaleObjects = extractDuplicateFeatures(
    { id: 'account', ...base, tier: 'Pro account' },
    { id: 'license', ...base, tier: 'Pro license' },
    DUPLICATE_LINKAGE_POLICY,
  );

  assert.equal(cadenceAndAccess.tierCoreExact, true);
  assert.equal(differentSaleObjects.tierCoreExact, false);
});

test('frozen duplicate gates pass the isolated fixed holdout without lowering thresholds', async () => {
  const gates = await loadDuplicateQualityGates();
  const report = await buildDuplicateAuditReport();

  assert.equal(gates.policyVersion, DUPLICATE_LINKAGE_POLICY.version);
  assert.equal(DUPLICATE_LINKAGE_POLICY.suspectedThreshold, 3.5);
  assert.equal(gates.maximumHardConflictLeaks, 0);
  assert.equal(report.gateEvaluation.overallStatus, 'passed');
  assert.equal(report.gateEvaluation.sampleSize.status, 'passed');
  assert.deepEqual(report.gateEvaluation.sampleSize.actual, { matchPairs: 30, nonMatchPairs: 60 });
  assert.deepEqual(report.gateEvaluation.sampleSize.required, { matchPairs: 30, nonMatchPairs: 60 });
  assert.equal(report.gateEvaluation.partitions.development.suspectRecallAtK.status, 'passed');
  assert.equal(report.gateEvaluation.partitions.holdout.suspectRecallAtK.status, 'passed');
  assert.equal(report.gateEvaluation.reviewPairsPerThousand.status, 'passed');
  assert.equal(report.gateEvaluation.hardConflictLeaks.status, 'passed');
  assert.ok(report.metrics.holdout.recallAtKConfidence95.lower < 1);
  assert.equal(report.metrics.holdout.recallAtKConfidence95.upper, 1);
  assert.deepEqual(report.metrics.holdout.budgetTruncationMisses, []);
  assert.ok(Object.values(report.metrics.holdout.routeRemovalMisses).every(ids => Array.isArray(ids)));
  assert.ok(report.routeFirstContribution.familyProduct >= 0);
  assert.ok(report.metrics.holdout.routeFirstContribution.characterNgram >= 0);
});

test('quality evaluation isolates development and holdout audit candidates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'duplicate-partition-isolation-'));
  try {
    const gates = await loadDuplicateQualityGates();
    const sharedPair = (prefix: string, partition: 'development' | 'holdout') => ({
      id: `${prefix}-outlook`,
      partition,
      label: 'match' as const,
      source: 'partition-isolation-regression',
      confirmedAlias: false,
      hardConflictReason: null,
      left: { id: `${prefix}-left`, family: `${prefix}-vendor`, product: 'outlook', tier: 'mailbox' },
      right: { id: `${prefix}-right`, family: `${prefix}-vendor`, product: 'outlok', tier: 'mailbox' },
    });
    const partitionedFixture = {
      version: 'partition-isolation-v1',
      truthGroups: [
        { id: 'development-outlook', members: ['development-left', 'development-right'] },
        { id: 'holdout-outlook', members: ['holdout-left', 'holdout-right'] },
      ],
      pairs: [sharedPair('development', 'development'), sharedPair('holdout', 'holdout')],
    };
    const fixtureUrl = pathToFileURL(join(directory, 'fixture.json'));
    const gatesUrl = pathToFileURL(join(directory, 'gates.json'));
    await writeFile(fixtureUrl, JSON.stringify(partitionedFixture), 'utf8');
    await writeFile(gatesUrl, JSON.stringify({
      ...gates,
      fixtureVersion: partitionedFixture.version,
      minimumHoldoutMatchPairs: 1,
      minimumHoldoutNonMatchPairs: 1,
    }), 'utf8');

    const report = await buildDuplicateAuditReport({ fixtureUrl, qualityGatesUrl: gatesUrl });

    assert.equal(report.suspectedPairCount, 2);
    assert.equal(report.metrics.development.expectedManualReviewPairs, 1);
    assert.equal(report.metrics.holdout.expectedManualReviewPairs, 1);
    assert.equal(report.gateEvaluation.reviewPairsPerThousand.actual, 500);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('quality evaluation rejects emitted suspect pairs without labels', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'duplicate-unlabeled-suspect-'));
  try {
    const incomplete = structuredClone(fixture);
    incomplete.pairs = incomplete.pairs.filter(pair => pair.id !== 'dev-transitive-ab');
    const fixtureUrl = pathToFileURL(join(directory, 'fixture.json'));
    await writeFile(fixtureUrl, JSON.stringify(incomplete), 'utf8');

    await assert.rejects(
      buildDuplicateAuditReport({ fixtureUrl }),
      /unlabeled suspected pair.*sp-011.*sp-012/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('deterministic hard-conflict merges fail the zero-leak gate', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'duplicate-deterministic-leak-'));
  try {
    const leaked = structuredClone(fixture);
    const conflict = leaked.pairs.find(pair => pair.id === 'holdout-tier-conflict-001')!;
    conflict.right.tier = conflict.left.tier;
    const fixtureUrl = pathToFileURL(join(directory, 'fixture.json'));
    await writeFile(fixtureUrl, JSON.stringify(leaked), 'utf8');

    const report = await buildDuplicateAuditReport({ fixtureUrl });

    assert.equal(report.gateEvaluation.hardConflictLeaks.actual, 1);
    assert.equal(report.gateEvaluation.hardConflictLeaks.status, 'failed');
    assert.equal(report.gateEvaluation.overallStatus, 'blocked');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('budget truncation reports match pairs removed by top-k', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'duplicate-top-k-truncation-'));
  try {
    const gates = await loadDuplicateQualityGates();
    const products = [
      { id: 'tier-a', family: 'x', product: 'premium account', tier: 'basic' },
      { id: 'tier-b', family: 'twitter', product: 'premium account', tier: 'basic monthly' },
      { id: 'tier-c', family: 'twitter', product: 'premium account', tier: 'basic yearly' },
    ];
    const constrainedFixture = {
      version: 'top-k-truncation-v1',
      truthGroups: [{ id: 'tier-basic', members: products.map(product => product.id) }],
      pairs: [
        { id: 'tier-ab', partition: 'development', label: 'match', source: 'top-k-regression', confirmedAlias: false, hardConflictReason: null, left: products[0], right: products[1] },
        { id: 'tier-ac', partition: 'development', label: 'match', source: 'top-k-regression', confirmedAlias: false, hardConflictReason: null, left: products[0], right: products[2] },
        { id: 'tier-bc', partition: 'development', label: 'match', source: 'top-k-regression', confirmedAlias: false, hardConflictReason: null, left: products[1], right: products[2] },
      ],
    };
    const fixtureUrl = pathToFileURL(join(directory, 'fixture.json'));
    const gatesUrl = pathToFileURL(join(directory, 'gates.json'));
    await writeFile(fixtureUrl, JSON.stringify(constrainedFixture), 'utf8');
    await writeFile(gatesUrl, JSON.stringify({ ...gates, fixtureVersion: constrainedFixture.version, topK: 1 }), 'utf8');

    const report = await buildDuplicateAuditReport({ fixtureUrl, qualityGatesUrl: gatesUrl });

    assert.ok(report.metrics.development.budgetTruncationMisses.length > 0);
    assert.equal(report.gateEvaluation.budgetTruncationMisses.status, 'failed');
    assert.equal(report.gateEvaluation.overallStatus, 'blocked');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('quality evaluation rejects product ids shared across fixture partitions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'duplicate-partition-leak-'));
  try {
    const gates = await loadDuplicateQualityGates();
    const partitionedFixture = {
      version: 'partition-leak-v1',
      truthGroups: [],
      pairs: [
        {
          id: 'development-pair', partition: 'development', label: 'match', source: 'partition-regression', confirmedAlias: false, hardConflictReason: null,
          left: { id: 'shared-product', family: 'microsoft', product: 'outlook', tier: 'mailbox' },
          right: { id: 'development-right', family: 'microsoft', product: 'outlok', tier: 'mailbox' },
        },
        {
          id: 'holdout-pair', partition: 'holdout', label: 'match', source: 'partition-regression', confirmedAlias: false, hardConflictReason: null,
          left: { id: 'shared-product', family: 'microsoft', product: 'outlook', tier: 'mailbox' },
          right: { id: 'holdout-right', family: 'microsoft', product: 'outlook-mail', tier: 'mailbox' },
        },
      ],
    };
    const fixtureUrl = pathToFileURL(join(directory, 'fixture.json'));
    const gatesUrl = pathToFileURL(join(directory, 'gates.json'));
    await writeFile(fixtureUrl, JSON.stringify(partitionedFixture), 'utf8');
    await writeFile(gatesUrl, JSON.stringify({ ...gates, fixtureVersion: partitionedFixture.version }), 'utf8');

    await assert.rejects(
      buildDuplicateAuditReport({ fixtureUrl, qualityGatesUrl: gatesUrl }),
      /product id shared-product crosses fixture partitions/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('quality evaluation rejects inconsistent identities for one product id', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'duplicate-product-drift-'));
  try {
    const inconsistent = structuredClone(fixture);
    const repeated = inconsistent.pairs.find(pair => pair.id === 'dev-transitive-ac')!;
    repeated.left.product = 'different product';
    const fixtureUrl = pathToFileURL(join(directory, 'fixture.json'));
    await writeFile(fixtureUrl, JSON.stringify(inconsistent), 'utf8');

    await assert.rejects(
      buildDuplicateAuditReport({ fixtureUrl }),
      /product id sp-011 has inconsistent fixture identities/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('quality evaluation rejects conflicting labels for one pair', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'duplicate-pair-label-'));
  try {
    const inconsistent = structuredClone(fixture);
    const duplicate = structuredClone(inconsistent.pairs.find(pair => pair.id === 'dev-transitive-ab')!);
    duplicate.id = 'dev-transitive-ab-conflict';
    duplicate.label = 'non_match';
    inconsistent.pairs.push(duplicate);
    const fixtureUrl = pathToFileURL(join(directory, 'fixture.json'));
    await writeFile(fixtureUrl, JSON.stringify(inconsistent), 'utf8');

    await assert.rejects(
      buildDuplicateAuditReport({ fixtureUrl }),
      /pair sp-011.*sp-012 has conflicting fixture labels/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('quality evaluation rejects duplicate unordered pairs even when labels agree', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'duplicate-pair-key-'));
  try {
    const duplicated = structuredClone(fixture);
    const duplicate = structuredClone(duplicated.pairs.find(pair => pair.id === 'dev-transitive-ab')!);
    duplicate.id = 'dev-transitive-ab-duplicate';
    [duplicate.left, duplicate.right] = [duplicate.right, duplicate.left];
    duplicated.pairs.push(duplicate);
    const fixtureUrl = pathToFileURL(join(directory, 'fixture.json'));
    await writeFile(fixtureUrl, JSON.stringify(duplicated), 'utf8');

    await assert.rejects(
      buildDuplicateAuditReport({ fixtureUrl }),
      /duplicate fixture pair sp-011.*sp-012/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('quality evaluation rejects duplicate pair ids', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'duplicate-pair-id-'));
  try {
    const duplicated = structuredClone(fixture);
    duplicated.pairs[1]!.id = duplicated.pairs[0]!.id;
    const fixtureUrl = pathToFileURL(join(directory, 'fixture.json'));
    await writeFile(fixtureUrl, JSON.stringify(duplicated), 'utf8');

    await assert.rejects(
      buildDuplicateAuditReport({ fixtureUrl }),
      /duplicate fixture pair id /u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('quality evaluation validates fixture structure before auditing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'duplicate-fixture-shape-'));
  try {
    const malformed = {
      version: fixture.version,
      pairs: [{
        id: 'missing-identities',
        partition: 'holdout',
        label: 'match',
        confirmedAlias: false,
        hardConflictReason: null,
      }],
    };
    const fixtureUrl = pathToFileURL(join(directory, 'fixture.json'));
    await writeFile(fixtureUrl, JSON.stringify(malformed), 'utf8');

    await assert.rejects(
      buildDuplicateAuditReport({ fixtureUrl }),
      /invalid duplicate pair fixture pairs\[0\]\.left/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('quality evaluation refuses to score a truncated suspect page', async () => {
  await assert.rejects(
    buildDuplicateAuditReport({ maxReportedSuspectPairs: 1 }),
    /duplicate audit pagination is incomplete/u,
  );
});

test('deterministic merges of labeled non-matches fail independently of hard-conflict annotations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'duplicate-deterministic-false-merge-'));
  try {
    const leaked = structuredClone(fixture);
    const conflict = leaked.pairs.find(pair => pair.id === 'holdout-tier-conflict-001')!;
    conflict.right.family = conflict.left.family;
    conflict.right.product = conflict.left.product;
    conflict.right.tier = conflict.left.tier;
    conflict.hardConflictReason = null;
    const fixtureUrl = pathToFileURL(join(directory, 'fixture.json'));
    await writeFile(fixtureUrl, JSON.stringify(leaked), 'utf8');

    const report = await buildDuplicateAuditReport({ fixtureUrl });

    assert.equal(report.gateEvaluation.deterministicFalseMerges.actual, 1);
    assert.equal(report.gateEvaluation.deterministicFalseMerges.status, 'failed');
    assert.equal(report.gateEvaluation.overallStatus, 'blocked');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('quality evaluation rejects deterministic identities shared across partitions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'duplicate-canonical-partition-leak-'));
  try {
    const gates = await loadDuplicateQualityGates();
    const partitionedFixture = {
      version: 'canonical-partition-leak-v1',
      truthGroups: [],
      pairs: [
        {
          id: 'development-pair', partition: 'development', label: 'match', source: 'partition-regression', confirmedAlias: false, hardConflictReason: null,
          left: { id: 'development-left', family: 'OpenAI', product: 'ChatGPT', tier: 'Plus' },
          right: { id: 'development-right', family: 'openai', product: 'openai chatgpt', tier: 'chatgpt plus' },
        },
        {
          id: 'holdout-pair', partition: 'holdout', label: 'match', source: 'partition-regression', confirmedAlias: false, hardConflictReason: null,
          left: { id: 'holdout-left', family: 'OpenAI', product: 'ChatGPT', tier: 'Plus' },
          right: { id: 'holdout-right', family: 'openai', product: 'openai chatgpt', tier: 'chatgpt plus' },
        },
      ],
    };
    const fixtureUrl = pathToFileURL(join(directory, 'fixture.json'));
    const gatesUrl = pathToFileURL(join(directory, 'gates.json'));
    await writeFile(fixtureUrl, JSON.stringify(partitionedFixture), 'utf8');
    await writeFile(gatesUrl, JSON.stringify({ ...gates, fixtureVersion: partitionedFixture.version }), 'utf8');

    await assert.rejects(
      buildDuplicateAuditReport({ fixtureUrl, qualityGatesUrl: gatesUrl }),
      /canonical identity .* crosses fixture partitions/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('quality evaluation rejects truth groups shared across fixture partitions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'duplicate-truth-group-partition-leak-'));
  try {
    const gates = await loadDuplicateQualityGates();
    const partitionedFixture = {
      version: 'truth-group-partition-leak-v1',
      truthGroups: [{ id: 'outlook-account', members: ['development-left', 'development-right', 'holdout-left', 'holdout-right'] }],
      pairs: [
        {
          id: 'development-pair', partition: 'development', label: 'match', source: 'partition-regression', confirmedAlias: false, hardConflictReason: null,
          left: { id: 'development-left', family: 'microsoft', product: 'outlook', tier: 'mailbox' },
          right: { id: 'development-right', family: 'microsoft', product: 'outlok', tier: 'mailbox' },
        },
        {
          id: 'holdout-pair', partition: 'holdout', label: 'match', source: 'partition-regression', confirmedAlias: false, hardConflictReason: null,
          left: { id: 'holdout-left', family: 'microsoft', product: 'outlook email', tier: 'mailbox' },
          right: { id: 'holdout-right', family: 'microsoft', product: 'outlook-email', tier: 'mailbox' },
        },
      ],
    };
    const fixtureUrl = pathToFileURL(join(directory, 'fixture.json'));
    const gatesUrl = pathToFileURL(join(directory, 'gates.json'));
    await writeFile(fixtureUrl, JSON.stringify(partitionedFixture), 'utf8');
    await writeFile(gatesUrl, JSON.stringify({ ...gates, fixtureVersion: partitionedFixture.version }), 'utf8');

    await assert.rejects(
      buildDuplicateAuditReport({ fixtureUrl, qualityGatesUrl: gatesUrl }),
      /truth group outlook-account crosses fixture partitions/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('calibration output is unchanged when only holdout labels and products change', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'duplicate-calibration-'));
  try {
    const changed = structuredClone(fixture) as typeof fixture;
    for (const pair of changed.pairs.filter(pair => pair.partition === 'holdout')) {
      pair.label = pair.label === 'match' ? 'non_match' : 'match';
      pair.left.family = `changed-${pair.left.family}`;
      pair.right.product = `changed-${pair.right.product}`;
    }
    const changedUrl = pathToFileURL(join(directory, 'changed-holdout.json'));
    await writeFile(changedUrl, JSON.stringify(changed), 'utf8');

    assert.deepEqual(await calibrateDuplicateLinkage(changedUrl), await calibrateDuplicateLinkage());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('calibration check rejects policy, fixture, gate, and report version drift', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'duplicate-gates-'));
  try {
    const gates = await loadDuplicateQualityGates();
    const cases = [
      { name: 'policy', value: { ...gates, policyVersion: 'stale-policy' }, error: /quality gate policy version mismatch/u },
      { name: 'fixture', value: { ...gates, fixtureVersion: 'stale-fixture' }, error: /quality gate fixture version mismatch/u },
      { name: 'gate', value: { ...gates, version: 'stale-gate' }, error: /duplicate audit report 质量门槛 mismatch/u },
      { name: 'report', value: { ...gates, auditReportVersion: 'stale-report' }, error: /duplicate audit report 审计报告版本 mismatch/u },
    ];
    for (const item of cases) {
      const driftedUrl = pathToFileURL(join(directory, `${item.name}.json`));
      await writeFile(driftedUrl, JSON.stringify(item.value), 'utf8');
      await assert.rejects(checkDuplicateLinkageCalibration({ qualityGatesUrl: driftedUrl }), item.error);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

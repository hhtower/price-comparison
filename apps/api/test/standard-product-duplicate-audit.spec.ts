import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { auditStandardProductDuplicates, VersionedDuplicateAuditIndex } from '../src/standardization/duplicate-audit.js';
import { DUPLICATE_LINKAGE_POLICY } from '../src/standardization/duplicate-linkage-policy.js';
import { classifyDuplicatePair, extractDuplicateFeatures } from '../src/standardization/duplicate-linkage.js';

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

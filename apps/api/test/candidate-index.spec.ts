import test from 'node:test';
import assert from 'node:assert/strict';
import { BoundedCandidateIndex, type CandidateDocument } from '../src/standardization/candidate-index.js';
import { buildCanonicalStandardKey } from '../src/standardization/canonical-key.js';
import { VersionedCandidateIndex, type CatalogIndexChange } from '../src/standardization/versioned-candidate-index.js';
import * as batching from '../src/ai/adaptive-batching.js';

test('Grok inventory evidence prioritizes its canonical account over mirrors and source JSON keys', () => {
  assert.equal(typeof batching.buildCandidateSearchQuery, 'function');
  const query = batching.buildCandidateSearchQuery({ id: '1', name: 'gro普号(库存)', spec: '',
    sourceData: { category: { id: 100, name: 'gro' }, user: { nickname: 'software' },
      evidence: '清库存，有一些可用build，有的只能console和web' } });
  assert.doesNotMatch(query.text, /sourceData|nickname|software|100/);
  const target = { id: '999', family: 'xai', product: 'grok', tier: 'free', aliases: [] };
  const index = new BoundedCandidateIndex([target, ...Array.from({ length: 30 }, (_, i) => ({
    id: String(i + 1), family: 'software', product: `grok_web_mirror_${i}`, tier: 'standard', aliases: [],
  }))], { maxScanned: 10, maxCompared: 1, topK: 1 });
  const result = index.search(query);
  assert.equal(result.candidates[0]?.id, target.id);
  assert.ok(result.candidates[0]?.routes.includes('canonical'));
  assert.equal(batching.buildCandidateSearchQuery({ name: 'gro普号 / SuperGrok会员' }).canonicalKey, undefined);
});

const documents: CandidateDocument[] = [
  { id: '1', family: 'openai', product: 'chatgpt', tier: 'plus', aliases: ['OpenAI Chat GPT Plus', 'GPT Plus'] },
  { id: '2', family: 'openai', product: 'chatgpt', tier: 'pro', aliases: ['ChatGPT Pro'] },
  { id: '3', family: 'microsoft', product: 'outlook', tier: 'email_account', aliases: ['微软 Outlook 邮箱账号'] },
  { id: '4', family: 'x', product: 'x', tier: 'premium', aliases: ['Twitter Blue', 'X Premium'] },
];

test('candidate index prioritizes canonical keys and confirmed aliases without merging identities', () => {
  const index = new BoundedCandidateIndex(documents);
  const exact = index.search({ canonicalKey: buildCanonicalStandardKey(documents[0]!), text: 'unrelated text' });
  assert.equal(exact.candidates[0]?.id, '1');
  assert.equal(exact.candidates[0]?.routes.includes('canonical'), true);

  const alias = index.search({ text: 'GPT Plus one month shared' });
  assert.equal(alias.candidates[0]?.id, '1');
  assert.equal(alias.candidates[0]?.routes.includes('alias'), true);
  assert.equal(alias.candidates.some((candidate) => candidate.id === '2'), false);
});

test('token and character n-gram routes recall mixed-language and unknown-brand evidence', () => {
  const index = new BoundedCandidateIndex(documents);
  assert.equal(index.search({ text: '微软outlook邮箱帐号一年' }).candidates[0]?.id, '3');
  assert.equal(index.search({ text: '推特 TwitterBlue 高级会员' }).candidates[0]?.id, '4');
});

test('candidate search enforces posting, scan, comparison and top-k bounds', () => {
  const common = Array.from({ length: 10_000 }, (_, index): CandidateDocument => ({
    id: String(index + 1), family: `brand-${index}`, product: `product-${index}`, tier: 'common', aliases: [`common service ${index}`],
  }));
  const index = new BoundedCandidateIndex(common, { maxPostingsPerFeature: 32, maxScanned: 64, maxCompared: 40, topK: 8, maxIndexBytes: 8_000_000 });
  const result = index.search({ text: 'common service unknown-brand' });
  assert.ok(result.stats.scanned <= 64);
  assert.ok(result.stats.compared <= 40);
  assert.ok(result.candidates.length <= 8);
  assert.equal(result.stats.truncated, true);
  assert.ok(result.stats.indexBytes <= 8_000_000);
});

test('confirmed aliases must map to exactly one catalog identity', () => {
  assert.throws(() => new BoundedCandidateIndex([
    documents[0]!,
    { ...documents[1]!, aliases: [...documents[1]!.aliases, 'GPT Plus'] },
  ]), /ambiguous confirmed alias/i);
});

test('exact canonical and confirmed-alias routes survive tight comparison limits', () => {
  const common = Array.from({ length: 100 }, (_, index): CandidateDocument => ({
    id: String(index + 1).padStart(3, '0'), family: `brand-${index}`, product: `product-${index}`, tier: 'common', aliases: [`common service ${index}`],
  }));
  common.push({ id: '999', family: 'acme', product: 'unique', tier: 'premium', aliases: ['Unique Plan'] });
  const index = new BoundedCandidateIndex(common, { maxPostingsPerFeature: 100, maxScanned: 100, maxCompared: 1, topK: 1 });

  assert.equal(index.search({ text: 'common', canonicalKey: buildCanonicalStandardKey(common.at(-1)!) }).candidates[0]?.id, '999');
  const alias = index.search({ text: 'common Unique Plan one month' });
  assert.equal(alias.candidates[0]?.id, '999');
  assert.equal(alias.candidates[0]?.routes.includes('alias'), true);
  assert.ok(alias.stats.compared <= 1);
});

test('unrelated queries do not fall back to scanning the catalog', () => {
  const index = new BoundedCandidateIndex(documents);
  const result = index.search({ text: '完全无关的随机条目 zzyyqq' });

  assert.deepEqual(result.candidates, []);
  assert.equal(result.stats.scanned, 0);
  assert.equal(result.stats.compared, 0);
});

test('candidate ordering and statistics are stable across source ordering', () => {
  const options = { maxPostingsPerFeature: 32, maxScanned: 64, maxCompared: 40, topK: 8, maxIndexBytes: 1_000_000 };
  const forward = new BoundedCandidateIndex(documents, options).search({ text: '微软 outlook 邮箱帐号' });
  const reversed = new BoundedCandidateIndex([...documents].reverse(), options).search({ text: '微软 outlook 邮箱帐号' });

  assert.deepEqual(reversed, forward);
});

test('1k, 5k and 10k catalogs keep retrieval work and index memory bounded', () => {
  for (const size of [1_000, 5_000, 10_000]) {
    const fixture = Array.from({ length: size }, (_, index): CandidateDocument => ({
      id: String(index + 1).padStart(5, '0'),
      family: `vendor-${index}`,
      product: `service-${index}`,
      tier: index % 2 ? 'pro' : 'basic',
      aliases: [`Vendor ${index} Service ${index} ${index % 2 ? 'Pro' : 'Basic'}`],
    }));
    const maxIndexBytes = 2_000_000;
    const result = new BoundedCandidateIndex(fixture, {
      maxPostingsPerFeature: 64,
      maxScanned: 96,
      maxCompared: 48,
      topK: 10,
      maxIndexBytes,
    }).search({ text: `vendor-${size - 1} service-${size - 1} pro` });

    assert.ok(result.stats.scanned <= 96, `${size}: scanned`);
    assert.ok(result.stats.compared <= 48, `${size}: compared`);
    assert.ok(result.candidates.length <= 10, `${size}: topK`);
    assert.ok(result.stats.indexBytes <= maxIndexBytes, `${size}: indexBytes`);
  }
});

test('tight memory budgets degrade every auxiliary index explicitly', () => {
  const fixture = Array.from({ length: 100 }, (_, index): CandidateDocument => ({
    id: String(index + 1).padStart(3, '0'),
    family: `vendor-${index}`,
    product: `service-${index}`,
    tier: 'premium',
    aliases: [`Vendor ${index} Premium Service`],
  }));
  const maxIndexBytes = 512;
  const result = new BoundedCandidateIndex(fixture, { maxIndexBytes }).search({
    canonicalKey: buildCanonicalStandardKey(fixture.at(-1)!),
    text: 'Vendor 99 Premium Service',
  });

  assert.ok(result.stats.indexBytes <= maxIndexBytes);
  assert.ok(result.stats.indexedCanonicalKeys < fixture.length);
  assert.ok(result.stats.indexedAliases < fixture.length);
  assert.equal(result.stats.truncated, true);
});

test('short aliases do not match arbitrary substrings', () => {
  const index = new BoundedCandidateIndex([
    { id: '1', family: 'x', product: 'x', tier: 'basic', aliases: ['X'] },
  ]);

  assert.deepEqual(index.search({ text: 'Netflix subscription' }).candidates, []);
});

test('versioned candidate index matches a same-version full rebuild after add, update, isolate and delete', () => {
  const options = { maxPostingsPerFeature: 32, maxScanned: 64, maxCompared: 40, topK: 8, maxIndexBytes: 1_000_000 };
  const queries = [
    { text: 'GPT Plus one month', canonicalKey: buildCanonicalStandardKey(documents[0]!) },
    { text: 'ChatGPT enterprise organization' },
    { text: '微软 outlook 邮箱帐号' },
    { text: 'Claude Team annual' },
  ];
  let current = [...documents];
  const index = VersionedCandidateIndex.build({
    version: 1n,
    aliasPolicyVersion: 'aliases-v1',
    documents: current,
  }, options);
  const assertEquivalent = () => {
    const rebuilt = new BoundedCandidateIndex(current, options);
    for (const query of queries) assert.deepEqual(index.search(query), rebuilt.search(query));
  };

  assertEquivalent();
  const added: CandidateDocument = { id: '5', family: 'anthropic', product: 'claude', tier: 'team', aliases: ['Claude Team'] };
  let applied = index.applyChanges([{ version: 2n, standardProductId: '5', operation: 'upsert', document: added }], 2n);
  current = [...current, added];
  assert.deepEqual({
    version: applied.version,
    ready: applied.targetVersionReady,
    processed: applied.processedChangeCount,
    rebuilt: applied.rebuiltDocumentCount,
    delta: applied.deltaDocumentCount,
    tombstones: applied.tombstoneCount,
  }, { version: 2n, ready: true, processed: 1, rebuilt: 1, delta: 1, tombstones: 0 });
  assertEquivalent();

  const updated: CandidateDocument = { ...documents[1]!, tier: 'enterprise', aliases: ['ChatGPT Enterprise'] };
  applied = index.applyChanges([{ version: 3n, standardProductId: '2', operation: 'upsert', document: updated }], 3n);
  current = current.map(document => document.id === '2' ? updated : document);
  assert.equal(applied.rebuiltDocumentCount, 2);
  assertEquivalent();

  applied = index.applyChanges([{ version: 4n, standardProductId: '1', operation: 'isolate' }], 4n);
  current = current.filter(document => document.id !== '1');
  assert.equal(applied.tombstoneCount, 1);
  assertEquivalent();

  applied = index.applyChanges([{ version: 5n, standardProductId: '3', operation: 'delete' }], 5n);
  current = current.filter(document => document.id !== '3');
  assert.equal(applied.tombstoneCount, 2);
  assertEquivalent();
});

test('one-percent catalog refresh processes only changed documents before compaction thresholds', () => {
  const fixture = Array.from({ length: 1_000 }, (_, item): CandidateDocument => ({
    id: String(item + 1).padStart(4, '0'),
    family: `v${item}x`,
    product: `p${item}y`,
    tier: `t${item}z`,
    aliases: [`a${item}b`],
  }));
  const changes: CatalogIndexChange[] = fixture.slice(0, 10).map((document, item) => ({
    version: 2n,
    standardProductId: document.id,
    operation: 'upsert',
    document: { ...document, tier: `u${item}z`, aliases: [`c${item}d`] },
  }));
  const options = { maxPostingsPerFeature: 2_000 };
  const index = VersionedCandidateIndex.build({ version: 1n, aliasPolicyVersion: 'aliases-v1', documents: fixture }, options);

  const applied = index.applyChanges(changes, 2n);

  assert.equal(applied.targetVersionReady, true);
  assert.equal(applied.processedChangeCount, 10);
  assert.equal(applied.rebuiltDocumentCount, 10);
  assert.equal(applied.deltaDocumentCount, 10);
  assert.equal(applied.baseDocumentCount, 1_000);
  assert.deepEqual(index.needsCompaction(), { required: false, blocksReady: false, reasons: [] });
  const refreshed = [...changes.map(change => change.document!), ...fixture.slice(10)];
  assert.deepEqual(
    index.search({ text: 'v4x p4y u4z' }),
    new BoundedCandidateIndex(refreshed, options).search({ text: 'v4x p4y u4z' }),
  );
});

test('version gaps, out-of-order changes and alias-policy changes require a blocking compaction', () => {
  const change: CatalogIndexChange = {
    version: 3n,
    standardProductId: documents[0]!.id,
    operation: 'upsert',
    document: { ...documents[0]!, tier: 'team' },
  };
  const gap = VersionedCandidateIndex.build({ version: 1n, aliasPolicyVersion: 'aliases-v1', documents });
  const gapResult = gap.applyChanges([change], 3n);
  assert.equal(gapResult.targetVersionReady, false);
  assert.equal(gapResult.version, 1n);
  assert.deepEqual(gap.needsCompaction(), { required: true, blocksReady: true, reasons: ['version_gap'] });

  const outOfOrder = VersionedCandidateIndex.build({ version: 1n, aliasPolicyVersion: 'aliases-v1', documents });
  outOfOrder.applyChanges([
    change,
    { ...change, version: 2n },
  ], 3n);
  assert.deepEqual(outOfOrder.needsCompaction(), { required: true, blocksReady: true, reasons: ['version_out_of_order'] });

  const policy = VersionedCandidateIndex.build({ version: 1n, aliasPolicyVersion: 'aliases-v1', documents });
  policy.applyChanges([{ ...change, version: 2n }], 2n, { aliasPolicyVersion: 'aliases-v2' });
  assert.deepEqual(policy.needsCompaction(), { required: true, blocksReady: true, reasons: ['alias_policy_version_changed'] });
});

test('changes touching truncated base features block the target version until full compaction', () => {
  const common = Array.from({ length: 10 }, (_, item): CandidateDocument => ({
    id: String(item + 1).padStart(2, '0'),
    family: `vendor-${item}`,
    product: `service-${item}`,
    tier: 'common',
    aliases: [],
  }));
  const index = VersionedCandidateIndex.build(
    { version: 1n, aliasPolicyVersion: 'aliases-v1', documents: common },
    { maxPostingsPerFeature: 2 },
  );
  const result = index.applyChanges([{
    version: 2n,
    standardProductId: '01',
    operation: 'upsert',
    document: { ...common[0]!, tier: 'replacement-tier' },
  }], 2n);

  assert.equal(result.targetVersionReady, false);
  assert.equal(result.version, 1n);
  assert.deepEqual(index.needsCompaction(), { required: true, blocksReady: true, reasons: ['truncated_feature_touched'] });
});

test('changes preserving truncated base features remain eligible for delta refresh', () => {
  const catalog = Array.from({ length: 300 }, (_, item): CandidateDocument => ({
    id: String(item + 1).padStart(3, '0'),
    family: 'shared-vendor',
    product: `service-${item}`,
    tier: `tier-${item}`,
    aliases: [],
  }));
  const index = VersionedCandidateIndex.build(
    { version: 1n, aliasPolicyVersion: 'aliases-v1', documents: catalog },
    { maxPostingsPerFeature: 256 },
  );
  const updated = { ...catalog[0]!, tier: 'replacement-tier' };

  const result = index.applyChanges([{
    version: 2n,
    standardProductId: updated.id,
    operation: 'upsert',
    document: updated,
  }], 2n);

  assert.equal(result.targetVersionReady, true);
  assert.equal(result.processedChangeCount, 1);
  assert.deepEqual(index.needsCompaction(), { required: false, blocksReady: false, reasons: [] });
  assert.deepEqual(index.getDocument(updated.id), updated);
});

test('a blocked target version leaves the current searchable index unchanged', () => {
  const index = VersionedCandidateIndex.build(
    { version: 1n, aliasPolicyVersion: 'aliases-v1', documents },
    { maxPostingsPerFeature: 32 },
  );
  const before = index.search({ text: 'GPT Plus one month' });
  const beforeDocument = index.getDocument('1');

  const result = index.applyChanges([{
    version: 3n,
    standardProductId: '1',
    operation: 'upsert',
    document: { ...documents[0]!, tier: 'team', aliases: ['ChatGPT Team'] },
  }], 3n);

  assert.equal(result.targetVersionReady, false);
  assert.equal(index.version, 1n);
  assert.deepEqual(index.getDocument('1'), beforeDocument);
  assert.deepEqual(index.search({ text: 'GPT Plus one month' }), before);
  assert.equal(result.deltaDocumentCount, 0);
  assert.equal(result.tombstoneCount, 0);
});

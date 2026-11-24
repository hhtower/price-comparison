import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMembershipFeatures, readCurrentMembershipFeatures } from '../src/standardization/membership-classification.js';

const product = { content_version: 2n, content_fingerprint: 'current', standardization_revision: 3n,
  shop_url: 'https://source.invalid', shop_protocol: null, shop_platform: 'test' };
const tags = [{ name: 'delivery', value: 'account' }, { name: 'warranty_days', value: '28' }];

test('approved feature snapshot is bound to current evidence and revision', () => {
  const snapshot = buildMembershipFeatures(tags, product, [], 'account');
  assert.equal(readCurrentMembershipFeatures(snapshot, product)?.decision.kind, 'account');
  assert.equal(readCurrentMembershipFeatures(snapshot, { ...product, content_version: 3n }), null);
  assert.equal(readCurrentMembershipFeatures(snapshot, { ...product, content_fingerprint: 'changed' }), null);
  assert.equal(readCurrentMembershipFeatures(snapshot, { ...product, standardization_revision: 4n }), null);
  assert.equal(readCurrentMembershipFeatures({ ...snapshot, policyVersion: 'old' }, product), null);
});

test('source binding is required and cannot be bypassed by old snapshots or incomplete callers', () => {
  const snapshot = buildMembershipFeatures([], product, [], 'account');
  const { source: _source, ...withoutSource } = snapshot;
  assert.equal(readCurrentMembershipFeatures(withoutSource, product), null);
  assert.equal(readCurrentMembershipFeatures(snapshot, { ...product, shop_url: 'https://replacement.invalid' }), null);
  const incomplete = { ...product, shop_url: undefined } as never;
  assert.equal(readCurrentMembershipFeatures(snapshot, incomplete), null);
  assert.throws(() => buildMembershipFeatures([], incomplete, [], 'account'), /source/i);
});
test('feature snapshots preserve every explicit LLM kind without rule inference', () => {
  for (const kind of ['account', 'top_up', 'top_up_half_price', 'rental', 'short_term'] as const) {
    for (const facts of [[], tags, [...tags, { name: 'access', value: 'shared' }]]) {
      const snapshot = buildMembershipFeatures(facts, product, ['warranty_days', 'access'], kind);
      assert.equal(snapshot.decision.kind, kind);
      assert.equal(snapshot.decision.reason, 'llm_reviewed');
      assert.deepEqual(snapshot.rejectedNames, ['warranty_days', 'access']);
      assert.equal(readCurrentMembershipFeatures(snapshot, product)?.decision.kind, kind);
    }
  }
});

test('feature construction rejects missing or invalid LLM kind instead of inferring from tags', () => {
  for (const kind of [undefined, null, '', 'unknown', 'unclassified']) {
    assert.throws(() => buildMembershipFeatures(tags, product, [], kind as never));
  }
});

test('feature snapshots retain approved evidence without deriving classification metadata from duration', () => {
  const facts = [{ name: 'duration_days', value: '7', evidence: [{ path: 'name', quote: '7天' }] }];
  const snapshot = buildMembershipFeatures(facts, product, [], 'rental');
  assert.deepEqual(snapshot.decision, { kind: 'rental', reason: 'llm_reviewed' });
  assert.deepEqual(snapshot.tags, [{ name: 'duration_days', value: '7' }]);
  assert.deepEqual(snapshot.evidence, [{ name: 'duration_days', value: '7', path: 'name', quote: '7天' }]);
  assert.equal(readCurrentMembershipFeatures({ ...snapshot, decision: { ...snapshot.decision, kind: 'unknown' } }, product), null);
});

test('classification decisions accept only the current kind and review reason fields', () => {
  const snapshot = buildMembershipFeatures([], product, [], 'short_term');
  assert.deepEqual(snapshot.decision, { kind: 'short_term', reason: 'llm_reviewed' });
  assert.deepEqual(snapshot.tags, []);
  assert.deepEqual(snapshot.evidence, []);
  for (const extra of [
    { durationSource: 'default' }, { durationSource: 'explicit' }, { requiredWarrantyDays: 28 }, { unknown: true },
  ]) assert.equal(readCurrentMembershipFeatures({ ...snapshot, decision: { ...snapshot.decision, ...extra } }, product), null);
});

test('legacy top-up snapshots require eligibility review while other feature snapshots remain current', () => {
  const snapshot = buildMembershipFeatures([], product, [], 'top_up');
  const legacy = { ...snapshot };
  delete legacy.topUpPolicyVersion;
  assert.equal(readCurrentMembershipFeatures(legacy, product), null);
  assert.equal(readCurrentMembershipFeatures(snapshot, product)?.decision.kind, 'top_up');
  assert.equal(readCurrentMembershipFeatures({ ...snapshot, topUpPolicyVersion: 'old' }, product), null);
  assert.equal(readCurrentMembershipFeatures(buildMembershipFeatures([], product, [], 'account'), product)?.decision.kind, 'account');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMembershipFeatures, readCurrentMembershipFeatures } from '../src/standardization/membership-classification.js';

const product = { content_version: 2n, content_fingerprint: 'current', standardization_revision: 3n };
const tags = [{ name: 'delivery', value: 'account' }, { name: 'warranty_days', value: '28' }];

test('approved feature snapshot is bound to current evidence and revision', () => {
  const snapshot = buildMembershipFeatures(tags, product, [], 'account');
  assert.equal(readCurrentMembershipFeatures(snapshot, product)?.decision.kind, 'account');
  assert.equal(readCurrentMembershipFeatures(snapshot, { ...product, content_version: 3n }), null);
  assert.equal(readCurrentMembershipFeatures(snapshot, { ...product, content_fingerprint: 'changed' }), null);
  assert.equal(readCurrentMembershipFeatures(snapshot, { ...product, standardization_revision: 4n }), null);
  assert.equal(readCurrentMembershipFeatures({ ...snapshot, policyVersion: 'old' }, product), null);
});

test('feature snapshots preserve every explicit LLM kind without rule inference', () => {
  for (const kind of ['account', 'top_up', 'rental', 'short_term'] as const) {
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

test('feature snapshots retain approved evidence and explicit duration', () => {
  const facts = [{ name: 'duration_days', value: '7', evidence: [{ path: 'name', quote: '7天' }] }];
  const snapshot = buildMembershipFeatures(facts, product, [], 'rental');
  assert.equal(snapshot.decision.durationSource, 'explicit');
  assert.deepEqual(snapshot.tags, [{ name: 'duration_days', value: '7' }]);
  assert.deepEqual(snapshot.evidence, [{ name: 'duration_days', value: '7', path: 'name', quote: '7天' }]);
  assert.equal(readCurrentMembershipFeatures({ ...snapshot, decision: { ...snapshot.decision, kind: 'unknown' } }, product), null);
});

test('classification-only snapshots do not invent duration or warranty metadata and keep legacy snapshots readable', () => {
  const snapshot = buildMembershipFeatures([], product, [], 'short_term');
  assert.deepEqual(snapshot.decision, { kind: 'short_term', reason: 'llm_reviewed' });
  assert.deepEqual(snapshot.tags, []);
  assert.deepEqual(snapshot.evidence, []);
  const legacy = { ...snapshot, tags, decision: { ...snapshot.decision, durationSource: 'default', requiredWarrantyDays: null } };
  assert.deepEqual(readCurrentMembershipFeatures(legacy, product), legacy);
});

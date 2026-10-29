import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planPublicationUnits, type PublicationMember } from '../src/ai/publication-planner.js';

const member = (productId: number, tags: number[] = [], payload: unknown = { productId, value: 'x' }): PublicationMember => ({
  productId: BigInt(productId), inputId: BigInt(productId), tags: tags.map(index => ({ name: `tag-${index}`, value: 'v' })), payload,
});

test('orders members by product ID and splits by member count', () => {
  const result = planPublicationUnits([member(3), member(1), member(2)], { maxMembers: 2, maxTagRows: 100, maxPayloadBytes: 10_000, maxSqlParameters: 100 });
  assert.deepEqual(result.units.map(unit => unit.productIds.map(String)), [['1', '2'], ['3']]);
});

test('splits before a member that would exceed tag rows, bytes, or SQL parameters', () => {
  const result = planPublicationUnits([member(1, [1, 2]), member(2, [3]), member(3, [4])], { maxMembers: 10, maxTagRows: 2, maxPayloadBytes: 10_000, maxSqlParameters: 100 });
  assert.deepEqual(result.units.map(unit => unit.productIds.map(String)), [['1'], ['2', '3']]);
  assert.deepEqual(result.units.map(unit => unit.tagCount), [2, 2]);

  const bytes = planPublicationUnits([member(1, [], 'a'.repeat(20)), member(2, [], 'b'.repeat(20))], { maxMembers: 10, maxTagRows: 100, maxPayloadBytes: 25, maxSqlParameters: 100 });
  assert.deepEqual(bytes.units.map(unit => unit.productIds.map(String)), [['1'], ['2']]);

  const params = planPublicationUnits([member(1, [1, 2]), member(2)], { maxMembers: 10, maxTagRows: 100, maxPayloadBytes: 10_000, maxSqlParameters: 12 });
  assert.deepEqual(params.units.map(unit => unit.productIds.map(String)), [['1'], ['2']]);
});

test('marks a single member that cannot fit any unit as publication_too_large', () => {
  const result = planPublicationUnits([member(1, [1, 2, 3, 4])], { maxMembers: 10, maxTagRows: 2, maxPayloadBytes: 10_000, maxSqlParameters: 100 });
  assert.deepEqual(result.units, []);
  assert.deepEqual(result.oversizedProductIds.map(String), ['1']);
});

test('returns a stable plan and hash independent of input order', () => {
  const limits = { maxMembers: 2, maxTagRows: 100, maxPayloadBytes: 10_000, maxSqlParameters: 100 } as const;
  const one = planPublicationUnits([member(4), member(2), member(3)], limits);
  const two = planPublicationUnits([member(3), member(4), member(2)], limits);
  assert.deepEqual(two.units, one.units);
  assert.equal(two.planHash, one.planHash);
});

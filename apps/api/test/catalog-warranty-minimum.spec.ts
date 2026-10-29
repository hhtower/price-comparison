import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCatalogQuery } from '../src/catalog/catalog.service.ts';

test('minimum warranty intent does not also require an exact number of warranty days', () => {
  const query = normalizeCatalogQuery({ q: 'ChatGPT 质保至少30天' });
  assert.equal(query.warrantyDaysMin, 30);
  assert.deepEqual(new Set(query.tags.map(tag => tag.name + ':' + tag.value)), new Set(['warranty:covered', 'warranty_scope:period']));
  assert.equal(query.search, 'chatgpt');
});

test('an explicit warranty minimum overrides the inferred minimum without retaining its exact-day tag', () => {
  const query = normalizeCatalogQuery({ q: 'ChatGPT 质保至少30天', warrantyDaysMin: 90 });
  assert.equal(query.warrantyDaysMin, 90);
  assert.ok(query.tags.every(tag => tag.name !== 'warranty_days'));
});

test('explicit exact-day API filters remain supported and are not silently changed to minimums', () => {
  const query = normalizeCatalogQuery({ tag: [{ name: 'warranty_days', value: '30' }] });
  assert.deepEqual(query.tags, [{ name: 'warranty_days', value: '30' }]);
  assert.equal(query.warrantyDaysMin, undefined);
});

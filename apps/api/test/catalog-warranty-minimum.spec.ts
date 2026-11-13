import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCatalogQuery } from '../src/catalog/catalog.service.ts';

test('removed warranty minimum inputs fail explicitly, including empty and malformed values', () => {
  for (const warrantyDaysMin of [30, 0, '', null, undefined, '30']) {
    assert.throws(() => normalizeCatalogQuery({ warrantyDaysMin } as never), { code: 'INVALID_FILTER' });
  }
  for (const name of ['warranty_days', 'access', 'delivery', 'payment_region']) {
    assert.throws(() => normalizeCatalogQuery({ tags: [{ name, value: '30' }] }), { code: 'INVALID_FILTER' });
  }
});

test('typed duration filters preserve exact, range and qualified days and deduplicate objects', () => {
  const values = [30, 0.5, { kind: 'range', min: 30, max: 90 }, { kind: 'min', days: 30 }, { kind: 'permanent' }];
  for (const value of values) {
    assert.deepEqual(normalizeCatalogQuery({ tags: [
      { name: 'duration', value }, { name: 'duration', value: structuredClone(value) },
    ] } as never).tags, [{ name: 'duration', value }]);
  }
  for (const value of ['30', '1 month', 0, -1, Infinity, { kind: 'range', min: 90, max: 30 }]) {
    assert.throws(() => normalizeCatalogQuery({ tags: [{ name: 'duration', value }] } as never), { code: 'INVALID_FILTER' });
  }
});

test('membership query parsing no longer relies on removed tags', () => {
  for (const [q, kind] of [['成品号', 'account'], ['成品账号', 'account'], ['现成账号', 'account'],
    ['Ready Account', 'account'], ['代充', 'top_up'], ['top-up', 'top_up'], ['共享', 'rental'], ['shared access', 'rental'],
    ['短期', 'short_term']]) {
    const query = normalizeCatalogQuery({ q });
    assert.deepEqual(query.membershipSearch?.kinds, [kind]);
    assert.deepEqual(query.tags, []);
  }
});

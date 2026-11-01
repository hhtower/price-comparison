import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeShopObservation, readShopRating } from '../src/shops/shop-rating.js';

test('observations retain their score until inputs change, while future and mismatched evidence is rejected', () => {
  const source = { url: 'https://score.invalid', protocol: 'dujiaoka' };
  const state = mergeShopObservation(null, source, { deposit: null, volume: 1000,
    observedAt: new Date(1000).toISOString(), counterDefinition: 'count' }, 1000);
  const first = readShopRating(state, source, 1000);
  assert.equal(first.score, '15.00');
  assert.equal(first.nextExpiryAt, null);
  assert.deepEqual(readShopRating(state, source, 1000 + 30 * 86_400_000), first);
  assert.equal(readShopRating(state, source, 999).score, null);
  assert.equal(readShopRating(state, { ...source, url: 'https://changed.invalid' }, 1000).score, null);
});

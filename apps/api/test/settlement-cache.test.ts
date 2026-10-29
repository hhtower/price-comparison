import assert from 'node:assert/strict';
import test from 'node:test';
import { needsSettlementRefresh, type SettlementBaseline } from '../src/crawler/settlement-cache.js';

const now = Date.parse('2026-10-04T12:00:00.000Z');
const ttl = 8_100_000;
const item = { externalId: 'one', name: 'Plus', spec: 'monthly', sourceData: { category: 'AI' }, price: 10, url: 'https://example.test', inStock: true };
const previous: SettlementBaseline = {
  name: 'Plus', spec: 'monthly', source_category: '', source_data: { category: 'AI' },
  price: '10.00', is_stale: false, settlement_price: '10.30',
  settlement_verified_at: new Date(now - 3_600_000), settlement_payment_method: 'Alipay',
};
const refresh = (candidate = item, baseline: SettlementBaseline | undefined = previous) =>
  needsSettlementRefresh(candidate, baseline, now, ttl);

test('reuses an unchanged quote until its actual expiry without renewing verification', () => {
  assert.equal(refresh(), false);
  assert.equal(refresh(item, { ...previous, settlement_verified_at: new Date(now - 4_500_000) }), false);
  assert.equal(refresh(item, { ...previous, settlement_verified_at: new Date(now - ttl + 1) }), false);
  assert.equal(refresh(item, { ...previous, settlement_verified_at: new Date(now - ttl) }), true);
  assert.equal(previous.settlement_verified_at?.getTime(), now - 3_600_000);
});

test('rechecks changed prices and missing quotes but not ordinary evidence changes', () => {
  assert.equal(refresh({ ...item, price: 11 }), true);
  assert.equal(refresh({ ...item, name: 'Pro', sourceData: { category: 'updated' } }), false);
  assert.equal(refresh(item, { ...previous, settlement_price: null }), true);
  assert.equal(refresh(item, { ...previous, is_stale: true }), true);
  assert.equal(needsSettlementRefresh(item, undefined, now, ttl), true);
});

test('invalid or future verification timestamps cannot suppress requests', () => {
  assert.equal(refresh(item, { ...previous, settlement_verified_at: new Date(NaN) }), true);
  assert.equal(refresh(item, { ...previous, settlement_verified_at: new Date(now + 1000) }), true);
});

test('a changed purchase quantity invalidates the unit price even when the listed price is unchanged', () => {
  assert.equal(needsSettlementRefresh(item, previous, now, ttl, 5), true);
  const multi = { ...previous, settlement_quantity: 5, settlement_total_amount: '51.50' };
  assert.equal(needsSettlementRefresh(item, multi, now, ttl, 5), false);
  assert.equal(needsSettlementRefresh(item, multi, now, ttl, 10), true);
  assert.equal(needsSettlementRefresh(item, multi, now, ttl, 1), true);
  assert.equal(needsSettlementRefresh(item, { ...multi, settlement_total_amount: null }, now, ttl, 5), true);
});

import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OfficialReferenceService } from '../src/official-reference/official-reference.service.js';
import { validateRegionSnapshot } from '../src/official-reference/official-reference.snapshot.js';
import { REFERENCE_REGIONS } from '../src/official-reference/official-reference.catalog.js';

const capturedAt = '2026-09-27T00:00:00.000Z';
const snapshot = (country = 'us', currency = 'USD', amount = 20) => ({
  appId: '6448311069', country, currency, capturedAt,
  sourceUrl: 'https://apps.apple.com/' + country + '/app/id6448311069',
  offers: [
    { id: 'sku-plus-month', name: 'Plus', amount, formatted: String(amount), period: null, kind: 'subscription' },
    { id: 'sku-plus-year', name: 'Plus', amount: amount * 10, formatted: String(amount * 10), period: null, kind: 'subscription' },
  ],
});
const row = (data: unknown, task_key = 'prices:6448311069:us', last_error: string | null = null) => ({ task_key, snapshot: data, last_error });

test('catalog reads saved snapshots, groups only matching SKU IDs, converts and sorts regions', async () => {
  const service = new OfficialReferenceService({ readPublished: async () => [
    row(snapshot()), row(snapshot('in', 'INR', 800), 'prices:6448311069:in'),
    row(snapshot('cl', 'CLP', 19990), 'prices:6448311069:cl'),
    row({ date: '2026-09-27', cny: { cny: 1, usd: 0.125, inr: 10, clp: 100 } }, 'fx'),
  ] }, () => Date.parse(capturedAt));
  const result = await service.catalog();
  assert.equal(result.apps.length, 8);
  const app = result.apps[0];
  assert.equal(app.availableRegions, 3); assert.equal(app.totalRegions, REFERENCE_REGIONS.length);
  assert.equal(app.plans.length, 2, 'same-name SKU variants must remain distinct');
  assert.deepEqual(app.plans[0].prices.map(p => [p.country, p.cnyAmount]), [['in', 80], ['us', 160], ['cl', 199.9]]);
  assert.equal(app.plans[0].prices[2].countryName, '智利');
  assert.equal(new Set(app.plans.map(p => p.name)).size, 2, 'duplicate plan labels must be distinguishable');
  assert.equal(result.exchangeDate, '2026-09-27');
});

test('missing exchange rates retain original quotes with null CNY instead of zero', async () => {
  const service = new OfficialReferenceService({ readPublished: async () => [row(snapshot())] }, () => Date.parse(capturedAt));
  const result = await service.catalog();
  assert.equal(result.apps[0].plans[0].prices[0].cnyAmount, null);
  assert.equal(result.apps[0].plans[0].prices[0].amount, 20);
  assert.equal(result.exchangeDate, null);
});

test('catalog leads with the app and subscriptions, keeps explicit periods distinct before credit packs', async () => {
  const data = snapshot();
  data.offers = [
    { ...data.offers[0], id: 'credits', name: '100 Credits', kind: 'purchase', period: null },
    { ...data.offers[0], id: 'app', name: 'ChatGPT', kind: 'app', amount: 0, period: null },
    { ...data.offers[0], id: 'monthly', name: 'ChatGPT Plus', period: 'P1M' },
    { ...data.offers[0], id: 'yearly', name: 'ChatGPT Plus', period: 'P1Y' },
  ];
  const result = await new OfficialReferenceService({ readPublished: async () => [row(data)] }).catalog();
  assert.deepEqual(result.apps[0].plans.map(p => [p.name, p.period]), [
    ['软件本体', null], ['ChatGPT Plus', 'P1M'], ['ChatGPT Plus', 'P1Y'], ['100 Credits', null],
  ]);
});

test('failed refreshes and old price or FX snapshots are marked stale', async () => {
  for (const [now, error, fxDate] of [[Date.parse(capturedAt), 'upstream unavailable', '2026-09-27'],
    [Date.parse(capturedAt) + 25 * 3600_000, null, '2026-09-27'],
    [Date.parse(capturedAt), null, '2026-09-23']] as const) {
    const service = new OfficialReferenceService({ readPublished: async () => [row(snapshot(), undefined, error),
      row({ date: fxDate, cny: { cny: 1, usd: 0.1 } }, 'fx')] }, () => now);
    assert.equal((await service.catalog()).apps[0].plans[0].prices[0].stale, true);
  }
});

test('snapshot validation rejects wrong region currency, duplicate SKUs and malformed prices', () => {
  assert.equal(validateRegionSnapshot(snapshot()).offers.length, 2);
  for (const value of [
    { ...snapshot(), currency: 'JPY' }, { ...snapshot(), capturedAt: 'invalid' },
    { ...snapshot(), sourceUrl: 'https://evil.test/us/app/id6448311069' },
    { ...snapshot(), offers: [snapshot().offers[0], snapshot().offers[0]] },
    { ...snapshot(), offers: [{ ...snapshot().offers[0], amount: -1 }] },
    { ...snapshot(), offers: [{ ...snapshot().offers[0], amount: Infinity }] },
  ]) assert.throws(() => validateRegionSnapshot(value));
});

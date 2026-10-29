import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCollection, parseAnalyticsQuery, analyticsPeriod } from '../src/analytics/analytics-input.js';

export const collection = {
  visitId: '11111111-1111-4111-8111-111111111111', visitorId: '22222222-2222-4222-8222-222222222222', sessionId: '33333333-3333-4333-8333-333333333333',
  page: 'catalog', device: 'desktop', browser: 'chrome', source: 'direct', activeMs: 0, actions: [],
};
test('accepts only bounded analytics fields and rejects credentials, URLs and invented metrics', () => {
  assert.deepEqual(parseCollection(collection), collection);
  for (const changes of [{ page: '/admin' }, { page: '/?token=secret' }, { visitorId: 'bad' }, { activeMs: -1 }, { activeMs: 86400001 }, { activeMs: 1.1 }, { browser: 'raw-user-agent' }, { source: 'https://secret.example' }, { apiKey: 'secret' }, { actions: [{ id: collection.visitId, name: 'ai_test' }] }, { actions: Array(21).fill({ id: collection.visitId, name: 'search' }) }]) {
    assert.throws(() => parseCollection({ ...collection, ...changes }));
  }
  assert.throws(() => parseCollection(null));
  assert.throws(() => parseCollection({ ...collection, actions: [{ id: collection.visitId, name: 'search', query: 'secret' }] }));
});
test('statistics ranges are bounded and Shanghai calendar boundaries include today', () => {
  assert.deepEqual(parseAnalyticsQuery({}), { days: 7, page: 1, limit: 20 });
  assert.deepEqual(parseAnalyticsQuery({ days: '30', page: '2', limit: '10' }), { days: 30, page: 2, limit: 10 });
  for (const query of [{ days: '365' }, { days: '7x' }, { page: '0' }, { page: '1.5' }, { limit: '101' }, { visitorId: 'x' }]) assert.throws(() => parseAnalyticsQuery(query));
  assert.deepEqual(analyticsPeriod(7, new Date('2026-09-26T17:00:00.000Z')), { start: '2026-09-20T16:00:00.000Z', end: '2026-09-27T16:00:00.000Z', days: 7, timezone: 'Asia/Shanghai' });
});

test('reference actions accept only known products and bounded official SKU identities on every public page', () => {
  const app = { appId: '6448311069' };
  const plan = { ...app, planId: '["6744120541","subscription","P1M"]' };
  for (const page of ['catalog', 'tools_ai', 'tools_ip']) {
    for (const action of [
      { name: 'reference_open' },
      { name: 'reference_product', reference: app },
      { name: 'reference_plans_open', reference: app },
      { name: 'reference_plan_select', reference: plan },
      { name: 'reference_plan_select', reference: { ...app, planId: '["6757568473","purchase",null]' } },
    ]) {
      const value = { ...collection, page, actions: [{ id: collection.visitId, ...action }] };
      assert.deepEqual(parseCollection(value), value);
    }
  }
  for (const action of [
    { name: 'reference_product' },
    { name: 'reference_product', reference: { appId: 'unknown' } },
    { name: 'reference_open', reference: app },
    { name: 'search', reference: app },
    { name: 'reference_product', reference: plan },
    { name: 'reference_plan_select', reference: app },
    { name: 'reference_plan_select', reference: { ...plan, name: 'private text' } },
    ...['https://private.example', 'sk-secret', '["6744120541","app",null]', '["6744120541","purchase","P1M"]', '["6744120541","subscription","private text"]'].map(planId => ({ name: 'reference_plan_select', reference: { ...app, planId } })),
  ]) assert.throws(() => parseCollection({ ...collection, actions: [{ id: collection.visitId, ...action }] }));
});

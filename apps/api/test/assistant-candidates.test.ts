import assert from 'node:assert/strict';
import test from 'node:test';
import { ASSISTANT_CAPABILITIES, capabilitySupportsPurpose, selectCapabilities, type CapabilityEvidence } from '../src/assistant/assistant-capabilities.js';
import { candidateEvidence, selectCandidates, type AssistantCandidate } from '../src/assistant/assistant-candidates.js';
import type { CatalogOffer } from '../src/catalog/catalog.repository.js';

const now = new Date('2026-10-31T12:00:00Z');
const needs = {
  purpose: 'fictional research', platform: null, budget: null, requiredTags: [],
  warrantyDaysMin: null, preferences: [],
};
const evidence: CapabilityEvidence = {
  id: 'fictional-research', identity: { platform: 'fictional', product: 'widget', tier: 'pro' },
  purposes: ['fictional research'], statement: 'Fictional research support; not a real product claim.',
  sourceUrl: 'https://example.invalid/evidence', checkedAt: '2026-10-31T00:00:00Z',
  reviewAfter: '2026-11-07T00:00:00Z',
};
function fixture(id = '1', offer: Partial<CatalogOffer> = {}): AssistantCandidate {
  return {
    standardProduct: { id, name: 'Fictional widget', platform: 'fictional', kind: 'subscription' },
    offer: {
      productId: id, shopId: '1', shop: 'Fictional shop', name: 'Fictional offer', price: '10.00',
      currency: 'CNY', settlementQuantity: 1, priceStatus: 'verified', inStock: true, stale: false,
      capturedAt: '2026-10-31T11:00:00Z', priceExpiresAt: '2026-10-31T13:00:00Z',
      inventoryExpiresAt: '2026-10-31T13:00:00Z', productUrl: 'https://example.invalid/item', spec: '',
      tags: [{ name: 'duration', value: '1 month' }], ...offer,
    },
    capabilityEvidence: [evidence],
  };
}

test('rejects unknown, expired, bulk, stale and unavailable offers without changing needs', () => {
  const before = structuredClone(needs);
  for (const offer of [
    { priceStatus: undefined }, { priceStatus: 'estimated' }, { price: null }, { price: 'NaN' },
    { price: '-1.00' }, { currency: '' }, { settlementQuantity: 10 }, { stale: true }, { inStock: false },
    { priceExpiresAt: null }, { inventoryExpiresAt: undefined }, { inventoryExpiresAt: now.toISOString() },
    { priceExpiresAt: 'invalid' }, { priceExpiresAt: now.toISOString() },
  ] satisfies Partial<CatalogOffer>[]) assert.deepEqual(selectCandidates([fixture('1', offer)], needs, now), []);
  assert.equal(selectCandidates([fixture()], needs, now).length, 1);
  assert.deepEqual(needs, before);
});

test('hard tags, warranty and budget must hold on the same offer', () => {
  const hard = { ...needs, budget: { amount: '15.00', currency: 'CNY', basis: 'purchase' as const },
    requiredTags: [{ name: 'access', value: 'dedicated' }], warrantyDaysMin: 30 };
  const cheap = fixture('1', { tags: [{ name: 'access', value: 'dedicated' }] });
  const covered = fixture('2', { price: '20.00', tags: [
    { name: 'access', value: 'dedicated' }, { name: 'warranty_days', value: '30' },
  ] });
  assert.deepEqual(selectCandidates([cheap, covered], hard, now), []);
  assert.equal(selectCandidates([fixture('3', { price: '15.00', tags: covered.offer.tags })], hard, now).length, 1);
  assert.deepEqual(selectCandidates([fixture('3', { currency: 'USD', tags: covered.offer.tags })], hard, now), []);
  assert.deepEqual(selectCandidates([fixture('3', { tags: [
    ...covered.offer.tags, { name: 'warranty_days', value: 'unknown' },
  ] })], hard, now), []);
});

test('monthly budgets require an explicit single month; annual price is never divided', () => {
  const monthly = { ...needs, budget: { amount: '10.00', currency: 'CNY', basis: 'month' as const } };
  for (const tags of [[], [{ name: 'duration', value: '1 year' }], [
    { name: 'duration', value: '1 month' }, { name: 'duration', value: '1 year' },
  ]]) assert.deepEqual(selectCandidates([fixture('1', { tags })], monthly, now), []);
  assert.equal(selectCandidates([fixture()], monthly, now).length, 1);
});

test('preferences are ordered, unknown warranty ranks last and simple setup stays unknown', () => {
  const a = fixture('1', { price: '5.00' });
  const b = fixture('2', { price: '9.00', tags: [
    ...a.offer.tags, { name: 'warranty_days', value: '30' }, { name: 'delivery', value: 'account' },
  ] });
  const c = fixture('3', { price: '7.00', tags: [
    ...a.offer.tags, { name: 'warranty_days', value: '60' },
  ] });
  const ids = (preferences: Array<'lower_price' | 'longer_warranty' | 'simple_setup'>) =>
    selectCandidates([b, a, c], { ...needs, preferences }, now).map(c => c.offer.productId);
  assert.deepEqual(ids(['lower_price', 'longer_warranty']), ['1', '3', '2']);
  assert.deepEqual(ids(['longer_warranty', 'lower_price']), ['3', '2', '1']);
  assert.deepEqual(ids(['simple_setup']), ['1', '3', '2']);
});

test('sorts ties stably, deduplicates offers and returns at most three candidates', () => {
  const candidates = ['4', '2', '3', '1'].map(id => fixture(id));
  candidates.push(fixture('1'));
  assert.deepEqual(selectCandidates(candidates, needs, now).map(c => c.offer.productId), ['1', '2', '3']);
  assert.deepEqual(selectCandidates(candidates.reverse(), needs, now).map(c => c.offer.productId), ['1', '2', '3']);
  assert.deepEqual(selectCandidates(candidates, { ...needs, platform: 'another' }, now), []);
});

test('purpose requires current capability evidence and never silently uses an unrelated product', () => {
  for (const capabilityEvidence of [[], [{ ...evidence, purposes: ['other'] }],
    [{ ...evidence, reviewAfter: now.toISOString() }], [{ ...evidence, checkedAt: '2026-11-01T00:00:00Z' }]]) {
    assert.deepEqual(selectCandidates([{ ...fixture(), capabilityEvidence }], needs, now), []);
  }
  assert.deepEqual(selectCandidates([fixture()], needs, new Date('invalid')), []);
  assert.deepEqual(selectCapabilities('fictional uncovered teleportation', now), []);
  assert.deepEqual(selectCapabilities('', now), []);
  assert.deepEqual(selectCapabilities('coding', new Date('2099-01-01')), []);
  assert.ok(ASSISTANT_CAPABILITIES.length >= 3);
});

test('explanation evidence contains only this offer facts with candidate-scoped IDs', () => {
  const candidate = fixture('7', { tags: [
    { name: 'access', value: 'dedicated' }, { name: 'warranty_exclusion', value: 'ban' },
    { name: 'warranty_days', value: '30' }, { name: 'warranty_terms', value: '仅限首次登录前申请' },
  ] });
  const facts = candidateEvidence(candidate);
  assert.ok(facts.some(fact => fact.text.includes('独享')));
  assert.ok(facts.some(fact => fact.text.includes('不保封号')));
  assert.ok(facts.some(fact => fact.text.includes('仅限首次登录前申请')));
  assert.ok(facts.some(fact => fact.text.includes(evidence.statement)));
  assert.equal(new Set(facts.map(fact => fact.id)).size, facts.length);
  assert.ok(facts.every(fact => !candidateEvidence(fixture('8')).some(other => other.id === fact.id)));
  assert.ok(!facts.some(fact => /最低|省心|简单/u.test(fact.text)));
  assert.deepEqual(facts, candidateEvidence({ ...candidate, offer: { ...candidate.offer, tags: [...candidate.offer.tags].reverse() } }));
  assert.ok(facts.every(fact => fact.id.length <= 128 && fact.text.length <= 240 && !fact.text.includes('https://')));
  const longTerms = candidateEvidence(fixture('9', { tags: [{ name: 'warranty_terms', value: '限制'.repeat(125) }] }));
  assert.ok(longTerms.every(fact => fact.text.length <= 240));
  assert.ok(longTerms.some(fact => fact.text.includes('完整')));
});

test('capability matching uses bounded terms, checks both time boundaries and removes stale evidence', () => {
  assert.equal(capabilitySupportsPurpose(evidence, 'Need fictional research help', now), true);
  assert.equal(capabilitySupportsPurpose(evidence, 'fictional researcher', now), false);
  assert.equal(capabilitySupportsPurpose({ ...evidence, purposes: [''] }, 'anything', now), false);
  for (const patch of [
    { checkedAt: 'invalid' }, { checkedAt: '2026-11-01T00:00:00Z' },
    { reviewAfter: 'invalid' }, { reviewAfter: now.toISOString() },
  ]) assert.equal(capabilitySupportsPurpose({ ...evidence, ...patch }, needs.purpose!, now), false);
  const stale = { ...evidence, id: 'stale', reviewAfter: now.toISOString() };
  assert.deepEqual(selectCandidates([{ ...fixture(), capabilityEvidence: [evidence, stale] }], needs, now)[0]?.capabilityEvidence, [evidence]);
});

test('explicit bulk minimum and contradictory warranty cannot satisfy single-item hard requirements', () => {
  assert.deepEqual(selectCandidates([fixture('1', { tags: [{ name: 'minimum_quantity', value: '10' }] })], needs, now), []);
  const contradictory = fixture('1', { tags: [
    { name: 'warranty_days', value: '30' }, { name: 'warranty', value: 'none' },
  ] });
  assert.deepEqual(selectCandidates([contradictory], { ...needs, warrantyDaysMin: 30 }, now), []);
});

test('simple setup compares only explicit operation counts and ranks unknown last', () => {
  const unknown = fixture('1', { price: '1.00', tags: [{ name: 'delivery', value: 'account' }] });
  const two = fixture('2', { tags: [{ name: 'setup_steps', value: '2' }] });
  const zero = fixture('3', { price: '20.00', tags: [{ name: 'setup_steps', value: '0' }] });
  assert.deepEqual(selectCandidates([unknown, two, zero], { ...needs, preferences: ['simple_setup'] }, now)
    .map(candidate => candidate.offer.productId), ['3', '2', '1']);
  assert.ok(candidateEvidence(zero).some(fact => fact.text.includes('0') && fact.text.includes('步骤')));
});

test('platform groups use catalog metadata overrides while exact platform requests stay narrow', () => {
  for (const [platform, displayed, platformGroup, expected] of [
    ['anthropic', 'Claude', 'anthropic', 1], ['google', 'YouTube', 'google', 1],
    ['google', 'Gemini', 'google', 1], ['openai', 'ChatGPT', 'openai', 1], ['xai', 'Cursor', 'xai', 1],
    ['youtube', 'YouTube', 'google', 1], ['youtube', 'Gemini', 'google', 0],
    ['claude', 'anthropic', 'anthropic', 0], ['anthropic', 'Google', 'google', 0],
    ['email', 'Google', 'email', 1], ['ip', 'Claude', 'ip', 1],
    ['other', 'Google', 'other', 1], ['google', 'Google', 'email', 0],
    ['google', 'Google', 'other', 0], ['anthropic', 'Claude', undefined, 1],
    ['google', 'YouTube', undefined, 1], ['youtube', 'YouTube', undefined, 1],
    ['other', 'Fictional', undefined, 1], ['anthropic', 'Google', undefined, 0],
  ] as const) {
    const candidate = fixture();
    candidate.standardProduct = { ...candidate.standardProduct, platform: displayed, platformGroup };
    assert.equal(selectCandidates([candidate], { ...needs, platform }, now).length, expected, `${platform}/${displayed}`);
  }
});

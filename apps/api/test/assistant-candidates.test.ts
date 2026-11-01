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

test('rejects missing or malformed prices and bulk offers without changing needs', () => {
  const before = structuredClone(needs);
  for (const offer of [
    { price: null }, { price: 'NaN' },
    { price: '-1.00' }, { currency: '' }, { settlementQuantity: 10 },
  ] satisfies Partial<CatalogOffer>[]) assert.deepEqual(selectCandidates([fixture('1', offer)], needs, now), []);
  assert.equal(selectCandidates([fixture()], needs, now).length, 1);
  assert.deepEqual(needs, before);
});

test('reference quotes remain eligible regardless of verification, inventory or expiry status', () => {
  for (const offer of [
    { priceStatus: undefined }, { priceStatus: 'estimated' }, { priceStatus: 'expired' },
    { priceStatus: 'unverified' }, { stale: true }, { inStock: false },
    { priceExpiresAt: null }, { inventoryExpiresAt: undefined },
    { inventoryExpiresAt: now.toISOString() }, { priceExpiresAt: now.toISOString() },
    { priceExpiresAt: '2020-01-01T00:00:00Z' },
  ] satisfies Partial<CatalogOffer>[]) {
    assert.equal(selectCandidates([fixture('1', offer)], needs, now).length, 1, JSON.stringify(offer));
  }
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

test('recommendations cover different purchase prerequisites before repeating cheaper conditions', () => {
  const base = fixture();
  const offers = ['1', '2', '3', '4', '5'].map((id, index) => ({
    ...base, offer: { ...base.offer, productId: id, price: `${10 + index}.00`, tags: [...base.offer.tags,
      { name: 'delivery', value: 'top_up' }, { name: 'warranty', value: 'covered' },
      ...index < 3 ? [{ name: 'usage_restriction', value: '需资格账号' }, { name: 'region', value: ['us', 'in', 'jp'][index]! }]
        : index === 3 ? [{ name: 'usage_restriction', value: '普通账号可充值，无需优惠资格' }] : [{ name: 'kyc_required', value: '有' }],
    ] },
  }));
  const request = { ...needs, requiredTags: [{ name: 'delivery', value: 'top_up' }], preferences: ['lower_price' as const] };
  assert.deepEqual(selectCandidates(offers, request, now).map(c => c.offer.productId), ['1', '4', '5']);
  assert.deepEqual(selectCandidates([...offers].reverse(), request, now).map(c => c.offer.productId), ['1', '4', '5']);
  const missing = { ...offers[3]!, offer: { ...offers[3]!.offer, tags: [{ name: 'delivery', value: 'top_up' }] } };
  assert.deepEqual(selectCandidates([missing], request, now)[0]!.offer.tags, missing.offer.tags,
    'missing restrictions must not become an unrestricted claim');
  assert.deepEqual(selectCandidates(offers, { ...request, budget: { amount: '12', currency: 'CNY', basis: 'purchase' } }, now)
    .map(c => c.offer.productId), ['1', '2', '3']);
  assert.deepEqual(selectCandidates(offers, { ...request, requiredTags: [...request.requiredTags,
    { name: 'usage_restriction', value: '需资格账号' }] }, now).map(c => c.offer.productId), ['1', '2', '3']);
});

test('other products diversify delivery and access and fill remaining slots without duplicates', () => {
  const base = fixture();
  const offers = ['1', '2', '3', '4', '5'].map((id, index) => ({ ...base,
    offer: { ...base.offer, productId: id, price: `${10 + index}.00`, tags: [
      { name: 'delivery', value: index === 3 ? 'redemption' : 'account' },
      { name: 'access', value: index === 4 ? 'dedicated' : 'shared' },
      { name: 'duration', value: '1 month' },
    ] },
  }));
  assert.deepEqual(selectCandidates(offers, { ...needs, preferences: ['lower_price'] }, now).map(c => c.offer.productId), ['1', '4', '5']);
  assert.deepEqual(selectCandidates([...offers.slice(0, 3), offers[0]!], needs, now).map(c => c.offer.productId), ['1', '2', '3']);
});

test('a different purchase gate wins over login variants of the same gate', () => {
  const base = fixture();
  const offers = ['password', 'email_code', 'oauth2', 'password'].map((login, index) => ({ ...base,
    offer: { ...base.offer, productId: String(index + 1), price: String(10 + index), tags: [...base.offer.tags,
      { name: 'usage_restriction', value: index < 3 ? '仅限符合资格的账号' : '普通账号可充值，无需优惠资格' },
      { name: 'login_method', value: login },
    ] },
  }));
  const request = { ...needs, preferences: ['lower_price' as const] };
  const selected = selectCandidates(offers, request, now);
  assert.ok(selected.some(candidate => candidate.offer.productId === '4'));
  assert.equal(selected[0]!.offer.productId, '1', 'keep the preferred quote');
  assert.deepEqual(selectCandidates([...offers].reverse(), request, now), selected);
});

test('a broader reranking pool reaches alternatives behind many duplicates', () => {
  const base = fixture();
  const offers = Array.from({ length: 52 }, (_, index) => ({ ...base, offer: { ...base.offer,
    productId: String(index + 1), price: String(10 + index), tags: [...base.offer.tags,
      { name: 'usage_restriction', value: index < 50 ? '需资格账号' : '普通账号可用' },
      ...index === 51 ? [{ name: 'renewable', value: '有' }] : [],
    ],
  } }));
  const selected = selectCandidates(offers, { ...needs, preferences: ['lower_price'] }, now, 12);
  assert.equal(selected.length, 12);
  assert.ok(selected.some(candidate => candidate.offer.productId === '51'));
  assert.ok(selected.some(candidate => candidate.offer.productId === '52'));
  assert.equal(new Set(selected.map(candidate => candidate.offer.productId)).size, 12);
});

test('purchase facets remain diverse across products, arbitrary merchant wording and secondary metadata', () => {
  for (const restriction of ['仅限符合资格的账号', '仅支持首次购买', '需要管理员邀请', '需自备可验证的组织账号']) {
    const base = fixture();
    const offers = Array.from({ length: 16 }, (_, index) => ({ ...base, offer: { ...base.offer,
      productId: String(index + 1), price: String(10 + index), tags: [...base.offer.tags,
        { name: 'usage_restriction', value: index < 15 ? restriction : '购买条件不同，请按商家列明条件办理' },
        { name: 'login_method', value: ['password', 'email_code', 'oauth2'][index % 3]! },
        { name: 'region', value: ['us', 'jp', 'in'][index % 3]! },
      ],
    } }));
    const request = { ...needs, preferences: ['lower_price' as const] };
    assert.ok(selectCandidates(offers, request, now).some(candidate => candidate.offer.productId === '16'), restriction);
    assert.equal(selectCandidates(offers, request, now)[0]!.offer.productId, '1');
    assert.ok(!selectCandidates(offers, { ...request, budget: { amount: '24', currency: 'CNY', basis: 'purchase' } }, now)
      .some(candidate => candidate.offer.productId === '16'));
  }
});

test('secondary variants cover durations and regions without treating tag order or duplicate tags as differences', () => {
  const base = fixture();
  const tags = [...base.offer.tags, { name: 'region', value: 'us' }];
  const variants = [tags, [...tags].reverse(), [...tags, tags[0]!],
    [{ name: 'duration', value: '1 year' }, { name: 'region', value: 'us' }],
    [...base.offer.tags, { name: 'region', value: 'in' }]];
  const offers = variants.map((tags, index) => ({ ...base, offer: { ...base.offer,
    productId: String(index + 1), price: `${10 + index}.00`, tags } }));
  assert.deepEqual(selectCandidates(offers, needs, now).map(c => c.offer.productId), ['1', '5', '4']);
});

test('explicit product matches standard names, never merchant names or offer marketing', () => {
  const products = ['ChatGPT Go', 'ChatGPT Plus', 'ChatGPT Pro', 'Claude Pro', 'ChatGPT PlusPlus'];
  const candidates = products.map((name, index) => ({
    ...fixture(String(index + 1), { shop: 'PLUSAI', name: 'ChatGPT Plus / Go / Pro 充值' }),
    standardProduct: { id: String(index + 1), name, platform: index === 3 ? 'anthropic' : 'openai', kind: 'subscription' },
  }));
  for (const product of ['ChatGPT Plus', 'gpt plus', 'ＰＬＵＳ', 'chatgpt-plus']) {
    assert.deepEqual(selectCandidates(candidates, { ...needs, purpose: null, platform: 'openai', product }, now)
      .map(candidate => candidate.standardProduct.name), ['ChatGPT Plus'], product);
  }
  assert.deepEqual(selectCandidates(candidates, { ...needs, purpose: null, product: 'Claude Pro' }, now)
    .map(candidate => candidate.standardProduct.name), ['Claude Pro']);
  assert.deepEqual(selectCandidates(candidates, { ...needs, purpose: null, product: 'ChatGPT Business' }, now), []);
});

test('explicit products also match canonical identities and standard aliases behind display names', () => {
  const candidates = [
    { ...fixture('1'), standardProduct: { id: '1', name: 'ChatGPT 商业版', platform: 'openai', kind: 'subscription',
      identityNames: ['openai / chatgpt / business', 'ChatGPT 企业版'] } },
    { ...fixture('2'), standardProduct: { id: '2', name: 'ChatGPT Pro 100', platform: 'openai', kind: 'subscription',
      identityNames: ['ChatGPT Pro 5x', 'openai chatgpt pro_5x'] } },
  ];
  for (const [product, id] of [['ChatGPT Business', '1'], ['ChatGPT 企业版', '1'], ['ChatGPT Pro 5x', '2'], ['ChatGPT Pro 100', '2']]) {
    assert.deepEqual(selectCandidates(candidates, { ...needs, purpose: null, product }, now)
      .map(candidate => candidate.standardProduct.id), [id], product);
  }
  assert.deepEqual(selectCandidates(candidates, { ...needs, purpose: null, product: 'ChatGPT Plus' }, now), []);
});

test('AI packages without purchase conditions prioritize newcomer offers before diverse alternatives', () => {
  for (const [name, platform] of [['ChatGPT Plus', 'openai'], ['Claude Pro', 'anthropic'],
    ['Gemini Pro', 'google'], ['Cursor Pro', 'cursor'], ['Grok Super', 'xai']]) {
    const candidates = Array.from({ length: 5 }, (_, index) => ({
      ...fixture(String(index + 1), { price: String(index + 1), tags: [
        { name: 'duration', value: '1 month' },
        { name: 'delivery', value: index === 0 ? 'redemption' : index === 4 ? 'account' : 'top_up' },
        { name: 'warranty_days', value: index === 1 ? '29' : '30' },
      ] }), standardProduct: { id: '1', name, platform, kind: '账号与订阅' },
    }));
    const before = structuredClone(needs);
    assert.deepEqual(selectCandidates(candidates, needs, now).map(c => c.offer.productId), ['3', '4', '5'], name);
    assert.deepEqual(selectCandidates([...candidates].reverse(), needs, now).map(c => c.offer.productId), ['3', '4', '5']);
    assert.deepEqual(needs, before, 'defaults are not saved as user requirements');
    assert.equal(selectCandidates(candidates, { ...needs, preferences: ['lower_price'] }, now)[0]?.offer.productId, '1');
    assert.equal(selectCandidates(candidates, { ...needs, requiredTags: [{ name: 'delivery', value: 'top_up' }] }, now)[0]?.offer.productId, '2');
    assert.equal(selectCandidates(candidates, { ...needs, warrantyDaysMin: 10 }, now)[0]?.offer.productId, '1');
    assert.equal(selectCandidates(candidates, { ...needs, budget: { amount: '2', currency: 'CNY', basis: 'purchase' } }, now)[0]?.offer.productId, '1');
    assert.equal(selectCandidates(candidates.slice(0, 2), needs, now).length, 2, 'fallback offers remain eligible');
  }
});

test('newcomer priority requires both delivery and unambiguous warranty on the same AI offer', () => {
  const base = fixture();
  base.standardProduct = { id: '1', name: 'ChatGPT Plus', platform: 'openai', kind: '账号与订阅' };
  const good = { ...base, offer: { ...base.offer, productId: '9', price: '99', tags: [
    ...base.offer.tags, { name: 'delivery', value: 'account' }, { name: 'warranty_days', value: '30' },
  ] } };
  for (const tags of [
    [{ name: 'delivery', value: 'account' }, { name: 'warranty', value: 'covered' }],
    [...good.offer.tags, { name: 'warranty', value: 'none' }],
    [...good.offer.tags, { name: 'warranty_days', value: 'unknown' }],
    [...good.offer.tags, { name: 'delivery', value: 'redemption' }],
    [{ name: 'warranty_days', value: '90' }],
  ]) {
    const other = { ...base, offer: { ...base.offer, tags } };
    assert.equal(selectCandidates([other, good], needs, now, 1)[0]?.offer.productId, '9');
    assert.equal(selectCandidates([other], needs, now, 1).length, 1);
  }
});

test('IP, email and non-AI products never get the AI newcomer priority from their platform or marketing', () => {
  for (const [name, platform, platformGroup, kind] of [
    ['住宅 IP', 'network', 'ip', '其他'], ['Google 邮箱', 'google', 'email', '其他'],
    ['Claude 邮箱', 'anthropic', 'email', '账号与订阅'], ['YouTube Premium', 'youtube', 'google', '账号与订阅'],
    ['X Premium', 'x', 'xai', '账号与订阅'], ['Claude 手机接码', 'anthropic', 'anthropic', '手机接码'],
    ['ChatGPT 教程', 'openai', 'openai', '教程'], ['Cursor 账号管理工具', 'software', 'other', '其他'],
  ]) {
    const cheap = fixture('1', { price: '1', name: 'ChatGPT Plus 新手推荐' });
    cheap.standardProduct = { id: '1', name, platform, platformGroup, kind };
    const covered = { ...cheap, offer: { ...cheap.offer, productId: '2', price: '99', tags: [
      ...cheap.offer.tags, { name: 'delivery', value: 'account' }, { name: 'warranty_days', value: '30' },
    ] } };
    assert.equal(selectCandidates([covered, cheap], needs, now, 1)[0]?.offer.productId, '1', name);
  }
});

test('delivery evidence explains what a beginner receives without inventing setup guarantees', () => {
  for (const [delivery, expected] of [['top_up', /已有账号/u], ['account', /提供.*账号/u]] as const) {
    const facts = candidateEvidence(fixture('1', { tags: [{ name: 'delivery', value: delivery }] }));
    assert.ok(facts.some(fact => expected.test(fact.text)));
  }
});

test('an explicit platform can browse quotes without inventing purpose evidence', () => {
  const candidate = { ...fixture(), capabilityEvidence: [] };
  assert.equal(selectCandidates([candidate], { ...needs, platform: 'fictional' }, now).length, 1);
  assert.deepEqual(selectCandidates([candidate], needs, now), []);
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

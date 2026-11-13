import assert from 'node:assert/strict';
import test from 'node:test';
import { ASSISTANT_CAPABILITIES, capabilitySupportsPurpose, selectCapabilities, type CapabilityEvidence } from '../src/assistant/assistant-capabilities.js';
import { candidateEvidence, selectCandidates, type AssistantCandidate } from '../src/assistant/assistant-candidates.js';
import type { CatalogOffer } from '../src/catalog/catalog.repository.js';

const now = new Date('2026-10-31T12:00:00Z');
const needs = {
  purpose: 'fictional research', platform: null, budget: null, requiredTags: [],
  preferences: [],
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
      tags: [{ name: 'duration', value: 30 }], ...offer,
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

test('hard tags and budget must hold on the same offer', () => {
  const hard = { ...needs, budget: { amount: '15.00', currency: 'CNY', basis: 'purchase' as const },
    requiredTags: [{ name: 'sms_verification', value: 'verified' }, { name: 'duration', value: 30 }] };
  const cheap = fixture('1', { tags: [{ name: 'sms_verification', value: 'verified' }] });
  const covered = fixture('2', { price: '20.00', tags: hard.requiredTags });
  assert.deepEqual(selectCandidates([cheap, covered], hard, now), []);
  assert.equal(selectCandidates([fixture('3', { price: '15.00', tags: covered.offer.tags })], hard, now).length, 1);
  assert.deepEqual(selectCandidates([fixture('3', { currency: 'USD', tags: covered.offer.tags })], hard, now), []);
  assert.deepEqual(selectCandidates([fixture('3', { tags: [...covered.offer.tags, { name: 'duration', value: 365 }] })], hard, now), []);
});

test('monthly budgets require an explicit single month; annual price is never divided', () => {
  const monthly = { ...needs, budget: { amount: '10.00', currency: 'CNY', basis: 'month' as const } };
  for (const tags of [[], [{ name: 'duration', value: 365 }], [
    { name: 'duration', value: 30 }, { name: 'duration', value: 365 },
  ]]) assert.deepEqual(selectCandidates([fixture('1', { tags })], monthly, now), []);
  assert.equal(selectCandidates([fixture()], monthly, now).length, 1);
});

test('duration filters compare numeric days and preserve every qualifier without parsing strings', () => {
  const monthly = { ...needs, requiredTags: [{ name: 'duration', value: 30 }] };
  const monthBudget = { ...needs, budget: { amount: '10', currency: 'CNY', basis: 'month' as const } };
  for (const value of [360, 365, 0.5, '30', '1 month', { kind: 'range', min: 30, max: 60 },
    { kind: 'min', days: 30 }, { kind: 'max', days: 30 }, { kind: 'approx', days: 30 }, { kind: 'permanent' }] as const) {
    const candidate = fixture('1', { tags: [{ name: 'duration', value }] });
    assert.deepEqual(selectCandidates([candidate], monthly, now), []);
    assert.deepEqual(selectCandidates([candidate], monthBudget, now), []);
  }
  for (const value of [0.5, 30, 90, 360, 365, { kind: 'range', min: 30, max: 60 },
    { kind: 'min', days: 30 }, { kind: 'permanent' }] as const) {
    const requiredTags = [{ name: 'duration', value }];
    assert.equal(selectCandidates([fixture('1', { tags: structuredClone(requiredTags) })],
      { ...needs, requiredTags }, now).length, 1);
  }
  assert.deepEqual(selectCandidates([fixture('1', { tags: [{ name: 'duration', value: 365 }] }),
    fixture('2', { tags: [{ name: 'duration', value: 360 }] })], needs, now).map(candidate => candidate.offer.productId), ['2', '1']);
});

test('regions use OR within the dimension and AND with other canonical requirements', () => {
  const request = { ...needs, requiredTags: [
    { name: 'region', value: 'us' }, { name: 'region', value: 'jp' }, { name: 'duration', value: 30 },
    { name: 'access_channel', value: 'web' }, { name: 'supported_client', value: 'codex' },
  ] };
  const tags = [{ name: 'duration', value: 30 }, { name: 'access_channel', value: 'web' },
    { name: 'access_channel', value: 'api' }, { name: 'supported_client', value: 'codex' }];
  assert.equal(selectCandidates([fixture('1', { tags: [...tags, { name: 'region', value: 'jp' }] })], request, now).length, 1);
  assert.equal(selectCandidates([fixture('1', { tags: [...tags, { name: 'region', value: 'jp' }, { name: 'region', value: 'us' }] })], request, now).length, 1);
  assert.deepEqual(selectCandidates([fixture('1', { tags: [...tags, { name: 'region', value: 'ph' }] })], request, now), []);
  assert.deepEqual(selectCandidates([fixture('1', { tags: [{ name: 'region', value: 'us' }] })], request, now), []);
});

test('conflicting single-valued facts cannot satisfy a hard requirement', () => {
  for (const tags of [
    [{ name: 'sms_verification', value: 'verified' }, { name: 'sms_verification', value: 'unverified' }],
    [{ name: 'warranty', value: '仅保首登' }, { name: 'warranty', value: '保订阅30天，封号不保' }],
  ]) {
    assert.deepEqual(selectCandidates([fixture('1', { tags })], { ...needs, requiredTags: [tags[0]!] }, now), []);
  }
});

test('entry points and supported clients use same-name OR and different-name AND', () => {
  const request = { ...needs, requiredTags: [
    { name: 'access_channel', value: 'web' }, { name: 'access_channel', value: 'api' },
    { name: 'supported_client', value: 'codex' }, { name: 'supported_client', value: 'sub2api' },
    { name: 'duration', value: 30 },
  ] };
  for (const entry of ['web', 'api']) {
    for (const client of ['codex', 'sub2api']) {
      const tags = [{ name: 'access_channel', value: entry }, { name: 'supported_client', value: client },
        { name: 'duration', value: 30 }];
      assert.equal(selectCandidates([fixture('1', { tags })], request, now).length, 1, `${entry}/${client}`);
    }
  }
  for (const tags of [
    [{ name: 'access_channel', value: 'web' }, { name: 'duration', value: 30 }],
    [{ name: 'supported_client', value: 'codex' }, { name: 'duration', value: 30 }],
    [{ name: 'access_channel', value: 'mirror' }, { name: 'supported_client', value: 'codex' }, { name: 'duration', value: 30 }],
    [{ name: 'access_channel', value: 'web' }, { name: 'supported_client', value: 'other' }, { name: 'duration', value: 30 }],
    [{ name: 'access_channel', value: 'api' }, { name: 'supported_client', value: 'sub2api' }, { name: 'duration', value: 365 }],
  ]) assert.deepEqual(selectCandidates([fixture('1', { tags })], request, now), [], JSON.stringify(tags));
});

test('warranty summaries never imply numeric ranking or setup complexity', () => {
  const a = fixture('1', { price: '5.00' });
  const b = fixture('2', { price: '9.00', tags: [...a.offer.tags, { name: 'warranty', value: '保订阅30天，封号不保' }] });
  const c = fixture('3', { price: '7.00', tags: [...a.offer.tags, { name: 'warranty', value: '购买后1小时仅保首登' }] });
  for (const preferences of [['lower_price'], ['simple_setup']] as const) {
    assert.deepEqual(selectCandidates([b, a, c], { ...needs, preferences: [...preferences] }, now).map(c => c.offer.productId), ['1', '3', '2']);
  }
});

test('sorts ties stably, deduplicates offers and returns at most three candidates', () => {
  const candidates = ['4', '2', '3', '1'].map(id => fixture(id));
  candidates.push(fixture('1'));
  assert.deepEqual(selectCandidates(candidates, needs, now).map(c => c.offer.productId), ['1', '2', '3']);
  assert.deepEqual(selectCandidates(candidates.reverse(), needs, now).map(c => c.offer.productId), ['1', '2', '3']);
  assert.deepEqual(selectCandidates(candidates, { ...needs, platform: 'another' }, now), []);
});

test('complete source specifications diversify purchase conditions without retired tags', () => {
  const offers = Array.from({ length: 5 }, (_, index) => fixture(String(index + 1), {
    price: String(10 + index), spec: index < 3 ? '需资格账号' : index === 3 ? '普通账号可充值' : '需自备组织账号',
    tags: [{ name: 'duration', value: 30 }, { name: 'region', value: 'us' }],
  }));
  offers.forEach(candidate => { candidate.standardProduct = offers[0]!.standardProduct; });
  assert.deepEqual(selectCandidates(offers, needs, now).map(c => c.offer.productId), ['1', '4', '5']);
  assert.deepEqual(selectCandidates([...offers].reverse(), needs, now).map(c => c.offer.productId), ['1', '4', '5']);
  assert.deepEqual(selectCandidates(offers, { ...needs, budget: { amount: '12', currency: 'CNY', basis: 'purchase' } }, now)
    .map(c => c.offer.productId), ['1', '2', '3']);
});

test('canonical entry points and regions diversify offers and fill remaining slots without duplicates', () => {
  const offers = Array.from({ length: 5 }, (_, index) => fixture(String(index + 1), { price: String(10 + index), tags: [
    { name: 'duration', value: 30 }, { name: 'access_channel', value: index === 3 ? 'api' : 'web' },
    { name: 'region', value: index === 4 ? 'jp' : 'us' },
  ] }));
  offers.forEach(candidate => { candidate.standardProduct = offers[0]!.standardProduct; });
  assert.deepEqual(selectCandidates(offers, needs, now).map(c => c.offer.productId), ['1', '4', '5']);
  assert.deepEqual(selectCandidates([...offers.slice(0, 3), offers[0]!], needs, now).map(c => c.offer.productId), ['1', '2', '3']);
});

test('a different purchase gate wins over login variants of the same gate', () => {
  const base = fixture();
  const offers = ['password', 'email_code', 'oauth2', 'password'].map((login, index) => ({ ...base,
    offer: { ...base.offer, productId: String(index + 1), price: String(10 + index), spec: index < 3 ? '仅限符合资格的账号' : '普通账号可充值，无需优惠资格', tags: [...base.offer.tags,
      { name: 'supported_client', value: login },
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
    productId: String(index + 1), price: String(10 + index), spec: index < 50 ? '需资格账号' : index === 50 ? '普通账号可用' : '支持续费，请确认条件', tags: [...base.offer.tags,
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
      productId: String(index + 1), price: String(10 + index), spec: index < 15 ? restriction : '购买条件不同，请按商家列明条件办理', tags: [...base.offer.tags,
        { name: 'supported_client', value: ['codex', 'sub2api', 'claude code'][index % 3]! },
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
    [{ name: 'duration', value: 365 }, { name: 'region', value: 'us' }],
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

test('AI membership scope stays hard with budgets and preferences and never fills with short term', () => {
  for (const [name, platform, product, tier] of [['ChatGPT Plus', 'openai', 'chatgpt', 'plus'], ['Claude Pro', 'anthropic', 'claude', 'pro'],
    ['Gemini Pro', 'google', 'gemini', 'pro'], ['Cursor Pro', 'cursor', 'cursor', 'pro'], ['Grok Super', 'xai', 'grok', 'super']]) {
    const candidates = Array.from({ length: 5 }, (_, index) => ({
      ...fixture(String(index + 1), { price: String(index + 1), membershipKind: index < 2 ? 'short_term' : 'account', tags: [
        { name: 'duration', value: 30 },
        { name: 'warranty', value: '保订阅30天，封号不保' },
      ] }), standardProduct: { id: '1', name, platform, kind: '账号与订阅',
        identity: { family: platform!, product: product!, tier: tier! } },
    }));
    const before = structuredClone(needs);
    assert.deepEqual(selectCandidates(candidates, needs, now).map(c => c.offer.productId), ['3', '4', '5'], name);
    assert.deepEqual(selectCandidates([...candidates].reverse(), needs, now).map(c => c.offer.productId), ['3', '4', '5']);
    assert.deepEqual(needs, before, 'defaults are not saved as user requirements');
    assert.equal(selectCandidates(candidates, { ...needs, preferences: ['lower_price'] }, now)[0]?.offer.productId, '3');
    assert.equal(selectCandidates(candidates, { ...needs, requiredTags: [{ name: 'duration', value: 30 }] }, now)[0]?.offer.productId, '3');
    assert.deepEqual(selectCandidates(candidates, { ...needs, budget: { amount: '2', currency: 'CNY', basis: 'purchase' } }, now), []);
    assert.equal(selectCandidates(candidates.slice(0, 2), needs, now).length, 0);
    assert.equal(selectCandidates(candidates, { ...needs, newcomer: false }, now)[0]?.offer.productId, '1');
    assert.equal(selectCandidates(candidates, { ...needs, membershipKinds: ['short_term'] }, now)[0]?.offer.productId, '1');
  }
});

test('newcomer scope trusts classified membership and never guesses from warranty summaries', () => {
  const base = fixture();
  base.standardProduct = { id: '1', name: 'ChatGPT Plus', platform: 'openai', kind: '账号与订阅',
    identity: { family: 'openai', product: 'chatgpt', tier: 'plus' } };
  const good = { ...base, offer: { ...base.offer, membershipKind: 'account' as const, productId: '9', price: '99', tags: [] } };
  for (const value of ['购买后1小时仅保首登', '保订阅30天，封号不保', '保订阅90天']) {
    const other = { ...base, offer: { ...base.offer, tags: [{ name: 'warranty', value }] } };
    assert.equal(selectCandidates([other, good], needs, now, 1)[0]?.offer.productId, '9');
    assert.equal(selectCandidates([other], needs, now).length, 0);
  }
  assert.equal(selectCandidates([good], needs, now).length, 1);
});

test('rental candidates require explicit scope and expose the rental label as evidence', () => {
  const candidate = fixture();
  candidate.standardProduct = { ...candidate.standardProduct, isAiMembership: true };
  candidate.offer = { ...candidate.offer, membershipKind: 'rental' };
  assert.deepEqual(selectCandidates([candidate], needs, now), []);
  assert.equal(selectCandidates([candidate], { ...needs, membershipKinds: ['rental'] }, now).length, 1);
  assert.equal(selectCandidates([candidate], { ...needs, newcomer: false }, now).length, 1);
  assert.match(JSON.stringify(candidateEvidence(candidate)), /租号/u);
  assert.equal(selectCandidates([fixture()], needs, now).length, 1);
});

test('explicit unclassified scope selects only pending AI offers and remains outside newcomer defaults', () => {
  const pending = fixture('1', { membershipKind: null });
  pending.standardProduct = { ...pending.standardProduct, isAiMembership: true };
  const classified = { ...pending, offer: { ...pending.offer, productId: '2', membershipKind: 'account' as const } };
  const nonAi = fixture('3', { membershipKind: null });
  assert.deepEqual(selectCandidates([pending, classified, nonAi], { ...needs, membershipKinds: ['unclassified'] }, now)
    .map(candidate => candidate.offer.productId), ['1']);
  assert.equal(selectCandidates([pending], needs, now).length, 0);
  assert.equal(selectCandidates([pending], { ...needs, membershipKinds: ['short_term'] }, now).length, 0);
  assert.equal(selectCandidates([pending, classified], { ...needs, membershipKinds: ['account', 'unclassified'] }, now).length, 2);
});

test('standard identity gates AI membership and only offer features establish its class', () => {
  const candidate = fixture();
  assert.equal(selectCandidates([candidate], needs, now).length, 1);
  for (const metadata of [
    { isAiMembership: true },
    { identity: { family: 'openai', product: 'chatgpt', tier: 'plus' } },
  ]) {
    const known = { ...candidate, standardProduct: { ...candidate.standardProduct, ...metadata } };
    assert.equal(selectCandidates([known], needs, now).length, 0);
    assert.equal(selectCandidates([known], { ...needs, newcomer: false }, now).length, 1);
  }
  for (const membershipKind of ['account', 'top_up'] as const) {
    const classified = { ...candidate, standardProduct: { ...candidate.standardProduct, isAiMembership: true },
      offer: { ...candidate.offer, membershipKind } };
    assert.equal(selectCandidates([classified], needs, now).length, 1);
  }
  const nonAi = { ...candidate, offer: { ...candidate.offer, membershipKind: 'account' as const } };
  assert.equal(selectCandidates([nonAi], { ...needs, membershipKinds: ['account'] }, now).length, 0);
  assert.ok(!candidateEvidence(nonAi).some(fact => fact.text.startsWith('会员商品特性')));
  assert.equal(selectCandidates([candidate], { ...needs, membershipKinds: ['account'] }, now).length, 0);
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
      ...cheap.offer.tags, { name: 'warranty', value: '保订阅30天，封号不保' },
    ] } };
    assert.equal(selectCandidates([covered, cheap], needs, now, 1)[0]?.offer.productId, '1', name);
  }
});

test('source specifications preserve purchase conditions without turning them into retired tags', () => {
  const facts = candidateEvidence(fixture('1', { spec: '代充给已有账号，需资格账号，禁止转售', tags: [] }));
  assert.ok(facts.some(fact => fact.text.includes('需资格账号，禁止转售')));
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

test('explanation evidence preserves complete warranty terms with candidate-scoped IDs', () => {
  const candidate = fixture('7', { tags: [
    { name: 'sms_verification', value: 'verified' },
    { name: 'warranty', value: '保订阅30天，封号不保；仅限首次登录前申请' },
  ] });
  const facts = candidateEvidence(candidate);
  for (const text of ['已接码', '封号不保', '仅限首次登录前申请', evidence.statement]) {
    assert.ok(facts.some(fact => fact.text.includes(text)), text);
  }
  assert.equal(new Set(facts.map(fact => fact.id)).size, facts.length);
  assert.ok(facts.every(fact => !candidateEvidence(fixture('8')).some(other => other.id === fact.id)));
  assert.ok(!facts.some(fact => /最低|省心|简单/u.test(fact.text)));
  assert.deepEqual(facts, candidateEvidence({ ...candidate, offer: { ...candidate.offer, tags: [...candidate.offer.tags].reverse() } }));
  assert.ok(facts.every(fact => fact.id.length <= 128 && fact.text.length <= 240 && !fact.text.includes('https://')));
  const longTerms = candidateEvidence(fixture('9', { tags: [{ name: 'warranty', value: '保订阅30天，' + '限制'.repeat(120) }] }));
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

test('optional bulk preserves single-item eligibility while required and bundled quantities stay conservative', () => {
  assert.equal(selectCandidates([fixture('1', { tags: [{ name: 'bulk_purchase', value: 'supported' }] })], needs, now).length, 1);
  for (const value of ['required', 'bundle']) {
    for (const settlementQuantity of [1, 10, 0, NaN, Infinity]) {
      assert.deepEqual(selectCandidates([fixture('1', { settlementQuantity, tags: [{ name: 'bulk_purchase', value }] })], needs, now), []);
    }
  }
  assert.deepEqual(selectCandidates([fixture('1', { settlementQuantity: 10, tags: [{ name: 'bulk_purchase', value: 'supported' }] })], needs, now), []);
});

test('retired filters and preferences are rejected rather than silently returning no matches', () => {
  for (const patch of [{ warrantyDaysMin: 30 }, { preferences: ['longer_warranty'] },
    { requiredTags: [{ name: 'minimum_quantity', value: '1' }] }]) {
    assert.throws(() => selectCandidates([fixture()], { ...needs, ...patch } as never, now), /Invalid assistant/u);
  }
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

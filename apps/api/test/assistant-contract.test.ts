import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ASSISTANT_LIMITS, emptyShoppingNeeds, isTurnTerminal, validateAssistantInput,
  validateAssistantReply, validateNeedsPatch, validateSessionSnapshot,
  validateShoppingNeeds, validateTurnSnapshot,
  type AssistantReply, type TurnSnapshot,
} from '@price-comparison/catalog/assistant-contract';
import { applyNeedsPatch, parseUnderstanding, separateProductAttributes } from '../src/assistant/assistant.schemas.js';

test('rental needs, understanding and quote snapshots accept the fourth kind', () => {
  const membershipKinds = ['account', 'top_up', 'rental', 'short_term'];
  assert.deepEqual(validateNeedsPatch({ membershipKinds }), { membershipKinds });
  const understanding = parseUnderstanding({ intent: 'recommend', patch: { membershipKinds: ['rental'] },
    evidence: [{ field: 'membershipKinds', quote: '租号' }], question: null, options: [] }, '只看租号');
  assert.deepEqual(understanding.patch.membershipKinds, ['rental']);
  const offer = { name: 'Rental', shop: 'Shop', spec: '', productUrl: '', tags: [], membershipKind: 'rental' };
  assert.equal(validateAssistantReply({ ...reply(), cards: [{ ...card, offer }] }).cards[0]?.offer?.membershipKind, 'rental');
  for (const kinds of [['rental', 'rental'], [...membershipKinds, 'rental'], ['unknown']]) {
    assert.throws(() => validateNeedsPatch({ membershipKinds: kinds }));
  }
});

test('unclassified is allowed in assistant queries but never as an approved quote kind', () => {
  assert.deepEqual(validateNeedsPatch({ membershipKinds: ['unclassified', 'account'] }),
    { membershipKinds: ['unclassified', 'account'] });
  const understanding = parseUnderstanding({ intent: 'recommend', patch: { membershipKinds: ['unclassified'] },
    evidence: [{ field: 'membershipKinds', quote: '未分类' }], question: null, options: [] }, '只看未分类');
  assert.deepEqual(understanding.patch.membershipKinds, ['unclassified']);
  const offer = { name: 'Pending', shop: 'Shop', spec: '', productUrl: '', tags: [], membershipKind: null };
  assert.equal(validateAssistantReply({ ...reply(), cards: [{ ...card, offer }] }).cards[0]?.offer?.membershipKind, null);
  assert.throws(() => validateAssistantReply({ ...reply(), cards: [{ ...card, offer: { ...offer, membershipKind: 'unclassified' } }] }));
});

test('optional membership preferences validate without rewriting old stored needs', () => {
  const old = emptyShoppingNeeds();
  assert.deepEqual(validateShoppingNeeds(old), old);
  assert.deepEqual(validateNeedsPatch({ membershipKinds: ['short_term'], newcomer: false }),
    { membershipKinds: ['short_term'], newcomer: false });
  assert.deepEqual(applyNeedsPatch(old, { membershipKinds: null, newcomer: true }),
    { ...old, membershipKinds: null, newcomer: true });
  for (const patch of [{ membershipKinds: [] }, { membershipKinds: ['all'] }, { membershipKinds: ['account', 'account'] },
    { membershipKinds: 'account' }, { membershipKinds: undefined }, { newcomer: null }, { newcomer: 'false' }]) {
    assert.throws(() => validateNeedsPatch(patch));
  }
});

test('assistant quote snapshots preserve validated membership kinds while accepting old snapshots', () => {
  const offer = { name: 'Quote', shop: 'Shop', spec: '', productUrl: '', tags: [], membershipKind: 'top_up' };
  const result = validateAssistantReply({ ...reply(), cards: [{ ...card, offer }] });
  assert.equal(result.cards[0]?.offer?.membershipKind, 'top_up');
  assert.throws(() => validateAssistantReply({ ...reply(), cards: [{ ...card, offer: { ...offer, membershipKind: 'all' } }] }));
});

test('product attribute separation uses numeric days and preserves membership words literally', () => {
  const needs = { ...emptyShoppingNeeds(), product: 'ChatGPT Plus 1个月',
    requiredTags: [{ name: 'duration', value: 30 }], budget: { amount: '80', currency: 'CNY', basis: 'purchase' as const } };
  const before = structuredClone(needs);
  const result = separateProductAttributes(needs);
  assert.ok(result);
  assert.equal(result.product, 'chatgpt plus');
  assert.deepEqual(result.requiredTags, needs.requiredTags);
  assert.deepEqual(result.budget, needs.budget);
  assert.deepEqual(needs, before);
  assert.equal(separateProductAttributes({ ...emptyShoppingNeeds(), product: '1个月' }), null);
  assert.equal(separateProductAttributes({ ...needs, requiredTags: [{ name: 'duration', value: 365 }] }), null);
  for (const product of [undefined, 'ChatGPT Plus', 'ChatGPT Plus 代充', 'ChatGPT 商业版', 'ChatGPT Pro 5x']) {
    const plain = { ...emptyShoppingNeeds(), ...(product ? { product } : {}) };
    assert.deepEqual(separateProductAttributes(plain), plain);
  }
});

const sessionId = '12345678-1234-4234-8234-123456789abc';
const clientMessageId = '22345678-1234-4234-8234-123456789abc';
const budget = { amount: '80.00', currency: 'CNY', basis: 'purchase' as const };
const card = {
  standardProductId: '1', productId: '2', shopId: '3', title: 'Example plan',
  price: '50.00', currency: 'CNY', capturedAt: '2026-10-31T01:00:00Z',
  priceExpiresAt: '2026-10-31T02:00:00Z', detailPath: '/products/1',
  reasons: ['Fits the documented purpose'], caveats: ['Check the current quote'],
  evidenceIds: ['capability-1'],
};
const reply = (): AssistantReply => ({
  kind: 'recommendation', text: 'A documented candidate', options: [],
  needs: emptyShoppingNeeds(), cards: [structuredClone(card)],
});
const turn = (): TurnSnapshot => ({
  id: '1', sessionId, clientMessageId, inputText: 'Help me choose',
  expectedRevision: 0, eventVersion: 1, status: 'queued', phase: 'queued',
  reply: null, errorCode: null,
});
const understanding = (patch: unknown = {}, evidence: unknown = []) => ({
  intent: 'recommend', patch, evidence, question: null, options: [],
});

test('reference quote expiry is optional metadata and does not restrict the capture time', () => {
  for (const priceExpiresAt of [null, '2020-01-01T00:00:00Z', card.capturedAt]) {
    assert.equal(validateAssistantReply({ ...reply(), cards: [{ ...card, priceExpiresAt }] })
      .cards[0]?.priceExpiresAt, priceExpiresAt);
  }
  assert.throws(() => validateAssistantReply({ ...reply(), cards: [{ ...card, priceExpiresAt: 'invalid' }] }));
});

test('product choice persists across follow-ups and quote details reject unsafe or malformed data', () => {
  const selected = applyNeedsPatch(emptyShoppingNeeds(), { product: 'ChatGPT Plus' });
  assert.equal(applyNeedsPatch(selected, { preferences: ['lower_price'] }).product, 'ChatGPT Plus');
  const offer = { name: 'Plus 一个月代充', shop: '示例店铺', spec: '一个月',
    productUrl: 'https://shop.invalid/item/2', tags: [{ name: 'duration', value: 30 }] };
  const detailed = { ...reply(), cards: [{ ...card, offer }] };
  assert.deepEqual(validateAssistantReply(detailed).cards[0]?.offer, offer);
  for (const patch of [{ productUrl: 'javascript:alert(1)' }, { productUrl: '//evil.invalid' },
    { tags: [{ name: 'delivery', value: 1 }] }, { name: 'x'.repeat(241) }]) {
    assert.throws(() => validateAssistantReply({ ...detailed, cards: [{ ...card, offer: { ...offer, ...patch } }] }));
  }
  assert.deepEqual(validateAssistantReply(reply()).cards[0], card, 'old stored replies remain readable');
});

test('empty needs have no implicit hard requirements and no shared mutable arrays', () => {
  const first = emptyShoppingNeeds();
  assert.deepEqual(first, {
    purpose: null, platform: null, budget: null, requiredTags: [],
    preferences: [],
  });
  first.requiredTags.push({ name: 'sms_verification', value: 'verified' });
  first.preferences.push('lower_price');
  assert.deepEqual(emptyShoppingNeeds().requiredTags, []);
  assert.deepEqual(emptyShoppingNeeds().preferences, []);
});

test('patch preserves omitted fields, replaces arrays, clears scalars, and never mutates input', () => {
  const current = {
    ...emptyShoppingNeeds(), purpose: 'Read papers', budget,
    requiredTags: [{ name: 'sms_verification', value: 'verified' }],
    preferences: ['simple_setup' as const],
  };
  const saved = structuredClone(current);
  const next = applyNeedsPatch(current, { purpose: null, requiredTags: [], preferences: ['lower_price'] });
  assert.deepEqual(next, { ...saved, purpose: null, requiredTags: [], preferences: ['lower_price'] });
  assert.deepEqual(current, saved);
  assert.deepEqual(applyNeedsPatch(current, { budget: null }).budget, null);
  next.budget!.amount = '1';
  assert.equal(current.budget.amount, '80.00', 'returned state must not alias confirmed needs');
});

test('a price preference preserves an existing hard budget', () => {
  const result = applyNeedsPatch({ ...emptyShoppingNeeds(), budget }, { preferences: ['lower_price'] });
  assert.deepEqual(result.budget, budget);
  assert.deepEqual(result.preferences, ['lower_price']);
});

test('strict needs and patches reject unknown fields, undefined, wrong shapes and non-finite integers', () => {
  for (const value of [null, [], 'needs', {}, { ...emptyShoppingNeeds(), extra: true },
    { ...emptyShoppingNeeds(), purpose: undefined }, { ...emptyShoppingNeeds(), preferences: null },
    { ...emptyShoppingNeeds(), warrantyDaysMin: Infinity },
    { ...emptyShoppingNeeds(), warrantyDaysMin: -1 }, { ...emptyShoppingNeeds(), warrantyDaysMin: 1.5 },
    { ...emptyShoppingNeeds(), preferences: ['lower_price', 'lower_price'] },
    { ...emptyShoppingNeeds(), preferences: ['newcomer'] }]) {
    assert.throws(() => validateShoppingNeeds(value), JSON.stringify(value));
  }
  for (const patch of [{ newcomer: 'true' }, { purpose: undefined }, { requiredTags: null },
    { budget: { ...budget, raw: 'secret' } }, JSON.parse('{"__proto__":{}}')]) {
    assert.throws(() => validateNeedsPatch(patch));
    assert.throws(() => applyNeedsPatch(emptyShoppingNeeds(), patch as never));
  }
  assert.deepEqual(validateNeedsPatch({}), {});
  assert.deepEqual(validateShoppingNeeds(emptyShoppingNeeds()), emptyShoppingNeeds());
});

test('budget amounts retain exact decimal strings and reject malformed or unbounded money', () => {
  for (const amount of ['0', '0.00', '50', '50.1', '50.12']) {
    assert.equal(validateNeedsPatch({ budget: { ...budget, amount } }).budget?.amount, amount);
  }
  for (const amount of ['-1', '+1', '.5', '1.', '1.001', '1e3', 'NaN', 'Infinity', ' 1', '1,000', '9'.repeat(100), 12]) {
    assert.throws(() => validateNeedsPatch({ budget: { ...budget, amount } }));
    assert.throws(() => validateAssistantReply({ ...reply(), cards: [{ ...card, price: amount }] }));
  }
  for (const patch of [{ currency: 'cny' }, { currency: 'CN' }, { currency: 'CNY\n' }, { basis: 'year' }]) {
    assert.throws(() => validateNeedsPatch({ budget: { ...budget, ...patch } }));
  }
});

test('required tags use the canonical policy and reject duplicate or mutually exclusive same-name values', () => {
  assert.deepEqual(validateNeedsPatch({ requiredTags: [{ name: 'sms_verification', value: 'verified' }] }),
    { requiredTags: [{ name: 'sms_verification', value: 'verified' }] });
  for (const requiredTags of [
    [{ name: 'access', value: 'exclusive' }], [{ name: '访问方式', value: '独享' }],
    [{ name: 'made_up', value: 'yes' }], [{ name: 'sms_verification', value: 'verified', count: 1 }],
    [{ name: 'sms_verification', value: 'verified' }, { name: 'sms_verification', value: 'unverified' }],
    [{ name: 'sms_verification', value: 'verified' }, { name: 'sms_verification', value: 'verified' }],
  ]) assert.throws(() => validateNeedsPatch({ requiredTags }));
  // Multiple values explicitly supported by the existing policy remain valid.
  assert.equal(validateNeedsPatch({ requiredTags: [
    { name: 'region', value: 'us' }, { name: 'region', value: 'jp' },
  ] }).requiredTags?.length, 2);
});

test('required tags and offer snapshots use the same typed canonical validation', () => {
  for (const value of [0.5, 30, 90, 365, { kind: 'range', min: 30, max: 60 },
    { kind: 'min', days: 30 }, { kind: 'max', days: 30 }, { kind: 'approx', days: 30 }, { kind: 'permanent' }]) {
    const tags = [{ name: 'duration', value }];
    assert.deepEqual(validateNeedsPatch({ requiredTags: tags }).requiredTags, tags);
    const offer = { name: 'Quote', shop: 'Shop', spec: '', productUrl: '', tags };
    assert.deepEqual(validateAssistantReply({ ...reply(), cards: [{ ...card, offer }] }).cards[0]?.offer?.tags, tags);
  }
  for (const tag of [
    { name: 'duration', value: '30' }, { name: 'duration', value: '1 month' },
    { name: 'duration', value: 0 }, { name: 'duration', value: -1 }, { name: 'duration', value: Infinity },
    { name: 'duration', value: { kind: 'range', min: 60, max: 30 } },
    { name: 'duration', value: { kind: 'min', days: 30, unit: 'day' } },
    { name: 'warranty', value: '' }, { name: 'warranty', value: 'x'.repeat(251) }, { name: 'warranty_days', value: '30' },
    { name: 'subscription_override', value: '有' }, { name: 'delivery', value: 'account' },
    { name: 'bulk_purchase', value: 'unknown' },
  ]) {
    assert.throws(() => validateNeedsPatch({ requiredTags: [tag] }));
    const offer = { name: 'Quote', shop: 'Shop', spec: '', productUrl: '', tags: [tag] };
    assert.throws(() => validateAssistantReply({ ...reply(), cards: [{ ...card, offer }] }));
  }
  for (const value of ['到手一小时内无法使用可联系处理', 'covered', '无质保']) {
    const tags = [{ name: 'warranty', value }];
    assert.deepEqual(validateNeedsPatch({ requiredTags: tags }).requiredTags, tags);
    const offer = { name: 'Quote', shop: 'Shop', spec: '', productUrl: '', tags };
    assert.deepEqual(validateAssistantReply({ ...reply(), cards: [{ ...card, offer }] }).cards[0]?.offer?.tags, tags);
  }
  const original = { ...emptyShoppingNeeds(), requiredTags: [{ name: 'duration', value: { kind: 'min' as const, days: 30 } }] };
  const patched = applyNeedsPatch(original, {});
  (patched.requiredTags[0]!.value as { days: number }).days = 60;
  assert.equal(original.requiredTags[0]!.value.days, 30);
  assert.throws(() => validateNeedsPatch({ warrantyDaysMin: null }));
  assert.throws(() => validateNeedsPatch({ preferences: ['longer_warranty'] }));
});

test('each changed field requires a nonempty verbatim quote from the current message', () => {
  const valid = understanding({ purpose: 'Read papers' }, [{ field: 'purpose', quote: 'Read papers' }]);
  assert.deepEqual(parseUnderstanding(valid, 'Please help me Read papers'), valid);
  for (const evidence of [[], [{ field: 'purpose', quote: 'read papers' }],
    [{ field: 'purpose', quote: '' }], [{ field: 'purpose', quote: ' ' }],
    [{ field: 'platform', quote: 'Read papers' }], [{ field: 'unknown', quote: 'Read papers' }],
    [{ field: 'purpose', quote: 'Read papers', source: 'model' }]]) {
    assert.throws(() => parseUnderstanding(understanding({ purpose: 'Read papers' }, evidence), 'Read papers'));
  }
  assert.throws(() => parseUnderstanding(understanding({ purpose: null }), 'Clear purpose'));
  assert.throws(() => parseUnderstanding(understanding({ requiredTags: [] }), 'Shared is fine'));
});

test('understanding rejects unknown keys and malformed question/options combinations', () => {
  for (const value of [{ ...understanding(), raw: 'provider' }, { ...understanding(), intent: 'buy' },
    { ...understanding(), question: undefined }, { ...understanding(), options: ['A'] },
    { ...understanding(), intent: 'clarify' },
    { ...understanding(), intent: 'clarify', question: 'Which?', options: ['A', 'A'] },
    { ...understanding(), intent: 'clarify', question: 'Which?', options: Array(5).fill('A') }]) {
    assert.throws(() => parseUnderstanding(value, 'Help'));
  }
  const valid = { ...understanding(), intent: 'clarify', question: 'Which budget basis?', options: ['Monthly', 'This purchase'] };
  assert.deepEqual(parseUnderstanding(valid, 'Help'), valid);
});

test('clarification permits explanatory statements and one question, but no links or unsupported guarantees', () => {
  const valid = { ...understanding(), intent: 'clarify', question: '预算口径会影响结果。是每月预算吗？', options: ['每月预算', '本次付款'] };
  assert.deepEqual(parseUnderstanding(valid, 'Help'), valid);
  for (const unsafe of [
    '每月预算吗？还是本次付款？', 'Monthly? Purchase?', '看 https://example.test',
    '看 www.example.test', '[详情](/products/42)', '[详情](//example.test)', '<a href="/products/42">详情</a>',
    '保证不封号', '绝对安全', '全网最低', '保证永不封号', '100%安全',
  ]) {
    assert.throws(() => parseUnderstanding({ ...valid, question: unsafe }, 'Help'), unsafe);
    assert.throws(() => parseUnderstanding({ ...valid, options: [unsafe] }, 'Help'), unsafe);
    assert.throws(() => validateAssistantReply({ kind: 'question', text: unsafe,
      options: [], needs: emptyShoppingNeeds(), cards: [] }), unsafe);
  }
});

test('ambiguous price and warranty preferences cannot silently become hard requirements', () => {
  const cases = [
    ['便宜一点就行', { budget }, 'budget'],
    ['尽量50元以内', { budget: { ...budget, amount: '50' } }, 'budget'],
    ['质保尽量长一点', { warrantyDaysMin: 30 }, 'warrantyDaysMin'],
    ['最好已接码', { requiredTags: [{ name: 'sms_verification', value: 'verified' }] }, 'requiredTags'],
    ['我是新手', { warrantyDaysMin: 30 }, 'warrantyDaysMin'],
    ['我是新手', { membershipKinds: ['account', 'top_up'] }, 'membershipKinds'],
    ['便宜一点', { newcomer: false }, 'newcomer'],
    ['不要关闭新手模式', { newcomer: false }, 'newcomer'],
  ] as const;
  for (const [text, patch, field] of cases) {
    assert.throws(() => parseUnderstanding(understanding(patch, [{ field, quote: text }]), text));
  }
  const preference = understanding({ preferences: ['lower_price'] }, [{ field: 'preferences', quote: '便宜一点' }]);
  assert.deepEqual(parseUnderstanding(preference, '便宜一点'), preference);
  for (const text of ['最多50元人民币，本次付款', '不要未接码，必须已接码']) {
    const patch = text.includes('50') ? { budget: { ...budget, amount: '50' } }
      : { requiredTags: [{ name: 'sms_verification', value: 'verified' }] };
    const field = text.includes('50') ? 'budget' : 'requiredTags';
    assert.deepEqual(parseUnderstanding(understanding(patch, [{ field, quote: text }]), text).patch, patch);
  }
  assert.deepEqual(parseUnderstanding(understanding({ requiredTags: [] },
    [{ field: 'requiredTags', quote: '共享也行' }]), '共享也行').patch, { requiredTags: [] });
});

test('soft preferences cannot be used as evidence for removing confirmed hard requirements', () => {
  for (const [patch, field] of [
    [{ budget: null }, 'budget'],
    [{ warrantyDaysMin: null }, 'warrantyDaysMin'],
    [{ requiredTags: [] }, 'requiredTags'],
  ] as const) {
    assert.throws(() => parseUnderstanding(understanding(patch,
      [{ field, quote: '便宜一点' }]), '便宜一点'));
  }
  assert.equal(parseUnderstanding(understanding({ budget: null },
    [{ field: 'budget', quote: '取消预算限制' }]), '取消预算限制').patch.budget, null);
});

test('literal evidence may express amounts in Chinese without an invented numeric-text parser', () => {
  const text = '本次最多五十元人民币';
  const value = understanding({ budget: { amount: '50', currency: 'CNY', basis: 'purchase' } },
    [{ field: 'budget', quote: text }]);
  assert.deepEqual(parseUnderstanding(value, text), value);
});

test('message and nested payload bounds reject excessive data without truncation', () => {
  assert.equal(validateAssistantInput('x'.repeat(2000)).length, 2000);
  for (const text of ['', ' \n ', 'x'.repeat(2001), 'x\u0000', 12]) {
    assert.throws(() => validateAssistantInput(text));
  }
  for (const value of [{ ...reply(), text: 'x'.repeat(1201) },
    { ...reply(), cards: Array(4).fill(card) }, { ...reply(), options: Array(5).fill('A') },
    { ...reply(), options: ['x'.repeat(10000)] },
    { ...reply(), cards: [{ ...card, reasons: ['x'.repeat(10000)] }] },
    { ...reply(), cards: [{ ...card, evidenceIds: Array(100).fill('e') }] }]) {
    assert.throws(() => validateAssistantReply(value));
  }
  assert.throws(() => validateNeedsPatch({ purpose: 'x'.repeat(2001) }));
  assert.throws(() => parseUnderstanding({ ...understanding(), raw: 'x'.repeat(ASSISTANT_LIMITS.outputMaxBytes) }, 'Help'));
});

test('reply validates complete cards and rejects extra fields and unsafe or mismatched detail links', () => {
  assert.deepEqual(validateAssistantReply(reply()), reply());
  for (const detailPath of ['https://evil.test/products/1', '//evil.test/products/1',
    'javascript:alert(1)', '/products/1?redirect=evil', '/products/1#x', '/products/../1',
    '/products/%31', '/products/2', '/products/3', '/products/1\n', '/products\\1']) {
    assert.throws(() => validateAssistantReply({ ...reply(), cards: [{ ...card, detailPath }] }));
  }
  for (const patch of [{ productId: 2 }, { shopId: '-1' }, { standardProductId: '0' },
    { capturedAt: '2026-02-30T01:00:00Z' }, { priceExpiresAt: 'yesterday' },
    { inventoryExpiresAt: '2026-10-31T02:00:00Z' }, { evidenceIds: [] }, { reasons: [] }]) {
    assert.throws(() => validateAssistantReply({ ...reply(), cards: [{ ...card, ...patch }] }));
  }
  for (const value of [{ ...reply(), raw: 'secret' }, { ...reply(), text: '' },
    { ...reply(), kind: 'unknown' }, { ...reply(), kind: 'question' },
    { ...reply(), cards: [card, card] }, { ...reply(), needs: { ...emptyShoppingNeeds(), newcomer: 'true' } }]) {
    assert.throws(() => validateAssistantReply(value));
  }
});

test('detail routes use the standard product ID rather than the source product ID', () => {
  const standardCard = { ...card, standardProductId: '42', productId: '9', detailPath: '/products/42' };
  assert.equal(validateAssistantReply({ ...reply(), cards: [standardCard] }).cards[0].detailPath, '/products/42');
  assert.throws(() => validateAssistantReply({
    ...reply(), cards: [{ ...standardCard, detailPath: '/products/9' }],
  }));
});

test('turn snapshots enforce identifiers, revisions and terminal reply/error consistency', () => {
  assert.deepEqual(validateTurnSnapshot(turn()), turn());
  const succeeded = { ...turn(), status: 'succeeded', phase: 'succeeded', reply: reply() };
  assert.deepEqual(validateTurnSnapshot(succeeded), succeeded);
  const failed = { ...turn(), status: 'failed', phase: 'failed', errorCode: 'invalid_response' };
  assert.deepEqual(validateTurnSnapshot(failed), failed);
  assert.equal(isTurnTerminal('succeeded'), true);
  assert.equal(isTurnTerminal('failed'), true);
  assert.equal(isTurnTerminal('cancelled'), true);
  assert.equal(isTurnTerminal('queued'), false);
  assert.equal(isTurnTerminal('running'), false);
  for (const patch of [{ id: '01' }, { id: '9223372036854775808' }, { sessionId: 'session' },
    { clientMessageId: 'message' }, { expectedRevision: -1 }, { expectedRevision: 0.5 },
    { eventVersion: Number.MAX_SAFE_INTEGER + 1 }, { status: 'done' }, { phase: 'unknown' },
    { status: 'running', phase: 'queued' }, { reply: reply() },
    { status: 'succeeded', phase: 'succeeded' }, { status: 'failed', phase: 'failed' },
    { errorCode: 'https://provider.test/secret' }, { raw: 'secret' }]) {
    assert.throws(() => validateTurnSnapshot({ ...turn(), ...patch }));
  }
  assert.throws(() => validateTurnSnapshot({ ...succeeded, errorCode: 'provider_error' }));
  assert.throws(() => validateTurnSnapshot({ ...failed, reply: reply() }));
});

test('terminal snapshots may retain the last processing phase used by storage', () => {
  for (const phase of ['understanding', 'searching', 'explaining']) {
    assert.equal(validateTurnSnapshot({ ...turn(), status: 'succeeded', phase, reply: reply() }).phase, phase);
    assert.equal(validateTurnSnapshot({ ...turn(), status: 'failed', phase, errorCode: 'invalid_response' }).phase, phase);
  }
  assert.equal(validateTurnSnapshot({ ...turn(), status: 'cancelled' }).phase, 'queued');
});

test('repository failed and cancelled snapshots preserve uppercase public error codes', () => {
  for (const [status, phase, errorCode] of [
    ['cancelled', 'queued', 'CANCELLED'],
    ['cancelled', 'explaining', 'CANCELLED'],
    ['failed', 'queued', 'TURN_TIMEOUT'],
    ['failed', 'understanding', 'REQUEST_OUTCOME_UNKNOWN'],
    ['failed', 'explaining', 'MODEL_INVALID_RESPONSE'],
    ['failed', 'searching', 'provider_error'],
    ['failed', 'searching', 'Provider_Error_2'],
  ] as const) {
    const snapshot = { ...turn(), status, phase, errorCode };
    assert.deepEqual(validateTurnSnapshot(snapshot), snapshot);
    assert.deepEqual(validateSessionSnapshot({
      id: sessionId, revision: 0, needs: emptyShoppingNeeds(), turns: [snapshot],
    }).turns[0], snapshot);
  }
  for (const errorCode of ['1_ERROR', '_ERROR', 'MODEL-ERROR', 'MODEL ERROR',
    'MODEL.ERROR', '错误', 'MODEL_ERROR\n', 'https://provider.test/secret', 'E'.repeat(65)]) {
    assert.throws(() => validateTurnSnapshot({
      ...turn(), status: 'failed', phase: 'explaining', errorCode,
    }), errorCode);
  }
});

test('session snapshots reject cross-session turns, duplicates and concurrent active turns', () => {
  const session = { id: sessionId, revision: 0, needs: emptyShoppingNeeds(), turns: [turn()] };
  assert.deepEqual(validateSessionSnapshot(session), session);
  for (const patch of [{ turns: [turn(), turn()] },
    { turns: [{ ...turn(), sessionId: clientMessageId }] },
    { turns: [turn(), { ...turn(), id: '2', clientMessageId: sessionId }] },
    { revision: -1 }, { revision: 31 }, { revision: 1.5 }, { revision: Number.MAX_SAFE_INTEGER + 1 },
    { turns: [{ ...turn(), expectedRevision: 1 }] }, { extra: true }]) {
    assert.throws(() => validateSessionSnapshot({ ...session, ...patch }));
  }
});

test('long conversations preserve full history and accept revisions beyond thirty', () => {
  const turns = Array.from({ length: 100 }, (_, index) => ({
    ...turn(), id: String(index + 1),
    clientMessageId: `${String(index + 1).padStart(8, '0')}-1234-4234-8234-123456789abc`,
    expectedRevision: index, status: 'succeeded' as const, phase: 'succeeded' as const, reply: reply(),
  }));
  const ending: TurnSnapshot[] = ['failed', 'cancelled', 'queued'].map((status, index) => ({
    ...turn(), id: String(101 + index),
    clientMessageId: `${String(101 + index).padStart(8, '0')}-1234-4234-8234-123456789abc`,
    expectedRevision: 100, status: status as TurnSnapshot['status'],
    phase: status === 'queued' ? 'queued' : 'searching', errorCode: status === 'failed' ? 'MODEL_ERROR' : null,
  }));
  const session = { id: sessionId, revision: 100, needs: emptyShoppingNeeds(), turns: [...turns, ...ending] };
  assert.deepEqual(validateSessionSnapshot(session), session);
  assert.deepEqual(validateTurnSnapshot(ending[2]), ending[2]);
  assert.throws(() => validateSessionSnapshot({ ...session, revision: 99 }));
  assert.throws(() => validateSessionSnapshot({ ...session, turns: [...turns, { ...ending[2], expectedRevision: 99 }] }));
  assert.throws(() => validateSessionSnapshot({ ...session, turns: [...turns, ending[2], ending[0]] }));
});

test('session snapshots preserve chronological revision history across success, failure and active work', () => {
  const success = { ...turn(), status: 'succeeded', phase: 'succeeded', reply: reply() };
  const failure = { ...turn(), id: '2', clientMessageId: sessionId, expectedRevision: 1,
    status: 'failed', phase: 'failed', errorCode: 'invalid_response' };
  const active = { ...turn(), id: '3', clientMessageId: '32345678-1234-4234-8234-123456789abc', expectedRevision: 1 };
  const session = { id: sessionId, revision: 1, needs: emptyShoppingNeeds(), turns: [success, failure, active] };
  assert.deepEqual(validateSessionSnapshot(session), session);
  for (const patch of [{ revision: 0 }, { revision: 2 },
    { turns: [success, { ...active, expectedRevision: 0 }] },
    { turns: [success, active, failure] },
    { turns: [failure, success] }]) {
    assert.throws(() => validateSessionSnapshot({ ...session, ...patch }));
  }
});

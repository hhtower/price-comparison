import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ASSISTANT_LIMITS, emptyShoppingNeeds, isTurnTerminal, validateAssistantInput,
  validateAssistantReply, validateNeedsPatch, validateSessionSnapshot,
  validateShoppingNeeds, validateTurnSnapshot,
  type AssistantReply, type TurnSnapshot,
} from '@price-comparison/catalog/assistant-contract';
import { applyNeedsPatch, parseUnderstanding } from '../src/assistant/assistant.schemas.js';

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

test('empty needs have no implicit hard requirements and no shared mutable arrays', () => {
  const first = emptyShoppingNeeds();
  assert.deepEqual(first, {
    purpose: null, platform: null, budget: null, requiredTags: [],
    warrantyDaysMin: null, preferences: [],
  });
  first.requiredTags.push({ name: 'access', value: 'dedicated' });
  first.preferences.push('lower_price');
  assert.deepEqual(emptyShoppingNeeds().requiredTags, []);
  assert.deepEqual(emptyShoppingNeeds().preferences, []);
});

test('patch preserves omitted fields, replaces arrays, clears scalars, and never mutates input', () => {
  const current = {
    ...emptyShoppingNeeds(), purpose: 'Read papers', budget,
    requiredTags: [{ name: 'access', value: 'dedicated' }],
    preferences: ['simple_setup' as const], warrantyDaysMin: 30,
  };
  const saved = structuredClone(current);
  const next = applyNeedsPatch(current, { purpose: null, requiredTags: [], preferences: ['lower_price'] });
  assert.deepEqual(next, { ...saved, purpose: null, requiredTags: [], preferences: ['lower_price'] });
  assert.deepEqual(current, saved);
  assert.deepEqual(applyNeedsPatch(current, { budget: null, warrantyDaysMin: null }).budget, null);
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
  for (const patch of [{ newcomer: true }, { purpose: undefined }, { requiredTags: null },
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
  assert.deepEqual(validateNeedsPatch({ requiredTags: [{ name: 'access', value: 'dedicated' }] }),
    { requiredTags: [{ name: 'access', value: 'dedicated' }] });
  for (const requiredTags of [
    [{ name: 'access', value: 'exclusive' }], [{ name: '访问方式', value: '独享' }],
    [{ name: 'made_up', value: 'yes' }], [{ name: 'access', value: 'dedicated', count: 1 }],
    [{ name: 'access', value: 'dedicated' }, { name: 'access', value: 'shared' }],
    [{ name: 'access', value: 'dedicated' }, { name: 'access', value: 'dedicated' }],
  ]) assert.throws(() => validateNeedsPatch({ requiredTags }));
  // Multiple values explicitly supported by the existing policy remain valid.
  assert.equal(validateNeedsPatch({ requiredTags: [
    { name: 'device_platform', value: 'ios' }, { name: 'device_platform', value: 'android' },
  ] }).requiredTags?.length, 2);
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
    ['最好独享', { requiredTags: [{ name: 'access', value: 'dedicated' }] }, 'requiredTags'],
    ['我是新手', { warrantyDaysMin: 30 }, 'warrantyDaysMin'],
  ] as const;
  for (const [text, patch, field] of cases) {
    assert.throws(() => parseUnderstanding(understanding(patch, [{ field, quote: text }]), text));
  }
  const preference = understanding({ preferences: ['lower_price'] }, [{ field: 'preferences', quote: '便宜一点' }]);
  assert.deepEqual(parseUnderstanding(preference, '便宜一点'), preference);
  for (const text of ['最多50元人民币，本次付款', '不要共享，必须独享']) {
    const patch = text.includes('50') ? { budget: { ...budget, amount: '50' } }
      : { requiredTags: [{ name: 'access', value: 'dedicated' }] };
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
    { priceExpiresAt: card.capturedAt }, { priceExpiresAt: '2026-10-30T01:00:00Z' },
    { inventoryExpiresAt: '2026-10-31T02:00:00Z' }, { evidenceIds: [] }, { reasons: [] }]) {
    assert.throws(() => validateAssistantReply({ ...reply(), cards: [{ ...card, ...patch }] }));
  }
  for (const value of [{ ...reply(), raw: 'secret' }, { ...reply(), text: '' },
    { ...reply(), kind: 'unknown' }, { ...reply(), kind: 'question' },
    { ...reply(), cards: [card, card] }, { ...reply(), needs: { ...emptyShoppingNeeds(), newcomer: true } }]) {
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

test('session snapshots reject cross-session turns, duplicates, excessive history and concurrent active turns', () => {
  const session = { id: sessionId, revision: 0, needs: emptyShoppingNeeds(), turns: [turn()] };
  assert.deepEqual(validateSessionSnapshot(session), session);
  for (const patch of [{ turns: [turn(), turn()] },
    { turns: [{ ...turn(), sessionId: clientMessageId }] },
    { turns: [turn(), { ...turn(), id: '2', clientMessageId: sessionId }] },
    { turns: Array(31).fill(turn()) }, { revision: -1 }, { revision: 31 },
    { turns: [{ ...turn(), expectedRevision: 1 }] }, { extra: true }]) {
    assert.throws(() => validateSessionSnapshot({ ...session, ...patch }));
  }
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

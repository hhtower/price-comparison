import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyShoppingNeeds, validateSessionSnapshot } from '@price-comparison/catalog/assistant-contract';
import { persistedNeeds, persistedReply, turnSnapshot } from '../src/assistant/assistant.repository.js';

test('obsolete persisted conditions are explicitly invalidated without translating any fields', () => {
  for (const patch of [{ warrantyDaysMin: null }, { warrantyDaysMin: 30 }, { preferences: ['longer_warranty'] },
    { requiredTags: [{ name: 'access', value: 'dedicated' }] },
    { requiredTags: [{ name: 'duration', value: '1 month' }] }]) {
    const value = { ...emptyShoppingNeeds(), platform: 'openai', product: 'ChatGPT Plus',
      budget: { amount: '80', currency: 'CNY', basis: 'purchase' },
      membershipKinds: ['top_up'], newcomer: false, ...patch };
    const before = structuredClone(value);
    assert.deepEqual(persistedNeeds(value), { needs: emptyShoppingNeeds(), needsInvalidated: true });
    assert.deepEqual(value, before);
  }
  assert.deepEqual(persistedNeeds(emptyShoppingNeeds()), { needs: emptyShoppingNeeds() });
});

test('historical replies retain text, cards, IDs and revisions when filters expire', () => {
  const id = '12345678-1234-4234-8234-123456789abc';
  const needs = { ...emptyShoppingNeeds(), platform: 'openai', product: 'ChatGPT Plus',
    budget: { amount: '80', currency: 'CNY', basis: 'purchase' },
    membershipKinds: ['top_up'], newcomer: false, warrantyDaysMin: 30 };
  const reply = {
    kind: 'recommendation', text: 'Historical recommendation', options: [], needs,
    cards: [{
      standardProductId: '1', productId: '2', shopId: '3', title: 'Historical quote',
      price: '12.00', currency: 'CNY', capturedAt: '2026-11-01T00:00:00Z', priceExpiresAt: null,
      detailPath: '/products/1', reasons: ['Historical reason'], caveats: ['Historical caveat'], evidenceIds: ['historical-evidence'],
      offer: { name: 'Quote', shop: 'Shop', spec: 'Full original conditions', productUrl: '',
        tags: [{ name: 'duration', value: '1 month' }, { name: 'region', value: 'us' }] },
    }],
  };
  const before = structuredClone(reply);
  const archived = persistedReply(reply);
  assert.equal(archived.text, reply.text);
  assert.equal(archived.needsInvalidated, true);
  assert.deepEqual(archived.needs, emptyShoppingNeeds());
  assert.equal(archived.cards[0]?.offer?.spec, 'Full original conditions');
  assert.deepEqual(archived.cards[0]?.offer?.tags, [{ name: 'region', value: 'us' }]);
  assert.deepEqual(archived.cards[0]?.reasons, reply.cards[0]?.reasons);
  const turn = turnSnapshot({
    id: 1n, session_id: id, client_message_id: id, input_text: 'Original user message',
    expected_revision: 0, event_version: 4, status: 'succeeded', phase: 'explaining', reply, error_code: null,
  } as never);
  const session = validateSessionSnapshot({ id, revision: 1, ...persistedNeeds(needs), turns: [turn] });
  assert.equal(session.needsInvalidated, true);
  assert.deepEqual(session.needs, emptyShoppingNeeds(), 'invalidated snapshots retain no active scope or coerced filters');
  assert.equal(session.revision, 1);
  assert.equal(session.turns[0]?.inputText, 'Original user message');
  assert.equal(session.turns[0]?.reply?.text, reply.text);
  assert.deepEqual(reply, before, 'reading must not rewrite persisted history');
});

test('archive reads still reject malformed cards and unsafe links', () => {
  const reply = { kind: 'question', text: 'Original question', options: [],
    needs: { ...emptyShoppingNeeds(), warrantyDaysMin: 30 }, cards: [{ productId: '2' }] };
  assert.throws(() => persistedReply(reply));
  assert.throws(() => persistedReply(null));
  assert.throws(() => validateSessionSnapshot({
    id: '12345678-1234-4234-8234-123456789abc', revision: 0,
    needs: emptyShoppingNeeds(), turns: [], needsInvalidated: 'true',
  }));
});

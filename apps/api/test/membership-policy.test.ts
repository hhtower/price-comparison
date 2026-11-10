import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AI_MEMBERSHIP_TIERS, MEMBERSHIP_POLICY_VERSION,
  isAiMembership, membershipKindLabel,
} from '../../../packages/catalog/src/membership-policy.js';
import { FINITE_CATALOG } from '../src/standardization/identity-policy.js';

const identity = { family: 'openai', product: 'chatgpt', tier: 'plus' };
test('membership applies to exactly the existing paid tiers of the five approved products', () => {
  const products = ['openai/chatgpt', 'anthropic/claude', 'google/gemini', 'xai/grok', 'cursor/cursor'];
  assert.deepEqual(Object.keys(AI_MEMBERSHIP_TIERS).sort(), [...products].sort());
  for (const product of products) {
    assert.deepEqual(AI_MEMBERSHIP_TIERS[product], FINITE_CATALOG[product].filter(tier => !['free', 'tutorial'].includes(tier)));
  }
  assert.ok(MEMBERSHIP_POLICY_VERSION.trim());
  for (const [key, tiers] of Object.entries(FINITE_CATALOG)) {
    const [family, product] = key.split('/');
    for (const tier of tiers) {
      const candidate = { family, product, tier };
      const applicable = products.includes(key) && !['free', 'tutorial'].includes(tier);
      assert.equal(isAiMembership(candidate), applicable, `${key}/${tier}`);
    }
  }
  for (const candidate of [
    { ...identity, family: 'google' }, { ...identity, tier: 'pro' },
    { ...identity, tier: 'unknown' }, { ...identity, tier: 'Plus' },
    { ...identity, tier: '' }, { ...identity, product: 'codex' },
    { family: 'cursor', product: 'cursor', tier: 'team' },
    { family: 'google', product: 'gemini', tier: 'free' },
    { family: 'anthropic', product: 'claude', tier: 'tutorial' },
    { family: 'training', product: 'course', tier: 'standard' },
    { family: 'openai/chatgpt', product: '', tier: 'plus' },
  ]) {
    assert.equal(isAiMembership(candidate), false, JSON.stringify(candidate));
  }
});

test('membership labels distinguish the four customer-facing categories', () => {
  assert.equal(membershipKindLabel('account'), '成品号');
  assert.equal(membershipKindLabel('top_up'), '代充');
  assert.equal(membershipKindLabel('short_term'), '短期');
  assert.equal(membershipKindLabel('rental'), '租号');
});

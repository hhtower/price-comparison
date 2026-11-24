import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AI_MEMBERSHIP_TIERS, MEMBERSHIP_POLICY_VERSION,
  MEMBERSHIP_BRANCH_PARENTS, MEMBERSHIP_BRANCH_POLICIES, MEMBERSHIP_KINDS, type MembershipKind,
  isAiMembership, membershipKindLabel, membershipGroupKinds, membershipBranches, membershipFilterKinds, normalizeMembershipSelection,
  membershipGroupingVersion, membershipSelections, membershipSearchKinds, membershipSearchPattern, isNewcomerMembership, newcomerMembershipKinds,
} from '../../../packages/catalog/src/membership-policy.js';
import { FINITE_CATALOG } from '../src/standardization/identity-policy.js';

const identity = { family: 'openai', product: 'chatgpt', tier: 'plus' };
test('branch declarations keep one parent and one label per product branch', () => {
  const seen = new Set<string>();
  for (const policy of MEMBERSHIP_BRANCH_POLICIES) {
    assert(isAiMembership(policy.identity));
    assert(policy.defaultLabel.trim());
    for (const branch of policy.branches) {
      assert.equal(MEMBERSHIP_BRANCH_PARENTS[branch.kind], policy.parent);
      assert(branch.label.trim());
      const key = JSON.stringify([policy.identity, branch.kind]);
      assert(!seen.has(key));
      seen.add(key);
    }
  }
});

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

test('product branch policies specialize labels and choices without changing base categories', () => {
  assert.equal(membershipKindLabel('account'), '成品号');
  assert.equal(membershipKindLabel('top_up'), '代充');
  assert.equal(membershipKindLabel('top_up', identity), '代充 · 通用');
  assert.equal(membershipKindLabel('top_up_half_price', identity), '代充 · 半价资格');
  assert.ok(membershipGroupKinds(identity).includes('top_up_half_price'));
  assert.deepEqual(membershipFilterKinds('top_up', undefined), ['top_up', 'top_up_half_price']);
  assert.deepEqual(membershipFilterKinds('top_up', identity), ['top_up']);
  for (const candidate of [
    { ...identity, tier: 'pro_5x' }, { family: 'xai', product: 'grok', tier: 'plus' },
    { family: 'google', product: 'gemini', tier: 'plus' }, undefined,
  ]) {
    assert.equal(membershipKindLabel('top_up', candidate), '代充');
    assert.equal(membershipGroupKinds(candidate).includes('top_up_half_price'), false);
    assert.deepEqual(membershipBranches(candidate), []);
  }
  assert.equal(membershipKindLabel('short_term'), '短期');
  assert.equal(membershipKindLabel('rental'), '租号');
});

test('changing product scope preserves the selected parent category', () => {
  const other = { family: 'xai', product: 'grok', tier: 'plus' };
  assert.deepEqual(normalizeMembershipSelection(['top_up_half_price'], other), ['top_up']);
  assert.deepEqual(normalizeMembershipSelection(['top_up_half_price'], undefined), ['top_up', 'top_up_half_price']);
  assert.deepEqual(normalizeMembershipSelection(['top_up'], undefined), ['top_up', 'top_up_half_price']);
  assert.deepEqual(normalizeMembershipSelection(['top_up', 'top_up_half_price'], identity), ['top_up', 'top_up_half_price']);
  assert.deepEqual(normalizeMembershipSelection(['top_up_half_price', 'rental'], other), ['top_up', 'rental']);
  assert.deepEqual(normalizeMembershipSelection([], undefined), []);
});

test('global chips represent complete selections while product-specific branches remain separate', () => {
  const kinds = ['top_up', 'top_up_half_price'] as const;
  assert.deepEqual(membershipSelections(kinds, undefined), [{ kind: 'top_up', kinds: [...kinds] }]);
  assert.deepEqual(membershipSelections(kinds, identity), [
    { kind: 'top_up', kinds: ['top_up'] }, { kind: 'top_up_half_price', kinds: ['top_up_half_price'] },
  ]);
  assert.deepEqual(membershipSelections(['top_up_half_price'], undefined),
    [{ kind: 'top_up_half_price', kinds: ['top_up_half_price'] }]);
  assert.deepEqual(membershipSelections(['top_up'], undefined), [{ kind: 'top_up', kinds: ['top_up'] }]);
});

test('grouping versions derive from policy content and return to the same value when restored', () => {
  const policies = MEMBERSHIP_BRANCH_POLICIES as Array<(typeof MEMBERSHIP_BRANCH_POLICIES)[number]>;
  const before = membershipGroupingVersion();
  policies.push({ ...policies[0]!, identity: { family: 'xai', product: 'grok', tier: 'plus' } });
  try { assert.notEqual(membershipGroupingVersion(), before); }
  finally { policies.pop(); }
  assert.equal(membershipGroupingVersion(), before);
});

test('a declared new top-up branch inherits search and newcomer eligibility from its parent', () => {
  const parents = MEMBERSHIP_BRANCH_PARENTS as Record<string, MembershipKind>;
  const kinds = MEMBERSHIP_KINDS as unknown as string[];
  const branch = 'top_up_student' as MembershipKind;
  parents[branch] = 'top_up';
  kinds.push(branch);
  const branches = MEMBERSHIP_BRANCH_POLICIES[0]!.branches as unknown as Array<{ kind: MembershipKind; label: string }>;
  branches.push({ kind: branch, label: '学生资格' });
  try {
    assert(isNewcomerMembership(branch));
    assert(newcomerMembershipKinds().includes(branch));
    assert(membershipSearchKinds('代充').includes(branch));
    assert(membershipFilterKinds('top_up', undefined).includes(branch));
    assert.deepEqual(membershipSearchKinds('学生资格代充'), [branch]);
    assert.equal(membershipKindLabel(branch), '代充 · 学生资格');
    assert.equal(membershipKindLabel(branch, identity), '代充 · 学生资格');
    assert.deepEqual('Claude 学生资格代充'.match(new RegExp(membershipSearchPattern(), 'gu')), ['学生资格代充']);
  } finally { branches.pop(); kinds.pop(); delete parents[branch]; }
});

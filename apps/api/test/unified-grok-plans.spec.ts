import assert from 'node:assert/strict';
import test from 'node:test';
import { assessProductEvidence, identityEvidenceConflict, isValidCatalogIdentity } from '../src/standardization/identity-policy.js';
import { buildExtractionPayload } from '../src/ai/adaptive-batching.js';
import { canonicalProductDisplayName, standardProductDisplayName, standardProductKind } from '@price-comparison/catalog/catalog-display';
import { parseStandardizationProtocolResponse } from '../src/ai/ai.schemas.js';
import { validateStandardizationEvidence } from '../src/ai/standardization-evidence.js';

test('official unified plans are distinct from historical Grok and X subscriptions', () => {
  for (const tier of ['plus', 'premium', 'super', 'ultra']) {
    const identity = { family: 'xai', product: 'grok', tier };
    assert.equal(isValidCatalogIdentity(identity), true, tier);
    assert.equal(canonicalProductDisplayName(identity), `Grok·X·Cursor ${tier[0]!.toUpperCase() + tier.slice(1)}（统一订阅）`);
    assert.equal(standardProductKind(identity), '账号与订阅');
  }
  assert.equal(standardProductDisplayName('X Premium'), 'X Premium（旧版）');
  assert.equal(standardProductDisplayName('X Premium Plus'), 'X Premium Plus（旧版）');
  assert.equal(standardProductDisplayName('SuperGrok'), 'SuperGrok（旧版）');
  assert.equal(standardProductDisplayName('Grok Heavy'), 'Grok Heavy（旧版）');
});

test('selected unified plans pass raw and frozen evidence without becoming legacy subscriptions', () => {
  for (const [name, spec, tier] of [
    ['Grok Plus 1个月', '', 'plus'],
    ['GroK Premium 30刀新套餐 正规充值 一个月', '', 'premium'],
    ['Grok Super 新版统一会员15x', '', 'super'],
    ['Grok Ultra 50x 会员', '', 'ultra'],
    ['X Premium 新版三合一会员', '', 'premium'],
    ['Grok Plus / Premium / Super / Ultra', 'Premium 1个月', 'premium'],
    ['Grok Plus / Premium / Super / Ultra', 'Plus 1个月', 'plus'],
    ['Grok Plus / Premium / Super / Ultra', 'Super 15x 1个月', 'super'],
    ['Grok Plus / Premium / Super / Ultra', 'Ultra 1个月', 'ultra'],
  ]) {
    const input = { id: '1', name: name!, spec: spec!, sourceData: { evidence: 'Grok、X、Cursor统一订阅，共享AI使用池。' } };
    const identity = { family: 'xai', product: 'grok', tier: tier! };
    for (const [format, evidence] of [['raw', input], ['text', buildExtractionPayload(input)]] as const) {
      assert.deepEqual(assessProductEvidence(evidence, format).identity, identity, name + ' ' + format);
      assert.equal(identityEvidenceConflict(identity, evidence, format), null, name + ' ' + format);
      for (const old of [
        { family: 'x', product: 'premium_membership', tier: 'premium' },
        { family: 'xai', product: 'grok', tier: 'supergrok' },
      ]) assert.ok(identityEvidenceConflict(old, evidence, format), name + ' legacy ' + format);
    }
  }
});

test('selected options also establish the unified Super multiplier', () => {
  for (const sourceData of [{ selectedOptions: 'Super 15x' }, { sku: { code: 'Super 15x' } }]) {
    const input = { id: '1', name: 'Grok Plus / Premium / Super / Ultra', spec: '', sourceData };
    const identity = { family: 'xai', product: 'grok', tier: 'super' };
    for (const [format, evidence] of [['raw', input], ['text', buildExtractionPayload(input)]] as const) {
      assert.deepEqual(assessProductEvidence(evidence, format).identity, identity);
      assert.equal(identityEvidenceConflict(identity, evidence, format), null);
    }
  }
});

test('legacy names, menu ambiguity, gifts and prices cannot establish a unified plan', () => {
  for (const input of [
    { name: 'X Premium 旧版 1个月' },
    { name: 'X Premium+ 赠送SuperGrok，旧版不是最新三合一' },
    { name: 'SuperGrok 老版30刀会员' },
    { name: 'Grok Super 月订阅' },
    { name: 'Grok Plus / Premium 会员' },
    { name: 'Grok 30美元月卡' },
    { name: 'Grok 普号', sourceData: { evidence: '可升级Premium，售价30美元' } },
    { name: 'Grok Premium', sourceData: { evidence: '实际交付Grok Plus会员' } },
    { name: 'Grok Super 旧版' },
    { name: 'Grok Plus 安装服务' },
    { name: 'Grok Plus 镜像服务' },
    { name: 'Grok Plus mirror subscription' },
    { name: 'Grok Plus', sourceData: { evidence: '实际仅交付Cursor账号，不提供Grok账号' } },
    { name: 'ChatGPT Plus 会员 附赠Grok' },
    { name: 'Grok Plus', sourceData: { evidence: '实际仅交付ChatGPT Plus账号' } },
    { name: 'X Premium 会员 附赠 Grok' },
    { name: 'X Premium会员含Grok权益' },
    { name: 'Gro Plus 1x 1个月', sourceData: { evidence: 'Gro Premium 8刀正规充值' } },
    { name: 'Grok Premium 15x 新版会员' },
    { name: 'Grok Premium 15x 新版会员', spec: '1个月' },
    { name: 'Grok Super Heavy 新版会员' },
  ]) {
    for (const tier of ['plus', 'premium', 'super', 'ultra']) {
      assert.ok(identityEvidenceConflict({ family: 'xai', product: 'grok', tier }, input), input.name + ' ' + tier);
    }
  }
  assert.equal(identityEvidenceConflict({ family: 'x', product: 'premium_membership', tier: 'premium_plus' },
    { name: 'X Premium+ 赠送SuperGrok，旧版不是最新三合一' }), null);
});

test('new and reused model identities must pass the same unified evidence guard', () => {
  for (const name of ['Grok Premium 4x 月卡', 'X Premium 会员 附赠Grok']) {
    const identity = { family: 'xai', product: 'grok', tier: 'premium' };
    const input = { id: '1', name, spec: '' };
    const payload = buildExtractionPayload(input);
    const evidence = [{ path: 'name', quote: name }];
    for (const choice of [
      { action: 'create_identity', identity: { ...identity, reason: '所选套餐', evidence } },
      { action: 'reuse_candidate', candidateRef: 'i1c1' },
    ]) {
      const parsed = parseStandardizationProtocolResponse({ items: [{ id: '1', ...choice, ruleIds: [], evidence, reason: '所选套餐' }] },
        [{ id: '1', candidateStandardProductIds: ['91'], candidateRefs: { i1c1: '91' } }]);
      const result = validateStandardizationEvidence(parsed, [{ id: '1', payload }], [{ id: '91', ...identity, aliases: [] }]);
      assert.equal(result.items[0]?.status === 'unclassified', name.startsWith('X '), name + ' ' + choice.action);
    }
  }
});

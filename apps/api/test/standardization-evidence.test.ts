import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStandardizationProtocolResponse } from '../src/ai/ai.schemas.js';
import { validateStandardizationEvidence } from '../src/ai/standardization-evidence.js';
import { buildExtractionPayload } from '../src/ai/adaptive-batching.js';
import { identityGuardRegressions } from './fixtures/identity-guard-regressions.js';
import { publicationEvidenceConflict } from '../src/standardization/publication-evidence.js';

test('quoted spec uncertainty does not create an identity publication conflict', () => {
  assert.equal(publicationEvidenceConflict({ name: 'ChatGPT Plus',
    spec: '说明: "不保证 / 质保: 30天" / 期限: 1个月',
    sourceData: { evidence: '质保5天。' } }), null);
});

test('software-only JSON evidence retains account identity', () => {
  const name = 'Team 5X 成品JSON';
  const description = '已开通Team 5X账号，成品JSON交付，仅支持Sub2API。';
  const input = { id: 'team-software', name, spec: '', sourceData: { evidence: description } };
  const evidence = [citation('name', name)];
  const parsed = parseStandardizationProtocolResponse({ items: [{ id: input.id, action: 'create_identity',
    identity: { family: 'openai', product: 'chatgpt', tier: 'team_5x', reason: '已开通', evidence },
    ruleIds: [], evidence, reason: '实际账号' }],
  }, [{ id: input.id, candidateStandardProductIds: [], candidateRefs: {} }]);
  const result = validateStandardizationEvidence(parsed, [{ id: input.id, payload: buildExtractionPayload(input) }], []).items[0]!;
  assert.equal(result.status, 'classified');
});

const citation = (path: string, quote: string) => ({ path, quote });

test('a valid X recharge citation cannot publish an unsupported Premium Plus candidate', () => {
  const input = { id: '7332973', name: '【自助充值】x Twitter 30天卡密', spec: '',
    sourceData: { evidence: 'X-Twitter自助卡密 正规IOS充值(10刀/月)' } };
  const evidence = [citation('sourceData.evidence', input.sourceData.evidence)];
  const parsed = parseStandardizationProtocolResponse({ items: [{ id: input.id, action: 'reuse_candidate',
    candidateRef: 'c1', ruleIds: [], evidence, reason: 'X Premium 会员充值卡密' }] },
  [{ id: input.id, candidateStandardProductIds: ['4185'], candidateRefs: { c1: '4185' } }]);
  assert.equal(parsed.items[0]?.status, 'classified');
  const result = validateStandardizationEvidence(parsed, [{ id: input.id, payload: buildExtractionPayload(input) }],
    [{ id: '4185', family: 'x', product: 'premium_membership', tier: 'premium_plus', aliases: [] }]).items[0]!;
  assert.equal(result.status, 'unclassified');
  assert.equal(result.reasonCode, 'identity_conflict');
});
for (const { input, identity } of identityGuardRegressions) {
  test('evidence validation retains a correct created or reused identity: ' + input.name, () => {
    const payload = buildExtractionPayload(input);
    const evidence = [citation('name', input.name)];
    const candidate = { id: '91', ...identity, aliases: [] };
    for (const choice of [
      { action: 'create_identity', identity: { ...identity, reason: 'explicit sale', evidence } },
      { action: 'reuse_candidate', candidateRef: 'c1' },
    ]) {
      const parsed = parseStandardizationProtocolResponse({ items: [
        { id: input.id, ...choice, ruleIds: [], evidence, reason: 'explicit sale' },
      ] }, [{ id: input.id, candidateStandardProductIds: ['91'], candidateRefs: { c1: '91' } }]);
      assert.equal(parsed.items[0]?.status, 'classified', choice.action + ' schema');
      const result = validateStandardizationEvidence(parsed, [{ id: input.id, payload }], [candidate]);
      assert.equal(result.items[0]?.status, 'classified', choice.action);
      assert.equal(result.items[0]?.reasonCode, null, choice.action);
      assert.ok(result.items[0]?.identity);
    }
  });
}

test('accepting independent goods never authorizes fabricated, foreign or missing identity citations', () => {
  const input = identityGuardRegressions.find(testCase => testCase.identity.product === 'ip')!.input;
  const identity = { family: 'network', product: 'ip', tier: 'standard' };
  for (const badEvidence of [[], [citation('name', 'invented')], [citation('items[1].name', input.name)]]) {
    const evidence = [citation('name', input.name)];
    const parsed = parseStandardizationProtocolResponse({ items: [{ id: input.id, action: 'create_identity',
      identity: { ...identity, reason: 'explicit sale', evidence: badEvidence },
      ruleIds: [], evidence, reason: 'explicit sale' },
    ] }, [{ id: input.id, candidateStandardProductIds: [], candidateRefs: {} }]);
    const result = validateStandardizationEvidence(parsed, [{ id: input.id, payload: buildExtractionPayload(input) }], []);
    assert.equal(result.items[0]?.status, 'unclassified');
    assert.equal(result.items[0]?.reasonCode, 'evidence_invalid');
    assert.deepEqual(result.identities, []);
  }
});

test('compound subscription products cannot be created or reused as generic recharge services', () => {
  const identity = { family: 'openai', product: 'chatgpt_pro_20x_recharge_service', tier: 'pro_20x_recharge_service' };
  const inputs = [{ id: '1', candidateStandardProductIds: ['91'], candidateRefs: { i1c1: '91' } }];
  const payload = { name: '充值服务' };
  const evidence = [citation('name', payload.name)];
  for (const choice of [
    { action: 'create_identity', identity: { ...identity, evidence, reason: 'explicit offer' } },
    { action: 'reuse_candidate', candidateRef: 'i1c1' },
  ]) {
    const parsed = parseStandardizationProtocolResponse({ items: [{ id: '1', ...choice, evidence, ruleIds: [], reason: 'explicit offer' }] }, inputs);
    const result = validateStandardizationEvidence(parsed, [{ id: '1', payload }], [{ id: '91', ...identity, aliases: [] }]);
    assert.equal(result.items[0]?.status, 'unclassified', choice.action);
    assert.equal(result.items[0]?.reasonCode, 'identity_conflict', choice.action);
    assert.equal(result.items[0]?.identity, undefined);
    assert.deepEqual(result.identities, []);
  }
});

test('Pro 20x recharge remains a ChatGPT plan', () => {
  const payload = { name: 'ChatGPT Pro 20x 代充' };
  const evidence = [citation('name', payload.name)];
  const parsed = parseStandardizationProtocolResponse({ items: [{ id: '1', action: 'create_identity',
    identity: { family: 'openai', product: 'chatgpt', tier: 'pro_20x', evidence, reason: 'explicit plan' },
    evidence, ruleIds: [], reason: 'explicit offer',
  }] }, [{ id: '1', candidateStandardProductIds: [], candidateRefs: {} }]);
  const result = validateStandardizationEvidence(parsed, [{ id: '1', payload }], []);
  assert.equal(result.items[0]?.status, 'classified');
  assert.equal(result.identities[0]?.product, 'chatgpt');
  assert.equal(result.identities[0]?.tier, 'pro_20x');
});

test('inline identities cannot borrow another item identity citation', () => {
  const response = parseStandardizationProtocolResponse({
    items: ['1', '2'].map(id => ({ id, action: 'create_identity',
      identity: { family: 'openai', product: 'chatgpt', tier: 'plus', reason: 'explicit', evidence: [citation('name', 'monthly')] },
      ruleIds: [], evidence: [citation('name', 'ChatGPT Plus')], reason: 'explicit' })),
  }, ['1', '2'].map(id => ({ id, candidateStandardProductIds: [], candidateRefs: {} })));
  const result = validateStandardizationEvidence(response, [
    { id: '1', payload: { name: 'ChatGPT Plus monthly' } }, { id: '2', payload: { name: 'ChatGPT Plus annual' } },
  ], []);
  assert.deepEqual(result.items.map(item => item.status), ['classified', 'unclassified']);
  assert.equal(result.items[1]?.reasonCode, 'evidence_invalid');
  assert.equal(result.items[1]?.diagnostic?.stage, 'evidence');
  assert.equal(result.items[1]?.diagnostic?.fieldPath, 'identity.evidence[0].quote');
  assert.equal(result.items[1]?.diagnostic?.matched, false);
  assert.equal(result.items[1]?.diagnostic?.quoteLength, 7);
  assert.doesNotMatch(JSON.stringify(result.items[1]?.diagnostic), /monthly|annual/);
  assert.deepEqual(result.identities.map(identity => identity.ref), ['i-1'], 'failed identity evidence must not reach persistence or canonical folding');
});

test('invalid first identity cannot win canonical folding over a valid sibling', () => {
  const parsed = parseStandardizationProtocolResponse({ items: ['1', '2'].map(id => ({ id, action: 'create_identity',
    identity: { family: 'openai', product: 'chatgpt', tier: 'plus', reason: id === '1' ? 'unvalidated-private-reason' : 'explicit',
      evidence: [citation('name', id === '1' ? 'unvalidated-private-quote' : 'ChatGPT Plus')] },
    ruleIds: [], evidence: [citation('name', 'ChatGPT Plus')], reason: 'explicit' })) },
  ['1', '2'].map(id => ({ id, candidateStandardProductIds: [], candidateRefs: {} })));
  const result = validateStandardizationEvidence(parsed, ['1', '2'].map(id => ({ id, payload: { name: 'ChatGPT Plus' } })), []);
  assert.deepEqual(result.identities.map(identity => identity.ref), ['i-2']);
  assert.doesNotMatch(JSON.stringify(result), /unvalidated-private/);
});

test('real identity contradictions keep the failed rule and proposed identity', () => {
  const payload = { name: 'ChatGPT Plus', sourceData: { description: '实际交付 Claude Pro 账号' } };
  const evidence = [citation('name', payload.name)];
  const parsed = parseStandardizationProtocolResponse({ items: [{ id: '1', action: 'create_identity',
    identity: { family: 'openai', product: 'chatgpt', tier: 'plus', evidence, reason: 'explicit plan' },
    evidence, ruleIds: [], reason: 'source facts',
  }] }, [{ id: '1', candidateStandardProductIds: [], candidateRefs: {} }]);
  const result = validateStandardizationEvidence(parsed, [{ id: '1', payload }], []).items[0]!;
  assert.equal(result.reasonCode, 'identity_conflict');
  assert.equal(result.diagnostic?.stage, 'identity');
  assert.ok(result.diagnostic?.ruleIds?.includes('conflicting_brands'));
  assert.deepEqual(result.diagnostic?.proposedIdentity, { family: 'openai', product: 'chatgpt', tier: 'plus' });
});

test('Gemini Pro classification survives unrelated delivery and import instructions', () => {
  const payload = { name: 'Google Gemini Pro', sourceData: { description: '不带邮箱密码；1小时内导入' } };
  const evidence = [citation('name', payload.name)];
  const parsed = parseStandardizationProtocolResponse({ items: [{ id: '1', action: 'create_identity',
    identity: { family: 'google', product: 'gemini', tier: 'pro', evidence, reason: 'explicit offer' },
    evidence, ruleIds: [], reason: 'source facts',
  }] }, [{ id: '1', candidateStandardProductIds: [], candidateRefs: {} }]);
  const result = validateStandardizationEvidence(parsed, [{ id: '1', payload }], []);
  assert.equal(result.items[0]?.status, 'classified');
  assert.equal(result.identities[0]?.product, 'gemini');
});

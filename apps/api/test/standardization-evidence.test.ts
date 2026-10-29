import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStandardizationProtocolResponse } from '../src/ai/ai.schemas.js';
import { validateStandardizationEvidence, validateStandardizationTags } from '../src/ai/standardization-evidence.js';
import type { JsonValue } from '../src/database/types.js';
import { buildExtractionPayload } from '../src/ai/adaptive-batching.js';
import { identityGuardRegressions } from './fixtures/identity-guard-regressions.js';
import { tagCitationSupports, tagEvidenceFacts } from '../src/ai/tag-evidence.js';
import { publicationEvidenceConflict } from '../src/standardization/publication-evidence.js';

test('quoted spec separators keep negation and uncertainty in their own attribute', () => {
  const spec = '说明: "不支持 / 交付格式: JSON" / 期限: 1个月';
  const fact = { name: 'delivery_format', value: 'json' };
  assert.equal(tagEvidenceFacts(fact, spec.toLowerCase()).has('json'), false);
  assert.equal(tagCitationSupports({ name: 'access_channel', value: 'api' }, 'api',
    '说明: "不支持 / 访问渠道: api" / 期限: 1个月'), false);
  assert.equal(publicationEvidenceConflict({ name: 'ChatGPT Plus',
    spec: '说明: "不保证 / 质保: 30天" / 期限: 1个月',
    sourceData: { evidence: '质保5天。' } }), null);
});

test('Team software and copied restrictions need their own positive or complete evidence', () => {
  const text = '成品JSON交付，仅支持Sub2API。禁止破限，禁止反代。';
  assert.equal(tagCitationSupports({ name: 'supported_client', value: 'sub2api' }, 'sub2api', text.toLowerCase()), true);
  assert.equal(tagCitationSupports({ name: 'usage_restriction', value: '仅支持sub2api' }, '仅支持sub2api', text.toLowerCase()), true);
  assert.equal(tagCitationSupports({ name: 'usage_restriction', value: '禁止破限' }, '禁止破限', text), true);
  assert.equal(tagCitationSupports({ name: 'usage_restriction', value: '不支持网页' }, '仅支持sub2api', text.toLowerCase()), false);
  for (const source of ['不支持sub2api', '禁止sub2api', '需自行测试sub2api', 'sub2api教程'])
    assert.equal(tagCitationSupports({ name: 'supported_client', value: 'sub2api' }, 'sub2api', source), false, source);
  assert.equal(tagCitationSupports({ name: 'access_channel', value: 'reverse_proxy' }, '反代', '禁止反代'), false);
});

test('software-only JSON evidence retains account identity and omits invented capabilities', () => {
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
  const attributes = validateStandardizationTags([tag('delivery_format', 'json', 'sourceData.evidence', 'JSON'),
    tag('supported_client', 'sub2api', 'sourceData.evidence', 'Sub2API'),
    tag('usage_restriction', '仅支持sub2api', 'sourceData.evidence', '仅支持Sub2API'),
    tag('access_channel', 'web', 'sourceData.evidence', '仅支持Sub2API'),
    tag('delivery_format', 'credentials', 'sourceData.evidence', 'JSON'),
    tag('2fa', '有', 'sourceData.evidence', 'JSON')], buildExtractionPayload(input));
  assert.deepEqual(attributes.tags.map(({ name, value }) => ({ name, value })), [
    { name: 'delivery_format', value: 'json' }, { name: 'supported_client', value: 'sub2api' },
    { name: 'usage_restriction', value: '仅支持sub2api' },
  ]);
});

const citation = (path: string, quote: string) => ({ path, quote });
const tag = (name: string, value: string, path: string, quote: string) => ({ name, value, evidence: [citation(path, quote)] });

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
function validate(payload: Record<string, JsonValue>, tags: ReturnType<typeof tag>[]) {
  return validateStandardizationTags(tags, payload);
}

function assertDropped(result: ReturnType<typeof validate>, context?: string) {
  assert.deepEqual(result.tags, [], context);
  assert.ok(result.diagnostic, context);
}

function assertFact(name: string, value: string, source: string, quote = source, accepted = true) {
  const proposed = tag(name, value, 'sourceData.evidence', quote);
  const result = validate({ name: '商品', sourceData: { evidence: source } }, [proposed]);
  assert.deepEqual(result.tags, accepted ? [proposed] : [], `${name}: ${source} quoting ${quote}`);
}

test('renewal evidence keeps the expiry condition across commas without accepting clipped or uncertain claims', () => {
  const source = '该渠道不支持提前续费,请您账号订阅到期,显示免费版后再进行购买续费 。';
  for (const [name, value] of [['renewable', '有'], ['renewal_timing', 'after_expiry']]) {
    assertFact(name!, value!, source);
    for (const text of ['不支持续费', '可能到期后续费', '如果显示免费版，到期后续费', '不支持到期后续费'])
      assertFact(name!, value!, text, text, false);
    assertFact(name!, value!, source, '购买续费', false);
  }
});

test('subscription override retains boolean polarity', () => {
  for (const source of ['Plus未到期不可以覆盖', '不可覆盖订阅']) assertFact('subscription_override', '无', source);
  assertFact('subscription_override', '有', '可覆盖');
  for (const [name, value, source, quote] of [
    ['subscription_override', '有', '不可覆盖订阅', '覆盖'],
    ['subscription_override', '无', '可能不可覆盖订阅', '不可覆盖订阅'],
  ]) assertFact(name!, value!, source!, quote!, false);
});

test('card requirements retain boolean polarity and selected SKU conflicts', () => {
  assertFact('card_binding_required', '无', '无需绑卡 直接激活', '无需绑卡');
  assertFact('card_binding_required', '有', '需要绑卡');
  assertFact('card_binding_required', '有', '无需绑卡', '绑卡', false);
  assertFact('card_binding_required', '无', '可能无需绑卡', '无需绑卡', false);
  assertFact('card_binding_required', '无', '无需接码 需要绑卡', '无需接码', false);
  assertFact('card_binding_required', '有', '无需接码 需要绑卡', '需要绑卡');
  assertFact('card_binding_required', '有', '不要绑卡', '绑卡', false);
  assertDropped(validate({ name: '商品', spec: '需要绑卡', sourceData: { evidence: '无需绑卡' } },
    [tag('card_binding_required', '无', 'sourceData.evidence', '无需绑卡')]));
});

for (const [name, source] of [
  ['vpn_required', 'VPN is required'],
  ['sms_required', 'SMS verification is required'],
  ['sms_required', '需要先接码'],
] as const) test(`requirement markers retain their local topic: ${source}`, () => {
  assertFact(name, '有', source);
});

test('requirement connectors preserve negative polarity and cross-topic isolation', () => {
  assertFact('vpn_required', '无', 'VPN is not required');
  assertFact('sms_required', '无', 'SMS verification is not required');
  assertFact('sms_required', '无', '不需要先接码');
  assertFact('sms_required', '有', '无需绑卡 需要先接码', '需要先接码');
  assertFact('card_binding_required', '无', '无需绑卡 需要先接码', '无需绑卡');
  assertFact('sms_required', '无', '无需绑卡 需要先接码', '无需绑卡', false);
});

test('English requirement in the selected SKU overrides a conflicting cited exemption', () => {
  assertDropped(validate({ name: '商品', spec: 'VPN is required', sourceData: { evidence: '无需vpn' } },
    [tag('vpn_required', '无', 'sourceData.evidence', '无需vpn')]));
});

for (const [name, value, source, quote] of [
  ['delivery_format', 'token', '可能提供 | token', 'token'],
  ['delivery_format', 'json', '不提供token|json', 'json'],
  ['delivery_format', 'token', '需要自备 | token', 'token'],
  ['email_provider', 'gmail', '不提供 | 谷歌邮箱', '谷歌邮箱'],
  ['credits', '24000', '最多 | 2.4w积分', '2.4w积分'],
] as const) test(`pipe fragments retain a governing qualifier: ${source}`, () => {
  assertFact(name, value, source, quote, false);
});

test('verbatim restrictions preserve comma conditions and case while requiring the whole claim', () => {
  const source = '加入了TEAM的号无法充值,必须退出';
  assertFact('usage_restriction', source, source);
  assertFact('usage_restriction', source, source, '无法充值', false);
  assertFact('usage_restriction', '加入了TEAM的号无法充值', source, source, false);
  assertFact('usage_restriction', source, `可能${source}`, source, false);
});

test('manual recharge requires affirmative local evidence', () => {
  assertFact('delivery_mode', 'manual', '人工手动充值');
  for (const [name, value, source, quote] of [
    ['delivery_mode', 'manual', '不支持人工手动充值', '人工手动充值'],
    ['delivery_mode', 'manual', '可能人工手动充值', '人工手动充值'],
  ]) assertFact(name!, value!, source!, quote!, false);
});

test('embedded mailbox aliases require affirmative local evidence', () => {
  assertFact('email_provider', 'gmail', '谷歌邮箱带2fa】已接马codex 10个起拍', '谷歌邮箱');
  for (const [name, value, source, quote] of [
    ['email_provider', 'gmail', '不提供谷歌邮箱带2fa', '谷歌邮箱'],
    ['email_provider', 'gmail', '可能谷歌邮箱带2fa', '谷歌邮箱'],
    ['email_provider', 'gmail', '不提供谷歌邮箱；谷歌邮箱带2fa', '不提供谷歌邮箱'],
  ]) assertFact(name!, value!, source!, quote!, false);
});

test('phone binding is a requirement with distinct negative boundaries', () => {
  assertFact('sms_required', '有', '要绑定手机号');
  assertFact('sms_required', '无', '无需绑定手机号');
  for (const [name, source, quote] of [
    ['sms_required', '可能要绑定手机号', '要绑定手机号'],
    ['sms_required', '无需绑定手机号', '绑定手机号'],
  ]) assertFact(name!, '有', source!, quote!, false);
});

test('completed KYC is a state with distinct negative boundaries', () => {
  assertFact('kyc', 'verified', '已完成真人验证kyc,未开通会员', '已完成真人验证kyc');
  assertFact('kyc', 'verified', '未完成真人验证kyc；已完成真人验证kyc', '已完成真人验证kyc', false);
  assertDropped(validate({ name: '商品', spec: '未完成真人验证kyc', sourceData: { evidence: '已完成真人验证kyc' } },
    [tag('kyc', 'verified', 'sourceData.evidence', '已完成真人验证kyc')]));
  for (const [name, source, quote] of [
    ['kyc', '未完成真人验证kyc', '完成真人验证kyc'],
    ['kyc', '无需完成真人验证kyc', '完成真人验证kyc'],
    ['kyc', '可能已完成真人验证kyc', '已完成真人验证kyc'],
    ['kyc', '需要完成真人验证kyc', '完成真人验证kyc'],
    ['kyc', '并非已完成真人验证kyc', '已完成真人验证kyc'],
    ['kyc', '建议已完成真人验证kyc', '已完成真人验证kyc'],
  ]) assertFact(name!, name === 'kyc' ? 'verified' : '有', source!, quote!, false);
});

test('w credits keep units and numeric qualifiers', () => {
  assertFact('credits', '24000', '菲律宾区 2.4w积分成品号', '2.4w积分');
  for (const [name, value, source, quote] of [
    ['credits', '24000', '最多2.4w积分', '2.4w积分'],
    ['credits', '24000', '价格2.4w元', '2.4w'],
    ['credits', '24000', '不含2.4w积分', '2.4w积分'],
  ]) assertFact(name!, value!, source!, quote!, false);
});

test('pipe-delimited delivery facts retain independent negation and conditions', () => {
  assertFact('delivery_format', 'token', '安卓真机注册| 无头像 | 邮箱不可用 | token | 已开启2fa', 'token');
  for (const [name, value, source, quote] of [
    ['delivery_format', 'token', '无token | 邮箱密码', 'token'],
    ['delivery_format', 'token', '可能token | 无头像', 'token'],
    ['delivery_format', 'token', '如果支持 | token', 'token'],
  ]) assertFact(name!, value!, source!, quote!, false);
  assertDropped(validate({ name: '商品', spec: 'JSON', sourceData: { evidence: 'token' } },
    [tag('delivery_format', 'token', 'sourceData.evidence', 'token')]));
  assertDropped(validate({ name: '商品', spec: '质保30天|需保持原密码' }, [
    tag('warranty', 'covered', 'spec', '质保'), tag('warranty_days', '30', 'spec', '30天'),
  ]));
});

test('unrelated pipe-delimited negation cannot prove no warranty', () => {
  const source = '不提供token | 提供30天质保';
  assertFact('warranty', 'none', source, source, false);
});

test('negated recharge wording cannot prove a top-up delivery', () => {
  for (const [source, quote] of [
    ['未接马free号,无代充,质保1小时内首登(账密2fa发货)', '无代充'],
    ['本商品无充值,只发成品号', '无充值'],
    ['不代充,需要自行充值到官方', '不代充'],
    ['无需代充,到手即用', '无需代充'],
  ]) assertFact('delivery', 'top_up', source!, quote!, false);
});

test('explicit pipe-delimited warranty retains its affirmative coverage and period', () => {
  const source = '不提供token | 提供30天质保';
  for (const quote of [source, '提供30天质保']) {
    assertFact('warranty', 'covered', source, quote);
    assertFact('warranty_days', '30', source, quote);
  }
});

test('pipe-delimited warranty retains governing qualifiers and actual warranty conflicts', () => {
  assertFact('warranty', 'none', '不提供 | 质保');
  assertFact('warranty', 'covered', '不提供 | 质保', '质保', false);
  for (const source of ['不提供质保 | 提供30天质保', '可能不提供token | 提供30天质保',
    '需要自备token | 提供30天质保', '如果购买token | 提供30天质保']) {
    assertFact('warranty', 'covered', source, source, false);
    assertFact('warranty', 'none', source, source, false);
  }
});

test('delivered password alone remains ambiguous evidence for password login', () => {
  assertFact('login_method', 'password', '发货格式:邮箱账号----密码----2fa', '密码', false);
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

test('authentication tags cannot quote positive fragments from negated or uncertain evidence', () => {
  for (const [description, quote] of [['不带2fa', '2fa'], ['no 2fa', '2fa'], ['带2fa或辅助邮箱', '2fa'], ['建议设置2fa', '2fa'],
    ['账号不支持2fa', '2fa'], ['account 2fa not included', '2fa'], ['account without 2fa', '2fa']]) {
    const result = validate({ name: 'ChatGPT Plus', sourceData: { description } }, [tag('2fa', '有', 'sourceData.description', quote)]);
    assertDropped(result, description);
  }
  assert.equal(validate({ name: 'ChatGPT Plus', spec: '邮箱----密码----2fa' }, [tag('2fa', '有', 'spec', '2fa')]).tags.length, 1);
  assert.equal(validate({ name: 'ChatGPT Plus', spec: '不带2fa' }, [tag('2fa', '无', 'spec', '不带2fa')]).tags.length, 1);
  assert.equal(validate({ name: 'ChatGPT Plus', spec: '账号不支持2fa' }, [tag('2fa', '无', 'spec', '账号不支持2fa')]).tags.length, 1);
});

test('verification requirements do not prove completed SMS or KYC verification', () => {
  for (const [name, text] of [['sms_verification', '需自行接码'], ['kyc', '需要实名认证'], ['kyc', 'kyc required']]) {
    assertDropped(validate({ name: 'ChatGPT Plus', spec: text }, [tag(name, 'verified', 'spec', text)]), text);
  }
  assert.equal(validate({ name: 'ChatGPT Plus', spec: '已接码' }, [tag('sms_verification', 'verified', 'spec', '已接码')]).tags.length, 1);
  assert.equal(validate({ name: 'ChatGPT Plus', spec: '已过kyc认证' }, [tag('kyc', 'verified', 'spec', '已过kyc认证')]).tags.length, 1);
  for (const [name, spec, quote] of [['sms_verification', 'sms not verified', 'verified'], ['kyc', 'kyc not verified', 'verified'], ['kyc', '并非已实名', '已实名']]) {
    assertDropped(validate({ name: 'ChatGPT Plus', spec }, [tag(name, 'verified', 'spec', quote)]), spec);
    assert.equal(validate({ name: 'ChatGPT Plus', spec }, [tag(name, 'unverified', 'spec', spec)]).tags.length, 1, spec);
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

test('selected SKU attributes override marketing options for both duration and access', () => {
  for (const [name, selected, offered, value] of [
    ['duration', '1 month', '1 year option is also available', '1 year'],
    ['access', '共享', '独享账号也有售', 'dedicated'],
  ]) {
    const item = validate({ name: 'ChatGPT Plus', spec: `${name}: ${selected}`, sourceData: { description: offered! } },
      [tag(name!, value!, 'sourceData.description', offered!)]);
    assertDropped(item);
    assert.equal(item.diagnostic?.stage, 'attribute');
    assert.equal(item.diagnostic?.fieldPath, 'tags[0]');
  }
});

test('warranty wording cannot supply a subscription term by quoting its numeric substring', () => {
  for (const description of ['质保期限为1年', '保修时间是1年', '售后保障1年', 'annual warranty', 'warranty for 1 year']) {
    const quote = description.includes('annual') ? 'annual' : description.includes('year') ? '1 year' : '1年';
    assertDropped(validate({ name: 'ChatGPT Plus', sourceData: { description } }, [tag('duration', '1 year', 'sourceData.description', quote)]), description);
  }
});

test('current selected attributes support spec citations', () => {
  const payload = { name: 'ChatGPT Plus', spec: 'duration: 1个月 / access: 合租', sourceData: {
    description: '也有1年独享套餐',
  } };
  const result = validate(payload, [tag('duration', '1 month', 'spec', '1个月'), tag('access', 'shared', 'spec', '合租')]);
  assert.equal(result.tags.length, 2);
});

test('warranty SKU fields do not become subscription terms', () => {
  const payload = { name: 'ChatGPT Plus', spec: '质保: 1 year' };
  assertDropped(validate(payload, [tag('duration', '1 year', 'spec', '1 year')]));
});

test('negated sharing statements cannot be quoted as positive sharing evidence', () => {
  for (const description of ['不支持共享', 'not for sharing', 'not shared', '不提供共享账号']) {
    const quote = description.includes('sharing') ? 'sharing' : description.includes('shared') ? 'shared' : '共享';
    assertDropped(validate({ name: 'ChatGPT Plus', sourceData: { description } }, [tag('access', 'shared', 'sourceData.description', quote)]), description);
  }
});

test('multiple mutually exclusive tag values cannot be accepted from an unselected options list', () => {
  const payload = { name: 'ChatGPT Plus', sourceData: { description: '1 month shared or 1 year dedicated' } };
  assertDropped(validate(payload, [tag('duration', '1 month', 'sourceData.description', '1 month'), tag('term', '1 year', 'sourceData.description', '1 year')]));
  assertDropped(validate(payload, [tag('access', 'shared', 'sourceData.description', 'shared'), tag('access_type', 'dedicated', 'sourceData.description', 'dedicated')]));
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

test('missing tag citations remain evidence errors with bounded diagnostics', () => {
  const result = validate({ name: 'ChatGPT Plus' }, [tag('access', 'shared', 'sourceData.missing', 'private quote')]);
  assertDropped(result);
  assert.equal(result.diagnostic?.code, 'citation_path_invalid');
  assert.equal(result.diagnostic?.fieldPath, 'evidence[0].path');
  assert.doesNotMatch(JSON.stringify(result.diagnostic), /private quote/);
  assert.deepEqual(result.tags, []);
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

test('invalid tags do not erase valid sibling tags', () => {
  const valid = tag('duration', '1 month', 'spec', '1 month');
  const result = validate({ name: 'ChatGPT Plus', spec: '1 month' }, [
    tag('access', 'shared', 'spec', 'invented'), valid,
  ]);
  assert.deepEqual(result.tags, [valid]);
  assert.ok(result.diagnostic);
});

test('dropping warranty conditions cannot leave an unconditional warranty promise', () => {
  const result = validate({ name: 'ChatGPT Plus', spec: '质保30天' }, [
    tag('warranty', 'covered', 'spec', '质保'),
    tag('warranty_scope', 'first_login', 'spec', '首次登录'),
    tag('warranty_days', '30', 'spec', '30天'),
  ]);
  assertDropped(result);
  const conflicting = validate({ name: 'ChatGPT Plus', spec: '质保30天' }, [
    tag('warranty_scope', 'first_login', 'spec', '质保'),
    tag('warranty_scope', 'period', 'spec', '质保'),
    tag('warranty_days', '30', 'spec', '30天'),
  ]);
  assertDropped(conflicting);
});

for (const [name, value, text, quote = text] of [
  ['delivery_format', 'credentials', '不带邮箱密码', '邮箱密码'],
  ['delivery_format', 'credentials', '无需提供账号密码', '账号密码'],
  ['delivery_format', 'credentials', 'credentials not included', 'credentials'],
  ['delivery_format', 'credentials', '可能提供邮箱密码', '邮箱密码'],
  ['delivery_format', 'credentials', '请自行修改账号密码', '账号密码'],
  ['delivery_format', 'json', '不提供JSON', 'JSON'],
  ['delivery', 'top_up', '不支持代充', '代充'],
  ['delivery', 'account', '需自备账号用于代充', '账号'],
  ['access_channel', 'imap', '未开通imap/pop3', 'imap'],
  ['access_channel', 'web', 'web login unsupported', 'web'],
  ['access_channel', 'api', '不支持API访问', 'API'],
  ['access_channel', 'mirror', '不提供镜像站', '镜像'],
  ['region', 'us', '随机区'],
  ['region', 'us', '非美区', '美区'],
  ['region', 'us', '美区或日区随机发货', '美区'],
  ['region', 'us', '建议使用美国IP', '美国'],
  ['registration_region', 'us', '美国IP登录', '美国'],
  ['payment_region', 'us', '注册地区：美国', '美国'],
  ['amount', '100 usd', '充值10美元', '10美元'],
  ['amount', '10 usd', '充值10元', '10元'],
  ['balance', '10 usd', '售价10美元', '10美元'],
  ['balance', '100 usd', '余额最高100美元', '100美元'],
  ['amount', '10 usd', '充值10-100美元', '10'],
  ['amount', '10 usd', '可能赠送10美元', '10美元'],
  ['quantity', '100', '交付数量10个', '10个'],
  ['quantity', '10', '10美元余额', '10'],
  ['quantity', '10', '库存10个', '10个'],
  ['quantity', '10', '10个起购', '10个'],
  ['seats', '10', '共享2人', '2人'],
  ['credits', '100', '含10积分', '10积分'],
  ['usage_count', '10', '可用10天', '10'],
  ['warranty_days', '30', '1小时内导入'],
  ['warranty_days', '30', '无质保，订阅30天', '30天'],
  ['warranty_days', '30', '质保约30天', '30天'],
  ['warranty_days', '30', '质保1小时', '1小时'],
  ['warranty_scope', 'period', '仅首登质保', '质保'],
  ['warranty', 'covered', '无质保', '质保'],
  ['warranty_trigger', 'purchase', '激活后开始质保', '质保'],
  ['edition', 'premium', '标准版'],
]) {
  test(`tag semantics drops unsupported ${name}=${value}: ${text}`, () => {
    assertDropped(validate({ name: 'ChatGPT Plus', sourceData: { description: text! } },
      [tag(name!, value!, 'sourceData.description', quote!)]), text);
  });
}

for (const [name, value, text, quote = text] of [
  ['delivery_format', 'credentials', '发货邮箱密码', '邮箱密码'],
  ['delivery_format', 'json', '提供登录JSON文件', 'JSON'],
  ['delivery', 'top_up', 'ChatGPT Plus 官方代充'],
  ['delivery', 'account', '交付成品账号', '成品账号'],
  ['delivery', 'redemption', '提供激活码', '激活码'],
  ['access_channel', 'web', '仅官网网页登录，未开通imap/pop3', '网页登录'],
  ['access_channel', 'imap', '支持IMAP协议', 'IMAP'],
  ['access_channel', 'api', '支持API访问', 'API'],
  ['access_channel', 'reverse_proxy', '仅反代使用', '反代'],
  ['region', 'us', '美国区账号', '美国区'],
  ['region', 'us', '交付美国区账号。', '美国区'],
  ['region', 'us', 'ChatGPT Plus 美国区账号', '美国区'],
  ['region', 'ph', 'Philippines'],
  ['region', 'random', '随机区'],
  ['region_options', 'us', '可选美区或日区', '美区'],
  ['recommended_ip_region', 'us', '建议使用美国IP', '美国'],
  ['registration_region', 'us', '注册地区：美国', '美国'],
  ['payment_region', 'us', '支付地区：美国', '美国'],
  ['amount', '10 usd', '充值10美元', '10美元'],
  ['balance', '10 usd', '账户余额10美元', '10美元'],
  ['quantity', '10', '交付数量10个', '10个'],
  ['minimum_quantity', '10', '10个起购'],
  ['seats', '2', '提供2个席位', '2个席位'],
  ['shared_users', '2', '共享2人', '2人'],
  ['multi_open', '5', '支持5开', '5开'],
  ['credits', '10000', '附赠1万积分', '1万积分'],
  ['usage_count', '3', '可使用3次', '3次'],
  ['storage', '10 gb', '存储容量10GB', '10GB'],
  ['email_provider', 'gmail', 'Gmail邮箱'],
  ['device_platform', 'android', '支持安卓'],
  ['edition', 'premium', '版本 premium', 'premium'],
]) {
  test(`tag semantics retains supported ${name}=${value}: ${text}`, () => {
    const proposed = tag(name!, value!, 'sourceData.description', quote!);
    const result = validate({ name: 'ChatGPT Plus', sourceData: { description: text! } }, [proposed]);
    assert.deepEqual(result.tags, [proposed]);
  });
}

test('tag semantics retains full-title Pro20x recharge citations', () => {
  const payload = { name: 'ChatGPT Pro 20x 官方代充' };
  const proposed = tag('delivery', 'top_up', 'name', payload.name);
  assert.deepEqual(validate(payload, [proposed]).tags, [proposed]);
});

test('new tag semantics uses the selected SKU label and rejects other offered regions', () => {
  const payload = { name: 'ChatGPT Plus', spec: '地区: 随机区 / 数量: 10', sourceData: {
    description: '也有美国区账号',
  } };
  const valid = tag('quantity', '10', 'spec', '10');
  const result = validate(payload, [tag('region', 'us', 'sourceData.description', '美国区'), valid]);
  assert.deepEqual(result.tags, [valid]);
});

test('real but unrelated quote cannot borrow a supported numeric fact in another clause', () => {
  assertDropped(validate({ name: 'ChatGPT Plus', sourceData: { description: '说明：普通说明；账户余额10美元' } },
    [tag('balance', '10 usd', 'sourceData.description', '普通说明')]));
});

test('qualified warranty requires its scope, time window and exclusions as one group', () => {
  const text = '仅首登1小时质保，封号不保';
  const warranty = [
    tag('warranty', 'covered', 'spec', '质保'),
    tag('warranty_scope', 'first_login', 'spec', '首登'),
    tag('warranty_window', '1 hour', 'spec', '1小时'),
    tag('warranty_exclusion', 'ban', 'spec', '封号不保'),
  ];
  const payload = { name: 'ChatGPT Plus', spec: text };
  const complete = validate(payload, warranty);
  assert.deepEqual(complete.tags, warranty);
  for (const index of [1, 2, 3]) assertDropped(validate(payload, warranty.filter((_, i) => i !== index)), `missing qualifier ${index}`);
  assertDropped(validate(payload, [tag('warranty', 'covered', 'spec', '质保'), tag('warranty_days', '30', 'spec', '1小时')]));
});

test('qualified subscription warranty is retained without strengthening into full coverage', () => {
  const text = '30天掉订阅包赔，封号不保';
  const warranty = [
    tag('warranty', 'covered', 'spec', '掉订阅包赔'),
    tag('warranty_scope', 'subscription', 'spec', '掉订阅包赔'),
    tag('warranty_window', '30 days', 'spec', '30天'),
    tag('warranty_exclusion', 'ban', 'spec', '封号不保'),
  ];
  assert.deepEqual(validate({ name: 'ChatGPT Plus', spec: text }, warranty).tags, warranty);
  assertDropped(validate({ name: 'ChatGPT Plus', spec: text }, [
    tag('warranty', 'covered', 'spec', '掉订阅包赔'), tag('warranty_days', '30', 'spec', '30天'),
  ]));
});

test('full-period warranty retains real days but cannot borrow an import deadline', () => {
  const warranty = [
    tag('warranty', 'covered', 'spec', '质保'),
    tag('warranty_scope', 'period', 'spec', '全程质保'),
    tag('warranty_days', '30', 'spec', '30天'),
  ];
  const result = validate({ name: 'ChatGPT Plus', spec: '全程质保30天；1小时内导入' }, warranty);
  assert.deepEqual(result.tags, warranty);
  assertDropped(validate({ name: 'ChatGPT Plus', spec: '全程质保30天；1小时内导入' },
    [tag('warranty_window', '1 hour', 'spec', '1小时')]));
});

test('an invalid warranty qualifier removes only warranty siblings', () => {
  const valid = tag('delivery_format', 'json', 'sourceData.description', 'JSON');
  const result = validate({ name: 'ChatGPT Plus', spec: '质保30天', sourceData: { description: '提供JSON文件' } }, [
    tag('warranty', 'covered', 'spec', '质保'), tag('warranty_days', '90', 'spec', '30天'), valid,
  ]);
  assert.deepEqual(result.tags, [valid]);
  assert.ok(result.diagnostic);
});

for (const [name, value, text, quote] of [
  ['delivery', 'top_up', '不代充', '代充'],
  ['delivery_format', 'credentials', '无邮箱密码', '邮箱密码'],
  ['region', 'jp', '非日本区', '日本区'],
  ['warranty', 'covered', '不质保', '质保'],
  ['warranty_days', '30', '质保30天，仅限自用', '30天'],
  ['warranty_days', '30', '质保30天，非人为问题才保', '30天'],
  ['warranty_days', '30', '质保30天，修改密码后不保', '30天'],
  ['quantity', '10', '交付数量10个，或20个', '10个'],
  ['usage_count', '10', '最多可用10次', '10次'],
  ['amount', '10 usd', '每天充值10美元', '10美元'],
  ['amount', '10 usd', '充值110美元', '10美元'],
  ['storage', '10 gb', '内存10GB', '10GB'],
  ['registration_year', '2020', '余额2020美元', '2020'],
  ['sms_required', '有', '有库存', '有'],
]) {
  test(`tag semantics preserves negation and numeric qualifiers for ${name}: ${text}`, () => {
    assertDropped(validate({ name: 'ChatGPT Plus', sourceData: { description: text! } },
      [tag(name!, value!, 'sourceData.description', quote!)]));
  });
}

test('Gemini Pro classification survives the actual unsafe delivery and warranty tag shapes', () => {
  const payload = { name: 'Google Gemini Pro', sourceData: { description: '不带邮箱密码；1小时内导入' } };
  const evidence = [citation('name', payload.name)];
  const parsed = parseStandardizationProtocolResponse({ items: [{ id: '1', action: 'create_identity',
    identity: { family: 'google', product: 'gemini', tier: 'pro', evidence, reason: 'explicit offer' },
    evidence, ruleIds: [], reason: 'source facts',
  }] }, [{ id: '1', candidateStandardProductIds: [], candidateRefs: {} }]);
  const result = validateStandardizationEvidence(parsed, [{ id: '1', payload }], []);
  assert.equal(result.items[0]?.status, 'classified');
  assert.equal(result.identities[0]?.product, 'gemini');
  assertDropped(validate(payload, [
    tag('delivery_format', 'credentials', 'sourceData.description', '不带邮箱密码'),
    tag('warranty_days', '30', 'sourceData.description', '1小时内导入'),
  ]));
});

for (const [name, value, text] of [
  ['delivery_mode', 'automatic', '自动发货'],
  ['account_lifecycle', 'aged', '老号'],
  ['renewal_timing', 'after_expiry', '到期后续费'],
  ['payment_method', 'apple_pay', 'apple pay'],
  ['model', 'gpt-4o', '型号 gpt-4o'],
  ['language', 'english', '语言 english'],
  ['color', 'black', '颜色 black'],
]) {
  test(`tag semantics retains reviewed enum and bounded text fields: ${name}`, () => {
    const proposed = tag(name!, value!, 'sourceData.description', text!);
    assert.deepEqual(validate({ name: 'ChatGPT Plus', sourceData: { description: text! } }, [proposed]).tags, [proposed]);
  });
}

for (const [name, value, text, quote = text] of [
  ['minimum_quantity', '10', '至少10个起购'],
  ['usage_count_max', '10', '最多可用10次', '10次'],
  ['amount_daily', '10 usd', '每天充值10美元', '10美元'],
  ['request_limit_hourly', '10', '每小时10次请求', '10次'],
  ['quantity', '10', '10个账号'],
  ['registration_year', '2020', '注册年份2020年', '2020年'],
  ['renewable', '有', '支持续费'],
  ['renewable', '无', '不可续费'],
  ['warranty', 'none', '不质保'],
]) {
  test(`tag semantics retains explicit qualified ${name}: ${text}`, () => {
    const proposed = tag(name!, value!, 'sourceData.description', quote!);
    assert.deepEqual(validate({ name: 'ChatGPT Plus', sourceData: { description: text! } }, [proposed]).tags, [proposed]);
  });
}

test('tag semantics retains named numeric source fields without inventing units', () => {
  const payload = { name: 'ChatGPT Plus', sourceData: { quantity: 10, balance: '10 usd', warranty_days: 30 } };
  const proposed = [
    tag('quantity', '10', 'sourceData.quantity', '10'),
    tag('balance', '10 usd', 'sourceData.balance', '10 usd'),
    tag('warranty_days', '30', 'sourceData.warranty_days', '30'),
  ];
  assert.deepEqual(validate(payload, proposed).tags, proposed);
  assertDropped(validate(payload, [tag('quantity', '100', 'sourceData.quantity', '10')]));
});

test('warranty trigger is retained and cannot be omitted from a timed promise', () => {
  const text = '激活后开始全程质保30天';
  const warranty = [
    tag('warranty', 'covered', 'spec', '质保'),
    tag('warranty_scope', 'period', 'spec', '全程质保'),
    tag('warranty_days', '30', 'spec', '30天'),
    tag('warranty_trigger', 'activation', 'spec', '激活后'),
  ];
  assert.deepEqual(validate({ name: 'ChatGPT Plus', spec: text }, warranty).tags, warranty);
  assertDropped(validate({ name: 'ChatGPT Plus', spec: text }, warranty.slice(0, 3)));
});

test('a full-period warranty starting at first login is not first-login-only coverage', () => {
  const text = '首次登录起全程质保30天';
  const warranty = [
    tag('warranty', 'covered', 'spec', '质保'),
    tag('warranty_scope', 'period', 'spec', '全程质保'),
    tag('warranty_days', '30', 'spec', '30天'),
    tag('warranty_trigger', 'first_login', 'spec', '首次登录起'),
  ];
  assert.deepEqual(validate({ name: 'ChatGPT Plus', spec: text }, warranty).tags, warranty);
});

test('full-period month warranty preserves the existing detail vocabulary without inventing days', () => {
  const text = '全程质保1个月';
  const warranty = [
    tag('warranty', 'covered', 'spec', '质保'),
    tag('warranty_scope', 'period', 'spec', '全程质保'),
    tag('warranty_detail', '1 month', 'spec', '1个月'),
  ];
  assert.deepEqual(validate({ name: 'ChatGPT Plus', spec: text }, warranty).tags, warranty);
  assertDropped(validate({ name: 'ChatGPT Plus', spec: text }, [tag('warranty_days', '30', 'spec', '1个月')]));
});

test('authentication requirements need their own context, not an unrelated affirmative word', () => {
  assertDropped(validate({ name: 'ChatGPT Plus', spec: '有 JSON' }, [tag('sms_required', '有', 'spec', '有')]));
  for (const [name, value, text] of [
    ['sms_required', '有', '需要短信验证'], ['kyc_required', '有', '需要实名认证'],
    ['sms_required', '无', '无需短信验证'], ['vpn_required', '有', '需要VPN'],
  ]) {
    const proposed = tag(name!, value!, 'spec', text!);
    assert.deepEqual(validate({ name: 'ChatGPT Plus', spec: text! }, [proposed]).tags, [proposed]);
  }
});

for (const [name, value, text, quote] of [
  ['delivery', 'top_up', 'ChatGPT Plus 官方代充', 'ChatGPT Plus'],
  ['balance', '10 usd', '账户余额10美元', '账户'],
  ['quantity', '10', '交付数量10个', '数量'],
  ['quantity', '10', '交付数量10个', '1'],
  ['region', 'us', '美国区账号', '账号'],
  ['warranty_scope', 'first_login', '仅首登质保', '质保'],
]) {
  test(`tag citation must carry the fact, not an unrelated fragment: ${name} quoting ${quote}`, () => {
    assertDropped(validate({ name: 'ChatGPT Plus', sourceData: { description: text! } },
      [tag(name!, value!, 'sourceData.description', quote!)]));
  });
}

test('warranty tags cannot omit sibling scope or qualification conditions', () => {
  const scoped = { name: 'ChatGPT Plus', sourceData: { warranty_days: 30, warranty_scope: 'first_login' } };
  assertDropped(validate(scoped, [tag('warranty_days', '30', 'sourceData.warranty_days', '30')]));
  for (const description of ['质保30天，不改密码才保', '质保30天，需保持原密码', '仅限自用，修改密码后不保']) {
    assertDropped(validate({ name: 'ChatGPT Plus', spec: description }, [
      tag('warranty', 'covered', 'spec', '质保'), tag('warranty_days', '30', 'spec', '30天'),
    ]), description);
  }
});

test('named fields keep semantic negation and reviewed aliases', () => {
  assertDropped(validate({ name: 'ChatGPT Plus', sourceData: { delivery: '不支持代充' } }, [
    tag('delivery', 'top_up', 'sourceData.delivery', '代充'),
  ]));
  assertDropped(validate({ name: 'ChatGPT Plus', sourceData: { delivery_format: 'credentials not included' } }, [
    tag('delivery_format', 'credentials', 'sourceData.delivery_format', 'credentials'),
  ]));
  for (const [name, value, text] of [
    ['delivery_mode', 'automatic', '自动发货'], ['account_lifecycle', 'aged', '老号'], ['renewal_timing', 'after_expiry', '到期后续费'],
  ] as const) {
    const proposed = tag(name, value, `sourceData.${name}`, text);
    assert.deepEqual(validate({ name: 'ChatGPT Plus', sourceData: { [name]: text } }, [proposed]).tags, [proposed]);
  }
});

test('selected SKU limits multi-valued delivery formats and typed option labels', () => {
  const payload = { name: 'ChatGPT Plus', spec: '仅提供JSON', sourceData: {
    description: '另一个规格提供邮箱密码',
  } };
  const jsonTag = tag('delivery_format', 'json', 'spec', 'JSON');
  const credentialsTag = tag('delivery_format', 'credentials', 'sourceData.description', '邮箱密码');
  assert.deepEqual(validate(payload, [jsonTag, credentialsTag]).tags, [jsonTag]);
  const warrantyTag = tag('warranty_days', '30', 'spec', '30');
  assert.deepEqual(validate({ name: 'ChatGPT Plus', spec: '质保天数: 30 / 期限: 1个月' }, [warrantyTag]).tags, [warrantyTag]);
});

test('explicit missing JSON cannot support JSON delivery beside valid credentials', () => {
  const jsonTag = tag('delivery_format', 'json', 'sourceData.description', 'JSON');
  const credentialsTag = tag('delivery_format', 'credentials', 'sourceData.description', '邮箱密码');
  assert.deepEqual(validate({ name: 'ChatGPT Plus', sourceData: { description: '无JSON文件；提供邮箱密码' } }, [jsonTag, credentialsTag]).tags, [credentialsTag]);
});

test('labeled spec preserves warranty and SMS qualifier boundaries', () => {
  const payload = { name: 'ChatGPT Plus', spec: '质保天数: 30 / 期限: 1个月 / 需要短信验证: 有' };
  const tags = [tag('warranty_days', '30', 'spec', '30'), tag('duration', '1 month', 'spec', '1个月'), tag('sms_required', '有', 'spec', '有')];
  assert.deepEqual(validate(payload, tags).tags, tags);
  assertDropped(validate(payload, [tag('duration', '30 days', 'spec', '30')]));
  assertDropped(validate({ name: 'ChatGPT Plus', spec: '需要短信验证: 无 / 交付格式: JSON' }, [tag('sms_required', '有', 'spec', 'JSON')]));
});

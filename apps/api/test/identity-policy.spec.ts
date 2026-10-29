import test from 'node:test';
import assert from 'node:assert/strict';

import * as policy from '../src/standardization/identity-policy.ts';
import { buildCanonicalStandardKey } from '../src/standardization/canonical-key.ts';
import { buildExtractionPayload } from '../src/ai/adaptive-batching.js';
import { identityGuardRegressions } from './fixtures/identity-guard-regressions.js';

for (const raw of [
  { name: '陌生商品', sourceData: { evidence: '<p>交付内容、平台和套餐均未说明。</p>' } },
  { id: 'ChatGPT Free account', name: '陌生商品', sourceData: { evidence: '<p>交付内容未说明。</p>' } },
]) for (const format of ['raw', 'text'] as const) test('absence of account-plan proof cannot become Free or Codex: ' + raw.name + ' ' + format, () => {
  const evidence = format === 'raw' ? raw : buildExtractionPayload({ id: 'unknown', spec: '', ...raw });
  assert.ok(policy.identityEvidenceConflict({ family: 'openai', product: 'chatgpt', tier: 'free' }, evidence, format));
  assert.ok(policy.identityEvidenceConflict({ family: 'openai', product: 'codex_sms', tier: 'standard' }, evidence, format));
  assert.equal(policy.identityEvidenceConflict({ family: 'generic', product: 'unknown offering', tier: 'standard' }, evidence, format), null);
});

for (const format of ['raw', 'text'] as const) test('Gmail registration without mailbox delivery preserves spelled-out account credentials: ' + format, () => {
  const raw = { name: 'Gmail注册 Free 已接码', sourceData: { evidence: '<p>Gmail邮箱注册Free；不提供Gmail邮箱，无法登录Gmail，只提供ChatGPT Free账号和密码。</p>' } };
  const evidence = format === 'raw' ? raw : buildExtractionPayload({ id: 'registered-gmail-free', spec: '', ...raw });
  const identity = { family: 'openai', product: 'chatgpt', tier: 'free' };
  assert.equal(policy.identityEvidenceConflict(identity, evidence, format), null);
  assert.deepEqual(policy.assessProductEvidence(evidence, format).identity, identity);
});

for (const format of ['raw', 'text'] as const) test('comparison prices, model entitlements and optional purchases never hide delivered plans: ' + format, () => {
  const base = identityGuardRegressions.find(({ input }) => input.id === 'team-comparison')!.input;
  const identity = { family: 'openai', product: 'chatgpt', tier: 'team' };
  for (const delivery of ['实际交付Plus账号。', '提供Claude Pro账号。', '实际只售模型API额度。']) {
    const raw = { ...base, sourceData: { evidence: `${(base.sourceData as { evidence: string }).evidence}<p>${delivery}</p>` } };
    const evidence = format === 'raw' ? raw : buildExtractionPayload(raw);
    assert.ok(policy.identityEvidenceConflict(identity, evidence, format), delivery);
  }
  const optional = { ...base, sourceData: { evidence: '<p>本产品可定制Business母号(另购)。每月还多出15次Pro 模型机会。</p>' } };
  const evidence = format === 'raw' ? optional : buildExtractionPayload(optional);
  assert.equal(policy.identityEvidenceConflict(identity, evidence, format), null);
});

for (const [name, body, tier] of [
  ['【自营】已接马 gmail邮箱 free | 提供json和账密 | 带RT | 质保2h使用',
    '高纯度gmail邮箱注册free,已接马; 不提供gmail邮箱,无法登录gmail邮箱,只提供GP梯账密,只可登录GP梯!', 'free'],
  ['Codex Team月权益车位', '交付Team月权益车位，可与plus并存，缓解额度，不想升级pro。', 'team'],
  ['Chat G Plus 成品账号', '交付Chat G Plus账号，附带登录教程。', 'plus'],
  ['G!P!T Plus 成品账号', '只提供G!P!T Plus账号和密码。', 'plus'],
] as const) test('sold account survives registration, coexistence and aliases: ' + name, () => {
  const raw = { name, sourceData: { evidence: `<p>${body}</p>` } };
  const identity = { family: 'openai', product: 'chatgpt', tier };
  for (const format of ['raw', 'text'] as const) {
    const evidence = format === 'raw' ? raw : buildExtractionPayload({ id: 'sale', spec: '', ...raw });
    assert.equal(policy.identityEvidenceConflict(identity, evidence, format), null, format);
    assert.deepEqual(policy.assessProductEvidence(evidence, format).identity, identity, format);
  }
});

test('generic identities reject actual alternative-brand sales but not registration and use mentions', () => {
  const identity = { family: '即梦', product: '即梦', tier: '高级会员' };
  for (const [body, conflict] of [
    ['Canva可画免费用户,canva兑换', true],
    ['实际交付Canva Pro兑换码', true],
    ['使用Canva设计图片后上传，即梦高级会员月卡兑换。', false],
    ['注册Gmail邮箱后登录，即梦高级会员月卡兑换。', false],
    ['Canva可用于设计，即梦高级会员月卡兑换。', false],
  ] as const) for (const format of ['raw', 'text'] as const) {
    const raw = { name: '即梦高级会员月卡', sourceData: { evidence: `<p>${body}</p>` } };
    const evidence = format === 'raw' ? raw : buildExtractionPayload({ id: 'generic', spec: '', ...raw });
    assert.equal(Boolean(policy.identityEvidenceConflict(identity, evidence, format)), conflict, body + ' ' + format);
  }
});

test('account aliases and auxiliary filtering never hide independently sold brands or plans', () => {
  for (const raw of [
    { name: 'Chat G Plus账号', sourceData: { evidence: '实际交付Claude Pro账号。' } },
    { name: 'G!P!T Plus账号', sourceData: { evidence: '实际交付ChatGPT Pro20x账号。' } },
    { name: 'Codex Team月权益车位', sourceData: { evidence: '可与Plus并存，实际交付Plus账号。' } },
    { name: 'ChatGPT Pro25x账号' },
    { name: 'ChatGPT Pro10x账号' },
    { name: 'Gmail邮箱 Free', sourceData: { evidence: '实际只提供Gmail邮箱账号。' } },
  ]) for (const format of ['raw', 'text'] as const) {
    const evidence = format === 'raw' ? raw : buildExtractionPayload({ id: 'negative', spec: '', ...raw });
    assert.ok(policy.identityEvidenceConflict({ family: 'openai', product: 'chatgpt', tier: 'plus' }, evidence, format), raw.name);
  }
});

for (const { input, identity } of identityGuardRegressions) {
  test('identity guard accepts evidenced delivery in raw and frozen text: ' + input.name, () => {
    for (const format of ['raw', 'text'] as const) {
      const evidence = format === 'raw' ? input : buildExtractionPayload(input);
      assert.equal(policy.identityEvidenceConflict(identity, evidence, format), null, format);
      if (['chatgpt', 'meta_sms', 'discord_sms', 'paypal_sms', 'google_sms', 'facebook_sms', 'amazon_sms',
        'wechat_sms', 'twitter_sms', 'luma_sms'].includes(identity.product)) {
        assert.deepEqual(policy.assessProductEvidence(evidence, format).identity, identity, format);
      } else assert.equal(policy.assessProductEvidence(evidence, format).kind, 'other', format);
    }
  });
}

test('prerequisites and mailbox wording cannot conceal real subscription or sale-object conflicts', () => {
  const cases = [
    { name: 'Codex Go 官方充值', sourceData: { evidence: '<p>已加入 TEAM / 组织的账户，需要先退出团队。</p><p>实际交付 Claude Pro 账号。</p>' } },
    { name: 'Codex Go 官方充值', sourceData: { evidence: '<p>已加入 TEAM / 组织的账户，需要先退出团队，实际交付 Pro 20x 订阅。</p>' } },
    { name: 'Codex Go 官方充值', sourceData: { evidence: '<p>已加入 TEAM / 组织的账户，Claude Pro账号质保30天，需要先退出团队。</p>' } },
    { name: 'Codex Free iCloud 邮箱', sourceData: { evidence: '<p>本商品只交付邮箱收件箱访问CDK。</p><p>不是AI成品账号。</p>' } },
    { name: 'Codex Free iCloud 邮箱', sourceData: { evidence: '<p>实际交付 Claude Free 账号，邮箱仅为登录载体。</p>' } },
    { name: 'Codex Free iCloud 邮箱', sourceData: { evidence: '<p>实际交付 ChatGPT Plus 账号。</p>' } },
  ];
  for (const raw of cases) for (const format of ['raw', 'text'] as const) {
    const identity = { family: 'openai', product: 'chatgpt', tier: raw.name.includes('Free') ? 'free' : 'go' };
    const evidence = format === 'raw' ? raw : buildExtractionPayload({ id: 'guard', spec: '', ...raw });
    assert.ok(policy.identityEvidenceConflict(identity, evidence, format), raw.name + ' ' + format);
  }
});

test('explicit non-account titles cannot bypass contradictory delivery or become unknown Free accounts', () => {
  for (const raw of [
    { name: 'Google 邮箱', sourceData: { evidence: '不是邮箱，实际交付 Claude Pro 账号。' } },
    { name: '住宅 IP', sourceData: { evidence: '实际交付 ChatGPT Plus 账号。' } },
    { name: 'ChatGPT 成品账号', sourceData: { evidence: '发货账号、密码。' } },
  ]) for (const format of ['raw', 'text'] as const) {
    const evidence = format === 'raw' ? raw : buildExtractionPayload({ id: 'generic', spec: '', ...raw });
    assert.ok(policy.identityEvidenceConflict({ family: 'network', product: 'ip', tier: 'standard' }, evidence, format));
    assert.ok(policy.identityEvidenceConflict({ family: 'openai', product: 'chatgpt', tier: 'free' }, evidence, format));
  }
});

test('newly recognized SMS platforms still reject unknown platforms, unselected menus and mailbox or account delivery', () => {
  for (const raw of [
    { name: 'Mystery 接码 手机号', sourceData: { evidence: '交付手机号和接码链接。' } },
    { name: 'Meta / Discord 接码 手机号', sourceData: { evidence: '可选多个平台。' } },
    { name: 'Meta / PayPal 接码 手机号', sourceData: { evidence: '交付手机号。' } },
    { name: 'Meta 邮箱接码', sourceData: { evidence: '交付邮箱，接收邮件验证码。' } },
    { name: 'Meta 成品账号 已接码', sourceData: { evidence: '交付账号和密码。' } },
    { name: 'Meta 接码 手机号', sourceData: { evidence: '实际交付 Meta 成品账号和密码，已经接码。' } },
    { name: 'Meta 接码 手机号', sourceData: { evidence: '实际只交付邮箱验证码，不提供手机号。' } },
    { name: 'Codex Free iCloud 已接短信', sourceData: { evidence: 'Codex Free账号，邮箱是登录载体。' } },
  ]) for (const format of ['raw', 'text'] as const) {
    const evidence = format === 'raw' ? raw : buildExtractionPayload({ id: 'sms', spec: '', ...raw });
    assert.ok(policy.identityEvidenceConflict({ family: 'meta', product: 'meta_sms', tier: 'standard' }, evidence, format), raw.name);
    assert.ok(policy.identityEvidenceConflict({ family: 'openai', product: 'codex_sms', tier: 'standard' }, evidence, format), raw.name);
  }
});

test('G plus account listings cannot invent a Google Plus product', () => {
  const evidence = { name: 'G plus纯手搓成品|已接马|发账密2FA |无质保', spec: '',
    sourceData: { evidence: '只保证会员是plus。发货格式：账号----密码----2fa----收邮件API网址----JSON' } };
  const chatgpt = { family: 'openai', product: 'chatgpt', tier: 'plus' };
  for (const format of ['raw', 'text'] as const) {
    const input = format === 'raw' ? evidence : buildExtractionPayload({ id: '16130', ...evidence });
    assert.deepEqual(policy.assessProductEvidence(input, format).identity, chatgpt);
    assert.equal(policy.identityEvidenceConflict(chatgpt, input, format), null);
    assert.ok(policy.identityEvidenceConflict({ family: 'google', product: 'google_plus', tier: 'plus' }, input, format));
  }
  const google = { family: 'google', product: 'gemini', tier: 'plus' };
  assert.deepEqual(policy.assessProductEvidence({ name: 'Google AI Plus 官方订阅账号' }).identity, google);
  assert.ok(policy.identityEvidenceConflict(chatgpt, { name: 'Google AI Plus 官方订阅账号' }));
});

test('X Premium evidence keeps Premium and Premium Plus distinct', () => {
  const cases = [
    { name: 'X Premium 月卡充值', sourceData: { evidence: 'X Premium 月卡，自助卡密，正规IOS充值。' }, tier: 'premium' },
    { name: 'X Premium+ 1月官方正规充值CDK', sourceData: { evidence: 'X-Premium+ 赠送满血Super Grok，正规IOS充值(50$/月)。' }, tier: 'premium_plus' },
    { name: 'X Premium Plus 会员', sourceData: { evidence: 'X Premium Plus会员充值。' }, tier: 'premium_plus' },
    { name: 'X Premium & X Premium+ 1个月会员', spec: '【自助充值】X Premium1个月会员', sourceData: { evidence: '到账 Premium / Premium+ 一个月。' }, tier: 'premium' },
    { name: '推特X会员代开 Premium', spec: '【人工上号】1个月Premium+会员', sourceData: { evidence: 'Premium+是否赠送Grok会员以官方实际为准。' }, tier: 'premium_plus' },
    { name: 'X Premium / Premium+ 会员', spec: 'Premium+1y / 400刀/年【送一年Super Grok】', sourceData: { evidence: '可选 Premium / Premium+。' }, tier: 'premium_plus' },
  ] as const;
  for (const raw of cases) for (const format of ['raw', 'text'] as const) {
    const evidence = format === 'raw' ? raw : buildExtractionPayload({ id: `x-${raw.tier}`, spec: '', ...raw });
    const identity = { family: 'x', product: 'premium_membership', tier: raw.tier };
    assert.deepEqual(policy.assessProductEvidence(evidence, format).identity, identity, `${raw.name} ${format}`);
    assert.equal(policy.identityEvidenceConflict(identity, evidence, format), null, `${raw.name} ${format}`);
    assert.ok(policy.identityEvidenceConflict({ ...identity, tier: raw.tier === 'premium' ? 'premium_plus' : 'premium' }, evidence, format), `${raw.name} ${format}`);
  }
});

test('X monthly blue-badge recharge cannot establish Premium Plus from price alone', () => {
  for (const name of ['X-Twitter推特蓝标 质保订阅 旧版', '【自助充值】x Twitter 30天卡密']) {
    const raw = { name, sourceData: { evidence: 'X-Twitter自助卡密 正规IOS充值(10刀/月)' } };
    for (const format of ['raw', 'text'] as const) {
      const input = format === 'raw' ? raw : buildExtractionPayload({ id: 'x-blue', spec: '', ...raw });
      assert.ok(policy.identityEvidenceConflict({ family: 'x', product: 'premium_membership', tier: 'premium_plus' }, input, format), name + ' ' + format);
    }
  }
});

test('X Premium menus without a selected tier remain ambiguous', () => {
  const evidence = { name: 'X Premium / X Premium+ 会员充值', sourceData: { evidence: 'X Premium / X Premium+ 可选，到账对应会员。' } };
  for (const format of ['raw', 'text'] as const) {
    const input = format === 'raw' ? evidence : buildExtractionPayload({ id: 'x-menu', spec: '', ...evidence });
    assert.equal(policy.assessProductEvidence(input, format).kind, 'ambiguous', format);
    assert.ok(policy.identityEvidenceConflict({ family: 'x', product: 'premium_membership', tier: 'premium' }, input, format), format);
    assert.ok(policy.identityEvidenceConflict({ family: 'x', product: 'premium_membership', tier: 'premium_plus' }, input, format), format);
  }
});

test('X selected tiers cannot hide conflicting delivery or independent subscriptions', () => {
  for (const body of ['实际交付X Premium会员。', '实际只提供Grok会员。', '附带Grok和Cursor Pro会员。']) {
    const raw = { name: 'X Premium+ 会员', spec: 'Premium+', sourceData: { evidence: body } };
    for (const format of ['raw', 'text'] as const) {
      const input = format === 'raw' ? raw : buildExtractionPayload({ id: 'x-conflict', ...raw });
      assert.ok(policy.identityEvidenceConflict({ family: 'x', product: 'premium_membership', tier: 'premium_plus' }, input, format), body + ' ' + format);
    }
  }
  assert.equal(policy.identityEvidenceConflict({ family: 'x', product: 'account', tier: 'standard' },
    { name: 'X 普号', sourceData: { evidence: '交付账号和密码。' } }), null);
});

test('Grok account platform aliases converge without absorbing X social accounts or other brands', () => {
  const expected = { family: 'xai', product: 'grok', tier: 'free' };
  for (const family of ['xai', 'xAI', 'x.ai', 'grok', 'gro', 'x']) {
    for (const product of ['Grok', 'gro', 'gr0k']) {
      const input = { family, product, tier: '普号' };
      assert.deepEqual(policy.normalizeIdentity(input), expected);
      assert.equal(buildCanonicalStandardKey(input), buildCanonicalStandardKey(expected));
    }
  }
  assert.equal(policy.isValidCatalogIdentity({ family: 'google', product: 'grok', tier: 'free' }), false);
  const social = { family: 'x', product: 'twitter', tier: 'premium' };
  assert.deepEqual(policy.normalizeIdentity(social), social);
  assert.notEqual(buildCanonicalStandardKey(social), buildCanonicalStandardKey(expected));
  assert.notEqual(buildCanonicalStandardKey({ ...expected, tier: 'super' }), buildCanonicalStandardKey(expected));
});

test('Grok free evidence resolves abbreviations but keeps ambiguous or different products separate', () => {
  for (const name of ['gro普号(库存)', 'Grok 普号', 'gr0k 普通账号', 'gro普号（新号）']) {
    assert.deepEqual(policy.assessProductEvidence({ name, spec: '', evidence: '清库存，有一些可用build，有的只能console和web' }).identity,
      { family: 'xai', product: 'grok', tier: 'free' }, name);
  }
  assert.deepEqual(policy.assessProductEvidence({ name: 'X Premium 账号' }).identity,
    { family: 'x', product: 'premium_membership', tier: 'premium' });
  for (const name of ['Grok API credits', 'Grok 网页镜像 普号', 'gro普号 / SuperGrok 会员', 'ChatGPT Grok 普号', 'Grok 接码服务', 'Grok 普号教程']) {
    assert.equal(policy.assessProductEvidence({ name }).identity, undefined, name);
  }
});

test('Grok title hints cannot override conflicting selected plans or subscription descriptions', () => {
  for (const evidence of [
    { sourceData: { tier: 'super' } }, { spec: 'plan: SuperGrok' }, { sourceData: { evidence: '实际交付 SuperGrok 会员' } },
  ]) assert.equal(policy.assessProductEvidence({ name: 'gro普号(库存)', ...evidence }).identity, undefined);
  assert.deepEqual(policy.assessProductEvidence({ name: 'gro普号(库存)', sourceData: { category: { name: 'gro直充/super/free' } } }).identity,
    { family: 'xai', product: 'grok', tier: 'free' });
});

test('explicit Grok Super offers cannot be published or regrouped as Heavy', () => {
  const heavy = { family: 'xai', product: 'grok', tier: 'heavy' };
  const standard = { family: 'xai', product: 'grok', tier: 'supergrok' };
  for (const name of ['Super周卡独享成品号', '格洛克 Super 印区直充 一个月', 'Grok Super 月卡'])
    assert.ok(policy.identityEvidenceConflict(heavy, { name }), name);
  assert.ok(policy.identityEvidenceConflict(standard, { name: 'SuperGrok Heavy 月卡' }));
  assert.equal(policy.identityEvidenceConflict(heavy, { name: 'SuperGrok Heavy 月卡' }), null);
  assert.ok(policy.identityEvidenceConflict(standard, { name: '格洛克 Super 印区直充 一个月' }));
  assert.equal(policy.identityEvidenceConflict(standard, { name: 'SuperGrok 月订阅' }), null);
});

test('Grok paid tiers read raw markup once and keep frozen literal tags intact', () => {
  const heavy = { family: 'xai', product: 'grok', tier: 'heavy' };
  for (const [name, conflict] of [
    ['SuperGrok <b>Heavy</b> 月卡', false],
    ['Grok Su<b>per</b> 月卡', true],
    ['SuperGrok &lt;b&gt;Heavy&lt;/b&gt; 月卡', false],
  ] as const) {
    const raw = { name };
    const frozen = buildExtractionPayload({ id: 'grok', name, spec: '' });
    assert.equal(Boolean(policy.identityEvidenceConflict(heavy, raw, 'raw')), conflict, name + ' raw');
    assert.equal(Boolean(policy.identityEvidenceConflict(heavy, frozen, 'text')), conflict, name + ' frozen');
  }
});

test('official account aliases normalize without losing quota multipliers', () => {
  assert.ok(policy);
  for (const [family, product, tier, expected] of [
    ['OpenAI', 'Codex', 'Pro 5X', { family: 'openai', product: 'chatgpt', tier: 'pro_5x' }],
    ['OpenAI', 'ChatGPT', 'Business 5x', { family: 'openai', product: 'chatgpt', tier: 'team_5x' }],
    ['Anthropic', 'Claude Code', 'Max 20x', { family: 'anthropic', product: 'claude', tier: 'max_20x' }],
    ['Google', 'Google AI', 'Ultra 20X', { family: 'google', product: 'gemini', tier: 'ultra_20x' }],
    ['Google', 'Gemini', 'Google AI Pro', { family: 'google', product: 'gemini', tier: 'pro' }],
    ['OpenAI', 'ChatGPT', '普号', { family: 'openai', product: 'chatgpt', tier: 'free' }],
  ] as const) assert.deepEqual(policy.normalizeIdentity({ family, product, tier }), expected);
});

test('ChatGPT Pro official dollar names and market multiplier aliases normalize to stable catalog tiers', () => {
  for (const [tier, expected] of [
    ['Pro 5x', 'pro_5x'], ['5x Pro', 'pro_5x'], ['Pro 5倍', 'pro_5x'], ['5倍 Pro', 'pro_5x'], ['Pro 100', 'pro_5x'], ['100 Pro', 'pro_5x'], ['Pro 100美元', 'pro_5x'], ['100美元 Pro', 'pro_5x'],
    ['Pro 10x', 'pro_20x'], ['10x Pro', 'pro_20x'], ['Pro 10倍', 'pro_20x'], ['10倍 Pro', 'pro_20x'], ['Pro 20x', 'pro_20x'], ['20x Pro', 'pro_20x'], ['Pro 200', 'pro_20x'], ['200 Pro', 'pro_20x'],
    ['Pro 25x', 'pro_500'], ['25x Pro', 'pro_500'], ['Pro 25倍', 'pro_500'], ['25倍 Pro', 'pro_500'], ['Pro 50x', 'pro_500'], ['50x Pro', 'pro_500'], ['Pro 50×', 'pro_500'], ['Pro 500', 'pro_500'], ['500 Pro', 'pro_500'], ['Pro 500美金', 'pro_500'], ['500美金 Pro', 'pro_500'],
  ] as const) {
    assert.deepEqual(policy.normalizeIdentity({ family: 'OpenAI', product: 'ChatGPT', tier }),
      { family: 'openai', product: 'chatgpt', tier: expected }, tier);
  }
  assert.equal(policy.isValidCatalogIdentity({ family: 'openai', product: 'chatgpt', tier: 'pro_500' }), true);
});

test('ChatGPT Pro dollar names and current/legacy multiplier evidence resolve without guessing', () => {
  for (const [name, expected] of [
    ['ChatGPT Pro 100 账号', { family: 'openai', product: 'chatgpt', tier: 'pro_5x' }],
    ['ChatGPT 100 Pro 账号', { family: 'openai', product: 'chatgpt', tier: 'pro_5x' }],
    ['ChatGPT Pro 5x 账号', { family: 'openai', product: 'chatgpt', tier: 'pro_5x' }],
    ['ChatGPT Pro 200 账号', { family: 'openai', product: 'chatgpt', tier: 'pro_20x' }],
    ['ChatGPT Pro 10x 账号', { family: 'openai', product: 'chatgpt', tier: 'pro_20x' }],
    ['ChatGPT Pro 20x 账号', { family: 'openai', product: 'chatgpt', tier: 'pro_20x' }],
    ['ChatGPT 200 Pro 账号', { family: 'openai', product: 'chatgpt', tier: 'pro_20x' }],
    ['ChatGPT Pro 500 账号', { family: 'openai', product: 'chatgpt', tier: 'pro_500' }],
    ['ChatGPT Pro 25x 账号', { family: 'openai', product: 'chatgpt', tier: 'pro_500' }],
    ['ChatGPT Pro 50x 账号', { family: 'openai', product: 'chatgpt', tier: 'pro_500' }],
    ['ChatGPT 500 Pro 账号', { family: 'openai', product: 'chatgpt', tier: 'pro_500' }],
    ['ChatGPT Pro $500 账号', { family: 'openai', product: 'chatgpt', tier: 'pro_500' }],
    ['ChatGPT 500美金 PRO账号', { family: 'openai', product: 'chatgpt', tier: 'pro_500' }],
    ['ChatGPT 500美元 Pro账号', { family: 'openai', product: 'chatgpt', tier: 'pro_500' }],
    ['ChatGPT USD 500 Pro账号', { family: 'openai', product: 'chatgpt', tier: 'pro_500' }],
  ] as const) {
    assert.deepEqual(policy.assessProductEvidence({ name }).identity, expected, name);
    assert.equal(policy.identityEvidenceConflict(expected, { name }), null, name);
  }
  for (const name of ['ChatGPT Pro 35x 账号', 'ChatGPT Pro 35x 500美元账号']) {
    const assessment = policy.assessProductEvidence({ name });
    assert.equal(assessment.kind, 'ambiguous', name);
    assert.equal(assessment.identity, undefined, name);
  }
  const legacySellerName = { name: 'ChatGPT Pro 20x 500刀账号' };
  assert.deepEqual(policy.assessProductEvidence(legacySellerName).identity, { family: 'openai', product: 'chatgpt', tier: 'pro_20x' });
  assert.equal(policy.identityEvidenceConflict({ family: 'openai', product: 'chatgpt', tier: 'pro_20x' }, legacySellerName), null);
  assert.deepEqual(policy.assessProductEvidence({ name: 'ChatGPT Pro 25x 500美元账号' }).identity,
    { family: 'openai', product: 'chatgpt', tier: 'pro_500' });
});

test('ChatGPT Pro equivalent current and legacy multipliers may coexist', () => {
  for (const [name, tier] of [
    ['ChatGPT Pro 200 10x（原20x）账号', 'pro_20x'],
    ['ChatGPT Pro 500 25x（原50x）账号', 'pro_500'],
    ['ChatGPT Pro 10x / 20x账号', 'pro_20x'],
    ['ChatGPT Pro 25× / 50倍账号', 'pro_500'],
  ]) for (const format of ['raw', 'text'] as const) {
    const raw = { name: name! };
    const evidence = format === 'raw' ? raw : buildExtractionPayload({ id: 'pro-alias', spec: '', ...raw });
    const identity = { family: 'openai', product: 'chatgpt', tier: tier! };
    assert.deepEqual(policy.assessProductEvidence(evidence, format).identity, identity, name + ' ' + format);
    assert.equal(policy.identityEvidenceConflict(identity, evidence, format), null, name + ' ' + format);
  }
});

test('ChatGPT Pro multiple unselected amount tiers and contradictory delivery remain review', () => {
  for (const raw of [
    { name: 'ChatGPT Pro 100 / Pro 200账号' },
    { name: 'ChatGPT Pro 200 / Pro 500账号' },
    { name: 'ChatGPT Pro 100/200/500账号' },
    { name: 'ChatGPT Pro 100美元 / 200美元账号' },
    { name: 'ChatGPT Pro $200 / $500账号' },
    { name: 'ChatGPT Pro 200 25x账号' },
    { name: 'ChatGPT Pro 500 20x账号' },
    { name: 'ChatGPT Pro 10x / 25x账号' },
    { name: 'ChatGPT Pro 10x / 35x账号' },
    { name: 'ChatGPT Pro 200账号', sourceData: { evidence: '实际交付Pro 500订阅账号。' } },
  ]) for (const format of ['raw', 'text'] as const) {
    const evidence = format === 'raw' ? raw : buildExtractionPayload({ id: 'pro-conflict', spec: '', ...raw });
    const assessment = policy.assessProductEvidence(evidence, format);
    assert.equal(assessment.kind, 'ambiguous', raw.name + ' ' + format);
    assert.equal(assessment.identity, undefined, raw.name + ' ' + format);
    assert.ok(policy.identityEvidenceConflict({ family: 'openai', product: 'chatgpt', tier: 'pro_500' }, evidence, format), raw.name);
  }
});

test('ChatGPT Pro sale prices balances and usage amounts do not select a subscription tier', () => {
  for (const [name, tier] of [
    ['ChatGPT Pro 200账号 售价500美元', 'pro_20x'],
    ['ChatGPT Pro 100账号 附赠余额500美元', 'pro_5x'],
    ['ChatGPT Pro 200账号 使用额度500美元', 'pro_20x'],
    ['ChatGPT Pro 20x 500刀账号', 'pro_20x'],
    ['ChatGPT Pro 10x账号 售价$500', 'pro_20x'],
  ]) {
    assert.deepEqual(policy.assessProductEvidence({ name }).identity, { family: 'openai', product: 'chatgpt', tier }, name);
  }
  for (const name of ['ChatGPT Pro账号 售价500美元', 'ChatGPT Pro账号 余额$200', 'ChatGPT Pro账号 使用额度100美元']) {
    assert.equal(policy.assessProductEvidence({ name }).kind, 'ambiguous', name);
  }
  for (const name of ['ChatGPT Pro 100000美元账号', 'ChatGPT Pro 100.5美元账号', 'ChatGPT Pro 100x账号']) {
    assert.equal(policy.assessProductEvidence({ name }).kind, 'ambiguous', name);
  }
});

test('ChatGPT Pro identity normalization cannot erase contradictory amount or multiplier labels', () => {
  for (const [tier, expected] of [
    ['Pro 200 10x（原20x）', 'pro_20x'], ['Pro 500 25x（原50x）', 'pro_500'],
  ]) assert.equal(policy.normalizeIdentity({ family: 'openai', product: 'chatgpt', tier }).tier, expected, tier);
  for (const tier of ['Pro 100 / Pro 200', 'Pro 100/200/500', 'Pro 200 25x', 'Pro 200 35x', 'Pro 500 20x']) {
    const identity = { family: 'openai', product: 'chatgpt', tier };
    assert.equal(policy.isValidCatalogIdentity(identity), false, tier);
    assert.equal(policy.normalizeIdentity(identity).tier, tier.toLowerCase(), tier);
  }
});

test('automatic publication requires three known textual identity fields', () => {
  assert.equal(policy.hasValidIdentityFields({ family: ' OpenAI ', product: 'ChatGPT', tier: 'ＰＲＯ' }), true);
  for (const value of ['', 'UNKNOWN', 'unknow', 'notapplicable', 'not applicable', ' 未知 ', 'n/a', 'unspecified', 'unknown\u200b', '\u200b', 'pro\u200b', null, 7]) {
    assert.equal(policy.hasValidIdentityFields({ family: 'OpenAI', product: 'ChatGPT', tier: value as string }), false);
  }
});

test('catalog accepts official combinations and retains other complete product identities', () => {
  assert.ok(policy);
  for (const [family, product, tiers] of [
    ['openai', 'chatgpt', ['free', 'go', 'plus', 'pro_5x', 'pro_20x', 'pro_500', 'team', 'team_5x']],
    ['google', 'gemini', ['plus', 'pro', 'ultra_5x', 'ultra_20x']],
    ['anthropic', 'claude', ['free', 'pro', 'max_5x', 'max_20x', 'team', 'team_5x']],
  ] as const) for (const tier of tiers) assert.equal(policy.isValidCatalogIdentity({ family, product, tier }), true, `${product} ${tier}`);
  for (const input of [
    { family: 'openai', product: 'chatgpt', tier: 'pro' },
    { family: 'anthropic', product: 'claude', tier: 'max' },
    { family: 'google', product: 'gemini', tier: 'ultra' },
    { family: 'google', product: 'chatgpt', tier: 'plus' },
    { family: 'openai', product: 'chatgpt', tier: 'premium' },
    { family: 'openai', product: 'chatgpt', tier: 'unknow' },
    { family: 'gpu', product: 'rtx 4090', tier: 'not applicable' },
    { family: 'gpu', product: 'rtx 4090', tier: 'pro\u200b' },
  ]) assert.equal(policy.isValidCatalogIdentity(input), false, JSON.stringify(input));
  assert.equal(policy.isValidCatalogIdentity({ family: 'gpu', product: 'rtx 4090', tier: 'high end' }), true);
});

test('subscription plans and recharge delivery cannot escape identity validation as generic products', () => {
  for (const [family, product, tier] of [
    ['openai', 'chatgpt_pro_20x_recharge_servicepro_20x_recharge_service', 'pro_20x_recharge_service'],
    ['openai', 'chatgpt_pro_20x_recharge_service', 'pro_20x'],
    ['openai', 'chatgpt_pro_20x', 'standard'],
    ['openai', 'chatgpt_recharge_service', 'pro_20x'],
    ['openai', 'codex_pro_5x_top_up_service', 'standard'],
    ['anthropic', 'claude_code_max_20x_recharge_service', 'standard'],
    ['google', 'google_ai_pro_recharge_service', 'standard'],
    ['google', 'gemini_ultra_5x', 'standard'],
    ['openai', 'chatgpt', 'pro_20x_recharge_service'],
  ]) {
    const identity = { family: family!, product: product!, tier: tier! };
    assert.equal(policy.isValidCatalogIdentity(identity), false, product);
    assert.ok(policy.identityEvidenceConflict(identity, { name: '充值服务' }), product);
  }
  for (const product of ['chatgpt_api_credits', 'chatgpt_pro_20x_tutorial', 'chatgpt_pro_20x_recharge_service_tutorial', 'codex_sms']) {
    const identity = { family: 'openai', product, tier: 'standard' };
    assert.equal(policy.isValidCatalogIdentity(identity), product !== 'chatgpt_api_credits', product);
    assert.deepEqual(policy.normalizeIdentity(identity), product.endsWith('_tutorial')
      ? { family: 'openai', product: 'chatgpt', tier: 'tutorial' } : identity);
  }
});

test('account evidence recognizes official plans and business aliases', () => {
  assert.ok(policy);
  for (const [name, expected] of [
    ['Claude普号 普通账户', { family: 'anthropic', product: 'claude', tier: 'free' }],
    ['Gemini Pro 18个月', { family: 'google', product: 'gemini', tier: 'pro' }],
    ['【自营】Team 5X', { family: 'openai', product: 'chatgpt', tier: 'team_5x' }],
    ['team 5x', { family: 'openai', product: 'chatgpt', tier: 'team_5x' }],
    ['team', { family: 'openai', product: 'chatgpt', tier: 'team' }],
    ['codex 5x Team', { family: 'openai', product: 'chatgpt', tier: 'team_5x' }],
    ['OpenAI ChatGPT Plus 账号', { family: 'openai', product: 'chatgpt', tier: 'plus' }],
    ['Codex Pro 5x 订阅账号', { family: 'openai', product: 'chatgpt', tier: 'pro_5x' }],
    ['ChatGPT Pro20x 账号', { family: 'openai', product: 'chatgpt', tier: 'pro_20x' }],
    ['team5x账号', { family: 'openai', product: 'chatgpt', tier: 'team_5x' }],
    ['Team 5X 账号', { family: 'openai', product: 'chatgpt', tier: 'team_5x' }],
    ['5x Team 账号', { family: 'openai', product: 'chatgpt', tier: 'team_5x' }],
    ['Business 账号', { family: 'openai', product: 'chatgpt', tier: 'team' }],
    ['plus会员', { family: 'openai', product: 'chatgpt', tier: 'plus' }],
    ['Go 账号', { family: 'openai', product: 'chatgpt', tier: 'go' }],
    ['Google AI Pro 账号 2TB Google One', { family: 'google', product: 'gemini', tier: 'pro' }],
    ['Gemini Ultra 5x 订阅', { family: 'google', product: 'gemini', tier: 'ultra_5x' }],
    ['Claude Code Max20x账号', { family: 'anthropic', product: 'claude', tier: 'max_20x' }],
    ['Anthropic Claude Pro 账号', { family: 'anthropic', product: 'claude', tier: 'pro' }],
    ['Claude Team Premium 账号', { family: 'anthropic', product: 'claude', tier: 'team_5x' }],
    ['ChatGPT 普号可升级Pro', { family: 'openai', product: 'chatgpt', tier: 'free' }],
    ['ChatGPT 普通账户 未订阅', { family: 'openai', product: 'chatgpt', tier: 'free' }],
    ['ChatGPT Team 5人共享账号', { family: 'openai', product: 'chatgpt', tier: 'team' }],
    ['ChatGPT Team 5个账号', { family: 'openai', product: 'chatgpt', tier: 'team' }],
  ] as const) {
    const result = policy.assessProductEvidence({ name });
    assert.equal(result.kind, 'account', name);
    assert.deepEqual(result.identity, expected, name);
  }
});

test('account evidence preserves ambiguous plans and conflicting brands for review', () => {
  assert.ok(policy);
  for (const name of ['ChatGPT Pro 账号', 'Pro 账号', 'Claude Max 账号', 'Gemini Ultra 账号', 'ChatGPT Plus/Pro 账号', 'ChatGPT Claude Pro账号', 'ChatGPT Pro 5x/20x 账号']) {
    const result = policy.assessProductEvidence({ name });
    assert.equal(result.kind, 'ambiguous', name);
    assert.equal(result.identity, undefined, name);
    assert.ok(result.conflict, name);
  }
});

for (const [name, identity] of [
  ['Team 10x', { family: 'openai', product: 'chatgpt', tier: 'team' }],
  ['ChatGPT Team 10x 账号', { family: 'openai', product: 'chatgpt', tier: 'team' }],
  ['Claude Team 20倍 Premium 账号', { family: 'anthropic', product: 'claude', tier: 'team_5x' }],
  ['ChatGPT Pro 0.5x', { family: 'openai', product: 'chatgpt', tier: 'pro_5x' }],
] as const) test(`unsupported or contradictory quota cannot be published: ${name}`, () => {
  const assessment = policy.assessProductEvidence({ name });
  assert.equal(assessment.kind, 'ambiguous');
  assert.equal(assessment.identity, undefined);
  assert.ok(policy.identityEvidenceConflict(identity, { name }));
});

test('quota recognition rejects unsupported numeric values without matching a decimal suffix', () => {
  for (const name of ['Team 0.5x', 'ChatGPT Team 0x', 'ChatGPT Team 1x', 'ChatGPT Team 100x', 'ChatGPT Pro 20.5x', 'Claude Max .5倍', 'ChatGPT Team 5x/10x']) {
    assert.equal(policy.assessProductEvidence({ name }).kind, 'ambiguous', name);
    assert.equal(policy.assessProductEvidence({ name }).identity, undefined, name);
  }
  for (const [name, identity] of [
    ['ChatGPT Pro 5x', { family: 'openai', product: 'chatgpt', tier: 'pro_5x' }],
    ['ChatGPT Pro 10x', { family: 'openai', product: 'chatgpt', tier: 'pro_20x' }],
    ['ChatGPT Pro 25x', { family: 'openai', product: 'chatgpt', tier: 'pro_500' }],
    ['ChatGPT Pro 20x', { family: 'openai', product: 'chatgpt', tier: 'pro_20x' }],
    ['Claude Max 20倍', { family: 'anthropic', product: 'claude', tier: 'max_20x' }],
    ['Claude Team Premium 5x', { family: 'anthropic', product: 'claude', tier: 'team_5x' }],
    ['Claude Team Premium', { family: 'anthropic', product: 'claude', tier: 'team_5x' }],
  ] as const) {
    assert.deepEqual(policy.assessProductEvidence({ name }).identity, identity, name);
    assert.equal(policy.identityEvidenceConflict(identity, { name }), null, name);
  }
});

test('brand defaults and account recognition do not absorb unrelated products or model availability', () => {
  assert.ok(policy);
  for (const name of ['Steam 账号', 'TeamViewer Pro 账号', 'Cursor Pro 订阅', 'Codex API credits', 'Codex API 充值', 'Claude Code 教程', 'GPT-5 模型 API', 'Google One 2TB', 'plus', 'Arbitrary Pro account']) {
    assert.equal(policy.assessProductEvidence({ name }).kind, 'other', name);
  }
  assert.deepEqual(policy.assessProductEvidence({ name: 'ChatGPT Plus 账号 支持 Gemini Pro 和 Claude 模型' }).identity, { family: 'openai', product: 'chatgpt', tier: 'plus' });
  assert.equal(policy.assessProductEvidence({ name: 'Plus 账号', sourceData: { brand: 'Adobe' } }).kind, 'other');
  assert.deepEqual(policy.assessProductEvidence({ name: 'Pro 账号', sourceData: { brand: 'Anthropic' } }).identity, { family: 'anthropic', product: 'claude', tier: 'pro' });
});

test('SMS service exclusions distinguish services from account delivery claims', () => {
  assert.ok(policy);
  for (const name of ['ChatGPT 接码服务', 'Claude 接码', 'OpenAI SMS verification service']) {
    assert.equal(policy.assessProductEvidence({ name }).kind, 'sms_service', name);
  }
  for (const name of ['ChatGPT Plus 账号 无需接码', 'ChatGPT Plus 已接码账号']) {
    assert.equal(policy.assessProductEvidence({ name }).kind, 'account', name);
  }
});

test('model support filtering cannot erase SMS service evidence or its delivery exceptions', () => {
  const identity = { family: 'openai', product: 'chatgpt', tier: 'plus' };
  for (const name of ['支持 ChatGPT 接码服务', 'ChatGPT Plus 支持接码服务', '支持 OpenAI SMS verification service']) {
    assert.equal(policy.assessProductEvidence({ name }).kind, 'sms_service', name);
    assert.ok(policy.identityEvidenceConflict(identity, { name }), name);
  }
  assert.equal(policy.assessProductEvidence({ name: 'ChatGPT Plus', spec: '支持接码服务' }).kind, 'sms_service');
  for (const name of ['ChatGPT Plus 账号 无需接码 支持 Gemini Pro 和 Claude 模型', 'ChatGPT Plus 已接码账号 支持 Gemini Pro 和 Claude 模型']) {
    assert.deepEqual(policy.assessProductEvidence({ name }).identity, identity, name);
    assert.equal(policy.identityEvidenceConflict(identity, { name }), null, name);
  }
});

test('evidence guards reject brand, product, plan and multiplier substitutions', () => {
  assert.ok(policy);
  const claude = { family: 'anthropic', product: 'claude', tier: 'pro' };
  assert.ok(policy.identityEvidenceConflict(claude, { name: 'ChatGPT Plus 账号' }));
  for (const tier of ['pro', 'pro_20x', 'plus']) assert.ok(policy.identityEvidenceConflict({ family: 'openai', product: 'chatgpt', tier }, { name: 'ChatGPT Pro 5x账号' }));
  assert.ok(policy.identityEvidenceConflict({ family: 'openai', product: 'chatgpt', tier: 'pro_5x' }, { name: 'ChatGPT Pro 账号' }));
  assert.ok(policy.identityEvidenceConflict({ family: 'openai', product: 'chatgpt', tier: 'free' }, { name: 'OpenAI Codex API credits' }));
  assert.equal(policy.identityEvidenceConflict({ family: 'openai', product: 'chatgpt', tier: 'plus' }, { name: 'ChatGPT Plus 账号' }), null);
  assert.equal(policy.identityEvidenceConflict({ family: 'gpu', product: 'x', tier: 'pro' }, { name: 'Generic fixture' }), null);
  assert.ok(policy.identityEvidenceConflict({ family: 'openai', product: 'chatgpt', tier: 'plus' }, { name: 'ChatGPT Plus 支持多种模型', spec: 'Claude Pro' }));
  assert.ok(policy.identityEvidenceConflict({ family: 'anthropic', product: 'claude', tier: 'free' }, { name: 'Claude 普号可升级 Pro', spec: 'ChatGPT Plus' }));
});

test('model descriptions and available-model clauses preserve independent source brand evidence', () => {
  assert.equal(policy.assessProductEvidence({ name: 'Gemini Pro 模型' }).kind, 'other');
  assert.equal(policy.assessProductEvidence({ name: 'Claude Pro model' }).kind, 'other');
  assert.deepEqual(policy.assessProductEvidence({ name: 'Pro 账号 支持高级模型', sourceData: { brand: 'Anthropic' } }).identity, { family: 'anthropic', product: 'claude', tier: 'pro' });
  assert.equal(policy.assessProductEvidence({ name: 'ChatGPT Plus 账号 支持高级模型', sourceData: { brand: 'Anthropic' } }).kind, 'ambiguous');
});

test('identity checks inspect long evidence tails and all spec text', () => {
  const longTail = policy.assessProductEvidence({
    name: `ChatGPT Plus account ${'x'.repeat(9000)} Anthropic`,
  });
  assert.equal(longTail.kind, 'ambiguous');
  assert.match(longTail.conflict ?? '', /brand/i);

  const manyOptions = Array.from({ length: 60 }, (_, index) => index === 59 ? 'Anthropic' : `option-${index}`);
  assert.equal(policy.assessProductEvidence({ name: 'ChatGPT Plus account', spec: manyOptions.join(' / ') }).kind, 'ambiguous');
});

test('provider names alone do not turn generic products into account subscriptions', () => {
  const generic = { family: 'openai', product: 'product 1', tier: 'plus' };
  assert.equal(policy.assessProductEvidence({ name: 'OpenAI Product 1 Plus' }).kind, 'other');
  assert.ok(policy.identityEvidenceConflict(generic, { name: 'OpenAI Product 1 Plus' }));
  assert.deepEqual(policy.assessProductEvidence({ name: 'Plus 账号', sourceData: { brand: 'OpenAI' } }).identity,
    { family: 'openai', product: 'chatgpt', tier: 'plus' });
  assert.deepEqual(policy.assessProductEvidence({ name: 'Team 账号', category: 'Digital subscriptions', sourceData: { description: 'Instant delivery' } }).identity,
    { family: 'openai', product: 'chatgpt', tier: 'team' });
});

test('unapproved Codex and Claude Code objects require review', () => {
  for (const identity of [
    { family: 'openai', product: 'codex', tier: 'api credits' },
    { family: 'anthropic', product: 'claude code', tier: 'plugin' },
  ]) {
    assert.deepEqual(policy.normalizeIdentity(identity), identity);
    assert.equal(policy.isValidCatalogIdentity(identity), false);
    assert.ok(policy.identityEvidenceConflict(identity, { name: `${identity.product} ${identity.tier}` }));
  }
  assert.equal(policy.isValidCatalogIdentity({ family: 'openai', product: 'codex', tier: 'pro' }), false);
});

test('tutorials share a product-level identity regardless of plan, topic or format', () => {
  const expected = { family: 'openai', product: 'chatgpt', tier: 'tutorial' };
  for (const input of [
    { family: 'openai', product: 'chatgpt', tier: '教程' },
    { family: 'openai', product: 'chatgpt', tier: 'guide' },
    { family: 'openai', product: 'codex', tier: 'tutorial' },
    { family: 'openai', product: 'chatgpt_plus_turkey_subscription_tutorial', tier: 'standard' },
    { family: 'openai', product: 'chatgpt_pro20x_ios_subscription_tutorial', tier: 'standard' },
    { family: 'openai', product: 'codex_tutorial_video', tier: 'standard' },
  ]) {
    assert.deepEqual(policy.normalizeIdentity(input), expected);
    assert.equal(policy.isValidCatalogIdentity(input), true);
    assert.equal(buildCanonicalStandardKey(input), buildCanonicalStandardKey(expected));
  }
  assert.deepEqual(policy.normalizeIdentity({ family: 'anthropic', product: 'Claude Code', tier: 'tutorial' }),
    { family: 'anthropic', product: 'claude', tier: 'tutorial' });
  assert.equal(policy.isValidCatalogIdentity({ family: 'google', product: 'chatgpt', tier: 'tutorial' }), false);
  assert.notEqual(buildCanonicalStandardKey(expected), buildCanonicalStandardKey({ ...expected, tier: 'plus' }));
  assert.notEqual(buildCanonicalStandardKey(expected), buildCanonicalStandardKey({ family: 'google', product: 'gemini', tier: 'tutorial' }));
});

test('product-level tutorials require sold instructional goods and the right subject', () => {
  const identity = { family: 'openai', product: 'chatgpt', tier: 'tutorial' };
  const cases: Array<[Record<string, any>, boolean]> = [
    [{ name: 'ChatGPT Plus 土区订阅教程' }, false],
    [{ name: 'ChatGPT Pro 20x iOS 教程', sourceData: { evidence: '对照 Google Play 的付款流程。' } }, false],
    [{ name: 'Codex <b>教学</b>视频' }, false],
    [{ name: '小白反代教程|已接马PLUS|未接马PLUS|bugteam|K12', sourceData: { evidence: '发货是文档教程' } }, false],
    [{ name: 'G plus 土区开通教程' }, false],
    [{ name: 'ChatGPT Plus 账号，附赠使用教程' }, true],
    [{ name: 'ChatGPT Plus 账号', sourceData: { instructions: 'ChatGPT 登录教程' } }, true],
    [{ name: 'ChatGPT Plus 账号', sourceData: { evidence: '使用教程：请先登录' } }, true],
    [{ name: 'Claude Max 20x 教程' }, true],
    [{ name: 'ChatGPT / Gemini 教程合集' }, true],
    [{ name: 'Steam 充值教程' }, true],
    [{ name: '教程' }, true],
  ];
  for (const [evidence, conflict] of cases) for (const format of ['raw', 'text'] as const) {
    const input = format === 'raw' ? evidence : buildExtractionPayload({ id: 'tutorial', name: evidence.name, spec: '', ...evidence });
    assert.equal(Boolean(policy.identityEvidenceConflict(identity, input, format)), conflict, evidence.name + ' ' + format);
  }
});

// Redacted real misrejections: the title names the sold plan; description device
// limits, recharge prerequisites and fee notes are not alternative offers.
for (const [name, evidence, identity] of [
  ['CPT Team团队版管理员号(母号)开子号席位仅需10美金/月', '官方定价:25/月\n提供30天技术支持与质保', { family: 'openai', product: 'chatgpt', tier: 'team' }],
  ['GPlus菲律宾官方卡充|质保一个月订阅|无法覆盖', '商品内容:Plus菲律宾官方卡充|质保一个月订阅|卡密自助充值', { family: 'openai', product: 'chatgpt', tier: 'plus' }],
  ['G codex pro100月卡【直冲自己账号】 正规充值', '设备数量限制:\nPlus:最多同时登录 2 台设备\nPro 5×:最多同时登录 3 台设备\nPro 20×:最多同时登录 5 台设备', { family: 'openai', product: 'chatgpt', tier: 'pro_5x' }],
  ['plus官方充值月卡(质保一个月)', '需要账号状态为free才可充值\n24小时卡密全自动充值', { family: 'openai', product: 'chatgpt', tier: 'plus' }],
  ['【卡冲官方充值】Claude max5x (质保订阅)', '必须过kyc\n商品介绍:Claude max 5x 一个月', { family: 'anthropic', product: 'claude', tier: 'max_5x' }],
] as const) for (const format of ['raw', 'text'] as const) test('title-anchored plan survives description mentions: ' + name + ' ' + format, () => {
  const raw = { name, sourceData: { evidence } };
  const input = format === 'raw' ? raw : buildExtractionPayload({ id: 'anchored', spec: '', ...raw });
  assert.deepEqual(policy.assessProductEvidence(input, format).identity, identity);
  assert.equal(policy.identityEvidenceConflict(identity, input, format), null);
});

test('use wording and eligibility titles never become a sold plan', () => {
  assert.equal(policy.assessProductEvidence({ name: 'VISA卡,可充值Gplus会员', sourceData: { evidence: '虚拟卡一张' } }).identity, undefined);
  assert.equal(policy.assessProductEvidence({ name: 'G Plus 半价资格号 两月', sourceData: { evidence: '此账号本身尚未开通 G Plus 订阅服务' } }).kind, 'other');
});

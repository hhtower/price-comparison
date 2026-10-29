import assert from 'node:assert/strict';
import test from 'node:test';
import { assessProductEvidence, identityEvidenceConflict, isValidCatalogIdentity } from '../src/standardization/identity-policy.js';
import { buildExtractionPayload } from '../src/ai/adaptive-batching.js';
import { saleEvidenceView } from '../src/standardization/sale-evidence.js';
import { isExcludedApiRelay } from '../src/standardization/catalog-exclusion.js';

const team = { family: 'openai', product: 'chatgpt', tier: 'team' };
const team5x = { ...team, tier: 'team_5x' };
for (const [name, description, expected] of [
  ['Team 标准席位', '提供标准席位。也不是5Xteam。', team],
  ['Team 标准席位', '标准席位的额度是 Plus 的1.25倍。交付Team订阅账号。', team],
  ['Team 5X 成品 JSON', '已开通Team 5X。成品JSON交付，仅支持Sub2API。', team5x],
  ['G Team 子号Token', '实时验活的 ChatGPT Team 子号，含refresh_token，CPA JSON + sub2api 导入 JSON。', team],
  ['Team 5X Gmail邮箱', '本商品为Team 5X成品账号，Gmail注册，交付账号密码2FA。', team5x],
  ['Team 5X 成品账号', '提供Team 5X账号，禁止反代。', team5x],
] as const) test('reviewed Team sale: ' + name + ' / ' + description, () => {
  const raw = { name, sourceData: { evidence: description } };
  const frozen = buildExtractionPayload({ id: 'team-review', ...raw, spec: '' });
  for (const [input, format] of [[raw, 'raw'], [frozen, 'text']] as const) {
    assert.deepEqual(assessProductEvidence(input, format).identity, expected);
    assert.equal(identityEvidenceConflict(expected, input, format), null);
    assert.equal(isExcludedApiRelay(input, format), false);
    assert.ok(identityEvidenceConflict(expected.tier === 'team' ? team5x : team, input, format));
  }
});

for (const [name, description] of [
  ['Team提链 CDK', '本商品仅提供结账链接生成工具，不包含账号、订阅费用及优惠券。'],
  ['Team优惠码', '仅售优惠码，不包含最终订阅费用，买家自行支付。'],
  ['Gmail 邮箱账号', '仅售邮箱，需买家自行开通Team订阅。'],
  ['Codex邀请积分', '交付邀请积分，Team账号不支持。'],
  ['ChatGPT 基础账号', '未订阅，买家需自行加入Team后再提取凭证。'],
] as const) test('reviewed distinct sale object: ' + name, () => {
  const raw = { name, sourceData: { evidence: description } };
  for (const [input, format] of [[raw, 'raw'], [buildExtractionPayload({ id: 'other-review', ...raw, spec: '' }), 'text']] as const) {
    assert.ok(identityEvidenceConflict(team, input, format));
    assert.ok(identityEvidenceConflict(team5x, input, format));
    assert.equal(isExcludedApiRelay(input, format), false);
  }
});

test('premium and K12 alone cannot establish a Team subscription tier', () => {
  for (const name of ['Business premium 成品账号', 'G Team K12 成品']) {
    const raw = { name, sourceData: { evidence: 'JSON发货，仅支持Sub2API。' } };
    assert.ok(identityEvidenceConflict(team, raw));
    assert.ok(identityEvidenceConflict(team5x, raw));
    assert.equal(isExcludedApiRelay(raw), false);
  }
});

test('selected standard and mixed advanced seats resolve the offered menu without erasing real delivery conflicts', () => {
  const menu = '套餐可选：标准席位、5X高级席位。高级席位=5X Team。';
  for (const [spec, expected] of [['2个标准席位', team], ['1个高级席位+1个标准席位', team5x]] as const) {
    const raw = { name: 'Team 订阅套餐', spec, sourceData: { evidence: menu } };
    for (const [input, format] of [[raw, 'raw'], [buildExtractionPayload({ id: 'selected', ...raw }), 'text']] as const) {
      assert.equal(identityEvidenceConflict(expected, input, format), null, spec);
      assert.ok(identityEvidenceConflict(expected.tier === 'team' ? team5x : team, input, format));
    }
  }
  const conflict = { name: 'Team 5X 成品账号', sourceData: { evidence: '实际只交付标准 Team 席位，不是5Xteam。' } };
  assert.ok(identityEvidenceConflict(team5x, conflict));
  assert.ok(identityEvidenceConflict(team, conflict));
  const denial = { name: 'Team 5X 成品账号', sourceData: { evidence: '本商品不是5Xteam。' } };
  const selectedStandard = { name: 'Team 订阅套餐', spec: '2个标准席位', sourceData: { evidence: '套餐可选标准或高级席位；实际提供5X Team账号，其他套餐可选。' } };
  for (const [raw, reject5x, rejectStandard] of [[denial, true, true], [selectedStandard, true, true]] as const) {
    for (const [input, format] of [[raw, 'raw'], [buildExtractionPayload({ id: 'conflict', ...raw, spec: raw.spec ?? '' }), 'text']] as const) {
      assert.equal(Boolean(identityEvidenceConflict(team5x, input, format)), reject5x);
      assert.equal(Boolean(identityEvidenceConflict(team, input, format)), rejectStandard);
    }
  }
});

// Production job 7412: incidental instructions and buyer restrictions are not inventory.
for (const [name, description, identity] of [
  ['GP Plus 月卡 Codex', '交付 Plus 账号。✅改2FA教程\n不提供私人教学。登录凭证包含 outlook token。', { family: 'openai', product: 'chatgpt', tier: 'plus' }],
  ['Claude 优质普号 outlook邮箱注册', '微软邮箱注册的 Claude free 号。发货格式：邮箱、密码、outlook token、claude sk。兑换网站提供 cookie 登录教程。', { family: 'anthropic', product: 'claude', tier: 'free' }],
  ['Gemini Pro 成品号 带rt凭证', '没有教学。基础教程 https://example.invalid/guide\n如果显示 FREE 是年龄没过。正常使用是 Pro 一年。', { family: 'google', product: 'gemini', tier: 'pro' }],
  ['Codex 5x Pro 官方充值', '充值要求账号无任何订阅：已开通 Plus / Pro 的账号请勿下单，菲区 Plus 和 iOS 内购的 Plus 也无法升级。', { family: 'openai', product: 'chatgpt', tier: 'pro_5x' }],
  ['Codex Pro 20x 成品号，剩15天，到期可当资格号使用', '交付 Pro 20x 订阅。', { family: 'openai', product: 'chatgpt', tier: 'pro_20x' }],
  ['Codex 20x Pro 官方充值（只有资格号可以充）', '充值到买家的账号。', { family: 'openai', product: 'chatgpt', tier: 'pro_20x' }],
  ['plus成品特殊gmail渠道订阅号', 'Plus 成品号，发货账号、密码、2FA。', { family: 'openai', product: 'chatgpt', tier: 'plus' }],
  ['ChatGPT Plus 独享账号', '请勿使用 Amazon、Google、Alibaba 的 IP；不提供教程或教学。', { family: 'openai', product: 'chatgpt', tier: 'plus' }],
  ['老gmail+Claude成品账号', '住宅IP注册，这是普通账号，无任何订阅套餐，不懂勿拍！不担保谷歌账号能用所有功能，比如gmail、youtube等。', { family: 'anthropic', product: 'claude', tier: 'free' }],
  ['Plus账号 已接马', '邮箱API收不到验证码？验证码不更新？只质保掉订阅，正常使用codex保。', { family: 'openai', product: 'chatgpt', tier: 'plus' }],
  ['Codex Pro 5x 官方充值', '已开通 Plus / Team / Pro 的账号，禁止提交充值订单。跟着步骤获取token令牌；复制粘贴token，确认信息。', { family: 'openai', product: 'chatgpt', tier: 'pro_5x' }],
  ['Codex Pro 5x 官方充值', '不能充到以前充过0刀plus卡密的账号；必须要等账号变成免费版且渡过宽限期！兑换后获得Pro 5x订阅。', { family: 'openai', product: 'chatgpt', tier: 'pro_5x' }],
  ['5x-Team-2fa格式 账号', '本商品为Team成品JSON，谷歌邮箱注册。只能放sub2api用。https://5xteam.example.invalid', { family: 'openai', product: 'chatgpt', tier: 'team_5x' }],
  ['Codex 5x team 账号', '目前账号额度存在不稳定情况，Plus额度同样可能出现波动。Team仅支持Sub2API。', { family: 'openai', product: 'chatgpt', tier: 'team_5x' }],
  ['codex Plus 成品号 质保30天', '本商品仅为账号本身，不附带Codex手机接码验证。小店无法提供接码支持。', { family: 'openai', product: 'chatgpt', tier: 'plus' }],
  ['PLUS账号 未绑定手机号 UPI渠道', '未接马网页号，使用codex需要自己接马（手机接马部分不在售后范围）。', { family: 'openai', product: 'chatgpt', tier: 'plus' }],
  ['Claude Max x20 成品号', '', { family: 'anthropic', product: 'claude', tier: 'max_20x' }],
  ['5Xteam 长效车 不踢', '交付Team订阅账号。', { family: 'openai', product: 'chatgpt', tier: 'team_5x' }],
  ['CodexPlus成品号1个月', '', { family: 'openai', product: 'chatgpt', tier: 'plus' }],
  ['Claude 成品账号', '请检查账号是否可用\n这是普通账号，无任何订阅套餐。', { family: 'anthropic', product: 'claude', tier: 'free' }],
  ['Team 5x', '仅支持sub2api\n本商品为Team成品账号。', { family: 'openai', product: 'chatgpt', tier: 'team_5x' }],
  ['Claude普通账号', '不是ccmax20x账号。', { family: 'anthropic', product: 'claude', tier: 'free' }],
  ['Plus iOS官方直充月卡', '加入Team的账号需先退出；原Pro订阅需等到期后再操作。账号信息：邮箱、密码、收邮件API网址。', { family: 'openai', product: 'chatgpt', tier: 'plus' }],
  ['OpenAI Pro20x正价代充【20x资格号充值专用】', '账号必须是free才可以充。账号现有Plus / Team / Pro订阅，请勿下单。', { family: 'openai', product: 'chatgpt', tier: 'pro_20x' }],
  ['5x team 过夜车 gmail账密2fa', '交付Team席位。', { family: 'openai', product: 'chatgpt', tier: 'team_5x' }],
  ['plus成品号 Codex需接马', '账号信息：成品号+未接码。', { family: 'openai', product: 'chatgpt', tier: 'plus' }],
  ['Gemini Pro 成品 官方订阅 老邮箱账号', '发货格式：邮箱、密码、手机号+接码链接（此赠送的手机号并非已绑定）。调取API等进阶操作不提供技术支持。', { family: 'google', product: 'gemini', tier: 'pro' }],
  ['Codex Pro 5× 正规卡充', '', { family: 'openai', product: 'chatgpt', tier: 'pro_5x' }],
  ['Codex Pro20x代充', '该账号目前没有GO、PLUS、PRO等订阅。只能充值有过20x账单的免费版账号。账户需为free状态。', { family: 'openai', product: 'chatgpt', tier: 'pro_20x' }],
  ['Codex Pro5x卡充', '如需覆盖菲区plus。复制跳转页全部内容（即Token）。可以点击Plus套餐自动刷新。查看头像旁是否显示Plus标识。必须先退出Team。', { family: 'openai', product: 'chatgpt', tier: 'pro_5x' }],
  ['Claude Team Premium 席位', '使用额度约为普通Claude Max5x的1.25倍。普通Claude Max5x的1.25倍。不是给转发接口、共享账号等用途使用。但实际额度并不是固定Token。', { family: 'anthropic', product: 'claude', tier: 'team_5x' }],
  ['克劳德Team席位', '怕封就去玩OpenAI。', { family: 'anthropic', product: 'claude', tier: 'team' }],
  ['Plus成品号 PP渠道', '发货包含access_token和refresh_token。', { family: 'openai', product: 'chatgpt', tier: 'plus' }],
  ['5x-Team-2fa格式【CC渠道】', 'team仅支持sub2api。本商品为Team成品JSON。', { family: 'openai', product: 'chatgpt', tier: 'team_5x' }],
  ['Claude普通账号', '未开通订阅', { family: 'anthropic', product: 'claude', tier: 'free' }],
  ['ChatGPT普号', '未开通订阅', { family: 'openai', product: 'chatgpt', tier: 'free' }],
  ['Codex Pro20x 官方续费', '仅限Pro20x续费。plantype改成free提交订单。', { family: 'openai', product: 'chatgpt', tier: 'pro_20x' }],
  ['Codex Pro5x 成品号', '不要再去开通Codex Team；后期如果Team出问题可能导致会员丢失。', { family: 'openai', product: 'chatgpt', tier: 'pro_5x' }],
  ['Codex Plus 官方充值', '账号封禁无售后：违规使用（批量注册，颜色，API中转），因此不在退款范围内。', { family: 'openai', product: 'chatgpt', tier: 'plus' }],
  ['Claude普通账号', '账号充值问题自行解决，充max会跳kyc，充pro也有几率，不接受退款。', { family: 'anthropic', product: 'claude', tier: 'free' }],
  ['Codex Pro5x 官方充值', '<p>以下情况不属于售后范围：</p><p>因违规使用导致的账号封禁，例如：</p><p>• API中转、共享滥用</p><p>• 频繁切换地区</p><p>交付Pro5x订阅。</p>', { family: 'openai', product: 'chatgpt', tier: 'pro_5x' }],
] as const) test('production identity guard preserves the sold subscription: ' + name, () => {
  const raw = { name, sourceData: { evidence: description } };
  const frozen = buildExtractionPayload({ id: 'regression', ...raw, spec: '' });
  for (const [input, format] of [[raw, 'raw'], [frozen, 'text']] as const) {
    assert.deepEqual(assessProductEvidence(input, format).identity, identity, description + ' ' + format);
    assert.equal(identityEvidenceConflict(identity, input, format), null);
  }
});

test('incidental instructions never conceal a contradictory actual sale', () => {
  const plus = { family: 'openai', product: 'chatgpt', tier: 'plus' };
  for (const description of ['不提供教学，实际交付 Claude Pro 账号', '使用教程：实际只交付 API credits', '到期可当资格号使用，实际仅售资格，未开通订阅',
    'Claude Pro账号质保30天', 'ClaudePro账号质保30天', '提供Claude Pro账号并附教程', '已开通Claude Pro订阅，禁止改密', '未开通订阅']) {
    const raw = { name: 'ChatGPT Plus 账号', sourceData: { evidence: description } };
    const frozen = buildExtractionPayload({ id: 'contradiction', ...raw, spec: '' });
    assert.ok(identityEvidenceConflict(plus, raw), description);
    assert.ok(identityEvidenceConflict(plus, frozen, 'text'), description + ' frozen');
  }
  assert.ok(identityEvidenceConflict({ family: 'google', product: 'gemini', tier: 'ultra_5x' }, { name: 'G PRO 5X 菲区官方卡充 全自动' }));
  assert.ok(identityEvidenceConflict(plus, { name: 'Codex API credits 充值' }));
  assert.ok(identityEvidenceConflict(plus, { name: 'ChatGPT Plus 账号', sourceData: { evidence: '本商品为Claude Pro账号，质保30天，住宅IP。' } }));
  assert.ok(identityEvidenceConflict(plus, { name: 'ChatGPT Plus 账号', sourceData: { evidence: '账号现有Plus订阅禁止购买，本商品为Claude Pro账号。' } }));
  assert.ok(identityEvidenceConflict(plus, { name: 'ChatGPT Plus 账号', sourceData: { evidence: '使用教程：交付Claude Pro账号，质保30天。' } }));
  for (const description of ['账号封禁无售后，本商品为Claude Pro账号', '<p>以下情况不属于售后范围：</p><p>• API中转</p><p>• 实际交付Claude Pro账号</p>', '<p>以下情况不属于售后范围：</p><p>• API中转</p><p>实际只交付API credits</p>',
    '账号充值问题自行解决，交付 API credits。', '因官方风控，交付 API credits。', '以下情况不属于售后范围：API中转，交付API credits。',
    '账号封禁无售后， 提供 API credits。', '账号充值问题自行解决，出售Claude Pro账号。',
    ...['。', ';', '；', '!', '！', '?', '？'].map(boundary => `以下情况不属于售后范围：API中转${boundary}交付API credits。`)]) {
    const raw = { name: 'ChatGPT Plus 账号', sourceData: { evidence: description } };
    assert.ok(identityEvidenceConflict(plus, raw), description);
    assert.ok(identityEvidenceConflict(plus, buildExtractionPayload({ id: 'exclusions', ...raw, spec: '' }), 'text'), description);
  }
});

// Minimal, redacted fragments from seven independently observed failures.
for (const [id, evidence, expected] of [
  ['517', { name: 'Gemini Pro 12个月pixel成品号', sourceData: { evidence: '<p><span><strong>使用教程 &nbsp;</strong></span><a href="https://example.invalid/guide">https://example.invalid/guide</a></p><p>交付 Gemini Pro 成品号</p>' } }, { family: 'google', product: 'gemini', tier: 'pro' }],
  ['11162', { name: 'Codex PRO 5x 官方充值', sourceData: { evidence: '<p>兑换后获得 1 个月 Pro 5x 订阅</p><p>加入过 Team 空间的，请先切回个人版再获取 Token</p><p>曾用过 0 刀 Plus 卡密的账号禁止充值</p><p>必须等账号变回免费版，再充值</p>' } }, { family: 'openai', product: 'chatgpt', tier: 'pro_5x' }],
  ['14098', { name: 'Plus|Gmail域名|Codex|成品号', sourceData: { evidence: '<p>交付 Plus 订阅账号，Gmail 域名注册</p>' } }, { family: 'openai', product: 'chatgpt', tier: 'plus' }],
  ['15378', { name: 'Codex Pro 20x代充月卡CDK', sourceData: { evidence: '<p>交付 Pro 20x 月权益</p><p>Plus / Pro 均可覆盖</p><p>Team 账号,均不支持充值；Team 未退出账号勿下单</p>' } }, { family: 'openai', product: 'chatgpt', tier: 'pro_20x' }],
  ['15477', { name: 'Codex 2500点数额度充值 (Free账号勿下)', sourceData: { evidence: '交付 Codex 点数额度；Free 免费账号无法购买' } }, null],
  ['16686', { name: '【官方充值】 pro 20x 成品号', sourceData: { evidence: '<p>交付 Pro 20x 订阅</p><p>代理对接马，联系方式已省略</p>' } }, { family: 'openai', product: 'chatgpt', tier: 'pro_20x' }],
  ['23356', { name: '微软 Microsoft 全球接马', sourceData: { evidence: '<p>交付接马服务卡密，取号收短信</p>' } }, { family: 'microsoft', product: 'microsoft_sms', tier: 'standard' }],
] as const) test('redacted real sale-object failure ' + id, () => {
  const frozen = buildExtractionPayload({ id, name: evidence.name, spec: '', sourceData: evidence.sourceData });
  for (const [input, format] of [[evidence, 'raw'], [frozen, 'text']] as const) {
    const result = assessProductEvidence(input, format);
    if (expected) {
      assert.deepEqual(result.identity, expected);
      assert.equal(identityEvidenceConflict(expected, input, format), null);
    } else {
      assert.equal(result.kind, 'other');
      assert.ok(identityEvidenceConflict({ family: 'openai', product: 'chatgpt', tier: 'free' }, input, format));
    }
  }
});

test('sold tutorials, API credits, mailboxes, menus and contradictory delivery remain protected', () => {
  for (const name of ['ChatGPT Plus 使用教程 PDF', 'Codex API Token 充值', 'Gmail 邮箱账号'])
    assert.equal(assessProductEvidence({ name }).kind, 'other', name);
  assert.equal(assessProductEvidence({ name: 'ChatGPT Plus/Pro 5x 订阅' }).kind, 'ambiguous');
  assert.equal(assessProductEvidence({ name: 'ChatGPT Plus 账号', sourceData: { evidence: '<p>实际交付 Claude Pro 账号</p>' } }).kind, 'ambiguous');
  assert.equal(assessProductEvidence({ name: 'Contoso 接码服务' }).kind, 'ambiguous');
  for (const name of ['ChatGPT Plus 注册邮箱', 'Google 邮箱账号']) assert.equal(assessProductEvidence({ name }).kind, 'other', name);
  const contradiction = { name: 'Codex Pro 5x 账号', sourceData: { evidence: '<p>曾用过 0 刀 Plus 卡密的账号禁止充值</p><p>实际交付 Claude Pro 账号</p>' } };
  for (const [input, format] of [[contradiction, 'raw'], [buildExtractionPayload({ id: 'conflict', ...contradiction, spec: '' }), 'text']] as const)
    assert.equal(assessProductEvidence(input, format).kind, 'ambiguous');
});

test('time extension cards cannot be assigned to Team subscriptions', () => {
  for (const raw of [
    { name: 'team 续时1h卡', sourceData: { category: 'OpenAI team/business' } },
    { name: 'ChatGPT Team 续时1h卡' },
    { name: 'TEAM 续时１Ｈ卡', sourceData: { evidence: '用于已有Team账号续时。' } },
    { name: 'Team 5x', spec: '续时1小时卡', sourceData: { evidence: '需已有账号，不提供新账号。' } },
    { name: 'ChatGPT Team 续时卡' },
  ]) {
    const frozen = buildExtractionPayload({ id: 'time-extension', ...raw, spec: 'spec' in raw ? raw.spec : '' });
    for (const [evidence, format] of [[raw, 'raw'], [frozen, 'text']] as const) {
      assert.equal(assessProductEvidence(evidence, format).kind, 'other', raw.name + ' ' + format);
      for (const identity of [team, team5x]) assert.ok(identityEvidenceConflict(identity, evidence, format), raw.name + ' ' + format);
    }
  }
  for (const raw of [
    { name: 'ChatGPT Team 席位续费月卡', sourceData: { evidence: '续费30天Team标准席位。' } },
    { name: 'Team 5x 账号 质保1h', sourceData: { evidence: '提供Team 5x账号，另有续时1h卡出售。' } },
    { name: 'ChatGPT Team账号（不含续时卡）' },
    { name: 'ChatGPT Team账号，续时1h卡另购' },
  ]) assert.equal(assessProductEvidence(raw).kind, 'account', raw.name);
});

test('Team discount codes stay separate from Team subscriptions and seat redemption codes', () => {
  const discountCode = { family: 'openai', product: 'chatgpt_team_discount_code', tier: 'standard' };
  assert.equal(isValidCatalogIdentity(discountCode), true);
  for (const evidence of [
    { name: '48个月team 埃及/瑞典22刀优惠码', sourceData: { evidence: '只提供优惠码，需要自己付款。' } },
    { name: 'TEAM 48个月减席位优惠码', sourceData: { evidence: '自行提链支付，优惠码使用一次失效。' } },
    { name: 'Team 优惠码', sourceData: { evidence: '此为开通1xteam空间所用优惠码，兑换后自行支付。' } },
  ]) {
    assert.deepEqual(assessProductEvidence(evidence).identity, discountCode, evidence.name);
    assert.equal(identityEvidenceConflict(discountCode, evidence), null, evidence.name);
  }

  for (const evidence of [
    { name: 'Business / Team 标准席位兑换码', sourceData: { evidence: '兑换后加入 Team 空间，每张卡增加 30 天。' } },
    { name: 'G Team 母号开通', sourceData: { evidence: '非优惠码 Team 车，需要新增席位。' } },
  ]) {
    assert.deepEqual(assessProductEvidence(evidence).identity, { family: 'openai', product: 'chatgpt', tier: 'team' }, evidence.name);
  }
});

test('raw and frozen evidence preserve sales claims across HTML and sentence boundaries', () => {
  const cases = [
    [{ name: 'Codex Pro 5x 账号', sourceData: { evidence: '曾用过 0 刀 Plus 卡密的账号禁止充值；实际交付 Claude Pro 账号' } }, 'ambiguous'],
    [{ name: 'Codex Pro 5x 账号', sourceData: { evidence: '曾用过 0 刀 Plus 卡密的账号禁止充值 实际交付 Claude Pro 账号' } }, 'ambiguous'],
    [{ name: 'Codex Pro 5x 账号', sourceData: { evidence: '请先获取 Token 实际交付 Claude Pro 账号' } }, 'ambiguous'],
    [{ name: 'Codex Pro 5x 账号', sourceData: { evidence: '支持 Plus / Pro 覆盖续费 实际交付 Claude Pro 账号' } }, 'ambiguous'],
    [{ name: 'Gemini Pro 账号', sourceData: { evidence: '<p><b>使用教程</b></p><p>交付 Gemini Pro 账号</p>' } }, 'account'],
    [{ name: 'ChatGPT Plus 账号', sourceData: { evidence: '<p>实际交付<strong>微软接码</strong>服务</p>' } }, 'ambiguous'],
  ] as const;
  for (const [raw, expected] of cases) {
    const frozen = buildExtractionPayload({ id: 'case', name: raw.name, spec: '', sourceData: raw.sourceData });
    assert.equal(assessProductEvidence(raw, 'raw').kind, expected, raw.name + ' raw');
    assert.equal(assessProductEvidence(frozen, 'text').kind, expected, raw.name + ' frozen');
  }
  const encoded = { sourceData: { evidence: '&lt;b&gt;字面&lt;/b&gt;' } };
  assert.equal((saleEvidenceView(encoded, 'raw').sourceData as any).evidence, '<b>字面</b>');
  assert.equal((saleEvidenceView({ sourceData: { evidence: '<b>字面</b>' } }, 'text').sourceData as any).evidence, '<b>字面</b>');
});

for (const [name, description, identity] of [
  ['GP Plus 月卡', '交付 Plus 会员账号。买家需要自行接码，附带登录教程。', { family: 'openai', product: 'chatgpt', tier: 'plus' }],
  ['Gemini Pro 账号', '交付 Gemini Pro 成品。首次登录需自行接码；使用说明参考 ChatGPT 教程。', { family: 'google', product: 'gemini', tier: 'pro' }],
  ['Claude Team Premium 账号', '交付 Team Premium 订阅。额度与 Max 5x 相同，升级 Max 20x 需要另外付费。', { family: 'anthropic', product: 'claude', tier: 'team_5x' }],
] as const) test(`usage requirements and plan comparisons do not replace the sale object: ${name}`, () => {
  const evidence = { name, sourceData: { description } };
  assert.deepEqual(assessProductEvidence(evidence).identity, identity);
  assert.equal(identityEvidenceConflict(identity, evidence), null);
});

test('selected plan wins over an explicitly offered list but actual delivery contradictions require review', () => {
  const identity = { family: 'openai', product: 'chatgpt', tier: 'plus' };
  const evidence = { name: 'ChatGPT Plus/Pro 5x 订阅', spec: 'Plus', sourceData: { description: '套餐可选 Plus 或 Pro 5x' } };
  assert.deepEqual(assessProductEvidence(evidence).identity, identity);
  assert.equal(assessProductEvidence({ name: 'ChatGPT Plus/Pro 5x 订阅' }).kind, 'ambiguous');
  assert.equal(assessProductEvidence({ name: 'ChatGPT Plus 账号', sourceData: { description: '实际交付 Claude Pro 账号' } }).kind, 'ambiguous');
  assert.equal(assessProductEvidence({ ...evidence, sourceData: { ...evidence.sourceData, description: '实际交付 ChatGPT Pro 5x 账号' } }).kind, 'ambiguous');
});

test('SMS sale objects retain their identity with API transport and mailbox registration uses', () => {
  for (const evidence of [
    { name: 'Codex 短效单次接码 可接api', sourceData: { description: '交付美国手机号，用 API 收取短信验证码' } },
    { name: 'Google 邮箱注册接码', sourceData: { description: '交付手机号，只接一次短信，不出售邮箱账号。' } },
  ]) {
    const platform = evidence.name.startsWith('Codex') ? 'codex' : 'google';
    assert.deepEqual(assessProductEvidence(evidence).identity, { family: platform === 'codex' ? 'openai' : 'google', product: `${platform}_sms`, tier: 'standard' });
  }
});

test('mailboxes, eligibility accounts, K12 and sold tutorials never acquire the compared subscription', () => {
  for (const evidence of [
    { name: 'Gmail 邮箱账号', sourceData: { description: '用于注册 ChatGPT，可能需要手机接码，不保证 OpenAI 业务。' } },
    { name: 'iCloud 邮箱取件 API', sourceData: { description: '交付邮箱，通过 API 接收邮件验证码。' } },
    { name: 'Claude Max 20x 开通资格号', sourceData: { description: '只售开通资格，未开通会员，买家自行订阅。' } },
    { name: 'Gemini K12 教育资格号', sourceData: { description: '仅提供资格，可申请 Gemini Pro，未开通订阅。' } },
    { name: 'K12 成品号', sourceData: { description: '可以申请Plus学生优惠。' } },
    { name: 'Plus学生认证', sourceData: { description: '通过认证后购买一个月Plus，再领取学生优惠。' } },
    { name: 'Codex新手一站式安装服务', sourceData: { description: '指导注册Google邮箱及ChatGPT账号。' } },
    { name: 'ChatGPT Plus 使用教程 PDF', sourceData: { description: '拍下交付 PDF，教程涉及手机接码。' } },
  ]) {
    assert.equal(assessProductEvidence(evidence).kind, 'other', evidence.name);
    assert.ok(identityEvidenceConflict({ family: 'openai', product: 'chatgpt', tier: 'plus' }, evidence), evidence.name);
  }
});

test('explicitly false mailbox titles conflict with mailbox identities', () => {
  const evidence = { name: 'Gmail 母号', sourceData: { description: '不是谷歌邮箱，实际交付 ChatGPT 普号。' } };
  assert.ok(identityEvidenceConflict({ family: 'google', product: 'gmail', tier: 'standard' }, evidence));
});

test('explicit SMS API inventory is distinct from model API credits with registration instructions', () => {
  for (const name of ['Codex 短信 API 接码服务', 'OpenAI SMS API verification service']) {
    assert.deepEqual(assessProductEvidence({ name, sourceData: { description: '交付手机号和短信验证码，API 自动取码。' } }).identity, { family: 'openai', product: 'codex_sms', tier: 'standard' }, name);
  }
  assert.equal(assessProductEvidence({ name: 'Codex API credits', sourceData: { description: '注册账号需要手机接码' } }).kind, 'other');
});

test('sale assertions are not erased by instructions earlier in the same sentence', () => {
  const evidence = { name: 'ChatGPT Plus 账号', sourceData: { description: '买家自行接码，实际交付 Claude Pro 账号' } };
  assert.equal(assessProductEvidence(evidence).kind, 'ambiguous');
  assert.equal(assessProductEvidence({ name: 'ChatGPT Plus 账号', sourceData: { description: '实际仅交付手机接码服务，不提供会员账号' } }).kind, 'ambiguous');
  assert.equal(assessProductEvidence({ name: 'ChatGPT Plus 账号 支持 Gemini 模型，实际交付 Claude Pro 账号' }).kind, 'ambiguous');
});

test('comparison and after-sales clauses preserve the selected account without proving entitlement elsewhere', () => {
  const evidence = { name: 'Claude Team Premium 账号', sourceData: { description: '额度相当于 Max 5x；升级为 Max 20x 需另外付费；售后不负责 Google 接码。' } };
  assert.deepEqual(assessProductEvidence(evidence).identity, { family: 'anthropic', product: 'claude', tier: 'team_5x' });
});

test('title-selected plans ignore eligible-account prerequisites and exclusions', () => {
  const cases = [
    [{ name: 'Codex 25x Pro500 质保30天 官方直充 500美金 | 卡充 | OpenAI', sourceData: { evidence: '可下单账号：免费版(Free)账号；已有 plus、5x 套餐联系客服提供账号。' } }, { family: 'openai', product: 'chatgpt', tier: 'pro_500' }],
    [{ name: 'GTP Go 1个月会员充自己号', sourceData: { evidence: '适用账号：当前为免费版的普通账号；没有 Plus、Pro、Go 或其他有效订阅。' } }, { family: 'openai', product: 'chatgpt', tier: 'go' }],
    [{ name: 'OpenAI PLUS 菲区正价CDK秒冲', sourceData: { evidence: '商品内容：菲律宾官方代充 Plus 1个月；不要使用 Team 的 session 进行充值。' } }, { family: 'openai', product: 'chatgpt', tier: 'plus' }],
    [{ name: 'OpenAI Pro5X 菲区正价CDK秒冲', sourceData: { evidence: '商品内容：菲律宾官方代充 Pro5X 1个月；不要使用team的session进行充值。' } }, { family: 'openai', product: 'chatgpt', tier: 'pro_5x' }],
    [{ name: 'claude pro iOS 渠道(质保订阅)', sourceData: { evidence: '账号必须为免费版；正规全区ios充值，使用Claude即可充值。' } }, { family: 'anthropic', product: 'claude', tier: 'pro' }],
  ] as const;
  for (const [evidence, expected] of cases) {
    const raw = { ...evidence, sourceData: { evidence: `<p>${evidence.sourceData.evidence}</p>` } };
    for (const format of ['raw', 'text'] as const) {
      const input = format === 'raw' ? raw : buildExtractionPayload({ id: 'plan-prerequisite', spec: '', ...raw });
      assert.deepEqual(assessProductEvidence(input, format).identity, expected, evidence.name + ' ' + format);
      assert.equal(identityEvidenceConflict(expected, input, format), null);
    }
  }
});

test('title-selected plans still reject an explicitly different delivered plan or split sale object', () => {
  const cases = [{
    name: '【CL官方充值】G pro5x 卡冲',
    sourceData: { evidence: '<p><strong>商品内容：</strong>【CL官方代充】G plus 1个月【质保30天】。</p>' },
  }, {
    name: '【Plus成品】G Plus成品号,质保订阅',
    sourceData: { evidence: '<h3><strong>现将成品拆成：</strong><span>普号+代充</span></h3><p>请购买普号自行代充。</p>' },
  }];
  for (const raw of cases) for (const format of ['raw', 'text'] as const) {
    const input = format === 'raw' ? raw : buildExtractionPayload({ id: 'delivery-conflict', spec: '', ...raw });
    assert.equal(assessProductEvidence(input, format).kind, 'ambiguous', raw.name + ' ' + format);
  }
});

test('selected SKU cannot erase conflicting product-content assertions formatted as a menu', () => {
  const raw = { name: 'OpenAI Pro5x 官方充值', spec: 'Pro5x',
    sourceData: { evidence: '<p>商品内容：Plus/Team账号。</p>' } };
  for (const format of ['raw', 'text'] as const) {
    const input = format === 'raw' ? raw : buildExtractionPayload({ id: 'product-content-conflict', ...raw });
    assert.equal(assessProductEvidence(input, format).kind, 'ambiguous', format);
  }
});

test('selected platforms resolve advertised menus while a single contradicting title remains ambiguous', () => {
  const selected = { name: 'Google / Codex 接码服务', spec: 'Google' };
  assert.deepEqual(assessProductEvidence(selected).identity, { family: 'google', product: 'google_sms', tier: 'standard' });
  assert.equal(assessProductEvidence({ name: 'Google / Codex 接码服务' }).kind, 'ambiguous');
  assert.equal(assessProductEvidence({ name: 'Codex 接码服务', spec: 'Google' }).kind, 'ambiguous');
  assert.deepEqual(assessProductEvidence({ name: 'ChatGPT / Claude 订阅', spec: 'Claude Pro' }).identity, { family: 'anthropic', product: 'claude', tier: 'pro' });
});

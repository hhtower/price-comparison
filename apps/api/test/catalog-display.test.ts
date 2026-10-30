import assert from 'node:assert/strict';
import test from 'node:test';
import { CATALOG_DISPLAY_SEARCH_LABELS, canonicalProductDisplayName, sanitizeOfferName, standardProductDisplayName, standardProductKind } from '@price-comparison/catalog/catalog-display';

test('known machine names describe products and explicit purposes without changing friendly names', () => {
  for (const [input, expected] of [
    ['openai / codex / sms', 'Codex 手机接码'], ['ChatGPT Free', 'ChatGPT 普通账号'],
    ['openai / chatgpt / pro_5x', 'ChatGPT Pro 100'], ['openai / chatgpt / pro_20x', 'ChatGPT Pro 200'],
    ['openai / chatgpt / pro_500', 'ChatGPT Pro 500'],
    ['anthropic / claude / max_20x', 'Claude Max 20x'], ['google / gemini / ultra_5x', 'Gemini Ultra 5x'],
    ['cursor / cursor / plugin_access', 'Cursor 插件访问'], ['google / google_sms / standard', 'Google 手机接码'],
    ['独家人工名称', '独家人工名称'], ['人工品牌/自定义产品/保修方案', '人工品牌/自定义产品/保修方案'], ['unknown / widget / free', 'unknown widget 免费版'],
    ['openai / chatgpt / constructor', 'openai / chatgpt / constructor'],
    ['xai / grok / super', 'Grok·X·Cursor Super（统一订阅）'], ['xai / grok / super_plus', 'Grok Super Plus'], ['openai / codex / credits', 'Codex 积分'],
  ]) assert.equal(standardProductDisplayName(input!), expected);
  assert.equal(canonicalProductDisplayName({ family: 'openai', product: 'chatgpt', tier: 'free' }), 'ChatGPT 普通账号');
  assert.equal(standardProductKind({ family: 'openai', product: 'codex', tier: 'sms' }), '手机接码');
  assert.equal(standardProductKind({ family: 'unknown', product: 'widget', tier: 'free' }), '其他');
});

test('service and utility machine names are readable without losing their distinct purposes', () => {
  for (const [input, expected] of [
    ['openai / chatgpt_card_binding_service / standard', 'ChatGPT 绑卡服务'],
    ['openai / chatgpt_reauth_card / standard', 'ChatGPT 重新授权服务'],
    ['openai / chatgpt_team_discount_code / standard', 'ChatGPT Team 优惠码'],
    [' OPENAI / CHATGPT_CARD_BINDING_SERVICE / STANDARD ', 'ChatGPT 绑卡服务'],
    ['google / gmail_code_service / standard', 'Google 邮箱收件服务'],
    ['software / cursor_account_manager / standard', 'Cursor 账号管理工具'],
    ['software / cursor_pro_plugin_entitlement / standard', 'Cursor Pro 插件权益'],
    ['sheerid / student_verification_service / standard', 'SheerID 学生认证服务'],
    ['apple / icloud_redemption_code / standard', 'iCloud 兑换码'],
    ['paypal / virtual_card / standard', 'PayPal 虚拟卡'],
    ['星星云 / cloud_phone / 月卡', '星星云 云手机 月卡'],
    ['轮回丹 / script_card / 永久卡', '轮回丹 脚本卡 永久卡'],
    ['service / remote_assistance / standard', '远程协助服务'],
    ['telegram / stars / top_up', 'Telegram 星币 充值'],
    ['cursor / cursor / pro_plus', 'Cursor Pro Plus'],
    ['apple / itunes_gift_card / us_10_usd', 'Apple iTunes 礼品卡 美区 10 USD'],
    ['github / account / free', 'GitHub 普通账号'],
    ['edu / email / free', '教育 邮箱 免费版'],
    ['telecom / roaming_data_sim / 40gb_365_days', '电信 漫游流量卡 40gb 365 天'],
    ['google / google_workspace / business', 'Google Workspace 商业版'],
    ['chat_mail / email / free', 'chat mail 邮箱 免费版'],
  ]) {
    assert.equal(standardProductDisplayName(input!), expected);
    assert.equal(standardProductDisplayName(expected!), expected);
  }
  const identity = { family: 'openai', product: 'chatgpt_card_binding_service', tier: 'standard' };
  assert.equal(canonicalProductDisplayName(identity), 'ChatGPT 绑卡服务');
  assert.deepEqual(identity, { family: 'openai', product: 'chatgpt_card_binding_service', tier: 'standard' });
  assert.equal(canonicalProductDisplayName({ family: 'openai', product: 'chatgpt_team_discount_code', tier: 'standard' }), 'ChatGPT Team 优惠码');
});

test('search labels expose X/Twitter for both canonical social family spellings', () => {
  assert.equal(CATALOG_DISPLAY_SEARCH_LABELS.families.x, 'X/Twitter');
  assert.equal(CATALOG_DISPLAY_SEARCH_LABELS.families.twitter, 'X/Twitter');
});

test('existing ChatGPT Pro market names display the amount tier and remain searchable by old and new aliases', () => {
  for (const [name, expected] of [
    ['ChatGPT Pro 5x', 'ChatGPT Pro 100'], ['ChatGPT Pro 20x', 'ChatGPT Pro 200'],
    ['ChatGPT Pro 10X', 'ChatGPT Pro 200'], ['ChatGPT Pro 25×', 'ChatGPT Pro 500'],
    ['ChatGPT Pro 50倍', 'ChatGPT Pro 500'], ['ChatGPT Pro 200', 'ChatGPT Pro 200'],
    ['ChatGPT Pro 35x', 'ChatGPT Pro 35x'], ['ChatGPT Pro 20x 充值资格账号（非付费订阅）', 'ChatGPT Pro 20x 充值资格账号（非付费订阅）'],
  ]) assert.equal(standardProductDisplayName(name!), expected);
  for (const [tier, aliases] of [
    ['pro_5x', ['Pro 100', 'Pro 5x']],
    ['pro_20x', ['Pro 200', 'Pro 10x', 'Pro 20x']],
    ['pro_500', ['Pro 500', 'Pro 25x', 'Pro 50x']],
  ] as const) for (const alias of aliases) assert.ok(CATALOG_DISPLAY_SEARCH_LABELS.tiers[tier].includes(alias), alias);
});

test('unknown machine names keep distinct identity details in readable form', () => {
  for (const [input, expected] of [
    ['火影忍者 / data_account / standard', '火影忍者 数据账号'],
    ['software / ai麦爆直播助手 / standard', 'ai麦爆直播助手'],
    ['keylink / balance_recharge / standard', 'keylink 余额充值'],
    ['欢乐防线 / 代挂服务 / standard', '欢乐防线 代挂服务'],
    ['unknown / widget / free', 'unknown widget 免费版'],
    ['OpenAI / 人工绑卡服务 / Free', 'OpenAI 人工绑卡服务 免费版'],
    ['OpenAI / 人工绑卡服务 / standard', 'OpenAI 人工绑卡服务'],
    ['new_vendor / widget_one / standard', 'new vendor widget one'],
    ['new_vendor / widget_two / standard', 'new vendor widget two'],
    ['other_vendor / widget_one / standard', 'other vendor widget one'],
    ['new_vendor / widget_one / custom_30_days', 'new vendor widget one custom 30 天'],
    ['generic / custom_tool / standard', 'custom tool'],
    ['service / custom_tool / standard', 'custom tool'],
    [' New_Vendor / Widget_One / CUSTOM_30_DAYS ', 'New Vendor Widget One CUSTOM 30 天'],
    ['google / custom_tool / standard', 'Google custom tool'],
    ['suno / suno / premier', 'Suno Premier'],
    ['openai / chatgpt / custom_tier', 'ChatGPT custom tier'],
  ] as const) {
    const [family, product, tier] = input.split('/');
    assert.equal(canonicalProductDisplayName({ family: family!, product: product!, tier: tier! }), expected, input);
    assert.equal(standardProductDisplayName(input), expected, input);
    assert.equal(standardProductDisplayName(expected), expected);
  }
});

test('friendly names, conflicting identities and unsafe or malformed machine names stay untouched', () => {
  for (const name of [
    '人工品牌/自定义产品/保修方案', 'ChatGPT 绑卡服务（人工说明）',
    '火影忍者 数据账号（人工说明）', '品牌 / 定制产品 / 保修方案',
    'anthropic / chatgpt_card_binding_service / standard',
    'anthropic / chatgpt / plus',
    'unknown / widget_sms / standard', 'openai / chatgpt_sms / plus',
    'openai / constructor / standard', 'openai / __proto__ / standard',
    'openai / prototype / standard', 'openai / toString / standard',
    'openai / chatgpt / constructor', 'openai / chatgpt_card_binding_service / __proto__',
    'unknown / widget / prototype', 'unknown / widget / toString',
    'openai / chatgpt_card_binding_service /', 'openai/chatgpt/plus/extra',
  ]) assert.equal(standardProductDisplayName(name), name);
});

test('platform SMS services display consistently without a product whitelist', () => {
  for (const [family, label] of [
    ['gopay', 'GoPay'], ['paypal', 'PayPal'], ['instagram', 'Instagram'],
    ['ebay', 'eBay'], ['qianwen', '千问'], ['microsoft', 'Microsoft'],
    ['twitter', 'X/Twitter'], ['new_platform', 'new platform'],
  ]) {
    const identity = { family: family!, product: family + '_sms', tier: 'standard' };
    const expected = label + ' 手机接码';
    assert.equal(canonicalProductDisplayName(identity), expected);
    assert.equal(standardProductDisplayName(`${family} / ${family}_sms / standard`), expected);
    assert.equal(standardProductDisplayName(expected), expected);
    assert.equal(standardProductKind(identity), '手机接码');
    if (family !== 'new_platform') assert.equal(CATALOG_DISPLAY_SEARCH_LABELS.products[family + '_sms'], expected);
  }
  assert.equal(standardProductDisplayName(' GOPAY / GOPAY_SMS / STANDARD '), 'GoPay 手机接码');
  for (const identity of [
    { family: 'gopay', product: 'paypal_sms', tier: 'standard' },
    { family: 'gopay', product: 'gopay_sms', tier: 'plus' },
    { family: 'unknown', product: 'widget_sms', tier: 'standard' },
  ]) {
    assert.equal(canonicalProductDisplayName(identity), `${identity.family} / ${identity.product} / ${identity.tier}`);
    assert.equal(standardProductKind(identity), '其他');
  }
});

test('unknown identities remain other even when their readable names end in navigation labels', () => {
  for (const identity of [
    { family: 'unknown', product: 'widget', tier: 'standard' },
    { family: 'unknown', product: 'widget', tier: 'free' },
    { family: 'unknown', product: 'widget', tier: 'sms' },
    { family: 'unknown', product: 'widget', tier: 'tutorial' },
    { family: 'unknown', product: 'widget', tier: 'plugin_access' },
    { family: 'unknown', product: '定制手机接码', tier: 'standard' },
    { family: 'unknown', product: '定制教程', tier: 'standard' },
    { family: 'software', product: '定制插件访问', tier: 'standard' },
  ]) assert.equal(standardProductKind(identity), '其他');
});

test('offer names keep their SKU meaning while losing ad and contact noise', () => {
  for (const [input, expected] of [
    // 括号广告段整体剥离
    ['ChatGPT Plus 独享【现货秒发】', 'ChatGPT Plus 独享'],
    ['【现货】【秒发】ChatGPT Plus', 'ChatGPT Plus'],
    ['Claude Pro 月付（顺丰包邮 假一赔十）', 'Claude Pro 月付'],
    // 裸广告词内联剥离
    ['ChatGPT Plus 现货', 'ChatGPT Plus'],
    ['Claude Pro 月付 现货速发 顺丰包邮', 'Claude Pro 月付'],
    ['Grok 账号 ✅稳定供应🔥售后无忧', 'Grok 账号'],
    ['Gemini Pro 招代理 诚招合伙人 一手货源', 'Gemini Pro'],
    ['ChatGPT Plus 全网最低价', 'ChatGPT Plus'],
    ['Claude Max 20x 假一赔十', 'Claude Max 20x'],
    ['Claude Pro 售后群:123456789', 'Claude Pro'],
    // 联系方式：平台词后跟账号才剥，避免误伤 QQ 会员 / 微信接码
    ['ChatGPT Plus 微信：abc12345', 'ChatGPT Plus'],
    ['QQ会员豪华版', 'QQ会员豪华版'],
    ['微信手机接码', '微信手机接码'],
    ['ChatGPT Plus 13800138000', 'ChatGPT Plus'],
    // 残留分隔符清理
    ['ChatGPT Plus-30天-特价', 'ChatGPT Plus-30天'],
    ['Claude Pro | 爆款 | 月付', 'Claude Pro | 月付'],
    ['Plus官方充值月卡----自动发货--限时优惠', 'Plus官方充值月卡----自动发货'],
    ['G Free|已接马|限时特惠!', 'G Free|已接马'],
    // 纯广告或剥空则原样返回
    ['【现货秒发】', '【现货秒发】'],
    ['招代理 一手货源 现货速发', '招代理 一手货源 现货速发'],
    // 无广告词的合法标题不动
    ['ChatGPT Plus 30天 独享', 'ChatGPT Plus 30天 独享'],
    ['ChatGPT Team 优惠码', 'ChatGPT Team 优惠码'],
    ['闲鱼低价提醒工具 激活码', '闲鱼低价提醒工具 激活码'],
    ['小美 8.0 授权（美团）', '小美 8.0 授权（美团）'],
    ['ChatGPT Plus（30天）', 'ChatGPT Plus（30天）'],
    // 平台名当联系方式误剥的回归：Telegram 是商品名；(秒充) 是括号广告
    ['Telegram Premium 会员 3个月(秒充)', 'Telegram Premium 会员 3个月'],
    // 原有分隔符排版保持不动，只清理剥离后的残留
    ['ChatGPT Plus|官方直充|质保30天', 'ChatGPT Plus|官方直充|质保30天'],
    ['注册收件专用 格式;账号---密码----辅助邮箱---2fa', '注册收件专用 格式;账号---密码----辅助邮箱---2fa'],
  ]) assert.equal(sanitizeOfferName(input!), expected);
});

test('live corpus regressions from 2026-10-28 ad-name calibration', () => {
  for (const [input, expected] of [
    // × 是档位信息不是装饰符
    ['Codex Pro 25× 成品号', 'Codex Pro 25× 成品号'],
    // 价格信息里的"批发价格"不剥，避免"价126"残缺
    ['ChatGPT Plus|官方代充自己账号|批发价格109', 'ChatGPT Plus|官方代充自己账号|批发价格109'],
    // 混合括号只剥广告词，保留渠道/质保信息
    ['【谷歌/IOS秒冲】充值卡密', '【谷歌/IOS】充值卡密'],
    ['美区 G ios plus(秒冲质保30天版 )', '美区 G ios plus(质保30天版)'],
    ['【自营招代理】gro/k plus(8$) 代充', '【自营】gro/k plus(8$) 代充'],
    ['《现货,自动发货》g pro 5x 成品号', '《自动发货》g pro 5x 成品号'],
    // 流程指示括号整体移除
    ['ChatGPT PRO 20X |菲律宾渠道(货源充足联系客服再下单)', 'ChatGPT PRO 20X |菲律宾渠道'],
    // 复合广告词整词剥离，不伤后续字
    ['Plus 官方充值 秒到账', 'Plus 官方充值'],
    ['OpenAI Codex G Plus 一个月 秒充值不排队', 'OpenAI Codex G Plus 一个月 不排队'],
    // 表情符号与文字不粘连；旗帜/肤色符/序号符一并清理；🐎 黑话译作"码"
    ['Business🚀Team Pro5x支持', 'Business Team Pro5x支持'],
    ['OpenAI Pro5X 🇨🇱智利正价CDK', 'OpenAI Pro5X 智利正价CDK'],
    ['【美国+1】 1~2年👍🏻推荐', '【美国+1】 1~2年推荐'],
    ['推荐指数:⭐⭐⭐⭐⭐ 直充', '直充'],
    ['G plus 正规直充成品号 未接🐎', 'G plus 正规直充成品号 未接码'],
    ['codex 短效接🐎未接到可换号可二次', 'codex 短效接码未接到可换号可二次'],
  ]) assert.equal(sanitizeOfferName(input!), expected);
});

test('readable services do not become account subscriptions in product navigation', () => {
  for (const identity of [
    { family: 'openai', product: 'chatgpt_card_binding_service', tier: 'standard' },
    { family: 'openai', product: 'chatgpt_reauth_card', tier: 'standard' },
    { family: 'openai', product: 'chatgpt_team_discount_code', tier: 'standard' },
    { family: 'paypal', product: 'virtual_card', tier: 'standard' },
    { family: '星星云', product: 'cloud_phone', tier: '月卡' },
    { family: 'software', product: 'cursor_account_manager', tier: 'standard' },
  ]) assert.equal(standardProductKind(identity), '其他');
  assert.equal(standardProductKind({ family: 'cursor', product: 'cursor_sms', tier: 'standard' }), '手机接码');
  assert.equal(standardProductKind({ family: 'openai', product: 'chatgpt', tier: 'plus' }), '账号与订阅');
});

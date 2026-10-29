export interface ProductDisplayIdentity { readonly family: string; readonly product: string; readonly tier: string }

const PRODUCTS: Record<string, readonly [string, string]> = {
  chatgpt: ['openai', 'ChatGPT'], codex: ['openai', 'Codex'], claude: ['anthropic', 'Claude'],
  gemini: ['google', 'Gemini'], google: ['google', 'Google'], grok: ['xai', 'Grok'],
  cursor: ['cursor', 'Cursor'], github: ['github', 'GitHub'], apple: ['apple', 'Apple'],
  perplexity: ['perplexity', 'Perplexity'], manus: ['manus', 'Manus'], suno: ['suno', 'Suno'],
  spotify: ['spotify', 'Spotify'], youtube: ['youtube', 'YouTube'], telegram: ['telegram', 'Telegram'],
  discord: ['discord', 'Discord'], binance: ['binance', 'Binance'], '1password': ['1password', '1Password'],
  icloud: ['apple', 'iCloud'], copilot: ['github', 'GitHub Copilot'], outlook: ['microsoft', '微软邮箱'],
  firefly: ['adobe', 'Adobe Firefly'], capcut: ['剪映', 'CapCut'], kling_ai: ['kling', '可灵 AI'],
  leonardo_ai: ['leonardo', 'Leonardo AI'], venice_ai: ['venice', 'Venice AI'],
};
const SERVICES: Record<string, readonly [string, string]> = {
  chatgpt_card_binding_service: ['openai', 'ChatGPT 绑卡服务'],
  chatgpt_reauth_card: ['openai', 'ChatGPT 重新授权服务'],
  chatgpt_gift_card: ['openai', 'ChatGPT 礼品卡'],
  chatgpt_student_verification: ['openai', 'ChatGPT 学生认证服务'],
  codex_referral_service: ['openai', 'Codex 邀请奖励服务'],
  claude_kyc: ['anthropic', 'Claude KYC 认证服务'],
  claude_kyc_link_extraction: ['anthropic', 'Claude KYC 链接提取服务'],
  antigravity_activation_service: ['google', 'Antigravity 激活服务'],
  mail_receive_service_mixed_domains: ['microsoft', '微软邮箱收件服务'],
  icloud_mail: ['apple', 'iCloud 隐私邮箱收件服务'],
  domain_email: ['email', '通用域名邮箱收件服务'], receive_credits: ['email', '邮箱收件额度充值'],
  premium_membership: ['x', 'X 会员'], follower_service: ['twitter', 'X/Twitter 粉丝增长服务'],
  chatgpt_team_discount_code: ['openai', 'ChatGPT Team 优惠码'],
  gmail_code_service: ['google', 'Google 邮箱收件服务'], gcp_account: ['google', 'Google Cloud 账号'],
  google_workspace: ['google', 'Google Workspace'], email_api: ['google', 'Google 邮箱 API'],
  enterprise_email: ['google', 'Google 企业邮箱'], voice: ['google', 'Google Voice'],
  icloud_redemption_code: ['apple', 'iCloud 兑换码'], itunes_gift_card: ['apple', 'Apple iTunes 礼品卡'],
  p12_personal_certificate: ['apple', 'Apple P12 个人证书'], star_boost: ['github', 'GitHub Star 增量服务'],
  paypal_account: ['paypal', 'PayPal 账号'], '163_mail': ['netease', '网易邮箱'],
  a100: ['nvidia', 'NVIDIA A100'], iprocker: ['iprocker', 'IPRocker'],
  bugteam: ['bugteam', 'BugTeam'], 'persistent-chat': ['persistent-chat', 'Persistent Chat'],
  cursor_account_manager: ['software', 'Cursor 账号管理工具'],
  cursor_pro_plugin_entitlement: ['software', 'Cursor Pro 插件权益'],
  codex_tool: ['software', 'Codex 工具'], g_plus_web_mirror: ['software', 'G Plus 网页镜像'],
  gplus_mirror: ['mirror', 'G Plus 镜像'], grok_mirror: ['xai', 'Grok 镜像'],
  grok_trial_card: ['generic', 'Grok 体验卡'], x_premium_membership: ['xai', 'X Premium 会员'],
  x_premium_plus: ['x', 'X Premium Plus'], twitter_blue: ['twitter', 'Twitter Blue'],
  cursor_pro_plus_and_supergrok_bundle: ['bundle', 'Cursor Pro Plus 与 SuperGrok 组合套餐'],
  super_grok_and_x_premium_bundle: ['bundle', 'SuperGrok 与 X Premium 组合套餐'],
};
const PURPOSES: Record<string, string> = {
  account: '账号', buyer_account: '买家账号', email: '邮箱', 'edu email': '教育邮箱', alumni_email: '校友邮箱',
  email_pool: '邮箱池', privacy_mailbox: '隐私邮箱', membership: '会员',
  card: '卡片', physical_card: '实体卡', virtual_card: '虚拟卡', payment_task_card: '支付任务卡',
  student_verification: '学生认证', student_verification_service: '学生认证服务',
  script_card: '脚本卡', script_agency: '脚本代理', game_script: '游戏脚本', automation_tool: '自动化工具',
  cloud_phone: '云手机', cloud_machine: '云主机', software: '软件', software_version: '软件版本',
  android_software_license: 'Android 软件授权', ios_location_simulator: 'iOS 定位模拟工具',
  ios_location_spoofing: 'iOS 定位修改工具', android_app_ad_removal: 'Android 应用去广告工具',
  android_screenshot_tool: 'Android 截图工具', model_converter: '模型转换工具',
  registration_bot: '注册机器人', free_account_registration_tool_source_code: '免费账号注册工具源码',
  login_error_fix: '登录错误修复服务', remote_assistance: '远程协助服务',
  discount_code: '优惠码', coupon: '优惠券', link_extraction: '链接提取服务',
  mcp_plugin_key: 'MCP 插件密钥', pro_anti_degradation_chrome_extension: 'Pro 防降级 Chrome 扩展',
  ai_canvas: 'AI 画布', ai_creative_workspace: 'AI 创作工作台', ai_knowledge_base: 'AI 知识库',
  image_credits: '图像积分', deepseek_harness: 'DeepSeek Harness', muse_ai: 'Muse AI',
  group_access: '群组加入资格', group_qr_code: '群组二维码', receipt_printer: '收款打印机',
  voice_pack: '语音包', theme_pack: '主题包', stars: '星币', echoes: '回声',
  physical_sim_card: '实体 SIM 卡', sim_card: 'SIM 卡', mobile_sim: '手机 SIM 卡', 'mobile sim': '手机 SIM 卡',
  roaming_data_sim: '漫游流量卡', mobile_top_up_voucher: '手机充值券', phone_recharge: '话费充值',
  proxy_traffic: '代理流量', ip: 'IP', dynamic_home_broadband: '动态家庭宽带',
  residential_broadband: '家庭宽带', vpn: 'VPN', vpn_subscription: 'VPN 订阅',
  delivery_order_service: '快递下单服务', hong_kong_address_forwarding_service: '香港地址转寄服务',
  multisig_wallet: '多签钱包', sponsorship: '赞助', game: '游戏', roco_kingdom_world: '洛克王国世界',
  xianyu_assistant: '闲鱼助手', feizhi_card: '飞智卡', mofang_card: '魔方卡', yunfan_protocol_card: '云帆协议卡',
  milk: '牛奶', bentonite_cat_litter: '膨润土猫砂', cat_external_deworming_medicine: '猫用体外驱虫药',
};
const FAMILIES: Record<string, string> = {
  openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', xai: 'xAI', cursor: 'Cursor',
  apple: 'Apple', github: 'GitHub', microsoft: 'Microsoft', paypal: 'PayPal', visa: 'Visa',
  telegram: 'Telegram', sheerid: 'SheerID', canva: 'Canva', kiro: 'Kiro', trae: 'Trae',
  windsurf: 'Windsurf', steam: 'Steam', facebook: 'Facebook', instagram: 'Instagram',
  linkedin: 'LinkedIn', tiktok: 'TikTok', twitter: 'X/Twitter', x: 'X/Twitter',
  wechat: '微信', qq: 'QQ', xiaohongshu: '小红书', netease: '网易', edu: '教育',
  nvidia: 'NVIDIA', android: 'Android', onnx: 'ONNX', vmos: 'VMOS', ucla: 'UCLA',
  gcash: 'GCash', upi: 'UPI', kakao_pay: 'Kakao Pay', giffgaff: 'giffgaff',
  one_nz: 'One NZ', ultra_mobile: 'Ultra Mobile', telecom: '电信', identity_v: '第五人格',
};
const GENERIC_FAMILIES = new Set(['generic', 'service', 'software', 'bundle', 'card', 'email', 'phone', 'network', 'server', 'logistics', 'courier', 'pet_care', 'student_verification']);
const TIERS: Record<string, string> = {
  free: '普通账号', go: 'Go', plus: 'Plus', pro: 'Pro', team: 'Team', standard: '',
  pro_5x: 'Pro 100', pro_20x: 'Pro 200', pro_500: 'Pro 500', team_5x: 'Team 5x',
  max_5x: 'Max 5x', max_20x: 'Max 20x', ultra_5x: 'Ultra 5x', ultra_20x: 'Ultra 20x',
  sms: '手机接码', tutorial: '教程', plugin_access: '插件访问', credits: '积分', kyc: 'KYC 认证',
  refund_service: '退款服务', account_manager: '账号管理工具', ultra: 'Ultra', heavy: 'Heavy',
  super: 'Super', supergrok: 'SuperGrok', super_plus: 'Super Plus', super_lite: 'Super Lite',
  pro_plus: 'Pro Plus', max: 'Max', premium: 'Premium', premium_plus: 'Premium Plus',
  basic: '基础版', personal: '个人版', business: '商业版', family: '家庭版', individual: '个人版',
  vip: 'VIP', svip: 'SVIP', gvip: 'GVIP', trial: '体验版', student: '学生版',
  top_up: '充值', prepaid: '预付费', permanent: '永久版', registered: '已注册', aged: '老号', account: '账号',
};
const TIER_TERMS: Record<string, string> = {
  us: '美区', hk: '港区', tr: '土耳其区', usd: 'USD', hkd: 'HKD', try: 'TRY', gbp: 'GBP',
  days: '天', months: '个月', annual: '年卡', prepaid: '预付费', card: '卡',
};

function ownValue<T>(values: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(values, key) ? values[key] : undefined;
}

export const CATALOG_DISPLAY_SEARCH_LABELS = {
  products: { ...PURPOSES,
    ...Object.fromEntries(Object.entries(PRODUCTS).flatMap(([key, [, name]]) => [[key, name], [`${key}_sms`, `${name} 手机接码`]])),
    ...Object.fromEntries(Object.entries(SERVICES).map(([key, [, name]]) => [key, name])) },
  families: FAMILIES,
  tiers: { ...TIERS, free: '普通账号 免费版',
    pro_5x: 'Pro 100 Pro 5x', pro_20x: 'Pro 200 Pro 10x Pro 20x', pro_500: 'Pro 500 Pro 25x Pro 50x' },
  tierTerms: TIER_TERMS,
};

export function canonicalProductDisplayName(identity: ProductDisplayIdentity): string {
  const family = identity.family.trim().toLowerCase();
  const product = identity.product.trim().toLowerCase();
  const tier = identity.tier.trim().toLowerCase();
  const sms = product.endsWith('_sms');
  const known = ownValue(PRODUCTS, sms ? product.slice(0, -4) : product);
  const service = ownValue(SERVICES, product);
  const purpose = ownValue(PURPOSES, product);
  const fallback = `${identity.family} / ${identity.product} / ${identity.tier}`;
  if ((known && known[0] !== family) || (service && service[0] !== family) || (sms && (!known || tier !== 'standard'))
    || ['constructor', '__proto__', 'prototype', 'tostring'].includes(tier)) return fallback;
  if (family === 'xai' && product === 'grok' && ['plus', 'premium', 'super', 'ultra'].includes(tier))
    return `Grok·X·Cursor ${TIERS[tier]}（统一订阅）`;
  if (family === 'xai' && product === 'grok' && ['supergrok', 'heavy'].includes(tier))
    return `${tier === 'supergrok' ? 'SuperGrok' : 'Grok Heavy'}（旧版）`;
  if (family === 'x' && product === 'premium_membership' && ['premium', 'premium_plus'].includes(tier))
    return `X ${TIERS[tier]}（旧版）`;
  const familyLabel = GENERIC_FAMILIES.has(family) ? '' : ownValue(FAMILIES, family) ?? identity.family.trim().replace(/_/gu, ' ');
  if (purpose === '账号' && tier === 'free') return [familyLabel, TIERS.free].filter(Boolean).join(' ');
  const label = known?.[1] ?? service?.[1] ?? (purpose
    ? [familyLabel, purpose].filter(Boolean).join(' ') : undefined);
  if (!label || (known && !Object.hasOwn(TIERS, tier))) return fallback;
  const tierLabel = sms ? '手机接码' : purpose && tier === 'free' ? '免费版' : ownValue(TIERS, tier)
    ?? identity.tier.trim().split(/[_\s]+/u).map(term => ownValue(TIER_TERMS, term.toLowerCase()) ?? term).join(' ');
  return [label, tierLabel].filter(Boolean).join(' ');
}

export function standardProductDisplayName(name: string): string {
  if (/^(?:X Premium(?: Plus|\+)?|SuperGrok|Grok Heavy)$/u.test(name)) return `${name}（旧版）`;
  const pro = name.match(/^ChatGPT\s+Pro\s*(5|10|20|25|50)\s*[x×倍]$/iu);
  if (pro) return `ChatGPT Pro ${{ '5': 100, '10': 200, '20': 200, '25': 500, '50': 500 }[pro[1]!]}`;
  const parts = name.split(/\s*\/\s*/u);
  if (parts.length === 3 && parts.every(part => part.trim()) && parts.some(part => /^[a-z0-9][a-z0-9_.+-]*$/iu.test(part.trim()))) {
    const display = canonicalProductDisplayName({ family: parts[0]!, product: parts[1]!, tier: parts[2]! });
    return display.includes(' / ') ? name : display;
  }
  const free = name.match(/^(ChatGPT|Claude|Gemini|Grok) Free$/iu);
  if (free) {
    const product = free[1]!.toLowerCase();
    return canonicalProductDisplayName({ family: PRODUCTS[product]![0], product, tier: 'free' });
  }
  return name;
}

export function standardProductKind(identity: ProductDisplayIdentity): string {
  const name = canonicalProductDisplayName(identity);
  if (name.includes(' / ')) return '其他';
  if (name.endsWith('手机接码')) return '手机接码';
  if (name.endsWith('教程')) return '教程';
  if (name.endsWith('插件访问')) return '插件访问';
  if (['credits', 'kyc', 'refund_service', 'account_manager'].includes(identity.tier.trim().toLowerCase())) return '其他';
  return Object.hasOwn(PRODUCTS, identity.product.trim().toLowerCase()) ? '账号与订阅' : '其他';
}

// Crawler titles carry shop ads and contact handles; offers display the cleaned
// name while the raw title stays in products.name for matching and evidence.
const OFFER_AD_TERMS = [
  '现货', '秒发', '秒冲', '秒到账', '秒到', '秒充值', '秒充', '速发', '秒发货', '当天发', '当日发', '顺丰包邮', '顺丰', '包邮',
  '全国联保', '假一赔十', '假一赔百', '售后无忧', '包售后', '售后群', '售前咨询', '联系客服',
  '招代理', '诚招', '合伙人', '代发', '一手货源', '货源充足', '货源', '稳定供应', '稳定供货', '长期供应', '长期供货', '源头供货', '源头直供', '实力代理',
  '自助下单', '再下单', '下单价', '补差价', '特价', '热卖', '热销', '爆款', '限时优惠', '限时特惠', '限时', '特惠', '福利价格', '秒杀', '直降', '甩卖', '清仓', '新手友好', '推荐指数',
  '全网最低价', '全网最低', '全网最', '最低价', '官方直供',
].sort((left, right) => right.length - left.length);
const OFFER_AD_PATTERN = new RegExp(OFFER_AD_TERMS.join('|'), 'gu');
// Platform words like Telegram/TG double as product names, so they must not be handle keywords.
const OFFER_CONTACT_PATTERN = /(?:微信|weixin|v信|vx|扣扣|企鹅|qq)[\s:：号]*(?:[a-z][a-z0-9_-]{3,}|\d{5,})|[（(]?1[3-9]\d{9}[)）]?|[:：]\s*\d{5,}/giu;
// Decorative symbols only; × stays because tiers like "Pro 25×" use it.
const OFFER_NOISE_SOURCE = '[\\p{Extended_Pictographic}\\p{Emoji_Modifier}\\u{FE0F}\\u{20E3}\\u{1F1E6}-\\u{1F1FF}\\u{2460}-\\u{24FF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\u{2190}-\\u{21FF}★☆✦✧✪✫●◆◇■□▲▼♥♦♣♠\\p{Cc}\\p{Cf}]';
const OFFER_NOISE_PATTERN = new RegExp(OFFER_NOISE_SOURCE, 'gu');
// Whole-bracket removal only for process instructions; mixed brackets keep their info.
const OFFER_INSTRUCTION_PATTERN = /联系客服|请在|拍下|售后群/;

function stripOfferAds(name: string): string {
  // 🐎 is slang for 码 (接🐎=接码), so translate instead of stripping it.
  let cleaned = name.replace(/🐎/gu, '码');
  // Ads, contacts and noise strip inline (inside brackets too); emoji between
  // latin/digit neighbors leaves a space so words do not glue together.
  cleaned = cleaned.replace(OFFER_AD_PATTERN, '').replace(OFFER_CONTACT_PATTERN, '')
    .replace(new RegExp(`(?<=[A-Za-z0-9])${OFFER_NOISE_SOURCE}+(?=[A-Za-z0-9])`, 'gu'), ' ')
    .replace(OFFER_NOISE_PATTERN, '');
  cleaned = cleaned.replace(/[[【（(《][^[\]【】（）()《》]*[\]】）)》]/gu, segment =>
    OFFER_INSTRUCTION_PATTERN.test(segment) ? '' : segment);
  // Drop brackets emptied by stripping and their leftover edge separators.
  cleaned = cleaned.replace(/[[【（(《][\s,，、.。|｜\-—~～]*[\]】）)》]/gu, '')
    .replace(/([\[【（(《])[\s,，、]+/gu, '$1').replace(/[\s,，、]+([\]】）)》])/gu, '$1');
  if (cleaned === name) return name;
  cleaned = cleaned.replace(/\s+/gu, ' ')
    .replace(/(?:\s*[|｜]\s*){2,}/gu, ' | ')
    .replace(/[,，]\s*[,，]/gu, ',')
    .replace(/^[\s!！:：，,、|｜/\\～~·。.\-—+]+|[\s!！:：，,、|｜/\\～~·。.\-—+]+$/gu, '')
    .trim();
  // Drop only unbalanced trailing closers (left by stripping), never a matched pair.
  const pairs: Record<string, string> = { ')': '(', ']': '[', '】': '【', '》': '《', '」': '「', '』': '『' };
  for (let i = 0; i < 4 && cleaned && pairs[cleaned.at(-1)!]; i += 1) {
    const closer = cleaned.at(-1)!;
    if ((cleaned.length - cleaned.replaceAll(closer, '').length) > (cleaned.length - cleaned.replaceAll(pairs[closer]!, '').length)) {
      cleaned = cleaned.slice(0, -1).replace(/[\s,，、|｜.。\-—~～]+$/u, '');
    } else break;
  }
  return cleaned;
}

export function sanitizeOfferName(name: string): string {
  if (!name) return name;
  const cleaned = stripOfferAds(name);
  // A title reduced to nothing (or near nothing) was pure ad copy; keep the raw one identifiable.
  return cleaned.replace(/\s/gu, '').length >= 2 ? cleaned : name;
}

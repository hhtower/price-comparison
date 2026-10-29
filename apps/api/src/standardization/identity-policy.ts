import { canonicalizeMatchText } from './fingerprint.js';
import { saleEvidenceView } from './sale-evidence.js';

export const IDENTITY_POLICY_VERSION = 'catalog-identity-20261023-v30';

export interface Identity { family: string; product: string; tier: string }

const TIERS: Record<string, readonly string[]> = {
  chatgpt: ['free', 'go', 'plus', 'pro_5x', 'pro_20x', 'pro_500', 'team', 'team_5x'],
  gemini: ['plus', 'pro', 'ultra_5x', 'ultra_20x'],
  claude: ['free', 'pro', 'max_5x', 'max_20x', 'team', 'team_5x'],
};
// Approved sale objects, not an assertion that every historical tier is current.
export const FINITE_CATALOG: Readonly<Record<string, readonly string[]>> = {
  'openai/chatgpt': [...TIERS.chatgpt!, 'tutorial'],
  'openai/codex_sms': ['standard'], 'openai/codex': ['credits'],
  'openai/codex_referral_service': ['standard'], 'openai/chatgpt_gift_card': ['standard'],
  'openai/chatgpt_student_verification': ['standard'], 'openai/chatgpt_card_binding_service': ['standard'],
  'openai/chatgpt_reauth_card': ['standard'], 'openai/chatgpt_team_discount_code': ['standard'],
  'anthropic/claude': TIERS.claude!, 'anthropic/claude_sms': ['standard'],
  'anthropic/claude_kyc': ['standard'], 'anthropic/claude_kyc_link_extraction': ['standard'],
  'google/gemini': [...TIERS.gemini!, 'tutorial'], 'google/google_sms': ['standard'],
  'google/gcp_account': ['standard'], 'google/voice': ['standard'],
  'google/student_verification': ['standard'], 'google/antigravity_activation_service': ['standard'],
  'google/ad': ['grant'], 'youtube/youtube': ['individual', 'family', 'tutorial'],
  'xai/grok': ['free', 'plus', 'premium', 'super', 'ultra', 'supergrok', 'heavy'],
  'cursor/cursor': ['free', 'pro', 'pro_plus', 'ultra'], 'cursor/cursor_sms': ['standard'],
  'network/ip': ['standard'],
  'x/account': ['standard'], 'x/premium_membership': ['premium', 'premium_plus'],
  'twitter/twitter_sms': ['standard'], 'twitter/follower_service': ['standard'],
  'google/email': ['standard'], 'microsoft/outlook': ['standard'], 'netease/163_mail': ['standard'],
  'yahoo/email': ['standard'], 'mail.com/email': ['standard'], 'edu/email': ['standard'],
  'google/gmail_code_service': ['standard'], 'microsoft/mail_receive_service_mixed_domains': ['standard'],
  'apple/icloud_mail': ['standard'], 'email/domain_email': ['standard'], 'email/receive_credits': ['standard'],
  // Converged 20261023: region, age, duration, direct-login/protocol delivery and
  // 科技号 registration are SKU facts; all Telegram accounts share one identity.
  'telegram/telegram': ['account', 'premium'], 'telegram/stars': ['top_up'],
};
const FAMILIES: Record<string, string> = { chatgpt: 'openai', gemini: 'google', claude: 'anthropic' };
const PRODUCTS: Record<string, string> = {
  chatgpt: 'chatgpt', openaichatgpt: 'chatgpt', codex: 'chatgpt', openaicodex: 'chatgpt',
  gemini: 'gemini', googlegemini: 'gemini', googleai: 'gemini',
  claude: 'claude', anthropicclaude: 'claude', claudecode: 'claude', anthropicclaudecode: 'claude',
};
const FAMILY_ALIASES: Record<string, string> = {
  openai: 'openai', chatgpt: 'openai', google: 'google', googleai: 'google', gemini: 'google', anthropic: 'anthropic', claude: 'anthropic',
};
const UNKNOWN = new Set(['', 'unknown', 'unknow', 'unspecified', 'undefined', 'null', 'none', 'na', 'notapplicable', '未知', '不详', '未指定', '不适用']);
const compact = (value: unknown) => canonicalizeMatchText(value).replace(/[\s_/-]+/gu, '');
const GROK_PRODUCTS = new Set(['grok', 'gro', 'gr0k']);
const GROK_FAMILIES = new Set(['xai', 'x.ai', 'grok', 'gro', 'x']);
const FREE_TIERS = new Set(['free', '普号', '普通账号', '普通账户', '未订阅', '免费', '免费版']);
// Keep the established catalog keys; provider/product spellings are service aliases.
const SMS_PRODUCTS: Record<string, string> = {
  codexsms: 'codex_sms', openaisms: 'codex_sms', chatgptsms: 'codex_sms',
  claudesms: 'claude_sms', anthropicsms: 'claude_sms', claudecodesms: 'claude_sms',
  googlesms: 'google_sms', geminisms: 'google_sms', googleaisms: 'google_sms',
  youtubesms: 'google_sms',
};
const SMS_DEFAULTS: Record<string, string> = { openai: 'codex_sms', anthropic: 'claude_sms', google: 'google_sms' };
const TUTORIAL_TIERS = new Set(['tutorial', 'guide', 'course', '教程', '教学', '课程']);
type ChatgptProDollarTier = 'pro_5x' | 'pro_20x' | 'pro_500';

const CHATGPT_PRO_MULTIPLIERS: Record<string, ChatgptProDollarTier> = {
  '5': 'pro_5x', '10': 'pro_20x', '20': 'pro_20x', '25': 'pro_500', '50': 'pro_500',
};
const CHATGPT_PRO_AMOUNTS: Record<string, ChatgptProDollarTier> = { '100': 'pro_5x', '200': 'pro_20x', '500': 'pro_500' };

function quotaMultipliers(value: string): Set<string> {
  return new Set([...value.matchAll(/(?<![\d.])(\d+(?:\.\d+)?|\.\d+)\s*(?:x|×|倍)(?![a-z\d])/giu)].map(match => match[1]!));
}

function chatgptProDollarTiers(value: string): Set<ChatgptProDollarTier> {
  const tiers = new Set<ChatgptProDollarTier>();
  for (const match of value.matchAll(/\bpro\s*\$?\s*(?:100|200|500)(?![\d.x])(?:\s*(?:usd|dollars?|美元|美金|美刀|刀))?(?:\s*[/|、]\s*(?:pro\s*)?\$?\s*(?:100|200|500)(?![\d.x])(?:\s*(?:usd|dollars?|美元|美金|美刀|刀))?)*/giu)) {
    for (const amount of match[0].matchAll(/100|200|500/gu)) tiers.add(CHATGPT_PRO_AMOUNTS[amount[0]]!);
  }
  for (const match of value.matchAll(/(?<![\d.])(100|200|500)\s*(?:(?:usd|dollars?|美元|美金|美刀|刀)\s*)?pro\b/giu)) tiers.add(CHATGPT_PRO_AMOUNTS[match[1]!]!);
  // An unlabelled currency amount cannot override a named plan or multiplier.
  if (tiers.size || quotaMultipliers(value).size || !/(?<![a-z])pro(?![a-z])/iu.test(value)) return tiers;
  const planText = value.replace(/(?:售价|价格|实付|付款|余额|额度|用量|预算|price|cost|balance|budget|usage)\s*[:：]?\s*(?:(?:usd|dollars?)\s*)?\$?\s*\d+(?:\.\d+)?\s*(?:usd|dollars?|美元|美金|美刀|刀)?/giu, ' ');
  for (const match of planText.matchAll(/(?:\$\s*(100|200|500)(?![\d.])|(?<![\d.])(100|200|500)\s*(?:usd|dollars?|美元|美金|美刀|刀)|\b(?:usd|dollars?)\s*\$?\s*(100|200|500)(?![\d.]))/giu)) {
    tiers.add(CHATGPT_PRO_AMOUNTS[match[1] ?? match[2] ?? match[3]!]!);
  }
  return tiers;
}

export function normalizeIdentity(input: { family?: unknown; product?: unknown; tier?: unknown }): Identity {
  let family = FAMILY_ALIASES[compact(input.family)] ?? canonicalizeMatchText(input.family);
  const rawProduct = canonicalizeMatchText(input.product);
  let product = PRODUCTS[compact(input.product)] ?? rawProduct;
  let tier = canonicalizeMatchText(input.tier);
  if (TUTORIAL_TIERS.has(compact(tier))) tier = 'tutorial';
  if (family === 'google' && product === 'antigravity' && tier === 'tutorial') product = 'gemini';
  if (family === 'cursor' && product === 'cursor') {
    if (['pro+', 'proplus'].includes(compact(tier))) tier = 'pro_plus';
    if (compact(tier) === 'ultra20x') tier = 'ultra';
    if (FREE_TIERS.has(compact(tier))) tier = 'free';
  }
  if (family === 'youtube' && product === 'youtube' && tier === 'sms') return { family: 'google', product: 'google_sms', tier: 'standard' };
  if (family === 'youtube' && compact(product) === 'youtubesms') family = 'google';
  // Legacy tutorial topics/formats belong to SKUs, not separate account products.
  const tutorialProduct = rawProduct.match(/^(chatgpt|codex|claude(?:[ _-]*code)?|gemini)[ _-].*(?:tutorial|guide|course)(?:[ _-](?:video|bundle))?$/u);
  if (tutorialProduct && ['standard', 'tutorial'].includes(tier)) {
    product = PRODUCTS[compact(tutorialProduct[1])]!;
    tier = 'tutorial';
  }
  if (compact(tier) === 'sms' && (FAMILIES[product] === family || (product === family && SMS_DEFAULTS[family]))) {
    return { family, product: SMS_DEFAULTS[family]!, tier: 'standard' };
  }
  product = SMS_PRODUCTS[compact(rawProduct)] ?? (compact(rawProduct) === 'sms' ? SMS_DEFAULTS[family] ?? product : product);
  // X is a Grok provider alias only when the product explicitly identifies Grok.
  // Other Grok tiers remain distinct; X/Twitter accounts are never folded in.
  if (GROK_PRODUCTS.has(compact(rawProduct))) {
    product = 'grok';
    if (GROK_FAMILIES.has(compact(family))) family = 'xai';
    if (FREE_TIERS.has(compact(tier))) tier = 'free';
  }
  if (TIERS[product]) {
    const value = compact(tier).replace(/[×倍]/gu, 'x').replace(/\$/gu, '').replace(/^(?:openaichatgpt|chatgpt|googleai|googlegemini|gemini|anthropicclaude|claudecode|claude)/u, '');
    const aliases: Record<string, string> = {
      free: 'free', 普号: 'free', 普通账号: 'free', 普通账户: 'free', 未订阅: 'free', 免费: 'free', 免费版: 'free',
      go: 'go', plus: 'plus', pro: 'pro', max: 'max', ultra: 'ultra',
      team: 'team', business: 'team', teamstandard: 'team', businessstandard: 'team',
      team5x: 'team_5x', '5xteam': 'team_5x', business5x: 'team_5x', '5xbusiness': 'team_5x',
      // Canonical keys stay stable for existing catalog rows; official names and
      // current/legacy merchant multipliers all normalize to those keys.
      pro5x: 'pro_5x', '5xpro': 'pro_5x', pro100: 'pro_5x', '100pro': 'pro_5x',
      pro10x: 'pro_20x', '10xpro': 'pro_20x', pro200: 'pro_20x', '200pro': 'pro_20x',
      pro20x: 'pro_20x', '20xpro': 'pro_20x',
      pro25x: 'pro_500', '25xpro': 'pro_500', pro500: 'pro_500', '500pro': 'pro_500',
      pro50x: 'pro_500', '50xpro': 'pro_500',
      max5x: 'max_5x', '5xmax': 'max_5x', max20x: 'max_20x', '20xmax': 'max_20x',
      ultra5x: 'ultra_5x', '5xultra': 'ultra_5x', ultra20x: 'ultra_20x', '20xultra': 'ultra_20x',
    };
    const proLabelRemainder = tier.replace(/pro|usd|dollars?|美元|美金|美刀|刀|原|旧|现|100|200|500|10|20|25|50|5|[\s$×倍x/|、()（）._-]/gu, '');
    if (product === 'chatgpt' && !proLabelRemainder && /(?<![a-z])pro(?![a-z])/u.test(tier)) {
      const proTiers = chatgptProDollarTiers(tier);
      const multipliers = quotaMultipliers(tier);
      for (const multiplier of multipliers) if (CHATGPT_PRO_MULTIPLIERS[multiplier]) proTiers.add(CHATGPT_PRO_MULTIPLIERS[multiplier]!);
      if (proTiers.size === 1 && [...multipliers].every(multiplier => CHATGPT_PRO_MULTIPLIERS[multiplier])) tier = [...proTiers][0]!;
    }
    tier = product === 'claude' && value === 'teampremium' ? 'team_5x' : (aliases[value] ?? tier);
    // These developer products share account plans, but still sell non-account goods.
    if (/^(?:openaicodex|codex|anthropicclaudecode|claudecode)$/u.test(compact(rawProduct)) &&
      !TIERS[product]!.includes(tier) && !['pro', 'max', 'ultra', 'tutorial'].includes(tier) && !UNKNOWN.has(compact(tier))) product = rawProduct;
  }
  return { family, product, tier };
}

export function hasValidIdentityFields(input: Identity): boolean {
  return [input.family, input.product, input.tier].every(value => typeof value === 'string' && !/[\p{Cc}\p{Cf}]/u.test(value) && !UNKNOWN.has(compact(value)));
}

const FINITE_PRODUCT = /chatgpt|codex|claude|gemini|google|youtube|antigravity|cursor|grok|gr0k|gmail|outlook|hotmail|icloud|netease|yahoo|mailcom|163mail|163邮箱|eduemail|教育邮箱|domainemail|receivecredits|twitter|推特|住宅(?:ip|代理)|residential(?:ip|proxy)|proxyip|ipproxy|^x(?:account|premium|subscription|账号|会员)/iu;
const INDEPENDENT_GOODS = [
  [/tool|toolkit|account[ _-]*manager/iu, /工具|(?<![a-z])(?:tools?|toolkit|account\s+manager)(?![a-z])/iu],
  [/plugin/iu, /插件|(?<![a-z])plugins?(?![a-z])/iu],
  [/mirror/iu, /镜像|(?<![a-z])mirror(?![a-z])/iu],
  [/bundle/iu, /组合|合集|套装|(?<![a-z])bundle(?![a-z])/iu],
  [/tutorial|guide|course/iu, /教程|教学|课程|指南|(?<![a-z])(?:tutorials?|guides?|courses?)(?![a-z])/iu],
  [/refund/iu, /退款|(?<![a-z])refund(?![a-z])/iu],
  [/installation/iu, /安装服务|(?<![a-z])installation(?![a-z])/iu],
  [/api/iu, /接口|中转|(?<![a-z])api(?![a-z])/iu],
] as const;
const finiteProduct = (value: string) => FINITE_PRODUCT.test(compact(value)) || /(?:^|[\s_/-])(?:ip|proxy)(?:$|[\s_/-])/iu.test(value);

export function isValidCatalogIdentity(input: Identity): boolean {
  if (!hasValidIdentityFields(input)) return false;
  const { family, product, tier } = normalizeIdentity(input);
  // Evidence-backed Claude tutorials are allowed, but no empty standard is prebuilt.
  if (family === 'anthropic' && product === 'claude' && tier === 'tutorial') return true;
  const approved = FINITE_CATALOG[`${family}/${product}`];
  if (approved) return approved.includes(tier);
  const restrictedFamilies = ['openai', 'anthropic', 'google', 'youtube', 'xai', 'cursor', 'network', 'x', 'twitter', 'email', 'edu', 'netease', 'yahoo', 'mail.com', 'icloud', 'telegram'];
  if (restrictedFamilies.includes(family)) return false;
  // Microsoft/Apple also sell unrelated goods; constrain only their mailbox identities.
  if (['microsoft', 'apple'].includes(family) && /mail|outlook|hotmail|icloud|email/iu.test(product)) return false;
  // Account plans and delivery attributes cannot bypass the known-product policy.
  const productText = compact(product);
  // Direct-login/protocol delivery, 科技号 registration and telegram账号 product
  // spellings are SKU facts under any family, never identities of their own.
  if (/直登|协议号|科技号|telegram账号|technologyphonenumber/iu.test(productText)) return false;
  if (finiteProduct(product) && !INDEPENDENT_GOODS.some(([pattern]) => pattern.test(productText))) return false;
  if (Object.keys(PRODUCTS).some(alias => productText.startsWith(alias) &&
    /^(?:free|go|plus|pro|max|ultra|team|business|5x|20x|recharge|topup|service|account|subscription)+$/u.test(productText.slice(alias.length)))) return false;
  if (/^(?:cursor|grok|gr0k|gro|gmail|hotmail|outlook|antigravity|residentialip|proxyip)(?:account|subscription|free|pro|plus|premium|ultra|standard|5x|20x|recharge|topup|service)*$/u.test(productText)) return false;
  // X's generic account label does not reserve unrelated platforms' accounts.
  if (productText === 'account' && (finiteProduct(family) || GROK_FAMILIES.has(family))) return false;
  if (productText !== 'account' && Object.keys(FINITE_CATALOG).some(key => compact(key.split('/')[1]) === productText)) return false;
  if (product.endsWith('_sms')) return tier === 'standard' && family === (SERVICE_FAMILIES[product.slice(0, -4)] ?? product.slice(0, -4));
  return !TIERS[product] || (FAMILIES[product] === family && (tier === 'tutorial' || TIERS[product].includes(tier)));
}

export interface ProductEvidenceAssessment {
  kind: 'account' | 'sms_service' | 'other' | 'ambiguous';
  identity?: Identity;
  rules: string[];
  conflict?: string;
}

function evidenceStrings(value: unknown, ancestors = new WeakSet<object>()): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'number' && Number.isFinite(value)) return [String(value)];
  if (!value || typeof value !== 'object') return [];
  if (ancestors.has(value)) return [];
  ancestors.add(value);
  const result = Array.isArray(value)
    ? value.flatMap(item => evidenceStrings(item, ancestors))
    : Object.entries(value).filter(([key]) => key !== 'model').flatMap(([, item]) => evidenceStrings(item, ancestors));
  ancestors.delete(value);
  return result;
}

function evidenceText(evidence: Record<string, unknown>): string {
  return evidenceStrings(evidence).map(value => canonicalizeMatchText(value
    // Strip support lists before whitespace folding, otherwise a mention of
    // "可用" can consume every later sales assertion across paragraph breaks.
    .replace(/(?:支持|可用(?:的)?模型|可使用|可调用|available models?\s*:|supports?\s+)[^,，。;；\n]*/giu, ' '))
    .replace(/(?<![a-z])(codex|chatgpt|claude|gemini)(?=plus|pro|team|free|max|ultra)/gu, '$1 ')
    .replace(/(?<![a-z])g(?=codex)/gu, '')
    .replace(/(?<![\d.])(5|20)x(?=team|business)/gu, '$1x ')
    .replace(/(?<=\d)\s*×/gu, 'x')
    .replace(/(?<![a-z\d])x(5|20)(?![\d.])/gu, '$1x')).join(' ');
}

const BRAND_MARKERS: Record<string, RegExp> = {
  chatgpt: /(?<![a-z])(?:chat\s*gpt|open\s*ai|oai|codex|gp(?=\s*plus))(?![a-z])/u,
  claude: /(?<![a-z])(?:anthropic|claude)(?![a-z])|克劳德/u,
  gemini: /(?<![a-z])(?:google|gemini)(?![a-z])/u,
};
const ACCOUNT_PRODUCT = /(?<![a-z])(?:chat\s*gpt|codex|claude|gemini|google\s*ai)(?![a-z])|克劳德/u;
const ACCOUNT = /账号|帐号|账户|帐户|成品|会员|订阅|合租|独享|代充|充值|卡充|直充|普号|未订阅|月卡|季卡|年卡|账密|席位|母号|(?:长效|过夜|新发)车|已接[码马]|未接[码马]|(?<![a-z])(?:accounts?|subscriptions?|memberships?|seats?)(?![a-z])/u;
const DISCOUNT_CODE = /优惠码|优惠券|减席位|discount\s+code|promo\s+code|coupon/iu;
const TIME_EXTENSION_CARD = /(?<!(?:不含|不包含|不提供|另购|另售)\s*)(?:续时|延时)\s*(?:\d+(?:\.\d+)?\s*(?:小时|h(?:rs?)?)\s*)?卡(?!\s*(?:另购|另售|单独购买))/iu;
const OTHER_PRODUCT = /(?<![a-z])(?:steam|teamviewer|cursor|perplexity|midjourney|deepseek|copilot|grok|netflix|spotify|adobe|notion|canva|youtube|windsurf)(?![a-z])/u;
const TITLE_PLAN = /(?<![a-z])(?:free|go|plus|pro|max|ultra|team|business)(?![a-z])|普号|普通(?:账号|账户|帐号|帐户)|未订阅/u;
// An unconditional non-activation claim describes the delivered account; a
// recharge prerequisite ("需要账号状态为free才可充值") describes the buyer's account.
const NOT_ACTIVATED = /(?:未|尚未|没有|无)(?:开通)?(?:订阅|会员)|^\s*(?:普号|普通(?:账号|账户|帐号|帐户))\s*$/u;
const PREREQUISITE = /需要|须|必须|才|要求|如果|如若|仅限|只限|状态为|变回|退出|切换|提交|已有|原有|可下单|不可下单|适用账号/u;
const EXPLICIT_SALE = /实际(?:仅|只)?(?:交付|出售|提供|售)|(?:只|仅)(?:售|交付|提供)(?!后)|(?:本|此)(?:商品|产品)(?:为|是)|(?:商品|产品)内容\s*[:：]|(?:成品|商品|产品)(?:拆成|拆分为|分为)|^\s*(?:交付|出售|提供|发货)/u;
const NON_ACCOUNT = /(?<![a-z\d])(?:api|tokens?|credits?|tutorials?|courses?)(?![a-z\d])|教程|课程|教学|代写|额度包|点数|接口/u;

const SERVICE_FAMILIES: Record<string, string> = { codex: 'openai', claude: 'anthropic', google: 'google' };
const SERVICE_MARKERS: Record<string, RegExp> = {
  codex: /(?<![a-z])(?:codex|open\s*ai|chat\s*gpt)(?![a-z])/u,
  claude: /(?<![a-z])(?:anthropic|claude(?:[\s_-]*code)?)(?![a-z])/u,
  google: /(?<![a-z])(?:google(?:\s*ai)?|gemini)(?![a-z])|谷歌/u,
  cursor: /(?<![a-z])cursor(?![a-z])/u,
  telegram: /(?<![a-z])telegram(?![a-z])/u,
  whatsapp: /(?<![a-z])whatsapp(?![a-z])/u,
  microsoft: /(?<![a-z])microsoft(?![a-z])|微软/u,
  meta: /(?<![a-z])(?:meta|muse)(?![a-z])/u,
  discord: /(?<![a-z])discord(?![a-z])/u,
  paypal: /(?<![a-z])paypal(?![a-z])/u,
  youtube: /(?<![a-z])youtube(?![a-z])/u,
  facebook: /(?<![a-z])facebook(?![a-z])/u,
  amazon: /(?<![a-z])amazon(?![a-z])/u,
  wechat: /(?<![a-z])wechat(?![a-z])|微信/u,
  twitter: /(?<![a-z])(?:twitter|x)(?![a-z])/u,
  luma: /(?<![a-z])luma(?![a-z])/u,
};
const DELIVERY_STATUS = /(?:无需|不需要|不用|免|已经|尚未|未曾|已|未)(?:接[码马]|(?:手机|手机号|短信)验证)/gu;

function assessSmsService(evidence: Record<string, unknown>): ProductEvidenceAssessment | undefined {
  const clean = (value: unknown) => evidenceStrings(value).map(item => item.normalize('NFKC').toLocaleLowerCase('en-US').replace(DELIVERY_STATUS, '')).join('\n');
  const text = clean(evidence);
  const smsMarker = /接[码马]|短信(?:验证码)?服务|(?<![a-z])sms\s+(?:api\s+)?(?:verification|service|activation)/u;
  const title = clean({ name: evidence.name, spec: evidence.spec });
  const strong = smsMarker.test(title)
    || (/接验证码/u.test(title) && /实卡|手机|t-mobile/u.test(title))
    || /(?:交付|提供|出售|发货(?!格式|方式))[^,，。;；<\n]*(?:接[码马]|短信验证码|sms\s+verification)/u.test(text);
  // A bare code, login instructions, email/TOTP and API products are not SMS inventory.
  // Supporting an SMS delivery API is not selling model API credits.
  let saleTitle = title.replace(/(?<![a-z])api\s*(?:对接|接入|调用|接口|integration)(?![a-z])|(?:可(?:以)?|支持)接\s*api(?![a-z])/gu, '');
  if (smsMarker.test(title) && /短信|实卡|手机号|长效|(?<![a-z])sms(?![a-z])/u.test(title) && !/模型|额度|tokens?|credits?/u.test(title)) saleTitle = saleTitle.replace(/(?<![a-z])api(?![a-z])/gu, '');
  const withoutWarnings = title.replace(/(?:看清楚|看清|详见|请看|查看|阅读)(?:商品|产品|使用)?说明/gu, '');
  if (NON_ACCOUNT.test(saleTitle) || /收不到|怎么办|教程|说明/u.test(withoutWarnings)) return undefined;
  // Mailbox code delivery is a different sale object, even when used for OpenAI.
  const mailbox = /邮箱|邮件|(?<![a-z])(?:email|e-mail)(?![a-z])/u.test(title)
    || (/(?<![a-z])gmail(?![a-z])/u.test(title) && !SERVICE_MARKERS.google!.test(title));
  const phoneDelivery = /(?:交付|提供|出售|发货)[^，。;；\n]*(?:手机号|手机号码|实卡|短信)/u.test(text);
  if (mailbox && !/手机|实卡|号码|短信|(?<![a-z])(?:sms|phone|sim)(?![a-z])/u.test(title) && !phoneDelivery) return undefined;
  const weak = !ACCOUNT.test(title) && !NON_ACCOUNT.test(title) &&
    !/邮箱|邮件|email|2fa|totp|登录|收不到|怎么办|教程|说明/u.test(title) &&
    (/(?:手机|手机号)验证/u.test(title) || /(?:codex|claude|chatgpt|cursor|gemini)\s*(?:短信)?验证码/u.test(title));
  if (!strong && !weak) return undefined;
  if (text.split(/[\n。;；,，]/u).some(clause => /(?:实际(?:仅|只)?(?:交付|出售|提供|售)|^(?:仅|只)?(?:交付|出售|发货(?!格式|方式)))[^，。;；\n]*(?:成品|账号|账户|邮箱|邮件|账密)/u.test(clause)
    && !/手机号|手机号码|实卡|接[码马](?:服务|链接)|短信(?:验证码)?服务/u.test(clause)))
    return ambiguous('The SMS title conflicts with explicitly delivered accounts or mailboxes', ['conflicting_sale_objects']);
  const platformsIn = (value: string) => [...new Set(Object.entries(SERVICE_MARKERS).filter(([, pattern]) => pattern.test(value))
    .map(([platform]) => platform === 'youtube' ? 'google' : platform))];
  // The listing title overrides broad shop/category labels, but never silently selects one of several offers.
  let platforms = platformsIn(title);
  const source = evidence.sourceData && typeof evidence.sourceData === 'object' ? evidence.sourceData as Record<string, unknown> : {};
  const brand = [evidence.brand, evidence.vendor, source.brand, source.vendor].filter(value => typeof value === 'string' && value.trim());
  if (!platforms.length && brand.length) {
    platforms = platformsIn(clean(brand));
    if (!platforms.length) return ambiguous('Unrecognized explicit SMS service platform', ['unknown_service_platform']);
  }
  if (!platforms.length) platforms = platformsIn(text);
  if (platforms.length > 1) return ambiguous('Multiple SMS service platforms are offered without a selected platform', ['conflicting_service_platforms']);
  if (!platforms.length) {
    // Do not override an explicit, unfamiliar platform with the Codex default.
    const words = title.replace(/(?<![a-z])(?:open\s*ai|sms|verification|service|activation|single|use|long|term|us|usa|uk|phone|number)(?![a-z])/gu, '').match(/[a-z]{2,}/u);
    if (words) return ambiguous('Unrecognized explicit SMS service platform', ['unknown_service_platform']);
    platforms = ['codex'];
  }
  const platform = platforms[0]!;
  return { kind: 'sms_service', identity: { family: SERVICE_FAMILIES[platform] ?? platform, product: `${platform}_sms`, tier: 'standard' }, rules: ['sms_verification_service'] };
}

function ambiguous(conflict: string, rules: string[]): ProductEvidenceAssessment {
  return { kind: 'ambiguous', rules, conflict };
}

function assessUnifiedGrok(evidence: Record<string, unknown>): ProductEvidenceAssessment | undefined {
  const title = evidenceText({ name: evidence.name, spec: evidence.spec });
  const grokPlan = /(?<![a-z])(?:gro(?:[.\s_/-]*k)?|gr0k)\s*(plus|premium|super|ultra)(?![a-z])/gu;
  const grok = [...title.matchAll(grokPlan)].length > 0
    || /^\s*(?:gro(?:[.\s_/-]*k)?|gr0k)\s*[/／]/u.test(title);
  const unified = /新版|新套餐|统一订阅|三合一|四合一/u.test(title);
  if ((!grok && !unified) || NON_ACCOUNT.test(title) || /镜像|安装服务|资格|工具|旧版|老版|heavy|supergrok|premium\s*(?:\+|plus)|(?<![a-z])(?:mirror|installation|tools?)(?![a-z])/u.test(title)) return undefined;
  const tiersIn = (value: string) => new Set([...value.matchAll(/(?<![a-z])(?:plus|premium|super|ultra)(?![a-z])/gu)].map(match => match[0]));
  const selected = tiersIn(evidenceText({ spec: evidence.spec }));
  const tiers = selected.size ? selected : tiersIn(title);
  if (!tiers.size) return undefined;
  if (!grok && !/(?<![a-z])(?:x|twitter)(?![a-z])|推特/u.test(title)) return undefined;
  if (tiers.size !== 1) return ambiguous('The unified subscription has no single selected plan', ['conflicting_plans']);
  const tier = [...tiers][0]!;
  const multiplier = { plus: '1', premium: '4', super: '15', ultra: '50' }[tier];
  const selectedText = evidenceText({ spec: evidence.spec });
  const quotaText = selected.size && tiersIn(title).size > 1 ? selectedText : `${title} ${selectedText}`;
  if ([...quotaMultipliers(quotaText)].some(value => value !== multiplier))
    return ambiguous('The unified plan conflicts with its usage multiplier', ['conflicting_multipliers']);
  // Historical sellers also used "Grok Super"; only new-plan evidence disambiguates it.
  if (tier === 'super' && !unified && !/(?<!\d)15\s*[x×倍]/u.test(quotaText)) return ambiguous('Super needs explicit unified-plan evidence', ['unified_plan_unresolved']);
  const clauses = evidenceStrings({ evidence: evidence.evidence, sourceData: evidence.sourceData })
    .flatMap(value => value.split(/[\n。;；,，]/u)).map(clause => evidenceText({ evidence: clause }));
  if ([title, ...clauses.filter(clause => EXPLICIT_SALE.test(clause))]
    .some(clause => Object.values(BRAND_MARKERS).some(pattern => pattern.test(clause))))
    return ambiguous('The unified subscription conflicts with another sold account brand', ['conflicting_brands']);
  if (clauses.some(clause => (EXPLICIT_SALE.test(clause) || /^\s*(?:gro|gr0k)/u.test(clause))
    && [...clause.matchAll(grokPlan)].some(match => match[1] !== tier)))
    return ambiguous('The selected unified plan conflicts with explicit delivery', ['conflicting_plans']);
  return { kind: 'account', identity: { family: 'xai', product: 'grok', tier }, rules: ['explicit_unified_grok_plan'] };
}

function assessXMembership(evidence: Record<string, unknown>): ProductEvidenceAssessment | undefined {
  const name = evidenceText({ name: evidence.name });
  if (!/(?<![a-z\d])(?:twitter|x)(?![a-z\d])|推特|(?<![a-z])xpremium/u.test(name)
    || NON_ACCOUNT.test(name) || !/premium|蓝[标v]|会员|订阅|充值|卡密|月卡|年卡/u.test(name)) return undefined;
  const text = evidenceText(evidence);
  const tiersIn = (value: string) => new Set([...value.matchAll(/(?<![a-z])(?:x[\s-]*)?premium(?:\s*(\+|plus)(?![a-z]))?(?![a-z])/gu)]
    .map(match => match[1] ? 'premium_plus' : 'premium'));
  const selected = tiersIn(evidenceText({ spec: evidence.spec }));
  const title = tiersIn(name);
  const tiers = selected.size ? selected : title.size ? title : tiersIn(text);
  if (tiers.size !== 1) return ambiguous('The X membership tier is unspecified or offered as an unselected menu', ['x_membership_tier_unresolved']);
  const tier = [...tiers][0]!;
  const delivery = evidenceStrings({ evidence: evidence.evidence, sourceData: evidence.sourceData })
    .flatMap(value => value.split(/[\n。;；,，]/u)).filter(clause => EXPLICIT_SALE.test(clause));
  if (delivery.some(clause => [...tiersIn(evidenceText({ evidence: clause }))].some(value => value !== tier)))
    return ambiguous('The selected X membership tier conflicts with explicitly delivered membership', ['conflicting_plans']);
  return { kind: 'account', identity: { family: 'x', product: 'premium_membership', tier }, rules: ['explicit_x_membership_tier'] };
}

function assessTeamDiscountCode(evidence: Record<string, unknown>): ProductEvidenceAssessment | undefined {
  const title = evidenceText({ name: evidence.name, spec: evidence.spec });
  const text = evidenceText(evidence);
  const combined = `${title} ${text}`;
  if (!DISCOUNT_CODE.test(combined) || !/(?<![a-z])(?:team|business)(?![a-z])/iu.test(combined)) return undefined;
  if (/(?:非|不是|不支持|不提供)\s*(?:优惠码|优惠券|discount\s+code|promo\s+code|coupon)/iu.test(combined)) return undefined;
  if (!/(?:只|仅)(?:提供|售|交付)\s*(?:优惠码|优惠券|discount\s+code|promo\s+code|coupon)|(?:自行|需要自己|需自行)[^,，。;；\n]{0,20}(?:付款|提链支付)|(?:开通|购买|减席位)[^,，。;；\n]{0,30}(?:优惠码|优惠券|discount\s+code|promo\s+code|coupon)/iu.test(combined)) return undefined;
  return { kind: 'other', identity: { family: 'openai', product: 'chatgpt_team_discount_code', tier: 'standard' }, rules: ['discount_code_product'] };
}

export function assessProductEvidence(evidence: Record<string, unknown>, format: 'raw' | 'text' = 'raw'): ProductEvidenceAssessment {
  const rawTitle = evidenceText({ name: evidence.name, spec: evidence.spec });
  if (/(?:5\s*[x×倍]\s*(?:team|business)|(?:team|business)\s*5\s*[x×倍])/iu.test(rawTitle)
    && evidenceStrings(evidence).some(value => /(?:本商品|本产品|实际交付|实际提供)[^。;；\n]*(?:不是|并非|并不是)\s*(?:5\s*[x×倍]\s*(?:team|business)|(?:team|business)\s*5\s*[x×倍])/iu.test(value)))
    return ambiguous('The Team 5X title conflicts with an explicit delivered-tier denial', ['conflicting_sale_objects']);
  evidence = saleEvidenceView(evidence, format);
  if (TIME_EXTENSION_CARD.test(evidenceText({ name: evidence.name, spec: evidence.spec })))
    return { kind: 'other', rules: ['non_account_product', 'time_extension_card'] };
  // "VISA卡，可充值Gplus" names what the goods can pay for, not the sold plan.
  // Merchant spellings of ChatGPT before a plan (G Plus, GPlus, GTP Pro, CPT Team, GT.P Pro) are
  // expanded in the title/spec only; descriptions mention them as uses or upgrades.
  const withoutUse = (value: unknown) => typeof value === 'string' ? value
    .replace(/(?:正好)?(?:可以|可|能|用于|用来)(?:充值|开通|订阅)[^,，。;；|]*/gu, ' ')
    .replace(/(?<!升级\s*)(?<![a-z])(?:g[.\s]*t[.\s]*p|c[.\s]*p[.\s]*t|gpt|gt|g)[\s\-–·]*(?=(?:free|go|plus|pro|team|business)(?![a-z]))/giu, 'ChatGPT ') : value;
  evidence = { ...evidence, name: withoutUse(evidence.name), spec: withoutUse(evidence.spec) };
  const service = assessSmsService(evidence);
  if (service) {
    const title = evidenceText({ name: evidence.name, spec: evidence.spec });
    if (service.kind === 'sms_service' && ACCOUNT.test(title) && /(?<![a-z])(?:plus|pro|max|ultra|team|business)(?![a-z])/u.test(title)
      && !/接[码马]|短信|sms/u.test(title)) return ambiguous('The account title conflicts with the explicitly offered SMS service', ['conflicting_sale_objects']);
    return service;
  }
  const unifiedGrok = assessUnifiedGrok(evidence);
  if (unifiedGrok) return unifiedGrok;
  const xMembership = assessXMembership(evidence);
  if (xMembership) return xMembership;
  const text = evidenceText(evidence);
  const discountCode = assessTeamDiscountCode(evidence);
  if (discountCode) return discountCode;
  const title = evidenceText({ name: evidence.name, spec: evidence.spec });
  const bodyClauses = evidenceStrings({ evidence: evidence.evidence, sourceData: evidence.sourceData })
    .flatMap(value => value.split(/[\n。;；,，]/u)).map(value => evidenceText({ evidence: value }));
  // A title/spec naming an account plan identifies the sold SKU. Descriptions
  // (device limits, prerequisites, comparisons) override it only by explicit sale assertions.
  // A bare "G-plus" needs a sale word or a spelled-out brand.
  const saleTitle = title;
  const spelledBrand = ACCOUNT_PRODUCT.test(saleTitle) || Object.values(BRAND_MARKERS).some(pattern => pattern.test(saleTitle));
  const titleAnchored = TITLE_PLAN.test(saleTitle) && (ACCOUNT.test(saleTitle) || spelledBrand);
  const source = evidence.sourceData && typeof evidence.sourceData === 'object' ? evidence.sourceData as Record<string, unknown> : {};
  // Brand/vendor fields and the selected spec state the SKU itself, not a mention.
  const selectedText = evidenceText({ brand: evidence.brand, vendor: evidence.vendor, family: evidence.family,
    brandField: source.brand, vendorField: source.vendor, familyField: source.family, spec: evidence.spec });
  const anchorText = titleAnchored
    ? [title, selectedText, ...bodyClauses.filter(clause => EXPLICIT_SALE.test(clause) || (ACCOUNT_PRODUCT.test(clause) && ACCOUNT.test(clause)
        && !PREREQUISITE.test(clause)) || (NOT_ACTIVATED.test(clause) && !PREREQUISITE.test(clause)))].join(' ')
    : text;
  const accountCredentials = /(?:子号|账号|账户|成品)[^\n。;；]*(?:token|凭证|json|rt)|(?:token|凭证|json|rt)[^\n。;；]*(?:子号|账号|账户|成品)/iu.test(text)
    && /(?<![a-z])(?:team|business)(?![a-z])/u.test(text)
    && !/credits?|额度包|点数|积分|api\s*(?:key|余额|中转|充值)|接口/u.test(anchorText);
  const saleAnchor = accountCredentials ? anchorText.replace(/(?<![a-z\d])tokens?(?![a-z\d])/gu, ' ') : anchorText;
  if (NON_ACCOUNT.test(saleAnchor) || /提链|结账链接|邀请积分/u.test(title)) return { kind: 'other', rules: ['non_account_product'] };
  if (/模型|(?<![a-z])models?(?![a-z])/u.test(text) && !ACCOUNT.test(text)) return { kind: 'other', rules: ['non_account_product'] };
  if (/镜像|安装服务|(?<![a-z])mirror(?![a-z])/u.test(title)) return { kind: 'other', rules: ['non_account_product'] };
  if (/资格(?:号|账号)|开通资格|仅售资格|只售资格|教育资格|学生认证|(?<![a-z])k12(?![a-z])/u.test(title) || /(?:仅|只)售资格/u.test(text)) return { kind: 'other', rules: ['non_account_product', 'eligibility_only'] };
  const mailboxProductTitle = /邮箱(?:账号|账户|母号)|邮件(?:账号|账户)|(?:注册|绑定|收件|发货)\s*邮箱/u.test(title);
  // Registration mailboxes are not delivered inventory when the seller
  // independently identifies the Free account and explicitly withholds mail access.
  const registeredFreeAccount = /(?<![a-z])free(?![a-z])/u.test(title)
    && bodyClauses.some(clause => /(?:邮箱|gmail).*注册\s*free|(?:不提供|无法登录).*(?:邮箱|gmail)/u.test(clause))
    && bodyClauses.some(clause => ACCOUNT_PRODUCT.test(clause) && /(?:交付|提供|发货).*(?:账密|(?:账号|账户)(?:和|及)?密码)/u.test(clause));
  const deliveredTeam = /(?<![a-z])(?:team|business)(?![a-z])/u.test(title)
    && bodyClauses.some(clause => /(?<![a-z])(?:team|business)(?![a-z])/u.test(clause) && /成品|订阅|账号|账户|席位/u.test(clause));
  const subscribedAccount = deliveredTeam || registeredFreeAccount || (ACCOUNT_PRODUCT.test(title) && /(?<![a-z])(?:free|go|plus|pro|max|ultra|team|business)(?![a-z])/u.test(title)
    && (!mailboxProductTitle || /成品|订阅/u.test(title)));
  if (subscribedAccount && bodyClauses.some(clause => /(?:仅|只)(?:交付|出售|提供|售)[^,，。;；]*(?:邮箱|邮件)/u.test(clause) && !ACCOUNT_PRODUCT.test(clause)))
    return ambiguous('The account title conflicts with explicitly exclusive mailbox delivery', ['conflicting_sale_objects']);
  if ((/邮箱|邮件|(?<![a-z])(?:gmail|hotmail|outlook|icloud|email|e-mail)(?![a-z])/u.test(title)
    && !subscribedAccount && !((ACCOUNT_PRODUCT.test(title) || BRAND_MARKERS.chatgpt!.test(title) || /(?<![a-z])(?:plus|pro|team|business)(?![a-z])/u.test(title)) && ACCOUNT.test(title) && !mailboxProductTitle))) {
    if (bodyClauses.some(clause => ACCOUNT_PRODUCT.test(clause) && ACCOUNT.test(clause))) {
      return ambiguous('The mailbox title conflicts with the explicitly delivered product', ['conflicting_sale_objects']);
    }
    return { kind: 'other', rules: ['non_account_product', 'mailbox_product'] };
  }
  if (/(?<![a-z])ip(?![a-z])/u.test(title) && !ACCOUNT_PRODUCT.test(title) && !subscribedAccount) {
    if (bodyClauses.some(clause => ACCOUNT_PRODUCT.test(clause) && ACCOUNT.test(clause)))
      return ambiguous('The IP title conflicts with the explicitly delivered product', ['conflicting_sale_objects']);
    return { kind: 'other', rules: ['non_account_product'] };
  }
  if (/(?<![a-z])(?:gro(?:[.\s]*k)?|gr0k)(?![a-z])/u.test(title)) {
    if (Object.values(BRAND_MARKERS).some(pattern => pattern.test(text))) return ambiguous('Conflicting explicit account brands', ['conflicting_brands']);
    if (/普号|普通(?:账号|账户|帐号|帐户)|未订阅|(?<![a-z])free(?![a-z])/u.test(title)) {
      const source = evidence.sourceData && typeof evidence.sourceData === 'object' ? evidence.sourceData as Record<string, unknown> : {};
      // Broad seller categories are not selected plans, but explicit SKU facts
      // and the supplied description must not contradict the free-account hint.
      const planEvidence = evidenceText({ name: evidence.name, spec: evidence.spec, tier: evidence.tier, evidence: evidence.evidence,
        sourceData: Object.fromEntries(Object.entries(source).filter(([key]) => key !== 'category')) });
      if (/(?<![a-z])(?:super(?:grok)?|plus|pro|premium|heavy|lite)(?![a-z])/u.test(planEvidence)) return ambiguous('Multiple Grok account plans are offered', ['conflicting_plans']);
      return { kind: 'account', identity: { family: 'xai', product: 'grok', tier: 'free' }, rules: ['explicit_grok_free_account'] };
    }
    return { kind: 'other', rules: ['other_explicit_product'] };
  }
  if (OTHER_PRODUCT.test(anchorText)) return { kind: 'other', rules: ['other_explicit_product'] };

  const brandsIn = (value: string) => Object.entries(BRAND_MARKERS).filter(([, pattern]) => pattern.test(value)).map(([product]) => product);
  // Brandless titles keep body brands; a branded title ignores incidental body brands.
  const products = brandsIn(titleAnchored && brandsIn(title).length ? anchorText : text);
  if (products.length > 1) return ambiguous('Conflicting explicit account brands', ['conflicting_brands']);
  // A future upgrade is not the plan delivered by the current listing.
  const withoutUpgrades = (value: string) => value.replace(/可(?:以)?升级(?:(?:至|为|到)\s*)?(?:pro|plus|max|ultra|team|business)[^，。;；]*/gu, ' ');
  const planText = withoutUpgrades(anchorText);
  const dollarTiers = chatgptProDollarTiers(planText);
  const dollarTier = dollarTiers.size === 1 ? [...dollarTiers][0] : undefined;
  const plans = new Set<string>();
  for (const match of planText.matchAll(/(?<![a-z])(?:free|go|plus|pro|max|ultra|team|business)(?![a-z])/gu)) plans.add(match[0] === 'business' ? 'team' : match[0]);
  if (/普号|普通(?:账号|账户|帐号|帐户)|未订阅|未开通(?:订阅|会员)|免费(?:版|账号|账户)/u.test(planText)) plans.add('free');
  if (dollarTiers.size && !plans.size) plans.add('pro');
  const shortTeamTitle = /^(?:【自营】|\[自营\])?\s*(?:team|business)\s*(?:(?:\d+(?:\.\d+)?|\.\d+)\s*(?:x|倍))?$/u.test(canonicalizeMatchText(evidence.name));
  const accountContext = accountCredentials || ACCOUNT.test(text) || shortTeamTitle || (ACCOUNT_PRODUCT.test(text) && products.length === 1 && plans.size > 0);
  if (!accountContext) return { kind: 'other', rules: [] };

  let product = products[0];
  const rules = ['account_subscription'];
  if (!product) {
    const explicitBrand = [evidence.brand, evidence.vendor, evidence.family, source.brand, source.vendor, source.family].some(value => typeof value === 'string' && value.trim());
    // Ancillary category/marketing text is not an explicit alternative brand.
    const unrecognizedWords = evidenceText({ name: evidence.name }).replace(/(?<![a-z])(?:free|go|plus|pro|team|business|accounts?|subscriptions?|memberships?|seats?|shared|private|monthly|annual|standard|premium|\d+x)(?![a-z])/gu, '')
      .replace(/(?<![a-z])(?:gmail|outlook|hotmail|icloud|upi|ios|cdk|json|cc|2fa|pp)(?![a-z])/gu, '').match(/[a-z]{2,}/u);
    if (explicitBrand || unrecognizedWords || ![...plans].some(plan => ['team', 'plus', 'go', 'pro'].includes(plan))) return { kind: 'other', rules: ['no_default_brand_evidence'] };
    product = 'chatgpt';
    rules.push('brandless_account_defaults_chatgpt');
  } else rules.push('explicit_brand');

  if (plans.size === 0) return ambiguous('Account plan is unspecified', [...rules, 'missing_plan']);
  if (plans.size > 1) return ambiguous('Multiple account plans are offered without a selected plan', [...rules, 'conflicting_plans']);
  let tier = [...plans][0]!;
  if (tier === 'team' && /标准席位/u.test(String(evidence.spec ?? '')) && !/高级席位/u.test(String(evidence.spec ?? ''))
    && bodyClauses.some(clause => /实际(?:只|仅)?(?:交付|提供)|^(?:交付|提供)/u.test(clause)
      && /(?:5\s*x\s*(?:team|business)|(?:team|business)\s*5\s*x)/u.test(clause)))
    return ambiguous('The selected standard seats conflict with explicitly delivered Team 5X', [...rules, 'conflicting_plans']);
  if (tier === 'team' && /(?:5\s*x\s*(?:team|business)|(?:team|business)\s*5\s*x)/u.test(title)
    && bodyClauses.some(clause => /实际(?:只|仅)?交付|(?:只|仅)交付/u.test(clause) && /标准\s*(?:team|business)?\s*席位/u.test(clause)))
    return ambiguous('The Team 5X title conflicts with explicitly delivered standard seats', [...rules, 'conflicting_plans']);
  if (product === 'chatgpt' && tier === 'team' && /premium|高级席位/u.test(planText)
    && !/(?<![\d.])5\s*(?:x|倍)(?![a-z\d])/u.test(planText))
    return ambiguous('The Team premium label needs explicit tier evidence', [...rules, 'missing_multiplier']);
  let multipliers = quotaMultipliers(planText);
  // An anchored Pro/Max/Ultra title may leave its required multiplier to the description.
  if (!multipliers.size && !dollarTier && titleAnchored && ['pro', 'max', 'ultra', 'team'].includes(tier)) {
    const described = quotaMultipliers(withoutUpgrades(text));
    if (described.size === 1 || (product === 'chatgpt' && tier === 'pro' && described.size)) multipliers = described;
  }
  const chatgptPro = product === 'chatgpt' && tier === 'pro';
  const multiplierTiers = new Set([...multipliers].map(multiplier => CHATGPT_PRO_MULTIPLIERS[multiplier]));
  if (multipliers.size > 1 && (!chatgptPro || multiplierTiers.size > 1)) return ambiguous('Multiple quota multipliers are offered without a selected plan', [...rules, 'conflicting_multipliers']);
  const multiplier = [...multipliers][0];
  const chatgptMultiplierTier = chatgptPro ? CHATGPT_PRO_MULTIPLIERS[multiplier ?? ''] : undefined;
  if (multiplier && !chatgptMultiplierTier && ((product === 'chatgpt' && tier === 'pro') || (multiplier !== '5' && multiplier !== '20')))
    return ambiguous('The quota multiplier is not supported by an official account plan', [...rules, 'unsupported_multiplier']);
  if (chatgptPro && (dollarTiers.size > 1 || (dollarTier && chatgptMultiplierTier && dollarTier !== chatgptMultiplierTier)))
    return ambiguous('The official amount tiers or quota multipliers conflict', [...rules, 'conflicting_multipliers']);
  const teamPremium = product === 'claude' && tier === 'team' && /(?<![a-z])premium(?![a-z])/u.test(planText);
  if (teamPremium && multiplier && multiplier !== '5') return ambiguous('Team Premium conflicts with the stated quota multiplier', [...rules, 'conflicting_multipliers']);
  const requiresMultiplier = (product === 'chatgpt' && tier === 'pro') || (product === 'claude' && tier === 'max') || (product === 'gemini' && tier === 'ultra');
  if (requiresMultiplier && !multiplier && !dollarTier) return ambiguous('The account plan requires an explicit official plan amount or multiplier', [...rules, 'missing_multiplier']);
  if (product === 'chatgpt' && tier === 'pro' && (chatgptMultiplierTier || dollarTier)) tier = chatgptMultiplierTier ?? dollarTier!;
  else if (requiresMultiplier) tier = `${tier}_${multiplier}x`;
  else if (tier === 'team' && (multiplier === '5' || teamPremium)) tier = 'team_5x';
  else if (multiplier) return ambiguous('The quota multiplier does not match an official account plan', [...rules, 'unsupported_multiplier']);
  const identity = product === 'gemini' && tier === 'free' ? { family: 'google', product: 'email', tier: 'standard' }
    : { family: FAMILIES[product]!, product, tier };
  if (!isValidCatalogIdentity(identity)) return ambiguous('The stated plan is not an official tier for this account product', [...rules, 'unsupported_plan']);
  return { kind: 'account', identity, rules };
}

export function identityEvidenceConflict(input: Identity, evidence: Record<string, unknown>, format: 'raw' | 'text' = 'raw'): string | null {
  if (!isValidCatalogIdentity(input)) return 'The identity does not use a valid catalog product and tier';
  const identity = normalizeIdentity(input);
  if (!FINITE_CATALOG[`${identity.family}/${identity.product}`] && !(identity.product === 'claude' && identity.tier === 'tutorial')) {
    const sale = saleEvidenceView(evidence, format);
    const title = evidenceText({ name: sale.name, spec: sale.spec });
    const clauses = evidenceStrings({ evidence: sale.evidence, sourceData: sale.sourceData })
      .flatMap(value => value.split(/[\n。;；,，]/u));
    const assertions = clauses.filter(clause => EXPLICIT_SALE.test(clause));
    // Secondary title clauses often name compatible platforms, not inventory.
    const primary = title.replace(/(?:可以|可|能|用于|用来)(?:充值|开通|订阅|安装)[^,，。;；]*/gu, ' ')
      .split(/[,，。;；]/u)[0]!;
    const sold = [primary, ...assertions];
    // A model's tool/bundle label is insufficient without the matching sold goods.
    if ((finiteProduct(identity.product) || sold.some(finiteProduct))
      && !INDEPENDENT_GOODS.some(([product, source]) => product.test(identity.product)
        && !assertions.some(clause => /(?:实际(?:仅|只)|仅|只)(?:交付|出售|提供)/u.test(clause)
          && finiteProduct(clause) && ACCOUNT.test(clause) && !source.test(clause))
        && !clauses.some(clause => {
          const denied = clause.match(/(?:不含|不售|不出售|不提供|不交付|没有)[^,，。;；）)]*/u)?.[0];
          return denied !== undefined && source.test(denied);
        }) && sold.some(clause => {
        const positive = clause.replace(/(?:附赠|赠送|附带|含使用教程|不含|不售|不提供|不交付|不支持|没有|非组合|无工具)[^,，。;；）)]*/gu, ' ');
        if (!source.test(positive)) return false;
        if (/bundle/u.test(product.source)) return /与|和|及|[+＋&]|(?<![a-z])and(?![a-z])/iu.test(positive);
        return !ACCOUNT.test(positive) || /(?:账号|账户)管理工具|教程|教学|课程|指南|接口|中转|(?<![a-z])(?:account\s+manager|tutorials?|guides?|courses?|api)(?![a-z])/iu.test(positive);
      })))
      return 'The finite platform sale object cannot be recreated under another family';
  }
  if (!TIERS[identity.product] && !identity.product.endsWith('_sms')) {
    const sale = saleEvidenceView(evidence, format);
    for (const clause of evidenceStrings(sale).flatMap(value => value.split(/[\n。;；,，]/u))) {
      const text = canonicalizeMatchText(clause);
      // An actual redemption/account offer is not a tool used for registration
      // or a tutorial topic. Reuse the established explicit-product markers.
      if (!/兑换|免费用户|交付|出售|只提供|仅提供|账号|账户|订阅|会员/u.test(text)
        || /(?:用于|用来|可用于|注册|使用|登录)/u.test(text) && !/实际(?:仅|只)?(?:交付|出售|提供)|^(?:交付|出售|只提供|仅提供)/u.test(text)) continue;
      for (const match of text.matchAll(new RegExp(OTHER_PRODUCT.source, 'gu'))) {
        const brand = compact(match[0]);
        if (brand === 'cursor' && identity.family === 'xai' && identity.product === 'grok'
          && ['plus', 'premium', 'super', 'ultra'].includes(identity.tier)
          && !/(?<![a-z])cursor\s*(?:pro|ultra|business|team)(?![a-z])/u.test(text)
          && !/(?:仅|只)(?:交付|提供|出售|售)|不(?:提供|交付).*grok/u.test(text)) continue;
        if (brand === 'grok' && identity.family === 'x' && identity.product === 'premium_membership'
          && /赠送|附赠|附带/u.test(text) && !EXPLICIT_SALE.test(text)) continue;
        const namesBrand = [identity.family, identity.product].some(value => canonicalizeMatchText(value).split(/[\s_/-]+/u).includes(brand));
        if (!namesBrand)
          return `The identity conflicts with the sold ${match[0]} product`;
      }
    }
  }
  if (identity.tier === 'tutorial' && TIERS[identity.product]) {
    const sale = saleEvidenceView(evidence, format);
    const title = evidenceText({ name: sale.name, spec: sale.spec });
    const text = evidenceText({ name: sale.name, spec: sale.spec, evidence: sale.evidence, sourceData: sale.sourceData });
    if (!/教程|教学|课程|指南|手册|电子资料|(?<![a-z])(?:tutorials?|courses?|guides?)(?![a-z])/u.test(text))
      return 'The evidence does not establish a sold tutorial';
    // Tutorial bodies discuss other tools/payment platforms; the subject in
    // the sale title takes priority over those incidental references.
    const subjectsIn = (value: string) => Object.entries(BRAND_MARKERS).filter(([product, pattern]) => pattern.test(value) ||
      (product === 'gemini' && /(?<![a-z])antigravity(?![a-z])/u.test(value)) ||
      (product === 'chatgpt' && /chatg皮提|g皮提|gp替|(?<![a-z])chatg(?![a-z])/u.test(value))).map(([product]) => product);
    const titleSubjects = subjectsIn(title);
    const subjects = titleSubjects.length ? titleSubjects : subjectsIn(text);
    if (subjects.length === 1 && subjects[0] === identity.product && !OTHER_PRODUCT.test(title)) return null;
    if (!subjects.length && identity.product === 'chatgpt' && !OTHER_PRODUCT.test(title) &&
      /^(?:[^a-z]*g\s*plus|[^a-z]*plus|小白反代教程)/u.test(title)) return null;
    return 'The tutorial subject is ambiguous or conflicts with the catalog product';
  }
  if (identity.product === 'grok' && ['supergrok', 'heavy'].includes(identity.tier)) {
    const visible = saleEvidenceView({ name: evidence.name, spec: evidence.spec }, format);
    const title = canonicalizeMatchText([visible.name, visible.spec].filter(value => typeof value === 'string').join(' '));
    const heavy = /(?<![a-z])heavy(?![a-z])/u.test(title);
    const superTier = /(?<![a-z])super(?![a-z])|supergrok|格洛克\s*super/u.test(title);
    if (heavy && superTier && /可选|任选|或|(?:super(?:grok)?|heavy)\s*[\/／]\s*(?:super(?:grok)?|heavy)/u.test(title)) return 'Multiple Grok account plans are offered';
    if (identity.tier === 'supergrok' && !heavy && !/supergrok/u.test(title)) return 'Super alone does not establish the historical SuperGrok plan; review the subscription';
    if ((heavy ? 'heavy' : superTier ? 'supergrok' : undefined) && (heavy ? 'heavy' : 'supergrok') !== identity.tier)
      return 'The identity conflicts with the explicit Grok account plan';
  }
  const assessment = assessProductEvidence(evidence, format);
  const title = evidenceText(saleEvidenceView({ name: evidence.name, spec: evidence.spec }, format));
  if (TIERS[identity.product] && /邮箱|邮件|域名/u.test(title) && !ACCOUNT_PRODUCT.test(title)
    && /邮箱注册账号|登录邮箱收信/u.test(evidenceText(saleEvidenceView(evidence, format)))) return 'Mailbox delivery does not establish an official subscription';
  if (assessment.kind === 'ambiguous') return assessment.conflict ?? 'Account identity is ambiguous';
  if (assessment.identity) {
    if (identity.family !== assessment.identity.family || identity.product !== assessment.identity.product) return 'The identity conflicts with the explicit account brand or product';
    if (identity.tier !== assessment.identity.tier) return 'The identity conflicts with the account plan or quota multiplier';
  } else if (identity.family === 'xai' && identity.product === 'grok' && ['plus', 'premium', 'super', 'ultra'].includes(identity.tier)) {
    return 'The evidence does not establish the selected unified subscription plan';
  } else if (identity.family === 'x' && identity.product === 'premium_membership') {
    return 'The evidence does not establish the selected X membership tier';
  } else if (identity.product.endsWith('_sms')) {
    return 'The evidence does not establish an SMS verification service';
  } else if (TIERS[identity.product]) {
    if (assessment.rules.includes('non_account_product') || assessment.rules.includes('other_explicit_product') || assessment.rules.includes('no_default_brand_evidence')) return 'The evidence describes a different product, not this account subscription';
    const text = evidenceText(saleEvidenceView(evidence, format));
    const explicitProducts = Object.entries(BRAND_MARKERS).filter(([, pattern]) => pattern.test(text)).map(([product]) => product);
    if (explicitProducts.some(product => product !== identity.product)) return 'The identity conflicts with the explicit brand';
    return 'The evidence does not establish this account subscription and plan';
  }
  return null;
}

export const IDENTITY_POLICY_PROMPT = `Official account identity policy (${IDENTITY_POLICY_VERSION}):
- Approved finite platform sale objects (family/product: allowed tiers): ${JSON.stringify(FINITE_CATALOG)}. For these platforms use only these identities; unrelated evidenced software/tools, installation services and complete bundles belong to their actual generic/software sale object, never an invented official subscription. Claude tutorials require independent sold instructional evidence and are not prebuilt.
- No fitting candidate does not authorize another platform identity. Unknown or newly advertised genuine plans require insufficient_evidence and manual review, never not_sellable solely for being absent here. In particular Cursor/Grok Plus/Premium/Super/Ultra new pricing has no verified mapping to historical Cursor Pro/Pro+/Ultra or SuperGrok/Heavy; Super alone is NOT a SuperGrok alias. Historical Heavy remains distinct.
- User-facing ChatGPT names remain Team and Team 5x. Official Business naming does not merge them; no fixed 5-fold entitlement is promised by the Team 5x name or legacy technical keys. Preserve actual SKU limitations.
- Time extension cards such as "team 续时1h卡" do not establish a ChatGPT Team/Team 5x subscription. Do not assign them to account plans based on Team keywords or seller categories. Normal Team seat/subscription renewals remain distinct.
- Google ordinary login accounts and Gmail share google/email/standard; Gmail availability is not guaranteed by this identity. Eligibility/student-verified but unpaid accounts remain ordinary accounts with original qualification/payment conditions. Never infer activated subscription or student eligibility from EDU/alumni domains. Google/Gmail/YouTube SMS shares google/google_sms/standard.
- Mailbox accounts use their explicit hosting provider: google/email/standard, microsoft/outlook/standard (Outlook/Hotmail/OAuth2), netease/163_mail/standard (all evidenced NetEase domains, NOT only 163), yahoo/email/standard, mail.com/email/standard, or edu/email/standard when educational hosting is unknown. Domain, institution, education, OAuth2/IMAP/POP3/API delivery, age and region are source attributes. OAuth2 does not intrinsically imply receive-only; retain seller restrictions. Google login without Gmail, admin-controlled accounts and receive/send/login restrictions must stay in evidence, not become unqualified capabilities.
- Only-mail/URL/query-code delivery without usable provider login credentials is a receiving service, separate from accounts: google/gmail_code_service/standard, microsoft/mail_receive_service_mixed_domains/standard, apple/icloud_mail/standard, email/domain_email/standard. Email receiving credit/CDK recharge uses email/receive_credits/standard; ambiguous delivery or conflicting quantities require review. APIs used for email or SMS delivery are not model relay exclusions. Toolkits needing the buyer's iCloud+/Apple account are software, not an included account or subscription. Preserve independent gifts and bundle rights.
- X social accounts use x/account/standard, memberships x/premium_membership/premium or premium_plus. Premium+ / Premium Plus needs explicit selected-tier evidence; blue badges, monthly recharge, prices and Grok gifts alone never establish that tier. A selected SKU overrides a shared Premium/Premium+ menu; no selected tier requires review. Attached Grok rights do not create a Grok account. IP resources use network/ip/standard; protocol, region, sharing, bandwidth/data/term and buyer-supplied subscription requirements remain SKU facts.
- Use canonical family/product pairs: openai/chatgpt, google/gemini, anthropic/claude.
- ChatGPT Pro 200 recharge/代充/直充 uses openai/chatgpt/pro_20x. Delivery methods do not change family/product/tier. The same applies to Codex, Claude/Claude Code and Gemini subscription recharge offers.
- Grok accounts use xai/grok. Current unified Grok/X/Cursor subscriptions use tiers plus, premium, super, ultra (shared AI usage; 1x/4x/15x/50x respectively). A named Grok Plus/Premium/Ultra plan or explicitly new/unified X plan is distinct from historical X Premium/Premium+ and SuperGrok/Heavy. Grok Super needs explicit new/unified or 15x evidence; Super alone never proves historical SuperGrok. Preserve old/legacy SKU identities; no automatic migration or mapping from old plans, dollar prices, gifts, shared menus or supported software. A unified subscription's included Cursor/Grok/X benefits are not three separately purchased subscriptions and do not establish standalone Cursor Pro/Pro+. gro, gr0k and Grok in an account title refer to Grok; 普号/free means tier free. For Grok products only, provider aliases x, grok and x.ai normalize to xai. X/Twitter social accounts, Grok API credits, mirrors and SMS services remain separate products; never infer or collapse different paid tiers.
- ChatGPT tiers: free, go, plus, pro_5x, pro_20x, pro_500, team, team_5x. The user-facing names are Pro 100, Pro 200 and Pro 500. Pro 5x/5X and Pro 100 are aliases for the first tier; Pro 10x/10X, Pro 20x/20X and Pro 200 are aliases for the second; Pro 25x/25X, Pro 50x/50X and Pro 500 are aliases for the third. Accept both Pro 10x/10x Pro and the legacy Pro 20x/20x Pro spellings, and likewise Pro 25x/25x Pro and legacy Pro 50x/50x Pro. Equivalent current/legacy aliases may coexist (10x with 20x; 25x with 50x). Compare canonical tiers before declaring a conflict. Different unselected amount tiers (Pro 100/200/500) or contradictory delivered tiers require review; never select the largest amount. Merchant sale prices, balances and usage amounts are not plan names and must not override a named Pro tier or multiplier. Do not infer unsupported decimal multipliers.
- Gemini paid tiers: plus, pro, ultra_5x, ultra_20x. Ordinary Google/Gemini Free accounts use google/email/standard, subject to their actual login/mail availability.
- Claude tiers: free, pro, max_5x, max_20x, team, team_5x.
- Team and Business are aliases of team. Team 5x, team5x, 5x Team and Business 5x are team_5x. Claude Team Premium is team_5x.
- Team JSON/RT/Token credentials with actual subscribed-account evidence remain Team accounts, including software-only or reverse-proxy-only use. Delivery format, registered email domain and supported client do not change family/product/tier and do not alone prove entitlement. Negated 5X and comparison quantities are not positive tier evidence; ChatGPT premium/高级 without explicit selected 5X mapping remains unresolved.
- Codex account subscriptions are ChatGPT. Claude Code account subscriptions are Claude. Decide model relay exclusions from the sold object: explicit model API relay credits, prepaid relay balances, request passes and API pool access are not catalog products. Relay/API mentions in after-sales or policy warnings, comparisons, instructions, possible extra services, categories, URLs, balances or dollar amounts alone do not establish the sold object; ambiguous sale evidence requires review. Login Token instructions, standalone tutorial headings, registration mailbox domains and buyer account restrictions are not sold goods.
- Consolidate sold tutorials at the underlying product level with tier=tutorial (教程): ChatGPT/Codex tutorials use openai/chatgpt/tutorial; Claude/Claude Code use anthropic/claude/tutorial; Gemini uses google/gemini/tutorial. Other tutorials keep their evidenced family/product and use tier=tutorial, e.g. facebook/facebook/tutorial. Name them '<Product> 教程'. Never split tutorials by plan, multiplier, region, payment method, topic, video/PDF format or difficulty, or concatenate these into product. Keep those details in original SKU evidence. Tutorials remain separate from actual accounts, API credits, software tools and installation services; incidental/free usage instructions do not make an account a tutorial. Multi-product bundles keep their own evidenced bundle product; never arbitrarily select one subject.
- Google AI Plus/Pro/Ultra are Gemini plans. Google One storage is an entitlement, not a separate account brand or tier.
- Free account labels include 普号, 普通账户, 普通账号 and 未订阅. 普号可升级Pro is currently free, not Pro.
- Explicit brands override defaults. Brandless team/plus/go/pro names default to ChatGPT when account subscription context is clear. Standalone team, team 5x and 【自营】Team 5X listings also default to ChatGPT. Unrelated explicit products (Steam, TeamViewer, Cursor, etc.) never default.
- ChatGPT Pro, Claude Max and Gemini Ultra REQUIRE explicit supported amount or multiplier evidence. For ChatGPT Pro, supported aliases are Pro 100/200/500 and 5x/10x/25x (with legacy 20x/50x); never invent a multiplier or collapse a known multiplier into pro/max/ultra. 5人 and 5个 are seat/count quantities, not 5x.
- Multiple offered brands/plans or unselected multipliers are ambiguous: request review instead of choosing one. Available model lists do not override the account brand.
- Determine what is sold and the selected SKU before using identity keywords. Buyer self-verification, login tutorials, after-sales exclusions, plan comparisons and possible upgrades do not change the delivered plan. An explicit selected plan resolves an offered menu, but never overrides contradictory actual-delivery claims. Eligibility-only/K12 accounts are not already-activated subscription rights. Mailboxes and sold PDF/tutorial products remain distinct catalog goods. A Team discount/coupon code that only lets the buyer complete payment is openai/chatgpt_team_discount_code/standard, not a Team subscription; actual Team seat redemption codes remain openai/chatgpt/team.
- SMS verification/接码/接马 services ARE catalog products. Provider aliases MUST share one identity: OpenAI/Codex/ChatGPT use openai/codex_sms/standard; Anthropic/Claude/Claude Code use anthropic/claude_sms/standard; Google/Gemini/Google AI use google/google_sms/standard; Microsoft/微软 use microsoft/microsoft_sms/standard. Do not create openai_sms, chatgpt_sms, anthropic_sms, claude_code_sms, gemini_sms or a separate generic sms identity. Other evidenced platforms use platform/platform_sms/standard. Name them '<Platform> 接码服务'. Never merge these with accounts or exclude them.
- A provider explicitly named in the sold service takes priority over providers mentioned in instructions, exclusions or broad categories. Google registration SMS is not Codex SMS just because the description discusses logging into Codex afterwards. Mailbox/email code reception is not phone SMS; an SMS service supporting API delivery is not model API credits.
- Codex 验证码 and 美区手机验证 describe SMS services. A genuine SMS service without an explicit platform defaults to Codex. Explicit title platforms override broad categories; multiple offered platforms without a selected offer require review. Unknown explicit platforms must never default to Codex.
- 已接码/已接马 and 未接码/未接马 describe account delivery conditions. 无需接码, login instructions, email/2FA codes and 验证码 alone do not establish a sold SMS service.
- Preserve unrelated well-formed generic product identities. unknown, unknow and not_applicable are unresolved placeholders and cannot be published.
- Telegram accounts all use telegram/telegram/account: region, account age, duration, direct-login/protocol delivery and 科技号 registration are SKU facts, never separate identities. Telegram Premium subscriptions use telegram/telegram/premium; Stars top-up uses telegram/stars/top_up.
- Region, term, seats, sharing/dedicated access and storage do not change family/product/tier. Gemini Pro 18个月 uses google/gemini/pro.`;

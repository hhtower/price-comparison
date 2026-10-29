import { normalizePurchaseTag, PURCHASE_NAME_ALIASES, type PurchaseTag } from './purchase-attributes.js';

// Exact, reviewed geographic synonyms only. Mixed regions and sales restrictions stay verbatim.
const REGION_ALIASES: Record<string, string[]> = {
  us: ['usa', 'united states', '美国', '美区', '美国区', 'us (美区)'],
  ph: ['philippines', '菲律宾', '菲区', '菲律宾区', 'philippines (菲区)', '菲区 (philippines)', '菲律宾(菲区)', '菲'],
  jp: ['japan', '日本', '日区', '日本区'],
  kr: ['south korea', 'korea', '韩国', '韩区', '韩国区'],
  ca: ['canada', '加拿大', '加区'],
  gb: ['uk', 'united kingdom', '英国', '英区'],
  de: ['germany', '德国', '德区'],
  fr: ['france', '法国', '法区'],
  in: ['india', '印度', '印区', '印度区'],
  id: ['indonesia', '印度尼西亚', '印尼', '印尼区'],
  vn: ['vietnam', '越南', '越南区'],
  br: ['brazil', '巴西', '巴西区'],
  cl: ['chile', '智利', '智利区'],
  tr: ['turkey', 'türkiye', '土耳其', '土区', '土耳其区'],
  ar: ['argentina', '阿根廷', '阿区'],
  au: ['australia', '澳大利亚', '澳洲', '澳区'],
  sg: ['singapore', '新加坡', '新加坡区'],
  hk: ['hong kong', '香港', '港区', '中国香港'],
  tw: ['taiwan', '台湾', '台区', '中国台湾'],
  ru: ['russia', '俄罗斯', '俄区'],
  th: ['thailand', '泰国', '泰区'],
  my: ['malaysia', '马来西亚', '马来区'],
  mx: ['mexico', '墨西哥', '墨西哥区'],
  global: ['全球', '全球通用', 'global region'],
  random: ['随机', '随机地区', '随机区', '随机国家', 'random region', 'random country'],
  cn: ['china', '中国', '国区'], eu: ['europe', '欧洲', '欧区', '欧洲渠道'],
  sea: ['southeast asia', '东南亚', '东南亚区'],
  co: ['colombia', '哥伦比亚'], za: ['south africa', '南非'], nl: ['netherlands', '荷兰'],
  ng: ['nigeria', '尼日利亚'], pk: ['pakistan', '巴基斯坦'], ua: ['ukraine', '乌克兰'],
};
const regions = new Map(Object.entries(REGION_ALIASES).flatMap(([code, values]) => [code, ...values].map(value => [value, code])));
const TWO_FACTOR_NAMES = new Set(['2fa', 'includes_2fa', 'mfa', 'two_factor', 'two_factor_auth', 'two_factor_authentication']);
const TWO_FACTOR_VALUES = new Map([
  ...['有', '是', 'true', 'yes', '1', 'enabled', 'included', 'supported', '支持', '2fa',
    '2fa configured', '2fa enabled', '2fa included', '2fa secret included', '2fa supported',
    'included and must be rebinded', '包含2fa', '含2fa', '已开通', '已设置2fa', '带2fa',
    '自带2fa', '自带2fa登录秘钥', '账号密码+2fa', '2fa链接随号交付,登录后需改',
    '卡密含2fa密钥', '已开2fa', '2fa已设置', '已添加密码和 mfa'].map(value => [value, '有']),
  ...['无', '否', 'false', 'no', '0', 'none', 'not supported', 'no 2fa', '不带2fa', '无2fa',
    '未设置2fa', '未开启', 'disabled', 'not included'].map(value => [value, '无']),
].map(([value, state]) => [value.replace(/[\s_-]+/gu, ''), state]));

// Reviewed legacy access values only; uncertain prose remains in source records and the backup.
function normalizeAccessForCleanup(value: string): PurchaseTag[] {
  const text = value.replace(/_/gu, ' ');
  const tags: PurchaseTag[] = [];
  const add = (name: string, value: string) => tags.push({ name, value });

  // proxy-only variants: only express access_channel, no dedicated/shared claim
  if (/^(?:proxy[ -]?only(?:[ ,，]no[ -]?credentials?)?|proxy[ -]?access|proxy|仅反代|反代(?:only)?)$/u.test(text)) {
    add('access_channel', 'reverse_proxy');
    return tags;
  }

  // family group seat: shared + seat account type
  if (/\bfamily\b|家庭(?:版|组|共享)?/u.test(text)) {
    add('access', 'shared');
    if (/\b(?:seat|slot|车位|席位)\b/u.test(text)) add('account_type', 'seat');
    if (/\b(?:owner|admin|主号|主账号)\b/u.test(text)) add('account_type', 'parent_account');
    return tags;
  }

  // non-overwrite / overwrite recharge
  if (/non[- ]?overwrite|无法覆盖|cannot cover(?! existing subscription$)|不可覆盖|不覆盖/u.test(text)) {
    add('subscription_override', '无'); return tags;
  }
  if (/^(?:可覆盖(?:续费)?|can cover|overwrite ok)$/u.test(text)) {
    add('subscription_override', '有'); return tags;
  }
  if (/^cannot cover existing subscription$/u.test(text)) {
    add('subscription_override', '无'); return tags;
  }

  // kyc / cyber verification state
  if (/\b(?:kyc|cyber|赛博)\b/u.test(text)) {
    const negated = /(?:no|not|un|未|未过|未做|不需要|不用)[ -]?(?:kyc|cyber|赛博|verified|认证)/u.test(text)
      || /(?:kyc|cyber|赛博)[ -]?(?:not|un|未|失败|failed)/u.test(text);
    const required = /(?:kyc|cyber|赛博)[ -]?(?:required|needed|需要|必须)/u.test(text)
      || /(?:need|require|需要|必须)[ -]?(?:kyc|cyber|赛博)/u.test(text);
    if (required) add('kyc_required', '有');
    else if (negated) add('kyc', 'unverified');
    else add('kyc', 'verified');
    return tags;
  }

  const sharing = text.replace(/(?:non[- ]?|not |no |without )(?:shared|sharing)|(?:非|不是|不|禁止)(?:共享|合租)/gu, ' ')
    .replace(/(?:non[- ]?|not |no )dedicated|(?:非|不是|不)(?:独享|独用)/gu, ' ');
  const dedicated = /\b(?:dedicated|exclusive|private use|independent accounts?)\b|独享|独用|独立使用|独立账号|一人一号/u.test(sharing)
    || /\b(?:non[- ]?shared|not shared|no sharing)\b|非共享/u.test(text);
  const shared = /\bshared\b|共享|合租|拼车/u.test(sharing);
  if (dedicated !== shared && !/\?|not specified|some accounts|未说明|少量|部分/u.test(text)) add('access', dedicated ? 'dedicated' : 'shared');

  const account = /成品(?:账?号|账号|账)?|\b(?:finished|ready(?:-made)?) account\b/u.test(text) && !/half[- ]finished|半成品/u.test(text);
  const topUp = /代充|充值|直充|自充|卡充|卡冲|官充|充(?:自己|你)|\brecharge\b|\btop[- ]?up\b/u.test(text);
  if (account !== topUp) add('delivery', account ? 'account' : 'top_up');
  if (!account && !topUp && /兑换码|激活码|\bredemption code\b/u.test(text)) add('delivery', 'redemption');

  // Negated protocols and credentials must not become supported channels or delivered account facts.
  const positive = text.replace(/no rt json credentials?|(?:no|not|without|non)[ -]+(?:(?:account|email) )?(?:password|credentials?|mirror|card[- ](?:code|key))(?:[ /]+(?:credentials?|password))?|(?:非|无|不带|无需(?:提供)?|不提供)(?:账密|账号密码|邮箱密码|镜像)(?:站)?/gu, ' ')
    .replace(/(?:no |not |未开通|未开启|不支持)(?:imap|pop3?)(?:[ /,]+(?:imap|pop3?))*/gu, ' ')
    .replace(/(?:no (?:official )?|not (?:official )?|unsupported |无法|不能|不支持)(?:web(?:[- ]only)?(?: login)?|网页(?:登录)?)|web login unsupported/gu, ' ')
    .replace(/(?:no |without |不带|无)(?:refresh token|rt)\b|refresh token or sk/gu, ' ');
  if (/\bjson\b/u.test(positive)) add('delivery_format', 'json');
  if (/\b(?:cdk|card[- ](?:code|key))\b|卡密/u.test(positive)) add('delivery_format', 'cdk');
  if (/\b(?:credentials?|password)\b|账密|账号[-+|/ ]*密码|邮箱[-+|/ ]*密码/u.test(positive)) add('delivery_format', 'credentials');
  if (/\b(?:refresh[- ]token|rt)\b/u.test(positive)) add('delivery_format', 'refresh_token');
  if (/\b(?:2fa|mfa)\b/u.test(positive) && !/或|\bor\b|after.*(?:2fa|mfa)|(?:2fa|mfa).*after/u.test(text)) {
    add('2fa', /(?:no |without |不带|无|未设置)(?:2fa|mfa)/u.test(text) ? '无' : '有');
  }

  const channelEvidence = positive.replace(/(?:禁止|请勿|不得|不支持|不可|不能)\s*(?:使用)?\s*(?:反代|反向代理|reverse[- ]proxy|sub2api|sub2|cpa)/gu, ' ');
  const channels: Array<[string, RegExp]> = [
    ['reverse_proxy', /反代|反向代理|\breverse[- ]proxy\b|\b(?:sub2api|sub2|cpa)\b|^sub account proxy only$/u],
    ['web', /\bweb\b|网页/u], ['mirror', /镜像|\bmirror\b/u],
    ['imap', /\bimap\b/u], ['pop3', /\bpop3?\b/u], ['graph', /\bgraph\b/u],
  ];
  for (const [channel, pattern] of channels) if (pattern.test(channelEvidence)) add('access_channel', channel);
  if (text === 'api') add('access_channel', 'api');
  if (/\boauth2\b/u.test(positive)) add('login_method', 'oauth2');
  if (/邮箱[+]验证码(?:登录)?|\bemail verification code\b/u.test(positive)) add('login_method', 'email_code');
  if (/\bsso\b/u.test(positive)) add('login_method', 'sso');
  if (/\bsub[- ]accounts?\b|子号/u.test(text)) add('account_type', 'sub_account');
  if (/\b(?:mother|parent|admin) account\b|母号/u.test(text)) add('account_type', 'parent_account');
  if (/\bseat\b|席位|车位/u.test(text)) add('account_type', 'seat');
  const multi = /^([1-9][0-9]*)[ -]*(?:开|open)$/u.exec(text);
  if (multi) add('multi_open', multi[1]);
  const people = /([1-9][0-9]*)[ -]*(?:人|people\b|users?\b|person\b)/u.exec(text);
  if (shared && !dedicated && people && !/[0-9][ -]*[-~到][ -]*[0-9]/u.test(text)) add('shared_users', people[1]);
  return tags;
}

interface TagRule { values?: readonly string[]; pattern?: string; multiple?: boolean }
const boolean: TagRule = { values: ['有', '无'] };
const integer: TagRule = { pattern: '^[1-9][0-9]*$' };
const number = '[0-9]+(?:[.][0-9]+)?';
const period = { pattern: '^' + number + ' (?:minutes?|hours?|days|weeks?|months?|years?)$' };
const range = { pattern: '^' + number + '-' + number + ' (?:minutes?|hours?|days|weeks?|months?|years?)$' };
const money = { pattern: '^' + number + ' (?:usd|cny|eur|gbp|jpy|hkd|twd)$' };
const dataSize = { pattern: '^' + number + ' (?:mb|gb|tb)$' };
const regionRule = { values: [...Object.keys(REGION_ALIASES), 'eg', 'bd', 'it', 'es', 'pl', 'pt', 'se', 'no', 'fi', 'ch', 'at', 'be', 'ie', 'nz', 'ae', 'sa', 'il', 'kz', 'pe', 'ke', 'ee'] };

/** One vocabulary for historical cleanup, the model's schema and ingestion validation. */
export const PRODUCT_TAG_RULES: Record<string, TagRule> = {
  '2fa': boolean, sms_required: boolean, kyc_required: boolean, renewable: boolean, vpn_required: boolean, single_use: boolean, subscription_override: boolean,
  '3ds': boolean, card_binding_required: boolean, email_included: boolean, invoice: boolean, official_bill: boolean,
  sms_verification: { values: ['verified', 'unverified'] }, kyc: { values: ['verified', 'unverified'] },
  access: { values: ['dedicated', 'shared'] }, delivery: { values: ['account', 'top_up', 'redemption'] },
  delivery_format: { values: ['credentials', 'cdk', 'json', 'refresh_token', 'token', 'cookie', 'link', 'sms_link', 'email_api', 'pdf'], multiple: true },
  delivery_mode: { values: ['manual', 'automatic', 'self_service'] },
  access_channel: { values: ['reverse_proxy', 'web', 'mirror', 'imap', 'pop3', 'graph', 'api'], multiple: true },
  supported_client: { multiple: true }, usage_restriction: { multiple: true },
  login_method: { values: ['oauth2', 'sso', 'password', 'email_code'], multiple: true },
  device_platform: { values: ['android', 'ios', 'windows', 'macos', 'linux', 'web', 'pc'], multiple: true },
  payment_platform: { values: ['ios', 'android', 'web'], multiple: true },
  account_type: { values: ['sub_account', 'parent_account', 'seat', 'personal', 'enterprise'] },
  account_lifecycle: { values: ['new', 'aged'] },
  email_provider: { values: ['icloud', 'gmail', 'hotmail', 'outlook', 'microsoft', 'custom_domain', 'mail.com', 'vfemail.net', 'mixed'] },
  email_domain: { pattern: '^(?:[a-z0-9-]+[.])+[a-z]{2,}$' },
  region: regionRule, region_options: { ...regionRule, multiple: true }, recommended_ip_region: { ...regionRule, multiple: true },
  registration_region: regionRule, payment_region: regionRule,
  duration: { pattern: '(?:^permanent$)|' + period.pattern }, duration_range: range, duration_min: period, duration_max: period, duration_approx: period,
  account_age: period, account_age_range: range, account_age_min: period, account_age_approx: period, registration_year: { pattern: '^20[0-9]{2}(?:-20[0-9]{2})?$' },
  token_validity: period, token_validity_range: range, token_validity_min: period, token_validity_approx: period,
  redemption_code_validity: { pattern: '(?:^permanent$)|' + period.pattern }, redemption_code_validity_range: range, redemption_code_validity_min: period, redemption_code_validity_approx: period,
  sms_receive_link_duration: period, sms_receive_link_duration_range: range, sms_receive_link_duration_min: period, sms_receive_link_duration_approx: period,
  email_validity: period, number_validity: period, credits_validity: period,
  warranty: { values: ['covered', 'none'] },
  warranty_scope: { values: ['first_login', 'period', 'subscription', 'first_code', 'activation', 'unspecified'] },
  warranty_trigger: { values: ['purchase', 'delivery', 'activation', 'first_login'] },
  warranty_days: integer, warranty_window: period, warranty_exclusion: { values: ['ban'], multiple: true },
  warranty_detail: { values: ['1 month', 'subscription coverage'] },
  warranty_terms: { multiple: true },
  intended_use: { values: ['rapid'] },
  quantity: integer, minimum_quantity: integer, usage_count: integer, seats: integer, shared_users: integer, multi_open: integer,
  binding_limit: integer, usage_count_max: integer, included_sms_count: integer, reset_count: integer, followers: integer, cpu_cores: integer, token_count: integer,
  token_unit: { values: ['muse'] },
  credits: { pattern: '^' + number + '$' }, amount: money, balance: money,
  credits_range: { pattern: '^' + number + '-' + number + '$' },
  balance_range: { pattern: '^' + number + '-' + number + ' (?:usd|cny|eur|gbp|jpy|hkd|twd)$' },
  amount_daily: money, amount_monthly: money, credits_daily: { pattern: '^' + number + '$' }, credits_monthly: { pattern: '^' + number + '$' },
  request_limit_hourly: integer, request_limit_daily: integer,
  storage: dataSize, memory: dataSize, data_quota: dataSize, bandwidth: { pattern: '^' + number + ' (?:mbps|gbps)$' },
  card_network: { values: ['visa', 'mastercard', 'amex', 'unionpay'] }, card_type: { values: ['physical', 'virtual'] },
  card_bin: { pattern: '^[0-9]{6,8}$' }, ip_type: { values: ['residential', 'dynamic_residential'] },
  sim_type: { values: ['physical', 'esim'] },
  payment_method: { values: ['paypal', 'upi', 'gcash', 'momo', 'google_pay', 'apple_pay', 'pix', 'ideal', 'kakao', 'gopay', 'visa', 'mastercard'], multiple: true },
  renewal_timing: { values: ['any_time', 'after_expiry'] },
  edition: {}, model: {}, carrier: {}, language: {}, color: {}, material: {}, size: {},
};

const NAME_ALIASES: Record<string, string> = {
  ...PURCHASE_NAME_ALIASES,
  delivery_form: 'delivery_format', format: 'delivery_format', delivery_content: 'delivery_format',
  email_type: 'email_provider', email: 'email_provider', platform: 'device_platform',
  renewal: 'renewable', account_region: 'region', country: 'region', 地区: 'region', 国家: 'region',
  seat_count: 'seats', count: 'quantity', points: 'credits', credit: 'credits',
  instances: 'multi_open', multi_instance: 'multi_open', 开数: 'multi_open',
  min_order_quantity: 'minimum_quantity', min_quantity: 'minimum_quantity', minimum_order: 'minimum_quantity',
  mail_provider: 'email_provider', email_suffix: 'email_domain',
  account_year: 'registration_year', account_creation_year: 'registration_year', registration_period: 'registration_year',
  account_vintage: 'registration_year', account_year_range: 'registration_year', registration_years: 'registration_year',
  account_years: 'registration_year', email_years: 'registration_year',
};
const clean = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();

export function isCanonicalProductTag(tag: PurchaseTag): boolean {
  const rule = Object.hasOwn(PRODUCT_TAG_RULES, tag.name) ? PRODUCT_TAG_RULES[tag.name] : undefined;
  const amounts = rule?.pattern && /^([0-9.]+)(?:-([0-9.]+))?(?: |$)/u.exec(tag.value);
  if (amounts && (!Number.isFinite(Number(amounts[1])) || (amounts[2] && (!Number.isFinite(Number(amounts[2])) || Number(amounts[2]) < Number(amounts[1]))))) return false;
  if (amounts && (rule === period || rule === range || /duration|account_age|validity|warranty_window/u.test(tag.name)) && Number(amounts[1]) <= 0) return false;
  return !!rule && !!tag.value && tag.value.length <= 250
    && (!rule.values || rule.values.includes(tag.value)) && (!rule.pattern || new RegExp(rule.pattern, 'u').test(tag.value));
}

function normalizedPeriod(value: string): string | undefined {
  const match = /^([0-9]+(?:[.][0-9]+)?)(?:\s*[-~～至到]\s*([0-9]+(?:[.][0-9]+)?))?\s*(分钟|小时|天|周|星期|个月|月|年|minutes?|hours?|days?|weeks?|months?|years?)$/u.exec(value);
  if (!match || Number(match[1]) <= 0 || (match[2] && Number(match[2]) < Number(match[1]))) return;
  const unit = /分钟|minute/u.test(match[3]) ? 'minute' : /小时|hour/u.test(match[3]) ? 'hour'
    : /天|day/u.test(match[3]) ? 'day' : /周|星期|week/u.test(match[3]) ? 'week' : /月|month/u.test(match[3]) ? 'month' : 'year';
  const amount = String(Number(match[1])) + (match[2] ? '-' + Number(match[2]) : '');
  return amount + ' ' + unit + (unit === 'day' || amount !== '1' ? 's' : '');
}

/** Undefined preserves an unrelated legacy attribute; [] discards an unsupported known claim. */
function normalizeKnownTag(tag: PurchaseTag): PurchaseTag[] | undefined {
  const rawName = clean(tag.name).replace(/[ -]+/gu, '_');
  const name = TWO_FACTOR_NAMES.has(rawName) ? '2fa' : NAME_ALIASES[rawName] ?? rawName;
  const value = clean(tag.value);
  const make = (name: string, value: string): PurchaseTag[] => [{ name, value }];
  if (!Object.hasOwn(PRODUCT_TAG_RULES, name)) return;
  if (isCanonicalProductTag({ name, value })) return make(name, value);
  if (name === '2fa') {
    const state = TWO_FACTOR_VALUES.get(value.replace(/[\s_-]+/gu, ''));
    return state ? make(name, state) : [];
  }
  if (name === 'access') return normalizeAccessForCleanup(value);
  if (/^(?:unknown|unspecified|not[_ ]specified|not[_ ]applicable|n\/a|未知|未说明|不适用)$/u.test(value)) return [];
  if (PRODUCT_TAG_RULES[name] === boolean) {
    if (/^(?:yes|true|1|是)$/u.test(value)) return make(name, '有');
    if (/^(?:no|false|0|否)$/u.test(value)) return make(name, '无');
  }
  if (name === 'registration_year' && /^20[0-9]{2}(?:-20[0-9]{2})?年$/u.test(value)) return make(name, value.slice(0, -1));
  if (name === 'email_domain') {
    if (value.startsWith('@') && isCanonicalProductTag({ name, value: value.slice(1) })) return make(name, value.slice(1));
    return normalizeKnownTag({ name: 'email_provider', value });
  }
  if (name === 'multi_open' && /^(?:单开|五开)$/u.test(value)) return make(name, value === '单开' ? '1' : '5');
  if (name === 'account_type') {
    if (/^(?:个人|个人版)$/u.test(value)) return make(name, 'personal');
    if (/^(?:老号|老邮箱)$/u.test(value)) return make('account_lifecycle', 'aged');
    if (/^(?:新号|new account)$/u.test(value)) return make('account_lifecycle', 'new');
    if (/^(?:日抛|daily throw|daily throwaway)$/u.test(value)) return make('intended_use', 'rapid');
  }
  if (name === 'payment_method' && /^(?:google pay|apple pay)$/u.test(value)) return make(name, value.replace(' ', '_'));
  if (['sms_verification', 'kyc'].includes(name)) {
    if (/部分|可能|或|\bor\b|partial|不保证|maybe/u.test(value)) return [];
    if (/^(?:required|需要|需验证|需认证)$/u.test(value)) return make(name === 'kyc' ? 'kyc_required' : 'sms_required', '有');
    if (/^(?:not[_ ]required|无需验证|无需认证)$/u.test(value)) return make(name === 'kyc' ? 'kyc_required' : 'sms_required', '无');
    if (/^(?:unverified|未(?:接码|接马|验证|认证|实名)|未过kyc)(?:\s*[(（].*[)）])?$/u.test(value)) return make(name, 'unverified');
    if (/^(?:verified|passed|已过|已(?:接码|接马|验证|认证|实名)|已过kyc认证)(?:\s*[(（](?:已接码|已接马|已验证|已认证)[)）])?$/u.test(value)) return make(name, 'verified');
    if (/^(?:single[-_ ]use|one[- ]time|单次)$/u.test(value)) return make('single_use', '有');
    return;
  }
  if (name === 'region') {
    const region = regions.get(value);
    if (region) return make(name, region);
    const restricted = /^([a-z]{2}) [(]vpn required[)]$/u.exec(value);
    if (restricted && PRODUCT_TAG_RULES.region.values!.includes(restricted[1])) return [{ name, value: restricted[1] }, { name: 'vpn_required', value: '有' }];
    if (/^(?:ios|苹果)渠道$/u.test(value)) return make('payment_platform', 'ios');
    if (/^(?:android|安卓)渠道$/u.test(value)) return make('payment_platform', 'android');
    if (/^(?:ios|苹果)(?:区)?$/u.test(value)) return make('device_platform', 'ios');
    if (/^(?:android|安卓)(?:区)?$/u.test(value)) return make('device_platform', 'android');
    if (PRODUCT_TAG_RULES.email_provider.values!.includes(value)) return make('email_provider', value);
    const payment = ({ upi: 'upi', 'upi渠道': 'upi', gcash: 'gcash', momo: 'momo', 'momo渠道': 'momo', 'pp渠道': 'paypal', 'google pay': 'google_pay' } as Record<string, string>)[value];
    if (payment) return make('payment_method', payment);
    return;
  }
  if (name === 'email_provider') {
    const normalized = value.replace(/微软/gu, 'microsoft').replace(/谷歌|google/gu, 'gmail').replace(/^ic邮箱$|^apple$/gu, 'icloud')
      .replace(/邮箱|邮件|账号|账户|混发|\bemail\b|\bmailbox\b/gu, '').trim();
    const providers = normalized.split(/[ /+、,，]+/u).filter(Boolean);
    if (providers.length && providers.every(p => PRODUCT_TAG_RULES.email_provider.values!.includes(p))) {
      return make(name, new Set(providers).size === 1 ? providers[0] : 'mixed');
    }
    if (/^(?:自定义域名|自建|自域名|自有域名)$/u.test(normalized)) return make(name, 'custom_domain');
    return;
  }
  if (name === 'device_platform') {
    if (/^(?:安卓苹果(?:互通|通用)?|安卓ios通用|android\s*(?:[/+,]|and)\s*ios)$/u.test(value)) return [{ name, value: 'android' }, { name, value: 'ios' }];
    const platform = ({ 安卓: 'android', 苹果: 'ios', 电脑: 'pc', 网页: 'web' } as Record<string, string>)[value];
    return platform ? make(name, platform) : undefined;
  }
  if (['delivery', 'delivery_format', 'login_method', 'account_type', 'access_channel'].includes(name)) {
    if (/或|\bor\b|部分|可能/u.test(value)) return;
    const direct = normalizePurchaseTag({ name, value });
    if (direct.every(isCanonicalProductTag)) return direct;
    const mode = /^(?:自动发货|自动|automatic|虚拟资源自动发货|virtual_resource_auto_delivery)$/u.test(value) ? 'automatic'
      : /^(?:人工发货|人工|手动|manual|人工交付|人工手动充值|手动发货|手工发货|私聊手动发货|manual delivery|manual delivery via customer service|人工代发|需要联系管理在线发货)$/u.test(value) ? 'manual'
      : /^(?:自助|self[-_ ]service)$/u.test(value) ? 'self_service' : undefined;
    if (mode) return make('delivery_mode', mode);
    if (/^(?:activation[_ ]code)$/u.test(value)) return make('delivery', 'redemption');
    if (/^(?:activation[_ ]link|subscription link|redemption link|激活链接|兑换链接|兑换链接 [(]redemption link[)])$/u.test(value)) return make('delivery_format', 'link');
    if (/^(?:pdf|pdf 电子资料)$/u.test(value)) return make('delivery_format', 'pdf');
    const moved = normalizeAccessForCleanup(value);
    return moved.length ? moved : undefined;
  }
  if (['duration', 'duration_range', 'duration_min', 'duration_approx', 'account_age', 'account_age_range', 'warranty_window'].includes(name)) {
    if (name === 'duration' && /^(?:single[-_ ]use|一次性|单次(?:接码|接马)?)$/u.test(value)) return make('single_use', '有');
    if (name === 'duration' && /^(?:日抛|日抛号|disposable|daily[_ ]disposable|daily [(]日抛[)])$/u.test(value)) return make('intended_use', 'rapid');
    if (name === 'duration' && /^(?:永久|永久卡|终身|lifetime)$/u.test(value)) return make(name, 'permanent');
    const word = ({ daily: '1 days', day: '1 days', 天卡: '1 days', weekly: '1 week', week: '1 week', 周卡: '1 week', monthly: '1 month', month: '1 month', 月卡: '1 month', 一个月: '1 month', quarterly: '3 months', 季卡: '3 months', annual: '1 year', yearly: '1 year', 年卡: '1 year', 一年: '1 year' } as Record<string, string>)[value];
    if (name === 'account_age' && /^[0-9]{2,4}-[0-9]{2,4}年?$/u.test(value)) return;
    const card = name === 'duration' ? ({ 月: '1 month', 单月: '1 month', 月包: '1 month', 'monthly card': '1 month',
      '1 natural month': '1 month', '1个自然月': '1 month', 三天卡: '3 days', 'day card': '1 days', 'weekly card': '1 week' } as Record<string, string>)[value] : undefined;
    // Strip only duration descriptors; token age, warranty and approximate validity keep their scope.
    const described = name === 'duration' ? normalizedPeriod(value.replace(/^(?:长效|短效)/u, '').replace(/(?:长效|订阅周期)$/u, '')) : undefined;
    const time = normalizedPeriod(value) ?? word ?? card ?? described;
    if (time) return make(time.includes('-') ? name === 'duration' ? 'duration_range' : name === 'account_age' ? 'account_age_range' : name : name, time);
    if (name === 'duration') {
      const approx = /^(?:about |约|~)(.+)$|^(.+)(?:左右)$/u.exec(value);
      const minimum = /^(?:at least |至少)(.+)$|^(.+)(?:以上)$/u.exec(value);
      const measured = approx ?? minimum;
      const qualified = measured ? normalizedPeriod(measured[1] ?? measured[2]) : undefined;
      if (qualified) return make(approx ? 'duration_approx' : 'duration_min', qualified);
    }
    return;
  }
  if (name === 'warranty') {
    const text = value.replace(/_/gu, ' ');
    if (/^(?:无质保无售后|无任何质保售后|无任何售后|不售后|不提供质保|不包 无售后|no after-sales)$/u.test(text)) return make(name, 'none');
    const scope = /^(?:质保首码|质保1次成功接马|质保一次成功接马|只质保首次来码)$/u.test(text) ? 'first_code'
      : /^(?:质保首次登陆|仅质保登录|质保首登录|仅首次登录质保|只质保首登|首次登录质保|首登录|first-login coverage|first login [(]质保首登[)])$/u.test(text) ? 'first_login'
      : text === '全程质保' ? 'period' : undefined;
    if (scope) return [{ name, value: 'covered' }, { name: 'warranty_scope', value: scope }];
    const basic = normalizePurchaseTag({ name, value: text });
    const first = /^(?:first[- ]login(?: only| warranty)?|首登(?:质保|保障)?|质保首登)$/u.test(text);
    if (first) return [{ name, value: 'covered' }, { name: 'warranty_scope', value: 'first_login' }];
    const timed = /^(?:质保|保修|warranty\s*)?([0-9]+\s*(?:小时|天|hours?|days?))\s*(first login(?: only)?|首登(?:质保)?|掉订阅包赔[,，]封号不保|质保|warranty)?$/u.exec(text);
    if (timed) {
      const time = normalizedPeriod(timed[1]);
      if (!time) return;
      const scope = /first login|首登/u.test(timed[2] ?? '') ? 'first_login' : /掉订阅/u.test(timed[2] ?? '') ? 'subscription' : 'period';
      return [{ name, value: 'covered' }, { name: 'warranty_scope', value: scope },
        ...make(time.endsWith(' days') && scope === 'period' ? 'warranty_days' : 'warranty_window', time.endsWith(' days') && scope === 'period' ? time.split(' ')[0] : time),
        ...(/封号不保/u.test(text) ? make('warranty_exclusion', 'ban') : [])];
    }
    const expanded = text.replace(/一个月/gu, '1 month').replace(/一小时/gu, '1 hour').replace(/半小时/gu, '30 minutes')
      .replace(/([0-9])h\b/gu, '$1 hours');
    const window = expanded.match(/[0-9]+\s*(?:minutes?|hours?|days?|weeks?|months?|years?|分钟|小时|天|周|个月|月|年)/u)?.[0];
    // Only discard reviewed connective words; arbitrary conditions stay in the legacy text.
    const remaining = expanded.replace(window ?? '\u0000', '').replace(/first[- ]login|subscription|warranty|within|only|first|login|no subscription drop|首登|首次登录|质保|保修|订阅周期|掉订阅包赔|不掉订阅|订阅|保|包|内|仅|[ ,，]/gu, '');
    if (!remaining && (window || /首登|first[- ]login|subscription|订阅/u.test(expanded))) {
      const scope = /首登|首次登录|first[- ]login/u.test(expanded) ? 'first_login' : /subscription|订阅/u.test(expanded) ? 'subscription' : 'period';
      const time = window ? normalizedPeriod(window) : undefined;
      if (window && !time) return;
      return [{ name, value: 'covered' }, { name: 'warranty_scope', value: scope }, ...(time ? make(scope === 'period' && time.endsWith(' days') ? 'warranty_days' : 'warranty_window', scope === 'period' && time.endsWith(' days') ? time.split(' ')[0] : time) : [])];
    }
    return basic.every(isCanonicalProductTag) ? basic : undefined;
  }
  if (name === 'renewable') {
    if (/^(?:(?:该渠道)?不支持提前续费[,，]\s*(?:需订阅到期后续费|请您账号订阅到期[,，]\s*显示免费版后再进行购买续费)|到期后续费|after expiry)$/u.test(value)) return [{ name, value: '有' }, { name: 'renewal_timing', value: 'after_expiry' }];
    if (/^(?:可续费|可续租|支持续费|renewable|supported|yes|true)$/u.test(value)) return make(name, '有');
    if (/^(?:不支持续费|不可续费|不续费|not renewable|unsupported|no|false)$/u.test(value)) return make(name, '无');
    return;
  }
  if (name === 'subscription_override') {
    if (/^(?:plus未到期不可以覆盖|(?:不可|无法|不)覆盖(?:订阅|续费)?|non[- ]?overwrite|cannot cover existing subscription)$/u.test(value)) return make(name, '无');
    if (/^(?:可覆盖(?:续费)?|can cover|overwrite ok)$/u.test(value)) return make(name, '有');
  }
  if (['quantity', 'minimum_quantity', 'usage_count', 'seats', 'shared_users', 'multi_open', 'credits', 'amount', 'balance', 'storage', 'warranty_days'].includes(name)) {
    const currency = /^(?:([$¥€£])\s*)?([0-9]+(?:[.][0-9]+)?)\s*(美元|美金|刀|dollars?|人民币|元|欧元|英镑|日元|港币|台币|usd|cny|eur|gbp|jpy|hkd|twd)?$/u.exec(value);
    if (currency && (currency[1] || currency[3])) {
      const code = ({ '$': 'usd', '¥': 'cny', '€': 'eur', '£': 'gbp', 美元: 'usd', 美金: 'usd', 刀: 'usd', dollar: 'usd', dollars: 'usd', 人民币: 'cny', 元: 'cny', 欧元: 'eur', 英镑: 'gbp', 日元: 'jpy', 港币: 'hkd', 台币: 'twd' } as Record<string, string>)[currency[3] ?? currency[1]] ?? currency[3];
      return make(name === 'balance' ? name : 'amount', Number(currency[2]) + ' ' + code);
    }
    const count = /^([1-9][0-9]*(?:[.][0-9]+)?)\s*(k|w|万)?\s*(积分|点数|点|credits?|points?|个|份|人|席位|seats?|users?|次(?:兑换)?|times|uses|开|天)?\s*(起拍|起购|起)?$/u.exec(value);
    if (count) {
      if (count[3] === '天' && name !== 'warranty_days') return;
      if (/^(?:人|users?|seats?|席位)$/u.test(count[3] ?? '') && !['seats', 'shared_users'].includes(name)) return;
      const target = count[4] ? 'minimum_quantity' : /^(?:次(?:兑换)?|times|uses)$/u.test(count[3] ?? '') ? 'usage_count' : count[3] === '开' ? 'multi_open' : /积分|点|credit|point/u.test(count[3] ?? '') ? 'credits' : name;
      const amount = String(Number(count[1]) * (count[2] === 'k' ? 1000 : /^(?:w|万)$/u.test(count[2] ?? '') ? 10000 : 1));
      if (isCanonicalProductTag({ name: target, value: amount })) return make(target, amount);
    }
    const size = /^([0-9]+(?:[.][0-9]+)?)\s*(mb|gb|tb)$/u.exec(value);
    return name === 'storage' && size ? make(name, Number(size[1]) + ' ' + size[2]) : undefined;
  }
  const normalized = normalizePurchaseTag({ name, value });
  return normalized.every(isCanonicalProductTag) ? normalized : undefined;
}

export function normalizeProductTag(tag: PurchaseTag): PurchaseTag[] | undefined {
  const result = normalizeKnownTag(tag);
  return result?.every(isCanonicalProductTag) ? result : undefined;
}

/** The catalog interprets warranty_days as full-period coverage; qualified coverage needs a window. */
export function normalizeWarrantyWindow<T extends PurchaseTag>(tag: T, scope: string | undefined): T {
  return tag.name === 'warranty_days' && isCanonicalProductTag(tag) && ['first_login', 'subscription', 'first_code', 'activation'].includes(scope ?? '')
    ? { ...tag, name: 'warranty_window', value: tag.value + ' days' } : tag;
}

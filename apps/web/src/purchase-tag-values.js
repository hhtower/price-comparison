import { normalizePurchaseTag, purchaseTagLabel } from '@price-comparison/catalog/purchase-attributes';
import { PURCHASE_GUIDE_FIELDS } from '@price-comparison/catalog/purchase-guide-content';

const REGION_NAMES = new Intl.DisplayNames(['zh-CN'], { type: 'region', fallback: 'code' });
const REGION_FIELDS = new Set(['region', 'region_options', 'recommended_ip_region', 'registration_region', 'payment_region']);
const VALUE_LABELS = {
  delivery_format: { credentials: '账密', cdk: '卡密', json: 'JSON', refresh_token: '刷新令牌', token: '令牌', cookie: 'Cookie', link: '兑换链接', sms_link: '接码链接', email_api: '邮箱接口', pdf: 'PDF' },
  access_channel: { reverse_proxy: '反向代理', web: '网页', mirror: '镜像站', imap: 'IMAP', pop3: 'POP3', graph: 'Microsoft Graph', api: 'API' },
  login_method: { oauth2: 'OAuth2 授权', sso: '单点登录', password: '密码', email_code: '邮箱验证码' },
  device_platform: { android: '安卓', ios: 'iOS', windows: 'Windows', macos: 'macOS', linux: 'Linux', web: '网页', pc: '电脑' },
  payment_platform: { android: '安卓', ios: 'iOS', web: '网页' },
  account_type: { sub_account: '子号', parent_account: '母号', seat: '席位', personal: '个人', enterprise: '企业' },
  email_provider: { icloud: 'iCloud', gmail: 'Gmail', hotmail: 'Hotmail', outlook: 'Outlook', microsoft: '微软', custom_domain: '自定义域名', mixed: '混合邮箱' },
  warranty_scope: { first_login: '仅保首登', period: '按质保时长', subscription: '仅保掉订阅', first_code: '仅保首次接码', activation: '仅保激活' },
  warranty_trigger: { purchase: '购买时', delivery: '交付时', activation: '激活时', first_login: '首次登录' },
  warranty_exclusion: { ban: '封号' },
  warranty_detail: { 'subscription coverage': '订阅保障' },
  card_network: { visa: 'Visa', mastercard: '万事达', amex: '美国运通', unionpay: '银联' },
  card_type: { physical: '实体卡', virtual: '虚拟卡' },
  ip_type: { residential: '住宅网络', dynamic_residential: '动态住宅网络' },
  sim_type: { physical: '实体卡', esim: 'eSIM' },
  payment_method: { paypal: 'PayPal', upi: 'UPI', gcash: 'GCash', momo: 'MoMo', google_pay: 'Google Pay', apple_pay: 'Apple Pay', pix: 'Pix', ideal: 'iDEAL', kakao: 'Kakao Pay', gopay: 'GoPay', visa: 'Visa', mastercard: '万事达' },
  token_unit: { muse: 'Muse' },
  renewal_timing: { any_time: '随时续费', after_expiry: '到期后续费' },
};
const REGION_LABELS = { global: '全球', random: '随机地区', eu: '欧洲', sea: '东南亚' };
const UNIT_LABELS = { minute: '分钟', hour: '小时', day: '天', week: '周', month: '个月', year: '年', usd: '美元', cny: '元', eur: '欧元', gbp: '英镑', jpy: '日元', hkd: '港元', twd: '新台币', mb: 'MB', gb: 'GB', tb: 'TB', mbps: 'Mbps', gbps: 'Gbps' };

export function displayPurchaseTagValue(tag, fallback = value => value.value) {
  if (['有', '无'].includes(tag.value)) return tag.name === '2fa' ? purchaseTagLabel(tag) : tag.value;
  if (VALUE_LABELS[tag.name]?.[tag.value]) return VALUE_LABELS[tag.name][tag.value];
  if (REGION_FIELDS.has(tag.name)) {
    if (REGION_LABELS[tag.value]) return REGION_LABELS[tag.value];
    if (/^[a-z]{2}$/iu.test(tag.value)) return REGION_NAMES.of(tag.value.toUpperCase());
  }
  if (tag.value === 'permanent' && /^(?:duration|redemption_code_validity)$/u.test(tag.name)) return '永久';
  const measured = /^([0-9]+(?:[.][0-9]+)?(?:-[0-9]+(?:[.][0-9]+)?)?) ([a-z]+)$/u.exec(tag.value);
  const unit = measured && (UNIT_LABELS[measured[2]] ?? UNIT_LABELS[measured[2].replace(/s$/u, '')]);
  if (unit) return measured[1] + unit;
  const label = purchaseTagLabel(tag);
  return label !== normalizePurchaseTag(tag)[0]?.value ? label : fallback(tag);
}

const BOOLEAN_TEXT = {
  '2fa': ['含2FA', '无2FA'], sms_required: ['需接码', '无需接码'], kyc_required: ['需实名', '无需实名'],
  renewable: ['可续费', '不可续费'], vpn_required: ['需代理', '无需代理'], single_use: ['一次性使用', '可多次使用'],
  subscription_override: ['覆盖现有订阅', '不覆盖订阅'], '3ds': ['支持3DS', '不支持3DS'],
  card_binding_required: ['需绑卡', '无需绑卡'], email_included: ['含邮箱', '不含邮箱'],
  invoice: ['含发票', '无发票'], official_bill: ['含官方账单', '无官方账单'],
};
const STANDALONE_FIELDS = new Set(['delivery', 'delivery_format', 'delivery_mode', 'access', 'access_channel',
  'account_lifecycle', 'sms_verification', 'intended_use', 'kyc', 'warranty', 'warranty_scope',
  'renewal_timing', 'usage_restriction', 'card_type', 'ip_type']);
const SHORT_LABELS = {
  supported_client: '支持', email_provider: '邮箱', email_domain: '邮箱域名', registration_year: '注册年份',
  token_unit: '令牌单位', storage: '存储', memory: '内存', data_quota: '流量', bandwidth: '带宽',
  card_network: '卡组织', card_bin: '卡段', payment_method: '支付',
};
const QUANTITY_TEXT = {
  quantity: ['', '件'], usage_count: ['可用', '次'], usage_count_max: ['最多用', '次'],
  seats: ['', '席位'], shared_users: ['', '人共享'], multi_open: ['', '开'], binding_limit: ['最多绑定', '个'],
  included_sms_count: ['含', '次短信'], reset_count: ['可重置', '次'], followers: ['', '粉丝'], cpu_cores: ['', '核CPU'],
  token_count: ['', '令牌'], credits: ['', '积分'], credits_range: ['', '积分'],
  amount: ['面值', ''], balance: ['余额', ''], balance_range: ['余额', ''],
  amount_daily: ['每日', ''], amount_monthly: ['每月', ''], credits_daily: ['每日', '积分'], credits_monthly: ['每月', '积分'],
  request_limit_hourly: ['每小时', '次请求'], request_limit_daily: ['每日', '次请求'],
};
const PERIOD_LABELS = { duration: '', account_age: '号龄', token_validity: '令牌', redemption_code_validity: '兑换码', sms_receive_link_duration: '接码链接' };

export function displayPurchaseTagText(tag, value = displayPurchaseTagValue(tag)) {
  const { name } = tag;
  if (BOOLEAN_TEXT[name] && ['有', '无'].includes(value)) return BOOLEAN_TEXT[name][value === '有' ? 0 : 1];
  if (name === '2fa' || STANDALONE_FIELDS.has(name)) return value;
  if (name === 'account_type') return ['个人', '企业'].includes(value) ? value + '账号' : value;
  if (name === 'login_method') return /^(?:密码|邮箱验证码)$/u.test(value) ? value + '登录' : value;
  if (name === 'device_platform') return '支持' + value;
  if (name === 'payment_platform') return value + '充值';
  if (name === 'sim_type') return value === '实体卡' ? '实体SIM卡' : value;
  if (REGION_FIELDS.has(name)) {
    if (name === 'region') return value;
    if (name === 'recommended_ip_region') return '建议' + value + '网络';
    return { region_options: '可选', registration_region: '注册地', payment_region: '支付地' }[name] + value;
  }
  if (name === 'minimum_quantity') return /^\d+$/u.test(value) ? value + '件起购' : value;
  if (QUANTITY_TEXT[name]) return QUANTITY_TEXT[name][0] + value + QUANTITY_TEXT[name][1];
  const period = /^(duration|account_age|token_validity|redemption_code_validity|sms_receive_link_duration)(?:_(range|min|max|approx))?$/u.exec(name);
  if (period) {
    const label = PERIOD_LABELS[period[1]];
    const qualifier = { min: '至少', max: '最多', approx: '约' }[period[2]] || '';
    if (value === '永久') return label ? label + '永久有效' : value;
    return label + (qualifier || (label && period[1] !== 'account_age' ? '有效期' : '')) + value;
  }
  if (name === 'warranty_days') return value.startsWith('质保') ? value : '质保' + value + '天';
  if (name === 'warranty_trigger') return { '购买时': '购买起保', '交付时': '交付起保', '激活时': '激活起保', '首次登录': '首登起保' }[value] || '起保 ' + value;
  if (name === 'warranty_window') return '保障窗口' + value;
  if (name === 'warranty_exclusion') return '不保' + value;
  if (name === 'warranty_detail') return value === '订阅保障' ? value : '补充质保' + value;
  return (SHORT_LABELS[name] || tag.label || PURCHASE_GUIDE_FIELDS[name]?.label || name) + ' ' + value;
}

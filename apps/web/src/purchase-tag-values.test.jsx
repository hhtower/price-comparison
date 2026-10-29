import { expect, test } from 'vitest';
import { PRODUCT_TAG_RULES } from '@price-comparison/catalog/product-tag-policy';
import { displayPurchaseTagValue, displayPurchaseTagText } from './purchase-tag-values.js';

test('all English enum values have readable labels or retain recognized brand and protocol names', () => {
  const retainedNames = new Set(['json', 'token', 'cookie', 'pdf', 'imap', 'pop3', 'graph', 'api', 'ios', 'windows', 'macos', 'linux', 'icloud', 'gmail', 'hotmail', 'outlook', 'mail.com', 'vfemail.net', 'muse', 'visa', 'esim', 'paypal', 'upi', 'gcash', 'momo', 'google_pay', 'apple_pay', 'pix', 'ideal', 'kakao', 'gopay']);
  for (const [name, rule] of Object.entries(PRODUCT_TAG_RULES)) {
    for (const value of rule.values || []) {
      if (!/[a-z]/iu.test(value) || retainedNames.has(value)) continue;
      expect(displayPurchaseTagValue({ name, value }), `${name}:${value}`).not.toBe(value);
    }
  }
});

test.each([
  ['delivery_mode', 'automatic', '自动发货'], ['delivery_mode', 'manual', '手动发货'], ['delivery_mode', 'self_service', '自助提取'],
  ['delivery_format', 'credentials', '账密'], ['login_method', 'email_code', '邮箱验证码'],
  ['access_channel', 'reverse_proxy', '反向代理'], ['warranty_trigger', 'delivery', '交付时'],
  ['amount', '12.5 usd', '12.5美元'], ['balance_range', '10-20 cny', '10-20元'],
  ['storage', '10 gb', '10GB'], ['bandwidth', '100 mbps', '100Mbps'], ['bandwidth', '1 gbps', '1Gbps'],
  ['duration_range', '1-2 years', '1-2年'], ['redemption_code_validity', 'permanent', '永久'],
  ['email_domain', 'example.com', 'example.com'], ['supported_client', 'CustomApp', 'CustomApp'],
  ['usage_restriction', 'Do not change password', 'Do not change password'],
])('formats %s:%s as %s', (name, value, expected) => {
  expect(displayPurchaseTagValue({ name, value })).toBe(expected);
});

test.each([
  ['delivery_mode', 'automatic', '自动发货'], ['delivery_format', 'credentials', '账密'],
  ['access', 'dedicated', '独享'], ['login_method', 'password', '密码登录'],
  ['login_method', 'email_code', '邮箱验证码登录'], ['login_method', 'sso', '单点登录'],
  ['renewable', '有', '可续费'], ['renewable', '无', '不可续费'],
  ['sms_required', '无', '无需接码'], ['sms_verification', 'unverified', '未接码'],
  ['kyc_required', '无', '无需实名'], ['kyc', 'unverified', '未认证'],
  ['single_use', '有', '一次性使用'], ['single_use', '无', '可多次使用'],
  ['2fa', '有', '含2FA'], ['card_binding_required', '无', '无需绑卡'],
  ['subscription_override', '无', '不覆盖订阅'], ['email_included', '无', '不含邮箱'],
  ['region', 'us', '美国'], ['region_options', 'us', '可选美国'],
  ['registration_region', 'us', '注册地美国'], ['payment_region', 'us', '支付地美国'],
  ['recommended_ip_region', 'global', '建议全球网络'],
  ['payment_platform', 'ios', 'iOS充值'], ['device_platform', 'ios', '支持iOS'],
  ['duration', '1 year', '1年'], ['duration_min', '1 year', '至少1年'],
  ['duration_max', '1 year', '最多1年'], ['duration_approx', '1 year', '约1年'],
  ['account_age', '1 year', '号龄1年'], ['token_validity_min', '3 months', '令牌至少3个月'],
  ['redemption_code_validity', 'permanent', '兑换码永久有效'],
  ['sms_receive_link_duration_range', '1-2 days', '接码链接有效期1-2天'],
  ['storage', '8 gb', '存储 8GB'], ['memory', '8 gb', '内存 8GB'],
  ['usage_count', '3', '可用3次'], ['usage_count_max', '3', '最多用3次'],
  ['shared_users', '3', '3人共享'], ['seats', '3', '3席位'],
  ['warranty_exclusion', 'ban', '不保封号'], ['warranty_trigger', 'first_login', '首登起保'],
  ['warranty_days', '30', '质保30天'], ['warranty_window', '24 hours', '保障窗口24小时'],
  ['warranty_detail', '1 month', '补充质保1个月'],
  ['balance', '10 usd', '余额10美元'], ['amount_daily', '10 usd', '每日10美元'],
  ['invoice', '无', '无发票'], ['official_bill', '有', '含官方账单'],
  ['sim_type', 'physical', '实体SIM卡'], ['card_type', 'physical', '实体卡'],
  ['usage_restriction', '禁止改密', '禁止改密'], ['model', 'Pro', '型号 Pro'],
])('keeps %s:%s concise without losing its meaning', (name, value, expected) => {
  expect(displayPurchaseTagText({ name, value })).toBe(expected);
});

test('all supported enum values keep meaningful labels, including negatives', () => {
  for (const [name, rule] of Object.entries(PRODUCT_TAG_RULES)) {
    for (const value of rule.values || []) {
      const text = displayPurchaseTagText({ name, value });
      expect(text, name).not.toMatch(/：|undefined|unknown/);
      expect(text, name).not.toMatch(/^(?:有|无|3)$/u);
    }
  }
  expect(displayPurchaseTagText({ name: 'custom_field', value: '自定义内容', label: '额外规格' })).toBe('额外规格 自定义内容');
});

import type { PurchaseTag } from './purchase-attributes.js';
import { isDurationValue } from './tag-value.js';

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

export interface TagRule { values?: readonly string[]; pattern?: string; multiple?: boolean; valueType?: 'duration' | 'text' }
export const PRODUCT_TAG_RULES: Record<string, TagRule> = {
  sms_verification: { values: ['verified', 'unverified'] },
  region: { values: [...Object.keys(REGION_ALIASES), 'eg', 'bd', 'it', 'es', 'pl', 'pt', 'se', 'no', 'fi', 'ch', 'at', 'be', 'ie', 'nz', 'ae', 'sa', 'il', 'kz', 'pe', 'ke', 'ee'], multiple: true },
  duration: { valueType: 'duration' },
  access_channel: { values: ['reverse_proxy', 'web', 'mirror', 'imap', 'pop3', 'graph', 'api'], multiple: true },
  supported_client: { valueType: 'text', multiple: true },
  subscription_override: { values: ['无'] },
  bulk_purchase: { values: ['supported', 'required', 'bundle'] },
  warranty: { valueType: 'text' },
};

/** Check comparable storage constraints only; tag meaning is decided by the reviewer. */
export function isCanonicalProductTag(tag: { name: string; value: unknown }): tag is PurchaseTag {
  const rule = Object.hasOwn(PRODUCT_TAG_RULES, tag.name) ? PRODUCT_TAG_RULES[tag.name] : undefined;
  if (!rule) return false;
  if (tag.name === 'duration') return isDurationValue(tag.value);
  if (typeof tag.value !== 'string' || !tag.value.trim() || tag.value !== tag.value.trim() || tag.value.length > 250) return false;
  if (rule.values && !rule.values.includes(tag.value)) return false;
  if (tag.name === 'supported_client' && (tag.value !== tag.value.toLowerCase() || tag.value.length > 80)) return false;
  return true;
}

/** Normalize current values only; retired tag names never map to a new dimension. */
export function normalizeProductTag(tag: PurchaseTag): PurchaseTag[] | undefined {
  if (!Object.hasOwn(PRODUCT_TAG_RULES, tag.name)) return undefined;
  let value = tag.value;
  if (typeof value === 'string') {
    value = (tag.name === 'warranty' ? value : value.normalize('NFKC')).replace(/\s+/gu, ' ').trim();
    if (tag.name === 'region') value = regions.get(value.toLowerCase()) ?? value.toLowerCase();
    if (tag.name === 'supported_client' || tag.name === 'access_channel') value = value.toLowerCase();
  }
  const normalized = { ...tag, value };
  return isCanonicalProductTag(normalized) ? [normalized] : undefined;
}

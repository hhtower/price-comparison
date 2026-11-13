import { normalizeProductTag } from './product-tag-policy.js';
import { durationToDays, formatDuration, tagValueKey, type TagValue } from './tag-value.js';
export { durationToDays, formatDuration, isDurationValue, tagValueKey, MAX_DURATION_DAYS } from './tag-value.js';
export type { DurationValue, TagValue } from './tag-value.js';

export interface PurchaseTag { name: string; value: TagValue; count?: number }
export interface ParsedCatalogSearch { text: string; tags: PurchaseTag[] }
export interface PurchaseAttributeDefinition { name: string; label: string; quick: boolean; values: Array<{ value: TagValue; label: string }> }
export const PURCHASE_ATTRIBUTE_DEFINITIONS: PurchaseAttributeDefinition[] = [
  { name: 'sms_verification', label: '接码状态', quick: true, values: [{ value: 'verified', label: '已接码' }, { value: 'unverified', label: '未接码' }] },
  { name: 'region', label: '地区', quick: true, values: [
    { value: 'us', label: '美区' }, { value: 'ph', label: '菲区' }, { value: 'jp', label: '日区' },
    { value: 'hk', label: '港区' }, { value: 'tw', label: '台区' }, { value: 'cn', label: '国区' },
    { value: 'tr', label: '土区' }, { value: 'gb', label: '英区' }, { value: 'ca', label: '加区' },
    { value: 'au', label: '澳区' }, { value: 'kr', label: '韩区' },
    { value: 'global', label: '全球' }, { value: 'random', label: '随机地区' }, { value: 'eu', label: '欧洲' }, { value: 'sea', label: '东南亚' },
  ] },
  { name: 'duration', label: '使用期限', quick: true, values: [7, 30, 90, 365].map(value => ({ value, label: formatDuration(value) })) },
  { name: 'access_channel', label: '使用入口', quick: true, values: [
    { value: 'web', label: '网页' }, { value: 'api', label: 'API' }, { value: 'reverse_proxy', label: '反向代理' },
    { value: 'mirror', label: '镜像站' }, { value: 'imap', label: 'IMAP' }, { value: 'pop3', label: 'POP3' }, { value: 'graph', label: 'Microsoft Graph' },
  ] },
  { name: 'supported_client', label: '支持工具', quick: true, values: [{ value: 'codex', label: 'Codex' }, { value: 'sub2api', label: 'Sub2API' }, { value: 'cpa', label: 'CPA' }] },
  { name: 'subscription_override', label: '覆盖现有订阅', quick: true, values: [{ value: '无', label: '不可覆盖订阅' }] },
  { name: 'bulk_purchase', label: '批量购买', quick: true, values: [
    { value: 'supported', label: '支持批量购买' }, { value: 'required', label: '需批量购买' }, { value: 'bundle', label: '打包出售' },
  ] },
  { name: 'warranty', label: '售后保障', quick: false, values: [] },
];

export function normalizePurchaseTag(tag: PurchaseTag): PurchaseTag[] {
  return normalizeProductTag(tag) ?? [];
}
const countries = new Intl.DisplayNames(['zh-CN'], { type: 'region', fallback: 'code' });
export function purchaseTagLabel(tag: PurchaseTag): string {
  const normalized = normalizePurchaseTag(tag)[0];
  if (!normalized) return '';
  if (normalized.name === 'duration') return formatDuration(normalized.value);
  const known = PURCHASE_ATTRIBUTE_DEFINITIONS.find(d => d.name === normalized.name)?.values
    .find(v => tagValueKey(v.value) === tagValueKey(normalized.value))?.label;
  if (known) return known;
  const value = String(normalized.value);
  if (normalized.name === 'region' && /^[a-z]{2}$/u.test(value)) return countries.of(value.toUpperCase()) ?? value;
  return value;
}
export function purchaseWarrantyLabel(tags: readonly PurchaseTag[]): string {
  const tag = tags.find(t => t.name === 'warranty');
  return tag ? purchaseTagLabel(tag) : '';
}

export function parseCatalogSearch(input: string): ParsedCatalogSearch {
  let text = input.normalize('NFKC').toLowerCase();
  const tags: PurchaseTag[] = [];
  const add = (tag: PurchaseTag) => {
    if (!tags.some(t => t.name === tag.name && tagValueKey(t.value) === tagValueKey(tag.value))) tags.push(tag);
  };
  const sms = (pattern: RegExp, value: string) => {
    text = text.replace(pattern, (match: string, offset: number, source: string) => {
      if (/(?:不要|不需要|无需|排除|不是|非|不想要)\s*$/u.test(source.slice(Math.max(0, offset - 12), offset))) return match;
      add({ name: 'sms_verification', value }); return ' ';
    });
  };
  sms(/未接码|未接马|sms\s+unverified|unverified\s+sms/gu, 'unverified');
  sms(/已接码|已接马|sms\s+verified|verified\s+sms/gu, 'verified');
  text = text.replace(/不可覆盖(?:现有)?订阅|不覆盖(?:现有)?订阅/gu, () => { add({ name: 'subscription_override', value: '无' }); return ' '; });
  // Do not convert operation deadlines, warranty windows or qualified periods into exact use terms.
  const period = /([0-9]+(?:[.][0-9]+)?)\s*(分钟|小时|个月|月|年|天|日|周|minutes?|hours?|days?|weeks?|months?|years?)/gu;
  text = text.replace(period, (match, amount: string, unit: string, offset: number, source: string) => {
    const before = source.slice(Math.max(0, offset - 16), offset);
    const after = source.slice(offset + match.length, offset + match.length + 16);
    if (/(?:质保|保障|保修|号龄|兑换|令牌|至少|最多|约|不少于|不超过|不要|不是|at least|at most|up to|about|approximately|>=|<=|[-~～至到])\s*$/u.test(before)
      || /^(?:\s*(?:内|后)?\s*(?:兑换|激活|反馈|质保|保修)|\s*(?:[-~～至到]|以上|以下|以内|左右|起))/u.test(after)) return match;
    try { add({ name: 'duration', value: durationToDays(Number(amount), unit) }); return ' '; }
    catch { return match; }
  });
  return { text: text.replace(/\s+/gu, ' ').trim(), tags };
}

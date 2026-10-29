export interface PurchaseTag {
  name: string;
  value: string;
  count?: number;
}

export interface ParsedCatalogSearch {
  text: string;
  tags: PurchaseTag[];
  warrantyDaysMin?: number;
}

export interface PurchaseAttributeDefinition {
  name: string;
  label: string;
  quick: boolean;
  values: Array<{ value: string; label: string }>;
}

const textValue = (value: unknown): string => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\t\r\n ]+/gu, ' ').trim();

/** Names are shared by the SQL read model and the browser parser. */
export const PURCHASE_NAME_ALIASES: Record<string, string> = {
  sms: 'sms_verification',
  sms_verification: 'sms_verification',
  '短信验证': 'sms_verification',
  '短信认证': 'sms_verification',
  接码: 'sms_verification',
  warranty: 'warranty',
  warranty_status: 'warranty',
  guarantee: 'warranty',
  保修: 'warranty',
  质保: 'warranty',
  保障: 'warranty',
  warranty_scope: 'warranty_scope',
  guarantee_scope: 'warranty_scope',
  '质保范围': 'warranty_scope',
  '保障范围': 'warranty_scope',
  warranty_days: 'warranty_days',
  guarantee_days: 'warranty_days',
  '质保天数': 'warranty_days',
  '保修天数': 'warranty_days',
  warranty_detail: 'warranty_detail',
  intended_use: 'intended_use',
  use: 'intended_use',
  usage: 'intended_use',
  '适用场景': 'intended_use',
  用途: 'intended_use',
  access: 'access',
  access_type: 'access',
  '访问方式': 'access',
  权限: 'access',
  delivery: 'delivery',
  delivery_method: 'delivery',
  delivery_type: 'delivery',
  '交付方式': 'delivery',
  duration: 'duration',
  subscription_duration: 'duration',
  term: 'duration',
  '订阅时长': 'duration',
  时长: 'duration',
  region: 'region',
  地区: 'region',
  国家: 'region',
  区域: 'region',
  country: 'region',
  account_region: 'region',
};

export const PURCHASE_ATTRIBUTE_DEFINITIONS: PurchaseAttributeDefinition[] = [
  {
    name: 'sms_verification', label: '接码状态', quick: true,
    values: [
      { value: 'verified', label: '已接码' },
      { value: 'unverified', label: '未接码' },
      { value: 'unknown', label: '接码未说明' },
    ],
  },
  {
    name: 'warranty', label: '售后保障', quick: true,
    values: [
      { value: 'covered', label: '有质保' },
      { value: 'none', label: '无质保' },
      { value: 'unknown', label: '质保未说明' },
    ],
  },
  {
    name: 'intended_use', label: '适用用途', quick: true,
    values: [{ value: 'rapid', label: '速刷' }],
  },
  {
    name: 'access', label: '使用方式', quick: true,
    values: [{ value: 'dedicated', label: '独享' }, { value: 'shared', label: '共享' }],
  },
  {
    name: 'delivery', label: '交付方式', quick: true,
    values: [
      { value: 'account', label: '成品账号' },
      { value: 'top_up', label: '代充' },
      { value: 'redemption', label: '兑换码' },
    ],
  },
  {
    name: 'duration', label: '订阅时长', quick: true,
    values: [{ value: '1 month', label: '1个月' }],
  },
  {
    name: 'delivery_mode', label: '发货方式', quick: true,
    values: [
      { value: 'automatic', label: '自动发货' },
      { value: 'manual', label: '手动发货' },
      { value: 'self_service', label: '自助提取' },
    ],
  },
  {
    name: 'region', label: '地区', quick: true,
    values: [
      { value: 'us', label: '美区' },
      { value: 'ph', label: '菲区' },
      { value: 'jp', label: '日区' },
      { value: 'hk', label: '港区' },
      { value: 'tw', label: '台区' },
      { value: 'tr', label: '土区' },
      { value: 'ar', label: '阿根廷' },
      { value: 'cl', label: '智利' },
      { value: 'in', label: '印度' },
      { value: 'global', label: '全球' },
      { value: 'random', label: '随机' },
    ],
  },
  {
    name: 'renewable', label: '可续费', quick: true,
    values: [{ value: '有', label: '可续费' }, { value: '无', label: '不可续费' }],
  },
  {
    name: 'account_lifecycle', label: '账号新旧', quick: true,
    values: [{ value: 'new', label: '新号' }, { value: 'aged', label: '老号' }],
  },
  {
    name: 'warranty_scope', label: '质保范围', quick: false,
    values: [{ value: 'first_login', label: '首登质保' }, { value: 'period', label: '按质保时长' }, { value: 'unspecified', label: '范围未说明' }],
  },
  {
    name: 'minimum_quantity', label: '最低起购', quick: false,
    values: [],
  },
  {
    name: '2fa', label: '2FA状态', quick: false,
    values: [{ value: '有', label: '含2FA' }, { value: '无', label: '无2FA' }],
  },
  {
    name: 'sms_required', label: '需要接码', quick: false,
    values: [{ value: '有', label: '需接码' }, { value: '无', label: '无需接码' }],
  },
  {
    name: 'kyc', label: 'KYC/赛博认证', quick: false,
    values: [{ value: 'verified', label: '已认证' }, { value: 'unverified', label: '未认证' }],
  },
  {
    name: 'kyc_required', label: '需要KYC', quick: false,
    values: [{ value: '有', label: '需KYC' }, { value: '无', label: '无需KYC' }],
  },
];

const aliases = (name: string): string => {
  const normalized = textValue(name);
  return PURCHASE_NAME_ALIASES[normalized.replace(/[ ]+/gu, '_')] ?? PURCHASE_NAME_ALIASES[normalized] ?? normalized;
};

const copyTag = (tag: PurchaseTag, name: string, value: string): PurchaseTag => {
  const result: PurchaseTag = { name, value };
  if (tag.count !== undefined) result.count = tag.count;
  return result;
};

const warrantyNumber = (value: string): number | undefined => {
  const normalized = textValue(value);
  const suffix = normalized.match(/^([0-9]+)[ \t]*(天|days?)([ \t]*(质保|保修|warranty))?$/iu);
  const prefix = normalized.match(/^(质保|保修|warranty)[ \t]*([0-9]+)[ \t]*(天|days?)$/iu);
  const days = Number(suffix?.[1] ?? prefix?.[2]);
  if (!suffix && !prefix) return undefined;
  return Number.isInteger(days) && days > 0 && days <= 36500 ? days : undefined;
};

const durationValue = (value: string): string | undefined => {
  const match = value.match(/^([0-9]+)[ \t]*(个月|月|months?|month)$/iu);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isInteger(amount) || amount <= 0) return undefined;
  return `${amount} month${amount === 1 ? '' : 's'}`;
};

/** Convert historical labels and explicit values into canonical facts. */
export function normalizePurchaseTag(input: PurchaseTag): PurchaseTag[] {
  const name = aliases(input.name);
  const value = textValue(input.value);
  const make = (canonicalName: string, canonicalValue: string): PurchaseTag => copyTag(input, canonicalName, canonicalValue);

  if (name === 'sms_verification') {
    if (/^(已接码|已接马|已验证|verified|verified sms|sms verified)$/iu.test(value)) return [make(name, 'verified')];
    if (/^(未接码|未接马|未验证|unverified|unverified sms|sms unverified)$/iu.test(value)) return [make(name, 'unverified')];
    if (/^(unknown|未知|未说明|接码未说明)$/iu.test(value)) return [make(name, 'unknown')];
  }
  if (name === 'warranty') {
    if (/\b(covered|none|unknown)\b[ \\t]+\b(covered|none|unknown)\b/iu.test(value)) return [make('warranty_detail', value)];
    const days = warrantyNumber(value);
    if (days !== undefined) {
      return [make('warranty', 'covered'), make('warranty_scope', 'period'), make('warranty_days', String(days))];
    }
    if (/^(质保首登|首登质保|首登保障|首登|first login|first login only|first login warranty|first-login warranty|[0-9]+[ \\t]+hour[ \\t]+first login)$/iu.test(value)) return [make('warranty', 'covered'), make('warranty_scope', 'first_login')];
    if (/^(1[ \\t]*month|质保订阅|subscription coverage|included)$/iu.test(value)) return [make('warranty', 'covered'), make('warranty_scope', 'period'), make('warranty_detail', value)];
    if (/^(有质保|有保修|covered|warranted|warranty|保修)$/iu.test(value)) return [make(name, 'covered')];
    if (/^(无质保|不质保|无保修|无售后|质保不来码|none|no warranty|without warranty|not warranted)$/iu.test(value)) return [make(name, 'none')];
    if (/^(unknown|未知|未说明|质保未说明)$/iu.test(value)) return [make(name, 'unknown')];
  }
  if (name === 'warranty_scope') {
    if (/^(首登|首登质保|质保首登|首登保障|first login|first login only|first_login)$/iu.test(value)) return [make(name, 'first_login')];
    if (/^(周期|期间|period|按天)$/iu.test(value)) return [make(name, 'period')];
    if (/^(unknown|未知|未说明|unspecified)$/iu.test(value)) return [make(name, 'unspecified')];
  }
  if (name === 'warranty_days') {
    const days = warrantyNumber(`${value} days`);
    if (days !== undefined) return [make(name, String(days))];
  }
  if (name === 'intended_use' && /^(速刷|日抛号?|rapid|rapid delivery)$/iu.test(value)) return [make(name, 'rapid')];
  if (name === 'access') {
    if (/^(独享|独用|dedicated|private)$/iu.test(value)) return [make(name, 'dedicated')];
    if (/^(共享|合租|shared|public)$/iu.test(value)) return [make(name, 'shared')];
  }
  if (name === 'delivery') {
    if (/^(成品账号|成品帐号|现成账号|独立账号|account|account ready|ready account)$/iu.test(value)) return [make(name, 'account')];
    if (/^(代充|代充值|充值|top[ -]?up|topup)$/iu.test(value)) return [make(name, 'top_up')];
    if (/^(兑换码|激活码|redemption|redemption code|redeem code)$/iu.test(value)) return [make(name, 'redemption')];
  }
  if (name === 'duration') {
    if (/^(monthly|月卡)$/iu.test(value)) return [make(name, '1 month')];
    const duration = durationValue(value);
    if (duration) return [make(name, duration)];
  }
  return [copyTag(input, name, value)];
}

export function purchaseTagLabel(tag: PurchaseTag): string {
  const normalized = normalizePurchaseTag(tag)[0] ?? tag;
  const definition = PURCHASE_ATTRIBUTE_DEFINITIONS.find((item) => item.name === normalized.name);
  const valueLabel = definition?.values.find((item) => item.value === normalized.value)?.label;
  if (valueLabel) return valueLabel;
  if (normalized.name === 'warranty_days' && /^[0-9]+$/u.test(normalized.value)) return `质保${normalized.value}天`;
  if (normalized.name === 'duration' && normalized.value.endsWith(' month')) return normalized.value.replace(' month', '个月');
  if (normalized.name === 'duration' && normalized.value.endsWith(' months')) return normalized.value.replace(' months', '个月');
  if (normalized.name === 'duration' && /^[0-9]+ days$/u.test(normalized.value)) return normalized.value.replace(' days', '天');
  if (normalized.name === 'warranty_scope' && normalized.value === 'subscription') return '仅保掉订阅';
  return normalized.value || normalized.name;
}

/** A coverage scope is a limit, not a replacement for its explicit time window. */
export function purchaseWarrantyLabel(tags: readonly PurchaseTag[]): string {
  const value = (name: string) => tags.find(tag => tag.name === name)?.value;
  if (value('warranty') === 'none') return '无质保';
  const scope = value('warranty_scope');
  const limited = scope === 'first_login' ? '仅保首登' : scope === 'activation' ? '仅保激活'
    : scope === 'first_code' ? '仅保首次接码' : '';
  const units: Record<string, string> = { minute: '分钟', hour: '小时', day: '天', week: '周', month: '个月', year: '年' };
  const window = value('warranty_window') ?? value('warranty_detail');
  const match = window && /^([0-9]+(?:\.[0-9]+)?) (minutes?|hours?|days|weeks?|months?|years?)$/u.exec(window);
  const time = match && Number(match[1]) > 0 ? match[1] + units[match[2].replace(/s$/u, '')] : '';
  const days = !limited && /^[1-9][0-9]*$/u.test(value('warranty_days') ?? '') ? value('warranty_days') + '天' : '';
  const term = time || days;
  const label = limited ? limited + (time ? `（${time}内）` : '')
    : term ? `质保${term}` : scope === 'subscription' ? '仅保掉订阅（时长未注明）'
    : scope === 'period' || value('warranty') === 'covered' ? '有质保（时长未注明）' : '';
  if (!label) return '';
  const limits = [!limited && term && scope === 'subscription' ? '仅保掉订阅' : '',
    ({ purchase: '购买起算', delivery: '交付起算', activation: '激活起算', first_login: '首登起算' } as Record<string, string>)[value('warranty_trigger') ?? ''] ?? '',
    tags.some(tag => tag.name === 'warranty_terms') ? '附售后条款' : '',
    tags.some(tag => tag.name === 'warranty_exclusion' && tag.value === 'ban') ? '不保封号' : ''].filter(Boolean);
  return label + (limits.length ? `（${limits.join('；')}）` : '');
}

const addTag = (tags: PurchaseTag[], tag: PurchaseTag): void => {
  if (!tags.some((item) => item.name === tag.name && item.value === tag.value)) tags.push(tag);
};

const cleanSearchText = (value: string): string => value
  .replace(/[\t\r\n ]+/gu, ' ')
  .replace(/^[,，、|;；:：]+/u, '')
  .replace(/[,，、|;；:：]+$/u, '')
  .trim();

/** Search synonyms are not separate stored attributes; negations stay literal. */
export function consumeRapidSearchTerms(input: string, onMatch: () => void = () => {}): string {
  // Mixed positive/negative or uncertain wording stays literal rather than guessing intent.
  if (/(?:不要|不需要|无需|不想要|不支持|不提供|不适合|禁止|不能|不是|非|是否|可能|或许|不确定)[ \t]*(?:是|为)?[ \t]*(?:速刷|日抛|rapid[ \t]+(?:delivery|refresh))|(?:速刷|日抛号?|rapid[ \t]+(?:delivery|refresh))[ \t]*(?:状态)?[ \t]*(?:不支持|不提供|不可用|不确定|未说明|未知|不保证)/iu.test(input)) return input;
  return input.replace(/速刷|日抛号?|rapid[ \t]+(?:delivery|refresh)/giu,
    () => { onMatch(); return ' '; });
}

export function parseCatalogSearch(input: string): ParsedCatalogSearch {
  let work = textValue(input);
  const tags: PurchaseTag[] = [];
  let warrantyDaysMin: number | undefined;
  const invalidWarranty: string[] = [];
  const protectInvalidWarranty = (value: string): string => {
    invalidWarranty.push(value);
    return `__p_i_${invalidWarranty.length - 1}__`;
  };

  const consume = (pattern: RegExp, callback: (match: string) => string | undefined): void => {
    work = work.replace(pattern, (match) => callback(match) ?? ' ');
  };
  const add = (name: string, value: string): void => addTag(tags, { name, value });

  consume(/未接码|未接马|unverified[ \\t]+sms|sms[ \\t]+unverified/giu, () => { add('sms_verification', 'unverified'); return undefined; });
  consume(/已接码|已接马|verified[ \\t]+sms|sms[ \\t]+verified/giu, () => { add('sms_verification', 'verified'); return undefined; });

  // Numeric warranty facts are consumed before generic warranty words.
  consume(/((质保|保修|warranty)[ \\t]*(至少|不少于|不低于|>=)?[ \\t]*([0-9]+)[ \\t]*(天|days?)|([0-9]+)[ \\t]*(天|days?)[ \\t]*(质保|保修|warranty))/giu, (match) => {
    const numberMatch = match.match(/[0-9]+/u);
    const days = numberMatch ? Number(numberMatch[0]) : 0;
    if (!Number.isInteger(days) || days <= 0 || days > 36500) return protectInvalidWarranty(match);
    add('warranty', 'covered');
    add('warranty_scope', 'period');
    add('warranty_days', String(days));
    warrantyDaysMin = warrantyDaysMin === undefined ? days : Math.max(warrantyDaysMin, days);
    return undefined;
  });
  consume(/((质保|保修|warranty)[ \\t]*([0-9]+)[ \\t]*(个月|月|months?|month)|([0-9]+)[ \\t]*(个月|月|months?|month)[ \\t]*(质保|保修|warranty))/giu, (match) => {
    const numberMatch = match.match(/[0-9]+/u);
    const amount = numberMatch ? Number(numberMatch[0]) : 0;
    if (!Number.isInteger(amount) || amount <= 0) return protectInvalidWarranty(match);
    add('warranty', 'covered');
    add('warranty_scope', 'period');
    add('warranty_detail', `${amount} month${amount === 1 ? '' : 's'}`);
    return undefined;
  });
  // Keep malformed numeric periods intact and prevent the generic warranty rule from consuming only its prefix.
  consume(/((质保|保修|warranty)[ \\t]*(至少|不少于|不低于|>=)?[ \\t]*([+-]?[0-9]+([ \\t]*-[ \\t]*[0-9]+)?)[ \\t]*(天|days?)|([+-]?[0-9]+([ \\t]*-[ \\t]*[0-9]+)?)[ \\t]*(天|days?)[ \\t]*(质保|保修|warranty))/giu, (match) => protectInvalidWarranty(match));
  consume(/质保首登|首登质保|首登保障|首登|[0-9]+[ \\t]+hour[ \\t]+first[ \\t]+login|first[ -]?login[ \\t]+only|first[ -]?login[ \\t]+warranty/giu, () => { add('warranty', 'covered'); add('warranty_scope', 'first_login'); return undefined; });
  consume(/无质保|不质保|没有质保|无保修|无售后|质保不来码|no[ \\t]+warranty|without[ \\t]+warranty|not[ \\t]+warranted/giu, () => { add('warranty', 'none'); return undefined; });
  consume(/质保未说明|保修未说明|warranty[ \\t]+unspecified/giu, () => { add('warranty', 'unknown'); return undefined; });
  consume(/有质保|有保修|covered warranty|warranted|warranty|保修|质保/giu, () => { add('warranty', 'covered'); return undefined; });

  consume(/独享|独用|dedicated[ \\t]+access|private[ \\t]+access|dedicated/giu, () => { add('access', 'dedicated'); return undefined; });
  consume(/共享|合租|shared[ \\t]+access|shared/giu, () => { add('access', 'shared'); return undefined; });
  consume(/成品账号|成品帐号|现成账号|ready[ \\t]+account|account[ \\t]+ready/giu, () => { add('delivery', 'account'); return undefined; });
  consume(/代充|充值|top[ -]?up|topup/giu, () => { add('delivery', 'top_up'); return undefined; });
  consume(/兑换码|激活码|redemption[ \\t]+code|redeem[ \\t]+code/giu, () => { add('delivery', 'redemption'); return undefined; });
  consume(/([0-9]+)[ \\t]*(个月|月|months?|month)/giu, (match) => {
    const duration = durationValue(match.replace(/ +/gu, ''));
    if (!duration) return match;
    add('duration', duration);
    return undefined;
  });
  work = consumeRapidSearchTerms(work, () => add('intended_use', 'rapid'));

  for (let index = 0; index < invalidWarranty.length; index += 1) work = work.replace(`__p_i_${index}__`, invalidWarranty[index]);

  const states = new Set(tags.filter((tag) => tag.name === 'warranty').map((tag) => tag.value));
  if (states.has('covered') && states.has('none')) {
    for (let index = tags.length - 1; index >= 0; index -= 1) {
      if (tags[index].name === 'warranty' || tags[index].name === 'warranty_scope' || tags[index].name === 'warranty_days') tags.splice(index, 1);
    }
    add('warranty', 'unknown');
    warrantyDaysMin = undefined;
  }

  return warrantyDaysMin === undefined
    ? { text: cleanSearchText(work), tags }
    : { text: cleanSearchText(work), tags, warrantyDaysMin };
}

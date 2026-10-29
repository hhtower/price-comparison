import { normalizeProductTag, PRODUCT_TAG_RULES } from '@price-comparison/catalog/product-tag-policy';
import type { PurchaseTag } from '@price-comparison/catalog/purchase-attributes';
import { canonicalizeMatchText } from '../standardization/fingerprint.js';
import { specificationParts } from '../products/product-spec.js';

const sentences = (text: string) => text.split(/[;；。!！?？\n]/u).map(value => value.trim()).filter(Boolean);
const uncertain = /部分|可能|不保证|约|左右|最高|最多|至少|以上|以下|建议|推荐|\b(?:maybe|optional|about|up to|at least|recommended)\b/u;
const negative = /禁止|请勿|不得|不带|不含|不提供|不支持|不代充|不充值|不质保|不保修|未开通|未开启|不能|不可|无需|没有|不包|无(?:邮箱密码|账号密码|json(?:文件|格式)?|token\b|质保|保修|售后|代充|充值)|非美|非日|\b(?:no|not|without|unsupported|disabled|unavailable)\b/iu;
const prerequisite = /自备|自行|自助修改|请.*修改|需.*(?:提供|准备)|前提|如果|仅限|若|\b(?:if|unless|your own|provided that)\b/u;
const openQualifier = new RegExp(`(?:${negative.source}|${prerequisite.source}|${uncertain.source}|需要|必须|要求|\\bmust\\b)$`, 'iu');
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const contains = (text: string, value: string) => new RegExp(`(?<![a-z0-9])${escape(value)}(?![a-z0-9])`, 'u').test(text);
const periods = /(?<![\d.])\d+(?:\.\d+)?\s*(?:分钟|小时|天|周|个月|月|年|minutes?|hours?|days?|weeks?|months?|years?)(?![a-z])/gu;
const number = String.raw`(?<![\d.\-])\d+(?:\.\d+)?\s*(?:k|w|万)?`;

function clauses(text: string): string[] {
  return specificationParts(text).flatMap(part => part.split(/[;；。!！?？,\n，]/u)).flatMap(clause => {
    const parts = clause.split('|').map(value => value.trim()).filter(Boolean);
    const scoped = parts.findIndex(value => {
      // A completed unavailable state closes its subject; a qualifier still governs the following list.
      const subject = value.replace(/^(.+?)(?:不可用|\s+(?:unavailable|disabled))$/u, '$1');
      return negative.test(subject) || uncertain.test(value) || prerequisite.test(value);
    });
    return scoped < 0 ? parts : [...parts.slice(0, scoped), parts.slice(scoped).join(' | ')];
  });
}

function normalized(name: string, value: string): PurchaseTag[] {
  return normalizeProductTag({ name, value }) ?? [];
}

/** Keep the original payload for audit; promoted offers are not current-item facts. */
export function currentProductTagEvidence(text: string, primaryText: string): string {
  let promoted = false;
  const topUp = tagEvidenceFacts({ name: 'delivery', value: 'top_up' }, canonicalizeMatchText(primaryText)).has('top_up');
  const heading = String.raw`(?:推荐|关联|其他|其它)(?:商品|产品)|另售|另购|(?:广告|推广)[:：]`;
  const linkedTopUp = String.raw`(?<![a-z0-9])(?:[a-z][a-z0-9 _-]{0,40})?(?:代充|充值)(?:链接|入口)`;
  const offer = topUp ? heading : `${heading}|${linkedTopUp}`;
  const startsOffer = new RegExp(`^(?:${offer})`, 'iu');
  // shortcut: promotion scope ends at an explicit current-item claim; refine with reviewed examples.
  return text.split(new RegExp(`(?<=[。!！?？;；\\n])|(?=${offer})`, 'iu')).map(part => {
    const claim = part.trim();
    if (/^(?:本|当前)(?:商品|产品|账号)|^实际(?:交付|出售|提供)/u.test(claim)) promoted = false;
    else if (startsOffer.test(claim)) promoted = true;
    return promoted ? '' : part;
  }).join('');
}

export function scopeEvidenceLines(text: string): string {
  let scope = '';
  let restrictionList = false;
  // shortcut: unclosed restriction lists remain scoped; refine boundaries with reviewed counterexamples.
  return text.split('\n').map(line => {
    const current = line.trim();
    if (!current) return line;
    if (restrictionList) return current.startsWith(scope) ? line : `${scope} ${line}`;
    const heading = /^([\p{L}\p{N} _-]{1,40})[:：]/u.exec(current)?.[0];
    const listIntro = /^(.*?)(?:以下|如下|下列)/u.exec(current)?.[1];
    if (heading) {
      scope = negative.test(heading) || uncertain.test(heading) || prerequisite.test(heading) ? heading : '';
      restrictionList = Boolean(scope);
    } else if (openQualifier.test(current)
      || (listIntro !== undefined && (negative.test(listIntro) || prerequisite.test(listIntro) || uncertain.test(listIntro)))) {
      scope = current; restrictionList = true;
    } else if (/^(?:如果|若|仅限|建议|推荐|if\b|unless\b)/u.test(current)) scope = current;
    else if (scope && !current.startsWith(scope)) return `${scope} ${line}`;
    return line;
  }).join('\n');
}

/** Extract only warranty assertions; import deadlines and subscription terms are not coverage. */
export function warrantyEvidenceFacts(text: string): PurchaseTag[] {
  if (/仅限自用|非人为|人为.*(?:不保|除外)|修改[^，。；]*不保|如果|若|条件|only if|unless/u.test(text)) return [];
  const facts: PurchaseTag[] = [];
  const add = (name: string, value: string) => facts.push({ name, value });
  const assertions = clauses(text).flatMap(clause => {
    if (uncertain.test(clause) || prerequisite.test(clause) || /人为|不改|必须|条件|only if/u.test(clause)) return [clause];
    // An explicit new coverage assertion ends an unrelated denial, but never drops governing conditions.
    return clause.split(/\|\s*(?=提供[^|]*(?:质保|保修|售后|warranty|guarantee))/u);
  });
  for (const clause of assertions) {
    const named = /^(warranty[a-z_]*)\s*:\s*(.+)$/u.exec(clause);
    if (named) {
      facts.push(...normalized(named[1]!, named[2]!));
      continue;
    }
    if (/封号不保|ban.*(?:not covered|excluded)/u.test(clause)) {
      add('warranty_exclusion', 'ban');
      continue;
    }
    if (!/质保|保修|售后|warranty|guarantee|掉订阅包赔|subscription coverage/u.test(clause)) continue;
    if (uncertain.test(clause) || prerequisite.test(clause) || /人为|不改|必须|条件|only if/u.test(clause)) continue;
    if (negative.test(clause)) {
      add('warranty', 'none');
      continue;
    }
    add('warranty', 'covered');
    const coverage = clause.replace(/首次登录(?:后|时|起)|from first login/gu, '');
    const scope = /首登|首次登[录陆]|first[- ]login/u.test(coverage) ? 'first_login'
      : /首码|首次来码|first code/u.test(coverage) ? 'first_code'
      : /仅.*激活|activation only/u.test(coverage) ? 'activation'
      : /掉订阅|订阅质保|质保订阅|subscription coverage/u.test(coverage) ? 'subscription' : undefined;
    const times = [...clause.matchAll(periods)].flatMap(match => normalized('warranty_window', match[0]));
    if (scope || times.length || /全程|全周期|周期质保|full[- ](?:period|coverage)/u.test(clause)) add('warranty_scope', scope ?? 'period');
    for (const time of times) {
      if (!scope && time.value.endsWith(' days')) add('warranty_days', time.value.split(' ')[0]!);
      else add('warranty_window', time.value);
      if (!scope && time.value === '1 month') add('warranty_detail', time.value);
    }
    for (const [trigger, pattern] of [
      ['purchase', /购买(?:后|时|起)|下单(?:后|起)|from purchase/u],
      ['delivery', /(?:交付|发货)(?:后|时|起)|from delivery/u],
      ['activation', /激活(?:后|时|起)|from activation/u],
      ['first_login', /首次登录(?:后|时|起)|from first login/u],
    ] as const) if (pattern.test(clause)) add('warranty_trigger', trigger);
  }
  return facts;
}

function regionFacts(tag: PurchaseTag, text: string): Set<string> {
  const name = tag.name;
  const facts = new Set<string>();
  for (const clause of clauses(text)) {
    if (negative.test(clause) || /部分|可能|不保证|\bmaybe\b/u.test(clause)) continue;
    const ip = /\bip\b|建议|推荐|recommended/u.test(clause);
    const registration = /注册|registration/u.test(clause);
    const payment = /支付|付款|payment/u.test(clause);
    if (name === 'recommended_ip_region' ? !ip : name === 'registration_region' ? !registration
      : name === 'payment_region' ? !payment : ip || registration || payment) continue;
    if (name !== 'region_options' && /或|\bor\b|可选/u.test(clause)) {
      if (/随机|random/u.test(clause)) facts.add('random');
      continue;
    }
    const clean = clause.replace(/(?:注册|支付|付款)(?:地区|国家|地)?|建议|推荐|使用|登录|账号|账户|可选|发货|交付|提供|地区|国家|\b(?:ip|region|registration|payment|recommended|use|account)\b/gu, ' ');
    for (const value of [clause, ...clean.split(/[:：/、|]|\bor\b|或/u), ...(clean.match(/[\p{Script=Han}]+/gu) ?? [])]) {
      for (const fact of normalized('region', value.trim())) if (fact.name === 'region') facts.add(fact.value);
    }
  }
  return facts;
}

const countUnits: Record<string, string> = {
  quantity: '个|份|accounts?|items?',
  minimum_quantity: '个|份|accounts?|items?',
  usage_count: '次|times|uses',
  usage_count_max: '次|times|uses',
  seats: '个?\\s*席位|人|seats?|users?',
  shared_users: '人|people|users?',
  multi_open: '开|instances?',
  credits: '积分|点数|点|credits?|points?',
  credits_daily: '积分|点数|点|credits?|points?',
  credits_monthly: '积分|点数|点|credits?|points?',
  binding_limit: '个|次|bindings?',
  included_sms_count: '条|次|messages?',
  reset_count: '次|resets?',
  followers: '粉丝|followers',
  cpu_cores: '核|cores?',
  token_count: 'tokens?',
  request_limit_hourly: '次|requests?',
  request_limit_daily: '次|requests?',
};
const countLabels: Record<string, RegExp> = {
  quantity: /数量|交付|发货|个账号|\bquantity\b/u,
  seats: /席位|seats?/u, shared_users: /共享|合租|shared|people|users?/u,
  binding_limit: /绑定|binding/u, included_sms_count: /短信|sms/u, reset_count: /重置|reset/u,
  credits_daily: /每日|每天|daily/u, credits_monthly: /每月|monthly/u,
  request_limit_hourly: /每小时|hourly/u, request_limit_daily: /每日|每天|daily/u,
};

function numericFacts(tag: PurchaseTag, text: string): Set<string> {
  const facts = new Set<string>();
  if (/或|\bor\b/u.test(text)) return facts;
  for (const clause of clauses(text)) {
    const qualified = tag.name === 'minimum_quantity' ? clause.replace(/至少|\bat least\b/gu, '')
      : tag.name === 'usage_count_max' ? clause.replace(/最多|最高|\b(?:up to|at most)\b/gu, '') : clause;
    if (negative.test(clause) || uncertain.test(qualified) || prerequisite.test(clause)
      || /库存|售价|价格|stock|price/u.test(clause) || /\d\s*[-~～至到]\s*\d/u.test(clause)) continue;
    if (/^(?:amount|balance)(?:_daily|_monthly)?$/u.test(tag.name)) {
      if (tag.name.startsWith('balance') && !/余额|balance/u.test(clause)) continue;
      if (tag.name.endsWith('_daily') && !/每日|每天|daily/u.test(clause)) continue;
      if (tag.name.endsWith('_monthly') && !/每月|monthly/u.test(clause)) continue;
      if (!tag.name.includes('_') && /每日|每天|每月|daily|monthly/u.test(clause)) continue;
      for (const match of clause.matchAll(/[$¥€£]\s*\d+(?:\.\d+)?|(?<![\d.])\d+(?:\.\d+)?\s*(?:美元|美金|刀|人民币|欧元|英镑|日元|港币|台币|元|usd|cny|eur|gbp|jpy|hkd|twd|dollars?)(?![a-z])/gu)) {
        for (const fact of normalized(tag.name.startsWith('balance') ? 'balance' : 'amount', match[0])) facts.add(fact.value);
      }
      continue;
    }
    const unit = countUnits[tag.name];
    if (unit) {
      const minimum = /起购|起拍|至少|最低购买数量|minimum/u.test(clause);
      if (tag.name === 'minimum_quantity' && /并非|不是|不要求/u.test(clause)) continue;
      if ((tag.name === 'minimum_quantity') !== minimum) continue;
      if (countLabels[tag.name] && !countLabels[tag.name]!.test(clause) && !contains(clause, tag.name)) continue;
      if (!/_daily|_monthly|_hourly/u.test(tag.name) && /每日|每天|每月|每小时|daily|monthly|hourly/u.test(clause)) continue;
      const matches = [...clause.matchAll(new RegExp(`${number}\\s*(?:${unit})(?![a-z])`, 'gu'))];
      if (contains(clause, tag.name) || (countLabels[tag.name]?.test(clause) && !matches.length)) {
        // A named scalar SKU value supplies the unit; prose still needs an explicit unit.
        const scalar = /[:： ](\d+(?:\.\d+)?)$/u.exec(clause);
        if (scalar) facts.add(String(Number(scalar[1])));
      }
      for (const match of matches) {
        const amount = /^(\d+(?:\.\d+)?)\s*(k|w|万)?/u.exec(match[0])!;
        facts.add(String(Number(amount[1]) * (amount[2] === 'k' ? 1000 : /^(?:w|万)$/u.test(amount[2] ?? '') ? 10000 : 1)));
      }
      continue;
    }
    if (['storage', 'memory', 'data_quota', 'bandwidth'].includes(tag.name)) {
      const label = ({ storage: /存储|容量|storage/u, memory: /内存|memory/u,
        data_quota: /流量|data_quota/u, bandwidth: /带宽|bandwidth/u } as Record<string, RegExp>)[tag.name]!;
      if (!label.test(clause)) continue;
      const unit = tag.name === 'bandwidth' ? 'mbps|gbps' : 'mb|gb|tb';
      for (const match of clause.matchAll(new RegExp(`${number}\\s*(?:${unit})(?![a-z])`, 'gu'))) {
        facts.add(match[0].replace(/\s+/gu, '').replace(/([0-9])([a-z])/u, '$1 $2'));
      }
    }
  }
  return facts;
}

/** Policy vocabulary is shared with ingestion; values alone do not prove numeric or scoped claims. */
export function tagEvidenceFacts(tag: PurchaseTag, text: string): Set<string> {
  // Canonical spec labels own their values; adjacent attributes cannot supply units or qualifiers.
  const attributes = specificationParts(text);
  if (attributes.length > 1) return new Set(attributes.flatMap(attribute => [...tagEvidenceFacts(tag, attribute)]));
  text = scopeEvidenceLines(text);
  if (tag.name === 'usage_restriction') return new Set(sentences(text).flatMap(sentence =>
    /必须|前提|条件/u.test(sentence) ? [sentence] : clauses(sentence))
    .filter(clause => !uncertain.test(clause) && /仅|只|禁止|请勿|不得|不支持|不能|不可|无法|必须|must not|only|prohibited|not supported/u.test(clause)
      && clause === canonicalizeMatchText(tag.value)).map(() => tag.value));
  if (tag.name === 'supported_client') return new Set(clauses(text)
    .filter(clause => !negative.test(clause) && !uncertain.test(clause) && !prerequisite.test(clause)
      && !/禁止|请勿|不得/u.test(clause) && /支持|可用|使用|导入|格式|compatible|supports?|use/u.test(clause) && contains(clause, tag.value))
    .map(() => tag.value));
  const named = /^(.+?)\s*[:：]\s*(.+)$/u.exec(text);
  if (named) {
    const namedName = named[1]!;
    const namedText = named[2]!;
    if (!negative.test(namedText) && !uncertain.test(namedText) && !prerequisite.test(namedText)) {
      const direct = normalizeProductTag({ name: namedName, value: namedText })
        ?.filter(fact => fact.name === tag.name).map(fact => fact.value) ?? [];
      if (direct.length) return new Set(direct);
    }
  }
  if (tag.name.startsWith('warranty')) return new Set(warrantyEvidenceFacts(text).filter(fact => fact.name === tag.name).map(fact => fact.value));
  if (/region/u.test(tag.name)) return regionFacts(tag, text);
  if (Object.hasOwn(countUnits, tag.name) || /^(?:amount|balance)(?:_daily|_monthly)?$/u.test(tag.name)
    || ['storage', 'memory', 'data_quota', 'bandwidth'].includes(tag.name)) return numericFacts(tag, text);
  const facts = new Set<string>();
  if (['renewable', 'renewal_timing'].includes(tag.name)) {
    for (const sentence of sentences(text)) {
      if (uncertain.test(sentence) || prerequisite.test(sentence)) continue;
      for (const value of [sentence, ...clauses(sentence)]) {
        for (const fact of normalized('renewable', value)) if (fact.name === tag.name) facts.add(fact.value);
      }
      const timing = /^(?:订阅)?到期后(?:才)?(?:可|可以|支持)?续费$/u.test(sentence) ? 'after_expiry'
        : /^随时(?:可|可以|支持)续费$/u.test(sentence) ? 'any_time' : undefined;
      if (timing) facts.add(tag.name === 'renewable' ? '有' : timing);
    }
    return facts;
  }
  const conditionalClauses = new Set(sentences(text).filter(sentence => /如果|若|\b(?:if|unless)\b/u.test(sentence)).flatMap(clauses));
  for (const clause of clauses(text)) {
    if (conditionalClauses.has(clause)) continue;
    if (tag.name === 'subscription_override') {
      if (uncertain.test(clause) || prerequisite.test(clause)) continue;
      for (const fact of normalized(tag.name, clause)) if (fact.name === tag.name) facts.add(fact.value);
      continue;
    }
    if (tag.name === 'registration_year' && !/注册|registration_year|registration year/u.test(clause)) continue;
    const requirement = ({ sms_required: /短信|接码|sms|手机号/u, kyc_required: /实名|kyc|cyber|赛博认证/u,
      vpn_required: /vpn/u, card_binding_required: /绑卡|绑定(?:银行|信用|支付)卡/u } as Record<string, RegExp>)[tag.name];
    if (requirement) {
      if (uncertain.test(clause) || /并非|不是/u.test(clause) || !requirement.test(clause)) continue;
      const absent = new RegExp(`(?:无需|不需要)\\s*(?:先|绑定|自行|完成)*(?:${requirement.source})|(?:${requirement.source})(?:\\s+verification)?\\s+(?:is\\s+)?not required`, 'gu');
      if (absent.test(clause)) facts.add('无');
      const required = new RegExp(`(?<![不无])(?:需要|需|必须|要)\\s*(?:先|绑定|自行|完成)*(?:${requirement.source})|(?:${requirement.source})(?:\\s+verification)?\\s+(?:is\\s+)?required`, 'u');
      if (required.test(clause.replace(absent, ' '))) facts.add('有');
      continue;
    }
    if (uncertain.test(clause) || negative.test(clause) || prerequisite.test(clause) || /或|\bor\b/u.test(clause)) continue;
    if (['login_method', 'account_type', 'token_validity', 'account_age'].includes(tag.name)
      && /并非|不是|不使用|不采用|不允许|尚未|未启用|未使用|未采用|关闭|禁用|停用|不出售|不销售|不售卖|未提供|未说明|非车位|非席位|赠送|比较|示例/u.test(clause)) continue;
    if (tag.name === 'login_method' && /(?:使用|采用)?密码登录/u.test(clause) && !/邮箱密码/u.test(clause)) facts.add('password');
    if (tag.name === 'account_type' && /车位|席位/u.test(clause)) facts.add('seat');
    const periodLabel = tag.name === 'token_validity' ? /(?:token|令牌)(?:有效期|有效期限|validity)[\s:：为是]*(.+)$/u
      : tag.name === 'account_age' ? /(?:账号)?(?:号龄|年龄)[\s:：为是]*(.+)$/u : undefined;
    const period = periodLabel?.exec(clause)?.[1];
    if (period) for (const fact of normalized('duration', period)) if (fact.name === 'duration') facts.add(fact.value);
    const rule = PRODUCT_TAG_RULES[tag.name];
    if (rule?.values?.includes('有')) continue;
    // ponytail: free text requires an exact bounded value; add reviewed synonyms only when needed.
    if (rule && !rule.pattern && !rule.values) {
      if (contains(clause, tag.value)) facts.add(tag.value);
      continue;
    }
    const candidates = [clause, ...(clause.match(/[a-z0-9]+(?:[-_.][a-z0-9]+)*|[\p{Script=Han}]+/gu) ?? []),
      ...(tag.name === 'email_provider' ? clause.match(/[\p{Script=Han}]+邮箱/gu) ?? [] : [])];
    const policyName = ({ delivery_mode: 'delivery', account_lifecycle: 'account_type',
      renewal_timing: 'renewable' } as Record<string, string>)[tag.name] ?? tag.name;
    for (const value of candidates) {
      for (const fact of normalized(policyName, value)) if (fact.name === tag.name) facts.add(fact.value);
      if (['delivery', 'delivery_format', 'access_channel', 'login_method', 'account_type'].includes(tag.name)) {
        for (const fact of normalized('access', value)) if (fact.name === tag.name) facts.add(fact.value);
      }
    }
    if (tag.name === 'access_channel' && /\bapi\b/u.test(clause)) facts.add('api');
    if (tag.name === 'device_platform' && /安卓/u.test(clause)) facts.add('android');
  }
  return facts;
}

export function tagCitationSupports(tag: PurchaseTag, quote: string, source: string): boolean {
  const includesQuote = (text: string) => canonicalizeMatchText(text).includes(quote);
  const citedClauses = clauses(scopeEvidenceLines(source).replace(/[:：][^\S\n]*\n\s*/gu, ': '));
  if (tag.name === 'access_channel' && !citedClauses.some(clause => includesQuote(clause)
    && tagEvidenceFacts(tag, clause).has(tag.value))) return false;
  if (['supported_client', 'usage_restriction'].includes(tag.name))
    return includesQuote(source) && quote.includes(canonicalizeMatchText(tag.value)) && tagEvidenceFacts(tag, source).has(tag.value);
  const quoted = tagEvidenceFacts(tag, quote).has(tag.value);
  const quoteName = /region/u.test(tag.name) ? 'region'
    : /^amount_/u.test(tag.name) ? 'amount' : /^credits_/u.test(tag.name) ? 'credits'
    : /^request_limit_/u.test(tag.name) ? 'usage_count' : tag.name;
  const carriesValue = quoted || normalized(quoteName, quote).some(fact => fact.value === tag.value)
    || (/^\d+(?:\.\d+)?$/u.test(quote) && quote === tag.value.split(' ')[0])
    || (tag.name.startsWith('warranty') && tagEvidenceFacts(tag, `${quote} 质保`).has(tag.value));
  return carriesValue && (quoted
    || citedClauses.some(clause => includesQuote(clause) && tagEvidenceFacts(tag, clause).has(tag.value)));
}

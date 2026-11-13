import { hasWarrantyCoverage, normalizeProductTag, PRODUCT_TAG_RULES } from '@price-comparison/catalog/product-tag-policy';
import { durationToDays, tagValueKey, type TagValue, type PurchaseTag } from '@price-comparison/catalog/purchase-attributes';
import { canonicalizeMatchText } from '../standardization/fingerprint.js';
import { specificationParts } from '../products/product-spec.js';

const sentences = (text: string) => text.split(/[;；。!！?？\n]/u).map(value => value.trim()).filter(Boolean);
const uncertain = /部分|可能|不保证|约|左右|最高|最多|至少|以上|以下|建议|推荐|\b(?:maybe|optional|about|up to|at least|recommended)\b/u;
const negative = /禁止|请勿|不得|不带|不含|不提供|不支持|不代充|不充值|不质保|不保修|未开通|未开启|不能|不可|无需|没有|不包|无(?:邮箱密码|账号密码|json(?:文件|格式)?|token\b|质保|保修|售后|代充|充值)|非美|非日|\b(?:no|not|without|unsupported|disabled|unavailable)\b/iu;
const prerequisite = /自备|自行|自助修改|请.*修改|需.*(?:提供|准备)|前提|如果|仅限|若|\b(?:if|unless|your own|provided that)\b/u;
const openQualifier = new RegExp(`(?:${negative.source}|${prerequisite.source}|${uncertain.source}|需要|必须|要求|\\bmust\\b)$`, 'iu');
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const contains = (text: string, value: string) => new RegExp(`(?<![a-z0-9])${escape(value)}(?![a-z0-9])`, 'u').test(text);
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
  const topUp = /代充|充值|top[- ]?up|recharge/iu.test(primaryText) && !negative.test(primaryText);
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

export const tagEvidenceValue = (value: TagValue): string => typeof value === 'string' ? value : tagValueKey(value);
const unit = String.raw`分钟|小时|天|日|周|星期|个月|月|年|minutes?|hours?|days?|weeks?|months?|years?`;
const amount = String.raw`\d+(?:\.\d+)?|一|二|两|三|半`;
const quantity = (value: string) => ({ 一: 1, 二: 2, 两: 2, 三: 3, 半: 0.5 } as Record<string, number>)[value] ?? Number(value);

function durationFacts(text: string): Set<string> {
  const facts = new Set<string>();
  for (const clause of clauses(text)) {
    if (/质保|保修|售后|首登|首次登[录陆]|首码|号龄|年龄|token|令牌|兑换|激活截止|兑换截止|导入截止|(?:分钟|小时|天)内(?:完成)?导入|有效代码|warranty|guarantee|redeem|account age|code validity/u.test(clause)
      || /不支持|没有|不含|未说明|建议|推荐|如果|若|或|\bor\b/u.test(clause)) continue;
    if (/永久|终身|\b(?:permanent|lifetime)\b/u.test(clause)) { facts.add(tagValueKey({ kind: 'permanent' })); continue; }
    const range = new RegExp(`(${amount})\\s*(${unit})?\\s*[-~～至到]\\s*(${amount})\\s*(${unit})(?![a-z])`, 'u').exec(clause);
    try {
      if (range) {
        const min = durationToDays(quantity(range[1]!), range[2] ?? range[4]!);
        const max = durationToDays(quantity(range[3]!), range[4]!);
        if (min < max) facts.add(tagValueKey({ kind: 'range', min, max }));
        continue;
      }
      const matches = [...clause.matchAll(new RegExp(`(?<![\\d.\\-])(${amount})\\s*(${unit})(?![a-z])`, 'gu'))];
      if (!matches.length) {
        if (/月卡|包月|\bmonthly\b/u.test(clause)) facts.add('30');
        if (/季卡|季度|\bquarterly\b/u.test(clause)) facts.add('90');
        if (/年卡|包年|\b(?:annual|yearly)\b/u.test(clause)) facts.add('365');
      }
      for (const match of matches) {
        const days = durationToDays(quantity(match[1]!), match[2]!);
        const kind = /至少|以上|不低于|\bat least\b/u.test(clause) ? 'min'
          : /最多|最高|以内|以下|不超过|\b(?:up to|at most)\b/u.test(clause) ? 'max'
          : /约|左右|大概|\b(?:about|approx(?:imately)?)\b/u.test(clause) ? 'approx' : undefined;
        facts.add(tagValueKey(kind ? { kind, days } : days));
      }
    } catch { /* An out-of-range period cannot support a duration tag. */ }
  }
  return facts;
}

const coverage = /质保|保修|售后|保订阅|订阅.*保|仅保|首登|首码|包赔|包换|包退|warranty|guarantee|coverage/u;
const warrantyCondition = /不保|不赔|不退|不换|除外|仅限|非人为|人为|修改|需[^。；\n]*(?:提供|提交|准备)|凭|必须|务必|前提|条件|退款|退换|补发|赔付|封号|失效|联系客服|购买后|发货后|激活后|from purchase|excluded|unless|only if/u;
// Select whole statements so unfamiliar clauses before or after the promise cannot disappear.
const warrantyStatements = (text: string) => sentences(text)
  .map(sentence => sentence.replace(/^(?:本|当前)(?:商品|产品|账号)/u, '').trim())
  .filter(sentence => coverage.test(sentence) || warrantyCondition.test(sentence));

/** Preserve the whole promise, including qualifiers elsewhere in its current-item source. */
function warrantySupported(value: string, text: string): boolean {
  const wanted = canonicalizeMatchText(value);
  const parts = warrantyStatements(text);
  return hasWarrantyCoverage(wanted) && hasWarrantyCoverage(text)
    && !/无条件|所有问题|任何问题|unconditional|all (?:issues|problems)/u.test(wanted)
    && parts.length > 0 && parts.every(part => wanted.includes(part))
    && text.replace(/\s/gu, '').includes(wanted.replace(/\s/gu, ''));
}

/** Current vocabulary only; unsupported/ambiguous source claims yield no facts. */
export function tagEvidenceFacts(tag: PurchaseTag, text: string): Set<string> {
  text = scopeEvidenceLines(text.split('\n').map(canonicalizeMatchText).join('\n'))
    .replace(/(支持|接入方式[:：]|访问方式[:：])\s*\n/gu, '$1 ');
  if (tag.name === 'duration') return durationFacts(text);
  if (typeof tag.value !== 'string' || !Object.hasOwn(PRODUCT_TAG_RULES, tag.name)) return new Set();
  const value = tag.value;
  if (tag.name === 'warranty') return new Set(warrantySupported(value, text) ? [value] : []);
  const facts = new Set<string>();
  for (const clause of clauses(text)) {
    if (/部分|可能|不保证|建议|推荐|如果|若|前提|仅限|才能|才可|\b(?:maybe|recommended|if|unless)\b/u.test(clause)) continue;
    if (tag.name === 'sms_verification') {
      if (/需要|必须|要求|需.*提供|买家|用户|无需|不需要|并非|不是|没有/u.test(clause)) continue;
      if (/未接码|未接马|未完成短信验证|尚未完成短信验证|\bunverified\b/u.test(clause)) facts.add('unverified');
      else if (/已接码|已接马|已完成短信验证|\bverified\b/u.test(clause)) facts.add('verified');
      continue;
    }
    if (tag.name === 'subscription_override') {
      if (/(?:不可|不能|无法|不支持|不允许)覆盖(?:现有|已有)?订阅|cannot (?:cover|override) (?:existing )?subscription/u.test(clause)) facts.add('无');
      continue;
    }
    if (negative.test(clause) || /未提供|未说明|不要求|不是|并非|赠送|比较|示例/u.test(clause)) continue;
    if (tag.name === 'region') {
      if (/建议|推荐|需|必须|要求|注册|\bor\b|或|可选/u.test(clause)) continue;
      const clean = clause.replace(/(?:本|当前)?(?:商品|产品)|(?:付款|支付)(?:地区|国家)(?:为|是)?|代充|充值|地区|国家|账号|账户|住宅|静态|动态|独享|交付|提供|\b(?:ip|region|account|product)\b/gu, ' ');
      for (const candidate of [clause, ...clean.split(/[\s:：/、|,，]+/u), ...(clean.match(/[\p{Script=Han}]+/gu) ?? [])]) {
        for (const fact of normalized('region', candidate.trim())) if (typeof fact.value === 'string') facts.add(fact.value);
      }
    } else if (tag.name === 'bulk_purchase') {
      if (/支持批量|可批量|批量下单|bulk (?:ordering|purchase)|supports? bulk/u.test(clause)) facts.add('supported');
      const minimum = /(\d+)\s*(?:件|个|份|账号)\s*起(?:购|拍)|(?:最低购买数量|至少购买|minimum(?: order)?)\s*[:：]?\s*(\d+)/u.exec(clause);
      if (minimum && Number(minimum[1] ?? minimum[2]) > 1) facts.add('required');
      const pack = /(\d+)\s*(?:个账号|个|件|份)\s*(?:一包|一组|一套|打包)|(?:pack of|bundle of)\s*(\d+)/u.exec(clause);
      if (pack && Number(pack[1] ?? pack[2]) > 1) facts.add('bundle');
    } else if (tag.name === 'supported_client') {
      if (/支持|可用|使用|导入|compatible|supports?|use/u.test(clause) && contains(clause, value)) facts.add(value);
    } else if (tag.name === 'access_channel') {
      for (const [channel, pattern] of [
        ['web', /网页|浏览器|\bweb\b/u], ['reverse_proxy', /反代|reverse proxy/u], ['mirror', /镜像|\bmirror\b/u],
        ['imap', /\bimap\b/u], ['pop3', /\bpop3\b/u], ['graph', /\bgraph\b/u], ['api', /\bapi\b/u],
      ] as const) if (pattern.test(clause)) facts.add(channel);
    }
  }
  return facts;
}

export function tagCitationSupports(tag: PurchaseTag, quote: string, source: string): boolean {
  const wanted = tagEvidenceValue(tag.value);
  if (tag.name === 'warranty') return tagEvidenceFacts(tag, quote).has(wanted) && tagEvidenceFacts(tag, source).has(wanted);
  // A clipped positive keyword cannot escape its containing negative/qualified clause.
  const contexts = clauses(scopeEvidenceLines(source).replace(/(支持|接入方式[:：]|访问方式[:：])\s*\n/gu, '$1 '));
  const compact = (text: string) => canonicalizeMatchText(text).replace(/\s/gu, '');
  const claim = compact(quote.replace(/[;；。!！?？\s]+$/gu, ''));
  const quoted = tagEvidenceFacts(tag, quote).has(wanted);
  return contexts.some(clause => (compact(clause).includes(claim) || claim.includes(compact(clause))) && tagEvidenceFacts(tag, clause).has(wanted)
    && (quoted || typeof tag.value === 'string' && quote.includes(tag.value)));
}

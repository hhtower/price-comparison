import { visibleEvidenceText } from './evidence-text.js';
import { specificationParts } from '../products/product-spec.js';

type FieldText = { path: string; text: string };
type Assertion = FieldText & { field: string; scope: string; value: string };
const ignoredKeys = new Set(['category', 'sourcecategory', 'model', 'models', 'supportedmodels', 'availablemodels',
  'instructions', 'usageinstructions', 'tutorial', 'tutorials', 'user', 'seller', 'merchant', 'shop', 'store', 'serviceevidence',
  'ratingtext', 'ratingunitid']);
const keyName = (key: string) => key.normalize('NFKC').replace(/[\s_-]+/gu, '').toLowerCase();
const smsStatus = /(?:已|未)(?:接[码马]|(?:通过)?(?:手机|短信)验证)/gu;
const term = /月卡|年卡|季卡/gu;
const accountAge = /新号|老号/u;
const actualDelivery = /实际(?:仅|只)?(?:交付|提供|出售)|(?:只|仅)(?:交付|提供|出售)/u;
const uncertain = /可能|或许|不确定|不保证|不担保|以.*为准/u;
// Quoted clauses let an admin locate the contradiction without rereading the whole listing.
const quote = (text: string) => text.length > 60 ? `${text.slice(0, 60)}…` : text;
const menu = /可选|任选|或者|或|(?:rt|refresh[_ -]*token)\s*[/／]\s*账密|账密\s*[/／]\s*(?:rt|refresh[_ -]*token)/u;
const plan = /(?<![a-z])(?:free|go|plus|pro|max|ultra|team|business)(?![a-z])/gu;

function currentOfferText(text: string, currentPlan: string): string {
  let siblingList = false;
  let advertisedPlan = '';
  // Resolve navigation scope before commas detach warranty/SMS claims from its label.
  return text.split('\n').filter(line => {
    if (!line.trim()) return true;
    if (actualDelivery.test(line) || /(?:本|此|这个)(?:商品|产品|链接)|(?:当前|目前)(?:的)?(?:商品|产品|链接|套餐|账号|账户)|(?:商品|产品)内容|^(?:交付|发货)/u.test(line.trim())) {
      siblingList = false; advertisedPlan = ''; return true;
    }
    // Separate sentences may resume current-SKU promises without repeating its plan.
    if (/[。;；]/u.test(line)) { siblingList = false; advertisedPlan = ''; return true; }
    if (/^\s*其他[^。;；]*?(?:商品|产品|成品号|账号)\s*[:：]\s*$/u.test(line)) {
      siblingList = true; advertisedPlan = ''; return false;
    }
    if (siblingList && /(?:→|->)\s*(?:https?:\/\/\S*)?\s*$/u.test(line)) return false;
    siblingList = false;
    const linePlans = new Set([...line.matchAll(plan)].map(match => match[0]));
    const linkedPlan = line.match(/(?<![a-z])(free|go|plus|pro|max|ultra|team|business)\s*代充链接/u)?.[1];
    if (currentPlan && linkedPlan && linkedPlan !== currentPlan && linePlans.size === 1) {
      advertisedPlan = linkedPlan; return true;
    }
    const advert = advertisedPlan && linePlans.size === 1 && linePlans.has(advertisedPlan)
      && /(?:可以|可)?\s*(?:qq|微信)?\s*联系|联系(?:客服|qq|微信)/u.test(line);
    advertisedPlan = '';
    return !advert;
  }).join('\n');
}

function fieldTexts(evidence: Record<string, unknown>, format: 'raw' | 'text'): FieldText[] {
  const fields: FieldText[] = [];
  const seen = new WeakSet<object>();
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      const text = (format === 'raw' ? visibleEvidenceText(value) : value).normalize('NFKC').toLowerCase();
      for (const part of path === 'spec' ? specificationParts(text) : [text]) fields.push({ path, text: part });
    } else if (value && typeof value === 'object' && !seen.has(value)) {
      seen.add(value);
      for (const [key, item] of Object.entries(value)) {
        if (!ignoredKeys.has(keyName(key))) walk(item, path ? `${path}.${key}` : key);
      }
      seen.delete(value);
    }
  };
  walk(evidence, '');
  return fields;
}

/** Only contradictory, explicit promises for the same delivered SKU block publication. */
export function publicationEvidenceConflict(evidence: Record<string, unknown>, format: 'raw' | 'text' = 'raw'): string | null {
  const fields = fieldTexts(evidence, format);
  const selected = fields.filter(({ path }) => path === 'spec');
  const selectedPlans = new Set(selected.flatMap(({ text }) => [...text.matchAll(plan)].map(match => match[0])));
  const titlePlans = new Set(fields.filter(({ path }) => path === 'name').flatMap(({ text }) => [...text.matchAll(plan)].map(match => match[0])));
  const currentPlan = selectedPlans.size === 1 ? [...selectedPlans][0]! : titlePlans.size === 1 ? [...titlePlans][0]! : '';
  const selectedTerms = new Set(selected.flatMap(({ text }) => text.match(term) ?? []));
  const titleTerms = new Set(fields.filter(({ path }) => path === 'name').flatMap(({ text }) => text.match(term) ?? []));
  const defaultTerm = selectedTerms.size === 1 ? [...selectedTerms][0]! : titleTerms.size === 1 ? [...titleTerms][0]! : '';
  const assertions: Assertion[] = [];
  const add = (field: string, scope: string, value: string, claim: FieldText): void => {
    assertions.push({ field, scope, value, ...claim });
  };

  for (const field of fields) {
    // Do not let a usage note erase an independent actual-delivery statement.
    const clauses = currentOfferText(field.text, currentPlan).replace(/(?=实际(?:仅|只)?(?:交付|提供|出售))/gu, '\n')
      .replace(/(e-?mail|邮箱|账号|账户|帐号|帐户)\s*\|\s*(?=password|密码)/giu, '$1-')
      .replace(/(rt|refresh[_ -]*token|账密|帐密)\s*\|\s*(?=rt|refresh[_ -]*token|账密|帐密)/giu, '$1/')
      .split(/[\n。;；|]|[,，](?!\s*(?:不提供|不带|不含|不随货|不会提供))/u);
    for (const text of clauses) {
      // Pointers to sibling listings and comparisons describe another SKU, not this one.
      if (!text.trim() || uncertain.test(text) || /其他(?:商品|产品)|另(?:一款|购)|例如|比如|下单本店|本店还有|店铺还有|去下单|可以下单|下[面方]链接|是同一?类产品|(?:可以|建议|推荐)拍|(?:→|->)\s*https?:/u.test(text)) continue;
      const explicit = actualDelivery.test(text);
      const smsMenu = /[/／]/u.test(text) && new Set([...text.matchAll(smsStatus)].map(match => match[0][0])).size > 1;
      if (!explicit && (menu.test(text) || smsMenu || /教程|自行|自备|(?:首次登录|登录时).*需.*(?:接[码马]|验证)/u.test(text))) continue;
      const claim = { path: field.path, text: text.trim() };
      const scope = `${text.match(term)?.[0] ?? defaultTerm}:${text.match(accountAge)?.[0] ?? ''}`;

      // Durations must be attached to a warranty, not to importing or logging in.
      // In "邮箱20天质保3天", the forward warranty duration owns the warranty marker.
      const duration = /(?:(?:质保|保障)\s*(?:时限|时间|期)?\s*(?:为|[:：])?\s*(?:下单(?:之?后)?\s*)?(\d+(?:\.\d+)?)\s*(小时|分钟|天|hours?|minutes?|days?|h|m|d)\s*(?:内\s*)?(?:首登|首次登录|第一次登录|炸车|封号)?|(\d+(?:\.\d+)?)\s*(小时|分钟|天|hours?|minutes?|days?|h|m|d)\s*(?:内\s*)?(?:首登|首次登录|第一次登录|炸车|封号)?\s*(?:质保|保障)(?!\s*(?:时限|时间|期)?\s*(?:为|[:：])?\s*(?:下单(?:之?后)?\s*)?\d+(?:\.\d+)?\s*(?:小时|分钟|天|hours?|minutes?|days?|h|m|d)))/gu;
      // A list marker such as "3.30 天质保" is item 3, not 3.3 days.
      // Only a single-digit marker before a 2+ digit amount, so "1.5天" stays 1.5 days.
      const durationText = text.replace(/(?:质保|保障)天数\s*[:：]\s*(\d+(?:\.\d+)?)(?=\s|$)/gu, '质保$1天').replace(/^(\s*)[1-9][.、](?=\d{2,}\s*(?:小时|分钟|天))/u, '$1')
        // A warranty range guarantees its lower bound, not its upper end.
        .replace(/(\d+(?:\.\d+)?)\s*[-~～至到\u2013\u2014]\s*(\d+(?:\.\d+)?)\s*(小时|分钟|天|hours?|minutes?|days?|h|m|d)/gu,
          (range, lower: string, upper: string, unit: string) => Number(lower) <= Number(upper) ? `${lower}${unit}` : range);
      for (const match of durationText.matchAll(duration)) {
        const amount = Number(match[1] ?? match[3]);
        const unit = match[2] ?? match[4]!;
        const local = durationText.slice(Math.max(0, match.index! - 8), match.index! + match[0].length);
        if (/不(?:提供|含|带)?(?:质保|保障)|无(?:质保|保障)/u.test(local)) continue;
        const warrantyScope = /首登|首次登录|第一次登录/u.test(local) ? 'first_login'
          : /炸车/u.test(local) ? 'crash' : /封号/u.test(local) ? 'ban' : 'general';
        const minutes = amount * (/^(?:天|d)/u.test(unit) ? 1440 : /^(?:小时|h)/u.test(unit) ? 60 : 1);
        add('warranty', `${scope}:${warrantyScope}`, `${minutes} minutes`, claim);
      }

      // Mailbox passwords are a separate delivery object from account credentials.
      const passwordSetup = !explicit && /(?:登录|登陆)(?:成功)?后.*(?:如果|如若|假如|若).*?(?:没有|未设置|未设定)/u.test(text)
        && /(?:设置|重置|修改).*密码/u.test(text);
      const accountText = text.replace(/(?:gmail|邮箱|邮件)\s*(?:账号|账户)?\s*(?:账密|帐密|密码)/giu, '');
      let credentials = false;
      for (const match of accountText.matchAll(/账密|帐密|(?:账号|账户|帐号|帐户)\s*(?:和|及|[\/、+＋|｜,:：-]+)?\s*密码|(?:e-?mail|邮箱)\s*[|｜\/、+＋,:：-]+\s*(?:password|密码)/giu)) {
        const prefix = accountText.slice(Math.max(0, match.index! - 24), match.index);
        const suffix = accountText.slice(match.index! + match[0].length, match.index! + match[0].length + 48);
        const prefixContext = prefix.replace(/[\s:：，,、;；/／|｜()[\]【】-]+$/u, '');
        const suffixContext = suffix.replace(/^[\s:：，,、;；/／|｜()[\]【】-]+/u, '');
        const missingBeforeSetup = passwordSetup && /(?:如果|如若|假如|若)(?:您|你)?(?:还)?(?:没有|未设置|未设定)\s*$/u.test(prefixContext)
          && /^(?:请|可|需|则|就|应|的话)[^()（）]*?(?:设置|重置|修改)[^()（）]*?密码/u.test(suffixContext);
        const settingAsInstruction = passwordSetup
          && /(?:请(?:您|你)?|可(?:以)?|需(?:要)?|应(?:该)?|建议|务必)(?:马上|立即|先|自行|自己|及时)*(?:设置|重置|修改)\s*$/u.test(prefixContext)
          && !/随货|发货|交付/u.test(prefixContext + suffixContext);
        if (missingBeforeSetup || settingAsInstruction) continue;
        const denied = /(?:不(?:提供|带|含|包含|包括|发送|发|交付)?|无|没有|不会(?:提供|发|发送|交付))\s*(?:(?:chatgpt|codex|claude|gemini|grok)\s*)?$/iu.test(prefixContext)
          || /^(?:不(?:提供|带|含|包含|包括|发送|发|交付)|不会(?:提供|发|发送|交付)|不随货)/iu.test(suffixContext);
        // Usage restrictions and format comparisons do not promise credential delivery.
        if (!denied && !explicit && (/(?:无需(?:提供|使用)?|不用|不需要|不能(?:用|使用)?|无法(?:用|使用)?|不可(?:用|使用)?|不是|而非|如需|请(?:输入|使用|修改))\s*$/u.test(prefixContext)
          || /^(?:仅?用于(?:教程|说明|示例)|仅?作(?:教程|说明|示例)|格式(?:说明|示例)|(?:不是|而非)(?:交付|本商品|本次)|为格式说明)/u.test(suffixContext))) continue;
        add('credentials', scope, denied ? 'absent' : 'provided', claim);
        if (!denied) credentials = true;
      }
      if (!credentials && /(?:只|仅)(?:有|提供|交付|发货)?\s*(?:rt|refresh[_ -]*token)(?![a-z])/u.test(accountText))
        add('credentials', scope, 'absent', claim);

      for (const match of text.matchAll(smsStatus)) {
        const prefix = text.slice(Math.max(0, match.index! - 8), match.index);
        if (/不(?:保证|担保|是)|无需|不用/u.test(prefix)) continue;
        add('sms_verification', scope, match[0].startsWith('已') ? 'verified' : 'unverified', claim);
      }
      if (/到期(?:之?后)?(?:才|才能|方可)(?:可(?:以)?)?续费|仅(?:限|支持)到期(?:之?后)?续费/u.test(text))
        add('renewal', scope, 'only_after_expiry', claim);
      if (/(?<!不)(?:支持|可(?:以)?|允许)提前续费/u.test(text))
        add('renewal', scope, 'early_renewal', claim);
    }
  }
  // A title listing several values for one attribute is a menu, so it promises none of them.
  const titleValues = new Map<string, Set<string>>();
  for (const { path, field, scope, value } of assertions) if (path === 'name')
    titleValues.set(`${field}:${scope}`, (titleValues.get(`${field}:${scope}`) ?? new Set()).add(value));
  const first = new Map<string, Assertion>();
  for (const assertion of assertions) {
    if (assertion.path === 'name' && titleValues.get(`${assertion.field}:${assertion.scope}`)!.size > 1) continue;
    const key = `${assertion.field}:${assertion.scope}`;
    const previous = first.get(key);
    if (previous && previous.value !== assertion.value)
      return `${assertion.field} conflict (${assertion.scope}): ${previous.path} declares ${previous.value}, but ${assertion.path} declares ${assertion.value}`
        + `；「${quote(previous.text)}」 vs 「${quote(assertion.text)}」`;
    first.set(key, assertion);
  }
  return null;
}

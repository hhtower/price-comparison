/** Sale assertions and selected SKU values are distinct from usage instructions,
 * after-sales terms, comparison tables and possible future upgrades. Raw evidence
 * stays intact in the payload; this view is used only by deterministic guards. */
import { visibleEvidenceText } from './evidence-text.js';

const auxiliaryKeys = new Set(['id', 'category', 'sourcecategory', 'model', 'models', 'availablemodels', 'supportedmodels',
  'instructions', 'usageinstructions', 'tutorial', 'tutorials', 'warranty', 'aftersales', 'support',
  'user', 'seller', 'merchant', 'shop', 'store', 'serviceevidence']);
const keyName = (key: string) => key.normalize('NFKC').replace(/[\s_-]+/gu, '').toLowerCase();
const plan = /(?<![a-z])(?:free|go|plus|premium|super|pro|max|ultra|team|business)(?![a-z])/giu;
const platformPatterns = [/(?<![a-z])(?:chat\s*gpt|open\s*ai|codex)(?![a-z])/giu, /(?<![a-z])(?:claude|anthropic)(?![a-z])/giu,
  /(?<![a-z])(?:google|gemini)(?![a-z])|谷歌/giu];
const platformsIn = (value: string) => platformPatterns.filter(pattern => [...value.matchAll(pattern)].length);
const descriptionKeys = new Set(['evidence', 'description', 'descriptions', 'detail', 'details', 'intro']);
const explicitSale = /实际(?:仅|只)?(?:交付|出售|提供|售)|(?:只|仅)售(?!后)|(?:本|此)(?:商品|产品)(?:为|是)|(?:商品|产品)内容\s*[:：]|(?:成品|商品|产品)(?:拆成|拆分为|分为)|^(?:交付|出售|提供|发货)/u;
const accountClaim = /(?<![a-z])(?:(?:chat\s*gpt|open\s*ai|codex|claude|gemini|grok)[\s_-]*)?(?:free|go|plus|pro|max|ultra|team|business|super|heavy)(?![a-z])[^,，。;；\n]*(?:账号|账户|成品|订阅|会员|席位)/iu;
const ancillaryClause = /教程|教学|请勿|勿下|禁止|不能充|无法升级|充值要求|账号限制|账号现有|如果|如若|若显示|首次登录|第一次登录|不保证|不担保|售后|质保|使用规范|使用说明|推荐|建议|浏览器|网络|支付渠道|登录方式|登录方法|验证码|进阶操作|(?:^|[^a-z])ip(?:[^a-z]|$)|(?:同样|也)(?:可能|会).*(?:波动|不稳定)|(?:必须|需要).*免费版|账号必须|原\s*(?:plus|pro|team).*订阅|加入\s*team.*(?:退出|切换)|不是.*(?:账号|套餐)|(?:额度|用量).*是.*(?:额度|用量)|额外购买|升级需要|(?:与|和).*(?:并存|共存)|不想升级|如介意.*(?:去买|购买)/iu;
const prerequisiteOrComparison = /(?:账号|账户)(?:目前没有|需为|现有|必须)|(?:仅限|只限)(?:当前|目前)?没有|只能充值|不能充|无法升级|原\s*(?:plus|pro|team).*订阅|加入\s*team.*(?:退出|切换)|如需|复制|点(?:击|一下)|查看.*(?:是否|显示)|必须先退出|不是给|并不是固定|就去玩|不包.*可开|不要(?:再)?(?:去)?开通|plantype.*(?:改成|改为|提交)|普通.*(?:的|约为).*\d.*倍|(?:额度|用量).*约为|免费账号本身/iu;
const exclusionHeading = /以下.*不(?:属于|在|包含).*(?:售后|质保)(?:范围)?|(?:售后|质保)(?:范围)?.*不(?:包括|包含)/u;
const policySentence = /^[^\p{L}\p{N}]*(?:账号充值问题|账号封禁无售后|因官方风控)/u;
const conditionalInstruction = /^[\s\d.、•]*(?:后期|以后|之后)?(?:如果|如若|若显示)/u;

function cleanAssertion(value: string, description = false): string {
  // Keep actual-delivery claims even when a seller appends them to instructions.
  let text = value.normalize('NFKC')
    // Negated plan names and comparisons do not supply a delivered multiplier.
    .replace(/(?:也)?(?:并非|并不是|不是|非)\s*(?:(?:5|20)\s*[x×倍]\s*(?:team|business)|(?:team|business)\s*(?:5|20)\s*[x×倍])\s*(?:账号|套餐)?/giu, ' ')
    .replace(/(?:额度|用量|配额)[^,，。;；\n]*?(?:是|为|约为|相当于)\s*(?:plus|pro|team|business)(?:\s*的)?\s*\d+(?:\.\d+)?\s*倍/giu, ' ')
    .replace(/(?<![a-z])(?:chat\s*g(?=\s*(?:free|go|plus|pro|team|business)\b)|g[!.\s]*p[!.\s]*t(?![a-z])|gp梯)/giu, 'chatgpt')
    .replace(/(?=实际(?:仅|只)?(?:交付|出售|提供|售)|(?:只|仅)售(?!后)|(?:本|此)(?:商品|产品)(?:为|是))/gu, '\n')
    .replace(/([:：,，。;；!！?？])\s*(?=交付|出售|提供|发货)/gu, '$1\n')
    .replace(/https?:\/\/[^\s<>，。；;]+/giu, ' ')
    .replace(/(?:不附带|不包含|无法提供|不能提供|不提供)[^,，。;；\n]*(?:接[码马]|短信验证)[^,，。;；\n]*/gu, ' ')
    .replace(/(?:不保证|不担保)[^。;；\n]*(?=。|;|；|\n|$)/gu, clause => explicitSale.test(clause) || accountClaim.test(clause) ? clause : ' ')
    .replace(/(?:已开通[^。;；\n]*的账号|账号现有)[^。;；\n]*(?:禁止|请勿)(?:提交|下单|购买)[^。;；\n]*/gu, ' ');
  // Split clauses, not entire paragraphs: a warranty/IP note must not erase
  // the delivered plan in the adjacent clause of the same sentence.
  if (description) {
    // Team restrictions can span a comma; remove them before splitting clauses.
    text = text.replace(/(?:已)?加入\s*team[^,，。;；\n]*?(?:[,，]\s*)?(?:需要|需|须|请)(?:先)?(?:退出|切换)[^,，。;；\n]*/giu, ' ');
    // A warranty exclusion heading scopes its following bullets. Keep any
    // independent delivery statement, including one embedded in that list.
    let exclusionList = false;
    text = text.replace(/(?=[•●])/gu, '\n').split('\n').filter(line => {
      const claim = line.replace(/^\s*[•●*-]\s*/u, '').trim();
      if (explicitSale.test(claim) || accountClaim.test(claim)) { exclusionList = false; return true; }
      if (exclusionHeading.test(line)) { exclusionList = true; return false; }
      if (exclusionList && (/^\s*[•●*-]/u.test(line) || /^\s*(?:因|例如|比如)/u.test(line))) return false;
      if (line.trim()) exclusionList = false;
      return true;
    }).join('\n').split(/[\n。;；]/u)
      .filter(sentence => !policySentence.test(sentence) || explicitSale.test(sentence) || accountClaim.test(sentence)).join('\n');
    text = text.split(/[\n。;；!！?？]/u).map(sentence => {
      // A conditional recommendation continues across commas, not across an
      // independent delivery claim or a new sentence.
      let conditional = false;
      return sentence.split(/[,，]/u).filter(clause => {
        const claim = clause.trim();
        if (explicitSale.test(claim)) { conditional = false; return true; }
        if (conditionalInstruction.test(claim)) conditional = true;
        if (conditional && /^(?:可以|可|或者|或是|也可|建议|不妨)/u.test(claim) && /去买|购买|选购|选择/u.test(claim)) return false;
        return !conditionalInstruction.test(claim) && !prerequisiteOrComparison.test(claim) && (accountClaim.test(claim) || !ancillaryClause.test(claim));
      }).join('\n');
    }).join('\n');
  }
  return text
    .replace(/资格(?:号|账号)(?:充值(?:专用)?|卡充|续费)/gu, ' ')
    .replace(/(?<!无)(?:需要|需)(?:自己|自行)?接[码马]/gu, ' ')
    .replace(description ? /(?:邮箱|邮件|郵件)\s*api(?:网址|網址)?/giu : /$^/u, ' ')
    .replace(/(?:不提供|不做|没有|无)(?:私人|任何|其他)?(?:教学|教程|指导)/gu, ' ')
    .replace(/(?<![a-z])(?:outlook|login|access|refresh|session)[\s_-]*token(?![a-z])/giu, ' ')
    .replace(/到期(?:之?后)?(?:可(?:以)?)(?:当|作为|用作)[^,，。;；\n]*资格(?:号|账号)[^,，。;；\n]*/gu, ' ')
    .replace(/(?:只有|仅限|需要)资格(?:号|账号)(?:才)?(?:可(?:以)?|能)充/gu, ' ')
    .replace(/^\s*(?:使用|登录|操作|注册)教程(?:\s+https?:\/\/\S+)?\s*$/gmu, ' ')
    // A buyer's prerequisite is not inventory supplied by the seller.
    .replace(/(?:买家|用户|客户|首次登录|登录后|登录时|使用前|使用时|注册时|注册后)?\s*(?:需(?:要)?|须|必须|请)?\s*(?:自行|自己|自备)[^,，。;；\n]*/giu, ' ')
    .replace(/(?:首次登录|登录时|登录后|注册时|使用时)[^,，。;；\n]*(?:接[码马]|短信|手机验证)[^,，。;；\n]*/giu, ' ')
    .replace(/(?:附赠|附带|赠送)(?:的)?[^,，。;；\n]*(?:教程|教学|说明)[^,，。;；\n]*/giu, ' ')
    .replace(/(?:请先|再)?(?:获取|复制粘贴|粘贴|复制|提交)\s*(?:登录\s*)?token(?:令牌)?/giu, ' ')
    .replace(/team\s*账号[^,，。;；<\n]*?请先切回/giu, ' ')
    .replace(/加入过\s*team\s*空间|曾用过\s*0\s*刀\s*plus\s*卡密/giu, ' ')
    .replace(/(?:必须|需要|请先)等?账号变回免费版/giu, ' ')
    .replace(/team\s*账号\s*[,，]?\s*均?不支持充值|team\s*未退出账号/giu, ' ')
    .replace(/(?:支持|可(?:以)?)[^,，。;；<\n]*?(?:plus\s*[\/]\s*pro|pro\s*[\/]\s*plus)[^,，。;；<\n]*?(?:覆盖|续费)/giu, ' ')
    .replace(/(?:plus\s*[\/／]\s*pro|pro\s*[\/／]\s*plus)\s*(?:均可|均能|可)?(?:覆盖|续费)/giu, ' ')
    .replace(/(?:team|plus|pro|free)\s*(?:账号|账户|会员)?[^,，。;；<\n]*?(?:不支持|无法|禁止|勿下|请先|不能)(?:充值|购买|下单|使用)/giu, ' ')
    .replace(/(?:使用说明|使用教程|登录教程|操作教程|注册教程)\s*(?:参考|参见|详见|[:：])[^,，。;；\n]*/giu, ' ')
    .replace(/(?:可(?:以)?)?\s*(?:与|和)\s*(?:free|go|plus|pro|max|ultra|team|business)\s*(?:并存|共存)/giu, ' ')
    .replace(/(?:相比|对比|比较)\s*(?:目前|当前|现有)?\s*(?:free|go|plus|pro|max|ultra|team|business)\s*(?:价格|定价|费用)/giu, ' ')
    .replace(description ? /(?<![a-z])(?:free|go|plus|pro|max|ultra|team|business)\s*模型(?:机会)?/giu : /$^/u, ' ')
    .replace(/(?:额度|用量|配额|功能|权益)?\s*(?:与|和|相比|对比)[^,，。;；\n]*(?:相同|一样|相当|更多|更高|更低|相比)[^,，。;；\n]*/giu, ' ')
    .replace(/(?:额度|用量|配额|功能|权益)\s*(?:相当于|等同于)[^,，。;；\n]*/giu, ' ')
    .replace(/售后[^,，。;；\n]*(?:不负责|不保证|不包含|不支持)[^,，。;；\n]*/giu, ' ')
    .replace(/(?:可(?:以)?升级|升级[^,，。;；\n]*(?:需要|需|须)[^,，。;；\n]*(?:付费|购买|补差价|加价))[^,，。;；\n]*/giu, ' ')
    .replace(/(?:用于|用来|用途为|可用于)[^,，。;；\n]*/giu, ' ');
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(strings);
}

export function saleEvidenceView(evidence: Record<string, unknown>, format: 'raw' | 'text' = 'raw'): Record<string, unknown> {
  const seen = new WeakSet<object>();
  const walk = (value: unknown, description = false): unknown => {
    if (typeof value === 'string') return cleanAssertion(format === 'raw' ? visibleEvidenceText(value) : value, description);
    if (!value || typeof value !== 'object' || seen.has(value)) return typeof value === 'number' ? value : undefined;
    seen.add(value);
    const result = Array.isArray(value) ? value.map(item => walk(item, description)) : Object.fromEntries(Object.entries(value)
      .filter(([key]) => !auxiliaryKeys.has(keyName(key))).map(([key, item]) => [key, walk(item, description || descriptionKeys.has(keyName(key)))]));
    seen.delete(value);
    return result;
  };
  const result = walk(evidence) as Record<string, unknown>;
  const selected = strings(result.spec).join(' ').toLowerCase();
  const selectedSeats = /标准席位|高级席位/u.test(selected);
  const teamMenu = strings(result).join('\n');
  if (selectedSeats && /(?:team|business)/iu.test(teamMenu) && /(?:可选|套餐选择)/u.test(teamMenu)) {
    const advanced = /高级席位/u.test(selected);
    const mapped5x = /高级席位\s*(?:=|为|是|[:：])\s*5\s*[x×倍]\s*(?:team|business)?/iu.test(teamMenu);
    if (!advanced || mapped5x) {
      const selectedView = (value: unknown): unknown => typeof value === 'string'
        ? value.split(/[\n。;；]/u).filter(clause => explicitSale.test(clause) || (!/可选|套餐选择/u.test(clause)
          && !/^\s*高级席位\s*(?:=|为|是|[:：])/u.test(clause))).join('\n')
        : value && typeof value === 'object' ? Array.isArray(value) ? value.map(selectedView)
          : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, selectedView(item)])) : value;
      const view = selectedView(result) as Record<string, unknown>;
      if (advanced) view.spec = `${view.spec ?? ''} 5x Team`;
      return view;
    }
  }
  const selectedPlans = new Set([...selected.matchAll(plan)].map(match => match[0].toLowerCase()));
  // A selected plan can disambiguate an offered menu; it cannot erase an
  // independently asserted delivery or an incompatible explicit brand.
  const selectedPlatforms = platformsIn(selected);
  if (selectedPlans.size === 1 || selectedPlatforms.length === 1) {
    const stripMenu = (value: unknown): unknown => {
      if (typeof value === 'string') {
        const plans = new Set([...value.matchAll(plan)].map(match => match[0].toLowerCase()));
        if (/可选|任选|套餐选择|\/|或|\bor\b/iu.test(value) && !explicitSale.test(value)) {
          let text = value;
          if (selectedPlans.size === 1 && plans.size > 1) text = text.replace(plan, '').replace(/(?<![\d.])\d+(?:\.\d+)?\s*(?:x|倍)(?![a-z\d])/giu, '');
          if (selectedPlatforms.length === 1 && platformsIn(value).length > 1) for (const pattern of platformPatterns) text = text.replace(pattern, '');
          return text;
        }
        return value;
      }
      if (!value || typeof value !== 'object') return value;
      return Array.isArray(value) ? value.map(stripMenu) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'spec' ? item : stripMenu(item)]));
    };
    return stripMenu(result) as Record<string, unknown>;
  }
  return result;
}

import { saleEvidenceView } from './sale-evidence.js';
import { extractServiceEvidence } from './service-evidence.js';

export const API_RELAY_EXCLUSION_REASON = '目录不收录模型中转站的 API 额度、余额、请求套餐或号池接口';

const model = /codex|claude|openai|chatgpt|gemini|grok|deepseek|模型/iu;
const account = /账号|账户|成品|订阅|会员|席位|账密|team|plus|pro|free/iu;
const commercial = /额度|余额|积分|充值|兑换|请求|并发|credits?|quota|号池|中转|relay/iu;
const api = /(?<![a-z\d])api(?![a-z])/iu;
const unrelatedService = /接[码马]|短信|邮箱|邮件|教程|教学|sms|gmail|icloud|outlook|hotmail|email|搜索|search|tavily|semantic[\s_-]*scholar|notion2api|官方直连|直连|代理\s*ip|住宅\s*ip|虚拟卡|云手机|云机/iu;
const actualDelivery = /(?:实际(?:仅|只)?(?:交付|出售|提供)|(?:只|仅)(?:交付|出售|提供|售)|本(?:商品|产品)(?:为|是)|发货)/iu;
const soldModelApi = /(?:(?:codex|claude|openai|chatgpt|gemini|grok|deepseek|模型)[\s_-]*(?:(?:中转|relay)[\s_-]*)?api|api[\s_-]*(?:(?:中转|relay)[\s_-]*)?(?:codex|claude|openai|chatgpt|gemini|grok|deepseek|模型))/iu;
const soldAccount = /(?:账号|账户|密码|账密|充值到[^,，。;；\n]*(?:自己|买家|用户))/iu;
const relayCategory = /模型\s*api\s*中转|模型中转|api\s*中转|中转站/iu;

/** Reject only high-confidence model API relay offers. */
export function isExcludedApiRelay(evidence: Record<string, unknown>, format: 'raw' | 'text' = 'raw'): boolean {
  const sale = saleEvidenceView(evidence, format);
  const title = [sale.name, sale.spec].filter((value): value is string => typeof value === 'string').join(' ');
  const text = JSON.stringify({ name: sale.name, spec: sale.spec, evidence: sale.evidence, sourceData: sale.sourceData });
  const category = [evidence.category, evidence.sourceCategory,
    evidence.sourceData && typeof evidence.sourceData === 'object' && !Array.isArray(evidence.sourceData)
      ? (evidence.sourceData as Record<string, unknown>).category : undefined]
    .filter((value): value is string => typeof value === 'string').join(' ');
  const hasEndpoint = extractServiceEvidence(evidence).endpoints.length > 0;

  // These fields are independent of the cleaned sale view: together they identify
  // a relay balance SKU even when the title contains no model name.
  if (relayCategory.test(category) && hasEndpoint && commercial.test(title)) return true;
  const titleRelay = (model.test(title) && api.test(title) && commercial.test(title))
    || (api.test(title) && /额度|余额|积分|请求|充值|credits?|quota/iu.test(title))
    || /sub2api.*(?:充值|兑换|余额)/iu.test(title);
  if (titleRelay && actualDelivery.test(text) && soldAccount.test(text)) return false;
  const explicitModelDelivery = actualDelivery.test(text) && soldModelApi.test(text) && commercial.test(text);
  const explicitCredentials = actualDelivery.test(text) && /api[\s_-]*url/iu.test(text) && /api[\s_-]*key/iu.test(text)
    && model.test(text) && /中转|relay|号池/iu.test(text);
  if (explicitModelDelivery || explicitCredentials) return true;
  if (account.test(title) && !/号池|中转|relay/iu.test(title)) return false;
  if ((unrelatedService.test(title) || unrelatedService.test(text)) && !/号池|中转|relay/iu.test(title)) return false;
  return titleRelay;
}

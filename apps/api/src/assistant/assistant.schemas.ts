import {
  ASSISTANT_INTENTS, ASSISTANT_LIMITS, SHOPPING_NEEDS_FIELDS,
  emptyShoppingNeeds, validateAssistantInput, validateAssistantReply, validateNeedsPatch, validateShoppingNeeds,
  type AssistantDataRequest, type NeedsPatch, type ShoppingNeeds, type Understanding,
} from '@price-comparison/catalog/assistant-contract';
import { parseCatalogSearch } from '@price-comparison/catalog/purchase-attributes';
import { isDeepStrictEqual } from 'node:util';

function invalid(field: string): never {
  throw new Error(`Invalid assistant understanding ${field}`);
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid('object');
  const source = value as Record<string, unknown>;
  if (Reflect.ownKeys(source).some(key => typeof key !== 'string' || !keys.includes(key))
    || keys.some(key => !Object.hasOwn(source, key))) invalid('fields');
  return source;
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) invalid('text');
  return value;
}

export function parseUnderstanding(value: unknown, userText: string): Understanding {
  validateAssistantInput(userText);
  const serialized = JSON.stringify(value);
  if (!serialized || new TextEncoder().encode(serialized).length > ASSISTANT_LIMITS.outputMaxBytes) invalid('output size');
  const hasRequests = value !== null && typeof value === 'object' && Object.hasOwn(value, 'requests');
  const source = record(value, ['intent', 'patch', 'evidence', 'question', 'options', ...(hasRequests ? ['requests'] : [])]);
  if (!ASSISTANT_INTENTS.includes(source.intent as Understanding['intent'])) invalid('intent');
  const patch = validateNeedsPatch(source.patch);
  if (['answer', 'explain'].includes(String(source.intent)) && Object.keys(patch).length) invalid('consultation patch');
  const requests = hasRequests ? parseDataRequests(source.requests, userText) : undefined;
  if (source.intent === 'clarify' && requests?.length) invalid('requests');
  if (!Array.isArray(source.evidence) || source.evidence.length > ASSISTANT_LIMITS.evidenceEntriesMax) invalid('evidence');
  const evidence = Array.from(source.evidence, value => {
    const entry = record(value, ['field', 'quote']);
    const field = entry.field as keyof ShoppingNeeds;
    if (!SHOPPING_NEEDS_FIELDS.includes(field) || !Object.hasOwn(patch, field)) invalid('evidence field');
    const quote = text(entry.quote, ASSISTANT_LIMITS.userTextMaxChars);
    if (!userText.includes(quote)) invalid('evidence quote');
    return { field, quote };
  });
  for (const field of SHOPPING_NEEDS_FIELDS) {
    if (!Object.hasOwn(patch, field)) continue;
    const quotes = evidence.filter(entry => entry.field === field).map(entry => entry.quote);
    if (!quotes.length) invalid('missing evidence');
    if (['budget', 'requiredTags', 'platform', 'membershipKinds'].includes(field)) {
      // shortcut: reject explicit soft-only phrases; semantic correctness still needs the service's conflict check.
      const softOnly = quotes.every(quote =>
        /尽量|最好|优先|如果可以|便宜(?:一?点)?|省心|新手|prefer(?:ably)?|if possible|cheaper/iu.test(quote)
        && !/必须|一定要|不能|不要|不接受|最多|至少|不得|must|required|at most|at least/iu.test(quote));
      if (softOnly && !(field === 'membershipKinds' && quotes.some(quote =>
        /只看|只要|只选|全部类别|所有类别|类别不限|关闭新手|取消新手|恢复默认/u.test(quote)))) invalid('preference as requirement');
    }
    if (field === 'newcomer' && !quotes.some(quote =>
      !/(?:不要|别|不能|不想).{0,4}(?:关闭|取消|开启|启用|打开|恢复)/u.test(quote)
      && /(?:关闭|取消|不用|不要|启用|开启|打开|恢复).{0,8}(?:新手|默认)|(?:全部|所有|不限|不限制).{0,6}(?:类别|分类|特性)|(?:类别|分类|特性).{0,6}(?:全部|所有|不限)|(?:disable|enable|turn off|turn on).{0,12}(?:beginner|newcomer)|all (?:kinds|categories)/iu.test(quote))) {
      invalid('preference as requirement');
    }
  }
  const question = source.question === null ? null : text(source.question, ASSISTANT_LIMITS.messageMaxChars);
  if (!Array.isArray(source.options) || source.options.length > ASSISTANT_LIMITS.optionsMax) invalid('options');
  const options = Array.from(source.options, option => text(option, ASSISTANT_LIMITS.optionMaxChars));
  if (new Set(options).size !== options.length || (source.intent === 'clarify') !== (question !== null)
    || (question === null && options.length)) invalid('question/options');
  if (question !== null) {
    validateAssistantReply({ kind: 'question', text: question, options, needs: emptyShoppingNeeds(), cards: [] });
  }
  return { intent: source.intent as Understanding['intent'], patch, evidence, question, options,
    ...(requests ? { requests } : {}) };
}

function parseDataRequests(value: unknown, userText: string): AssistantDataRequest[] {
  if (!Array.isArray(value) || value.length > 4) invalid('requests');
  const seen = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid('requests');
    const tool = Reflect.get(item, 'tool');
    const allowed = tool === 'knowledge' ? ['tool'] : ['tool', 'scope', 'filters', 'evidence', 'currency', 'currencyQuote',
      ...(tool === 'statistics' ? ['groupBy'] : [])];
    if (!['knowledge', 'statistics', 'history'].includes(tool)
      || Object.keys(item).some(key => !allowed.includes(key))) invalid('requests');
    if (tool === 'knowledge') {
      if (seen.has('knowledge')) invalid('requests');
      seen.add('knowledge');
      return { tool: 'knowledge' };
    }
    const entry = item as Record<string, unknown>;
    if (!['catalog', 'current'].includes(String(entry.scope))) invalid('requests');
    const filters = Object.hasOwn(entry, 'filters') ? validateNeedsPatch(entry.filters) : undefined;
    if (filters && Object.keys(filters).some(key => !['platform', 'product', 'budget', 'requiredTags', 'membershipKinds', 'newcomer'].includes(key))) invalid('requests');
    const filterPlan = parseUnderstanding({ intent: 'recommend', patch: filters ?? {},
      evidence: Object.hasOwn(entry, 'evidence') ? entry.evidence : [], question: null, options: [] }, userText);
    if (Object.hasOwn(entry, 'currency') && (typeof entry.currency !== 'string' || !/^[A-Z]{3}$/u.test(entry.currency))) invalid('requests');
    if (Object.hasOwn(entry, 'currency') !== Object.hasOwn(entry, 'currencyQuote')
      || (entry.currency && !userText.includes(text(entry.currencyQuote, ASSISTANT_LIMITS.userTextMaxChars)))) invalid('requests');
    if (Object.hasOwn(entry, 'groupBy') && !['none', 'membership', 'platform'].includes(String(entry.groupBy))) invalid('requests');
    const request: AssistantDataRequest = { tool, scope: entry.scope as 'catalog' | 'current',
      ...(filters ? { filters } : {}),
      ...(Object.hasOwn(entry, 'evidence') ? { evidence: filterPlan.evidence } : {}),
      ...(entry.currency ? { currency: entry.currency as string, currencyQuote: entry.currencyQuote as string } : {}),
      ...(entry.groupBy ? { groupBy: entry.groupBy as 'none' | 'membership' | 'platform' } : {}) };
    const key = JSON.stringify(request);
    if (seen.has(key)) invalid('requests');
    seen.add(key);
    return request;
  });
}

export function applyNeedsPatch(current: ShoppingNeeds, patch: NeedsPatch): ShoppingNeeds {
  return validateShoppingNeeds({ ...validateShoppingNeeds(current), ...validateNeedsPatch(patch) });
}

export function separateProductAttributes(needs: ShoppingNeeds): ShoppingNeeds | null {
  if (!needs.product) return needs;
  const parsed = parseCatalogSearch(needs.product);
  if (!parsed.tags.length) return needs;
  // An attribute-only phrase must not broaden the request to arbitrary products.
  if (!parsed.text) return null;
  const tags = [...needs.requiredTags, ...parsed.tags];
  try {
    return validateShoppingNeeds({ ...needs, product: parsed.text,
      requiredTags: tags.filter((tag, index) => tags.findIndex(other => isDeepStrictEqual(other, tag)) === index),
    });
  } catch { return null; }
}

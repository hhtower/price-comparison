import {
  ASSISTANT_INTENTS, ASSISTANT_LIMITS, SHOPPING_NEEDS_FIELDS,
  emptyShoppingNeeds, validateAssistantInput, validateAssistantReply, validateNeedsPatch, validateShoppingNeeds,
  type NeedsPatch, type ShoppingNeeds, type Understanding,
} from '@price-comparison/catalog/assistant-contract';

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
  const source = record(value, ['intent', 'patch', 'evidence', 'question', 'options']);
  if (!ASSISTANT_INTENTS.includes(source.intent as Understanding['intent'])) invalid('intent');
  const patch = validateNeedsPatch(source.patch);
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
    if (['budget', 'warrantyDaysMin', 'requiredTags', 'platform'].includes(field)) {
      // shortcut: reject explicit soft-only phrases; semantic correctness still needs the service's conflict check.
      const softOnly = quotes.every(quote =>
        /尽量|最好|优先|如果可以|便宜(?:一?点)?|省心|新手|prefer(?:ably)?|if possible|cheaper/iu.test(quote)
        && !/必须|一定要|不能|不要|不接受|最多|至少|不得|must|required|at most|at least/iu.test(quote));
      if (softOnly) invalid('preference as requirement');
    }
  }
  const question = source.question === null ? null : text(source.question, ASSISTANT_LIMITS.replyMaxChars);
  if (!Array.isArray(source.options) || source.options.length > ASSISTANT_LIMITS.optionsMax) invalid('options');
  const options = Array.from(source.options, option => text(option, ASSISTANT_LIMITS.optionMaxChars));
  if (new Set(options).size !== options.length || (source.intent === 'clarify') !== (question !== null)
    || (question === null && options.length)) invalid('question/options');
  if (question !== null) {
    validateAssistantReply({ kind: 'question', text: question, options, needs: emptyShoppingNeeds(), cards: [] });
  }
  return { intent: source.intent as Understanding['intent'], patch, evidence, question, options };
}

export function applyNeedsPatch(current: ShoppingNeeds, patch: NeedsPatch): ShoppingNeeds {
  return validateShoppingNeeds({ ...validateShoppingNeeds(current), ...validateNeedsPatch(patch) });
}

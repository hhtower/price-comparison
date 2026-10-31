import { isCanonicalProductTag, PRODUCT_TAG_RULES } from './product-tag-policy.js';

export const ASSISTANT_LIMITS = Object.freeze({
  userTextMaxChars: 2000,
  contextMaxBytes: 24 * 1024,
  contextTurns: 6,
  evidenceMaxBytes: 32 * 1024,
  outputMaxTokens: 2048,
  outputMaxBytes: 16 * 1024,
  replyMaxChars: 1200,
  optionsMax: 4,
  optionMaxChars: 120,
  cardsMax: 3,
  turnDeadlineMs: 90_000,
  sessionMaxTurns: 30,
  sessionTtlMs: 24 * 60 * 60 * 1000,
  sessionMaxActiveTurns: 1,
  sessionMaxSubscriptions: 2,
  sessionCreatesPerIpPerMinute: 5,
  messagesPerIpPerMinute: 10,
  requestsMax: 2,
  standardProductsMax: 5,
  offersPerProductMax: 20,
  cleanupBatchMax: 100,
  ssePollMs: 1000,
  sseHeartbeatMs: 15_000,
  sseBufferMaxBytes: 64 * 1024,
  workerHeartbeatMs: 1000,
  purposeMaxChars: 2000,
  platformMaxChars: 120,
  tagsMax: 32,
  tagNameMaxChars: 64,
  tagValueMaxChars: 250,
  warrantyDaysMax: 36_500,
  amountMaxChars: 15,
  amountIntegerMaxDigits: 12,
  idMaxChars: 19,
  identifierMaxChars: 128,
  cardTitleMaxChars: 240,
  cardNotesMax: 4,
  cardNoteMaxChars: 240,
  cardEvidenceMax: 8,
  errorCodeMaxChars: 64,
  evidenceEntriesMax: 28,
});

export const ASSISTANT_PREFERENCES = ['lower_price', 'simple_setup', 'longer_warranty'] as const;
export const ASSISTANT_INTENTS = ['clarify', 'recommend', 'compare', 'explain'] as const;
export const ASSISTANT_REPLY_KINDS = ['question', 'recommendation', 'comparison', 'explanation', 'no_match'] as const;
export const ASSISTANT_TURN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export const ASSISTANT_TURN_PHASES = ['queued', 'understanding', 'searching', 'explaining', 'succeeded', 'failed', 'cancelled'] as const;
export const SHOPPING_NEEDS_FIELDS = ['purpose', 'platform', 'budget', 'requiredTags', 'warrantyDaysMin', 'preferences'] as const;

export type Budget = { amount: string; currency: string; basis: 'purchase' | 'month' };
export type ShoppingNeeds = {
  purpose: string | null;
  platform: string | null;
  budget: Budget | null;
  requiredTags: Array<{ name: string; value: string }>;
  warrantyDaysMin: number | null;
  preferences: Array<typeof ASSISTANT_PREFERENCES[number]>;
};
export type NeedsPatch = Partial<ShoppingNeeds>;
export type Understanding = {
  intent: typeof ASSISTANT_INTENTS[number];
  patch: NeedsPatch;
  evidence: Array<{ field: keyof ShoppingNeeds; quote: string }>;
  question: string | null;
  options: string[];
};
export type AssistantReply = {
  kind: typeof ASSISTANT_REPLY_KINDS[number];
  text: string;
  options: string[];
  needs: ShoppingNeeds;
  cards: Array<{
    standardProductId: string;
    productId: string;
    shopId: string;
    title: string;
    price: string;
    currency: string;
    capturedAt: string;
    priceExpiresAt: string;
    detailPath: string;
    reasons: string[];
    caveats: string[];
    evidenceIds: string[];
  }>;
};
export type TurnStatus = typeof ASSISTANT_TURN_STATUSES[number];
export type TurnPhase = typeof ASSISTANT_TURN_PHASES[number];
export type TurnSnapshot = {
  id: string;
  sessionId: string;
  clientMessageId: string;
  inputText: string;
  expectedRevision: number;
  eventVersion: number;
  status: TurnStatus;
  phase: TurnPhase;
  reply: AssistantReply | null;
  errorCode: string | null;
};
export type SessionSnapshot = {
  id: string;
  revision: number;
  needs: ShoppingNeeds;
  turns: TurnSnapshot[];
};

function invalid(field: string): never {
  throw new Error(`Invalid assistant ${field}`);
}

function record(value: unknown, keys: readonly string[], partial = false): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid('object');
  const result = value as Record<string, unknown>;
  if (Reflect.ownKeys(result).some(key => typeof key !== 'string' || !keys.includes(key))
    || (!partial && keys.some(key => !Object.hasOwn(result, key)))) invalid('fields');
  return result;
}

function text(value: unknown, field: string, max: number, multiline = false): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max
    || /[\u0000-\u001f\u007f]/u.test(multiline ? value.replace(/[\t\r\n]/gu, '') : value)) invalid(field);
  return value;
}

function clarificationText(value: unknown, max: number, multiline = false): string {
  const result = text(value, 'clarification text', max, multiline);
  const normalized = result.normalize('NFKC');
  if ((normalized.match(/[?？]/gu) ?? []).length > 1
    || /[a-z][a-z0-9+.-]*:\/\/|\/\/|\bwww\.|\b(?:https?|javascript|data|mailto|tel):|\[[^\]]*\]\s*[([]|<[^>]*\bhref\s*=|\b(?:[a-z0-9-]+\.)+[a-z]{2,63}\b/iu.test(normalized)
    || /保证(?:永远|永久|永)?不(?:会)?封号|绝不封号|永不封号|绝对安全|完全安全|保证安全|零风险|全网最低|(?:100\s*%|百分之?百)(?:安全|不封号)|guaranteed?\s+(?:safe|never\s+banned)|lowest\s+price\s+(?:anywhere|on\s+the\s+internet)/iu.test(normalized)) invalid('unsafe clarification');
  return result;
}

function integer(value: unknown, field: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) invalid(field);
  return value;
}

function choice<T extends string>(value: unknown, choices: readonly T[], field: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) invalid(field);
  return value as T;
}

function list<T>(value: unknown, max: number, parse: (entry: unknown) => T, min = 0): T[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) invalid('array');
  return Array.from(value, parse);
}

function unique<T>(values: T[]): T[] {
  if (new Set(values).size !== values.length) invalid('duplicates');
  return values;
}

function amount(value: unknown): string {
  const result = text(value, 'amount', ASSISTANT_LIMITS.amountMaxChars);
  if (!new RegExp(`^(?:0|[1-9][0-9]{0,${ASSISTANT_LIMITS.amountIntegerMaxDigits - 1}})(?:\\.[0-9]{1,2})?$`, 'u').test(result)) invalid('amount');
  return result;
}

function currency(value: unknown): string {
  const result = text(value, 'currency', 3);
  if (!/^[A-Z]{3}$/u.test(result)) invalid('currency');
  return result;
}

function id(value: unknown): string {
  const result = text(value, 'id', ASSISTANT_LIMITS.idMaxChars);
  if (!/^[1-9][0-9]*$/u.test(result) || BigInt(result) > 9223372036854775807n) invalid('id');
  return result;
}

function uuid(value: unknown): string {
  const result = text(value, 'uuid', 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(result)) invalid('uuid');
  return result;
}

function timestamp(value: unknown): string {
  const result = text(value, 'timestamp', 24);
  const date = new Date(result);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(result)
    || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== result.slice(0, 19)) invalid('timestamp');
  return result;
}

export function validateAssistantInput(value: unknown): string {
  return text(value, 'inputText', ASSISTANT_LIMITS.userTextMaxChars, true);
}

export function emptyShoppingNeeds(): ShoppingNeeds {
  return { purpose: null, platform: null, budget: null, requiredTags: [], warrantyDaysMin: null, preferences: [] };
}

export function validateNeedsPatch(value: unknown): NeedsPatch {
  const source = record(value, SHOPPING_NEEDS_FIELDS, true);
  const patch: NeedsPatch = {};
  for (const field of SHOPPING_NEEDS_FIELDS) {
    if (!Object.hasOwn(source, field)) continue;
    const entry = source[field];
    switch (field) {
      case 'purpose':
      case 'platform':
        patch[field] = entry === null ? null : text(entry, field,
          field === 'purpose' ? ASSISTANT_LIMITS.purposeMaxChars : ASSISTANT_LIMITS.platformMaxChars, field === 'purpose');
        break;
      case 'budget': {
        if (entry === null) { patch.budget = null; break; }
        const budget = record(entry, ['amount', 'currency', 'basis']);
        patch.budget = { amount: amount(budget.amount), currency: currency(budget.currency),
          basis: choice(budget.basis, ['purchase', 'month'], 'basis') };
        break;
      }
      case 'warrantyDaysMin':
        patch.warrantyDaysMin = entry === null ? null : integer(entry, field, ASSISTANT_LIMITS.warrantyDaysMax);
        break;
      case 'preferences':
        patch.preferences = unique(list(entry, ASSISTANT_PREFERENCES.length,
          item => choice(item, ASSISTANT_PREFERENCES, field)));
        break;
      case 'requiredTags': {
        const seen = new Map<string, Set<string>>();
        patch.requiredTags = list(entry, ASSISTANT_LIMITS.tagsMax, item => {
          const tag = record(item, ['name', 'value']);
          const parsed = { name: text(tag.name, 'tag name', ASSISTANT_LIMITS.tagNameMaxChars),
            value: text(tag.value, 'tag value', ASSISTANT_LIMITS.tagValueMaxChars) };
          if (!isCanonicalProductTag(parsed)) invalid('requiredTags');
          const values = seen.get(parsed.name);
          if (values && (values.has(parsed.value) || !PRODUCT_TAG_RULES[parsed.name].multiple)) invalid('conflicting tags');
          if (values) values.add(parsed.value);
          else seen.set(parsed.name, new Set([parsed.value]));
          return parsed;
        });
      }
    }
  }
  return patch;
}

export function validateShoppingNeeds(value: unknown): ShoppingNeeds {
  record(value, SHOPPING_NEEDS_FIELDS);
  return validateNeedsPatch(value) as ShoppingNeeds;
}

export function validateAssistantReply(value: unknown): AssistantReply {
  const source = record(value, ['kind', 'text', 'options', 'needs', 'cards']);
  const kind = choice(source.kind, ASSISTANT_REPLY_KINDS, 'kind');
  const cards = list(source.cards, ASSISTANT_LIMITS.cardsMax, value => {
    const source = record(value, ['standardProductId', 'productId', 'shopId', 'title', 'price', 'currency',
      'capturedAt', 'priceExpiresAt', 'detailPath', 'reasons', 'caveats', 'evidenceIds']);
    const standardProductId = id(source.standardProductId);
    const productId = id(source.productId);
    const capturedAt = timestamp(source.capturedAt);
    const priceExpiresAt = timestamp(source.priceExpiresAt);
    if (Date.parse(priceExpiresAt) <= Date.parse(capturedAt)) invalid('price expiry');
    if (source.detailPath !== `/products/${standardProductId}`) invalid('detailPath');
    const notes = (value: unknown, min = 0) => unique(list(value, ASSISTANT_LIMITS.cardNotesMax,
      item => text(item, 'card note', ASSISTANT_LIMITS.cardNoteMaxChars, true), min));
    return {
      standardProductId, productId, shopId: id(source.shopId),
      title: text(source.title, 'title', ASSISTANT_LIMITS.cardTitleMaxChars),
      price: amount(source.price), currency: currency(source.currency),
      capturedAt, priceExpiresAt, detailPath: `/products/${standardProductId}`,
      reasons: notes(source.reasons, 1), caveats: notes(source.caveats),
      evidenceIds: unique(list(source.evidenceIds, ASSISTANT_LIMITS.cardEvidenceMax,
        item => text(item, 'evidence id', ASSISTANT_LIMITS.identifierMaxChars), 1)),
    };
  });
  unique(cards.map(card => card.productId));
  if ((kind === 'question' || kind === 'no_match') && cards.length) invalid('cards for reply kind');
  return { kind, text: kind === 'question'
    ? clarificationText(source.text, ASSISTANT_LIMITS.replyMaxChars, true)
    : text(source.text, 'reply text', ASSISTANT_LIMITS.replyMaxChars, true),
    options: unique(list(source.options, ASSISTANT_LIMITS.optionsMax,
      item => clarificationText(item, ASSISTANT_LIMITS.optionMaxChars))),
    needs: validateShoppingNeeds(source.needs), cards };
}

export function isTurnTerminal(status: TurnStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

export function validateTurnSnapshot(value: unknown): TurnSnapshot {
  const source = record(value, ['id', 'sessionId', 'clientMessageId', 'inputText', 'expectedRevision',
    'eventVersion', 'status', 'phase', 'reply', 'errorCode']);
  const status = choice(source.status, ASSISTANT_TURN_STATUSES, 'status');
  const phase = choice(source.phase, ASSISTANT_TURN_PHASES, 'phase');
  const reply = source.reply === null ? null : validateAssistantReply(source.reply);
  const errorCode = source.errorCode === null ? null : text(source.errorCode, 'errorCode', ASSISTANT_LIMITS.errorCodeMaxChars);
  if (errorCode !== null && !/^[A-Za-z][A-Za-z0-9_]*$/u.test(errorCode)) invalid('errorCode');
  const processing = ['understanding', 'searching', 'explaining'].includes(phase);
  if ((status === 'queued' && phase !== 'queued') || (status === 'running' && !processing)
    || (isTurnTerminal(status) && phase !== status && phase !== 'queued' && !processing)) invalid('status/phase');
  if ((status === 'succeeded') !== (reply !== null)
    || (status === 'failed' && errorCode === null)
    || (!['failed', 'cancelled'].includes(status) && errorCode !== null)) invalid('terminal result');
  return {
    id: id(source.id), sessionId: uuid(source.sessionId), clientMessageId: uuid(source.clientMessageId),
    inputText: validateAssistantInput(source.inputText),
    expectedRevision: integer(source.expectedRevision, 'expectedRevision', ASSISTANT_LIMITS.sessionMaxTurns),
    eventVersion: integer(source.eventVersion, 'eventVersion'), status, phase, reply, errorCode,
  };
}

export function validateSessionSnapshot(value: unknown): SessionSnapshot {
  const source = record(value, ['id', 'revision', 'needs', 'turns']);
  const sessionId = uuid(source.id);
  const revision = integer(source.revision, 'revision', ASSISTANT_LIMITS.sessionMaxTurns);
  const turns = list(source.turns, ASSISTANT_LIMITS.sessionMaxTurns, validateTurnSnapshot);
  unique(turns.map(turn => turn.id));
  unique(turns.map(turn => turn.clientMessageId.toLowerCase()));
  if (turns.some(turn => turn.sessionId.toLowerCase() !== sessionId.toLowerCase() || turn.expectedRevision > revision)
    || turns.filter(turn => !isTurnTerminal(turn.status)).length > ASSISTANT_LIMITS.sessionMaxActiveTurns) invalid('session turns');
  let completed = 0;
  for (const [index, turn] of turns.entries()) {
    if (turn.expectedRevision !== completed
      || (index > 0 && BigInt(turn.id) <= BigInt(turns[index - 1].id))
      || (!isTurnTerminal(turn.status) && index !== turns.length - 1)) invalid('turn order/revision');
    if (turn.status === 'succeeded') completed++;
  }
  if (revision !== completed) invalid('session revision');
  return { id: sessionId, revision, needs: validateShoppingNeeds(source.needs), turns };
}

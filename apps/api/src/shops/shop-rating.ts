import assert from 'node:assert/strict';
import type { JsonValue } from '../database/types.js';

export const SHOP_RATING_POLICY_ID = 'shop-public-information-score-v2';
const MAX_AGE_MS = 86_400_000;
const DOMAINS = [['L1', 'L2', 'L3'], ['R1', 'R2', 'R3'], ['A1', 'A2']];
const QUESTIONS = DOMAINS.flat();
const GROUPS = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'];
type Deposit = { amountMinor: number | null; currency: string | null; purpose: string | null };
type Answers = Record<string, boolean | null>;
type Listing = { unitId: string; answers: Answers | null; consistency: Answers | null };
export type RatingInput = { deposit: Deposit; volume: number | null; listings: Listing[] | null };
type Source = { url: string; protocol: string | null };
export type ShopObservation = { deposit: Deposit | null; volume: number | null; counterDefinition: string; observedAt: string };
type RatingState = {
  policyId: string; sourceUrl: string; sourceProtocol: string | null;
  deposit: { value: Deposit; observedAt: number } | null;
  volume: { value: number; observedAt: number; definition: string; evidence: string } | null;
};

const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function checkDeposit(value: unknown): asserts value is Deposit {
  assert(exact(value, ['amountMinor', 'currency', 'purpose']));
  assert(value.amountMinor === null || integer(value.amountMinor));
  assert(value.currency === null || typeof value.currency === 'string' && /^[A-Z]{3}$/.test(value.currency));
  assert(value.purpose === null || value.purpose === 'refund_applicable' || value.purpose === 'listing_only');
  assert(value.amountMinor === null || value.amountMinor === 0 || value.currency === null || value.currency === 'CNY');
}
function checkAnswers(value: unknown, keys: string[]): asserts value is Answers | null {
  assert(value === null || exact(value, keys) && Object.values(value).every(item => item === null || typeof item === 'boolean'));
}
function hill(value: number, half: number): number {
  if (value === 0) return 0;
  const z = Math.log(value) - Math.log(half);
  return z >= 0 ? 100 / (1 + Math.exp(-z)) : 100 * Math.exp(z) / (1 + Math.exp(z));
}

// Keep the adopted fixed budgets; parity tests bind this buildable implementation to the archived scorer.
export function scoreShopRating(input: RatingInput): number {
  assert(exact(input, ['deposit', 'volume', 'listings']));
  checkDeposit(input.deposit);
  assert(input.volume === null || integer(input.volume));
  assert(input.listings === null || Array.isArray(input.listings));
  const units = new Map<string, Listing>();
  for (const unit of input.listings ?? []) {
    assert(exact(unit, ['unitId', 'answers', 'consistency']));
    assert(typeof unit.unitId === 'string' && unit.unitId.trim().length > 0);
    checkAnswers(unit.answers, QUESTIONS);
    checkAnswers(unit.consistency, GROUPS);
    if (units.has(unit.unitId)) assert.deepEqual(unit, units.get(unit.unitId), 'conflicting repeated listing');
    else units.set(unit.unitId, unit);
  }
  const deposit = input.deposit;
  const p = deposit.amountMinor !== null && (deposit.currency === 'CNY' || deposit.amountMinor === 0)
    ? (deposit.purpose === 'refund_applicable' ? 1 : 0.75) * hill(deposit.amountMinor, 10000) : 0;
  const v = input.volume === null ? 0 : hill(input.volume, 1000);
  const listings = [...units].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, unit]) => unit);
  const i = !listings.length ? 0 : listings.reduce((sum, unit) => sum + DOMAINS.reduce((total, questions) =>
    total + 100 * questions.filter(key => unit.answers?.[key] === true).length / questions.length, 0) / 3, 0) / listings.length;
  const c = !listings.length ? 0 : 100 * listings.reduce((sum, unit) => sum
    + GROUPS.filter(key => unit.consistency?.[key] === false).length, 0) / (6 * listings.length);
  return p * 50 / 100 + v * 30 / 100 + i * 18 / 100 + c * 2 / 100;
}

function storedState(value: JsonValue | null, source: Source): RatingState | null {
  try {
    assert(exact(value, ['policyId', 'sourceUrl', 'sourceProtocol', 'deposit', 'volume']));
    assert(value.policyId === SHOP_RATING_POLICY_ID && value.sourceUrl === source.url && value.sourceProtocol === source.protocol);
    if (value.deposit !== null) {
      assert(exact(value.deposit, ['value', 'observedAt']) && integer(value.deposit.observedAt));
      checkDeposit(value.deposit.value);
      assert(value.deposit.value.amountMinor !== null);
    }
    if (value.volume !== null) {
      assert(exact(value.volume, ['value', 'observedAt', 'definition', 'evidence']));
      assert(integer(value.volume.value) && integer(value.volume.observedAt));
      assert(typeof value.volume.definition === 'string' && value.volume.definition.trim());
      assert(value.volume.evidence === 'public_display_unverified');
    }
    return value as RatingState;
  } catch { return null; }
}

export function mergeShopObservation(previous: JsonValue | null, source: Source, observation: ShopObservation, now: number): RatingState {
  const observedAt = Date.parse(observation.observedAt);
  assert(integer(observedAt) && observedAt <= now, 'invalid observation time');
  assert(typeof observation.counterDefinition === 'string' && observation.counterDefinition.trim());
  assert(observation.volume === null || integer(observation.volume));
  if (observation.deposit !== null) checkDeposit(observation.deposit);
  const old = storedState(previous, source);
  return {
    policyId: SHOP_RATING_POLICY_ID, sourceUrl: source.url, sourceProtocol: source.protocol,
    deposit: observation.deposit?.amountMinor != null ? { value: observation.deposit, observedAt } : old?.deposit ?? null,
    volume: observation.volume !== null ? { value: observation.volume, observedAt,
      definition: observation.counterDefinition, evidence: 'public_display_unverified' } : old?.volume ?? null,
  };
}

export type ShopRatingDetails = {
  deposit: { amountMinor: number | null; currency: string | null; contribution: string } | null;
  volume: { count: number; unit: 'people' | 'count'; contribution: string } | null;
  text?: { total: number; reviewed: number; disclosureContribution: string; consistencyContribution: string };
};

export function readShopRating(value: JsonValue | null, source: Source, now: number,
  text?: { listings: Listing[]; reviewed: number; nextExpiryAt: number } | null): { score: string | null; nextExpiryAt: number | null; details: ShopRatingDetails | null } {
  const state = storedState(value, source);
  const fresh = (field: { observedAt: number } | null | undefined) => field != null && field.observedAt <= now && field.observedAt + MAX_AGE_MS > now;
  const deposit = fresh(state?.deposit) ? state!.deposit! : null;
  const volume = fresh(state?.volume) ? state!.volume! : null;
  const deadlines = [deposit, volume].flatMap(field => field ? [field.observedAt + MAX_AGE_MS] : []);
  const currentText = text && text.nextExpiryAt > now && text.listings.length ? text : null;
  if (currentText) deadlines.push(currentText.nextExpiryAt);
  if (!deadlines.length) return { score: null, nextExpiryAt: null, details: null };
  const input: RatingInput = {
    deposit: deposit?.value ?? { amountMinor: null, currency: null, purpose: null }, volume: volume?.value ?? null,
    listings: currentText?.listings ?? null,
  };
  const noDeposit = { amountMinor: null, currency: null, purpose: null };
  return { score: scoreShopRating(input).toFixed(2), nextExpiryAt: Math.min(...deadlines), details: {
    deposit: deposit ? { amountMinor: deposit.value.amountMinor, currency: deposit.value.currency,
      contribution: scoreShopRating({ ...input, volume: null, listings: null }).toFixed(2) } : null,
    volume: volume ? { count: volume.value,
      unit: volume.definition.startsWith('merchant_sales_count_text_person_payment_display_unverified;') ? 'people' : 'count',
      contribution: scoreShopRating({ ...input, deposit: noDeposit, listings: null }).toFixed(2) } : null,
    ...(currentText ? { text: { total: currentText.listings.length, reviewed: currentText.reviewed,
      disclosureContribution: scoreShopRating({ deposit: noDeposit, volume: null,
        listings: currentText.listings.map(unit => ({ ...unit, consistency: null })) }).toFixed(2),
      consistencyContribution: scoreShopRating({ deposit: noDeposit, volume: null,
        listings: currentText.listings.map(unit => ({ ...unit, answers: null })) }).toFixed(2) } } : {}),
  } };
}

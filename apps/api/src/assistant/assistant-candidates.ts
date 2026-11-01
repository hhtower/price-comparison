import type { ShoppingNeeds } from '@price-comparison/catalog/assistant-contract';
import { createHash } from 'node:crypto';
import { CATALOG_PLATFORMS, groupCatalogPlatforms, normalizeCatalogPlatform } from '@price-comparison/catalog/platform-groups';
import { purchaseTagLabel, purchaseWarrantyLabel } from '@price-comparison/catalog/purchase-attributes';
import { PURCHASE_GUIDE_FIELDS } from '@price-comparison/catalog/purchase-guide-content';
import type { CatalogOffer, PublicCatalogProduct } from '../catalog/catalog.repository.js';
import { capabilitySupportsPurpose, type CapabilityEvidence } from './assistant-capabilities.js';

export interface AssistantCandidate {
  standardProduct: PublicCatalogProduct;
  offer: CatalogOffer;
  capabilityEvidence: CapabilityEvidence[];
}

function tag(candidate: AssistantCandidate, name: string): string | undefined {
  const values = new Set(candidate.offer.tags.filter(tag => tag.name === name).map(tag => tag.value));
  return values.size === 1 ? [...values][0] : undefined;
}

function warrantyDays(candidate: AssistantCandidate): number | undefined {
  if (candidate.offer.tags.some(tag => tag.name === 'warranty' && tag.value !== 'covered')) return undefined;
  const value = tag(candidate, 'warranty_days');
  return value !== undefined && /^[0-9]+$/u.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value) : undefined;
}

function setupSteps(candidate: AssistantCandidate): number | undefined {
  const value = tag(candidate, 'setup_steps');
  return value !== undefined && /^[0-9]+$/u.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value) : undefined;
}

export function isBeginnerRecommendation(candidate: AssistantCandidate, needs: ShoppingNeeds): boolean {
  if (needs.budget || needs.requiredTags.length || needs.warrantyDaysMin !== null || needs.preferences.length) return false;
  const product = candidate.standardProduct;
  if (['ip', 'email'].includes(product.platformGroup ?? groupCatalogPlatforms([product.platform])[0]!)
    || !['账号与订阅', '订阅', 'subscription', 'account'].includes(product.kind)) return false;
  // Navigation groups also contain mailboxes, YouTube and X; use standard identities, never offer marketing.
  const aiPackage = [product.name, ...product.identityNames ?? []].some(name =>
    /(?<![a-z0-9_])(?:chatgpt|gpt|codex|claude|gemini|cursor|grok|supergrok|perplexity|copilot|manus|suno|firefly)(?![a-z0-9_])/iu.test(name.normalize('NFKC')));
  return aiPackage && ['top_up', 'account'].includes(tag(candidate, 'delivery') ?? '')
    && (warrantyDays(candidate) ?? -1) >= 30;
}

function matchesPlatform(product: PublicCatalogProduct, requested: string): boolean {
  const platform = normalizeCatalogPlatform(requested);
  const isGroup = platform === 'other' || CATALOG_PLATFORMS.some(group => group.id === platform);
  return isGroup ? (product.platformGroup ?? groupCatalogPlatforms([product.platform])[0]) === platform
    : product.platform.trim().toLowerCase() === platform;
}

export function matchesRequestedProduct(product: PublicCatalogProduct, needs: ShoppingNeeds): boolean {
  if (needs.platform && !matchesPlatform(product, needs.platform)) return false;
  if (!needs.product) return true;
  const words = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\bgpt\b/gu, 'chatgpt')
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const requested = words(needs.product);
  // Only standard identities establish product matches, never merchant names or offer marketing.
  return requested.length > 0 && [product.name, ...product.identityNames ?? []].some(name => {
    const terms = words(name);
    return requested.every(word => terms.includes(word));
  });
}

function money(value: string | null): bigint | undefined {
  if (value === null || !/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/u.test(value)) return undefined;
  const [whole, decimal = ''] = value.split('.');
  return BigInt(whole!) * 100n + BigInt(decimal.padEnd(2, '0'));
}

const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const compareMoney = (a: bigint, b: bigint): number => a < b ? -1 : a > b ? 1 : 0;

function priceOrder(a: AssistantCandidate, b: AssistantCandidate): number {
  // Group incompatible payment scopes before comparing prices; never convert currencies or annual fees.
  const currency = compareText(a.offer.currency, b.offer.currency);
  const durationA = tag(a, 'duration');
  const durationB = tag(b, 'duration');
  return currency || (durationA === undefined ? durationB === undefined ? 0 : 1
    : durationB === undefined ? -1 : compareText(durationA, durationB))
    || (durationA !== undefined && durationA === durationB
      ? compareMoney(money(a.offer.price)!, money(b.offer.price)!) : 0);
}

function purchaseFacets(candidate: AssistantCandidate): Map<string, Set<string>> {
  const facets = new Map<string, Set<string>>();
  for (const tag of candidate.offer.tags) {
    const field = PURCHASE_GUIDE_FIELDS[tag.name];
    if (!field) continue;
    const values = facets.get(field.collectionGroup) ?? new Set<string>();
    values.add(JSON.stringify([tag.name, tag.value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()]));
    facets.set(field.collectionGroup, values);
  }
  return facets;
}

function facetDistance(a: Map<string, Set<string>>, b: Map<string, Set<string>>): number {
  let distance = 0;
  let total = 0;
  for (const group of new Set([...a.keys(), ...b.keys()])) {
    // Bound each facet's influence: more login tags must not outweigh a different purchase gate.
    const weight = group === '其他使用条件' ? 4 : ['交付形态', '使用方式'].includes(group) ? 2 : 1;
    const left = a.get(group);
    const right = b.get(group);
    const union = new Set([...left ?? [], ...right ?? []]);
    const shared = [...left ?? []].filter(value => right?.has(value)).length;
    // Unknown conditions are distinct evidence, never evidence of unrestricted use.
    distance += weight * (!left || !right ? 0.5 : 1 - shared / union.size);
    total += weight;
  }
  return total ? distance / total : 0;
}

export function selectCandidates(candidates: AssistantCandidate[], needs: ShoppingNeeds, now: Date, limit = 3): AssistantCandidate[] {
  if (!Number.isFinite(now.getTime())) return [];
  const eligible = candidates.flatMap(candidate => {
    const { offer, standardProduct } = candidate;
    const price = money(offer.price);
    if (standardProduct.mergedIntoId || price === undefined
      || !/^[A-Z]{3}$/u.test(offer.currency)
      || offer.settlementQuantity !== 1
      || offer.tags.some(tag => tag.name === 'minimum_quantity' && tag.value !== '1')
      || !matchesRequestedProduct(standardProduct, needs)
      || !needs.requiredTags.every(required => required.value !== 'unknown' && tag(candidate, required.name) === required.value)
      || (needs.warrantyDaysMin !== null && (warrantyDays(candidate) ?? -1) < needs.warrantyDaysMin)) return [];
    if (needs.budget) {
      const budget = money(needs.budget.amount);
      if (budget === undefined || offer.currency !== needs.budget.currency || price > budget
        || (needs.budget.basis === 'month' && tag(candidate, 'duration') !== '1 month')) return [];
    }
    const capabilityEvidence = candidate.capabilityEvidence.filter(evidence =>
      Date.parse(evidence.checkedAt) <= now.getTime() && Date.parse(evidence.reviewAfter) > now.getTime()
      && (!needs.purpose || capabilitySupportsPurpose(evidence, needs.purpose, now)));
    if (needs.purpose && !needs.platform && !needs.product && capabilityEvidence.length === 0) return [];
    return [{ ...candidate, capabilityEvidence }];
  });
  eligible.sort((a, b) => {
    for (const preference of needs.preferences) {
      if (preference === 'lower_price') {
        const order = priceOrder(a, b);
        if (order) return order;
      }
      if (preference === 'longer_warranty') {
        const daysA = warrantyDays(a);
        const daysB = warrantyDays(b);
        const order = (daysB ?? -1) - (daysA ?? -1);
        if (order) return order;
      }
      if (preference === 'simple_setup') {
        const stepsA = setupSteps(a);
        const stepsB = setupSteps(b);
        const order = stepsA === undefined ? stepsB === undefined ? 0 : 1
          : stepsB === undefined ? -1 : stepsA - stepsB;
        if (order) return order;
      }
    }
    return Number(isBeginnerRecommendation(b, needs)) - Number(isBeginnerRecommendation(a, needs))
      || priceOrder(a, b) || compareText(a.standardProduct.id, b.standardProduct.id)
      || compareText(a.offer.shopId, b.offer.shopId) || compareText(a.offer.productId, b.offer.productId);
  });
  const seen = new Set<string>();
  const unique = eligible.filter(candidate => {
    const key = JSON.stringify([candidate.offer.shopId, candidate.offer.productId]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const facets = unique.map(purchaseFacets);
  const selected = new Set<number>();
  const nearest = unique.map(() => 1);
  if (unique.length && limit > 0) selected.add(0);
  // MMR: keep the best ranked offer, then balance rank with distance to the nearest selected offer.
  // Text equality here is lexical; the existing explanation call handles semantic paraphrases.
  let last = 0;
  while (selected.size < Math.min(limit, unique.length)) {
    let best = -1;
    let bestScore = -Infinity;
    for (const [index, candidate] of unique.entries()) {
      if (selected.has(index)) continue;
      nearest[index] = Math.min(nearest[index]!, candidate.standardProduct.id !== unique[last]!.standardProduct.id
        ? 1 : facetDistance(facets[index]!, facets[last]!));
      // Default newcomer suitability outranks diversity; other offers remain available as fallbacks.
      const score = 2 * Number(isBeginnerRecommendation(candidate, needs)) + 0.2 / (index + 1) + 0.8 * nearest[index]!;
      if (score > bestScore) { best = index; bestScore = score; }
    }
    selected.add(best);
    last = best;
  }
  return unique.filter((_, index) => selected.has(index));
}

export function candidateEvidence(candidate: AssistantCandidate): Array<{ id: string; text: string }> {
  const { offer } = candidate;
  const scope = JSON.stringify([candidate.standardProduct.id, offer.shopId, offer.productId]);
  const fact = (key: string, text: string) => ({
    id: `candidate:${createHash('sha256').update(JSON.stringify([scope, key, text])).digest('hex').slice(0, 32)}`,
    text: text.length <= 240 && !/https?:\/\/|www\./iu.test(text) ? text
      : '该报价含较长条款或外部链接，请在商品详情核实完整内容。',
  });
  const tags = [...offer.tags].sort((a, b) => compareText(a.name, b.name) || compareText(a.value, b.value));
  const conflictingWarranty = tags.some(tag => tag.name.startsWith('warranty')
    && !['warranty_terms', 'warranty_exclusion'].includes(tag.name)
    && tags.some(other => other.name === tag.name && other.value !== tag.value));
  const warranty = conflictingWarranty ? '资料存在冲突，请在商品详情核实' : purchaseWarrantyLabel(tags);
  const facts = [
    fact('price', `采集参考价为 ${offer.price ?? '未知'} ${offer.currency}，结算数量为 ${offer.settlementQuantity} 件；实际价格以商家为准。`),
    fact('availability', `采集于 ${offer.capturedAt}；采集时库存：${offer.inStock ? '有货' : '无货'}。同步存在时间差，实际价格与库存请向商家确认。`),
    fact('warranty', warranty
      ? `商家质保说明：${warranty}；具体限制以该报价的售后条款为准。`
      : '商家未明确质保时长与保障范围，请在商品详情核实不保事项和售后条款。'),
    ...tags.map(tag => {
      const label = tag.name === 'setup_steps' ? '明确操作步骤数' : PURCHASE_GUIDE_FIELDS[tag.name]?.label ?? tag.name;
      const value = tag.name === 'delivery' && tag.value === 'top_up' ? '代充：给你已有账号充值，下单前确认账号条件和充值流程。'
        : tag.name === 'delivery' && tag.value === 'account' ? '成品号：商家提供一个账号，下单前确认登录方式、是否独享及能否改密。'
        : tag.name === 'warranty_exclusion' && tag.value === 'ban' ? '不保封号' : purchaseTagLabel(tag);
      return fact(`tag:${tag.name}:${tag.value}`, `${label}：${value}`);
    }),
    ...[...candidate.capabilityEvidence].sort((a, b) => compareText(a.id, b.id))
      .map(evidence => fact(`capability:${evidence.id}`, evidence.statement)),
  ];
  return [...new Map(facts.map(fact => [fact.id, fact])).values()];
}

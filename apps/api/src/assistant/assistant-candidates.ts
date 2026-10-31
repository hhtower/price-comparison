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

function matchesPlatform(product: PublicCatalogProduct, requested: string): boolean {
  const platform = normalizeCatalogPlatform(requested);
  const isGroup = platform === 'other' || CATALOG_PLATFORMS.some(group => group.id === platform);
  return isGroup ? (product.platformGroup ?? groupCatalogPlatforms([product.platform])[0]) === platform
    : product.platform.trim().toLowerCase() === platform;
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

export function selectCandidates(candidates: AssistantCandidate[], needs: ShoppingNeeds, now: Date): AssistantCandidate[] {
  if (!Number.isFinite(now.getTime())) return [];
  const eligible = candidates.flatMap(candidate => {
    const { offer, standardProduct } = candidate;
    const price = money(offer.price);
    if (standardProduct.mergedIntoId || offer.priceStatus !== 'verified' || price === undefined
      || !/^[A-Z]{3}$/u.test(offer.currency) || offer.inStock !== true || offer.stale !== false
      || offer.settlementQuantity !== 1
      || offer.tags.some(tag => tag.name === 'minimum_quantity' && tag.value !== '1')
      || !(Date.parse(offer.priceExpiresAt ?? '') > now.getTime())
      || !(Date.parse(offer.inventoryExpiresAt ?? '') > now.getTime())
      || (needs.platform && !matchesPlatform(standardProduct, needs.platform))
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
    if (needs.purpose && capabilityEvidence.length === 0) return [];
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
    return priceOrder(a, b) || compareText(a.standardProduct.id, b.standardProduct.id)
      || compareText(a.offer.shopId, b.offer.shopId) || compareText(a.offer.productId, b.offer.productId);
  });
  const seen = new Set<string>();
  return eligible.filter(candidate => {
    const key = JSON.stringify([candidate.offer.shopId, candidate.offer.productId]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 3);
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
    fact('price', `该报价为 ${offer.price ?? '未知'} ${offer.currency}，结算数量为 ${offer.settlementQuantity} 件；价格状态：${offer.priceStatus === 'verified' ? '已核验' : '未核验或已过期'}。`),
    fact('availability', `快照库存：${offer.inStock ? '有货' : '无货'}；${offer.stale ? '数据已陈旧' : '数据未标记陈旧'}。采集于 ${offer.capturedAt}；价格有效至 ${offer.priceExpiresAt ?? '未知'}；库存有效至 ${offer.inventoryExpiresAt ?? '未知'}。`),
    fact('warranty', warranty
      ? `商家质保说明：${warranty}；具体限制以该报价的售后条款为准。`
      : '商家未明确质保时长与保障范围，请在商品详情核实不保事项和售后条款。'),
    ...tags.map(tag => {
      const label = tag.name === 'setup_steps' ? '明确操作步骤数' : PURCHASE_GUIDE_FIELDS[tag.name]?.label ?? tag.name;
      const value = tag.name === 'warranty_exclusion' && tag.value === 'ban' ? '不保封号' : purchaseTagLabel(tag);
      return fact(`tag:${tag.name}:${tag.value}`, `${label}：${value}`);
    }),
    ...[...candidate.capabilityEvidence].sort((a, b) => compareText(a.id, b.id))
      .map(evidence => fact(`capability:${evidence.id}`, evidence.statement)),
  ];
  return [...new Map(facts.map(fact => [fact.id, fact])).values()];
}

import { normalizePurchaseTag, purchaseTagLabel } from '@price-comparison/catalog/purchase-attributes';

export function displayPurchaseTagValue(tag) {
  const normalized = normalizePurchaseTag(tag)[0];
  return normalized ? purchaseTagLabel(normalized) : '';
}

export function displayPurchaseTagText(tag, value = displayPurchaseTagValue(tag)) {
  return tag.name === 'supported_client' && value ? '支持' + value : value;
}

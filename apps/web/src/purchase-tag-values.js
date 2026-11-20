import { normalizePurchaseTag, purchaseTagLabel } from '@price-comparison/catalog/purchase-attributes';

export function displayPurchaseTagValue(tag) {
  const normalized = normalizePurchaseTag(tag)[0];
  return normalized ? purchaseTagLabel(normalized) : '';
}

export function displayPurchaseTagText(tag, value = displayPurchaseTagValue(tag)) {
  if (value && value !== '首登' && ['subscription_warranty', 'usage_warranty'].includes(tag.name)) {
    const scope = tag.name === 'subscription_warranty' ? '订阅' : '使用';
    return scope + value.replace('（期限未注明）', '').replace(/\s+/gu, '');
  }
  return tag.name === 'supported_client' && value ? '支持' + value : value;
}

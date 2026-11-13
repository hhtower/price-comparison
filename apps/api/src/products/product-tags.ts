import { isCanonicalProductTag, PRODUCT_TAG_RULES } from '@price-comparison/catalog/product-tag-policy';
import { tagValueKey, type PurchaseTag, type TagValue } from '@price-comparison/catalog/purchase-attributes';
import { DomainValidationError } from '../common/errors.js';

export function validateProductTags(tags: readonly { name: string; value: unknown }[]): PurchaseTag[] {
  if (!Array.isArray(tags) || tags.length > 100) throw new DomainValidationError('INVALID_TAGS', '标签列表无效');
  const result: PurchaseTag[] = [];
  for (const tag of tags) {
    if (!tag || typeof tag.name !== 'string' || !isCanonicalProductTag(tag)) {
      throw new DomainValidationError('INVALID_TAG', '标签字段或值不符合当前定义');
    }
    const previous = result.filter(item => item.name === tag.name);
    if (previous.some(item => tagValueKey(item.value) === tagValueKey(tag.value))) continue;
    if (previous.length && !PRODUCT_TAG_RULES[tag.name]!.multiple) {
      throw new DomainValidationError('TAG_CONFLICT', '同一标签存在相互冲突的值');
    }
    result.push({ name: tag.name, value: tag.value });
  }
  return result;
}

/** URL values are serialized JSON for duration; ordinary text dimensions stay text. */
export function readTagQueryValue(name: string, value: string): TagValue {
  let parsed: unknown = value;
  if (name === 'duration') {
    try { parsed = JSON.parse(value); } catch { throw new DomainValidationError('INVALID_TAG', '期限必须是数值天数'); }
  }
  return validateProductTags([{ name, value: parsed }])[0]!.value;
}

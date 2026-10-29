import { Inject, Injectable } from '@nestjs/common';
import { DomainNotFoundError, DomainValidationError } from '../common/errors.js';
import {
  ProductsRepository,
  type Product,
  type ProductUpdate,
  type ProductUpsert,
} from './products.repository.js';

@Injectable()
export class ProductsService {
  constructor(@Inject(ProductsRepository) private readonly products: ProductsRepository) {}

  upsertBatch(input: readonly ProductUpsert[]): Promise<ReadonlyMap<string, bigint>> {
    if (input.length === 0) throw new DomainValidationError('EMPTY_PRODUCTS', '至少提供一个商品');
    return this.products.upsertBatch(input.map(normalizeProduct));
  }

  async get(id: bigint): Promise<Product> {
    const product = await this.products.findById(id);
    if (!product) throw new DomainNotFoundError('PRODUCT_NOT_FOUND', '商品不存在');
    return product;
  }

  async update(id: bigint, input: ProductUpdate): Promise<Product> {
    if (Object.keys(input).length === 0) throw new DomainValidationError('EMPTY_UPDATE', '至少提供一个待修改字段');
    const product = await this.products.update(id, normalizeUpdate(input));
    if (!product) throw new DomainNotFoundError('PRODUCT_NOT_FOUND', '商品不存在');
    return product;
  }

  async remove(id: bigint): Promise<void> {
    if (!(await this.products.softDelete(id))) throw new DomainNotFoundError('PRODUCT_NOT_FOUND', '商品不存在');
  }

  async removeBatch(ids: readonly bigint[]): Promise<{ success: string[]; failures: { id: string; reason: string }[] }> {
    if (!ids.length) throw new DomainValidationError('EMPTY_PRODUCTS', '至少提供一个商品');
    if (ids.some(id => id < 1n || id > 9223372036854775807n)) {
      throw new DomainValidationError('INVALID_ID', 'productIds 必须是有效的商品 ID');
    }
    const productIds = [...new Set(ids)];
    const deletedIds = new Set(await this.products.softDeleteBatch(productIds));
    return {
      success: productIds.filter(id => deletedIds.has(id)).map(String),
      failures: productIds.filter(id => !deletedIds.has(id)).map(id => ({ id: String(id), reason: '商品不存在或已删除' })),
    };
  }

  async restore(id: bigint): Promise<Product> {
    const product = await this.products.restore(id);
    if (!product) throw new DomainNotFoundError('PRODUCT_NOT_FOUND', '商品不存在或未删除');
    return product;
  }

  restoreBatch(ids: readonly bigint[]): Promise<{ success: string[]; failures: { id: string; reason: string }[] }> {
    if (!ids.length) throw new DomainValidationError('EMPTY_PRODUCTS', '至少提供一个商品');
    if (ids.some(id => id < 1n || id > 9223372036854775807n)) {
      throw new DomainValidationError('INVALID_ID', 'productIds 必须是有效的商品 ID');
    }
    return this.products.restoreBatch(ids);
  }

  listTags(id: bigint) { return this.products.listTags(id); }

  async replaceTags(id: bigint, tags: readonly { name: string; value: string }[]) {
    await this.get(id);
    const normalized = tags.map((tag) => ({ name: required(tag.name, 'name'), value: required(tag.value, 'value') }));
    return this.products.replaceTags(id, normalized);
  }

  assignStandardProduct(id: bigint, standardProductId: bigint | null, confirmEvidenceConflict = false): Promise<void> {
    return this.products.assignStandardProduct(id, standardProductId, undefined, confirmEvidenceConflict);
  }

}

function normalizeProduct(input: ProductUpsert): ProductUpsert {
  if (!input.shopId || input.shopId < 1n) throw new DomainValidationError('INVALID_SHOP_ID', 'shopId 无效');
  return {
    ...input,
    sourceName: input.sourceName ?? input.name,
    externalId: required(input.externalId, 'externalId'),
    name: required(input.name, 'name'),
    normalizedKey: required(input.normalizedKey, 'normalizedKey'),
    url: required(input.url, 'url'),
  };
}

function normalizeUpdate(input: ProductUpdate): ProductUpdate {
  if (input.name !== undefined) required(input.name, 'name');
  return {
    ...input,
    ...(input.normalizedKey !== undefined ? { normalizedKey: required(input.normalizedKey, 'normalizedKey') } : {}),
    ...(input.url !== undefined ? { url: required(input.url, 'url') } : {}),
  };
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new DomainValidationError('REQUIRED_FIELD', `${field} 不能为空`, { field });
  return normalized;
}

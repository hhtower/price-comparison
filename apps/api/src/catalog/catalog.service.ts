import { Inject, Injectable } from '@nestjs/common';
import { CACHE, type Cache } from '../cache/cache.js';
import { CatalogRepository, type CatalogFacets, type CatalogPage, type CatalogQuery, type CatalogSort, type CatalogTag } from './catalog.repository.js';
import { DomainValidationError } from '../common/errors.js';
import { normalizePurchaseTag, parseCatalogSearch } from '@price-comparison/catalog/purchase-attributes';
import { normalizeCatalogPlatform } from '@price-comparison/catalog/platform-groups';

export interface CatalogQueryInput {
  readonly sort?: string;
  readonly view?: string;
  readonly standardProductId?: unknown;
  readonly shopQuery?: unknown;
  readonly shopId?: unknown;
  readonly priceMin?: unknown;
  readonly priceMax?: unknown;
  readonly currency?: unknown;
  readonly offerSort?: unknown;
  readonly detailKind?: unknown;
  readonly detailPage?: unknown;
  readonly detailPageSize?: unknown;
  readonly platform?: string;
  readonly q?: string;
  readonly search?: string;
  readonly searchMode?: unknown;
  readonly tags?: readonly CatalogTag[];
  readonly tag?: readonly CatalogTag[] | CatalogTag | string | readonly string[];
  readonly cursor?: string;
  readonly limit?: number;
  readonly warrantyDaysMin?: number;
  readonly newcomer?: unknown;
}

export function normalizeCatalogQuery(input: CatalogQueryInput): CatalogQuery {
  if (input.newcomer !== undefined && ![true, false, 'true', 'false'].includes(input.newcomer as boolean | string)) {
    throw new DomainValidationError('INVALID_NEWCOMER_MODE', '新手模式参数无效');
  }
  if (input.sort !== undefined && !['default', 'price', 'updated'].includes(input.sort)) {
    throw new DomainValidationError('INVALID_SORT', '排序方式无效');
  }
  if (input.view !== undefined && input.view !== 'summary' && input.view !== 'full') {
    throw new DomainValidationError('INVALID_VIEW', '目录视图无效');
  }
  const standardProductId = input.standardProductId;
  if (standardProductId !== undefined && (typeof standardProductId !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(standardProductId) || BigInt(standardProductId) >= 2n ** 63n)) {
    throw new DomainValidationError('INVALID_STANDARD_PRODUCT', '商品编号无效');
  }
  const shopId = input.shopId;
  if (shopId !== undefined && (typeof shopId !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(shopId) || BigInt(shopId) >= 2n ** 63n)) {
    throw new DomainValidationError('INVALID_SHOP', '店铺编号无效');
  }
  if (input.shopQuery !== undefined && typeof input.shopQuery !== 'string') {
    throw new DomainValidationError('INVALID_SHOP_QUERY', '店铺搜索内容无效');
  }
  const shopQuery = input.shopQuery?.normalize('NFKC').trim();
  if (shopQuery && shopQuery.length > 100) throw new DomainValidationError('INVALID_SHOP_QUERY', '店铺搜索不能超过100个字符');
  const priceBound = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if ((typeof value !== 'string' && typeof value !== 'number') || !/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/u.test(String(value))) {
      throw new DomainValidationError('INVALID_PRICE_RANGE', '价格须为0至999999999999.99之间、最多两位小数的金额');
    }
    return Number(value).toFixed(2);
  };
  const priceMin = priceBound(input.priceMin);
  const priceMax = priceBound(input.priceMax);
  if (priceMin !== undefined && priceMax !== undefined && Number(priceMin) > Number(priceMax)) {
    throw new DomainValidationError('INVALID_PRICE_RANGE', '最低价格不能高于最高价格');
  }
  const currency = input.currency ?? (priceMin !== undefined || priceMax !== undefined ? 'CNY' : undefined);
  if (input.currency === null || (currency !== undefined && (typeof currency !== 'string' || !/^[A-Z]{3}$/u.test(currency)))) {
    throw new DomainValidationError('INVALID_CURRENCY', '币种须为三位大写字母');
  }
  const offerSort = input.offerSort;
  if (offerSort !== undefined && offerSort !== 'price' && offerSort !== 'priceDesc' && offerSort !== 'updated') {
    throw new DomainValidationError('INVALID_OFFER_SORT', '报价排序方式无效');
  }
  const hasDetail = input.detailKind !== undefined || input.detailPage !== undefined || input.detailPageSize !== undefined;
  const detailInteger = (value: unknown, fallback: number): number => value === undefined ? fallback
    : typeof value === 'number' ? value : typeof value === 'string' && /^(0|[1-9][0-9]*)$/u.test(value) ? Number(value) : Number.NaN;
  const detailPage = detailInteger(input.detailPage, 0);
  const detailPageSize = detailInteger(input.detailPageSize, 4);
  if (hasDetail && (!standardProductId || input.view === 'summary' || (input.detailKind !== 'offers' && input.detailKind !== 'shops')
    || !Number.isSafeInteger(detailPage) || detailPage < 0 || !Number.isSafeInteger(detailPageSize) || detailPageSize < 1 || detailPageSize > 50
    || !Number.isSafeInteger(detailPage * detailPageSize))) {
    throw new DomainValidationError('INVALID_DETAIL_QUERY', '详情分页需要有效商品、完整视图、详情类型和分页参数');
  }
  const search = String(input.search ?? input.q ?? '').normalize('NFKC').trim();
  if (search.length > 500) throw new DomainValidationError('INVALID_SEARCH', '搜索内容不能超过500个字符');
  if (input.searchMode !== undefined && input.searchMode !== 'literal') {
    throw new DomainValidationError('INVALID_SEARCH_MODE', '搜索模式无效');
  }
  const parsed = input.searchMode === 'literal' ? { text: search, tags: [], warrantyDaysMin: undefined } : parseCatalogSearch(search);
  const tagsInput = input.tags ?? input.tag;
  const supplied = Array.isArray(tagsInput) ? tagsInput : tagsInput ? [tagsInput] : [];
  if (supplied.length > 50) throw new DomainValidationError('INVALID_FILTER', '筛选条件不能超过50项');
  const explicit = supplied.flatMap((raw) => {
    let tag: unknown = raw;
    if (typeof tag === 'string') {
      try { tag = JSON.parse(tag); } catch { throw new DomainValidationError('INVALID_FILTER', '筛选条件格式无效'); }
    }
    if (!tag || typeof tag !== 'object' || !('name' in tag) || !('value' in tag)
      || typeof tag.name !== 'string' || typeof tag.value !== 'string'
      || !tag.name.trim() || !tag.value.trim() || tag.name.length > 80 || tag.value.length > 250) {
      throw new DomainValidationError('INVALID_FILTER', '筛选条件必须包含有效属性和值');
    }
    return normalizePurchaseTag({ name: tag.name, value: tag.value });
  });
  const explicitNames = new Set(explicit.map(tag => tag.name));
  // The parser preserves exact facts for labels; a minimum query must not also
  // require equality to its lower bound. Explicit exact-day API tags stay intact.
  const tags = [...parsed.tags.filter(tag => !explicitNames.has(tag.name)
    && !(parsed.warrantyDaysMin !== undefined && tag.name === 'warranty_days')), ...explicit]
    .map(({ name, value }) => ({ name, value }))
    .sort((a, b) => `${a.name}\u0000${a.value}`.localeCompare(`${b.name}\u0000${b.value}`));
  const uniqueTags = tags.filter((tag, index) => index === tags.findIndex((candidate) => candidate.name === tag.name && candidate.value === tag.value));
  const warrantyDaysMin = input.warrantyDaysMin ?? parsed.warrantyDaysMin;
  if (warrantyDaysMin !== undefined && (!Number.isSafeInteger(warrantyDaysMin) || warrantyDaysMin < 1 || warrantyDaysMin > 36500)) {
    throw new DomainValidationError('INVALID_WARRANTY_DAYS', '质保天数必须为1至36500的整数');
  }
  const limit = Number.isSafeInteger(input.limit) ? Number(input.limit) : 20;
  return {
    ...(input.sort && input.sort !== 'default' ? { sort: input.sort as CatalogSort } : {}),
    ...(input.view === 'summary' ? { view: 'summary' as const } : {}),
    ...(standardProductId ? { standardProductId } : {}),
    ...(shopQuery ? { shopQuery } : {}),
    ...(shopId ? { shopId } : {}),
    ...(priceMin !== undefined ? { priceMin } : {}),
    ...(priceMax !== undefined ? { priceMax } : {}),
    ...(currency ? { currency } : {}),
    ...(offerSort && offerSort !== 'price' ? { offerSort } : {}),
    ...(hasDetail ? { detailKind: input.detailKind as 'offers' | 'shops', detailPage, detailPageSize } : {}),
    ...(input.platform?.trim() ? { platform: normalizeCatalogPlatform(input.platform) } : {}),
    ...(parsed.text ? { search: parsed.text } : {}),
    tags: uniqueTags,
    ...(warrantyDaysMin !== undefined ? { warrantyDaysMin } : {}),
    ...(input.newcomer === true || input.newcomer === 'true' ? { newcomer: true } : {}),
    ...(input.cursor?.trim() ? { cursor: input.cursor.trim() } : {}),
    limit: Math.min(Math.max(limit, 1), 100),
  };
}

@Injectable()
export class CatalogService {
  constructor(
    @Inject(CatalogRepository) private readonly repository: CatalogRepository,
    @Inject(CACHE) private readonly cache: Cache,
  ) {}

  getProducts() { return this.repository.publicProducts(); }

  getCoverage() {
    return this.cache.wrap('catalog:coverage:v1', () => this.repository.coverage(), 300_000);
  }

  getProduct(id: string) {
    if (!/^[1-9][0-9]{0,18}$/u.test(id) || BigInt(id) >= 2n ** 63n) return Promise.resolve(null);
    return this.repository.publicProduct(id);
  }

  async getPriceHistory(id: string, productId?: unknown, currency?: unknown) {
    const query = normalizeCatalogQuery({ standardProductId: id, currency });
    const source = normalizeCatalogQuery({ standardProductId: productId });
    const product = await this.repository.publicProduct(id);
    if (!product || product.mergedIntoId) return null;
    return this.repository.priceHistory(id, source.standardProductId, query.currency ?? 'CNY');
  }

  async getFacets(input: Pick<CatalogQueryInput, 'platform' | 'q' | 'search' | 'searchMode' | 'tags' | 'tag' | 'warrantyDaysMin' | 'newcomer'
    | 'standardProductId' | 'shopQuery' | 'shopId' | 'priceMin' | 'priceMax' | 'currency' | 'offerSort'>): Promise<CatalogFacets> {
    const { limit: _limit, offerSort: _offerSort, ...query } = normalizeCatalogQuery({
      platform: input.platform, q: input.q, search: input.search, searchMode: input.searchMode, tags: input.tags, tag: input.tag, warrantyDaysMin: input.warrantyDaysMin, newcomer: input.newcomer,
      standardProductId: input.standardProductId, shopQuery: input.shopQuery, shopId: input.shopId,
      priceMin: input.priceMin, priceMax: input.priceMax, currency: input.currency, offerSort: input.offerSort,
    });
    return this.readFresh(() => this.repository.facets(query));
  }

  async getCatalog(input: CatalogQueryInput): Promise<CatalogPage> {
    const query = normalizeCatalogQuery(input);
    return this.readFresh(() => this.repository.search(query));
  }

  private async readFresh<T extends { readonly nextExpiryAt?: string | null }>(loader: () => Promise<T>): Promise<T> {
    for (;;) {
      const result = await loader();
      if (!result.nextExpiryAt || Date.parse(result.nextExpiryAt) > Date.now()) return result;
      // Refresh the complete snapshot when a read crosses a relevant deadline.
    }
  }
}

export type { CatalogQuery, CatalogPage } from './catalog.repository.js';

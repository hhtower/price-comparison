import { Controller, Get, Inject, NotFoundException, Param, Query, ServiceUnavailableException } from '@nestjs/common';
import { CatalogService, type CatalogQueryInput } from './catalog.service.js';
import { DomainValidationError } from '../common/errors.js';

function catalogFilters(query: Record<string, unknown>): CatalogQueryInput {
  return {
    standardProductId: query.standardProductId,
    shopQuery: query.shopQuery,
    shopId: query.shopId,
    priceMin: query.priceMin,
    priceMax: query.priceMax,
    currency: query.currency,
    offerSort: query.offerSort,
    platform: typeof query.platform === 'string' ? query.platform : undefined,
    q: typeof query.q === 'string' ? query.q : undefined,
    searchMode: query.searchMode,
    newcomer: query.newcomer,
    warrantyDaysMin: typeof query.warrantyDaysMin === 'string' ? Number(query.warrantyDaysMin) : undefined,
    tag: query.tag === undefined ? undefined : (Array.isArray(query.tag) ? query.tag : [query.tag]).map(String),
  };
}

@Controller({ path: 'catalog', version: '1' })
export class CatalogController {
  constructor(@Inject(CatalogService) private readonly service: CatalogService) {}

  @Get('coverage')
  async getCoverage() {
    try { return await this.service.getCoverage(); }
    catch (error) { throw new ServiceUnavailableException('数据覆盖统计暂时不可用', { cause: error }); }
  }

  @Get('products')
  async getProducts() {
    try { return await this.service.getProducts(); }
    catch (error) { throw new ServiceUnavailableException('商品目录暂时不可用', { cause: error }); }
  }

  @Get('products/:id')
  async getProduct(@Param('id') id: string) {
    const product = await this.service.getProduct(id).catch(error => {
      throw new ServiceUnavailableException('商品信息暂时不可用', { cause: error });
    });
    if (!product) throw new NotFoundException('商品不存在');
    return product;
  }

  @Get('products/:id/price-history')
  async getPriceHistory(@Param('id') id: string, @Query() query: Record<string, unknown>) {
    const history = await this.service.getPriceHistory(id, query.productId, query.currency);
    if (!history) throw new NotFoundException('商品不存在');
    return history;
  }

  @Get('facets')
  getFacets(@Query() query: Record<string, unknown>) {
    return this.service.getFacets(catalogFilters(query));
  }

  @Get()
  getCatalog(@Query() query: Record<string, unknown>) {
    const hasDetail = query.detailKind !== undefined || query.detailPage !== undefined || query.detailPageSize !== undefined;
    if (hasDetail && ((query.view !== undefined && typeof query.view !== 'string')
      || (query.standardProductId !== undefined && typeof query.standardProductId !== 'string'))) {
      throw new DomainValidationError('INVALID_DETAIL_QUERY', '详情视图参数无效');
    }
    const input: CatalogQueryInput = {
      ...catalogFilters(query),
      sort: typeof query.sort === 'string' ? query.sort : undefined,
      view: typeof query.view === 'string' ? query.view : undefined,
      detailKind: query.detailKind,
      detailPage: query.detailPage,
      detailPageSize: query.detailPageSize,
      cursor: typeof query.cursor === 'string' ? query.cursor : undefined,
      limit: typeof query.limit === 'string' ? Number(query.limit) : undefined,
    };
    return this.service.getCatalog(input);
  }
}

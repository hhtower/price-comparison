import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, UseGuards, ValidationPipe } from '@nestjs/common';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { AuthGuard } from '../auth/auth.guard.js';
import { parsePositiveBigint } from '../common/pagination.js';
import { DomainValidationError } from '../common/errors.js';
import { AdminRepository } from './admin.repository.js';
import type { AdminAiJobRow, AdminProductRow, AdminRunHistoryRow, AdminShopRow, AdminStandardProductRow, AdminTagRow } from './admin.repository.js';
import type { AiJobListFilter, PlatformListFilter, ProductListFilter, RunHistoryListFilter, ShopListFilter, StandardProductListFilter, TagListFilter } from './admin.repository.js';
import {
  AdminPageQueryDto,
  ListAiJobsQueryDto,
  ListProductsQueryDto,
  ListPlatformsQueryDto,
  ListRunHistoryQueryDto,
  ListShopsQueryDto,
  ListStandardProductsQueryDto,
  ListTagsQueryDto,
} from './dto/admin-query.dto.js';
import type { JsonValue } from '../database/types.js';
import { publicationEvidenceConflict } from '../standardization/publication-evidence.js';
import { standardProductDisplayName } from '@price-comparison/catalog/catalog-display';
import { ListStandardProductPlatformsQueryDto } from './dto/admin-query.dto.js';

const MAX_POSTGRESQL_BIGINT = 9223372036854775807n;

interface PageResponse<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
  readonly total?: number;
  readonly page?: number;
  readonly pageSize?: number;
}

interface ShopResponse {
  readonly id: string;
  readonly protocol: string | null;
  readonly platform: string;
  readonly url: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly lastFetchAt: Date | null;
  readonly lastError: string | null;
}

interface ProductResponse {
  readonly id: string;
  readonly shopId: string;
  readonly shopName: string | null;
  readonly externalId: string;
  readonly name: string;
  readonly spec: string;
  readonly sourceCategory: string;
  readonly sourceData: JsonValue;
  readonly normalizedKey: string;
  readonly url: string;
  readonly imageUrl: string | null;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
  readonly standardProductName: string | null;
  readonly standardizationOutcome: 'classified' | 'cannot_process' | null;
  readonly tags: JsonValue;
  readonly latestPrice: string | null;
  readonly latestCurrency: string | null;
  readonly evidenceConflict: string | null;
  readonly processingSummary?: AdminProductRow['processing_summary'];
}

interface StandardProductResponse {
  readonly aliases: readonly string[];
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly canonicalFamily: string | null;
  readonly canonicalProduct: string | null;
  readonly canonicalTier: string | null;
  readonly sortOrder: string;
  readonly standardKey: string | null;
  readonly hidden: boolean;
  readonly mergedIntoId: string | null;
  readonly memberCount: string;
  readonly shopCount: string;
}

interface TagResponse {
  readonly id: string;
  readonly productId: string;
  readonly name: string;
  readonly value: string;
  readonly productCount: string;
}

interface AiJobResponse {
  readonly id: string;
  readonly status: AdminAiJobRow['status'];
  readonly total: string;
  readonly processed: string;
  readonly applied: string;
  readonly model: string;
  readonly autoApply: boolean;
  readonly error: string | null;
  readonly createdAt: Date;
  readonly finishedAt: Date | null;
  readonly scopeShopId: string | null;
  readonly promptVersion: string;
  readonly phase: string;
  readonly pauseRequested: boolean;
  readonly cancelRequested: boolean;
  readonly failedBatches: string;
}

interface RunHistoryResponse {
  readonly id: string;
  readonly shopId: string;
  readonly shopName: string | null;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly status: AdminRunHistoryRow['status'];
  readonly itemCount: string;
  readonly error: string | null;
  readonly settlementReport?: unknown;
  readonly taskType: AdminRunHistoryRow['task_type'];
  readonly sourceFetchRunId: string | null;
  readonly crawlMetrics: unknown;
}
class PlatformDto { @IsString() name!: string }
class StandardProductCreateDto { @IsString() family!: string; @IsString() product!: string; @IsString() tier!: string; @IsOptional() @IsString() platform?: string; @IsArray() @ArrayNotEmpty() @IsString({ each: true }) productIds!: string[]; @IsOptional() @IsBoolean() confirmEvidenceConflict?: boolean }
class StandardProductVisibilityDto { @IsBoolean() hidden!: boolean }
class StandardProductBatchVisibilityDto extends StandardProductVisibilityDto {
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(1000) @IsString({ each: true }) ids!: string[];
}
class PlatformBatchStatusDto {
  @Transform(({ value }: { value: unknown }) => Array.isArray(value) ? value.map(item => typeof item === 'string' ? item.trim() : item) : value)
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(1000) @IsString({ each: true }) @IsNotEmpty({ each: true }) @MaxLength(50, { each: true }) names!: string[];
  @IsBoolean() enabled!: boolean;
}
class StandardProductMergeDto { @IsString() targetId!: string; @IsArray() @ArrayNotEmpty() @IsString({ each: true }) sourceIds!: string[]; @IsOptional() @IsBoolean() confirmEvidenceConflict?: boolean }
class StandardProductBindDto { @IsArray() @ArrayNotEmpty() @IsString({ each: true }) productIds!: string[]; @IsString() standardProductId!: string; @IsOptional() @IsBoolean() confirmOwnershipChange?: boolean; @IsOptional() @IsBoolean() confirmEvidenceConflict?: boolean }
class TagBindDto { @IsArray() @ArrayNotEmpty() @IsString({ each: true }) productIds!: string[]; @IsString() name!: string; @IsString() value!: string }
class TagMutationDto { @IsString() name!: string; @IsString() value!: string; @IsOptional() @IsString() nextName?: string; @IsOptional() @IsString() nextValue?: string }
class StandardProductPatchDto {
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(80, { each: true }) aliases?: string[];
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() platform?: string;
  @IsOptional() @IsString() canonicalFamily?: string;
  @IsOptional() @IsString() canonicalProduct?: string;
  @IsOptional() @IsString() canonicalTier?: string;
}

@Controller({ path: 'admin', version: '1' })
@UseGuards(AuthGuard)
export class AdminController {
  constructor(@Inject(AdminRepository) private readonly service: AdminRepository) {}

  @Get('shops')
  async listShops(@Query(new ValidationPipe({ expectedType: ListShopsQueryDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) query: ListShopsQueryDto): Promise<PageResponse<ShopResponse>> {
    const page = await this.service.listShops({
      ...pageRequest(query),
      ...(query.standardProductId === undefined ? {} : { standardProductId: parseId(query.standardProductId, 'standardProductId') }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.keyword === undefined ? {} : { keyword: query.keyword }),
    } satisfies ShopListFilter);
    return pageOf(page.items.map(toShopResponse), page);
  }

  @Get('products')
  async listProducts(@Query(new ValidationPipe({ expectedType: ListProductsQueryDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) query: ListProductsQueryDto): Promise<PageResponse<ProductResponse>> {
    const filter: ProductListFilter = {
      ...pageRequest(query),
      ...(query.standardProductId === undefined ? {} : { standardProductId: parseId(query.standardProductId, 'standardProductId') }),
      ...(query.shopId === undefined ? {} : { shopId: parseId(query.shopId, 'shopId') }),
      ...(query.keyword === undefined ? {} : { keyword: query.keyword }),
      ...(query.standardized === undefined ? {} : { standardized: query.standardized }),
      ...(query.pending === undefined ? {} : { pending: query.pending }),
      ...(query.deleted === undefined ? {} : { deleted: query.deleted }),
    };
    const page = await this.service.listProducts(filter);
    return pageOf(page.items.map(toProductResponse), page);
  }

  @Get('standard-products')
  async listStandardProducts(@Query(new ValidationPipe({ expectedType: ListStandardProductsQueryDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) query: ListStandardProductsQueryDto): Promise<PageResponse<StandardProductResponse>> {
    const filter: StandardProductListFilter = {
      ...pageRequest(query),
      ...(query.keyword === undefined ? {} : { keyword: query.keyword }),
      ...(query.platform === undefined ? {} : { platform: query.platform }),
      ...(query.status === undefined ? {} : { status: query.status }),
    };
    const page = await this.service.listStandardProducts(filter);
    return pageOf(page.items.map(toStandardProductResponse), page);
  }

  @Get('standard-products/platforms')
  async listStandardProductPlatforms(@Query(new ValidationPipe({ expectedType: ListStandardProductPlatformsQueryDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) query: ListStandardProductPlatformsQueryDto): Promise<{ items: string[] }> {
    return { items: await this.service.listStandardProductPlatforms(query.status === 'all') };
  }

  @Post('standard-products')
  async createStandardProduct(@Body(new ValidationPipe({ expectedType: StandardProductCreateDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) body: StandardProductCreateDto) {
    return toStandardProductResponse(await this.service.createStandardProduct({ family: body.family, product: body.product, tier: body.tier }, body.platform ?? '', (body.productIds ?? []).map(id => parseId(id, 'productIds')), body.confirmEvidenceConflict ?? false));
  }

  @Patch('standard-products/:id')
  async updateStandardProduct(@Param('id') id: string, @Body(new ValidationPipe({ expectedType: StandardProductPatchDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) body: StandardProductPatchDto) {
    const row = await this.service.updateStandardProduct(parseId(id, 'id'), body);
    if (!row) throw new DomainValidationError('STANDARD_PRODUCT_NOT_FOUND', '标准商品不存在');
    return toStandardProductResponse(row);
  }

  @Delete('standard-products/:id')
  async deleteStandardProduct(@Param('id') id: string): Promise<void> {
    if (!(await this.service.deleteStandardProduct(parseId(id, 'id')))) throw new DomainValidationError('STANDARD_PRODUCT_NOT_FOUND', '标准商品不存在');
  }

  @Patch('standard-products/:id/visibility')
  async setStandardProductVisibility(@Param('id') id: string, @Body() body: StandardProductVisibilityDto) {
    if (!(await this.service.setStandardProductVisibility(parseId(id, 'id'), Boolean(body.hidden)))) throw new DomainValidationError('STANDARD_PRODUCT_NOT_FOUND', '标准商品不存在');
    return { ok: true, hidden: Boolean(body.hidden) };
  }

  @Post('standard-products/merge')
  async mergeStandardProducts(@Body() body: StandardProductMergeDto) {
    return this.service.mergeStandardProducts((body.sourceIds ?? []).map(id => parseId(id, 'sourceIds')), parseId(body.targetId, 'targetId'), body.confirmEvidenceConflict ?? false);
  }

  @Post('standard-products/batch-visibility')
  async setStandardProductsVisibility(@Body(new ValidationPipe({ expectedType: StandardProductBatchVisibilityDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) body: StandardProductBatchVisibilityDto) {
    return this.service.setStandardProductsVisibility(body.ids.map(id => parseId(id, 'ids')), body.hidden);
  }

  @Post('products/tags/bind')
  async bindTags(@Body(new ValidationPipe({ expectedType: TagBindDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) body: TagBindDto) {
    return this.service.bindTags((body.productIds ?? []).map(id => parseId(id, 'productIds')), body.name.trim(), body.value.trim());
  }

  @Post('products/standard-products/bind')
  async bindProducts(@Body(new ValidationPipe({ expectedType: StandardProductBindDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) body: StandardProductBindDto) {
    return this.service.bindProducts((body.productIds ?? []).map(id => parseId(id, 'productIds')), parseId(body.standardProductId, 'standardProductId'), body.confirmOwnershipChange ?? false, body.confirmEvidenceConflict ?? false);
  }

  @Delete('tags')
  async deleteTag(@Query() query: TagMutationDto) { if (!(await this.service.deleteTag(query.name, query.value))) throw new DomainValidationError('TAG_NOT_FOUND', '标签不存在'); }
  @Patch('tags')
  async renameTag(@Body() body: TagMutationDto) { if (!(await this.service.renameTag(body.name, body.value, body.nextName?.trim() ?? body.name, body.nextValue?.trim() ?? body.value))) throw new DomainValidationError('TAG_NOT_FOUND', '标签不存在'); return { ok: true }; }
  @Post('tags/merge')
  async mergeTags(@Body() body: TagMutationDto) { return this.service.mergeTags(body.name, body.value, body.nextName?.trim() ?? '', body.nextValue?.trim() ?? ''); }

  @Get('tags')
  async listTags(@Query(new ValidationPipe({ expectedType: ListTagsQueryDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) query: ListTagsQueryDto): Promise<PageResponse<TagResponse>> {
    const filter: TagListFilter = {
      ...pageRequest(query),
      ...(query.productId === undefined ? {} : { productId: parseId(query.productId, 'productId') }),
      ...(query.keyword === undefined ? {} : { keyword: query.keyword }),
      ...(query.name === undefined ? {} : { name: query.name }),
      ...(query.value === undefined ? {} : { value: query.value }),
    };
    const page = await this.service.listTags(filter);
    return pageOf(page.items.map(toTagResponse), page);
  }

  @Get('tags/products')
  async listTagProducts(@Query(new ValidationPipe({ expectedType: ListTagsQueryDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) query: ListTagsQueryDto) {
    if (!query.name || !query.value) throw new DomainValidationError('TAG_IDENTITY_REQUIRED', '标签名和值不能为空');
    const page = await this.service.listTagProducts(query.name, query.value, pageRequest(query));
    return pageOf(page.items.map(toProductResponse), page);
  }

  @Get('ai/jobs')
  async listAiJobs(@Query(new ValidationPipe({ expectedType: ListAiJobsQueryDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) query: ListAiJobsQueryDto): Promise<PageResponse<AiJobResponse>> {
    const filter: AiJobListFilter = {
      page: query.page,
      limit: query.limit,
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.shopId === undefined ? {} : { shopId: parseId(query.shopId, 'shopId') }),
    };
    const page = await this.service.listAiJobs(filter);
    return pageOf(page.items.map(toAiJobResponse), page);
  }

  @Get('run-history')
  async listRunHistory(@Query(new ValidationPipe({ expectedType: ListRunHistoryQueryDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) query: ListRunHistoryQueryDto): Promise<PageResponse<RunHistoryResponse>> {
    const filter: RunHistoryListFilter = {
      ...pageRequest(query),
      ...(query.shopId === undefined ? {} : { shopId: parseId(query.shopId, 'shopId') }),
      ...(query.status === undefined ? {} : { status: query.status }),
    };
    const page = await this.service.listRunHistory(filter);
    return pageOf(page.items.map(toRunHistoryResponse), page);
  }

  @Get('platforms')
  async listPlatforms(@Query(new ValidationPipe({ expectedType: ListPlatformsQueryDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) query: ListPlatformsQueryDto) {
    const page = await this.service.listPlatforms({ page: query.page, limit: query.limit, ...(query.keyword === undefined ? {} : { keyword: query.keyword }), ...(query.status === undefined ? {} : { status: query.status }) } satisfies PlatformListFilter);
    return { items: page.items.map((p) => ({ id: p.id, name: p.name, enabled: p.enabled, standardProductCount: p.standard_product_count.toString(), standard_product_count: p.standard_product_count.toString() })), total: page.total, page: page.page, pageSize: page.pageSize };
  }

  @Post('platforms')
  async createPlatform(@Body(new ValidationPipe({ expectedType: PlatformDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) body: PlatformDto) {
    return toPlatformResponse(await this.service.createPlatform(body.name.trim()));
  }

  @Post('platforms/batch-status')
  async setPlatformsEnabled(@Body(new ValidationPipe({ expectedType: PlatformBatchStatusDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) body: PlatformBatchStatusDto) {
    return this.service.setPlatformsEnabled(body.names, body.enabled);
  }

  @Patch('platforms/:id')
  async renamePlatform(@Param('id') id: string, @Body(new ValidationPipe({ expectedType: PlatformDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) body: PlatformDto) {
    const current = decodeURIComponent(id);
    const result = await this.service.renamePlatform(current, body.name.trim());
    if (!result) throw new DomainValidationError('PLATFORM_NOT_FOUND', '平台不存在');
    return toPlatformResponse(result);
  }

  @Delete('platforms/:id')
  async deletePlatform(@Param('id') id: string): Promise<void> {
    await this.service.deletePlatform(decodeURIComponent(id));
  }
}

function toPlatformResponse(row: { id: string; name: string; enabled: boolean; standard_product_count: bigint }) {
  return { id: row.id, name: row.name, enabled: row.enabled, standardProductCount: row.standard_product_count.toString(), standard_product_count: row.standard_product_count.toString() };
}

function pageRequest(query: AdminPageQueryDto): { cursor?: string; limit?: number; page?: number } {
  return {
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    ...(query.limit === undefined && query.pageSize === undefined ? {} : { limit: query.limit ?? query.pageSize }),
    ...(query.page === undefined ? {} : { page: query.page }),
  };
}

function parseId(value: string, field: string): bigint {
  const parsed = parsePositiveBigint(value, field);
  if (parsed > MAX_POSTGRESQL_BIGINT) {
    throw new DomainValidationError('INVALID_ID', `${field} 超出有效范围`, { field });
  }
  return parsed;
}

function pageOf<T>(items: readonly T[], page: { nextCursor?: string; total?: number; page?: number; pageSize?: number }): PageResponse<T> {
  return {
    items,
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    ...(page.total === undefined ? {} : { total: page.total }),
    ...(page.page === undefined ? {} : { page: page.page }),
    ...(page.pageSize === undefined ? {} : { pageSize: page.pageSize }),
  };
}

function toShopResponse(row: AdminShopRow): ShopResponse {
  return {
    id: row.id.toString(),
    protocol: row.protocol,
    platform: row.platform,
    url: row.url,
    name: row.name,
    enabled: row.enabled,
    lastFetchAt: row.last_fetch_at,
    lastError: row.last_error,
  };
}

function toProductResponse(row: AdminProductRow): ProductResponse {
  return {
    id: row.id.toString(),
    shopId: row.shop_id.toString(),
    shopName: row.shop_name,
    externalId: row.external_id,
    name: row.name,
    spec: row.spec,
    sourceCategory: row.source_category,
    sourceData: row.source_data,
    normalizedKey: row.normalized_key,
    url: row.url,
    imageUrl: row.image_url,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    standardProductName: row.standard_product_name,
    standardizationOutcome: row.standardization_outcome ?? null,
    tags: row.tags,
    latestPrice: row.latest_price,
    latestCurrency: row.latest_currency,
    // Same gate as binding, so reviewers see the quoted contradiction before they bind.
    evidenceConflict: publicationEvidenceConflict({ name: row.name, spec: row.spec, sourceData: row.source_data }),
    ...(row.processing_summary ? { processingSummary: row.processing_summary } : {}),
  };
}

function toStandardProductResponse(row: AdminStandardProductRow): StandardProductResponse {
  return {
    aliases: row.aliases,
    id: row.id.toString(),
    name: standardProductDisplayName(row.name),
    platform: row.platform,
    canonicalFamily: row.canonical_family,
    canonicalProduct: row.canonical_product,
    canonicalTier: row.canonical_tier,
    sortOrder: row.sort_order.toString(),
    standardKey: row.standard_key,
    hidden: row.hidden,
    mergedIntoId: row.merged_into_id?.toString() ?? null,
    memberCount: row.member_count.toString(),
    shopCount: row.shop_count.toString(),
  };
}

function toTagResponse(row: AdminTagRow): TagResponse {
  return {
    id: row.id.toString(),
    productId: row.product_id.toString(),
    name: row.name,
    value: row.value,
    productCount: (row.product_count ?? 0n).toString(),
  };
}

function toAiJobResponse(row: AdminAiJobRow): AiJobResponse {
  return {
    id: row.id.toString(),
    status: row.status,
    total: row.total.toString(),
    processed: row.processed.toString(),
    applied: row.applied.toString(),
    model: row.model,
    autoApply: row.auto_apply,
    error: row.error,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    scopeShopId: row.scope_shop_id === null ? null : row.scope_shop_id.toString(),
    promptVersion: row.prompt_version,
    phase: row.phase,
    pauseRequested: row.pause_requested,
    cancelRequested: row.cancel_requested,
    failedBatches: row.failed_batches.toString(),
  };
}

function toRunHistoryResponse(row: AdminRunHistoryRow): RunHistoryResponse {
  return {
    id: row.id.toString(),
    shopId: row.shop_id.toString(),
    shopName: row.shop_name,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    itemCount: row.item_count.toString(),
    error: row.error,
    settlementReport: row.settlement_report ?? null,
    taskType: row.task_type,
    sourceFetchRunId: row.source_fetch_run_id?.toString() ?? null,
    crawlMetrics: row.crawl_metrics ?? null,
  };
}

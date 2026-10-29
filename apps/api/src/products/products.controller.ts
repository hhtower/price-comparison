import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Inject, ValidationPipe, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import type { JsonValue } from '../database/types.js';
import { parsePositiveBigint } from '../common/pagination.js';
import { ProductsService } from './products.service.js';
import { productMapKey, type Product, type ProductUpsert } from './products.repository.js';

class ProductUpsertDto {
  @IsString()
  shopId!: string;

  @IsString()
  externalId!: string;

  @IsString()
  name!: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  spec?: string;

  @IsOptional()
  @IsString()
  sourceCategory?: string;

  @IsOptional()
  @IsObject()
  sourceData?: Record<string, JsonValue>;

  @IsString()
  normalizedKey!: string;

  @IsUrl({ protocols: ['http', 'https'] })
  url!: string;

  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'] })
  imageUrl?: string;
}

class ProductBatchDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ProductUpsertDto)
  items!: ProductUpsertDto[];
}

class ProductIdsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  productIds!: string[];
}

class ProductPatchDto {
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  name?: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  spec?: string;

  @IsOptional()
  @IsString()
  sourceCategory?: string;

  @IsOptional()
  @IsObject()
  sourceData?: Record<string, JsonValue>;

  @IsOptional()
  @IsString()
  normalizedKey?: string;

  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'] })
  url?: string;

  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'] })
  imageUrl?: string;
}

class ProductTagDto { @IsString() name!: string; @IsString() value!: string }
class ProductTagsDto { @IsArray() @ValidateNested({ each: true }) @Type(() => ProductTagDto) items!: ProductTagDto[] }
class StandardProductAssignmentDto { @IsOptional() @IsString() standardProductId?: string | null; @IsOptional() @IsBoolean() confirmEvidenceConflict?: boolean }

@Controller({ path: 'admin/products', version: '1' })
@UseGuards(AuthGuard)
export class ProductsController {
  constructor(@Inject(ProductsService) private readonly service: ProductsService) {}

  @Post('batch')
  async upsertBatch(@Body(new ValidationPipe({ expectedType: ProductBatchDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) body: ProductBatchDto): Promise<{ items: readonly ProductIdResponse[] }> {
    const inputs = body.items.map(toProductUpsert);
    const ids = await this.service.upsertBatch(inputs);
    return {
      items: inputs.map((input) => ({
        key: productMapKey(input.shopId, input.externalId),
        id: ids.get(productMapKey(input.shopId, input.externalId))!.toString(),
      })),
    };
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<ProductResponse> {
    return toProductResponse(await this.service.get(parsePositiveBigint(id)));
  }

  @Post('batch-delete')
  async removeBatch(@Body(new ValidationPipe({ expectedType: ProductIdsDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) body: ProductIdsDto) {
    return this.service.removeBatch(body.productIds.map(id => parsePositiveBigint(id, 'productIds')));
  }

  @Post('batch-restore')
  async restoreBatch(@Body(new ValidationPipe({ expectedType: ProductIdsDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) body: ProductIdsDto) {
    return this.service.restoreBatch(body.productIds.map(id => parsePositiveBigint(id, 'productIds')));
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body(new ValidationPipe({ expectedType: ProductPatchDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) body: ProductPatchDto): Promise<ProductResponse> {
    return toProductResponse(await this.service.update(parsePositiveBigint(id), body));
  }

  @Delete(':id')
  async remove(@Param('id') id: string): Promise<void> {
    await this.service.remove(parsePositiveBigint(id));
  }

  @Post(':id/restore')
  async restore(@Param('id') id: string): Promise<ProductResponse> {
    return toProductResponse(await this.service.restore(parsePositiveBigint(id)));
  }

  @Get(':id/tags')
  async listTags(@Param('id') id: string) {
    await this.service.get(parsePositiveBigint(id));
    const tags = await this.service.listTags(parsePositiveBigint(id));
    return { items: tags.map((tag) => ({ id: tag.id.toString(), productId: tag.product_id.toString(), name: tag.name, value: tag.value })) };
  }

  @Put(':id/tags')
  async replaceTags(@Param('id') id: string, @Body(new ValidationPipe({ expectedType: ProductTagsDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) body: ProductTagsDto) {
    const tags = await this.service.replaceTags(parsePositiveBigint(id), body.items);
    return { items: tags.map((tag) => ({ id: tag.id.toString(), productId: tag.product_id.toString(), name: tag.name, value: tag.value })) };
  }

  @Put(':id/standard-product')
  async assignStandardProduct(@Param('id') id: string, @Body(new ValidationPipe({ expectedType: StandardProductAssignmentDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) body: StandardProductAssignmentDto) {
    const standardProductId = body.standardProductId == null ? null : parsePositiveBigint(body.standardProductId, 'standardProductId');
    await this.service.assignStandardProduct(parsePositiveBigint(id), standardProductId, body.confirmEvidenceConflict ?? false);
    return { ok: true };
  }

}

interface ProductIdResponse {
  readonly key: string;
  readonly id: string;
}

interface ProductResponse {
  readonly id: string;
  readonly shopId: string;
  readonly externalId: string;
  readonly name: string;
  readonly description: string;
  readonly spec: string;
  readonly sourceCategory: string;
  readonly sourceData: JsonValue;
  readonly normalizedKey: string;
  readonly url: string;
  readonly imageUrl: string | null;
  readonly updatedAt: Date;
}

function toProductUpsert(input: ProductUpsertDto): ProductUpsert {
  return {
    shopId: parsePositiveBigint(input.shopId, 'shopId'),
    externalId: input.externalId,
    name: input.name,
    description: input.description,
    spec: input.spec,
    sourceCategory: input.sourceCategory,
    sourceData: input.sourceData,
    normalizedKey: input.normalizedKey,
    url: input.url,
    imageUrl: input.imageUrl,
  };
}

function toProductResponse(product: Product): ProductResponse {
  return {
    id: product.id.toString(),
    shopId: product.shop_id.toString(),
    externalId: product.external_id,
    name: product.name,
    description: product.source_description,
    spec: product.spec,
    sourceCategory: product.source_category,
    sourceData: product.source_data,
    normalizedKey: product.normalized_key,
    url: product.url,
    imageUrl: product.image_url,
    updatedAt: product.updated_at,
  };
}

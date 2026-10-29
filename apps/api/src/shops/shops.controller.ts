import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUrl,
} from 'class-validator';
import { Body, Controller, Delete, Get, Param, Patch, Post, Inject, ValidationPipe, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { ShopsService } from './shops.service.js';
import type { Shop } from './shops.repository.js';
import { parsePositiveBigint } from '../common/pagination.js';

class ShopDto {
  @IsOptional() @IsString() protocol?: string;
  @IsString()
  platform!: string;

  @IsUrl({ protocols: ['http', 'https'] })
  url!: string;

  @IsString()
  name!: string;

  @IsBoolean()
  enabled!: boolean;
}

class ShopPatchDto {
  @IsOptional() @IsString() protocol?: string;
  @IsOptional()
  @IsString()
  platform?: string;

  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'] })
  url?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

class RefreshDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  shopIds!: string[];
}

@Controller({ path: 'admin/shops', version: '1' })
@UseGuards(AuthGuard)
export class ShopsController {
  constructor(@Inject(ShopsService) private readonly service: ShopsService) {}

  @Post()
  async create(@Body(new ValidationPipe({ expectedType: ShopDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) body: ShopDto): Promise<ShopResponse> {
    return toShopResponse(await this.service.upsert(body));
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<ShopResponse> {
    return toShopResponse(await this.service.get(parsePositiveBigint(id)));
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body(new ValidationPipe({ expectedType: ShopPatchDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) body: ShopPatchDto): Promise<ShopResponse> {
    return toShopResponse(await this.service.update(parsePositiveBigint(id), body));
  }

  @Delete(':id')
  async remove(@Param('id') id: string): Promise<void> {
    await this.service.remove(parsePositiveBigint(id));
  }

  @Post(':id/restore')
  async restore(@Param('id') id: string): Promise<ShopResponse> {
    return toShopResponse(await this.service.restore(parsePositiveBigint(id)));
  }

  @Post(':id/refresh')
  async refreshOne(@Param('id') id: string): Promise<{ items: readonly RefreshResponse[] }> {
    const runs = await this.service.enqueueRefresh([parsePositiveBigint(id, 'shopId')]);
    return { items: runs.map((run) => ({ id: run.id.toString(), shopId: run.shop_id.toString(), status: run.status })) };
  }

  @Post('refresh')
  async refresh(@Body(new ValidationPipe({ expectedType: RefreshDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) body: RefreshDto): Promise<{ items: readonly RefreshResponse[] }> {
    const ids = body.shopIds.map((id) => parsePositiveBigint(id, 'shopIds'));
    const runs = await this.service.enqueueRefresh(ids);
    return { items: runs.map((run) => ({ id: run.id.toString(), shopId: run.shop_id.toString(), status: run.status })) };
  }
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

interface RefreshResponse {
  readonly id: string;
  readonly shopId: string;
  readonly status: 'queued';
}

function toShopResponse(shop: Shop): ShopResponse {
  return {
    id: shop.id.toString(),
    protocol: shop.protocol,
    platform: shop.platform,
    url: shop.url,
    name: shop.name,
    enabled: shop.enabled,
    lastFetchAt: shop.last_fetch_at,
    lastError: shop.last_error,
  };
}

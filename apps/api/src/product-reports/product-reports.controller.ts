import { Body, Controller, Get, Inject, Param, Post, Query, Req, UseGuards, ValidationPipe } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard.js';
import { parsePositiveBigint } from '../common/pagination.js';
import type { ProductReportReason, ProductReportStatus } from '../database/types.js';
import { ProductReportsService } from './product-reports.service.js';
import type { ProductReport } from './product-reports.repository.js';

const reasons = ['price_mismatch', 'invalid_link', 'misleading', 'unsafe', 'other'] as const;
const statuses = ['pending', 'resolved', 'dismissed'] as const;

class CreateProductReportDto {
  @IsString() @Matches(/^\d+$/u) productId!: string;
  @IsEnum(reasons) reason!: ProductReportReason;
  @IsOptional() @IsString() @MaxLength(1000) details?: string;
}

class ListProductReportsDto {
  @IsOptional() @IsEnum(statuses) status: ProductReportStatus = 'pending';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 10;
}

function toResponse(report: ProductReport) {
  return {
    id: report.id.toString(), productId: report.product_id?.toString() ?? null,
    productName: report.product_name, shopName: report.shop_name, productUrl: report.product_url,
    price: report.price, currency: report.currency, priceCapturedAt: report.price_captured_at,
    reason: report.reason, details: report.details, status: report.status,
    createdAt: report.created_at, reviewedAt: report.reviewed_at,
  };
}

@Controller({ path: 'product-reports', version: '1' })
export class ProductReportsController {
  constructor(@Inject(ProductReportsService) private readonly service: ProductReportsService) {}

  @Post()
  async create(@Body(new ValidationPipe({ expectedType: CreateProductReportDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) body: CreateProductReportDto) {
    const report = await this.service.create(parsePositiveBigint(body.productId, 'productId'), body.reason, body.details ?? '');
    return { id: report.id.toString(), status: report.status };
  }
}

@Controller({ path: 'admin/product-reports', version: '1' })
@UseGuards(AuthGuard)
export class AdminProductReportsController {
  constructor(@Inject(ProductReportsService) private readonly service: ProductReportsService) {}

  @Get()
  async list(@Query(new ValidationPipe({ expectedType: ListProductReportsDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) query: ListProductReportsDto) {
    const result = await this.service.list(query.status, query.page, query.limit);
    return { items: result.items.map(toResponse), total: result.total, page: query.page, pageSize: query.limit };
  }

  @Post(':id/resolve')
  async resolve(@Param('id') id: string, @Req() request: { user?: { userId: string } }) {
    return toResponse(await this.service.review(parsePositiveBigint(id), 'resolved', request.user?.userId ?? null));
  }

  @Post(':id/dismiss')
  async dismiss(@Param('id') id: string, @Req() request: { user?: { userId: string } }) {
    return toResponse(await this.service.review(parsePositiveBigint(id), 'dismissed', request.user?.userId ?? null));
  }
}

import { Body, Controller, Get, Inject, Param, Post, Query, Req, UseGuards, ValidationPipe } from '@nestjs/common';
import { IsInt, IsOptional, IsString, IsUrl, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { AuthGuard } from '../auth/auth.guard.js';
import { parsePositiveBigint } from '../common/pagination.js';
import { DomainValidationError } from '../common/errors.js';
import { ShopSubmissionsService } from './shop-submissions.service.js';

class CreateSubmissionDto {
  @IsOptional() @IsString() platform?: string;
  @IsUrl({ protocols: ['http', 'https'] }) url!: string;
  @IsString() name!: string;
}

class ListSubmissionDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 10;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

interface RequestWithUser { user?: { userId: string } }
class ProtocolDto {
  @IsOptional() @IsString() protocol?: string;
}

@Controller({ path: 'shop-submissions', version: '1' })
export class ShopSubmissionsController {
  constructor(@Inject(ShopSubmissionsService) private readonly service: ShopSubmissionsService) {}

  @Post()
  async create(@Body(new ValidationPipe({ expectedType: CreateSubmissionDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) body: CreateSubmissionDto): Promise<{ id: string; status: string }> {
    const result = await this.service.create(body);
    return { id: result.id.toString(), status: result.status };
  }
}

@Controller({ path: 'admin/shop-submissions', version: '1' })
@UseGuards(AuthGuard)
export class AdminShopSubmissionsController {
  constructor(@Inject(ShopSubmissionsService) private readonly service: ShopSubmissionsService) {}

  @Get('protocols')
  protocols() { return { items: this.service.listProtocols() }; }

  @Post(':id/detect')
  detect(@Param('id') id: string, @Body(new ValidationPipe({ expectedType: ProtocolDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) body: ProtocolDto) {
    return this.service.detect(parsePositiveBigint(id), body.protocol);
  }

  @Get()
  async list(@Query(new ValidationPipe({ expectedType: ListSubmissionDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) query: ListSubmissionDto): Promise<unknown> {
    const page = parsePage(query.page, 1);
    const pageSize = parsePage(query.limit ?? query.pageSize, 10);
    const result = await this.service.listPending(page, pageSize);
    return { items: result.items.map(toResponse), total: result.total, page, pageSize };
  }

  @Post(':id/approve')
  approve(@Param('id') id: string, @Req() req: RequestWithUser, @Body(new ValidationPipe({ expectedType: ProtocolDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) body: ProtocolDto): Promise<ReturnType<typeof toResponse>> {
    return this.service.review(parsePositiveBigint(id), 'approve', req.user?.userId ?? null, body.protocol).then(toResponse);
  }

  @Post(':id/reject')
  reject(@Param('id') id: string, @Req() req: RequestWithUser): Promise<ReturnType<typeof toResponse>> {
    return this.service.review(parsePositiveBigint(id), 'reject', req.user?.userId ?? null).then(toResponse);
  }
}

function parsePage(value: string | number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000000) throw new DomainValidationError('INVALID_PAGE', '分页参数无效');
  return parsed;
}

function toResponse(row: any): any {
  return {
    id: row.id.toString(), platform: row.platform, url: row.url, name: row.name, status: row.status,
    createdAt: row.created_at, created_at: row.created_at, reviewedAt: row.reviewed_at,
    shopId: row.shop_id === null ? null : row.shop_id.toString(),
  };
}

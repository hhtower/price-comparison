import { Type, Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsNotEmpty, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

const POSITIVE_ID = /^[1-9]\d*$/;

export class AdminPageQueryDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}

function trimKeyword({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

function parseBoolean({ value }: { value: unknown }): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

export class ListShopsQueryDto extends AdminPageQueryDto {
  @IsOptional()
  @Matches(POSITIVE_ID, { message: 'standardProductId 必须是正整数' })
  standardProductId?: string;

  @IsOptional()
  @IsIn(['active', 'disabled', 'deleted'])
  status?: 'active' | 'disabled' | 'deleted';

  @IsOptional()
  @Transform(trimKeyword)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  keyword?: string;
}

export class ListProductsQueryDto extends AdminPageQueryDto {
  @IsOptional()
  @Matches(POSITIVE_ID, { message: 'standardProductId 必须是正整数' })
  standardProductId?: string;

  @IsOptional()
  @Matches(POSITIVE_ID, { message: 'shopId 必须是正整数' })
  shopId?: string;

  @IsOptional()
  @Transform(trimKeyword)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  keyword?: string;

  @IsOptional()
  @Transform(parseBoolean)
  @IsBoolean()
  standardized?: boolean;

  @IsOptional()
  @Transform(parseBoolean)
  @IsBoolean()
  pending?: boolean;

  @IsOptional()
  @Transform(parseBoolean)
  @IsBoolean()
  deleted?: boolean;
}

export class ListStandardProductPlatformsQueryDto {
  @IsOptional()
  @IsIn(['unmerged', 'all'])
  status?: 'unmerged' | 'all';
}

export class ListStandardProductsQueryDto extends AdminPageQueryDto {
  @IsOptional()
  @IsIn(['active', 'hidden', 'merged', 'unmerged', 'all'])
  status?: 'active' | 'hidden' | 'merged' | 'unmerged' | 'all';

  @IsOptional()
  @Transform(trimKeyword)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  keyword?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  platform?: string;
}

export class ListPlatformsQueryDto extends AdminPageQueryDto {
  @IsOptional()
  @IsIn(['enabled', 'disabled', 'all'])
  status?: 'enabled' | 'disabled' | 'all';

  @IsOptional()
  @Transform(trimKeyword)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  keyword?: string;
}

export class ListTagsQueryDto extends AdminPageQueryDto {
  @IsOptional()
  @Transform(trimKeyword)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  keyword?: string;

  @IsOptional()
  @Matches(POSITIVE_ID, { message: 'productId 必须是正整数' })
  productId?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  value?: string;
}

export class ListAiJobsQueryDto extends AdminPageQueryDto {
  @IsOptional()
  @IsIn(['queued', 'running', 'paused', 'ready', 'ready_with_errors', 'succeeded', 'failed', 'cancelled'])
  status?: 'queued' | 'running' | 'paused' | 'ready' | 'ready_with_errors' | 'succeeded' | 'failed' | 'cancelled';

  @IsOptional()
  @Matches(POSITIVE_ID, { message: 'shopId 必须是正整数' })
  shopId?: string;
}

export class ListRunHistoryQueryDto extends AdminPageQueryDto {
  @IsOptional()
  @Matches(POSITIVE_ID, { message: 'shopId 必须是正整数' })
  shopId?: string;

  @IsOptional()
  @IsIn(['queued', 'running', 'succeeded', 'deferred', 'failed', 'cancelled'])
  status?: 'queued' | 'running' | 'succeeded' | 'deferred' | 'failed' | 'cancelled';
}

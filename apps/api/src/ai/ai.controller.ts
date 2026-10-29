import { Body, Controller, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { ArrayMaxSize, ArrayNotEmpty, ArrayUnique, Equals, IsArray, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { DomainValidationError } from '../common/errors.js';
import { AiService } from './ai.service.js';
import { AiRepository } from './ai.repository.js';
const ID = /^[1-9]\d*$/u;
export class CreateJobDto { @IsString() @IsNotEmpty() @MaxLength(200) model!: string; @IsOptional() @IsInt() @Min(1) @Max(100) batchSize?: number; @IsOptional() @Matches(ID) scopeShopId?: string; }
export class RetryPoolDto {
  @Equals(true) acknowledgePossibleCharge!: boolean;
  @IsUUID() requestId!: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(500) @ArrayUnique() @Matches(ID, { each: true })
  productIds?: string[];
}
export class TagJobScopeDto {
  @ValidateIf((_object,value)=>value!==undefined) @Equals(true) allPending?:boolean;
  @ValidateIf((_object,value)=>value!==undefined) @IsArray() @ArrayNotEmpty() @ArrayMaxSize(500) @ArrayUnique() @Matches(ID,{each:true}) productIds?:string[];
  @ValidateIf((_object,value)=>value!==undefined) @Matches(ID) scopeShopId?:string;
  @ValidateIf((_object,value)=>value!==undefined) @Matches(ID) retryOfJobId?:string;
}
export class TagJobCreateDto extends TagJobScopeDto {
  @Equals(true) acknowledgePossibleCharge!:boolean;
  @IsUUID() requestId!:string;
  @ValidateIf((object,value)=>object.allPending!==true||value!==undefined)
  @Matches(/^[a-f0-9]{64}$/u) previewDigest?:string;
}
function tagScope(body:TagJobScopeDto) { return {allPending:body.allPending,productIds:body.productIds?.map(id),scopeShopId:body.scopeShopId===undefined?undefined:id(body.scopeShopId),retryOfJobId:body.retryOfJobId===undefined?undefined:id(body.retryOfJobId)}; }
function id(value: string): bigint { try { return BigInt(value); } catch { throw new DomainValidationError('INVALID_ID', 'ID 无效'); } }
function jsonSafe<T>(value: T): T { return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item)) as T; }
@Controller({ path: 'ai', version: '1' })
@UseGuards(AuthGuard)
export class AiController {
  constructor(@Inject(AiService) private readonly service: AiService, @Inject(AiRepository) private readonly repository: AiRepository) {}
  @Post('tag-jobs/preview') async previewTags(@Body() body:TagJobScopeDto) { return jsonSafe(await this.service.previewTagJob(tagScope(body))); }
  @Post('tag-jobs') async createTags(@Body() body:TagJobCreateDto) {
    if(body.acknowledgePossibleCharge!==true) throw new DomainValidationError('AI_RETRY_ACK_REQUIRED','请确认任务可能计费');
    return jsonSafe(await this.service.createTagJob({...tagScope(body),requestId:body.requestId,previewDigest:body.previewDigest}));
  }
  @Post('jobs') async createJob(@Body() body: CreateJobDto) { return jsonSafe(await this.service.createJob({ model: body.model, batchSize: body.batchSize, scopeShopId: body.scopeShopId == null ? null : id(body.scopeShopId) })); }
  @Post('jobs/:id/pause') async pause(@Param('id') value: string) { return jsonSafe(await this.repository.pauseJob(id(value))); }
  @Post('jobs/:id/resume') async resume(@Param('id') value: string) { return jsonSafe(await this.repository.resumeJob(id(value))); }
  @Post('jobs/:id/cancel') async cancel(@Param('id') value: string) { return jsonSafe(await this.repository.cancelJob(id(value))); }
  @Post('jobs/:id/retry') async retry(@Param('id') value: string) { return jsonSafe(await this.repository.retryJob(id(value))); }
  @Post('retry-pool') async retryPool(@Body() body: RetryPoolDto) {
    if (body?.acknowledgePossibleCharge !== true) throw new DomainValidationError('AI_RETRY_ACK_REQUIRED', '请确认重试可能再次计费');
    return jsonSafe(await this.service.retryPool({ requestId: body.requestId, productIds: body.productIds?.map(id) }));
  }
  @Post('jobs/:id/reapply') async reapply(@Param('id') value: string) { return jsonSafe(await this.repository.reapplySavedResults(id(value))); }
}

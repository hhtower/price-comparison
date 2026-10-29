import { Controller, Get, Inject, Param, Query, Res, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { DomainValidationError } from '../common/errors.js';
import { AiRepository } from './ai.repository.js';

const ID = /^[1-9]\d*$/u;
function parseId(value: string, field = 'id'): bigint { if (!ID.test(value)) throw new DomainValidationError('INVALID_ID', `${field} 必须是正整数`, { field }); return BigInt(value); }
function limit(value: string | undefined): number { const result = value == null ? 20 : Number(value); if (!Number.isInteger(result) || result < 1 || result > 100) throw new DomainValidationError('INVALID_PAGE_SIZE', '每页数量必须是 1 到 100 之间的整数'); return result; }
function jsonSafe<T>(value: T): T { return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item)) as T; }

@Controller({ path: 'admin/ai', version: '1' })
@UseGuards(AuthGuard)
export class AiAdminController {
  constructor(@Inject(AiRepository) private readonly repository: AiRepository) {}

  @Get('status') async status() { return jsonSafe(await this.repository.adminStatus()); }
  @Get('task-queue') taskQueue(@Query('limit') size?: string, @Query('cursor') cursor?: string, @Query('status') status?: string, @Query('jobType') jobType?: string, @Query('scopeShopId') scopeShopId?: string) {
    return this.repository.adminTaskQueue({ limit: limit(size), cursor, status, jobType, scopeShopId:scopeShopId===undefined?undefined:parseId(scopeShopId,'scopeShopId') });
  }
  @Get('standard-products') globalStandardProducts(@Query('limit') size?: string, @Query('cursor') cursor?: string, @Query('q') query?: string, @Query('includeTotal') includeTotal?: string) {
    return this.repository.listGlobalStandardProducts({ limit: limit(size), cursor, query, includeTotal: includeTotal === 'true' });
  }
  @Get('standard-products/:id/products') globalProducts(@Param('id') value: string, @Query('limit') size?: string, @Query('cursor') cursor?: string) {
    return this.repository.listGlobalStandardProductItems({ standardProductId: parseId(value, 'standardProductId'), limit: limit(size), cursor });
  }
  @Get('results') globalResults(@Query('limit') size?: string, @Query('cursor') cursor?: string) {
    return this.repository.listGlobalResults({ limit: limit(size), cursor });
  }
  @Get('retry-pool') retryPool(@Query('limit') size?: string, @Query('cursor') cursor?: string) {
    return this.repository.listRetryPool({ limit: limit(size), cursor });
  }
  @Get('jobs/:id/results') results(@Param('id') value: string, @Query('limit') size?: string, @Query('cursor') cursor?: string) {
    return this.repository.listJobResults({ jobId: parseId(value, 'jobId'), limit: limit(size), cursor });
  }
  @Get('jobs/:id/tag-results') tagResults(@Param('id') value:string,@Query('limit') size?:string,@Query('cursor') cursor?:string) { return this.repository.listTagJobResults({jobId:parseId(value,'jobId'),limit:limit(size),cursor}); }
  @Get('jobs/:id/tag-results/:productId') tagAudit(@Param('id') value:string,@Param('productId') productId:string) { return this.repository.tagProductAudit(parseId(value,'jobId'),parseId(productId,'productId')); }
  @Get('jobs/:id') async detail(@Param('id') value: string) { return jsonSafe(await this.repository.adminJobSnapshot(parseId(value, 'jobId'))); }
  @Get('jobs/:id/progress') async progress(@Param('id') value: string, @Query('since') since: string | undefined, @Res() reply: any) {
    const jobId = parseId(value, 'jobId');
    let version: bigint | undefined;
    if (since !== undefined) { if (!/^\d+$/u.test(since)) throw new DomainValidationError('INVALID_VERSION', 'since 必须是非负整数'); version = BigInt(since); }
    const snapshot = await this.repository.getJobProgress(jobId, version);
    reply.header('etag', `\"${jobId}:${snapshot?.version ?? version?.toString() ?? '0'}\"`);
    if (!snapshot) return reply.code(304).send();
    return reply.send(jsonSafe(snapshot));
  }
  @Get('jobs/:id/events') async events(@Param('id') value: string, @Query('since') since: string | undefined, @Res() reply: any) {
    const jobId = parseId(value, 'jobId');
    if (since !== undefined && !/^\d+$/u.test(since)) throw new DomainValidationError('INVALID_VERSION', 'since 必须是非负整数');
    const start = since == null ? 0n : BigInt(since);
    reply.hijack?.();
    reply.raw?.setHeader?.('content-type', 'text/event-stream'); reply.raw?.setHeader?.('cache-control', 'no-cache'); reply.raw?.flushHeaders?.();
    const controller = new AbortController();
    reply.raw?.on?.('close', () => controller.abort());
    try {
      for await (const event of this.repository.streamJobEvents(jobId, start, controller.signal)) {
        if (controller.signal.aborted) break;
        const payload = event.data == null ? '' : `data: ${JSON.stringify(jsonSafe(event.data))}\n`;
        reply.raw?.write?.(`id: ${event.id}\nevent: ${event.type}\n${payload}\n`);
      }
    } finally {
      if (!reply.raw?.writableEnded) reply.raw?.end?.();
    }
    return undefined;
  }
  @Get('jobs/:id/standard-products') standardProducts(@Param('id') value: string, @Query('limit') size?: string, @Query('cursor') cursor?: string, @Query('q') query?: string, @Query('includeTotal') includeTotal?: string) {
    return this.repository.listStandardProductsByCursor({ jobId: parseId(value, 'jobId'), limit: limit(size), cursor, query, includeTotal: includeTotal === 'true' });
  }
  @Get('jobs/:id/standard-products/:key/products') async products(@Param('id') value: string, @Param('key') key: string, @Query('limit') size?: string, @Query('cursor') cursor?: string) {
    return jsonSafe(await this.repository.listStandardProductItemsByCursor({ jobId: parseId(value, 'jobId'), key, limit: limit(size), cursor }));
  }
}

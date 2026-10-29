import { Controller, Get, Inject, Optional, Query, Res, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { DomainValidationError } from '../common/errors.js';
import { JobsRepository } from '../jobs/jobs.repository.js';
import { CRAWLER_METRICS_REDIS, type CrawlerRedisClient } from '../crawler/crawler-redis.module.js';
import { readCrawlerMetrics, streamCrawlerMetrics, type StreamedCrawlerMetrics } from '../crawler/metrics-store.js';
import { DiagnosticsRepository, type CrawlerDiagnostics } from '../crawler/diagnostics.repository.js';

export interface CrawlerTasksSnapshot extends StreamedCrawlerMetrics {
  readonly instances: { readonly queued: number; readonly running: number; readonly failedRecent: number };
  readonly diagnostics?: CrawlerDiagnostics;
}

/** 任务台第一阶段的抓取任务概览：Redis 计数器/心跳 + fetch_runs 实例统计。 */
@Controller({ path: 'admin/tasks/crawler', version: '1' })
@UseGuards(AuthGuard)
export class CrawlerTasksController {
  protected streamIntervalMs = 5_000;
  private cachedExtras?: Pick<CrawlerTasksSnapshot, 'instances' | 'diagnostics'>;
  private extrasExpiresAt = 0;
  private pendingExtras?: Promise<Pick<CrawlerTasksSnapshot, 'instances' | 'diagnostics'>>;

  constructor(
    @Inject(CRAWLER_METRICS_REDIS) private readonly redis: CrawlerRedisClient | undefined,
    @Inject(JobsRepository) private readonly jobs: Pick<JobsRepository, 'fetchRunCounts'>,
    @Optional() @Inject(DiagnosticsRepository) private readonly diagnostics?: Pick<DiagnosticsRepository, 'snapshot'>,
  ) {}

  @Get('status')
  async status(): Promise<CrawlerTasksSnapshot> {
    const [report, extras] = await Promise.all([
      readCrawlerMetrics(this.redis), this.readExtras(),
    ]);
    return { ...report, ...extras };
  }

  private readExtras(): Promise<Pick<CrawlerTasksSnapshot, 'instances' | 'diagnostics'>> {
    if (this.cachedExtras && Date.now() < this.extrasExpiresAt) return Promise.resolve(this.cachedExtras);
    if (this.pendingExtras) return this.pendingExtras;
    this.pendingExtras = (async () => {
      const diagnostics = await this.diagnostics?.snapshot();
      const instances = diagnostics?.instances ?? await this.jobs.fetchRunCounts();
      const extras = { instances, ...(diagnostics ? { diagnostics } : {}) };
      this.cachedExtras = extras;
      this.extrasExpiresAt = Date.now() + this.streamIntervalMs;
      return extras;
    })().finally(() => { this.pendingExtras = undefined; });
    return this.pendingExtras;
  }

  @Get('events')
  async events(@Query('since') since: string | undefined, @Res() reply: any): Promise<undefined> {
    let sinceValue: number | null = null;
    if (since !== undefined) {
      if (!/^\d+$/u.test(since)) throw new DomainValidationError('INVALID_VERSION', 'since 必须是非负整数');
      sinceValue = Number(since);
    }
    reply.hijack?.();
    reply.raw?.setHeader?.('content-type', 'text/event-stream');
    reply.raw?.setHeader?.('cache-control', 'no-cache');
    reply.raw?.flushHeaders?.();
    const controller = new AbortController();
    reply.raw?.on?.('close', () => controller.abort());
    try {
      for await (const report of streamCrawlerMetrics(this.redis, {
        signal: controller.signal,
        intervalMs: this.streamIntervalMs,
        since: sinceValue,
        readExtras: () => this.readExtras(),
      })) {
        if (controller.signal.aborted) break;
        reply.raw?.write?.(`id: ${report.lastReportAt ?? 0}\nevent: progress\ndata: ${JSON.stringify(report)}\n\n`);
      }
    } finally {
      if (!reply.raw?.writableEnded) reply.raw?.end();
    }
    return undefined;
  }
}

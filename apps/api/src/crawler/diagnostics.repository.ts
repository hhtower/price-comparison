import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { defaultQuotePolicy } from '../catalog/quote-policy.js';
import { readCrawlerConfig } from '../config/env.js';
import { DATABASE } from '../database/database.providers.js';
import type { DatabaseSchema } from '../database/types.js';
import type { CrawlHostMetrics, CrawlMetricsData } from './run-metrics.js';

type RequestCounts = Pick<CrawlHostMetrics, 'requests' | 'retries' | 'list' | 'channel' | 'settlement'>;

export interface HostBudget extends RequestCounts {
  host: string;
  shops: number;
  sampledShops: number;
  estimatedMs: number | null;
  recommendedIntervalMs: number | null;
}

export interface CrawlerDiagnostics {
  instances: { queued: number; running: number; failedRecent: number };
  oldestQueuedMs: number | null;
  deferred: number;
  windowRuns: number;
  listSucceeded: number;
  listFailed: number;
  coverage: { eligible: number; verified: number };
  budgets: HostBudget[];
  settlementQueue: { queued: number; running: number; deferred: number; failedRecent: number };
}

function validMetrics(value: unknown): value is CrawlMetricsData {
  return !!value && typeof value === 'object' && (value as CrawlMetricsData).version === 1;
}

function metric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function shopHost(url: string): string | null {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

@Injectable()
export class DiagnosticsRepository {
  constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  async snapshot(): Promise<CrawlerDiagnostics> {
    const now = new Date();
    const windowStart = new Date(now.getTime() - 3_600_000);
    const config = readCrawlerConfig();
    const quoteTtlMs = defaultQuotePolicy().ttlMs;
    const [queue, recent, coverage, shops, samples] = await Promise.all([
      sql<{ oldest: Date | null; queued: string; running: string; deferred: string; settlement_queued: string; settlement_running: string; settlement_deferred: string }>`
        select min(greatest(started_at, available_at)) filter (where available_at <= ${now} and (status = 'queued' or (status = 'running' and (lease_until is null or lease_until <= ${now})))) as oldest,
          count(*) filter (where available_at <= ${now} and (status = 'queued' or (status = 'running' and (lease_until is null or lease_until <= ${now}))))::text as queued,
          count(*) filter (where status = 'running' and lease_until > ${now})::text as running,
          count(*) filter (where status in ('queued', 'running') and available_at > ${now})::text as deferred,
          count(*) filter (where task_type = 'settlement' and available_at <= ${now} and (status = 'queued' or (status = 'running' and (lease_until is null or lease_until <= ${now}))))::text as settlement_queued,
          count(*) filter (where task_type = 'settlement' and status = 'running' and lease_until > ${now})::text as settlement_running,
          count(*) filter (where task_type = 'settlement' and available_at > ${now})::text as settlement_deferred
        from fetch_runs where status in ('queued', 'running')`.execute(this.database),
      sql<{ list_succeeded: string; list_failed: string; failed_recent: string; settlement_failed: string }>`
        select count(*) filter (where task_type = 'list' and status = 'succeeded')::text as list_succeeded,
          count(*) filter (where task_type = 'list' and status = 'failed')::text as list_failed,
          count(*) filter (where status = 'failed')::text as failed_recent,
          count(*) filter (where task_type = 'settlement' and status = 'failed')::text as settlement_failed
        from fetch_runs where status in ('succeeded', 'failed') and finished_at >= ${windowStart}`.execute(this.database),
      sql<{ eligible: string; verified: string }>`
        select count(*)::text as eligible,
          count(*) filter (where latest.settlement_price is not null and latest.settlement_price >= 0
            and latest.settlement_verified_at is not null and nullif(btrim(latest.settlement_payment_method), '') is not null
            and least(latest.captured_at, latest.settlement_verified_at) + ${quoteTtlMs} * interval '1 millisecond' > ${now})::text as verified
        from catalog_read_offer_prices latest
        join shops sh on sh.id = latest.shop_id and sh.enabled and sh.deleted_at is null
        join standard_products sp on sp.id = latest.standard_product_id and sp.verification_state = 'verified' and not sp.hidden and sp.merged_into_id is null
        where latest.available`.execute(this.database),
      this.database.selectFrom('shops').select(['id', 'platform', 'url']).where('enabled', '=', true).where('deleted_at', 'is', null).execute(),
      sql<{ shop_id: bigint; list_metrics: CrawlMetricsData; settlement_metrics: CrawlMetricsData | null }>`
        select sh.id as shop_id, latest.crawl_metrics as list_metrics, retry.crawl_metrics as settlement_metrics
        from shops sh
        join lateral (select id, crawl_metrics from fetch_runs
          where shop_id = sh.id and task_type = 'list' and status = 'succeeded' and crawl_metrics is not null
          order by finished_at desc nulls last, id desc limit 1) latest on true
        left join fetch_runs retry on retry.source_fetch_run_id = latest.id and retry.task_type = 'settlement' and retry.crawl_metrics is not null
        where sh.enabled and sh.deleted_at is null`.execute(this.database),
    ]);

    const listSucceeded = Number(recent.rows[0]?.list_succeeded ?? 0);
    const listFailed = Number(recent.rows[0]?.list_failed ?? 0);

    return {
      oldestQueuedMs: queue.rows[0]?.oldest ? Math.max(0, now.getTime() - new Date(queue.rows[0].oldest).getTime()) : null,
      instances: { queued: Number(queue.rows[0]?.queued ?? 0), running: Number(queue.rows[0]?.running ?? 0),
        failedRecent: Number(recent.rows[0]?.failed_recent ?? 0) },
      deferred: Number(queue.rows[0]?.deferred ?? 0), windowRuns: listSucceeded + listFailed, listSucceeded, listFailed,
      coverage: { eligible: Number(coverage.rows[0]?.eligible ?? 0), verified: Number(coverage.rows[0]?.verified ?? 0) },
      budgets: this.budgets(shops, samples.rows, config.hostMinIntervalMs, config.concurrency),
      settlementQueue: {
        queued: Number(queue.rows[0]?.settlement_queued ?? 0), running: Number(queue.rows[0]?.settlement_running ?? 0),
        deferred: Number(queue.rows[0]?.settlement_deferred ?? 0), failedRecent: Number(recent.rows[0]?.settlement_failed ?? 0),
      },
    };
  }

  private budgets(
    shops: readonly { id: bigint; platform: string; url: string }[],
    samples: readonly { shop_id: bigint; list_metrics: CrawlMetricsData; settlement_metrics: CrawlMetricsData | null }[],
    spacing: ReadonlyMap<string, number>, concurrency: number,
  ): HostBudget[] {
    const budgets = new Map<string, { shops: Set<bigint>; sampled: Set<bigint>; platforms: Set<string>; counts: RequestCounts; networkMs: number }>();
    const entry = (host: string) => {
      let value = budgets.get(host);
      if (!value) {
        value = { shops: new Set(), sampled: new Set(), platforms: new Set(), counts: { requests: 0, retries: 0, list: 0, channel: 0, settlement: 0 }, networkMs: 0 };
        budgets.set(host, value);
      }
      return value;
    };
    for (const shop of shops) {
      const host = shopHost(shop.url);
      if (host) entry(host).shops.add(shop.id);
    }
    const platformByShop = new Map(shops.map(shop => [shop.id, shop.platform]));
    const primaryHostByShop = new Map(shops.map(shop => [shop.id, shopHost(shop.url)]));
    for (const sample of samples) {
      const metrics = [sample.list_metrics, sample.settlement_metrics];
      for (const data of metrics) {
        if (!validMetrics(data)) continue;
        for (const [host, hostMetrics] of Object.entries(data.hosts ?? {})) {
          const budget = entry(host);
          budget.sampled.add(sample.shop_id);
          const platform = platformByShop.get(sample.shop_id);
          if (platform && primaryHostByShop.get(sample.shop_id) !== host) budget.platforms.add(platform);
          for (const key of Object.keys(budget.counts) as Array<keyof RequestCounts>) budget.counts[key] += metric(hostMetrics[key]);
          budget.networkMs += metric(hostMetrics.networkMs);
        }
      }
    }
    for (const budget of budgets.values()) {
      for (const shop of shops) if (budget.platforms.has(shop.platform)) budget.shops.add(shop.id);
    }
    return [...budgets].map(([host, budget]) => {
      const shopsCount = budget.shops.size;
      const sampledShops = budget.sampled.size;
      const factor = sampledShops ? shopsCount / sampledShops : 0;
      const spacingMs = budget.counts.requests * factor * (spacing.get(host) ?? 1_000);
      const networkMs = budget.networkMs * factor / Math.max(1, concurrency);
      const estimatedMs = sampledShops ? Math.ceil(Math.max(spacingMs, networkMs) * 1.25) : null;
      return { host, shops: shopsCount, sampledShops, ...budget.counts, estimatedMs, recommendedIntervalMs: estimatedMs };
    }).sort((a, b) => a.host.localeCompare(b.host));
  }
}

import type { CrawlerRequestEvent } from './fetch-client.js';

export type CrawlHostMetrics = {
  requests: number; retries: number; list: number; channel: number; settlement: number;
  connection: number; rate_limited: number; blocked: number; timeout: number; networkMs: number;
}
export type CrawlMetricsData = {
  version: 1; attempts: number; listSucceeded: number; listFailed: number; leaseFailures: number;
  requests: number; retries: number;
  durations: { list: number; settlement: number; transaction: number; rate_wait: number; proxy_wait: number; network: number; total: number };
  hosts: Record<string, CrawlHostMetrics>;
  /** acg-faka: 列表完成度(去重后条数与站点声称值),守卫放宽后不再静默缺数据。 */
  list?: { unique: number; duplicates: number; categories: number | null; categoryClaims: number | null; flatTotal: number | null };
}

/** Durable per-run counters, including attempts that preceded a successful retry. */
export class CrawlRunMetrics {
  readonly data: CrawlMetricsData;

  constructor(previous?: unknown, private readonly supplement = false) {
    const old = previous && typeof previous === 'object' && 'version' in previous && previous.version === 1
      ? structuredClone(previous) as CrawlMetricsData : undefined;
    const empty: CrawlMetricsData = {
      version: 1, attempts: 0, listSucceeded: 0, listFailed: 0, leaseFailures: 0, requests: 0, retries: 0,
      durations: { list: 0, settlement: 0, transaction: 0, rate_wait: 0, proxy_wait: 0, network: 0, total: 0 }, hosts: {},
    };
    this.data = old ? { ...empty, ...old, durations: { ...empty.durations, ...old.durations }, hosts: old.hosts ?? {} } : empty;
    this.data.attempts++;
  }

  readonly observe = (event: CrawlerRequestEvent): void => {
    const host = this.data.hosts[event.host] ??= {
      requests: 0, retries: 0, list: 0, channel: 0, settlement: 0,
      connection: 0, rate_limited: 0, blocked: 0, timeout: 0, networkMs: 0,
    };
    if (event.type === 'request') {
      this.data.requests++; host.requests++; host[event.stage]++;
      if (event.retry || this.supplement || this.data.attempts > 1) { this.data.retries++; host.retries++; }
    } else if (event.type === 'duration') {
      const ms = Math.max(0, Math.round(event.ms));
      this.data.durations[event.phase] += ms;
      if (event.phase === 'network') host.networkMs += ms;
    } else host[event.reason]++;
  };
}

import type { MetricsRegistry } from '../observability/metrics.js';
import type { ProxyPool } from './proxy-pool.js';

/** Redis 客户端需为爬虫指标提供的 hash/worker 索引能力。 */
export interface CrawlerMetricsRedis {
  hset(key: string, fields: Record<string, string | number>): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
  expire(key: string, ttlSeconds: number): Promise<unknown>;
  time(): Promise<number[]>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  zremrangebyscore(key: string, min: string, max: number): Promise<unknown>;
}

export const CRAWLER_METRICS_KEY_PREFIX = 'crawler:metrics:';
export const CRAWLER_WORKERS_KEY = 'crawler:workers';
export const CRAWLER_METRICS_TTL_SECONDS = 30;
const STARTED_AT_FIELD = 'started_at';
const UPDATED_AT_FIELD = 'updated_at';

export interface CrawlerMetricsReport {
  readonly counters: Readonly<Record<string, number>>;
  readonly workerCount: number;
  readonly lastReportAt: number | null;
}

export interface StreamedCrawlerMetrics extends CrawlerMetricsReport {
  readonly fetchQueueDepth?: number;
}

/** 以 workerId 为键写入本进程生命周期计数器；TTL 保证 worker 停止后键自动消失。 */
export async function publishCrawlerMetrics(
  redis: CrawlerMetricsRedis,
  workerId: string,
  counters: Readonly<Record<string, number>>,
  startedAt: number,
  now: number = Date.now(),
): Promise<void> {
  const key = `${CRAWLER_METRICS_KEY_PREFIX}${workerId}`;
  const [seconds, microseconds] = await redis.time();
  const redisNow = Number(seconds) * 1000 + Math.floor(Number(microseconds) / 1000);
  await Promise.all([
    redis.hset(key, { ...counters, [STARTED_AT_FIELD]: startedAt, [UPDATED_AT_FIELD]: now }),
    redis.expire(key, CRAWLER_METRICS_TTL_SECONDS),
    redis.zadd(CRAWLER_WORKERS_KEY, redisNow, key),
    redis.zremrangebyscore(CRAWLER_WORKERS_KEY, '-inf', redisNow - CRAWLER_METRICS_TTL_SECONDS * 1000),
  ]);
}

function offlineReport(): CrawlerMetricsReport {
  return { counters: {}, workerCount: 0, lastReportAt: null };
}

/** 汇总所有在线 worker 的计数器（进程生命周期累计），取最近上报时间。 */
export async function readCrawlerMetrics(redis: CrawlerMetricsRedis | undefined): Promise<CrawlerMetricsReport> {
  if (!redis) return offlineReport();
  try {
    const keys = await redis.zrange(CRAWLER_WORKERS_KEY, 0, -1);
    const reports = await Promise.all(keys.map(key => redis.hgetall(key)));
    const counters: Record<string, number> = {};
    let lastReportAt: number | null = null;
    let workerCount = 0;
    for (const fields of reports) {
      if (!fields[UPDATED_AT_FIELD]) continue;
      workerCount++;
      for (const [name, raw] of Object.entries(fields)) {
        if (name === STARTED_AT_FIELD || name === UPDATED_AT_FIELD) continue;
        const value = Number(raw);
        if (!Number.isFinite(value)) continue;
        counters[name] = (counters[name] ?? 0) + value;
      }
      const updatedAt = Number(fields[UPDATED_AT_FIELD]);
      if (Number.isFinite(updatedAt) && (lastReportAt ?? Number.NEGATIVE_INFINITY) < updatedAt) {
        lastReportAt = updatedAt;
      }
    }
    return { counters, workerCount, lastReportAt };
  } catch {
    return offlineReport();
  }
}

export interface StreamCrawlerMetricsOptions {
  readonly signal?: AbortSignal;
  readonly intervalMs?: number;
  /** 客户端已持有的上报版本（lastReportAt）；与当前一致时不重推初始快照。 */
  readonly since?: number | null;
  /** 可选的附加读取（如实时查库的实例统计），任一字段变化同样触发推送。 */
  readonly readExtras?: () => Promise<Record<string, unknown>>;
}

const DEFAULT_STREAM_INTERVAL_MS = 5_000;

/** 周期采样并仅在上报时间或附加数据变化时产出快照。 */
export async function* streamCrawlerMetrics(
  redis: CrawlerMetricsRedis | undefined,
  options: StreamCrawlerMetricsOptions = {},
): AsyncGenerator<StreamedCrawlerMetrics> {
  const intervalMs = options.intervalMs ?? DEFAULT_STREAM_INTERVAL_MS;
  let lastReportAt = options.since ?? null;
  let lastExtrasJson: string | null = null;
  while (!options.signal?.aborted) {
    const [report, extras] = await Promise.all([readCrawlerMetrics(redis), options.readExtras?.()]);
    const extrasChanged = extras != null && JSON.stringify(extras) !== lastExtrasJson;
    if (report.lastReportAt !== lastReportAt || extrasChanged) {
      lastReportAt = report.lastReportAt;
      if (extras != null) lastExtrasJson = JSON.stringify(extras);
      yield { ...report, ...(extras ?? {}) };
    }
    await sleepOrAborted(intervalMs, options.signal);
  }
}

export interface CrawlerMetricsPublisher {
  stop(): void;
}

export interface CrawlerMetricsPublisherOptions {
  readonly metrics: Pick<MetricsRegistry, 'snapshot'>;
  readonly redis?: CrawlerMetricsRedis;
  readonly workerId: string;
  readonly intervalMs?: number;
  readonly proxyPool?: Pick<ProxyPool, 'snapshot'>;
}

const DEFAULT_PUBLISH_INTERVAL_MS = 10_000;

/** 爬虫进程内周期发布计数器；无 Redis 时空操作。 */
export function startCrawlerMetricsPublisher(options: CrawlerMetricsPublisherOptions): CrawlerMetricsPublisher {
  const { redis } = options;
  if (!redis) return { stop(): void { /* 未配置 Redis，无需发布 */ } };
  const startedAt = Date.now();
  const publish = (): void => {
    const counters = { ...options.metrics.snapshot().crawler, ...options.proxyPool?.snapshot() };
    publishCrawlerMetrics(redis, options.workerId, counters, startedAt).catch(() => undefined);
  };
  publish();
  const timer = setInterval(publish, options.intervalMs ?? DEFAULT_PUBLISH_INTERVAL_MS);
  timer.unref?.();
  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}

function sleepOrAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

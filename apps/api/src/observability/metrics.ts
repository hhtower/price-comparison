import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { KyselyPlugin, QueryId, QueryResult, RootOperationNode, UnknownRow } from 'kysely';
import type { Pool } from 'pg';
import {
  getRequestContext,
  updateRequestContext,
  type StructuredLogger,
} from './request-context.js';

export interface RequestMetric {
  readonly route: string;
  readonly method: string;
  readonly statusCode: number;
  readonly durationMs: number;
}

export interface PoolStats {
  readonly total: number;
  readonly idle: number;
  readonly waiting: number;
  readonly max: number;
}

export interface WorkerMetric {
  readonly kind: string;
  readonly status: 'succeeded' | 'failed' | 'requeued';
  readonly durationMs: number;
}

export interface MetricsSnapshot {
  readonly requests: {
    readonly count: number;
    readonly errors: number;
    readonly errorRate: number;
    readonly totalDurationMs: number;
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly p99Ms: number;
  };
  readonly database: {
    readonly queries: number;
    readonly totalDurationMs: number;
    readonly p95Ms: number;
  };
  readonly pool: PoolStats & { readonly utilization: number };
  readonly redis: {
    readonly hits: number;
    readonly misses: number;
    readonly hitRate: number;
  };
  readonly queues: Readonly<Record<string, number>>;
  readonly crawler: Readonly<Record<string, number>>;
  readonly standardization: {
    readonly standardizationPlanningMs: number;
    readonly aiQueueWaitMs: number;
    readonly aiFirstContentMs: number;
    readonly aiResponseMs: number;
    readonly aiRetryTotal: number;
  };
  readonly workers: Readonly<
    Record<
      string,
      {
        readonly total: number;
        readonly succeeded: number;
        readonly failed: number;
        readonly requeued: number;
        readonly totalDurationMs: number;
        readonly throughputPerSecond: number;
      }
    >
  >;
}

export interface RequestMetricsRecorder {
  observeRequest(metric: RequestMetric): void;
}

export interface AiTimingMetric {
  readonly queueWaitMs: number;
  readonly firstContentMs: number | null;
  readonly responseMs: number;
  readonly retryClass?: string | null;
}

const DEFAULT_SLOW_QUERY_MS = 250;
const MAX_SAMPLES = 10_000;

export interface ConnectionBudget {
  readonly api: number;
  readonly crawler: number;
  readonly ai: number;
  readonly standardization: number;
}

/** Validate per-role pool shares before workers can starve the API pool. */
export function getConnectionBudget(environment: NodeJS.ProcessEnv = process.env): ConnectionBudget {
  const read = (name: string, fallback: number): number => {
    const raw = environment[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    return value;
  };
  const poolMax = read('PG_POOL_MAX', 10);
  const roleDefault = (requested: number, used: number): number => Math.max(0, Math.min(requested, poolMax - used));
  const api = read('API_CONNECTIONS', 2);
  const crawler = read('CRAWLER_CONNECTIONS', roleDefault(1, api));
  const ai = read('AI_CONNECTIONS', roleDefault(2, api + crawler));
  const standardization = read('STANDARDIZATION_CONNECTIONS', roleDefault(2, api + crawler + ai));
  const budget = {
    api,
    crawler,
    ai,
    standardization,
  } satisfies ConnectionBudget;
  if (budget.api < 2) throw new Error('connection budget must reserve at least 2 API connections');
  if (budget.api + budget.crawler + budget.ai + budget.standardization > poolMax) {
    throw new Error('connection budget exceeds PG_POOL_MAX');
  }
  return budget;
}

export class MetricsRegistry implements RequestMetricsRecorder {
  private readonly requestDurations: number[] = [];
  private readonly queues = new Map<string, number>();
  private readonly workers = new Map<
    string,
    {
      total: number;
      succeeded: number;
      failed: number;
      requeued: number;
      totalDurationMs: number;
      firstAt: number;
    }
  >();
  private requestCount = 0;
  private requestErrorCount = 0;
  private requestTotalDurationMs = 0;
  private databaseQueryCount = 0;
  private databaseQueryTotalDurationMs = 0;
  private readonly databaseQueryDurations: number[] = [];
  private redisHits = 0;
  private redisMisses = 0;
  private pool: PoolStats = { total: 0, idle: 0, waiting: 0, max: 0 };
  private readonly standardizationMetrics = {
    standardizationPlanningMs: 0,
    aiQueueWaitMs: 0,
    aiFirstContentMs: 0,
    aiResponseMs: 0,
    aiRetryTotal: 0,
  };
  private readonly crawlerCounters = new Map<string, number>();

  incrementCrawlerCounter(key: string): void {
    this.crawlerCounters.set(key, (this.crawlerCounters.get(key) ?? 0) + 1);
  }

  setStandardizationMetric(name: keyof typeof this.standardizationMetrics, value: number): void {
    if (name === 'aiRetryTotal') {
      this.standardizationMetrics.aiRetryTotal = Math.max(
        this.standardizationMetrics.aiRetryTotal,
        finiteCount(value),
      );
      return;
    }
    this.standardizationMetrics[name] = finiteDuration(value);
  }

  incrementStandardizationMetric(name: keyof typeof this.standardizationMetrics, amount = 1): void {
    if (name !== 'aiRetryTotal') {
      this.standardizationMetrics[name] += finiteDuration(amount);
      return;
    }
    this.standardizationMetrics.aiRetryTotal += finiteCount(amount);
  }

  observeAiTiming(metric: AiTimingMetric): void {
    this.setStandardizationMetric('aiQueueWaitMs', metric.queueWaitMs);
    if (metric.firstContentMs != null) this.setStandardizationMetric('aiFirstContentMs', metric.firstContentMs);
    this.setStandardizationMetric('aiResponseMs', metric.responseMs);
    if (metric.retryClass) this.incrementStandardizationMetric('aiRetryTotal');
  }

  observeRequest(metric: RequestMetric): void {
    this.requestCount += 1;
    if (metric.statusCode >= 400) this.requestErrorCount += 1;
    this.requestTotalDurationMs += finiteDuration(metric.durationMs);
    pushSample(this.requestDurations, metric.durationMs);
  }

  observeDatabaseQuery(durationMs: number): void {
    this.databaseQueryCount += 1;
    this.databaseQueryTotalDurationMs += finiteDuration(durationMs);
    pushSample(this.databaseQueryDurations, durationMs);
  }

  recordRedisResult(hit: boolean): void {
    if (hit) this.redisHits += 1;
    else this.redisMisses += 1;
  }

  setPoolStats(stats: PoolStats): void {
    this.pool = {
      total: Math.max(0, stats.total),
      idle: Math.max(0, stats.idle),
      waiting: Math.max(0, stats.waiting),
      max: Math.max(0, stats.max),
    };
  }

  setQueueDepth(queue: string, depth: number): void {
    this.queues.set(queue, Math.max(0, Math.floor(depth)));
  }

  recordWorker(metric: WorkerMetric): void {
    const current = this.workers.get(metric.kind) ?? {
      total: 0,
      succeeded: 0,
      failed: 0,
      requeued: 0,
      totalDurationMs: 0,
      firstAt: Date.now(),
    };
    current.total += 1;
    current[metric.status] += 1;
    current.totalDurationMs += finiteDuration(metric.durationMs);
    this.workers.set(metric.kind, current);
  }

  snapshot(now = Date.now()): MetricsSnapshot {
    const redisTotal = this.redisHits + this.redisMisses;
    const poolInUse = Math.max(0, this.pool.total - this.pool.idle);
    const workers = Object.fromEntries(
      [...this.workers.entries()].map(([kind, worker]) => [
        kind,
        {
          total: worker.total,
          succeeded: worker.succeeded,
          failed: worker.failed,
          requeued: worker.requeued,
          totalDurationMs: worker.totalDurationMs,
          throughputPerSecond:
            worker.total / Math.max(1, (now - worker.firstAt) / 1_000),
        },
      ]),
    );
    return {
      requests: {
        count: this.requestCount,
        errors: this.requestErrorCount,
        errorRate:
          this.requestCount > 0
            ? this.requestErrorCount / this.requestCount
            : 0,
        totalDurationMs: this.requestTotalDurationMs,
        p50Ms: percentile(this.requestDurations, 0.5),
        p95Ms: percentile(this.requestDurations, 0.95),
        p99Ms: percentile(this.requestDurations, 0.99),
      },
      database: {
        queries: this.databaseQueryCount,
        totalDurationMs: this.databaseQueryTotalDurationMs,
        p95Ms: percentile(this.databaseQueryDurations, 0.95),
      },
      pool: {
        ...this.pool,
        utilization: this.pool.max > 0 ? poolInUse / this.pool.max : 0,
      },
      redis: {
        hits: this.redisHits,
        misses: this.redisMisses,
        hitRate: redisTotal > 0 ? this.redisHits / redisTotal : 0,
      },
      queues: Object.freeze(Object.fromEntries(this.queues)),
      crawler: Object.freeze({ ...Object.fromEntries(this.crawlerCounters) }),
      standardization: { ...this.standardizationMetrics },
      workers: Object.freeze(workers),
    };
  }

  toPrometheus(now = Date.now()): string {
    const snapshot = this.snapshot(now);
    const lines = [
      '# TYPE http_request_duration_ms summary',
      `http_requests_total ${snapshot.requests.count}`,
      `http_request_errors_total ${snapshot.requests.errors}`,
      `http_request_error_rate ${snapshot.requests.errorRate}`,
      `http_request_duration_ms_sum ${snapshot.requests.totalDurationMs}`,
      `http_request_duration_ms{quantile="0.5"} ${snapshot.requests.p50Ms}`,
      `http_request_duration_ms{quantile="0.95"} ${snapshot.requests.p95Ms}`,
      `http_request_duration_ms{quantile="0.99"} ${snapshot.requests.p99Ms}`,
      '# TYPE db_query_duration_ms summary',
      `db_queries_total ${snapshot.database.queries}`,
      `db_query_duration_ms_sum ${snapshot.database.totalDurationMs}`,
      `db_query_duration_ms{quantile="0.95"} ${snapshot.database.p95Ms}`,
      '# TYPE db_pool_utilization gauge',
      `db_pool_utilization ${snapshot.pool.utilization}`,
      `db_pool_connections_total ${snapshot.pool.total}`,
      `db_pool_connections_idle ${snapshot.pool.idle}`,
      `db_pool_waiting_requests ${snapshot.pool.waiting}`,
      '# TYPE redis_cache_hit_rate gauge',
      `redis_cache_hit_rate ${snapshot.redis.hitRate}`,
      `redis_cache_hits_total ${snapshot.redis.hits}`,
      `redis_cache_misses_total ${snapshot.redis.misses}`,
      '# TYPE standardization_planning_ms gauge',
      `standardization_planning_ms ${snapshot.standardization.standardizationPlanningMs}`,
      '# TYPE ai_queue_wait_ms gauge',
      `ai_queue_wait_ms ${snapshot.standardization.aiQueueWaitMs}`,
      '# TYPE ai_first_content_ms gauge',
      `ai_first_content_ms ${snapshot.standardization.aiFirstContentMs}`,
      '# TYPE ai_response_ms gauge',
      `ai_response_ms ${snapshot.standardization.aiResponseMs}`,
      '# TYPE ai_retry_total counter',
      `ai_retry_total ${snapshot.standardization.aiRetryTotal}`,
    ];
    for (const [queue, depth] of Object.entries(snapshot.queues)) {
      lines.push(`queue_depth{queue="${escapeLabel(queue)}"} ${depth}`);
    }
    for (const [kind, worker] of Object.entries(snapshot.workers)) {
      const label = escapeLabel(kind);
      lines.push(`worker_jobs_total{kind="${label}"} ${worker.total}`);
      lines.push(`worker_jobs_succeeded_total{kind="${label}"} ${worker.succeeded}`);
      lines.push(`worker_jobs_failed_total{kind="${label}"} ${worker.failed}`);
      lines.push(`worker_throughput_per_second{kind="${label}"} ${worker.throughputPerSecond}`);
    }
    for (const [key, count] of Object.entries(snapshot.crawler)) {
      lines.push(`crawler_events_total{key="${escapeLabel(key)}"} ${count}`);
    }
    return `${lines.join('\n')}\n`;
  }
}

export function createDatabaseMetricsPlugin(
  metrics: MetricsRegistry,
  logger?: StructuredLogger,
  slowQueryMs = readSlowQueryThreshold(),
): KyselyPlugin {
  const startedAt = new WeakMap<QueryId, number[]>();
  return {
    transformQuery({ queryId, node }): RootOperationNode {
      const samples = startedAt.get(queryId) ?? [];
      samples.push(performance.now());
      startedAt.set(queryId, samples);
      return node;
    },
    async transformResult({
      queryId,
      result,
    }): Promise<QueryResult<UnknownRow>> {
      const samples = startedAt.get(queryId);
      const queryStartedAt = samples?.shift();
      if (queryStartedAt !== undefined) {
        const durationMs = performance.now() - queryStartedAt;
        metrics.observeDatabaseQuery(durationMs);
        const queryName = getRequestContext()?.queryName ?? 'database.query';
        if (logger && durationMs >= slowQueryMs) {
          updateRequestContext({ durationMs });
          logger.warn('database.query.slow', {
            queryName,
            duration: durationMs,
            slowQueryMs,
          });
        }
      }
      return result;
    },
  };
}

export function readSlowQueryThreshold(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const value = Number(environment.SLOW_QUERY_THRESHOLD_MS ?? DEFAULT_SLOW_QUERY_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SLOW_QUERY_MS;
}

function pushSample(samples: number[], durationMs: number): void {
  samples.push(finiteDuration(durationMs));
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
}

function finiteDuration(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function finiteCount(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function percentile(samples: readonly number[], rank: number): number {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * rank) - 1)] ?? 0;
}

function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

@Injectable()
export class MetricsService extends MetricsRegistry implements OnApplicationShutdown {
  private samplingTimer?: ReturnType<typeof setInterval>;

  startPoolSampling(
    pool: Pick<Pool, 'totalCount' | 'idleCount' | 'waitingCount' | 'options'>,
    intervalMs = 10_000,
  ): void {
    clearInterval(this.samplingTimer);
    const sample = (): void => this.setPoolStats({
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
      max: Number(pool.options.max ?? 0),
    });
    this.samplingTimer = setInterval(sample, Math.max(100, intervalMs));
    this.samplingTimer.unref?.();
    sample();
  }

  onApplicationShutdown(): void {
    clearInterval(this.samplingTimer);
  }
}

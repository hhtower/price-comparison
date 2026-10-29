import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sql } from 'kysely';
import { of, lastValueFrom, throwError } from 'rxjs';
import {
  RequestContextInterceptor,
  StructuredLogger,
  formatLogTimestamp,
  runWithWorkerContext,
} from '../src/observability/request-context.js';
import {
  MetricsRegistry,
  MetricsService,
  createDatabaseMetricsPlugin,
  getConnectionBudget,
} from '../src/observability/metrics.js';
import {
  createRateLimitStore,
  RateLimitGuard,
} from '../src/common/rate-limit.guard.js';

const root = path.resolve(import.meta.dirname, '../../..');

test('connection budgets reserve API capacity and fit the pool', () => {
  assert.deepEqual(getConnectionBudget({ PG_POOL_MAX: '10', API_CONNECTIONS: '2', CRAWLER_CONNECTIONS: '1', AI_CONNECTIONS: '3', STANDARDIZATION_CONNECTIONS: '3' }), { api: 2, crawler: 1, ai: 3, standardization: 3 });
  assert.throws(() => getConnectionBudget({ PG_POOL_MAX: '10', API_CONNECTIONS: '6', CRAWLER_CONNECTIONS: '3', AI_CONNECTIONS: '2', STANDARDIZATION_CONNECTIONS: '1' }), /budget/i);
  assert.throws(() => getConnectionBudget({ PG_POOL_MAX: '10', API_CONNECTIONS: '1' }), /at least 2/i);
});

test('Task 8 observability files are present', () => {
  for (const relativePath of [
    'apps/api/src/observability/observability.module.ts',
    'apps/api/src/observability/request-context.ts',
    'apps/api/src/observability/metrics.ts',
    'apps/api/src/common/rate-limit.guard.ts',
    'docs/deployment/postgresql.md',
    'docs/deployment/redis.md',
  ]) {
    assert.equal(fs.existsSync(path.join(root, relativePath)), true, `${relativePath} is required`);
  }
});

function httpContext(request: Record<string, unknown>, response: Record<string, unknown>) {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as never;
}

test('request IDs propagate through the interceptor and structured completion log', async () => {
  const metrics = new MetricsRegistry();
  const lines: string[] = [];
  const responseHeaders = new Map<string, string>();
  const interceptor = new RequestContextInterceptor(
    metrics,
    new StructuredLogger((line) => lines.push(line)),
  );
  const request = {
    headers: { 'x-request-id': 'request-123' },
    method: 'GET',
    url: '/v1/catalog',
    routeOptions: { url: '/v1/catalog' },
  };
  const response = {
    header: (name: string, value: string) => responseHeaders.set(name, value),
  };

  await lastValueFrom(
    interceptor.intercept(httpContext(request, response), {
      handle: () => of({ ok: true }),
    }),
  );

  assert.equal(request.requestId, 'request-123');
  assert.equal(responseHeaders.get('x-request-id'), 'request-123');
  assert.equal(metrics.snapshot().requests.count, 1);
  const record = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(record.requestId, 'request-123');
  assert.equal(record.jobId, null);
  assert.equal(record.queryName, '/v1/catalog');
  assert.equal(typeof record.duration, 'number');
});

test('unknown request errors are logged and measured as 500 instead of the POST default status', async () => {
  const metrics = new MetricsRegistry();
  const lines: string[] = [];
  const interceptor = new RequestContextInterceptor(
    metrics,
    new StructuredLogger((line) => lines.push(line)),
  );
  const response = { statusCode: 201, header: () => undefined };

  await assert.rejects(
    lastValueFrom(interceptor.intercept(httpContext({ headers: {}, method: 'POST', url: '/v1/ai/jobs/1/retry' }, response), {
      handle: () => throwError(() => new Error('database failed')),
    })),
    /database failed/,
  );

  const record = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(record.statusCode, 500);
  assert.equal(metrics.snapshot().requests.errors, 1);
});

test('worker context logs include correlation fields and redact secrets and SQL parameters', () => {
  const lines: string[] = [];
  const logger = new StructuredLogger((line) => lines.push(line));

  runWithWorkerContext(
    { workerId: 'ai-1', jobId: 42n, queryName: 'worker.ai.claim' },
    () => logger.warn('worker.failed', {
      password: 'do-not-log',
      token: 'do-not-log',
      sql: 'select * from products where id = $1',
      parameters: ['do-not-log'],
      safe: 'visible',
    }),
  );

  const record = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.match(String(record.requestId), /^worker-ai-1-/);
  assert.equal(record.jobId, '42');
  assert.equal(record.queryName, 'worker.ai.claim');
  assert.equal(typeof record.duration, 'number');
  assert.equal(record.password, '[REDACTED]');
  assert.equal(record.token, '[REDACTED]');
  assert.equal(record.safe, 'visible');
  assert.equal(lines[0]!.includes('do-not-log'), false);
  assert.equal(lines[0]!.includes('select * from products'), false);
});

test('rate limits return 429 and a retry-after header after the configured budget', async () => {
  let hits = 0;
  const store = { hit: async (_key: string, windowMs: number) => ({ count: ++hits, retryAfterMs: windowMs }) };
  const guard = new RateLimitGuard(store, { maxRequests: 1, windowMs: 10_000 });
  const headers = new Map<string, string>();
  const request = { ip: '198.51.100.10', method: 'GET', url: '/v1/catalog' };
  const response = {
    header: (name: string, value: string) => headers.set(name, value),
  };
  const context = httpContext(request, response);

  assert.equal(await guard.canActivate(context), true);
  await assert.rejects(
    guard.canActivate(context),
    (error: unknown) =>
      Boolean(
        error &&
          typeof error === 'object' &&
          'getStatus' in error &&
          (error as { getStatus: () => number }).getStatus() === 429,
      ),
  );
  assert.equal(headers.get('retry-after'), '10');
  await guard.onApplicationShutdown();
});

test('production rate-limit factory fails closed instead of keeping per-process state', async () => {
  const store = createRateLimitStore({ REDIS_URL: '' });
  await assert.rejects(
    store.hit('rate-limit:test', 1_000),
    /Redis.*required|unavailable/i,
  );
  await store.close?.();
});

test('database plugin records duration and logs slow queries without SQL parameters', async () => {
  const metrics = new MetricsRegistry();
  const lines: string[] = [];
  const plugin = createDatabaseMetricsPlugin(metrics, new StructuredLogger((line) => lines.push(line)), 0);
  const queryId = { queryId: 'catalog.list' };
  const node = sql`select ${'do-not-log'}`.toOperationNode();
  const result = { rows: [{ name: 'ok' }] };
  await runWithWorkerContext(
    { workerId: 'observability-test', jobId: 42n, queryName: 'catalog.list' },
    async () => {
      assert.equal(plugin.transformQuery({ queryId, node }), node);
      assert.equal(await plugin.transformResult({ queryId, result }), result);
    },
  );

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.database.queries, 1);
  assert.ok(snapshot.database.totalDurationMs >= 0);
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(record.queryName, 'catalog.list');
  assert.equal(record.jobId, '42');
  assert.equal(typeof record.duration, 'number');
  assert.equal(record.sql, undefined);
  assert.equal(record.parameters, undefined);
  assert.equal(lines[0]!.includes('do-not-log'), false);
});

test('metrics expose pool, cache, queue, and worker signals', () => {
  const metrics = new MetricsRegistry();
  metrics.observeRequest({
    route: '/v1/catalog',
    method: 'GET',
    statusCode: 200,
    durationMs: 12,
  });
  metrics.observeRequest({
    route: '/v1/catalog',
    method: 'GET',
    statusCode: 503,
    durationMs: 18,
  });
  metrics.setPoolStats({ total: 8, idle: 2, waiting: 1, max: 10 });
  metrics.recordRedisResult(true);
  metrics.recordRedisResult(false);
  metrics.setQueueDepth('ai_batch', 7);
  metrics.recordWorker({ kind: 'ai', status: 'succeeded', durationMs: 20 });
  const snapshot = metrics.snapshot();

  assert.equal(snapshot.pool.utilization, 0.6);
  assert.equal(snapshot.requests.errors, 1);
  assert.equal(snapshot.requests.errorRate, 0.5);
  assert.equal(snapshot.redis.hitRate, 0.5);
  assert.equal(snapshot.queues.ai_batch, 7);
  assert.equal(snapshot.workers.ai.succeeded, 1);
  assert.match(metrics.toPrometheus(), /queue_depth\{queue="ai_batch"\} 7/);
  assert.match(metrics.toPrometheus(), /worker_throughput_per_second\{kind="ai"\}/);
});

test('pool sampling starts immediately, replaces the old timer and stops on shutdown', context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const metrics = new MetricsService();
  context.after(() => metrics.onApplicationShutdown());
  let reads = 0;
  const first = { get totalCount() { reads++; return 2; }, idleCount: 1, waitingCount: 0, options: { max: 4 } };
  metrics.startPoolSampling(first, 1);
  assert.equal(metrics.snapshot().pool.utilization, 0.25);
  context.mock.timers.tick(99);
  assert.equal(reads, 1);
  context.mock.timers.tick(1);
  assert.equal(reads, 2);
  const second = { totalCount: 5, idleCount: 2, waitingCount: 1, options: { max: 10 } };
  metrics.startPoolSampling(second, 100);
  context.mock.timers.tick(100);
  assert.equal(reads, 2, 'the replaced pool must no longer be sampled');
  assert.equal(metrics.snapshot().pool.total, 5);
  metrics.onApplicationShutdown();
  second.totalCount = 9;
  context.mock.timers.tick(100);
  assert.equal(metrics.snapshot().pool.total, 5);
});

test('standardization metrics start at zero, export stable names, and retry counts are monotonic', () => {
  const metrics = new MetricsRegistry();
  assert.deepEqual(metrics.snapshot().standardization, {
    standardizationPlanningMs: 0,
    aiQueueWaitMs: 0,
    aiFirstContentMs: 0,
    aiResponseMs: 0,
    aiRetryTotal: 0,
  });
  metrics.setStandardizationMetric('aiResponseMs', 42);
  metrics.setStandardizationMetric('aiRetryTotal', 3);
  metrics.setStandardizationMetric('aiRetryTotal', 1);
  metrics.incrementStandardizationMetric('aiRetryTotal', 2);
  assert.equal(metrics.snapshot().standardization.aiResponseMs, 42);
  assert.equal(metrics.snapshot().standardization.aiRetryTotal, 5);
  const output = metrics.toPrometheus();
  assert.match(output, /# TYPE ai_retry_total counter\nai_retry_total 5/);
  assert.match(output, /ai_response_ms 42/);
});

test('deployment configuration defines roles, probes, non-root shutdown, and operations docs', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  const devCompose = fs.readFileSync(path.join(root, 'docker-compose.dev.yml'), 'utf8');
  const env = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  const postgres = fs.readFileSync(path.join(root, 'docs/deployment/postgresql.md'), 'utf8');
  const redis = fs.readFileSync(path.join(root, 'docs/deployment/redis.md'), 'utf8');

  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /STOPSIGNAL SIGTERM/);
  assert.match(compose, /worker-ai:/);
  assert.match(compose, /worker-standardization:/);
  assert.match(compose, /worker-crawler:/);
  assert.match(compose, /stop_grace_period:/);
  assert.match(devCompose, /service_healthy/);
  assert.match(env, /RATE_LIMIT_MAX=/);
  assert.match(env, /SLOW_QUERY_THRESHOLD_MS=/);
  assert.match(postgres, /pool_mode\s*=\s*transaction/);
  assert.match(postgres, /pg_stat_statements/);
  assert.match(postgres, /PgBouncer/);
  assert.match(postgres, /log_min_duration_statement/);
  assert.match(redis, /Lua/);
  assert.match(redis, /redis_cache_hit_rate/);
});

test('structured log timestamps use local year-month-day hour-minute-second format', () => {
  assert.equal(formatLogTimestamp(new Date(2026, 8, 17, 23, 5, 9)), '2026-09-17 23:05:09');
  const lines: string[] = [];
  new StructuredLogger((line) => lines.push(line)).log('timestamp-format');
  const record = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.match(String(record.timestamp), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

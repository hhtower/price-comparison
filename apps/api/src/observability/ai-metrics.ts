import type { StructuredLogger } from './request-context.js';
import type { MetricsRegistry } from './metrics.js';

export interface AiMetricsRedis {
  hincrby(key: string, field: string, increment: number): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export function asAiMetricsRedis(value: unknown): AiMetricsRedis | undefined {
  const redis = value as Partial<AiMetricsRedis> | undefined;
  return typeof redis?.hincrby === 'function' && typeof redis.expire === 'function' ? redis as AiMetricsRedis : undefined;
}

export interface AiTimingInput {
  stage: 'standardization';
  queueWaitMs: number;
  firstContentMs: number | null;
  responseMs: number;
  inputBytes: number;
  outputBytes: number;
  retryClass: string | null;
  workerId?: string;
  jobId?: string | bigint;
  taskId?: string | bigint;
}

const TTL_SECONDS = readTtlSeconds();
const BUCKETS = [50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000];

export async function recordAiTiming(redis: AiMetricsRedis | undefined, input: AiTimingInput, logger?: StructuredLogger, metrics?: Pick<MetricsRegistry, 'observeAiTiming'>): Promise<void> {
  metrics?.observeAiTiming(input);
  logger?.log('ai.timing', {
    stage: input.stage, workerId: input.workerId, jobId: input.jobId, taskId: input.taskId,
    queueWaitMs: finite(input.queueWaitMs), firstContentMs: input.firstContentMs == null ? null : finite(input.firstContentMs),
    responseMs: finite(input.responseMs), retryClass: input.retryClass,
  });
  if (!redis) return;
  const day = new Date().toISOString().slice(0, 10);
  const key = `ai:timing:${day}:${input.stage}:${input.workerId?.trim() || 'unknown'}`;
  const values: Array<[string, number]> = [
    ['queue_wait_ms_sum', finite(input.queueWaitMs)], ['response_ms_sum', finite(input.responseMs)],
    ['input_bytes_sum', finite(input.inputBytes)], ['output_bytes_sum', finite(input.outputBytes)], ['count', 1],
  ];
  if (input.firstContentMs != null) values.push(['first_content_ms_sum', finite(input.firstContentMs)]);
  if (input.retryClass) values.push([`retry_${input.retryClass}`, 1]);
  for (const [field, amount] of values) await redis.hincrby(key, field, amount);
  for (const [name, value] of [['queue_wait_ms', input.queueWaitMs], ['first_content_ms', input.firstContentMs], ['response_ms', input.responseMs]] as const) {
    if (value == null) continue;
    for (const bucket of BUCKETS) if (finite(value) <= bucket) await redis.hincrby(key, `${name}_bucket_${bucket}`, 1);
    await redis.hincrby(key, `${name}_bucket_inf`, 1);
  }
  await redis.expire(key, TTL_SECONDS);
}

function finite(value: number): number { return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0; }

function readTtlSeconds(): number {
  const value = Number(process.env.AI_METRICS_TTL_SECONDS ?? 172_800);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('AI_METRICS_TTL_SECONDS must be a positive integer');
  return value;
}

export class AiMetricsRecorder {
  constructor(private readonly redis?: AiMetricsRedis, private readonly logger?: StructuredLogger, private readonly metrics?: Pick<MetricsRegistry, 'observeAiTiming'>) {}
  recordAiTiming(input: AiTimingInput): Promise<void> { return recordAiTiming(this.redis, input, this.logger, this.metrics); }
}

export type AiTimingRecorder = Pick<AiMetricsRecorder, 'recordAiTiming'>;

export async function recordAiTimingSafely(recorder: AiTimingRecorder | undefined, input: AiTimingInput, logger?: { warn?: (...args: unknown[]) => void }): Promise<void> {
  if (!recorder) return;
  try { await recorder.recordAiTiming(input); }
  catch (error) { logger?.warn?.('ai timing record failed', error); }
}

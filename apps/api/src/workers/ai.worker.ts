import 'reflect-metadata';
import '../config/env.js';
import { NestFactory } from '@nestjs/core';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { AppModule } from '../app.module.js';
import { JobsRepository } from '../jobs/jobs.repository.js';
import { AiRepository } from '../ai/ai.repository.js';
import { createAiWorker as createWorker, createOpenAiModelCall } from '../ai/ai.worker.js';
import { MetricsService } from '../observability/metrics.js';
import { StructuredLogger } from '../observability/request-context.js';
import { createAiConcurrencyCoordinator, createAiConcurrencyRedisClient, readAiConcurrency } from '../ai/ai-concurrency.js';
import { AiMetricsRecorder, asAiMetricsRedis } from '../observability/ai-metrics.js';
import { requireAiStandardizationWorker } from '../ai/ai-standardization-features.js';
export const createAiWorker = createWorker;

export async function main(): Promise<void> {
  requireAiStandardizationWorker();
  const context = await NestFactory.createApplicationContext(AppModule);
  const repository = context.get(AiRepository);
  const logger = context.get(StructuredLogger);
  const concurrency = readAiConcurrency(process.env);
  const redis = createAiConcurrencyRedisClient(process.env);
  const metrics = context.get(MetricsService);
  const modelCall = createOpenAiModelCall(repository, process.env, undefined, logger);
  const worker = createAiWorker(context.get(JobsRepository), {
    repository,
    modelCall,
    concurrency,
    aiConcurrency: concurrency,
    aiCoordinator: createAiConcurrencyCoordinator(redis, { concurrency }),
    aiStage: 'standardization',
    logger,
    metrics,
    aiMetrics: new AiMetricsRecorder(asAiMetricsRedis(redis), logger, metrics),
  });
  const shutdown = async () => { await worker.stop(); redis.disconnect?.(); await context.close(); };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  worker.start();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) void main();

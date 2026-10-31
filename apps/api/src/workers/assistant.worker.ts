import 'reflect-metadata';
import '../config/env.js';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { ASSISTANT_LIMITS } from '@price-comparison/catalog/assistant-contract';
import { AppModule } from '../app.module.js';
import { JobsRepository } from '../jobs/jobs.repository.js';
import { AssistantRepository } from '../assistant/assistant.repository.js';
import { AssistantService } from '../assistant/assistant.service.js';
import { readAssistantConfig } from '../assistant/assistant.config.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { createStreamingCall } from '../ai/llm-runtime.js';
import { createAiConcurrencyCoordinator, createAiConcurrencyRedisClient, readAiConcurrency } from '../ai/ai-concurrency.js';
import { MetricsService } from '../observability/metrics.js';
import { StructuredLogger } from '../observability/request-context.js';
import { WorkerRuntime } from './worker-runtime.js';

export async function main(): Promise<void> {
  const cleanupOnly = process.argv.includes('--cleanup');
  const config = readAssistantConfig(cleanupOnly ? { ...process.env, ASSISTANT_ENABLED: 'false' } : process.env);
  if (!config.enabled && !cleanupOnly) { console.log('AI 导购助手未启用'); return; }
  const context = await NestFactory.createApplicationContext(AppModule);
  const repository = context.get(AssistantRepository);
  await repository.cleanupExpired();
  if (cleanupOnly) { await context.close(); return; }
  const logger = context.get(StructuredLogger);
  const redis = createAiConcurrencyRedisClient();
  const concurrency = readAiConcurrency();
  const service = new AssistantService(repository, context.get(CatalogService), createStreamingCall({
    ...process.env, AI_MAX_OUTPUT_BYTES: String(ASSISTANT_LIMITS.outputMaxBytes),
  }, undefined, logger), config.model!);
  const worker = new WorkerRuntime({
    service: context.get(JobsRepository), kind: 'assistant_turn', workerId: `assistant-${randomUUID()}`,
    handler: (job, signal, execution) => {
      logger.log('assistant.started', { turnId: job.id.toString(), queueWaitMs: execution?.aiLease?.queueWaitMs ?? 0 });
      return service.runTurn(job, signal);
    },
    beforeExecute: async () => { await repository.cleanupExpired(); },
    concurrency, aiConcurrency: concurrency,
    aiCoordinator: createAiConcurrencyCoordinator(redis, { concurrency }), aiStage: 'assistant',
    heartbeatMs: ASSISTANT_LIMITS.workerHeartbeatMs, metrics: context.get(MetricsService), logger,
  });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await worker.stop();
    redis.disconnect?.();
    await context.close();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  worker.start();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().catch(() => { console.error('AI 导购 worker 启动失败，请检查配置与数据库迁移'); process.exitCode = 1; });
}

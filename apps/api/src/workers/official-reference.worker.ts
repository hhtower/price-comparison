import 'reflect-metadata';
import '../config/env.js';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Dispatcher } from 'undici';
import { DatabaseModule } from '../database/database.module.js';
import { HostRateLimiter } from '../crawler/rate-limiter.js';
import { ProxyPool, ProxyAuthenticationError, createDispatcher } from '../crawler/proxy-pool.js';
import { createRunFetchFactory, type CrawlerFetch } from '../crawler/fetch-client.js';
import type { ClaimedJob } from '../jobs/jobs.repository.js';
import { OfficialReferenceRepository } from '../official-reference/official-reference.repository.js';
import { readOfficialReferenceConfig } from '../official-reference/official-reference.config.js';
import { fetchReferenceRegion, ReferenceUnavailableError } from '../official-reference/official-reference.collector.js';
import { fetchSourceText, parseExchangeRates } from '../official-reference/official-reference.sources.js';
import { WorkerRuntime } from './worker-runtime.js';

export const REFERENCE_FX_URL = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/cny.json';

export function createOfficialReferenceHandler(
  store: Pick<OfficialReferenceRepository, 'publish' | 'markUnavailable'>,
  fetchFactory: (signal: AbortSignal) => CrawlerFetch,
  collectRegion = fetchReferenceRegion,
) {
  return async (job: ClaimedJob, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
    const fetcher = fetchFactory(bounded);
    try {
      let snapshot: unknown;
      if (job.row.task_key === 'fx') {
        const rates = parseExchangeRates(JSON.parse(await fetchSourceText(REFERENCE_FX_URL, fetcher, bounded)));
        snapshot = { date: rates.date, cny: rates.rates };
      } else {
        snapshot = await collectRegion(String(job.row.app_id), String(job.row.country), fetcher, bounded);
      }
      bounded.throwIfAborted();
      await store.publish(job, snapshot, bounded);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ProxyAuthenticationError) throw error;
      if (error instanceof ReferenceUnavailableError && error.appId === job.row.app_id && error.country === job.row.country) {
        bounded.throwIfAborted();
        await store.markUnavailable(job, bounded);
        return;
      }
      // Retry/backoff belong to WorkerRuntime. Do not leak transport configuration into logs or DB.
      throw new Error('Official reference upstream request failed');
    }
  };
}

@Module({ imports: [DatabaseModule], providers: [OfficialReferenceRepository] })
class OfficialReferenceWorkerModule {}

async function main(): Promise<void> {
  const config = readOfficialReferenceConfig();
  if (!config.enabled) { console.log('官网正价参考 worker 已禁用'); return; }
  if (!config.proxyUrl) throw new Error('官网正价参考抓取需要配置 AI_PROXY_URL 或 OFFICIAL_REFERENCE_PROXY_URL');
  const context = await NestFactory.createApplicationContext(OfficialReferenceWorkerModule, { logger: ['error', 'warn'] });
  const dispatchers: Dispatcher[] = [];
  let worker: WorkerRuntime | undefined;
  try {
    const repository = context.get(OfficialReferenceRepository);
    repository.intervalMs = config.intervalMs;
    await repository.seed();
    const pool = new ProxyPool([config.proxyUrl], { dispatcherFactory: url => {
      const dispatcher = createDispatcher(url); dispatchers.push(dispatcher); return dispatcher;
    } });
    const limiter = new HostRateLimiter(new Map([['apps.apple.com', 1000], ['cdn.jsdelivr.net', 1000]]));
    worker = new WorkerRuntime({ service: repository, kind: 'fetch_run', workerId: 'official-reference-' + randomUUID(),
      concurrency: config.concurrency, pollMs: 1000, transientMaxAttempts: 3,
      handler: createOfficialReferenceHandler(repository, createRunFetchFactory({ pool, limiter, maxResponseBytes: 4 * 1024 * 1024 })),
      logger: { error: () => console.error('官网正价参考任务失败，将按调度重试') },
    });
    const stopped = new Promise<void>(resolveStop => {
      process.once('SIGINT', resolveStop); process.once('SIGTERM', resolveStop);
    });
    worker.start();
    console.log('官网正价参考 worker 已启动：后台定期更新地区报价和汇率');
    await stopped;
  } finally {
    await worker?.stop();
    await Promise.allSettled(dispatchers.map(dispatcher => dispatcher.close()));
    await context.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().catch(() => { console.error('官网正价参考 worker 启动失败，请检查数据库迁移和代理配置'); process.exitCode = 1; });
}

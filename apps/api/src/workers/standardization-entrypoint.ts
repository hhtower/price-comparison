import 'reflect-metadata';
import '../config/env.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { requireIncrementalStandardizationWorker } from '../ai/ai-standardization-features.js';
import { StandardizationWorker } from './standardization.worker.js';

export async function main(): Promise<void> {
  requireIncrementalStandardizationWorker();
  const context = await NestFactory.createApplicationContext(AppModule);
  const worker = context.get(StandardizationWorker);
  const controller = new AbortController();
  const shutdown = async () => {
    controller.abort();
    await context.close();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  try {
    await worker.start(controller.signal);
  } finally {
    await context.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) void main();

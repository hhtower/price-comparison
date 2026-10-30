import 'reflect-metadata';
import './config/env.js';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Pool } from 'pg';
import { AppModule } from './app.module.js';
import { PG_POOL } from './database/database.providers.js';
import { MetricsService } from './observability/metrics.js';
import { CatalogService } from './catalog/catalog.service.js';
import { registerPublicPages } from './seo/public-pages.js';
import { registerStaticAssets } from './seo/static-assets.js';
import {
  createRequestId,
  StructuredLogger,
} from './observability/request-context.js';

const DEFAULT_PORT = 3000;
const DEFAULT_BODY_LIMIT = 1_048_576;

export async function createApp(): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({ logger: true, bodyLimit: DEFAULT_BODY_LIMIT });
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    adapter,
  );
  const fastify = app.getHttpAdapter().getInstance();
  const clientRoot = resolve(process.cwd(), 'dist/client');
  const metrics = app.get(MetricsService);
  const logger = app.get(StructuredLogger);

  fastify.addHook('onRequest', (request, reply, done) => {
    const requestId = createRequestId(
      request.headers['x-request-id'] ?? request.id,
    );
    reply.header('x-request-id', requestId);
    done();
  });
  fastify.get('/metrics', async (_request, reply) => {
    reply.type('text/plain; version=0.0.4');
    return metrics.toPrometheus();
  });
  fastify.get('/ready', async (_request, reply) => {
    try {
      const pool = app.get<Pool>(PG_POOL);
      await pool.query('select 1');
      return { ok: true };
    } catch {
      reply.code(503);
      return { ok: false };
    }
  });
  if (existsSync(resolve(clientRoot, 'index.html'))) {
    registerPublicPages(adapter, {
      template: readFileSync(resolve(clientRoot, 'index.html'), 'utf8'),
      siteUrl: process.env.PUBLIC_SITE_URL,
      getCatalog: input => app.get(CatalogService).getCatalog(input ?? { limit: 20 }),
      getProducts: () => app.get(CatalogService).getProducts(),
      getProduct: id => app.get(CatalogService).getProduct(id),
    });
    registerStaticAssets(fastify, clientRoot);
  }
  app.enableVersioning({ type: VersioningType.URI });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.enableShutdownHooks();
  try {
    metrics.startPoolSampling(app.get<Pool>(PG_POOL));
  } catch {
    logger.warn('database.pool.metrics_unavailable');
  }
  return app;
}

async function bootstrap(): Promise<void> {
  const app = await createApp();
  const port = Number.parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
  await app.listen(Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT, '0.0.0.0');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void bootstrap();
}

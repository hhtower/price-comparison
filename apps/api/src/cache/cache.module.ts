import { Global, Module } from '@nestjs/common';
import { createKeyvNonBlocking } from '@keyv/redis';
import { KeyvHooks } from 'keyv';
import { CACHE, createCache, createMemoryStore, type CacheOptions } from './cache.js';
import { ObservabilityModule } from '../observability/observability.module.js';
import { MetricsRegistry } from '../observability/metrics.js';

export const CATALOG_CACHE_TTL_MS = 30_000;
export const CATALOG_MEMORY_CACHE_ENTRIES = 128;
export const MAX_CATALOG_CACHE_BYTES = 512 * 1024;

export function catalogCacheOptions(
  environment: NodeJS.ProcessEnv = process.env,
  metrics?: Pick<MetricsRegistry, 'recordRedisResult'>,
): CacheOptions {
  const stores = [createMemoryStore(CATALOG_CACHE_TTL_MS, CATALOG_MEMORY_CACHE_ENTRIES)];
  const url = environment.REDIS_URL?.trim();
  if (url) {
    const redis = createKeyvNonBlocking({
      url, disableOfflineQueue: true, commandsQueueMaxLength: 128,
      socket: { connectTimeout: 1_000, socketTimeout: 1_000, reconnectStrategy: false },
    }, { namespace: 'catalog-v11', connectionTimeout: 1_000 });
    const recordRead = ({ value }: { value?: { value?: unknown } }) => metrics?.recordRedisResult(value?.value !== undefined);
    redis.onHook(KeyvHooks.AFTER_GET, recordRead);
    redis.onHook(KeyvHooks.AFTER_GET_RAW, recordRead);
    stores.push(redis);
  }
  return { stores, ttl: CATALOG_CACHE_TTL_MS, maxBytes: MAX_CATALOG_CACHE_BYTES };
}

@Global()
@Module({
  imports: [ObservabilityModule],
  providers: [{
    provide: CACHE,
    inject: [MetricsRegistry],
    useFactory: (metrics: MetricsRegistry) => createCache(catalogCacheOptions(process.env, metrics)),
  }],
  exports: [CACHE],
})
export class CatalogCacheModule {}

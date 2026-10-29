import { Module } from '@nestjs/common';
import { CacheModule, type CacheModuleOptions } from '@nestjs/cache-manager';
import { createKeyv as createMemoryKeyv } from 'cacheable';
import { createKeyvNonBlocking } from '@keyv/redis';
import { KeyvHooks } from 'keyv';
import { ObservabilityModule } from '../observability/observability.module.js';
import { MetricsRegistry } from '../observability/metrics.js';

export const CATALOG_CACHE_TTL_MS = 30_000;
export const CATALOG_MEMORY_CACHE_ENTRIES = 128;
export const MAX_CATALOG_CACHE_BYTES = 512 * 1024;

export function catalogCacheOptions(
  environment: NodeJS.ProcessEnv = process.env,
  metrics?: Pick<MetricsRegistry, 'recordRedisResult'>,
): CacheModuleOptions {
  const stores = [createMemoryKeyv({ ttl: CATALOG_CACHE_TTL_MS, lruSize: CATALOG_MEMORY_CACHE_ENTRIES })];
  const url = environment.REDIS_URL?.trim();
  if (url) {
    const redis = createKeyvNonBlocking({
      url, disableOfflineQueue: true, commandsQueueMaxLength: 128,
      socket: { connectTimeout: 1_000, socketTimeout: 1_000, reconnectStrategy: false },
    }, { namespace: 'catalog-v10', connectionTimeout: 1_000 });
    // Redis is optional; consume errors silently so cache fallback stays available.
    redis.on('error', () => {});
    const recordRead = ({ value }: { value?: { value?: unknown } }) => metrics?.recordRedisResult(value?.value !== undefined);
    redis.hooks.addHandler(KeyvHooks.POST_GET, recordRead);
    redis.hooks.addHandler(KeyvHooks.POST_GET_RAW, recordRead);
    stores.push(redis);
  }
  for (const store of stores) {
    store.hooks.addHandler(KeyvHooks.PRE_SET, (entry: { value: unknown; ttl?: number }) => {
      if (Buffer.byteLength(JSON.stringify(entry.value) ?? '', 'utf8') <= MAX_CATALOG_CACHE_BYTES) return;
      // Keyv has no skip-write flag. A short-lived undefined entry remains a
      // cache miss, while wrap() returns the complete loader result unchanged.
      entry.value = undefined;
      entry.ttl = 1;
    });
  }
  return { stores, ttl: CATALOG_CACHE_TTL_MS, refreshThreshold: 0, nonBlocking: false };
}

@Module({
  imports: [CacheModule.registerAsync({
    isGlobal: true,
    imports: [ObservabilityModule],
    inject: [MetricsRegistry],
    useFactory: (metrics: MetricsRegistry) => catalogCacheOptions(process.env, metrics),
  })],
  exports: [CacheModule],
})
export class CatalogCacheModule {}

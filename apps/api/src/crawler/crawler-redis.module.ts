import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import type { CrawlerMetricsRedis } from './metrics-store.js';
import type { HostRateLimitRedis } from './rate-limiter.js';

export const CRAWLER_METRICS_REDIS = Symbol('CRAWLER_METRICS_REDIS');
export interface CrawlerRedisClient extends CrawlerMetricsRedis, HostRateLimitRedis { disconnect(): void }

export function createCrawlerRedis(environment: NodeJS.ProcessEnv = process.env): CrawlerRedisClient | undefined {
  const url = environment.REDIS_URL?.trim();
  if (!url) return undefined;
  const redis = new Redis(url, { enableOfflineQueue: true, maxRetriesPerRequest: 1, connectTimeout: 5_000, commandTimeout: 5_000 });
  redis.on('error', () => undefined);
  return {
    eval: (script, numberOfKeys, ...args) => redis.eval(script, numberOfKeys, ...args),
    hset: (key, fields) => redis.hset(key, fields),
    hgetall: key => redis.hgetall(key),
    expire: (key, seconds) => redis.expire(key, seconds),
    time: () => redis.time(),
    zadd: (key, score, member) => redis.zadd(key, score, member),
    zrange: (key, start, stop) => redis.zrange(key, start, String(stop)),
    zremrangebyscore: (key, min, max) => redis.zremrangebyscore(key, min, max),
    disconnect: () => redis.disconnect(),
  };
}

@Injectable()
class CrawlerRedisShutdown implements OnApplicationShutdown {
  constructor(@Inject(CRAWLER_METRICS_REDIS) private readonly redis: CrawlerRedisClient | undefined) {}
  onApplicationShutdown(): void { this.redis?.disconnect(); }
}

@Global()
@Module({
  providers: [{ provide: CRAWLER_METRICS_REDIS, useFactory: createCrawlerRedis }, CrawlerRedisShutdown],
  exports: [CRAWLER_METRICS_REDIS],
})
export class CrawlerRedisModule {}

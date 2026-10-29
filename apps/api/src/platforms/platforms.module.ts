import { Module } from '@nestjs/common';
import { readCrawlerConfig } from '../config/env.js';
import { CRAWLER_METRICS_REDIS, type CrawlerRedisClient, CrawlerRedisModule } from '../crawler/crawler-redis.module.js';
import { createSharedHostRateLimiter } from '../crawler/rate-limiter.js';
import { PROTOCOL_DETECTION_OPTIONS, type DetectionEgress, ProtocolDetectionService } from './protocol-detection.service.js';

/** Detection probes through the same egresses the crawler uses (CRAWLER_PROXIES in order, then the self-hosted exit); direct only when unconfigured. */
export function detectionProxyOptions(environment: NodeJS.ProcessEnv = process.env): { egresses?: DetectionEgress[] } {
  const config = readCrawlerConfig(environment);
  const egresses: DetectionEgress[] = config.proxies.map(proxyUrl => ({ proxyUrl }));
  if (config.selfHostedProxyUrl) egresses.push({ proxyUrl: config.selfHostedProxyUrl, proxyDns: true });
  return egresses.length ? { egresses } : {};
}

@Module({
  imports: [CrawlerRedisModule],
  providers: [
    { provide: PROTOCOL_DETECTION_OPTIONS, inject: [CRAWLER_METRICS_REDIS],
      useFactory: (redis: CrawlerRedisClient | undefined) => ({ ...detectionProxyOptions(),
        limiter: createSharedHostRateLimiter(readCrawlerConfig().hostMinIntervalMs, redis) }) },
    ProtocolDetectionService,
  ],
  exports: [ProtocolDetectionService],
})
export class PlatformsModule {}

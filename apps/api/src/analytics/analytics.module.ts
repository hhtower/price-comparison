import { Module } from '@nestjs/common';
import { CACHE, createCache, type Cache } from '../cache/cache.js';
import { AuthModule } from '../auth/auth.module.js';
import { AnalyticsController, AdminAnalyticsController } from './analytics.controller.js';
import { AnalyticsRepository } from './analytics.repository.js';
import { analyticsCacheOptions, AnalyticsNetworkService } from './analytics-network.js';
@Module({
  imports: [AuthModule],
  controllers: [AnalyticsController, AdminAnalyticsController],
  providers: [
    AnalyticsRepository,
    { provide: CACHE, useFactory: () => createCache(analyticsCacheOptions()) },
    { provide: AnalyticsNetworkService, inject: [CACHE], useFactory: (cache: Cache) => new AnalyticsNetworkService({ cache }) },
  ],
})
export class AnalyticsModule {}

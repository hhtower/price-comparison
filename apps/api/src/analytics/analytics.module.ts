import { Module } from '@nestjs/common';
import { CACHE_MANAGER, CacheModule } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { AuthModule } from '../auth/auth.module.js';
import { AnalyticsController, AdminAnalyticsController } from './analytics.controller.js';
import { AnalyticsRepository } from './analytics.repository.js';
import { analyticsCacheOptions, AnalyticsNetworkService } from './analytics-network.js';
@Module({
  imports: [AuthModule, CacheModule.registerAsync({ useFactory: () => analyticsCacheOptions() })],
  controllers: [AnalyticsController, AdminAnalyticsController],
  providers: [AnalyticsRepository, { provide: AnalyticsNetworkService, inject: [CACHE_MANAGER], useFactory: (cache: Cache) => new AnalyticsNetworkService({ cache }) }],
})
export class AnalyticsModule {}

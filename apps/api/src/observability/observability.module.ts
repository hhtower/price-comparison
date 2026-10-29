import { Global, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import {
  RequestContextInterceptor,
  StructuredLogger,
} from './request-context.js';
import { MetricsRegistry, MetricsService } from './metrics.js';
import {
  RATE_LIMIT_OPTIONS,
  RATE_LIMIT_STORE,
  RateLimitGuard,
  createRateLimitStore,
  rateLimitOptions,
} from '../common/rate-limit.guard.js';

@Global()
@Module({
  providers: [
    MetricsService,
    { provide: MetricsRegistry, useExisting: MetricsService },
    StructuredLogger,
    {
      provide: RequestContextInterceptor,
      inject: [MetricsRegistry, StructuredLogger],
      useFactory: (
        metrics: MetricsRegistry,
        logger: StructuredLogger,
      ) => new RequestContextInterceptor(metrics, logger),
    },
    { provide: APP_INTERCEPTOR, useExisting: RequestContextInterceptor },
    {
      provide: RATE_LIMIT_STORE,
      useFactory: () => createRateLimitStore(),
    },
    {
      provide: RATE_LIMIT_OPTIONS,
      useFactory: () => rateLimitOptions(),
    },
    RateLimitGuard,
    { provide: APP_GUARD, useExisting: RateLimitGuard },
  ],
  exports: [
    MetricsRegistry,
    MetricsService,
    StructuredLogger,
    RequestContextInterceptor,
    RateLimitGuard,
  ],
})
export class ObservabilityModule {}

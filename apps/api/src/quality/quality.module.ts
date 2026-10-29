import { Module } from '@nestjs/common';
import { createAiConcurrencyCoordinator, createAiConcurrencyRedisClient, readAiConcurrency } from '../ai/ai-concurrency.js';
import { QualityController } from './quality.controller.js';
import { QualityRepository } from './quality.repository.js';
import { QualityService } from './quality.service.js';
import { createAiQualityDetector } from './ai-quality-detector.js';
import { createIpQualityDetector } from './ip-quality-detector.js';

@Module({
  controllers: [QualityController],
  providers: [QualityRepository, { provide: QualityService, inject: [QualityRepository], useFactory: (repository: QualityRepository) => {
    const redis = createAiConcurrencyRedisClient(); const concurrency = readAiConcurrency();
    return new QualityService({ repository, aiDetector: createAiQualityDetector(), ipDetector: createIpQualityDetector(), aiConcurrency: concurrency, coordinator: createAiConcurrencyCoordinator(redis, { concurrency }), close: () => redis.disconnect?.() });
  } }],
})
export class QualityModule {}

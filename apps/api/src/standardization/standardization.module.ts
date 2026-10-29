import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { StandardizationRepository } from './standardization.repository.js';
import { StandardizationWorker } from '../workers/standardization.worker.js';

@Module({
  imports: [AiModule],
  providers: [StandardizationRepository, StandardizationWorker],
  exports: [StandardizationRepository, StandardizationWorker],
})
export class StandardizationModule {}

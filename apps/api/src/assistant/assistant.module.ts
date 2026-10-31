import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RATE_LIMIT_STORE, type RateLimitStore } from '../common/rate-limit.guard.js';
import { AssistantAccess } from './assistant-access.js';
import { readAssistantConfig } from './assistant.config.js';
import { AssistantController } from './assistant.controller.js';
import { AssistantRepository } from './assistant.repository.js';

@Module({
  controllers: [AssistantController],
  providers: [
    AssistantRepository,
    {
      provide: AssistantAccess,
      inject: [RATE_LIMIT_STORE],
      useFactory: (store: RateLimitStore) => {
        readAssistantConfig();
        return new AssistantAccess(store);
      },
    },
  ],
  exports: [AssistantRepository],
})
export class AssistantModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Set this before guards so admission failures cannot be cached either.
    consumer.apply((_request: IncomingMessage, response: ServerResponse, next: () => void) => {
      response.setHeader('Cache-Control', 'no-store');
      next();
    }).forRoutes(AssistantController);
  }
}

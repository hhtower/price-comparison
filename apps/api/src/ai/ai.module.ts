import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module.js';
import { AiController } from './ai.controller.js';
import { AiAdminController } from './ai-admin.controller.js';
import { AuthModule } from '../auth/auth.module.js';
import { AiRepository } from './ai.repository.js';
import { AiService } from './ai.service.js';
@Module({ imports: [JobsModule, AuthModule], controllers: [AiController, AiAdminController], providers: [AiRepository, AiService], exports: [AiRepository, AiService] })
export class AiModule {}

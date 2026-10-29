import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { AdminController } from './admin.controller.js';
import { AdminRepository } from './admin.repository.js';
import { CrawlerTasksController } from './crawler-tasks.controller.js';
import { DiagnosticsRepository } from '../crawler/diagnostics.repository.js';
@Module({ imports: [AuthModule, JobsModule], controllers: [AdminController, CrawlerTasksController], providers: [AdminRepository, DiagnosticsRepository], exports: [AdminRepository] })
export class AdminModule {}

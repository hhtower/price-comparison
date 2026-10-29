import { Module } from '@nestjs/common';
import { JobsRepository } from './jobs.repository.js';

@Module({ providers: [JobsRepository], exports: [JobsRepository] })
export class JobsModule {}

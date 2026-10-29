import { Global, Module } from '@nestjs/common';
import { ObservabilityModule } from '../observability/observability.module.js';
import { DATABASE, databaseProviders, DatabaseService, PG_POOL } from './database.providers.js';

@Global()
@Module({
  imports: [ObservabilityModule],
  providers: [...databaseProviders, DatabaseService],
  exports: [PG_POOL, DATABASE, DatabaseService],
})
export class DatabaseModule {}

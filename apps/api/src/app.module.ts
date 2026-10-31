import { CrawlerRedisModule } from './crawler/crawler-redis.module.js';
import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { ProductsModule } from './products/products.module.js';
import { ShopsModule } from './shops/shops.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { AiModule } from './ai/ai.module.js';
import { AuthModule } from './auth/auth.module.js';
import { AdminModule } from './admin/admin.module.js';
import { ObservabilityModule } from './observability/observability.module.js';
import { ShopSubmissionsModule } from './shop-submissions/shop-submissions.module.js';
import { StandardizationModule } from './standardization/standardization.module.js';
import { ProductReportsModule } from './product-reports/product-reports.module.js';
import { QualityModule } from './quality/quality.module.js';
import { AnalyticsModule } from './analytics/analytics.module.js';
import { OfficialReferenceModule } from './official-reference/official-reference.module.js';
import { AssistantModule } from './assistant/assistant.module.js';

@Module({ imports: [CrawlerRedisModule, DatabaseModule, AuthModule, AdminModule, HealthModule, ShopsModule, ProductsModule, CatalogModule, JobsModule, AiModule, ObservabilityModule, ShopSubmissionsModule, StandardizationModule, ProductReportsModule, QualityModule, AnalyticsModule, OfficialReferenceModule, AssistantModule] })
export class AppModule {}

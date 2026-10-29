import { Module } from '@nestjs/common';
import { CatalogCacheModule } from '../cache/cache.module.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogRepository } from './catalog.repository.js';
import { CatalogService } from './catalog.service.js';
import { CatalogVersionRepository } from './catalog-version.repository.js';

@Module({ imports: [CatalogCacheModule], controllers: [CatalogController], providers: [CatalogRepository, CatalogService, CatalogVersionRepository], exports: [CatalogRepository, CatalogService, CatalogVersionRepository] })
export class CatalogModule {}

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AdminProductReportsController, ProductReportsController } from './product-reports.controller.js';
import { ProductReportsRepository } from './product-reports.repository.js';
import { ProductReportsService } from './product-reports.service.js';

@Module({
  imports: [AuthModule],
  controllers: [ProductReportsController, AdminProductReportsController],
  providers: [ProductReportsRepository, ProductReportsService],
})
export class ProductReportsModule {}

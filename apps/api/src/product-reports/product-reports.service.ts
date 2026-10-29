import { Inject, Injectable } from '@nestjs/common';
import { DomainNotFoundError, DomainValidationError } from '../common/errors.js';
import type { ProductReportReason, ProductReportStatus } from '../database/types.js';
import { ProductReportsRepository } from './product-reports.repository.js';

@Injectable()
export class ProductReportsService {
  constructor(@Inject(ProductReportsRepository) private readonly reports: ProductReportsRepository) {}

  async create(productId: bigint, reason: ProductReportReason, details: string) {
    const normalized = details.trim();
    if (reason === 'other' && !normalized) throw new DomainValidationError('REPORT_DETAILS_REQUIRED', '请填写举报说明');
    const report = await this.reports.create(productId, reason, normalized);
    if (!report) throw new DomainNotFoundError('REPORT_PRODUCT_NOT_FOUND', '该商品报价已不可用');
    return report;
  }

  list(status: ProductReportStatus, page: number, pageSize: number) { return this.reports.list(status, page, pageSize); }
  review(id: bigint, status: Exclude<ProductReportStatus, 'pending'>, reviewer: string | null) { return this.reports.review(id, status, reviewer); }
}

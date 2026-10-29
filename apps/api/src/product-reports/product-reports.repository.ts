import { Inject, Injectable } from '@nestjs/common';
import type { Kysely, Selectable } from 'kysely';
import { DATABASE } from '../database/database.providers.js';
import type { DatabaseSchema, ProductReportReason, ProductReportStatus, ProductReportTable } from '../database/types.js';
import { DomainConflictError, DomainNotFoundError } from '../common/errors.js';

export type ProductReport = Selectable<ProductReportTable>;

@Injectable()
export class ProductReportsRepository {
  constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  async create(productId: bigint, reason: ProductReportReason, details: string): Promise<ProductReport | undefined> {
    const product = await this.database.selectFrom('products as p')
      .innerJoin('shops as sh', 'sh.id', 'p.shop_id')
      .innerJoin('standard_product_members as m', 'm.product_id', 'p.id')
      .innerJoin('standard_products as sp', 'sp.id', 'm.standard_product_id')
      .innerJoin('offers as o', 'o.product_id', 'p.id')
      .select(['p.id', 'p.name', 'p.url', 'sh.name as shop_name', 'o.price', 'o.currency', 'o.captured_at'])
      .where('p.id', '=', productId)
      .where('p.deleted_at', 'is', null).where('sh.deleted_at', 'is', null).where('sh.enabled', '=', true)
      .where('m.publication_state', '=', 'published').where('sp.verification_state', '=', 'verified')
      .where('o.is_stale', '=', false).where('o.stock_available', '=', true)
      .orderBy('o.captured_at', 'desc').orderBy('o.id', 'desc').limit(1)
      .executeTakeFirst();
    if (!product) return undefined;
    return this.database.insertInto('product_reports').values({
      product_id: product.id, product_name: product.name, shop_name: product.shop_name,
      product_url: product.url, price: product.price, currency: product.currency,
      price_captured_at: product.captured_at, reason, details,
      status: 'pending', reviewed_at: null, reviewer: null,
    }).returningAll().executeTakeFirstOrThrow();
  }

  async list(status: ProductReportStatus, page: number, pageSize: number): Promise<{ items: ProductReport[]; total: number }> {
    const [items, total] = await Promise.all([
      this.database.selectFrom('product_reports').selectAll().where('status', '=', status)
        .orderBy('created_at', 'desc').orderBy('id', 'desc').limit(pageSize).offset((page - 1) * pageSize).execute(),
      this.database.selectFrom('product_reports').select(({ fn }) => fn.countAll<number>().as('count'))
        .where('status', '=', status).executeTakeFirstOrThrow(),
    ]);
    return { items, total: Number(total.count) };
  }

  async review(id: bigint, status: Exclude<ProductReportStatus, 'pending'>, reviewer: string | null): Promise<ProductReport> {
    const updated = await this.database.updateTable('product_reports')
      .set({ status, reviewed_at: new Date(), reviewer })
      .where('id', '=', id).where('status', '=', 'pending')
      .returningAll().executeTakeFirst();
    if (updated) return updated;
    const existing = await this.database.selectFrom('product_reports').select('id').where('id', '=', id).executeTakeFirst();
    if (!existing) throw new DomainNotFoundError('PRODUCT_REPORT_NOT_FOUND', '举报不存在');
    throw new DomainConflictError('PRODUCT_REPORT_ALREADY_REVIEWED', '该举报已处理');
  }
}

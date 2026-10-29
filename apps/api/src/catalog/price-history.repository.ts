import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../database/database.providers.js';
import type { DatabaseSchema } from '../database/types.js';
import { CATALOG_QUOTE_POLICY, defaultQuotePolicy, type QuotePolicy } from './quote-policy.js';

export interface PriceHistoryPoint {
  readonly date: string;
  readonly price: string;
  readonly verifiedAt: string;
  readonly productId: string;
  readonly shop: string;
  readonly name: string;
  readonly spec: string;
  readonly quantity: number;
  readonly contentVersion: string;
  readonly paymentMethod: string;
}
export interface PriceHistory { readonly currency: string; readonly days: 30; readonly startDate: string; readonly endDate: string; readonly points: readonly PriceHistoryPoint[] }

@Injectable()
export class PriceHistoryRepository {
  constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Optional() @Inject(CATALOG_QUOTE_POLICY) private readonly policy: QuotePolicy = defaultQuotePolicy()) {}

  async get(standardProductId: string, productId?: string, currency = 'CNY'): Promise<PriceHistory> {
    const now = new Date(this.policy.now()).toISOString();
    const end = Date.parse(now) + 8 * 3600000;
    const endDate = new Date(end).toISOString().slice(0, 10);
    const startDate = new Date(end - 29 * 86400000).toISOString().slice(0, 10);
    const result = await sql<Omit<PriceHistoryPoint, 'verifiedAt'> & { verifiedAt: Date }>`
      select distinct on ((h.verified_at at time zone 'Asia/Shanghai')::date)
        to_char(h.verified_at at time zone 'Asia/Shanghai', 'YYYY-MM-DD') as date,
        h.price::text as price, h.verified_at as "verifiedAt", h.product_id::text as "productId",
        sh.name as shop, h.name, h.spec, h.quantity, h.content_version::text as "contentVersion",
        h.payment_method as "paymentMethod"
      from offer_price_history h
      join products p on p.id = h.product_id and p.deleted_at is null
      join shops sh on sh.id = p.shop_id and sh.enabled and sh.deleted_at is null
      join standard_product_members m on m.product_id = p.id and m.publication_state = 'published'
        and m.standard_product_id = h.standard_product_id
      join standard_products sp on sp.id = m.standard_product_id and not sp.hidden
        and sp.verification_state = 'verified' and sp.merged_into_id is null
      where h.standard_product_id = ${standardProductId}::bigint and h.currency = ${currency}
        ${productId ? sql`and h.product_id = ${productId}::bigint` : sql``}
        and h.verified_at >= (${startDate}::date::timestamp at time zone 'Asia/Shanghai')
        and h.verified_at <= ${now}::timestamptz
      order by (h.verified_at at time zone 'Asia/Shanghai')::date, h.price,
        h.verified_at desc, h.product_id, h.id desc`.execute(this.database);
    return { currency, days: 30, startDate, endDate, points: result.rows.map(row => ({ ...row, verifiedAt: row.verifiedAt.toISOString() })) };
  }
}

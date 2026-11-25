import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../database/database.providers.js';
import type { DatabaseSchema } from '../database/types.js';
import { CATALOG_QUOTE_POLICY, defaultQuotePolicy, type QuotePolicy } from './quote-policy.js';
import { newcomerMembershipKinds, type MembershipGroup } from '@price-comparison/catalog/membership-policy';
import { catalogMembershipKind, failedMembershipFeatures } from '../standardization/membership-classification.js';

export interface PriceHistoryScope {
  readonly membershipKinds?: readonly MembershipGroup[];
  readonly newcomer?: boolean;
}

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

  async get(standardProductId: string, productId?: string, currency = 'CNY', scope: PriceHistoryScope = {}): Promise<PriceHistory> {
    const now = new Date(this.policy.now()).toISOString();
    const end = Date.parse(now) + 8 * 3600000;
    const endDate = new Date(end).toISOString().slice(0, 10);
    const startDate = new Date(end - 29 * 86400000).toISOString().slice(0, 10);
    const ai = sql<boolean>`is_ai_membership(sp.canonical_family, sp.canonical_product, sp.canonical_tier)`;
    const kind = catalogMembershipKind(ai);
    const membershipScope = scope.membershipKinds?.length
      ? sql`and ${ai} and coalesce(${kind}, 'unclassified') = any(${scope.membershipKinds}::text[])
        ${scope.membershipKinds.includes('unclassified') ? sql`and (${kind} is not null or ${failedMembershipFeatures()})` : sql``}`
      : scope.newcomer ? sql`and (not ${ai} or ${kind} = any(${newcomerMembershipKinds()}::text[]))` : sql``;
    // For groups, +0 matches the daily expression index, avoiding product-first misplans for parameterized ANY.
    const result = await sql<Omit<PriceHistoryPoint, 'verifiedAt'> & { verifiedAt: Date }>`
      with eligible_products as materialized (
        select p.id
        from products p
        join shops sh on sh.id = p.shop_id and sh.enabled and sh.deleted_at is null
        join standard_product_members m on m.product_id = p.id and m.publication_state = 'published'
        join standard_products sp on sp.id = m.standard_product_id and not sp.hidden
          and sp.verification_state = 'verified' and sp.merged_into_id is null
        where m.standard_product_id = ${standardProductId}::bigint and p.deleted_at is null
          ${membershipScope}
          ${productId ? sql`and p.id = ${productId}::bigint` : sql``}
      ), winners as (
        select ${startDate}::date + d.n as day, winner.id
        from generate_series(0, 29) as d(n)
        cross join lateral (
          select h.id
          from offer_price_history h
          where h.standard_product_id = ${standardProductId}::bigint and h.currency = ${currency}
            and h.settlement_kind = 'verified'
            ${productId ? sql`and h.product_id = ${productId}::bigint
              and h.verified_at >= ((${startDate}::date + d.n)::timestamp at time zone 'Asia/Shanghai')
              and h.verified_at < ((${startDate}::date + d.n + 1)::timestamp at time zone 'Asia/Shanghai')`
              : sql`and (h.verified_at at time zone 'Asia/Shanghai')::date = ${startDate}::date + d.n`}
            and h.verified_at <= ${now}::timestamptz
            and (h.product_id + 0) = any(array(select id from eligible_products))
          order by h.price, h.verified_at desc, (h.product_id + 0), h.id desc
          limit 1
        ) winner
      )
      select
        to_char(h.verified_at at time zone 'Asia/Shanghai', 'YYYY-MM-DD') as date,
        h.price::text as price, h.verified_at as "verifiedAt", h.product_id::text as "productId",
        sh.name as shop, h.name, h.spec, h.quantity, h.content_version::text as "contentVersion",
        h.payment_method as "paymentMethod"
      from winners w
      join offer_price_history h on h.id = w.id
      join products p on p.id = h.product_id
      join shops sh on sh.id = p.shop_id
      order by w.day`.execute(this.database);
    return { currency, days: 30, startDate, endDate, points: result.rows.map(row => ({ ...row, verifiedAt: row.verifiedAt.toISOString() })) };
  }
}

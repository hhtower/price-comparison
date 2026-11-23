import { sql } from 'kysely';

/** Match the public quote gate against the latest row, never an older in-stock offer. */
export function hasUsableOffer(productId = 'p.id') {
  return sql<boolean>`coalesce((select not eligibility_offer.is_stale and eligibility_offer.stock_available
      and eligibility_offer.price >= 0 and eligibility_offer.price < 'Infinity'::numeric
    from offers eligibility_offer where eligibility_offer.product_id = ${sql.ref(productId)}
    order by eligibility_offer.captured_at desc, eligibility_offer.id desc limit 1), false)`;
}

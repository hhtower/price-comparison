import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/types.js';
import { createTextReviewAccumulator, prepareTextReview, type ProductReviewRow } from '../shops/shop-text-review.js';
import { readShopRating } from '../shops/shop-rating.js';
import { failedMembershipFeatures, membershipGroupKind } from '../standardization/membership-classification.js';
import { MEMBERSHIP_POLICY_VERSION, membershipGroupingVersion, type MembershipKind } from '@price-comparison/catalog/membership-policy';

/** Runs only in the catalog worker; readers never prepare missing results. */
export async function publishNextCatalogChange(database: Kysely<DatabaseSchema>, now = Date.now()): Promise<boolean> {
  return database.transaction().setIsolationLevel('repeatable read').execute(async tx => {
    const lock = await sql<{ acquired: boolean }>`select pg_try_advisory_xact_lock(
      hashtext(current_schema()), hashtext('catalog-projection')) as acquired`.execute(tx);
    if (!lock.rows[0]!.acquired) return false;
    // Publish browsing results before optional scores so initial backfills do not hide the catalog.
    let change = (await sql<{ shop_id: bigint | null; standard_product_id: bigint | null }>`
      select shop_id, standard_product_id from catalog_projection_changes
      order by (shop_id is not null), id limit 1`.execute(tx)).rows[0];
    if (!change) {
      const missing = (await sql<{ standard_product_id: bigint }>`select standard_product_id
        from catalog_read_shop_totals where membership_policy_version is distinct from ${membershipGroupingVersion()}
        limit 1`.execute(tx)).rows[0];
      if (!missing) return false;
      await sql`insert into catalog_projection_changes (standard_product_id) values (${missing.standard_product_id})`.execute(tx);
      change = { shop_id: null, standard_product_id: missing.standard_product_id };
    }
    const predicate = change.shop_id !== null ? sql`shop_id = ${change.shop_id}`
      : change.standard_product_id !== null ? sql`standard_product_id = ${change.standard_product_id}` : sql`coverage`;
    // Only acknowledge events visible to this snapshot, including out-of-order commits.
    const events = (await sql<{ id: bigint }>`select id from catalog_projection_changes where ${predicate}`.execute(tx)).rows;
    if (change.shop_id !== null) {
      const shop = await tx.selectFrom('shops').select(['id', 'url', 'protocol', 'platform', 'shop_rating', 'rating_manifest'])
        .where('id', '=', change.shop_id).executeTakeFirst();
      if (shop) {
        const reviews = createTextReviewAccumulator(shop.rating_manifest, shop, now);
        if (reviews) {
          await sql`declare catalog_reviews no scroll cursor for
            select p.external_id, p.content_version, p.content_fingerprint,
              jsonb_build_object('ratingText', p.source_data->'ratingText') as source_data, p.text_review
            from products p join (
              select min(id) as id from products where shop_id = ${shop.id} and text_review_key is not null
              group by text_review_key
            ) unique_reviews using (id)`.execute(tx);
          try {
            for (;;) {
              const batch = await sql<ProductReviewRow>`fetch forward 64 from catalog_reviews`.execute(tx);
              for (const row of batch.rows) {
                const review = prepareTextReview(row);
                if (review) reviews.add(review);
              }
              if (batch.rows.length < 64) break;
            }
          } finally { await sql`close catalog_reviews`.execute(tx); }
        }
        const rating = readShopRating(shop.shop_rating, shop, now, reviews?.finish());
        await sql`insert into catalog_shop_ratings (shop_id, score, details, computed_at)
          values (${shop.id}, ${rating.score}, ${JSON.stringify(rating.details)}::jsonb, ${new Date(now)})
          on conflict (shop_id) do update set score = excluded.score, details = excluded.details,
            computed_at = excluded.computed_at`.execute(tx);
      }
    } else if (change.standard_product_id !== null) {
      const id = change.standard_product_id!;
      await sql`delete from catalog_read_shop_totals where standard_product_id = ${id}`.execute(tx);
      await sql`insert into catalog_read_shop_totals
          (standard_product_id, shop_id, currency, min_price, latest_captured_at, product_count, winner_id, membership_policy_version)
        select standard_product_id, shop_id, currency, min(price), max(captured_at), count(*)::int,
          (array_agg(product_id order by price, product_id))[1], ${membershipGroupingVersion()}
        from catalog_read_offer_prices where standard_product_id = ${id} and available
        group by standard_product_id, shop_id, currency`.execute(tx);
      await sql`delete from catalog_read_membership_totals where standard_product_id = ${id}`.execute(tx);
      await sql`insert into catalog_read_membership_totals
          (standard_product_id, shop_id, currency, membership_kind, min_price, max_price,
            latest_captured_at, product_count, winner_id)
        select r.standard_product_id, r.shop_id, r.currency, coalesce(grouped.kind, 'unclassified'),
          min(r.price), max(r.price), max(r.captured_at), count(*)::int,
          (array_agg(r.product_id order by r.price nulls last,
            case when r.price is null then r.captured_at end desc, r.product_id))[1]
        from catalog_read_offer_prices r
        join standard_products sp on sp.id = r.standard_product_id
        left join catalog_membership_kinds mk on mk.product_id = r.product_id
          and mk.policy_version = ${MEMBERSHIP_POLICY_VERSION}
        cross join lateral (select ${membershipGroupKind(sql<MembershipKind | null>`mk.kind`)} as kind) grouped
        where r.standard_product_id = ${id} and r.available
          and (mk.kind is not null or (select ${failedMembershipFeatures()}
            from products p join shops sh on sh.id = p.shop_id where p.id = r.product_id))
        group by r.standard_product_id, r.shop_id, r.currency, grouped.kind`.execute(tx);
    } else {
      await sql`update catalog_coverage set shop_count = (select count(*) from shops),
        product_count = (select count(*) from products) where id = 1`.execute(tx);
    }
    await sql`delete from catalog_projection_changes where id = any(${events.map(row => String(row.id))}::bigint[])`.execute(tx);
    return true;
  });
}

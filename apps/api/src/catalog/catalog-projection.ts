import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/types.js';
import { createTextReviewAccumulator, prepareTextReview, type ProductReviewRow } from '../shops/shop-text-review.js';
import { readShopRating } from '../shops/shop-rating.js';

/** Runs only in the catalog worker; readers never prepare missing results. */
export async function publishNextCatalogChange(database: Kysely<DatabaseSchema>, now = Date.now()): Promise<boolean> {
  return database.transaction().setIsolationLevel('repeatable read').execute(async tx => {
    const lock = await sql<{ acquired: boolean }>`select pg_try_advisory_xact_lock(
      hashtext(current_schema()), hashtext('catalog-projection')) as acquired`.execute(tx);
    if (!lock.rows[0]!.acquired) return false;
    // Publish browsing results before optional scores so initial backfills do not hide the catalog.
    const change = (await sql<{ shop_id: bigint | null; standard_product_id: bigint | null }>`
      select shop_id, standard_product_id from catalog_projection_changes
      order by (shop_id is not null), id limit 1`.execute(tx)).rows[0];
    if (!change) return false;
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
          (standard_product_id, shop_id, currency, min_price, latest_captured_at, product_count, winner_id)
        select standard_product_id, shop_id, currency, min(price), max(captured_at), count(*)::int,
          (array_agg(product_id order by price, product_id))[1]
        from catalog_read_offer_prices where standard_product_id = ${id} and available
        group by standard_product_id, shop_id, currency`.execute(tx);
    } else {
      await sql`update catalog_coverage set shop_count = (select count(*) from shops),
        product_count = (select count(*) from products) where id = 1`.execute(tx);
    }
    await sql`delete from catalog_projection_changes where id = any(${events.map(row => String(row.id))}::bigint[])`.execute(tx);
    return true;
  });
}

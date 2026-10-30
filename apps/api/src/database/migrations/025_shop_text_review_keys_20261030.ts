import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`create function shop_text_review_key(
    content_version bigint, fingerprint text, rating_text jsonb, review jsonb
  ) returns text language sql immutable parallel safe set search_path to pg_catalog as $function$
    select case when jsonb_typeof(review) = 'object'
      and review->'contentVersion' = to_jsonb(content_version::text)
      and review->'fingerprint' = to_jsonb(fingerprint)
    then encode(sha256(convert_to(
      jsonb_build_array(rating_text, review - 'contentVersion' - 'fingerprint')::text, 'UTF8'
    )), 'hex') end
  $function$`.execute(database);
  await sql`alter table products add column text_review_key text generated always as (
    shop_text_review_key(content_version, content_fingerprint, source_data->'ratingText', text_review)
  ) stored`.execute(database);
  await sql`create index products_shop_text_review_key on products (shop_id, text_review_key, id)
    where text_review_key is not null`.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`drop index products_shop_text_review_key`.execute(database);
  await sql`alter table products drop column text_review_key`.execute(database);
  await sql`drop function shop_text_review_key(bigint, text, jsonb, jsonb)`.execute(database);
}

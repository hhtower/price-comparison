import { Inject, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { DATABASE } from '../database/database.providers.js';
import { DomainValidationError } from '../common/errors.js';
import type { DatabaseSchema, JsonValue } from '../database/types.js';
import { readShopRating, type ShopRatingDetails } from '../shops/shop-rating.js';
import { aggregateTextReviews } from '../shops/shop-text-review.js';
import { CATALOG_PLATFORMS, groupCatalogPlatforms, normalizeCatalogPlatform } from '@price-comparison/catalog/platform-groups';
import { catalogOrderRank, catalogPlatformGroup, OTHER_CATALOG_RANK } from './catalog-order.js';
import { CATALOG_QUOTE_POLICY, defaultQuotePolicy, type QuotePolicy } from './quote-policy.js';
import { CATALOG_DISPLAY_SEARCH_LABELS, sanitizeOfferName, standardProductDisplayName, standardProductKind } from '@price-comparison/catalog/catalog-display';
import { PriceHistoryRepository } from './price-history.repository.js';

export interface PublicCatalogProduct { readonly id: string; readonly name: string; readonly platform: string; readonly kind: string; readonly mergedIntoId?: string }
export interface PublicCatalogProducts { readonly items: readonly PublicCatalogProduct[] }
export interface CatalogCoverage { readonly shopCount: number; readonly productCount: number }

function publicStandard(alias: string): RawBuilder<boolean> {
  const sp = sql.table(alias);
  return sql<boolean>`${sp}.hidden = false and ${sp}.merged_into_id is null and ${sp}.verification_state = 'verified'
    and exists (select 1 from standard_product_members m join products p on p.id = m.product_id
      join shops sh on sh.id = p.shop_id where m.standard_product_id = ${sp}.id
      and m.publication_state = 'published' and p.deleted_at is null and sh.deleted_at is null and sh.enabled = true)`;
}

function productMetadata(row: { id: string; name: string; platform: string; family: string | null; product: string | null; tier: string | null; merged_into_id: string | null }): PublicCatalogProduct {
  return { id: row.id, name: standardProductDisplayName(row.name), platform: row.platform,
    kind: standardProductKind({ family: row.family ?? '', product: row.product ?? '', tier: row.tier ?? '' }),
    ...(row.merged_into_id ? { mergedIntoId: row.merged_into_id } : {}) };
}
type ProductMetadataRow = Parameters<typeof productMetadata>[0];

export interface CatalogTag { readonly name: string; readonly value: string }
export type CatalogSort = 'default' | 'price' | 'updated';
export type CatalogOfferSort = 'price' | 'priceDesc' | 'updated';
export interface CatalogCursor { readonly sortOrder: bigint; readonly standardProductId: bigint; readonly catalogRank?: number; readonly sort?: Exclude<CatalogSort, 'default'>; readonly sortValue?: string }
export interface CatalogQuery {
  readonly sort?: CatalogSort;
  readonly view?: 'summary' | 'full';
  readonly standardProductId?: string;
  readonly shopQuery?: string;
  readonly shopId?: string;
  readonly priceMin?: string;
  readonly priceMax?: string;
  readonly currency?: string;
  readonly offerSort?: CatalogOfferSort;
  readonly detailKind?: 'offers' | 'shops';
  readonly detailPage?: number;
  readonly detailPageSize?: number;
  readonly platform?: string;
  readonly search?: string;
  readonly warrantyDaysMin?: number;
  readonly newcomer?: boolean;
  readonly tags: readonly CatalogTag[];
  readonly cursor?: string;
  readonly limit: number;
}

export interface CatalogOffer {
  readonly shopId: string;
  readonly productId: string;
  readonly name: string;
  readonly shop: string;
  readonly shopScore?: string | null;
  readonly shopScoreExpiresAt?: string | null;
  readonly shopScoreDetails?: ShopRatingDetails | null;
  readonly independentShop?: boolean;
  readonly price: string | null;
  readonly settlementQuantity: number;
  readonly listedPrice?: string;
  readonly priceStatus?: 'verified' | 'expired' | 'estimated' | 'unverified';
  readonly priceVerifiedAt?: string | null;
  readonly priceExpiresAt?: string | null;
  readonly inventoryExpiresAt?: string | null;
  readonly paymentMethod?: string | null;
  readonly currency: string;
  readonly productUrl: string;
  readonly spec: string;
  readonly tags: readonly CatalogTag[];
  readonly capturedAt: string;
  readonly stale: boolean;
  readonly inStock: boolean;
}

export interface CatalogItem {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly standardProductId: string;
  readonly shopCount: number;
  readonly productCount: number;
  readonly offers: readonly CatalogOffer[];
  readonly allOffers?: readonly CatalogOffer[];
  readonly detail?: CatalogDetail;
  readonly offersTruncated?: boolean;
  readonly latestCapturedAt?: string;
  readonly minPrice: string | null;
}

export interface CatalogShopEntry {
  readonly key: string;
  readonly name: string;
  readonly count: number;
  readonly offer: CatalogOffer;
}

export type CatalogDetail = { readonly page: number; readonly pageSize: number; readonly total: number } & (
  | { readonly kind: 'offers'; readonly entries: readonly CatalogOffer[] }
  | { readonly kind: 'shops'; readonly entries: readonly CatalogShopEntry[] }
);

export interface CatalogPage {
  readonly nextExpiryAt?: string | null;
  readonly items: readonly CatalogItem[];
  readonly platformFacets: readonly string[];
  readonly total: number;
  readonly offerTotal?: number;
  readonly appliedQuery?: { readonly text: string; readonly tags: readonly CatalogTag[]; readonly warrantyDaysMin?: number };
  readonly nextCursor?: string;
}

export type CatalogFacetsQuery = Pick<CatalogQuery, 'platform' | 'search' | 'tags' | 'warrantyDaysMin' | 'newcomer'
  | 'standardProductId' | 'shopQuery' | 'shopId' | 'priceMin' | 'priceMax' | 'currency'>;
export interface CatalogFacets { readonly nextExpiryAt?: string | null; readonly tagFacets: readonly (Pick<CatalogTag, 'name' | 'value'> & { readonly priority: number })[] }

interface CatalogResult {
  has_next: boolean;
  entries: (Omit<CatalogItem, 'standardProductId' | 'minPrice'> & { sortOrder: string; sortValue: string; catalogRank: number })[];
  platform_facets: string[];
  total: number;
  offer_total: number;
  next_expiry_at: string | null;
  text_reviews: { shop_id: string; external_id: string; content_version: string;
    content_fingerprint: string | null; source_data: JsonValue; text_review: JsonValue }[];
}

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;
const PRODUCT_SEARCH_LABELS = JSON.stringify(CATALOG_DISPLAY_SEARCH_LABELS.products);
const FAMILY_SEARCH_LABELS = JSON.stringify(CATALOG_DISPLAY_SEARCH_LABELS.families);
const TIER_SEARCH_LABELS = JSON.stringify(CATALOG_DISPLAY_SEARCH_LABELS.tiers);
const TIER_TERM_SEARCH_LABELS = JSON.stringify(CATALOG_DISPLAY_SEARCH_LABELS.tierTerms);
function offerPriceText(alias: string): RawBuilder<string | null> {
  const offer = sql.table(alias);
  return sql<string | null>`(case when ${offer}.settlement_quantity = 1 then round(${offer}.price, 2) else ${offer}.price end)::text`;
}

export function encodeCatalogCursor(cursor: CatalogCursor): string {
  return Buffer.from(JSON.stringify({ v: cursor.sort ? 3 : cursor.catalogRank !== undefined ? 4 : 2, s: cursor.sortOrder.toString(), sp: cursor.standardProductId.toString(),
    ...(!cursor.sort && cursor.catalogRank !== undefined ? { r: cursor.catalogRank } : {}),
    ...(cursor.sort ? { order: cursor.sort, k: cursor.sortValue } : {}) }), 'utf8').toString('base64url');
}

export function decodeCatalogCursor(value: string): CatalogCursor {
  try {
    const payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if ((payload.v !== 2 && payload.v !== 3 && payload.v !== 4) || typeof payload.s !== 'string' || typeof payload.sp !== 'string') throw new Error();
    if (!/^-?\d+$/.test(payload.s) || !/^\d+$/.test(payload.sp)) throw new Error();
    const sortOrder = BigInt(payload.s);
    const standardProductId = BigInt(payload.sp);
    if (sortOrder < -(2n ** 63n) || sortOrder >= 2n ** 63n || standardProductId < 1n || standardProductId >= 2n ** 63n) throw new Error();
    if (payload.v === 3) {
      if ((payload.order !== 'price' && payload.order !== 'updated') || typeof payload.k !== 'string'
        || (!/^-?[0-9]{1,30}(\.[0-9]{1,12})?$/u.test(payload.k) && !(payload.order === 'price' && payload.k === 'Infinity'))) throw new Error();
      return { sortOrder, standardProductId, sort: payload.order, sortValue: payload.k };
    }
    if (payload.v === 4) {
      if (typeof payload.r !== 'number' || !Number.isInteger(payload.r) || payload.r < 100 || payload.r > OTHER_CATALOG_RANK) throw new Error();
      return { sortOrder, standardProductId, catalogRank: payload.r };
    }
    return { sortOrder, standardProductId };
  } catch {
    throw new DomainValidationError('INVALID_CURSOR', '分页游标无效');
  }
}

@Injectable()
export class CatalogRepository {
  constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Optional() @Inject(CATALOG_QUOTE_POLICY) private readonly policy: QuotePolicy = defaultQuotePolicy()) {}

  async coverage(): Promise<CatalogCoverage> {
    // Unique source rows include inactive/history, not just publicly comparable offers.
    const result = await sql<CatalogCoverage>`select
      (select count(*) from shops)::float8 as "shopCount",
      (select count(*) from products)::float8 as "productCount"`.execute(this.database);
    return result.rows[0]!;
  }

  priceHistory(id: string, productId?: string, currency = 'CNY') {
    return new PriceHistoryRepository(this.database, this.policy).get(id, productId, currency);
  }

  async publicProducts(): Promise<PublicCatalogProducts> {
    const result = await sql<ProductMetadataRow>`select sp.id::text, sp.name, sp.platform,
      sp.canonical_family as family, sp.canonical_product as product, sp.canonical_tier as tier, null::text as merged_into_id
      from standard_products sp where ${publicStandard('sp')} order by ${catalogOrderRank()}, sp.sort_order, sp.id limit 10001`.execute(this.database);
    // ponytail: bounded navigation; add cursor pagination if the public catalog exceeds 10000 products.
    if (result.rows.length > 10000) throw new ServiceUnavailableException('公开商品目录超过10000项，请启用目录分页');
    return { items: result.rows.map(productMetadata) };
  }

  async publicProduct(id: string): Promise<PublicCatalogProduct | null> {
    const result = await sql<ProductMetadataRow>`select sp.id::text, sp.name, sp.platform,
      sp.canonical_family as family, sp.canonical_product as product, sp.canonical_tier as tier, sp.merged_into_id::text
      from standard_products sp where sp.id = ${id}::bigint and (${publicStandard('sp')}
        or (sp.merged_into_id is not null and exists (select 1 from standard_products target where target.id = sp.merged_into_id and ${publicStandard('target')})))`.execute(this.database);
    return result.rows[0] ? productMetadata(result.rows[0]) : null;
  }

  async search(input: CatalogQuery): Promise<CatalogPage> {
    const query = input;
    const result = await this.runRead(database => buildCatalogQuery(input, this.policy).execute(database));
    const { entries, platform_facets: platformFacets, total } = result.rows[0]!;
    const hasNext = result.rows[0]!.has_next;
    const visible = entries;
    type InternalRating = { state: JsonValue | null; url: string; protocol: string | null; platform: string; manifest: JsonValue | null };
    const reviewRows = result.rows[0]!.text_reviews;
    const reviewsByShop = new Map<string, typeof reviewRows>();
    for (const row of reviewRows) {
      const id = String(row.shop_id);
      if (!reviewsByShop.has(id)) reviewsByShop.set(id, []);
      reviewsByShop.get(id)!.push(row);
    }
    let nextExpiry = result.rows[0]!.next_expiry_at ? Date.parse(result.rows[0]!.next_expiry_at) : Infinity;
    const ratings = new Map<string, ReturnType<typeof readShopRating>>();
    const withRating = (offer: CatalogOffer): CatalogOffer => {
      const { _shopRating, ...publicOffer } = offer as CatalogOffer & {
        _shopRating?: InternalRating;
      };
      let rating = ratings.get(offer.shopId);
      if (!rating) {
        const now = this.policy.now();
        rating = _shopRating ? readShopRating(_shopRating.state, _shopRating, now,
          aggregateTextReviews(_shopRating.manifest, _shopRating, reviewsByShop.get(offer.shopId) ?? [], now))
          : { score: null, nextExpiryAt: null, details: null };
        ratings.set(offer.shopId, rating);
        if (rating.nextExpiryAt !== null) nextExpiry = Math.min(nextExpiry, rating.nextExpiryAt);
      }
      return { ...publicOffer, name: sanitizeOfferName(publicOffer.name), shopScore: rating.score, shopScoreDetails: rating.details,
        shopScoreExpiresAt: rating.nextExpiryAt === null ? null : new Date(rating.nextExpiryAt).toISOString() };
    };
    const items = visible.map(({ sortOrder: _sortOrder, sortValue: _sortValue, catalogRank: _catalogRank, ...item }): CatalogItem => {
      // Summary and paginated detail responses carry only their bounded offers.
      if (query.view === 'summary' || query.detailKind) delete (item as { allOffers?: readonly CatalogOffer[] }).allOffers;
      const detail = item.detail?.kind === 'shops' ? { ...item.detail, entries: item.detail.entries.map(entry => ({ ...entry, offer: withRating(entry.offer) })) }
        : item.detail ? { ...item.detail, entries: item.detail.entries.map(withRating) } : undefined;
      return { ...item, offers: item.offers.map(withRating), ...(item.allOffers ? { allOffers: item.allOffers.map(withRating) } : {}),
        ...(detail ? { detail } : {}), name: standardProductDisplayName(item.name), standardProductId: item.id, minPrice: item.offers[0]!.price,
        ...(query.view === 'summary' || query.detailKind ? { offersTruncated: true } : {}) };
    });
    const last = visible.at(-1);
    return { items, nextExpiryAt: Number.isFinite(nextExpiry) ? new Date(nextExpiry).toISOString() : null, platformFacets: groupCatalogPlatforms(platformFacets), total: Number(total), offerTotal: Number(result.rows[0]!.offer_total),
      appliedQuery: { text: query.search ?? '', tags: query.tags, ...(query.warrantyDaysMin ? { warrantyDaysMin: query.warrantyDaysMin } : {}) },
      ...(hasNext && last ? { nextCursor: encodeCatalogCursor({ sortOrder: BigInt(last.sortOrder), standardProductId: BigInt(last.id),
        ...(query.sort && query.sort !== 'default' ? { sort: query.sort, sortValue: last.sortValue } : { catalogRank: last.catalogRank }) }) } : {}) };
  }

  async facets(input: CatalogFacetsQuery): Promise<CatalogFacets> {
    const result = await this.runRead(database => buildCatalogQuery({ ...input, view: 'summary', limit: 1 }, this.policy, true).execute(database));
    return { tagFacets: result.rows[0]!.tag_facets, nextExpiryAt: result.rows[0]!.next_expiry_at };
  }

  async explainFacets(input: CatalogFacetsQuery): Promise<unknown> {
    const result = await this.runRead(database => sql<{ 'QUERY PLAN': unknown }>`
      explain (analyze, buffers, format json) ${buildCatalogQuery({ ...input, view: 'summary', limit: 1 }, this.policy, true)}
    `.execute(database));
    return result.rows[0]?.['QUERY PLAN'] ?? [];
  }

  async explain(input: CatalogQuery): Promise<unknown> {
    const result = await this.runRead(database => sql<{ 'QUERY PLAN': unknown }>`
      explain (analyze, buffers, format json) ${buildCatalogQuery(input, this.policy)}
    `.execute(database));
    return result.rows[0]?.['QUERY PLAN'] ?? [];
  }

  private async runRead<T>(run: (database: Kysely<DatabaseSchema>) => Promise<T>): Promise<T> {
    if (!this.database.isTransaction) return run(this.database);
    // Preserve callers that explicitly enable JIT inside their transaction.
    const setting = await sql<{ jit: string }>`show jit`.execute(this.database);
    await sql`set local jit = off`.execute(this.database);
    const result = await run(this.database);
    await sql`select set_config('jit', ${setting.rows[0]!.jit}, true)`.execute(this.database);
    return result;
  }
}

type FacetResult = { tag_facets: CatalogFacets['tagFacets']; next_expiry_at: string | null };
function buildCatalogQuery(input: CatalogQuery, policy: QuotePolicy, optionsOnly: true): RawBuilder<FacetResult>;
function buildCatalogQuery(input: CatalogQuery, policy: QuotePolicy, optionsOnly?: false): RawBuilder<CatalogResult>;
function buildCatalogQuery(input: CatalogQuery, policy: QuotePolicy, optionsOnly = false): RawBuilder<CatalogResult> | RawBuilder<FacetResult> {
  const now = new Date(policy.now());
  const freshAfter = new Date(now.getTime() - policy.ttlMs);
  const pricesOnly = !optionsOnly && !input.search?.trim();
  const verified = sql`r.settlement_price is not null and r.settlement_price >= 0 and r.settlement_price < 'Infinity'::numeric
    and r.settlement_verified_at is not null and nullif(btrim(r.settlement_payment_method), '') is not null`;
  const price = pricesOnly ? sql`r.price` : sql`case when ${verified} then r.settlement_price else r.listed_price end`;
  const payloadFields = sql`r.product_name, r.product_url, r.product_spec, sh.shop_name, sh.independent_shop, sh.shop_rating, r.tags, r.listed_price, r.currency,
    case when not (${verified}) then 'estimated'
      when least(r.captured_at, r.settlement_verified_at) <= ${freshAfter}::timestamptz then 'expired' else 'verified' end as price_status,
    case when ${verified} then r.settlement_verified_at end as price_verified_at,
    (case when ${verified} then least(r.captured_at, r.settlement_verified_at) else r.captured_at end)
      + ${policy.ttlMs} * interval '1 millisecond' as price_expires_at,
    r.captured_at + ${policy.ttlMs} * interval '1 millisecond' as inventory_expires_at,
    case when ${verified} then r.settlement_payment_method else '支付价（预估：售价）' end as payment_method,
    case when ${verified} then coalesce(r.settlement_quantity, 1) else 1 end as settlement_quantity`;
  const limit = catalogPageLimit(input.limit);
  const conditions = [sql`r.available = true`];
  if (input.newcomer) conditions.push(sql`r.product_id in (
    select n.product_id from catalog_read_offers n where n.warranty_days >= 30
      and (n.tags @> '[{"name":"delivery","value":"top_up"}]'::jsonb
        or n.tags @> '[{"name":"delivery","value":"account"}]'::jsonb))`);
  if (input.standardProductId) conditions.push(sql`r.standard_product_id = ${input.standardProductId}::bigint`);
  if (input.shopId) conditions.push(sql`r.shop_id = ${input.shopId}::bigint`);
  if (input.shopQuery) conditions.push(sql`r.shop_id in (select shop_id from catalog_shops
    where search_text like lower(${`%${input.shopQuery.replace(/[\\%_]/gu, '\\$&')}%`}))`);
  if (input.priceMin !== undefined) conditions.push(sql`${price} >= ${input.priceMin}::numeric`);
  if (input.priceMax !== undefined) conditions.push(sql`${price} <= ${input.priceMax}::numeric`);
  const currency = input.currency ?? 'CNY';
  if (currency) conditions.push(sql`r.currency = ${currency}`);
  const summary = input.view === 'summary';
  const preview = summary || input.detailKind !== undefined;
  // Normalized detail requests target one standard product; cap rows before JSON construction.
  const detailPage = input.detailPage ?? 0;
  const detailPageSize = input.detailPageSize ?? 4;
  const detailOrder = sql`(d.price is null), ${input.offerSort === 'updated' ? sql`d.captured_at desc, d.price`
    : input.offerSort === 'priceDesc' ? sql`d.price desc nulls last` : sql`d.price nulls last`},
    case when d.price is null then d.captured_at end desc, d.shop_id, d.product_id`;
  const platformGroup = catalogPlatformGroup();
  const requestedPlatform = input.platform ? normalizeCatalogPlatform(input.platform) : undefined;
  const isGroup = requestedPlatform === 'other' || CATALOG_PLATFORMS.some(group => group.id === requestedPlatform);
  const platformCondition = !requestedPlatform ? sql`true` : sql`e.standard_product_id in (
    select sp.id from catalog_standards sp where ${isGroup
    ? sql`sp.platform_group = ${requestedPlatform}` : sql`lower(btrim(sp.platform)) = ${requestedPlatform}`})`;
  const words = [...new Set((input.search ?? '').normalize('NFKC').trim().split(/[\s/]+/u).filter(Boolean))];
  const standardSearchText = words.length ? sql`lower(normalize(concat_ws(' ', sp.name, sp.platform,
    sp.canonical_family, sp.canonical_product, sp.canonical_tier,
    ${PRODUCT_SEARCH_LABELS}::jsonb ->> lower(btrim(sp.canonical_product)),
    ${FAMILY_SEARCH_LABELS}::jsonb ->> lower(btrim(sp.canonical_family)),
    coalesce(${TIER_SEARCH_LABELS}::jsonb ->> lower(btrim(sp.canonical_tier)),
      (select string_agg(coalesce(${TIER_TERM_SEARCH_LABELS}::jsonb ->> term, term), ' ' order by ordinal)
        from regexp_split_to_table(lower(btrim(sp.canonical_tier)), '[_[:space:]]+')
          with ordinality as tier_terms(term, ordinal))),
    array_to_string(sp.aliases, ' ')), NFKC))` : sql`null::text`;
  for (const word of words) {
    const term = `%${word.replace(/[\\%_]/gu, '\\$&')}%`;
    conditions.push(sql`(r.search_text like lower(${term})
      or r.standard_product_id = any(array(select id from catalog_standards where search_text like lower(${term})))
      or r.shop_id = any(array(select shop_id from catalog_shops where search_text like lower(${term}))))`);
  }
  const dimensions = new Map<string, CatalogTag[]>();
  for (const tag of input.tags) dimensions.set(tag.name, [...(dimensions.get(tag.name) ?? []), tag]);
  const tagConditions = [...dimensions].map(([name, tags]) => ({ name, condition: sql`(${sql.join(tags.map(tag => sql`r.tags @> ${JSON.stringify([{ name: tag.name, value: tag.value.toLowerCase() }])}::jsonb`), sql` or `)})` }));
  const minimumDays = input.warrantyDaysMin;
  if (minimumDays !== undefined) tagConditions.push({ name: 'warranty_days', condition: sql`r.warranty_days >= ${minimumDays}` });
  const filters = tagConditions.length
    ? sql.join(tagConditions.map(({ condition }) => condition), sql` and `) : sql`true`;
  const cursor = input.cursor ? decodeCatalogCursor(input.cursor) : undefined;
  const sort = input.sort ?? 'default';
  if (cursor && (cursor.sort ?? 'default') !== sort) throw new DomainValidationError('INVALID_CURSOR', '分页游标与排序方式不一致');
  const sortValue = sort === 'price' ? sql`coalesce(min_price, 'Infinity'::numeric)` : sort === 'updated' ? sql`-extract(epoch from latest_captured_at)` : sql`0::numeric`;
  // Resolve the rank for pre-existing v2 cursors so an open page survives the rollout.
  const cursorRank = cursor?.catalogRank ?? (cursor ? sql`coalesce((select ${catalogOrderRank()} from standard_products sp
    where sp.id = ${cursor.standardProductId}), ${OTHER_CATALOG_RANK})` : OTHER_CATALOG_RANK);
  const afterCursor = !cursor ? sql`true` : sort === 'default'
    ? sql`(catalog_rank, sort_order, standard_product_id) > (${cursorRank}, ${cursor.sortOrder}, ${cursor.standardProductId})`
    : sql`(${sortValue}, sort_order, standard_product_id) > (${cursor.sortValue}::numeric, ${cursor.sortOrder}, ${cursor.standardProductId})`;
  const rankingCtes = sql`shop_totals as materialized (
      select standard_product_id, shop_id, min(price) as min_price,
        max(captured_at) as latest_captured_at, count(*)::int as product_count
      from filtered_skus group by standard_product_id, shop_id
    ), product_totals as materialized (
      select standard_product_id, min(min_price) as min_price, max(latest_captured_at) as latest_captured_at,
        sum(product_count)::int as product_count, count(*)::int as shop_count
      from shop_totals group by standard_product_id
    ), page as (
      select t.*, sp.catalog_rank, sp.sort_order, sp.name as standard_product_name, sp.platform, ${sortValue} as sort_value
      from product_totals t join catalog_standards sp on sp.id = t.standard_product_id
      where ${afterCursor}
      order by sort_value, ${sort === 'default' ? sql`catalog_rank,` : sql``} sort_order, standard_product_id limit ${limit + 1}
    ), visible_page as materialized (
      select * from page
      order by sort_value, ${sort === 'default' ? sql`catalog_rank,` : sql``} sort_order, standard_product_id limit ${limit}
    )${preview && input.detailKind !== 'shops' ? sql`, preview_shop_totals as materialized (
      select * from (
        select s.*, row_number() over (partition by s.standard_product_id order by s.min_price, s.shop_id) as shop_rank
        from shop_totals s join visible_page using (standard_product_id)
      ) ranked where shop_rank <= 4
    )` : sql``}, shop_winner_ids as (
      select min(e.product_id) as product_id${input.detailKind === 'shops' ? sql`, max(s.product_count)::int as shop_product_count` : sql``}
      from filtered_skus e join ${sql.table(preview && input.detailKind !== 'shops' ? 'preview_shop_totals' : 'shop_totals')} s using (standard_product_id, shop_id)
      join visible_page using (standard_product_id) where e.price = s.min_price
      group by e.standard_product_id, e.shop_id
    ), shop_winners as (
      select e.*${input.detailKind === 'shops' ? sql`, w.shop_product_count` : sql``}
      from filtered_skus e join shop_winner_ids w using (product_id)
    ), ranked_shops as (
      select w.*, row_number() over (partition by standard_product_id order by price nulls last, case when price is null then captured_at end desc, shop_id, product_id) as preview_rank
      from shop_winners w
    )`;
  const eligibleCte = sql`catalog_groups as materialized (
      select sp.id, sp.name, sp.platform, sp.sort_order, sp.canonical_family, sp.canonical_product, sp.canonical_tier,
        ${platformGroup} as platform_group, ${standardSearchText} as search_text
      from standard_products sp
      where sp.hidden = false and sp.merged_into_id is null and sp.verification_state = 'verified'
    ), catalog_standards as materialized (
      select sp.id, sp.name, sp.platform, sp.sort_order, sp.platform_group, sp.search_text,
        ${optionsOnly || sort !== 'default' ? sql`0::int` : catalogOrderRank(sql<string>`sp.platform_group`)} as catalog_rank
      from catalog_groups sp
    ), catalog_shops as materialized (
      select sh.id as shop_id, sh.name as shop_name,
        jsonb_build_object('state', sh.shop_rating, 'url', sh.url, 'protocol', sh.protocol,
          'platform', sh.platform, 'manifest', sh.rating_manifest) as shop_rating,
        -- Marketplace protocols are the lower-risk baseline; every other or unknown protocol is a self-built storefront with a higher-risk marker.
        (sh.protocol is distinct from 'liandong' and sh.protocol is distinct from '16688') as independent_shop,
        ${words.length || input.shopQuery ? sql`lower(normalize(sh.name, NFKC))` : sql`null::text`} as search_text
      from shops sh where sh.enabled = true and sh.deleted_at is null
    ), eligible_skus as materialized (
      select r.product_id, r.captured_at, r.standard_product_id,
        ${optionsOnly ? sql`r.facet_tags` : sql`${price} as price,
          ${pricesOnly ? sql`r.verification_at` : sql`case when ${verified} then least(r.captured_at, r.settlement_verified_at) end as verification_at`},
          r.shop_id`}
      from ${sql.table(pricesOnly ? 'catalog_read_offer_prices' : 'catalog_read_offers')} r
      where r.standard_product_id in (select id from catalog_standards)
        and r.shop_id in (select shop_id from catalog_shops)
        and r.captured_at > ${freshAfter}::timestamptz and ${sql.join(conditions, sql` and `)}
    )`;
  const scopeCtes = sql`scoped_skus as materialized (
      select * from eligible_skus e where ${platformCondition}
    )`;
  const facetOptionsCtes = sql`facet_sets as materialized (
      select f.facet_tags::jsonb as tags, f.product_count as weight
      from catalog_read_facet_counts f
      where f.facet_tags in (select facet_tags from scoped_skus)
    ), facet_tags as materialized (
      select t->>'name' as name, t->>'value' as value, sum(e.weight)::int as priority
      from facet_sets e cross join lateral jsonb_array_elements(e.tags) t
      group by t->>'name', t->>'value'
    ), known_dimensions as materialized (
      select distinct name from facet_tags where value <> 'unknown'
    ), facet_options as (
      select distinct name, value from facet_tags
      where name <> 'warranty_detail' and (value <> 'unknown'
        or name = any(${[...dimensions.keys()]}::text[])
        or name in (select name from known_dimensions))
      union
      select s->>'name', s->>'value' from jsonb_array_elements(${JSON.stringify(input.tags.map(({ name, value }) => ({ name, value })))}::jsonb) s
    )`;
  if (optionsOnly) {
    // Priority uses prepared-set frequency, not a count of matching offers.
    return sql<FacetResult>`with ${eligibleCte}, ${scopeCtes}, ${facetOptionsCtes}
      select coalesce(jsonb_agg(jsonb_build_object('name', name, 'value', value, 'priority', coalesce(t.priority, 0))
        order by name, value), '[]'::jsonb) as tag_facets,
        (select to_jsonb(min(captured_at) + ${policy.ttlMs} * interval '1 millisecond') #>> '{}' from scoped_skus) as next_expiry_at
      from facet_options f left join facet_tags t using (name, value)`;
  }
  const priceDeadlines = !preview ? sql`select verification_at from filtered_skus join visible_page using (standard_product_id)`
    : input.detailKind ? sql`select verification_at from preview_skus union all select verification_at from detail_skus`
      : sql`select verification_at from preview_skus`;
  const navigationIds = requestedPlatform || tagConditions.length
    ? sql`select distinct standard_product_id from eligible_skus`
    : sql`select standard_product_id from product_totals`;
  return sql<CatalogResult>`with ${eligibleCte}, ${tagConditions.length ? sql`purchase_matches as materialized (
      select r.product_id from catalog_read_offers r where ${filters}
    ),` : sql``} filtered_skus as ${requestedPlatform || tagConditions.length ? sql`materialized` : sql`not materialized`} (
      select e.* from eligible_skus e
      where ${platformCondition}
      ${tagConditions.length ? sql`and e.product_id in (select product_id from purchase_matches)` : sql``}
    ), ${rankingCtes}, preview_skus as materialized (
      select w.*, ${payloadFields}
      from ranked_shops w join catalog_read_offers r using (product_id)
      join catalog_shops sh on sh.shop_id = r.shop_id
      ${preview ? sql`where preview_rank <= 4` : sql``}
    )${input.detailKind ? sql`, detail_skus as materialized (
      select * from ${sql.table(input.detailKind === 'shops' ? 'ranked_shops' : 'filtered_skus')} d
      order by ${detailOrder} limit ${detailPageSize} offset ${detailPage * detailPageSize}
    ), detail_entries as (
      select d.*, ${payloadFields}
      from detail_skus d join catalog_read_offers r using (product_id)
      join catalog_shops sh on sh.shop_id = r.shop_id
    ), detail_payload as (
      select coalesce(jsonb_agg(${input.detailKind === 'shops' ? sql`jsonb_build_object(
        'key', d.shop_id::text, 'name', d.shop_name, 'count', d.shop_product_count, 'offer',` : sql``}
        jsonb_build_object(
          'shopId', d.shop_id::text, 'productId', d.product_id::text, 'name', d.product_name,
          'shop', d.shop_name, '_shopRating', d.shop_rating, 'independentShop', d.independent_shop, 'price', ${offerPriceText('d')}, 'currency', d.currency,
          'listedPrice', d.listed_price::text, 'priceStatus', d.price_status, 'priceVerifiedAt', d.price_verified_at,
          'priceExpiresAt', d.price_expires_at, 'inventoryExpiresAt', d.inventory_expires_at, 'paymentMethod', d.payment_method, 'settlementQuantity', d.settlement_quantity,
          'productUrl', d.product_url, 'spec', d.product_spec, 'tags', d.tags,
          'capturedAt', d.captured_at, 'stale', false, 'inStock', true
        )${input.detailKind === 'shops' ? sql`)` : sql``}
        order by ${detailOrder}), '[]'::jsonb) as entries
      from detail_entries d
    )` : sql``}, catalog_items as (
      select page.catalog_rank, page.sort_order, page.standard_product_id, page.standard_product_name, page.platform, page.sort_value,
        page.product_count, page.shop_count, page.latest_captured_at, jsonb_agg(jsonb_build_object(
        'shopId', w.shop_id::text, 'productId', w.product_id::text, 'name', w.product_name,
        'shop', w.shop_name, '_shopRating', w.shop_rating, 'independentShop', w.independent_shop, 'price', ${offerPriceText('w')}, 'currency', w.currency,
        'listedPrice', w.listed_price::text, 'priceStatus', w.price_status, 'priceVerifiedAt', w.price_verified_at,
        'priceExpiresAt', w.price_expires_at, 'inventoryExpiresAt', w.inventory_expires_at, 'paymentMethod', w.payment_method, 'settlementQuantity', w.settlement_quantity,
        'productUrl', w.product_url, 'spec', w.product_spec,
        'tags', w.tags,
        'capturedAt', w.captured_at, 'stale', false, 'inStock', true
      ) order by w.price nulls last, case when w.price is null then w.captured_at end desc, w.shop_id, w.product_id) as offers,
      ${preview ? sql`null::jsonb` : sql`(select jsonb_agg(jsonb_build_object(
        'shopId', allw.shop_id::text, 'productId', allw.product_id::text, 'name', allw.product_name,
        'shop', allw.shop_name, '_shopRating', allw.shop_rating, 'independentShop', allw.independent_shop, 'price', ${offerPriceText('allw')}, 'currency', allw.currency,
        'listedPrice', allw.listed_price::text, 'priceStatus', allw.price_status, 'priceVerifiedAt', allw.price_verified_at,
        'priceExpiresAt', allw.price_expires_at, 'inventoryExpiresAt', allw.inventory_expires_at, 'paymentMethod', allw.payment_method, 'settlementQuantity', allw.settlement_quantity,
        'productUrl', allw.product_url, 'spec', allw.product_spec,
        'tags', allw.tags,
        'capturedAt', allw.captured_at, 'stale', false, 'inStock', true
      ) order by allw.price nulls last, case when allw.price is null then allw.captured_at end desc, allw.shop_id, allw.product_id)
       from (select f.*, ${payloadFields} from filtered_skus f join catalog_read_offers r using (product_id)
         join catalog_shops sh on sh.shop_id = r.shop_id
         where f.standard_product_id = page.standard_product_id) allw)`} as all_offers
      from visible_page page join preview_skus w using (standard_product_id)
      group by page.catalog_rank, page.sort_order, page.standard_product_id, page.standard_product_name, page.platform, page.sort_value,
        page.product_count, page.shop_count, page.latest_captured_at
    )
    select
      (select count(*) > ${limit} from page) as has_next,
      (select coalesce(jsonb_agg(jsonb_build_object(
        'id', standard_product_id::text, 'name', standard_product_name, 'platform', platform,
        'catalogRank', catalog_rank, 'sortOrder', sort_order::text, 'sortValue', sort_value::text, 'offers', offers, 'allOffers', all_offers,
        'shopCount', shop_count, 'productCount', product_count, 'latestCapturedAt', latest_captured_at
      )${input.detailKind ? sql` || jsonb_build_object('detail', jsonb_build_object(
        'kind', ${input.detailKind}::text, 'page', ${detailPage}::bigint, 'pageSize', ${detailPageSize}::int,
        'total', ${input.detailKind === 'shops' ? sql`shop_count` : sql`product_count`},
        'entries', (select entries from detail_payload)
      ))` : sql``} order by sort_value, ${sort === 'default' ? sql`catalog_rank,` : sql``} sort_order, standard_product_id), '[]'::jsonb) from catalog_items) as entries,
      (select coalesce(jsonb_agg(platform order by platform), '[]'::jsonb)
       from (select distinct sp.platform_group as platform from (${navigationIds}) e
         join catalog_standards sp on sp.id = e.standard_product_id) platforms) as platform_facets,
      (select count(*)::int from product_totals) as total,
      (select coalesce(sum(product_count), 0)::int from product_totals) as offer_total,
      -- Read all shop reviews with the manifest in the same statement snapshot.
      (select coalesce(jsonb_agg(jsonb_build_object(
        'shop_id', p.shop_id::text, 'external_id', p.external_id, 'content_version', p.content_version::text,
        'content_fingerprint', p.content_fingerprint, 'source_data', jsonb_build_object('ratingText', p.source_data->'ratingText'),
        'text_review', p.text_review)), '[]'::jsonb)
       from products p join shops s on s.id = p.shop_id
       where s.rating_manifest is not null and p.text_review is not null and p.shop_id in (
         select w.shop_id from preview_skus w join visible_page using (standard_product_id)
         ${input.detailKind ? sql`union select shop_id from detail_skus` : sql``}
       )) as text_reviews,
      -- Prices stay comparable after verification expires; only matching price
      -- labels and the inventory behind results/navigation can change this response.
      to_jsonb(least(
        (select min(captured_at) from eligible_skus),
        (select min(verification_at) from (${priceDeadlines}) deadlines where verification_at > ${freshAfter}::timestamptz)
      ) + ${policy.ttlMs} * interval '1 millisecond'
      ) #>> '{}' as next_expiry_at
  `;
}

function catalogPageLimit(value: number): number {
  return Math.min(Math.max(Math.trunc(value || DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
}

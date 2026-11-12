import { Inject, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { DATABASE } from '../database/database.providers.js';
import { DomainValidationError } from '../common/errors.js';
import type { DatabaseSchema } from '../database/types.js';
import { type ShopRatingDetails } from '../shops/shop-rating.js';
import { CATALOG_PLATFORMS, groupCatalogPlatforms, normalizeCatalogPlatform } from '@price-comparison/catalog/platform-groups';
import { catalogOrderRank, catalogPlatformGroup, OTHER_CATALOG_RANK } from './catalog-order.js';
import { CATALOG_QUOTE_POLICY, defaultQuotePolicy, type QuotePolicy } from './quote-policy.js';
import { CATALOG_DISPLAY_SEARCH_LABELS, CATALOG_PRODUCT_ALIASES, sanitizeOfferName, standardProductDisplayName, standardProductKind } from '@price-comparison/catalog/catalog-display';
import { PriceHistoryRepository } from './price-history.repository.js';
import { isAiMembership, MEMBERSHIP_GROUPS, MEMBERSHIP_POLICY_VERSION, type MembershipGroup, type MembershipKind } from '@price-comparison/catalog/membership-policy';
import { catalogMembershipKind, failedMembershipFeatures } from '../standardization/membership-classification.js';

export interface PublicCatalogProduct { readonly id: string; readonly name: string; readonly platform: string; readonly platformGroup?: string; readonly identityNames?: readonly string[]; readonly kind: string; readonly mergedIntoId?: string;
  readonly identity?: { family: string; product: string; tier: string }; readonly isAiMembership?: boolean }
export interface PublicCatalogProducts { readonly items: readonly PublicCatalogProduct[] }
export interface PublicProductIdentity { readonly platform: string; readonly product: string; readonly tier: string }
export interface CatalogCoverage { readonly shopCount: number; readonly productCount: number }

function publicStandard(alias: string): RawBuilder<boolean> {
  const sp = sql.table(alias);
  return sql<boolean>`${sp}.hidden = false and ${sp}.merged_into_id is null and ${sp}.verification_state = 'verified'
    and exists (select 1 from standard_product_members m join products p on p.id = m.product_id
      join shops sh on sh.id = p.shop_id where m.standard_product_id = ${sp}.id
      and m.publication_state = 'published' and p.deleted_at is null and sh.deleted_at is null and sh.enabled = true)`;
}

function productMetadata(row: { id: string; name: string; platform: string; platform_group: string; family: string | null; product: string | null; tier: string | null; aliases: string[]; merged_into_id: string | null }): PublicCatalogProduct {
  return { id: row.id, name: standardProductDisplayName(row.name), platform: row.platform, platformGroup: row.platform_group,
    identity: { family: row.family ?? '', product: row.product ?? '', tier: row.tier ?? '' },
    isAiMembership: isAiMembership({ family: row.family ?? '', product: row.product ?? '', tier: row.tier ?? '' }),
    identityNames: [row.name, [row.family, row.product, row.tier].filter(Boolean).join(' '),
      ...CATALOG_PRODUCT_ALIASES[`${row.family}/${row.product}/${row.tier}`] ?? [], ...row.aliases],
    kind: standardProductKind({ family: row.family ?? '', product: row.product ?? '', tier: row.tier ?? '' }),
    ...(row.merged_into_id ? { mergedIntoId: row.merged_into_id } : {}) };
}
type ProductMetadataRow = Parameters<typeof productMetadata>[0];

function membershipScope(input: Pick<CatalogQuery, 'newcomer' | 'membershipKinds' | 'membershipSearch'>,
  ai: RawBuilder<boolean>, kind: RawBuilder<MembershipKind | null>, failed: RawBuilder<boolean>): RawBuilder<boolean> {
  if (input.membershipKinds?.length) return sql<boolean>`(${ai} and coalesce(${kind}, 'unclassified') = any(${input.membershipKinds}::text[])
    ${input.membershipKinds.includes('unclassified') ? sql`and (${kind} is not null or ${failed})` : sql``})`;
  if (input.membershipSearch) return sql<boolean>`(not (${ai}) or ${kind} = any(${input.membershipSearch.kinds}::text[]))`;
  return input.newcomer ? sql<boolean>`(not (${ai}) or ${kind} in ('account', 'top_up'))` : sql<boolean>`true`;
}

export interface CatalogTag { readonly name: string; readonly value: string }
export type CatalogSort = 'default' | 'price' | 'updated';
export type CatalogOfferSort = 'price' | 'priceDesc' | 'updated';
export interface CatalogCursor { readonly sortOrder: bigint; readonly standardProductId: bigint; readonly catalogRank?: number; readonly sort?: Exclude<CatalogSort, 'default'>; readonly sortValue?: string }
export interface CatalogQuery {
  readonly sort?: CatalogSort;
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
  readonly membershipKinds?: readonly MembershipGroup[];
  readonly membershipSearch?: { readonly kinds: readonly MembershipKind[]; readonly delivery: boolean; readonly access?: boolean; readonly terms: readonly string[] };
  readonly tags: readonly CatalogTag[];
  readonly cursor?: string;
  readonly limit: number;
}

export interface CatalogOffer {
  readonly membershipKind?: MembershipKind | null;
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
  readonly stockQuantity?: number | null;
}

export interface CatalogMembershipGroup {
  readonly kind: MembershipGroup;
  readonly shopCount: number;
  readonly productCount: number;
  readonly minPrice: string | null;
  readonly maxPrice: string | null;
  readonly latestCapturedAt: string;
  readonly offers: readonly CatalogOffer[];
}

export interface CatalogItem {
  readonly isAiMembership?: boolean;
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly standardProductId: string;
  readonly shopCount: number;
  readonly productCount: number;
  readonly offers: readonly CatalogOffer[];
  readonly membershipGroups?: readonly CatalogMembershipGroup[];
  readonly detail?: CatalogDetail;
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
  readonly appliedQuery?: { readonly text: string; readonly tags: readonly CatalogTag[]; readonly warrantyDaysMin?: number; readonly membershipKinds?: readonly MembershipGroup[] };
  readonly nextCursor?: string;
}

export type CatalogFacetsQuery = Pick<CatalogQuery, 'platform' | 'search' | 'tags' | 'warrantyDaysMin' | 'newcomer' | 'membershipKinds' | 'membershipSearch'
  | 'standardProductId' | 'shopQuery' | 'shopId' | 'priceMin' | 'priceMax' | 'currency'>;
export interface CatalogFacets { readonly nextExpiryAt?: string | null; readonly tagFacets: readonly (Pick<CatalogTag, 'name' | 'value'> & { readonly priority: number })[] }

interface CatalogResult {
  has_next: boolean;
  shop_ratings: { shop_id: string; score: string | null; details: ShopRatingDetails | null }[];
  entries: (Omit<CatalogItem, 'standardProductId' | 'minPrice'> & { sortOrder: string; sortValue: string; catalogRank: number })[];
  platform_facets: string[];
  total: number;
  offer_total: number;
  next_expiry_at: string | null;
}

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;
const PRODUCT_SEARCH_LABELS = JSON.stringify(CATALOG_DISPLAY_SEARCH_LABELS.products);
const FAMILY_SEARCH_LABELS = JSON.stringify(CATALOG_DISPLAY_SEARCH_LABELS.families);
const TIER_SEARCH_LABELS = JSON.stringify(CATALOG_DISPLAY_SEARCH_LABELS.tiers);
const IDENTITY_SEARCH_LABELS = JSON.stringify(CATALOG_DISPLAY_SEARCH_LABELS.identities);
const TIER_TERM_SEARCH_LABELS = JSON.stringify(CATALOG_DISPLAY_SEARCH_LABELS.tierTerms);
function offerPriceText(alias: string): RawBuilder<string | null> {
  const offer = sql.table(alias);
  return sql<string | null>`(case when ${offer}.settlement_quantity = 1 then round(${offer}.price, 2) else ${offer}.price end)::text`;
}

function offerPayload(alias: string): RawBuilder<unknown> {
  const offer = sql.table(alias);
  return sql`jsonb_build_object(
    'shopId', ${offer}.shop_id::text, 'productId', ${offer}.product_id::text, 'name', ${offer}.product_name,
    'membershipKind', ${offer}.membership_kind, 'shop', ${offer}.shop_name, 'independentShop', ${offer}.independent_shop,
    'price', ${offerPriceText(alias)}, 'currency', ${offer}.currency, 'listedPrice', ${offer}.listed_price::text,
    'priceStatus', ${offer}.price_status, 'priceVerifiedAt', ${offer}.price_verified_at,
    'priceExpiresAt', ${offer}.price_expires_at, 'inventoryExpiresAt', ${offer}.inventory_expires_at,
    'paymentMethod', ${offer}.payment_method, 'settlementQuantity', ${offer}.settlement_quantity,
    'productUrl', ${offer}.product_url, 'spec', ${offer}.product_spec, 'tags', ${offer}.tags,
    'capturedAt', ${offer}.captured_at, 'stale', false, 'inStock', true, 'stockQuantity', ${offer}.stock_quantity)`;
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
    const result = await sql<CatalogCoverage>`select shop_count::float8 as "shopCount",
      product_count::float8 as "productCount" from catalog_coverage where id = 1`.execute(this.database);
    return result.rows[0]!;
  }

  priceHistory(id: string, productId?: string, currency = 'CNY', scope: Pick<CatalogQuery, 'membershipKinds' | 'newcomer'> = {}) {
    return new PriceHistoryRepository(this.database, this.policy).get(id, productId, currency, scope);
  }

  async publicProducts(): Promise<PublicCatalogProducts> {
    const result = await sql<ProductMetadataRow>`select sp.id::text, sp.name, sp.platform, sp.aliases,
      ${catalogPlatformGroup()} as platform_group,
      sp.canonical_family as family, sp.canonical_product as product, sp.canonical_tier as tier, null::text as merged_into_id
      from standard_products sp where ${publicStandard('sp')} order by ${catalogOrderRank()}, sp.sort_order, sp.id limit 10001`.execute(this.database);
    // ponytail: bounded navigation; add cursor pagination if the public catalog exceeds 10000 products.
    if (result.rows.length > 10000) throw new ServiceUnavailableException('公开商品目录超过10000项，请启用目录分页');
    return { items: result.rows.map(productMetadata) };
  }

  async publicProduct(id: string): Promise<PublicCatalogProduct | null> {
    const result = await sql<ProductMetadataRow>`select sp.id::text, sp.name, sp.platform, sp.aliases,
      ${catalogPlatformGroup()} as platform_group,
      sp.canonical_family as family, sp.canonical_product as product, sp.canonical_tier as tier, sp.merged_into_id::text
      from standard_products sp where sp.id = ${id}::bigint and (${publicStandard('sp')}
        or (sp.merged_into_id is not null and exists (select 1 from standard_products target where target.id = sp.merged_into_id and ${publicStandard('target')})))`.execute(this.database);
    return result.rows[0] ? productMetadata(result.rows[0]) : null;
  }

  async resolvePublicProductIdentity(identity: PublicProductIdentity): Promise<PublicCatalogProduct | null> {
    const products = await this.resolvePublicProductIdentities(identity);
    return products.length === 1 ? products[0]! : null;
  }

  async resolvePublicProductIdentities(identity: PublicProductIdentity): Promise<PublicCatalogProduct[]> {
    const result = await sql<ProductMetadataRow>`select sp.id::text, sp.name, sp.platform, sp.aliases,
      ${catalogPlatformGroup()} as platform_group,
      sp.canonical_family as family, sp.canonical_product as product, sp.canonical_tier as tier,
      null::text as merged_into_id
      from standard_products sp where sp.canonical_family = ${identity.platform}
        and sp.canonical_product = ${identity.product} and sp.canonical_tier = ${identity.tier}
        and ${publicStandard('sp')} order by sp.id`.execute(this.database);
    return result.rows.map(productMetadata);
  }

  async search(input: CatalogQuery): Promise<CatalogPage> {
    const query = input;
    const result = (await this.runRead(database => buildCatalogQuery(input, this.policy).execute(database))).rows[0]!;
    const { entries: visible, platform_facets: platformFacets, total, has_next: hasNext } = result;
    const ratings = new Map(result.shop_ratings.map(rating => [rating.shop_id, rating]));
    const withRating = (offer: CatalogOffer): CatalogOffer => {
      const rating = ratings.get(offer.shopId);
      return { ...offer, name: sanitizeOfferName(offer.name), shopScore: rating?.score ?? null,
        shopScoreDetails: rating?.details ?? null, shopScoreExpiresAt: null };
    };
    const items = visible.map(({ sortOrder: _sortOrder, sortValue: _sortValue, catalogRank: _catalogRank, ...item }): CatalogItem => {
      const detail = item.detail?.kind === 'shops' ? { ...item.detail, entries: item.detail.entries.map(entry => ({ ...entry, offer: withRating(entry.offer) })) }
        : item.detail ? { ...item.detail, entries: item.detail.entries.map(withRating) } : undefined;
      return { ...item, offers: item.offers.map(withRating),
        ...(item.membershipGroups ? { membershipGroups: item.membershipGroups.map(group => ({ ...group, offers: group.offers.map(withRating) })) } : {}),
        ...(detail ? { detail } : {}), name: standardProductDisplayName(item.name), standardProductId: item.id, minPrice: item.offers[0]!.price };
    });
    const last = visible.at(-1);
    return { items, nextExpiryAt: null, platformFacets: groupCatalogPlatforms(platformFacets), total: Number(total), offerTotal: Number(result.offer_total),
      appliedQuery: { text: query.search ?? '', tags: query.tags, ...(query.membershipKinds ? { membershipKinds: query.membershipKinds } : {}),
        ...(query.warrantyDaysMin ? { warrantyDaysMin: query.warrantyDaysMin } : {}) },
      ...(hasNext && last ? { nextCursor: encodeCatalogCursor({ sortOrder: BigInt(last.sortOrder), standardProductId: BigInt(last.id),
        ...(query.sort && query.sort !== 'default' ? { sort: query.sort, sortValue: last.sortValue } : { catalogRank: last.catalogRank }) }) } : {}) };
  }

  async referenceOffers(input: CatalogQuery): Promise<CatalogOffer[]> {
    const ai = sql<boolean>`is_ai_membership(sp.canonical_family, sp.canonical_product, sp.canonical_tier)`;
    const kind = catalogMembershipKind(ai);
    const verified = sql`r.settlement_price is not null and r.settlement_price >= 0 and r.settlement_price < 'Infinity'::numeric
      and r.settlement_verified_at is not null and nullif(btrim(r.settlement_payment_method), '') is not null`;
    const price = sql`case when ${verified} then r.settlement_price else r.listed_price end`;
    // Reference quotes need no freshness gate, catalog totals or merchant-review hydration.
    const result = await sql<CatalogOffer>`select r.product_id::text as "productId", r.shop_id::text as "shopId",
      r.product_name as name, sh.name as shop, r.product_url as "productUrl", r.product_spec as spec, r.tags, ${kind} as "membershipKind",
      (${price})::text as price, r.currency, r.listed_price::text as "listedPrice",
      case when ${verified} then coalesce(r.settlement_quantity, 1) else 1 end as "settlementQuantity",
      case when ${verified} then r.settlement_payment_method else '支付价（预估：售价）' end as "paymentMethod",
      to_char(r.captured_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "capturedAt",
      null::text as "priceExpiresAt", r.is_stale as stale, r.stock_available as "inStock",
      r.stock_quantity::float8 as "stockQuantity",
      (sh.protocol is distinct from 'liandong' and sh.protocol is distinct from '16688') as "independentShop"
      from catalog_read_offers r
      join standard_products sp on sp.id = r.standard_product_id
      join shops sh on sh.id = r.shop_id
      join products p on p.id = r.product_id
      where r.standard_product_id = ${input.standardProductId}::bigint
        and ${membershipScope(input, ai, kind, failedMembershipFeatures())}
        and ${publicStandard('sp')} and sh.enabled = true and sh.deleted_at is null
        and ${price} >= 0 and ${price} < 'Infinity'::numeric
        ${input.currency ? sql`and r.currency = ${input.currency}` : sql``}
        ${input.priceMax !== undefined ? sql`and ${price} <= ${input.priceMax}::numeric` : sql``}
        ${input.tags.length ? sql`and r.tags @> ${JSON.stringify(input.tags)}::jsonb` : sql``}
        ${input.warrantyDaysMin !== undefined ? sql`and r.warranty_days >= ${input.warrantyDaysMin}` : sql``}
      order by r.product_id`.execute(this.database);
    return result.rows.map(offer => ({ ...offer, name: sanitizeOfferName(offer.name) }));
  }

  async facets(input: CatalogFacetsQuery): Promise<CatalogFacets> {
    const result = await this.runRead(database => buildCatalogQuery({ ...input, limit: 1 }, this.policy, true).execute(database));
    return { tagFacets: result.rows[0]!.tag_facets, nextExpiryAt: result.rows[0]!.next_expiry_at };
  }

  async explainFacets(input: CatalogFacetsQuery): Promise<unknown> {
    const result = await this.runRead(database => sql<{ 'QUERY PLAN': unknown }>`
      explain (analyze, buffers, format json) ${buildCatalogQuery({ ...input, limit: 1 }, this.policy, true)}
    `.execute(database));
    return result.rows[0]?.['QUERY PLAN'] ?? [];
  }

  async explain(input: CatalogQuery): Promise<unknown> {
    const result = await this.runRead(database => sql<{ 'QUERY PLAN': unknown }>`
      explain (analyze, buffers, format json) ${buildCatalogQuery(input, this.policy)}
    `.execute(database));
    return result.rows[0]?.['QUERY PLAN'] ?? [];
  }

  private async runRead<T>(run: (database: Kysely<DatabaseSchema>) => Promise<T>, database = this.database): Promise<T> {
    if (!database.isTransaction) return database.transaction().execute(async tx => {
      await sql`set local jit = off`.execute(tx);
      return run(tx);
    });
    // Preserve callers that explicitly enable JIT inside their transaction.
    const setting = await sql<{ jit: string }>`show jit`.execute(database);
    await sql`set local jit = off`.execute(database);
    let failed = false;
    try { return await run(database); }
    catch (error) { failed = true; throw error; }
    finally {
      const restore = sql`select set_config('jit', ${setting.rows[0]!.jit}, true)`.execute(database);
      if (failed) await restore.catch(() => {});
      else await restore;
    }
  }
}

type FacetResult = { tag_facets: CatalogFacets['tagFacets']; next_expiry_at: string | null };
function buildCatalogQuery(input: CatalogQuery, policy: QuotePolicy, optionsOnly: true): RawBuilder<FacetResult>;
function buildCatalogQuery(input: CatalogQuery, policy: QuotePolicy, optionsOnly?: false): RawBuilder<CatalogResult>;
function buildCatalogQuery(input: CatalogQuery, _policy: QuotePolicy, optionsOnly = false): RawBuilder<CatalogResult> | RawBuilder<FacetResult> {
  const pricesOnly = !optionsOnly;
  const membershipFiltered = Boolean(input.newcomer || input.membershipKinds?.length || input.membershipSearch);
  const needsMembership = !optionsOnly || membershipFiltered;
  const ai = sql<boolean>`cs.is_ai_membership`;
  const kind = sql<MembershipKind | null>`mk.kind`;
  const failed = sql<boolean>`(select ${failedMembershipFeatures('p', 'source_shop')}
    from products p join shops source_shop on source_shop.id = p.shop_id where p.id = r.product_id)`;
  const verified = sql`r.settlement_price is not null and r.settlement_price >= 0 and r.settlement_price < 'Infinity'::numeric
    and r.settlement_verified_at is not null and nullif(btrim(r.settlement_payment_method), '') is not null`;
  const price = pricesOnly ? sql`r.price` : sql`case when ${verified} then r.settlement_price else r.listed_price end`;
  const payloadFields = sql`r.product_name, r.product_url, r.product_spec, sh.shop_name, sh.independent_shop, r.tags, r.listed_price, r.currency, r.stock_quantity,
    case when ${verified} then 'verified' else 'estimated' end as price_status,
    case when ${verified} then r.settlement_verified_at end as price_verified_at,
    null::timestamptz as price_expires_at, null::timestamptz as inventory_expires_at,
    case when ${verified} then r.settlement_payment_method else '支付价（预估：售价）' end as payment_method,
    case when ${verified} then coalesce(r.settlement_quantity, 1) else 1 end as settlement_quantity`;
  const limit = catalogPageLimit(input.limit);
  const conditions = [sql`r.available = true`, membershipScope(input, ai, kind, failed)];
  if (input.shopId) conditions.push(sql`r.shop_id = ${input.shopId}::bigint`);
  if (input.shopQuery) conditions.push(sql`r.shop_id in (select shop_id from catalog_shops
    where search_text like lower(${`%${input.shopQuery.replace(/[\\%_]/gu, '\\$&')}%`}))`);
  if (input.priceMin !== undefined) conditions.push(sql`${price} >= ${input.priceMin}::numeric`);
  if (input.priceMax !== undefined) conditions.push(sql`${price} <= ${input.priceMax}::numeric`);
  const currency = input.currency ?? 'CNY';
  if (currency) conditions.push(sql`r.currency = ${currency}`);
  // Normalized detail requests target one standard product; cap rows before JSON construction.
  const detailPage = input.detailPage ?? 0;
  const detailPageSize = Math.min(Math.max(Math.trunc(input.detailPageSize ?? 4), 1), 50);
  const detailOrder = sql`(d.price is null), ${input.offerSort === 'updated' ? sql`d.captured_at desc, d.price`
    : input.offerSort === 'priceDesc' ? sql`d.price desc nulls last` : sql`d.price nulls last`},
    case when d.price is null then d.captured_at end desc, d.shop_id, d.product_id`;
  const platformGroup = catalogPlatformGroup();
  const requestedPlatform = input.platform ? normalizeCatalogPlatform(input.platform) : undefined;
  const isGroup = requestedPlatform === 'other' || CATALOG_PLATFORMS.some(group => group.id === requestedPlatform);
  const platformCondition = !requestedPlatform ? sql`true` : sql`e.standard_product_id in (
    select sp.id from catalog_standards sp where ${isGroup
    ? sql`sp.platform_group = ${requestedPlatform}` : sql`lower(btrim(sp.platform)) = ${requestedPlatform}`})`;
  const searchWords = (text: string) => [...new Set(text.normalize('NFKC').trim().split(/[\s/]+/u).filter(Boolean))];
  const words = searchWords(input.search ?? '');
  const standardSearchText = words.length ? sql`lower(normalize(concat_ws(' ', sp.name, sp.platform,
    sp.canonical_family, sp.canonical_product, sp.canonical_tier,
    ${PRODUCT_SEARCH_LABELS}::jsonb ->> lower(btrim(sp.canonical_product)),
    ${FAMILY_SEARCH_LABELS}::jsonb ->> lower(btrim(sp.canonical_family)),
    ${IDENTITY_SEARCH_LABELS}::jsonb ->> concat_ws('/', lower(btrim(sp.canonical_family)), lower(btrim(sp.canonical_product)), lower(btrim(sp.canonical_tier))),
    coalesce(${TIER_SEARCH_LABELS}::jsonb ->> lower(btrim(sp.canonical_tier)),
      (select string_agg(coalesce(${TIER_TERM_SEARCH_LABELS}::jsonb ->> term, term), ' ' order by ordinal)
        from regexp_split_to_table(lower(btrim(sp.canonical_tier)), '[_[:space:]]+')
          with ordinality as tier_terms(term, ordinal))),
    array_to_string(sp.aliases, ' ')), NFKC))` : sql`null::text`;
  const wordCondition = (word: string) => {
    const term = `%${word.replace(/[\\%_]/gu, '\\$&')}%`;
    return sql`r.product_id in (
      select product_id from catalog_read_offers where search_text like lower(${term})
      union all
      select product_id from catalog_read_offers where standard_product_id in (
        select id from catalog_standards where search_text like lower(${term}))
      union all
      select product_id from catalog_read_offers where shop_id in (
        select shop_id from catalog_shops where search_text like lower(${term})))`;
  };
  const aiSearch = input.membershipSearch?.terms.reduce((text, term) => text.replaceAll(term, ''), input.search ?? '')
    .replace(/\(\s*\)/gu, '');
  if (aiSearch !== undefined && aiSearch !== (input.search ?? '')) {
    const aiWords = searchWords(aiSearch);
    const aiStandard = sql`r.standard_product_id in (select id from catalog_standards where is_ai_membership)`;
    conditions.push(sql`(
      (${aiStandard} and ${aiWords.length ? sql.join(aiWords.map(wordCondition), sql` and `) : sql`true`})
      or (not (${aiStandard}) and ${words.length ? sql.join(words.map(wordCondition), sql` and `) : sql`true`}))`);
  } else conditions.push(...words.map(wordCondition));
  const dimensions = new Map<string, CatalogTag[]>();
  for (const tag of input.tags) dimensions.set(tag.name, [...(dimensions.get(tag.name) ?? []), tag]);
  const tagMatches = (tags: CatalogTag[]) => tags.length ? sql`(
    ${sql.join(tags.map(tag => sql`r.tags @> ${JSON.stringify([{ name: tag.name, value: tag.value.toLowerCase() }])}::jsonb`), sql` or `)})` : sql`true`;
  const tagConditions = [...dimensions].map(([name, tags]) => {
    const condition = tagMatches(tags);
    const aiStandard = sql`r.standard_product_id in (select id from catalog_standards where is_ai_membership)`;
    // Only inferred shared access is a rental alias; other access requirements still constrain AI offers.
    if (name === 'access' && input.membershipSearch?.access) {
      return { name, condition: sql`(case when ${aiStandard}
        then ${tagMatches(tags.filter(tag => tag.value !== 'shared'))} else ${condition} end)` };
    }
    return { name, condition: name === 'delivery' && input.membershipSearch?.delivery
      ? sql`(${aiStandard} or ${condition})` : condition };
  });
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
  const preparedTotals = !words.length && !tagConditions.length && !input.newcomer && !input.detailKind
    && !input.membershipKinds?.length && !input.membershipSearch
    && input.priceMin === undefined && input.priceMax === undefined;
  const rankingCtes = sql`${preparedTotals ? sql`prepared_totals as materialized (
      select e.* from catalog_read_shop_totals e
      where e.currency = ${currency} and e.standard_product_id in (select id from catalog_standards)
        and e.shop_id in (select shop_id from catalog_shops)
        ${input.shopId ? sql`and e.shop_id = ${input.shopId}::bigint` : sql``}
        ${input.shopQuery ? sql`and e.shop_id in (select shop_id from catalog_shops
          where search_text like lower(${`%${input.shopQuery.replace(/[\\%_]/gu, '\\$&')}%`}))` : sql``}
    ),` : sql``} shop_totals as materialized (
      ${preparedTotals ? sql`select * from prepared_totals e where ${platformCondition}` : sql`
      select standard_product_id, shop_id, min(price) as min_price,
        max(captured_at) as latest_captured_at, count(*)::int as product_count
      from filtered_skus group by standard_product_id, shop_id`}
    ), product_totals as materialized (
      select standard_product_id, min(min_price) as min_price, max(latest_captured_at) as latest_captured_at,
        sum(product_count)::int as product_count, count(*)::int as shop_count
      from shop_totals group by standard_product_id
    ), page as (
      select t.*, sp.catalog_rank, sp.sort_order, sp.name as standard_product_name, sp.platform, sp.is_ai_membership, ${sortValue} as sort_value
      from product_totals t join catalog_standards sp on sp.id = t.standard_product_id
      where ${afterCursor}
      order by sort_value, ${sort === 'default' ? sql`catalog_rank,` : sql``} sort_order, standard_product_id limit ${limit + 1}
    ), visible_page as materialized (
      select * from page
      order by sort_value, ${sort === 'default' ? sql`catalog_rank,` : sql``} sort_order, standard_product_id limit ${limit}
    )${input.detailKind !== 'shops' ? sql`, preview_shop_totals as materialized (
      select * from (
        select s.*, row_number() over (partition by s.standard_product_id order by s.min_price, s.shop_id) as shop_rank
        from shop_totals s join visible_page using (standard_product_id)
      ) ranked where shop_rank <= 4
    )` : sql``}, shop_winner_ids as (
      ${preparedTotals ? sql`select winner_id as product_id from preview_shop_totals` : sql`
      select min(e.product_id) as product_id${input.detailKind === 'shops' ? sql`, max(s.product_count)::int as shop_product_count` : sql``}
      from filtered_skus e join ${sql.table(input.detailKind !== 'shops' ? 'preview_shop_totals' : 'shop_totals')} s using (standard_product_id, shop_id)
      join visible_page using (standard_product_id) where e.price = s.min_price
      group by e.standard_product_id, e.shop_id`}
    ), shop_winners as (
      select e.product_id, e.captured_at, e.standard_product_id, e.price, e.shop_id, e.membership_kind${input.detailKind === 'shops' ? sql`, w.shop_product_count` : sql``}
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
        ${input.standardProductId ? sql`and sp.id = ${input.standardProductId}::bigint` : sql``}
    ), catalog_standards as materialized (
      select sp.id, sp.name, sp.platform, sp.sort_order, sp.platform_group, sp.search_text,
        is_ai_membership(sp.canonical_family, sp.canonical_product, sp.canonical_tier) as is_ai_membership,
        ${optionsOnly || sort !== 'default' ? sql`0::int` : catalogOrderRank(sql<string>`sp.platform_group`)} as catalog_rank
      from catalog_groups sp
    ), catalog_shops as materialized (
      select sh.id as shop_id, sh.name as shop_name,
        -- Marketplace protocols are the lower-risk baseline; every other or unknown protocol is a self-built storefront with a higher-risk marker.
        (sh.protocol is distinct from 'liandong' and sh.protocol is distinct from '16688') as independent_shop,
        ${words.length || input.shopQuery ? sql`lower(normalize(sh.name, NFKC))` : sql`null::text`} as search_text
      from shops sh where sh.enabled = true and sh.deleted_at is null
    ), eligible_skus as not materialized (
      select r.standard_product_id,
        ${optionsOnly ? sql`r.facet_tags` : sql`r.product_id, r.captured_at, ${kind} as membership_kind,
          ${price} as price, r.shop_id`}
      from ${sql.table(pricesOnly ? 'catalog_read_offer_prices' : 'catalog_read_offers')} r
      join catalog_standards cs on cs.id = r.standard_product_id
      join catalog_shops sh on sh.shop_id = r.shop_id
      ${needsMembership ? sql`left join catalog_membership_kinds mk on cs.is_ai_membership and mk.product_id = r.product_id
        and mk.policy_version = ${MEMBERSHIP_POLICY_VERSION}` : sql``}
      where ${sql.join(conditions, sql` and `)}
    )`;
  const scopeCtes = sql`scoped_skus as not materialized (
      select * from eligible_skus e where ${platformCondition}
    )`;
  const facetOptionsCtes = sql`facet_sets as materialized (
      ${input.newcomer || input.membershipKinds?.length || input.membershipSearch ? sql`
      select facet_tags::jsonb as tags, count(*)::int as weight from scoped_skus group by facet_tags`
        : sql`select f.facet_tags::jsonb as tags, f.product_count as weight
      from catalog_read_facet_counts f
      where f.facet_tags in (select facet_tags from scoped_skus)`}
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
        null::text as next_expiry_at
      from facet_options f left join facet_tags t using (name, value)`;
  }
  const navigationIds = preparedTotals ? sql`select distinct standard_product_id from prepared_totals` : requestedPlatform || tagConditions.length
    ? sql`select distinct standard_product_id from eligible_skus`
    : sql`select standard_product_id from product_totals`;
  return sql<CatalogResult>`with ${eligibleCte}, ${tagConditions.length ? sql`purchase_matches as materialized (
      select r.product_id from catalog_read_offers r where ${filters}
    ),` : sql``} filtered_skus as ${words.length || requestedPlatform || tagConditions.length || membershipFiltered ? sql`materialized` : sql`not materialized`} (
      select e.* from eligible_skus e
      where ${platformCondition}
      ${tagConditions.length ? sql`and e.product_id in (select product_id from purchase_matches)` : sql``}
    ), ${rankingCtes}, preview_skus as materialized (
      select w.*, ${payloadFields}
      from ranked_shops w join catalog_read_offers r using (product_id)
      join catalog_shops sh on sh.shop_id = r.shop_id
      where preview_rank <= 4
    )${input.detailKind ? sql`, detail_skus as materialized (
      select detail.* from visible_page page cross join lateral (
        select d.*
        from ${sql.table(input.detailKind === 'shops' ? 'ranked_shops' : 'filtered_skus')} d
        where d.standard_product_id = page.standard_product_id
        order by ${detailOrder} limit ${detailPageSize} offset ${detailPage * detailPageSize}
      ) detail
    ), detail_entries as (
      select d.*, ${payloadFields}
      from detail_skus d join catalog_read_offers r using (product_id)
      join catalog_shops sh on sh.shop_id = r.shop_id
    ), detail_payload as (
      select d.standard_product_id, coalesce(jsonb_agg(${input.detailKind === 'shops' ? sql`jsonb_build_object(
        'key', d.shop_id::text, 'name', d.shop_name, 'count', d.shop_product_count, 'offer',` : sql``}
        ${offerPayload('d')}${input.detailKind === 'shops' ? sql`)` : sql``}
        order by ${detailOrder}), '[]'::jsonb) as entries
      from detail_entries d group by d.standard_product_id
    )` : sql``}, catalog_items as (
      select page.catalog_rank, page.sort_order, page.standard_product_id, page.standard_product_name, page.platform, page.is_ai_membership, page.sort_value,
        page.product_count, page.shop_count, page.latest_captured_at, jsonb_agg(${offerPayload('w')} order by w.price nulls last, case when w.price is null then w.captured_at end desc, w.shop_id, w.product_id) as offers
      from visible_page page join preview_skus w using (standard_product_id)
      group by page.catalog_rank, page.sort_order, page.standard_product_id, page.standard_product_name, page.platform, page.is_ai_membership, page.sort_value,
        page.product_count, page.shop_count, page.latest_captured_at
    ), membership_candidates as materialized (
      select e.* from filtered_skus e join visible_page page using (standard_product_id)
      where page.is_ai_membership
    ), membership_skus as materialized (
      select e.* from membership_candidates e
      where e.membership_kind is not null or (select ${failedMembershipFeatures('p', 'source_shop')}
          from products p join shops source_shop on source_shop.id = p.shop_id where p.id = e.product_id)
    ), membership_counts as (
      select standard_product_id, membership_kind, count(distinct shop_id)::int as shop_count, count(*)::int as product_count,
        min(price)::text as min_price, max(price)::text as max_price, max(captured_at) as latest_captured_at
      from membership_skus group by standard_product_id, membership_kind
    ), membership_shop_winners as (
      select distinct on (standard_product_id, membership_kind, shop_id) * from membership_skus
      order by standard_product_id, membership_kind, shop_id, price nulls last,
        case when price is null then captured_at end desc, product_id
    ), membership_ranked as (
      select e.*, row_number() over (partition by standard_product_id, membership_kind
        order by price nulls last, case when price is null then captured_at end desc, shop_id, product_id) as group_rank
      from membership_shop_winners e
    ), membership_preview as materialized (
      select g.*, ${payloadFields} from membership_ranked g join catalog_read_offers r using (product_id)
      join catalog_shops sh on sh.shop_id = g.shop_id where g.group_rank <= 4
    ), membership_groups as (
      select c.standard_product_id, jsonb_agg(jsonb_build_object(
        'kind', coalesce(c.membership_kind, 'unclassified'), 'shopCount', c.shop_count, 'productCount', c.product_count,
        'minPrice', c.min_price, 'maxPrice', c.max_price, 'latestCapturedAt', c.latest_captured_at,
        'offers', (select jsonb_agg(${offerPayload('g')} order by g.group_rank) from membership_preview g
          where g.standard_product_id = c.standard_product_id and g.membership_kind is not distinct from c.membership_kind)
      ) order by array_position(${[...MEMBERSHIP_GROUPS]}::text[], coalesce(c.membership_kind, 'unclassified'))) as groups
      from membership_counts c group by c.standard_product_id
    ), returned_shop_ids as materialized (
      select distinct shop_id from preview_skus
      union select shop_id from membership_preview
      ${input.detailKind ? sql`union select shop_id from detail_skus` : sql``}
    ), catalog_page as (
    select
      (select count(*) > ${limit} from page) as has_next,
      (select coalesce(jsonb_agg(jsonb_build_object(
        'id', standard_product_id::text, 'name', standard_product_name, 'platform', platform, 'isAiMembership', is_ai_membership,
        'catalogRank', catalog_rank, 'sortOrder', sort_order::text, 'sortValue', sort_value::text, 'offers', offers,
        'shopCount', shop_count, 'productCount', product_count, 'latestCapturedAt', latest_captured_at
      ) || case when is_ai_membership and exists (select 1 from membership_groups g where g.standard_product_id = catalog_items.standard_product_id)
        then jsonb_build_object('membershipGroups', (select groups from membership_groups g where g.standard_product_id = catalog_items.standard_product_id))
        else '{}'::jsonb end${input.detailKind ? sql` || jsonb_build_object('detail', jsonb_build_object(
        'kind', ${input.detailKind}::text, 'page', ${detailPage}::bigint, 'pageSize', ${detailPageSize}::int,
        'total', ${input.detailKind === 'shops' ? sql`shop_count` : sql`product_count`},
        'entries', coalesce((select entries from detail_payload d where d.standard_product_id = catalog_items.standard_product_id), '[]'::jsonb)
      ))` : sql``} order by sort_value, ${sort === 'default' ? sql`catalog_rank,` : sql``} sort_order, standard_product_id), '[]'::jsonb) from catalog_items) as entries,
      (select coalesce(jsonb_agg(platform order by platform), '[]'::jsonb)
       from (select distinct sp.platform_group as platform from (${navigationIds}) e
         join catalog_standards sp on sp.id = e.standard_product_id) platforms) as platform_facets,
      (select count(*)::int from product_totals) as total,
      (select coalesce(sum(product_count), 0)::int from product_totals) as offer_total,
      null::text as next_expiry_at
    ) select p.*, coalesce((select jsonb_agg(jsonb_build_object(
      'shop_id', r.shop_id::text, 'score', r.score, 'details', r.details))
      from catalog_shop_ratings r join returned_shop_ids s using (shop_id)), '[]'::jsonb) as shop_ratings
    from catalog_page p
  `;
}

function catalogPageLimit(value: number): number {
  return Math.min(Math.max(Math.trunc(value || DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
}

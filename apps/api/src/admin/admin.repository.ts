import { Inject, Injectable } from '@nestjs/common';
import { canonicalProductDisplayName, CATALOG_DISPLAY_SEARCH_LABELS } from '@price-comparison/catalog/catalog-display';
import { recordManualDecisions } from '../standardization/decision-history.js';
import { publicationEvidenceConflict } from '../standardization/publication-evidence.js';
import { productProcessingSummary, productStandardizationOutcome, type ProductProcessingState, type ProductProcessingSummary } from '../ai/product-standardization-state.js';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DomainValidationError } from '../common/errors.js';
import { DATABASE } from '../database/database.providers.js';
import { bumpCatalogVersion, recordCandidateCatalogChanges } from '../catalog/catalog-version.repository.js';
import { normalizeCatalogAliases, relatedCatalogAliasOwners } from '../standardization/catalog-aliases.js';
import { buildCanonicalStandardKey } from '../standardization/canonical-key.js';
import { hasValidIdentityFields, IDENTITY_POLICY_VERSION, normalizeIdentity } from '../standardization/identity-policy.js';
import type { AiJobStatus, DatabaseSchema, FetchRunStatus, JsonValue } from '../database/types.js';
import {
  buildCursorPage,
  normalizePageLimit,
  normalizePageRequest,
  type CursorPage,
  type PageRequest,
} from '../common/pagination.js';

export type ShopListStatus = 'active' | 'disabled' | 'deleted';

export interface ShopListFilter extends PageRequest {
  readonly standardProductId?: bigint;
  readonly status?: ShopListStatus;
  readonly keyword?: string;
}

export interface ProductListFilter extends PageRequest {
  readonly standardProductId?: bigint;
  readonly shopId?: bigint;
  readonly keyword?: string;
  readonly standardized?: boolean;
  readonly pending?: boolean;
  readonly deleted?: boolean;
}

export interface StandardProductListFilter extends PageRequest {
  readonly status?: 'active' | 'hidden' | 'merged' | 'unmerged' | 'all';
  readonly keyword?: string;
  readonly platform?: string;
}

export interface PlatformListFilter extends PageRequest {
  readonly status?: 'enabled' | 'disabled' | 'all';
  readonly keyword?: string;
}

export interface TagListFilter extends PageRequest {
  readonly productId?: bigint;
  readonly keyword?: string;
  readonly name?: string;
  readonly value?: string;
}

export interface AiJobListFilter extends PageRequest {
  readonly status?: AiJobStatus;
  readonly shopId?: bigint;
}

export interface RunHistoryListFilter extends PageRequest {
  readonly shopId?: bigint;
  readonly status?: FetchRunStatus;
}

export interface AdminShopRow {
  readonly id: bigint;
  readonly protocol: string | null;
  readonly platform: string;
  readonly url: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly last_fetch_at: Date | null;
  readonly last_error: string | null;
}

export interface AdminProductRow {
  readonly id: bigint;
  readonly shop_id: bigint;
  readonly shop_name: string | null;
  readonly external_id: string;
  readonly name: string;
  readonly spec: string;
  readonly source_category: string;
  readonly source_data: JsonValue;
  readonly normalized_key: string;
  readonly url: string;
  readonly image_url: string | null;
  readonly updated_at: Date;
  readonly deleted_at: Date | null;
  readonly standard_product_name: string | null;
  readonly standardization_outcome?: 'classified' | 'cannot_process' | null;
  readonly processing_summary?: ProductProcessingSummary;
  readonly tags: JsonValue;
  readonly latest_price: string | null;
  readonly latest_currency: string | null;
}

export interface AdminStandardProductRow {
  readonly aliases: string[];
  readonly id: bigint;
  readonly name: string;
  readonly platform: string;
  readonly sort_order: bigint;
  readonly standard_key: string | null;
  readonly canonical_family: string | null;
  readonly canonical_product: string | null;
  readonly canonical_tier: string | null;
  readonly hidden: boolean;
  readonly merged_into_id: bigint | null;
  readonly member_count: bigint;
  readonly shop_count: bigint;
}

export interface AdminTagRow {
  readonly id: bigint;
  readonly product_id: bigint;
  readonly name: string;
  readonly value: string;
  readonly product_count?: bigint;
  readonly product_ids?: readonly bigint[];
}

export interface AdminTagProductRow extends AdminProductRow {
  readonly shop_name: string;
}

export interface AdminAiJobRow {
  readonly id: bigint;
  readonly status: AiJobStatus;
  readonly total: bigint;
  readonly processed: bigint;
  readonly applied: bigint;
  readonly model: string;
  readonly auto_apply: boolean;
  readonly error: string | null;
  readonly created_at: Date;
  readonly finished_at: Date | null;
  readonly scope_shop_id: bigint | null;
  readonly prompt_version: string;
  readonly phase: string;
  readonly pause_requested: boolean;
  readonly cancel_requested: boolean;
  readonly failed_batches: bigint;
}

export interface AdminRunHistoryRow {
  readonly id: bigint;
  readonly shop_id: bigint;
  readonly shop_name: string | null;
  readonly started_at: Date;
  readonly finished_at: Date | null;
  readonly status: FetchRunStatus;
  readonly item_count: bigint;
  readonly error: string | null;
  readonly settlement_report?: unknown;
  readonly task_type: 'list' | 'settlement';
  readonly source_fetch_run_id: bigint | null;
  readonly crawl_metrics: JsonValue | null;
}
export interface AdminPlatformRow { readonly id: string; readonly name: string; readonly enabled: boolean; readonly standard_product_count: bigint }
export interface AdminBatchResult { readonly success: string[]; readonly skipped: string[]; readonly conflicts: Array<{ id: string; reason: string }>; readonly notice?: string }
// Human review outranks the shop-text gate: list each contradiction so an admin can confirm instead of a blanket refusal.
function evidenceConflicts(products: ReadonlyArray<{ id: bigint; name: string; spec: string; source_data: JsonValue }>): Array<{ id: string; reason: string }> {
  return products.flatMap(product => {
    const conflict = publicationEvidenceConflict({ name: product.name, spec: product.spec, sourceData: product.source_data });
    return conflict ? [{ id: product.id.toString(), reason: `发布证据冲突：${conflict}` }] : [];
  });
}

@Injectable()
export class AdminRepository {
  constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  async listShops(filter: ShopListFilter = {}): Promise<CursorPage<AdminShopRow>> {
    const page = normalizePageRequest(filter);
    let query = this.database
      .selectFrom('shops')
      .select([
        'shops.id', 'shops.platform', 'shops.protocol', 'shops.url', 'shops.name', 'shops.enabled',
        'shops.last_fetch_at', 'shops.last_error',
      ])
      .orderBy('shops.id', 'asc')
      ;

    if (filter.status === 'deleted') {
      query = query.where('shops.deleted_at', 'is not', null);
    } else {
      query = query.where('shops.deleted_at', 'is', null);
      if (filter.status === 'active') query = query.where('shops.enabled', '=', true);
      if (filter.status === 'disabled') query = query.where('shops.enabled', '=', false);
    }
    if (filter.keyword) {
      const pattern = containsPattern(filter.keyword);
      query = query.where(({ eb, or }) => or([
        eb('shops.name', 'ilike', pattern),
        eb('shops.url', 'ilike', pattern),
        eb('shops.platform', 'ilike', pattern),
      ]));
    }
    if (filter.standardProductId !== undefined) {
      query = query.where(({ exists, selectFrom }) => exists(
        selectFrom('standard_product_members as member')
          .innerJoin('products as member_product', 'member_product.id', 'member.product_id')
          .select('member.product_id')
          .whereRef('member_product.shop_id', '=', 'shops.id')
          .where('member_product.deleted_at', 'is', null)
          .where('member.standard_product_id', '=', filter.standardProductId!),
      ));
    }
    if (page.afterId !== undefined) query = query.where('shops.id', '>', page.afterId);
    if (page.page !== undefined) {
      const rows = await query.select(sql<number>`count(*) over()`.as('_total')).offset((page.page - 1) * page.limit).limit(page.limit).execute();
      return { items: rows, total: Number(rows[0]?._total ?? 0), page: page.page, pageSize: page.limit };
    }

    return buildCursorPage(await query.limit(page.limit + 1).execute(), page.limit);
  }

  async listProducts(filter: ProductListFilter = {}): Promise<CursorPage<AdminProductRow>> {
    if (filter.pending === undefined) return this.listProductPage(this.database, filter);
    return this.database.transaction().setIsolationLevel('repeatable read').execute(async transaction => {
      // JIT compilation costs more than execution for this interactive status query.
      await sql`set local jit = off`.execute(transaction);
      const page = await this.listProductPage(transaction, filter);
      if (!filter.pending || !page.items.length) return page;
      const states = await transaction.selectFrom('products as p')
        .select(['p.id', sql<ProductProcessingState>`(
          select jsonb_build_object(
            'reasonCode', case
              when p.standardization_locked or (d.content_version=p.content_version and d.content_fingerprint=p.content_fingerprint) then 'manual_decision_preserved'
              when r.job_id is null then 'not_processed'
              when r.content_version<>p.content_version or im.content_version<>p.content_version
                or im.standardization_revision<>p.standardization_revision then 'source_changed'
              when r.status='unclassified' then coalesce(r.reason_code, 'other_unclassified') else 'unassigned' end,
            'reason', r.reason, 'requestError', b.error, 'manualReason', d.reason)
          from (select 1) anchor
          left join lateral (select content_version, content_fingerprint, reason
            from product_standardization_decisions where product_id=p.id order by id desc limit 1) d on true
          left join lateral (select job_id, batch_id, product_id, content_version, status, reason_code, reason
            from ai_standardization_results where product_id=p.id order by job_id desc limit 1) r on true
          left join ai_job_input_members im on im.job_id=r.job_id and im.product_id=p.id
          left join ai_job_batches b on b.id=r.batch_id
        )`.as('processing_state')])
        .where('p.id', 'in', page.items.map(item => item.id)).execute();
      const summaries = new Map(states.map(row => [row.id, productProcessingSummary(row.processing_state)]));
      return { ...page, items: page.items.map(item => ({ ...item, processing_summary: summaries.get(item.id) })) };
    });
  }

  private async listProductPage(database: Kysely<DatabaseSchema>, filter: ProductListFilter): Promise<CursorPage<AdminProductRow>> {
    const page = normalizePageRequest(filter);
    let query = database
      .selectFrom('products')
      .select([
        'products.id', 'products.shop_id', 'products.external_id', 'products.name', 'products.spec',
        'products.source_category', 'products.source_data', 'products.normalized_key', 'products.url',
        'products.image_url', 'products.updated_at', 'products.deleted_at',
        (filter.pending === true ? sql<null>`null` : productStandardizationOutcome('products')).as('standardization_outcome'),
        sql<string | null>`(select s.name from shops s where s.id = products.shop_id)`.as('shop_name'),
        sql<string | null>`(select sp.name from standard_product_members m join standard_products sp on sp.id = m.standard_product_id where m.product_id = products.id limit 1)`.as('standard_product_name'),
        sql<JsonValue>`coalesce((select jsonb_agg(jsonb_build_object('name', t.name, 'value', t.value) order by t.name, t.value) from product_tags t where t.product_id = products.id), '[]'::jsonb)`.as('tags'),
        sql<string | null>`(select o.price from offers o where o.product_id = products.id order by o.captured_at desc, o.id desc limit 1)`.as('latest_price'),
        sql<string | null>`(select o.currency from offers o where o.product_id = products.id order by o.captured_at desc, o.id desc limit 1)`.as('latest_currency'),
      ])
      .orderBy('products.id', 'asc');

    query = query.where('products.deleted_at', filter.deleted ? 'is not' : 'is', null);

    if (filter.shopId !== undefined) query = query.where('products.shop_id', '=', filter.shopId);
    if (filter.standardProductId !== undefined) {
      query = query.where(({ exists, selectFrom }) => exists(
        selectFrom('standard_product_members as member').select('member.product_id')
          .whereRef('member.product_id', '=', 'products.id')
          .where('member.standard_product_id', '=', filter.standardProductId!),
      ));
    }
    if (filter.keyword) {
      const pattern = containsPattern(filter.keyword);
      query = query.where(({ eb, or }) => or([
        eb('products.name', 'ilike', pattern),
        eb('products.normalized_key', 'ilike', pattern),
        eb('products.external_id', 'ilike', pattern),
      ]));
    }
    if (filter.standardized !== undefined) {
      query = query
        .leftJoin('standard_product_members as standard_member', (join) =>
          join.onRef('standard_member.product_id', '=', 'products.id'))
        .where(
          'standard_member.product_id',
          filter.standardized ? 'is not' : 'is',
          null,
        );
    }
    if (filter.pending !== undefined) {
      query = query.where(productStandardizationOutcome('products'), filter.pending ? 'is' : 'is not', null);
    }
    if (page.afterId !== undefined) query = query.where('products.id', '>', page.afterId);
    if (page.page !== undefined) {
      const rows = await query.select(sql<number>`count(*) over()`.as('_total')).offset((page.page - 1) * page.limit).limit(page.limit).execute();
      return { items: rows, total: Number(rows[0]?._total ?? 0), page: page.page, pageSize: page.limit };
    }

    return buildCursorPage(await query.limit(page.limit + 1).execute(), page.limit);
  }

  async listStandardProductPlatforms(includeMerged = false): Promise<string[]> {
    let query = this.database.selectFrom('standard_products').select('platform').distinct().orderBy('platform');
    if (!includeMerged) query = query.where('merged_into_id', 'is', null);
    return (await query.execute()).map(row => row.platform).filter(platform => platform.trim());
  }

  async listStandardProducts(filter: StandardProductListFilter = {}): Promise<CursorPage<AdminStandardProductRow>> {
    const page = normalizePageRequest(filter);
    let query = this.database
      .selectFrom('standard_products')
      .select(['standard_products.id', 'standard_products.name', 'standard_products.platform', 'standard_products.sort_order', 'standard_products.standard_key', 'standard_products.canonical_family', 'standard_products.canonical_product', 'standard_products.canonical_tier', 'standard_products.aliases', 'standard_products.hidden', 'standard_products.merged_into_id', sql<bigint>`count(member_products.id)`.as('member_count'), sql<bigint>`count(distinct member_shops.id)`.as('shop_count')])
      .leftJoin('standard_product_members', 'standard_product_members.standard_product_id', 'standard_products.id')
      .leftJoin('products as member_products', join => join.onRef('member_products.id', '=', 'standard_product_members.product_id').on('member_products.deleted_at', 'is', null))
      .leftJoin('shops as member_shops', join => join.onRef('member_shops.id', '=', 'member_products.shop_id').on('member_shops.deleted_at', 'is', null))
      .groupBy(['standard_products.id', 'standard_products.name', 'standard_products.platform', 'standard_products.sort_order', 'standard_products.standard_key', 'standard_products.canonical_family', 'standard_products.canonical_product', 'standard_products.canonical_tier', 'standard_products.aliases', 'standard_products.hidden', 'standard_products.merged_into_id'])
      .orderBy('standard_products.id', 'asc');

    if (filter.keyword) {
      const words = [...new Set(filter.keyword.normalize('NFKC').trim().split(/\s+/u).filter(Boolean))];
      const labels = CATALOG_DISPLAY_SEARCH_LABELS;
      const searchText = sql<string>`regexp_replace(normalize(concat_ws(' ', standard_products.name, standard_products.standard_key,
        standard_products.platform, standard_products.canonical_family, standard_products.canonical_product, standard_products.canonical_tier,
        array_to_string(standard_products.aliases, ' '),
        ${JSON.stringify(labels.products)}::jsonb ->> lower(btrim(standard_products.canonical_product)),
        ${JSON.stringify(labels.families)}::jsonb ->> lower(btrim(standard_products.canonical_family)),
        ${JSON.stringify(labels.tiers)}::jsonb ->> lower(btrim(standard_products.canonical_tier))), NFKC), '[[:space:]]+', '', 'g')`;
      for (const word of words) query = query.where(searchText, 'ilike', containsPattern(word));
      // ID cursors keep their original ordering; relevance applies to numbered picker pages.
      if (page.page !== undefined && words.length) query = query.clearOrderBy().orderBy(sql`case when lower(standard_products.canonical_product) in (${sql.join(words.map(word => sql`${word.toLowerCase()}`))}) then 0 else 1 end`).orderBy('standard_products.id');
    }
    if (filter.platform) query = query.where('standard_products.platform', '=', filter.platform);
    if (filter.status === 'active' || filter.status === 'hidden') {
      query = query.where('standard_products.hidden', '=', filter.status === 'hidden').where('standard_products.merged_into_id', 'is', null);
    } else if (filter.status === 'merged') query = query.where('standard_products.merged_into_id', 'is not', null);
    else if (filter.status === 'unmerged') query = query.where('standard_products.merged_into_id', 'is', null);
    if (page.page !== undefined) {
      const rows = await query.select(sql<number>`count(*) over()`.as('_total')).offset((page.page - 1) * page.limit).limit(page.limit).execute();
      return { items: rows.map(({ _total: _total, ...row }) => row), total: Number(rows[0]?._total ?? 0), page: page.page, pageSize: page.limit };
    }
    if (page.afterId !== undefined) query = query.where('standard_products.id', '>', page.afterId);

    return buildCursorPage(await query.limit(page.limit + 1).execute(), page.limit);
  }

  async listTags(filter: TagListFilter = {}): Promise<CursorPage<AdminTagRow>> {
    const limit = normalizePageLimit(filter.limit);
    let query = this.database
      .selectFrom('product_tags')
      .innerJoin('products as tagged_products', 'tagged_products.id', 'product_tags.product_id')
      .select([sql<bigint>`min(product_tags.id)`.as('id'), sql<bigint>`min(product_tags.product_id)`.as('product_id'), 'product_tags.name', 'product_tags.value', sql<bigint>`count(*)`.as('product_count'), sql<bigint[]>`array_agg(product_tags.product_id order by product_tags.product_id)`.as('product_ids')])
      .where('tagged_products.deleted_at', 'is', null)
      .groupBy(['product_tags.name', 'product_tags.value'])
      .orderBy('product_tags.name', 'asc')
      .orderBy('product_tags.value', 'asc')
      .orderBy(sql`min(product_tags.id)`, 'asc');

    if (filter.productId !== undefined) query = query.where('product_tags.product_id', '=', filter.productId);
    if (filter.keyword) {
      const pattern = containsPattern(filter.keyword);
      query = query.where(({ eb, or }) => or([
        eb('product_tags.name', 'ilike', pattern),
        eb('product_tags.value', 'ilike', pattern),
      ]));
    }
    if (filter.name) query = query.where('product_tags.name', '=', filter.name);
    if (filter.value) query = query.where('product_tags.value', '=', filter.value);
    if (filter.page !== undefined) {
      const rows = await query.select(sql<number>`count(*) over()`.as('_total')).offset((filter.page - 1) * limit).limit(limit).execute();
      return { items: rows.map(({ _total: _total, ...row }) => row), total: Number(rows[0]?._total ?? 0), page: filter.page, pageSize: limit };
    }
    query = query.limit(limit + 1);
    if (filter.cursor !== undefined) {
      const cursor = decodeTagCursor(filter.cursor);
      query = query.where(({ eb, and, or }) => or([
        eb('product_tags.name', '>', cursor.name),
        and([
          eb('product_tags.name', '=', cursor.name),
          eb('product_tags.value', '>', cursor.value),
        ]),
      ]));
    }

    const rows = await query.execute();
    const hasNext = rows.length > limit;
    const items = hasNext ? rows.slice(0, limit) : [...rows];
    const last = items.at(-1);
    return {
      items,
      ...(hasNext && last ? { nextCursor: encodeTagCursor(last) } : {}),
    };
  }
  async listAiJobs(filter: AiJobListFilter = {}): Promise<CursorPage<AdminAiJobRow>> {
    const page = normalizePageRequest(filter);
    let query = this.database
      .selectFrom('ai_jobs')
      .select([
        'id', 'status', 'total', 'processed', 'applied', 'model', 'auto_apply', 'error',
        'created_at', 'finished_at', 'scope_shop_id', 'prompt_version', 'phase',
        'pause_requested', 'cancel_requested', 'failed_batches',
      ])
      .orderBy('id', 'asc')
      .limit(page.limit + 1);

    if (filter.status) query = query.where('status', '=', filter.status);
    if (filter.shopId !== undefined) query = query.where('scope_shop_id', '=', filter.shopId);
    if (page.afterId !== undefined) query = query.where('id', '>', page.afterId);

    return buildCursorPage(await query.execute(), page.limit);
  }

  async listRunHistory(filter: RunHistoryListFilter = {}): Promise<CursorPage<AdminRunHistoryRow>> {
    const page = normalizePageRequest(filter);
    let query = this.database
      .selectFrom('fetch_runs')
      .leftJoin('shops', 'shops.id', 'fetch_runs.shop_id')
      .select([
        'fetch_runs.id', 'fetch_runs.shop_id', 'shops.name as shop_name',
        'fetch_runs.started_at', 'fetch_runs.finished_at', 'fetch_runs.status',
        'fetch_runs.item_count', 'fetch_runs.error', 'fetch_runs.settlement_report',
        'fetch_runs.task_type', 'fetch_runs.source_fetch_run_id', 'fetch_runs.crawl_metrics',
      ])
      .orderBy('fetch_runs.started_at', 'desc')
      .orderBy('fetch_runs.id', 'desc')
      .limit(page.limit + 1);

    if (filter.shopId !== undefined) query = query.where('fetch_runs.shop_id', '=', filter.shopId);
    if (filter.status) query = query.where('fetch_runs.status', '=', filter.status);
    if (page.page !== undefined) {
      const [items, count] = await Promise.all([
        query.offset((page.page - 1) * page.limit).limit(page.limit).execute(),
        query.clearSelect().clearOrderBy().clearLimit()
          .select(({ fn }) => fn.countAll<string>().as('total')).executeTakeFirstOrThrow(),
      ]);
      return { items, total: Number(count.total), page: page.page, pageSize: page.limit };
    }
    if (page.afterId !== undefined) query = query.where(sql<boolean>`
      (fetch_runs.started_at, fetch_runs.id) < (select started_at, id from fetch_runs where id = ${page.afterId})`);

    return buildCursorPage(await query.execute(), page.limit);
  }

  async listPlatforms(request: PlatformListFilter = {}): Promise<CursorPage<AdminPlatformRow>> {
    const page = normalizePageRequest(request);
    let query = this.database.selectFrom('product_platforms').select(['name', 'enabled']).orderBy('name');
    if (request.status === 'enabled' || request.status === 'disabled') query = query.where('enabled', '=', request.status === 'enabled');
    if (request.keyword) query = query.where('name', 'ilike', containsPattern(request.keyword));
    const rows = await query.execute();
    if (page.page !== undefined) {
      const slice = rows.slice((page.page - 1) * page.limit, page.page * page.limit);
      const items = await Promise.all(slice.map(async (row) => ({ id: row.name, name: row.name, enabled: row.enabled, standard_product_count: BigInt(Number((await this.database.selectFrom('standard_products').select(({ fn }) => fn.countAll<number>().as('count')).where('platform', '=', row.name).executeTakeFirstOrThrow()).count)) })));
      return { items, total: rows.length, page: page.page, pageSize: page.limit };
    }
    const start = page.afterId === undefined ? 0 : Number(page.afterId);
    const slice = rows.slice(start, start + page.limit + 1);
    const items = await Promise.all(slice.slice(0, page.limit).map(async (row) => ({ id: row.name, name: row.name, enabled: row.enabled, standard_product_count: BigInt(Number((await this.database.selectFrom('standard_products').select(({ fn }) => fn.countAll<number>().as('count')).where('platform', '=', row.name).executeTakeFirstOrThrow()).count)) })));
    return { items, ...(slice.length > page.limit ? { nextCursor: String(start + page.limit) } : {}) };
  }

  async createPlatform(name: string): Promise<AdminPlatformRow> {
    await this.database.insertInto('product_platforms').values({ name, enabled: true }).onConflict(c => c.column('name').doUpdateSet({ enabled: true })).execute();
    return this.platformByName(name);
  }

  async renamePlatform(name: string, nextName: string): Promise<AdminPlatformRow | undefined> {
    const result = await this.database.transaction().execute(async tx => {
      const names = [...new Set([name, nextName])].sort();
      const platforms = await tx.selectFrom('product_platforms').select(['name', 'enabled']).where('name', 'in', names).orderBy('name').forUpdate().execute();
      const current = platforms.find(platform => platform.name === name);
      if (!current) return false;
      if (name !== nextName && platforms.some(platform => platform.name === nextName)) {
        throw new DomainValidationError('PLATFORM_NAME_CONFLICT', '目标平台名称已存在');
      }
      const affected = await tx.selectFrom('standard_product_members as member')
        .innerJoin('standard_products as standard', 'standard.id', 'member.standard_product_id')
        .select('member.product_id')
        .where('standard.platform', '=', name)
        .orderBy('member.product_id')
        .forUpdate()
        .execute();
      const affectedProductIds = [...new Set(affected.map(row => row.product_id.toString()))].map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
      for (const productId of affectedProductIds) {
        await tx.selectFrom('products').select('id').where('id', '=', productId).forUpdate().executeTakeFirst();
        await tx.updateTable('products').set({ standardization_revision: sql`standardization_revision + 1` }).where('id', '=', productId).execute();
      }
      await tx.updateTable('product_platforms').set({ name: nextName }).where('name', '=', name).execute();
      const standards = await tx.updateTable('standard_products').set({ platform: nextName }).where('platform', '=', name).executeTakeFirst();
      if (standards.numUpdatedRows > 0n) await bumpCatalogVersion(tx);
      return true;
    });
    if (!result) return undefined;
    return this.platformByName(nextName);
  }

  async deletePlatform(name: string): Promise<boolean> {
    const result = await this.database.updateTable('product_platforms').set({ enabled: false }).where('name', '=', name).executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async setPlatformsEnabled(names: readonly string[], enabled: boolean): Promise<AdminBatchResult> {
    return this.database.transaction().execute(async tx => {
      const uniqueNames = [...new Set(names)];
      const rows = await tx.selectFrom('product_platforms').select(['name', 'enabled'])
        .where('name', 'in', uniqueNames).orderBy('name').forUpdate().execute();
      const byName = new Map(rows.map(row => [row.name, row]));
      const success: string[] = [], skipped: string[] = [], conflicts: Array<{ id: string; reason: string }> = [];
      for (const name of uniqueNames) {
        const row = byName.get(name);
        if (!row) conflicts.push({ id: name, reason: '商品平台不存在' });
        else if (row.enabled === enabled) skipped.push(name);
        else success.push(name);
      }
      if (success.length) await tx.updateTable('product_platforms').set({ enabled }).where('name', 'in', success).execute();
      return { success, skipped, conflicts };
    });
  }

  async createStandardProduct(input: { family: string; product: string; tier: string }, platform = '', productIds: readonly bigint[] = [], confirmEvidenceConflict = false): Promise<AdminStandardProductRow> {
    const identity = normalizeIdentity(input);
    // Human-reviewed classifications may describe guides or courses, not only AI account plans.
    if (!hasValidIdentityFields(identity)) throw new DomainValidationError('STANDARD_PRODUCT_IDENTITY_INVALID', 'family、product、tier 不是有效的标准商品身份');
    const uniqueProductIds = [...new Set(productIds.map(String))].map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    if (!uniqueProductIds.length) throw new DomainValidationError('STANDARD_PRODUCT_EMPTY', '标准商品必须绑定商品');
    return this.database.transaction().execute(async tx => {
      const standardKey = buildCanonicalStandardKey(identity);
      const existing = await tx.selectFrom('standard_products').select('id').where('standard_key', '=', standardKey).where('merged_into_id', 'is', null).executeTakeFirst();
      if (existing) throw new DomainValidationError('STANDARD_PRODUCT_KEY_CONFLICT', '相同 family、product、tier 的标准商品已经存在');
      const products = await tx.selectFrom('products').select(['id', 'deleted_at', 'name', 'spec', 'source_data']).where('id', 'in', uniqueProductIds).orderBy('id').forUpdate().execute();
      if (products.length !== uniqueProductIds.length || products.some(product => product.deleted_at !== null)) throw new DomainValidationError('PRODUCT_STATE_CHANGED', '所选商品不存在或已删除');
      const conflicts = confirmEvidenceConflict ? [] : evidenceConflicts(products);
      if (conflicts.length) throw new DomainValidationError('CATALOG_PUBLICATION_BLOCKED', `${conflicts.length} 件商品的标题与描述互相矛盾，确认后可继续`, { conflicts });
      if (platform) await this.requireEnabledPlatform(tx, platform);
      const row = await tx.insertInto('standard_products').values({ name: canonicalProductDisplayName(identity), platform, sort_order: 0n, standard_key: standardKey, canonical_platform: identity.family, canonical_family: identity.family, canonical_product: identity.product, canonical_tier: identity.tier }).returning(['id', 'name', 'platform', 'sort_order', 'standard_key', 'canonical_family', 'canonical_product', 'canonical_tier', 'aliases', 'hidden', 'merged_into_id']).executeTakeFirstOrThrow();
      await recordManualDecisions(tx, uniqueProductIds, { action: 'assign', standardProductId: row.id, reason: '管理员基于所选商品建立标准商品', allowEvidenceConflict: confirmEvidenceConflict });
      await tx.deleteFrom('standard_product_members').where('product_id', 'in', uniqueProductIds).execute();
      await tx.insertInto('standard_product_members').values(uniqueProductIds.map(product_id => ({ standard_product_id: row.id, product_id, assignment_source: 'human' }))).execute();
      await bumpCatalogVersion(tx);
      return { ...row, member_count: BigInt(uniqueProductIds.length), shop_count: 0n };
    });
  }

  async listTagProducts(name: string, value: string, filter: PageRequest = {}): Promise<CursorPage<AdminTagProductRow>> {
    const page = normalizePageRequest(filter);
    let query = this.database.selectFrom('products')
      .innerJoin('product_tags', 'product_tags.product_id', 'products.id')
      .innerJoin('shops', 'shops.id', 'products.shop_id')
      .select(['products.id', 'products.shop_id', 'products.external_id', 'products.name', 'products.spec', 'products.source_category', 'products.source_data', 'products.normalized_key', 'products.url', 'products.image_url', 'products.updated_at', 'products.deleted_at', 'shops.name as shop_name',
        sql<string | null>`(select sp.name from standard_product_members m join standard_products sp on sp.id = m.standard_product_id where m.product_id = products.id limit 1)`.as('standard_product_name'),
        sql<JsonValue>`coalesce((select jsonb_agg(jsonb_build_object('name', t.name, 'value', t.value) order by t.name, t.value) from product_tags t where t.product_id = products.id), '[]'::jsonb)`.as('tags'),
        sql<string | null>`(select o.price from offers o where o.product_id = products.id order by o.captured_at desc, o.id desc limit 1)`.as('latest_price'),
        sql<string | null>`(select o.currency from offers o where o.product_id = products.id order by o.captured_at desc, o.id desc limit 1)`.as('latest_currency')])
      .where('products.deleted_at', 'is', null)
      .where('product_tags.name', '=', name)
      .where('product_tags.value', '=', value)
      .orderBy('products.id', 'asc');
    if (page.page !== undefined) {
      const rows = await query.select(sql<number>`count(*) over()`.as('_total')).offset((page.page - 1) * page.limit).limit(page.limit).execute();
      return { items: rows.map(({ _total: _total, ...row }) => row), total: Number(rows[0]?._total ?? 0), page: page.page, pageSize: page.limit };
    }
    if (page.afterId !== undefined) query = query.where('products.id', '>', page.afterId);
    return buildCursorPage(await query.limit(page.limit + 1).execute(), page.limit);
  }
  async updateStandardProduct(id: bigint, changes: { name?: string; platform?: string; canonicalFamily?: string; canonicalProduct?: string; canonicalTier?: string; aliases?: string[] }): Promise<AdminStandardProductRow | undefined> {
    const row = await this.database.transaction().execute(async tx => {
      const existing = await tx.selectFrom('standard_products').select(['id', 'name', 'platform', 'sort_order', 'standard_key', 'canonical_family', 'canonical_product', 'canonical_tier', 'aliases', 'hidden', 'merged_into_id']).where('id', '=', id).where('merged_into_id', 'is', null).forUpdate().executeTakeFirst();
      if (!existing) return undefined;
      const aliasOwnersBefore = changes.aliases === undefined ? [id] : await relatedCatalogAliasOwners(tx, [id]);
      if (changes.aliases !== undefined) {
        if (changes.aliases.length > 20 || changes.aliases.some(value => value.length > 80))
          throw new DomainValidationError('STANDARD_PRODUCT_ALIASES_INVALID', '最多 20 个搜索别名，每个不超过 80 个字符');
        changes = { ...changes, aliases: normalizeCatalogAliases(changes.aliases) };
        if (changes.aliases!.some(value => value.length > 80))
          throw new DomainValidationError('STANDARD_PRODUCT_ALIASES_INVALID', '每个搜索别名不超过 80 个字符');
      }
      if (changes.platform !== undefined && changes.platform && changes.platform !== existing.platform) await this.requireEnabledPlatform(tx, changes.platform);
      const previousIdentity = normalizeIdentity({ family: existing.canonical_family, product: existing.canonical_product, tier: existing.canonical_tier });
      const requestedIdentity = normalizeIdentity({ family: changes.canonicalFamily ?? existing.canonical_family, product: changes.canonicalProduct ?? existing.canonical_product, tier: changes.canonicalTier ?? existing.canonical_tier });
      const hasIdentityChange = requestedIdentity.family !== previousIdentity.family || requestedIdentity.product !== previousIdentity.product || requestedIdentity.tier !== previousIdentity.tier;
      const { canonicalFamily: _canonicalFamily, canonicalProduct: _canonicalProduct, canonicalTier: _canonicalTier, ...baseChanges } = changes;
      if (!hasIdentityChange) {
        if (!Object.values(baseChanges).some(value => value !== undefined)) return existing;
        const members = await tx.selectFrom('standard_product_members').select('product_id').where('standard_product_id', '=', id).orderBy('product_id').forUpdate().execute();
        const updated = await tx.updateTable('standard_products').set(baseChanges).where('id', '=', id).where('merged_into_id', 'is', null).returning(['id', 'name', 'platform', 'sort_order', 'standard_key', 'canonical_family', 'canonical_product', 'canonical_tier', 'aliases', 'hidden', 'merged_into_id']).executeTakeFirst();
        if (updated) {
          for (const member of members) await tx.updateTable('products').set({ standardization_revision: sql`standardization_revision + 1` }).where('id', '=', member.product_id).execute();
          await bumpCatalogVersion(tx);
          await recordCandidateCatalogChanges(tx, aliasOwnersBefore, IDENTITY_POLICY_VERSION);
        }
        return updated;
      }

      const family = (changes.canonicalFamily ?? existing.canonical_family ?? '').trim();
      const product = (changes.canonicalProduct ?? existing.canonical_product ?? '').trim();
      const tier = (changes.canonicalTier ?? existing.canonical_tier ?? '').trim();
      const allEmpty = !family && !product && !tier;
      if (!allEmpty && (!family || !product || !tier)) throw new DomainValidationError('STANDARD_PRODUCT_IDENTITY_INCOMPLETE', 'family、product、tier 必须同时填写');
      if (allEmpty) {
        const members = await tx.selectFrom('standard_product_members').select('product_id').where('standard_product_id', '=', id).orderBy('product_id').forUpdate().execute();
        const updated = await tx.updateTable('standard_products').set({
          ...baseChanges,
          canonical_platform: null,
          canonical_family: null,
          canonical_product: null,
          canonical_tier: null,
          standard_key: null,
        }).where('id', '=', id).where('merged_into_id', 'is', null).returning(['id', 'name', 'platform', 'sort_order', 'standard_key', 'canonical_family', 'canonical_product', 'canonical_tier', 'aliases', 'hidden', 'merged_into_id']).executeTakeFirst();
        if (updated) {
          await recordManualDecisions(tx, members.map(member => member.product_id), { action: 'identity_update', standardProductId: id, reason: '管理员清除标准商品身份，保留历史归属' });
          await bumpCatalogVersion(tx);
          await recordCandidateCatalogChanges(tx, aliasOwnersBefore, IDENTITY_POLICY_VERSION);
        }
        return updated;
      }

      const identity = normalizeIdentity({ family, product, tier });
      if (!hasValidIdentityFields(identity)) throw new DomainValidationError('STANDARD_PRODUCT_IDENTITY_INVALID', 'family、product、tier 不是有效的标准商品身份');
      const standardKey = buildCanonicalStandardKey(identity);
      const duplicate = await tx.selectFrom('standard_products').select('id')
        .where('standard_key', '=', standardKey).where('id', '!=', id).executeTakeFirst();
      if (duplicate) throw new DomainValidationError('STANDARD_PRODUCT_KEY_CONFLICT', '相同 family、product、tier 的标准商品已经存在');
      const members = await tx.selectFrom('standard_product_members').select('product_id')
        .where('standard_product_id', '=', id).orderBy('product_id').forUpdate().execute();
      await tx.updateTable('standard_products').set({
        ...baseChanges,
        name: canonicalProductDisplayName(identity),
        canonical_platform: identity.family,
        canonical_family: identity.family,
        canonical_product: identity.product,
        canonical_tier: identity.tier,
        standard_key: standardKey,
      }).where('id', '=', id).execute();
      await recordManualDecisions(tx, members.map(member => member.product_id),
        { action: 'identity_update', standardProductId: id, reason: '管理员修改标准商品身份' });
      await bumpCatalogVersion(tx);
      await recordCandidateCatalogChanges(tx, aliasOwnersBefore, IDENTITY_POLICY_VERSION);
      return tx.selectFrom('standard_products').select(['id', 'name', 'platform', 'sort_order', 'standard_key', 'canonical_family', 'canonical_product', 'canonical_tier', 'aliases', 'hidden', 'merged_into_id']).where('id', '=', id).executeTakeFirst();
    });
    if (row) return { ...row, member_count: 0n, shop_count: 0n };
    return row;
  }
  async setStandardProductVisibility(id: bigint, hidden: boolean): Promise<boolean> {
    return this.database.transaction().execute(async tx => {
      const result = await tx.updateTable('standard_products').set({ hidden }).where('id', '=', id).where('merged_into_id', 'is', null).executeTakeFirst();
      if (result.numUpdatedRows === 1n) await bumpCatalogVersion(tx);
      return result.numUpdatedRows === 1n;
    });
  }

  async setStandardProductsVisibility(ids: readonly bigint[], hidden: boolean): Promise<AdminBatchResult> {
    return this.database.transaction().execute(async tx => {
      const uniqueIds = [...new Set(ids.map(String))];
      const rows = await tx.selectFrom('standard_products').select(['id', 'hidden', 'merged_into_id'])
        .where('id', 'in', uniqueIds.map(BigInt)).orderBy('id').forUpdate().execute();
      const byId = new Map(rows.map(row => [String(row.id), row]));
      const success: string[] = [], skipped: string[] = [], conflicts: Array<{ id: string; reason: string }> = [];
      for (const id of uniqueIds) {
        const row = byId.get(id);
        if (!row) conflicts.push({ id, reason: '标准商品不存在' });
        else if (row.merged_into_id !== null) conflicts.push({ id, reason: '标准商品已合并，不能修改展示状态' });
        else if (row.hidden === hidden) skipped.push(id);
        else success.push(id);
      }
      if (success.length) {
        await tx.updateTable('standard_products').set({ hidden }).where('id', 'in', success.map(BigInt)).execute();
        await bumpCatalogVersion(tx);
      }
      return { success, skipped, conflicts };
    });
  }
  async mergeStandardProducts(sourceIds: readonly bigint[], targetId: bigint, confirmEvidenceConflict = false): Promise<AdminBatchResult> {
    const conflicts: Array<{ id: string; reason: string }> = [], success: string[] = [], skipped: string[] = [];
    await this.database.transaction().execute(async tx => {
      const uniqueSourceIds = [...new Set(sourceIds.map(String))].map(BigInt);
      const idsToLock = [...new Set([...uniqueSourceIds, targetId].map(String))].map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
      const standards = await tx.selectFrom('standard_products').select(['id', 'merged_into_id', 'aliases']).where('id', 'in', idsToLock).orderBy('id').forUpdate().execute();
      const standardsById = new Map(standards.map(standard => [standard.id.toString(), standard]));
      const mergeableSources = uniqueSourceIds.filter(sourceId => sourceId !== targetId && !standardsById.get(sourceId.toString())?.merged_into_id && standardsById.has(sourceId.toString()) && !standardsById.get(targetId.toString())?.merged_into_id && standardsById.has(targetId.toString()));
      const products = mergeableSources.length
        ? await tx.selectFrom('standard_product_members').select(['standard_product_id', 'product_id']).where('standard_product_id', 'in', mergeableSources).orderBy('product_id').forUpdate().execute()
        : [];
      const productIds = [...new Set(products.map(product => product.product_id.toString()))].map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
      const memberEvidence = new Map<string, { id: bigint; name: string; spec: string; source_data: JsonValue }>();
      for (const productId of productIds) {
        const row = await tx.selectFrom('products').select(['id', 'name', 'spec', 'source_data']).where('id', '=', productId).forUpdate().executeTakeFirst();
        if (row) memberEvidence.set(row.id.toString(), row);
      }
      for (const sourceId of uniqueSourceIds) {
        if (sourceId === targetId) { skipped.push(sourceId.toString()); continue; }
        const source = standardsById.get(sourceId.toString());
        const target = standardsById.get(targetId.toString());
        if (!source || !target || source.merged_into_id || target.merged_into_id) { conflicts.push({ id: sourceId.toString(), reason: '标准商品不存在或已合并' }); continue; }
        const sourceProducts = products.filter(product => product.standard_product_id === sourceId);
        const blocked = confirmEvidenceConflict ? [] : evidenceConflicts(sourceProducts.flatMap(product => memberEvidence.get(product.product_id.toString()) ?? []));
        if (blocked.length) { conflicts.push({ id: sourceId.toString(), reason: `发布证据冲突：${blocked.map(item => `\n  成员 #${item.id} ${item.reason.replace(/^发布证据冲突：/u, '')}`).join('')}` }); continue; }
        await recordManualDecisions(tx, sourceProducts.map(product => product.product_id), { action: 'merge', standardProductId: targetId, reason: '管理员合并标准商品归属', allowEvidenceConflict: confirmEvidenceConflict });
        await tx.updateTable('standard_product_members').set({ standard_product_id: targetId, assignment_source: 'human' }).where('standard_product_id', '=', sourceId).execute();
        await tx.updateTable('standard_products').set({ merged_into_id: targetId, hidden: true }).where('id', '=', sourceId).execute(); success.push(sourceId.toString());
      }
      if (success.length) {
        const mergedIds = new Set(success);
        const aliases = normalizeCatalogAliases([
          ...standardsById.get(targetId.toString())!.aliases,
          ...standards.filter(standard => mergedIds.has(String(standard.id))).flatMap(standard => standard.aliases),
        ]);
        await tx.updateTable('standard_products').set({ aliases }).where('id', '=', targetId).execute();
        await bumpCatalogVersion(tx);
        await recordCandidateCatalogChanges(tx, [...success.map(BigInt), targetId], IDENTITY_POLICY_VERSION);
      }
    });
    return { success, skipped, conflicts };
  }
  async deleteStandardProduct(id: bigint): Promise<boolean> { return this.setStandardProductVisibility(id, true); }
  async bindTags(productIds: readonly bigint[], name: string, value: string): Promise<AdminBatchResult> {
    const success: string[] = [], skipped: string[] = [], conflicts: Array<{ id: string; reason: string }> = [];
    await this.database.transaction().execute(async tx => {
      for (const id of [...new Set(productIds.map(String))].map(BigInt).sort((a, b) => a < b ? -1 : 1)) {
        const p = await tx.selectFrom('products').select(['id', 'deleted_at']).where('id', '=', id).forUpdate().executeTakeFirst();
        if (!p || p.deleted_at) { conflicts.push({ id: id.toString(), reason: '原始商品不存在或已删除' }); continue; }
        const r = await tx.insertInto('product_tags').values({ product_id: id, name, value }).onConflict(c => c.columns(['product_id', 'name', 'value']).doNothing()).executeTakeFirst();
        if (r.numInsertedOrUpdatedRows === 0n) skipped.push(id.toString());
        else {
          await tx.updateTable('products').set({ standardization_revision: sql`standardization_revision + 1` }).where('id', '=', id).execute();
          success.push(id.toString());
        }
      }
    });
    return { success, skipped, conflicts };
  }
  async deleteTag(name: string, value: string): Promise<boolean> {
    return this.database.transaction().execute(async tx => {
      const rows = await tx.selectFrom('product_tags').select('product_id').where('name', '=', name).where('value', '=', value).orderBy('product_id').forUpdate().execute();
      if (!rows.length) return false;
      for (const row of rows) await tx.updateTable('products').set({ standardization_revision: sql`standardization_revision + 1` }).where('id', '=', row.product_id).execute();
      await tx.deleteFrom('product_tags').where('name', '=', name).where('value', '=', value).execute();
      return true;
    });
  }
  async renameTag(name: string, value: string, nextName: string, nextValue: string): Promise<boolean> {
    if (name === nextName && value === nextValue) return true;
    return this.database.transaction().execute(async tx => {
      const rows = await tx.selectFrom('product_tags').select('product_id').where('name', '=', name).where('value', '=', value).orderBy('product_id').forUpdate().execute();
      if (!rows.length) return false;
      for (const row of rows) {
        await tx.insertInto('product_tags').values({ product_id: row.product_id, name: nextName, value: nextValue }).onConflict(c => c.columns(['product_id', 'name', 'value']).doNothing()).execute();
        await tx.updateTable('products').set({ standardization_revision: sql`standardization_revision + 1` }).where('id', '=', row.product_id).execute();
      }
      await tx.deleteFrom('product_tags').where('name', '=', name).where('value', '=', value).execute();
      return true;
    });
  }
  async mergeTags(sourceName: string, sourceValue: string, targetName: string, targetValue: string): Promise<AdminBatchResult> {
    if (sourceName === targetName && sourceValue === targetValue) return { success: [], skipped: [], conflicts: [] };
    const skipped: string[] = [], success: string[] = [];
    await this.database.transaction().execute(async tx => {
      const rows = await tx.selectFrom('product_tags').select('product_id').where('name', '=', sourceName).where('value', '=', sourceValue).orderBy('product_id').forUpdate().execute();
      for (const row of rows) {
        const inserted = await tx.insertInto('product_tags').values({ product_id: row.product_id, name: targetName, value: targetValue }).onConflict(c => c.columns(['product_id', 'name', 'value']).doNothing()).executeTakeFirst();
        (inserted.numInsertedOrUpdatedRows === 0n ? skipped : success).push(row.product_id.toString());
        await tx.updateTable('products').set({ standardization_revision: sql`standardization_revision + 1` }).where('id', '=', row.product_id).execute();
      }
      await tx.deleteFrom('product_tags').where('name', '=', sourceName).where('value', '=', sourceValue).execute();
    });
    return { success, skipped, conflicts: [] };
  }

  async bindProducts(productIds: readonly bigint[], standardProductId: bigint, confirmOwnershipChange: boolean, confirmEvidenceConflict = false): Promise<AdminBatchResult> {
    const success: string[] = [], skipped: string[] = [], conflicts: Array<{ id: string; reason: string }> = [];
    let notice: string | undefined;
    await this.database.transaction().execute(async tx => {
      const approvedIds: bigint[] = [];
      const target = await tx.selectFrom('standard_products').select(['id', 'merged_into_id', 'verification_state']).where('id', '=', standardProductId).forUpdate().executeTakeFirst();
      if (!target || target.merged_into_id) throw new DomainValidationError('STANDARD_PRODUCT_NOT_FOUND', '目标标准商品不存在或已合并');
      if (target.verification_state !== 'verified') notice = '目标标准商品未通过身份验证或已隔离，绑定后不会在前台展示';
      for (const id of [...new Set(productIds.map(String))].map(BigInt).sort((a, b) => a < b ? -1 : 1)) {
        const product = await tx.selectFrom('products').select(['id', 'deleted_at', 'name', 'spec', 'source_data']).where('id', '=', id).forUpdate().executeTakeFirst();
        if (!product || product.deleted_at) { conflicts.push({ id: id.toString(), reason: '原始商品不存在或已删除' }); continue; }
        const membership = await tx.selectFrom('standard_product_members').select('standard_product_id').where('product_id', '=', id).forUpdate().executeTakeFirst();
        if (membership?.standard_product_id === standardProductId) { skipped.push(id.toString()); continue; }
        if (membership && !confirmOwnershipChange) { conflicts.push({ id: id.toString(), reason: `当前属于标准商品 ${membership.standard_product_id}` }); continue; }
        // Contradictory shop text is reported per item; an admin may confirm the binding after reading it.
        const evidenceConflict = confirmEvidenceConflict ? null : publicationEvidenceConflict({ name: product.name, spec: product.spec, sourceData: product.source_data });
        if (evidenceConflict) { conflicts.push({ id: id.toString(), reason: `发布证据冲突：${evidenceConflict}` }); continue; }
        approvedIds.push(id);
      }
      if (approvedIds.length) {
        await recordManualDecisions(tx, approvedIds, { action: 'assign', standardProductId, reason: '管理员批量审核商品归属', allowEvidenceConflict: confirmEvidenceConflict });
        await tx.deleteFrom('standard_product_members').where('product_id', 'in', approvedIds).execute();
        await tx.insertInto('standard_product_members').values(approvedIds.map(product_id => ({ standard_product_id: standardProductId, product_id, assignment_source: 'human' }))).execute();
        success.push(...approvedIds.map(String));
        await bumpCatalogVersion(tx);
      }
    });
    return { success, skipped, conflicts, ...(notice ? { notice } : {}) };
  }

  private async requireEnabledPlatform(tx: Transaction<DatabaseSchema>, name: string): Promise<void> {
    const platform = await tx.selectFrom('product_platforms').select('enabled').where('name', '=', name).executeTakeFirst();
    if (!platform?.enabled) throw new DomainValidationError('PLATFORM_DISABLED', '平台不存在或已停用');
  }

  private async platformByName(name: string): Promise<AdminPlatformRow> {
    const row = await this.database.selectFrom('product_platforms').select(['name', 'enabled']).where('name', '=', name).executeTakeFirstOrThrow();
    const count = await this.database.selectFrom('standard_products').select(({ fn }) => fn.countAll<number>().as('count')).where('platform', '=', name).executeTakeFirstOrThrow();
    return { id: row.name, name: row.name, enabled: row.enabled, standard_product_count: BigInt(Number(count.count)) };
  }
}

function containsPattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}

interface TagCursorPayload {
  readonly v: 2;
  readonly name: string;
  readonly value: string;
  readonly id: string;
}

function encodeTagCursor(row: Pick<AdminTagRow, 'id' | 'name' | 'value'>): string {
  const payload: TagCursorPayload = { v: 2, name: row.name, value: row.value, id: row.id.toString() };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeTagCursor(cursor: string): { name: string; value: string; id: bigint } {
  try {
    const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<TagCursorPayload>;
    if (
      payload.v !== 2 ||
      typeof payload.name !== 'string' || payload.name.length === 0 ||
      typeof payload.value !== 'string' || payload.value.length === 0 ||
      typeof payload.id !== 'string' || !/^[1-9]\d*$/.test(payload.id)
    ) {
      throw new Error('invalid tag cursor payload');
    }
    return { name: payload.name, value: payload.value, id: BigInt(payload.id) };
  } catch {
    throw new DomainValidationError('INVALID_CURSOR', '分页游标无效');
  }
}

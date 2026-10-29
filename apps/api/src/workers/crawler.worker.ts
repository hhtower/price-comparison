import 'reflect-metadata';
import '../config/env.js';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { AppModule } from '../app.module.js';
import { JobsRepository } from '../jobs/jobs.repository.js';
import type { ClaimedJob } from '../jobs/jobs.repository.js';
import { WorkerRuntime, type WorkerRuntimeOptions, type WorkerRuntimeService } from './worker-runtime.js';
import { MetricsService } from '../observability/metrics.js';
import { StructuredLogger } from '../observability/request-context.js';
import { platformForUrl, FX_URL, latestCnyPerUsd } from '../platforms/index.js';
import type { SettlementResult } from '../platforms/index.js';
import { buildRatingManifest } from '../platforms/source-evidence.js';
import { ProductsRepository } from '../products/products.repository.js';
import { lockProductRowNames, softDeleteProductNames } from '../products/product-name-deletion.js';
import type { Kysely, Transaction } from 'kysely';
import type { DatabaseSchema } from '../database/types.js';
import { jsonb } from '../database/types.js';
import { sql } from 'kysely';
import { DATABASE } from '../database/database.providers.js';
import { normalizeProductEvidence } from '../standardization/fingerprint.js';
import { jitteredIntervalMs } from '../crawler/jitter.js';
import { DEFAULT_CRAWLER_TARGET_INTERVAL_MS, readCrawlerConfig } from '../config/env.js';
import { createSharedHostRateLimiter } from '../crawler/rate-limiter.js';
import { ProxyPool } from '../crawler/proxy-pool.js';
import { createRunFetchFactory, mergeDefaultHeaders } from '../crawler/fetch-client.js';
import { startCrawlerMetricsPublisher } from '../crawler/metrics-store.js';
import { CRAWLER_METRICS_REDIS, type CrawlerRedisClient } from '../crawler/crawler-redis.module.js';
import { FetchSchedulerWorker } from './fetch-scheduler.worker.js';
import { ShopsRepository, type Shop } from '../shops/shops.repository.js';
import { createQualityFetch } from '../quality/quality-network.js';
import { boundedResponse } from '../crawler/response-body.js';
import { defaultQuotePolicy } from '../catalog/quote-policy.js';
import { needsSettlementRefresh } from '../crawler/settlement-cache.js';
import { CrawlRunMetrics } from '../crawler/run-metrics.js';
import type { CrawlerRequestEvent } from '../crawler/fetch-client.js';
import { crawlClaim, enqueueSettlementRetry, runSettlementRetry, settlementReport, settlementError as describeSettlementError } from '../crawler/settlement-retry.js';
import { enqueueDueSettlements } from '../crawler/settlement-scheduler.js';
import { mergeShopObservation, type ShopObservation } from '../shops/shop-rating.js';

type WorkerFactoryOptions = Omit<Partial<WorkerRuntimeOptions>, 'service' | 'kind'>;

export function createCrawlerWorker(service: WorkerRuntimeService, options: WorkerFactoryOptions = {}): WorkerRuntime {
  return new WorkerRuntime({
    service,
    kind: 'fetch_run',
    workerId: options.workerId ?? `crawler-${randomUUID()}`,
    handler: options.handler ?? failClosedHandler,
    ...options,
  });
}

export function failClosedHandler(): Promise<void> {
  return Promise.reject(new Error('worker handler is not configured'));
}

export interface CrawlerHandlerDeps {
  readonly publicFetchFactory?: typeof createQualityFetch;
  readonly publicProxyUrl?: string;
  readonly shops?: Pick<ShopsRepository, 'markFetchSucceeded' | 'markFetchFailed'>;
  readonly targetIntervalMs?: number;
  readonly minIntervalMs?: number;
  /** 自建独立站出口；未配置时回退 publicProxyUrl。 */
  readonly selfHostedProxyUrl?: string;
  readonly fetchFactory?: (signal: AbortSignal, observe?: (event: CrawlerRequestEvent) => void) => (url: any, options?: any) => Promise<Response>;
}

export function createCrawlerHandler(database: Kysely<DatabaseSchema>, products: ProductsRepository, deps: CrawlerHandlerDeps = {}) {
  const shops = deps.shops ?? new ShopsRepository(database);
  return async (job: ClaimedJob, signal: AbortSignal = new AbortController().signal): Promise<void> => {
    signal.throwIfAborted();
    const startedAt = performance.now();
    const metrics = new CrawlRunMetrics(job.row.crawl_metrics,
      job.row.task_type === 'settlement' && job.row.source_fetch_run_id != null);
    const initialTotal = metrics.data.durations.total;
    const isSettlement = job.row.task_type === 'settlement';
    const shopId = BigInt(job.row.shop_id as string | bigint);
    let fetchImpl = deps.fetchFactory
      ? deps.fetchFactory(signal, metrics.observe)
      : (url: any, options: any) => fetch(url, { ...options, signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal, headers: mergeDefaultHeaders(options?.headers, url) });
    let observedShop: Shop | undefined;
    let publicClient: Awaited<ReturnType<typeof createQualityFetch>> | undefined;
    let snapshotPersisted = false;
    let listFinished = false;
    let listStarted = performance.now();
    let settlementStarted: number | undefined;
    let transactionStarted: number | undefined;
    const transactionBefore = metrics.data.durations.transaction;
    try {
      const shop = await database.selectFrom('shops').selectAll().where('id', '=', shopId).executeTakeFirst();
      observedShop = shop;
      if (!shop || !shop.enabled || shop.deleted_at) throw new Error('shop is unavailable');
      const adapter = platformForUrl(shop.url, shop.protocol);
      if (!['liandong', '16688'].includes(adapter.id) || !adapter.hosts.includes(new URL(shop.url).hostname)) {
        // Custom storefronts must resolve to public addresses on every connection.
        publicClient = await (deps.publicFetchFactory ?? createQualityFetch)(undefined, {
          fetchImpl: fetchImpl as typeof fetch, signal, serverProxyUrl: deps.selfHostedProxyUrl ?? deps.publicProxyUrl,
          reuseConnections: false, proxyDns: deps.selfHostedProxyUrl !== undefined,
        });
        const client = publicClient;
        fetchImpl = async (url, options = {}) => {
          if (new URL(url).origin !== new URL(shop.url).origin && !(adapter.id === 'prism' && String(url) === FX_URL)) throw new Error('crawler endpoint escaped shop origin');
          // The shared transport bounds the actual network/body operation after admission.
          if (deps.fetchFactory) return client.fetch(url, { ...options, signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal });
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(new Error('crawler request timed out')), 30_000);
          const combined = AbortSignal.any([signal, controller.signal]);
          try { return await boundedResponse(await client.fetch(url, { ...options, signal: combined }), combined); }
          finally { clearTimeout(timeout); }
        };
      }
      if (isSettlement) {
        const failure = await runSettlementRetry(database, job, shop, adapter, fetchImpl as typeof fetch, signal, metrics, startedAt);
        snapshotPersisted = true;
        if (failure) throw new Error(failure);
        return;
      }
      const previousProducts = await database.selectFrom('products as p')
        .leftJoin('standard_product_members as m', 'm.product_id', 'p.id')
        .leftJoin('standard_products as sp', 'sp.id', 'm.standard_product_id')
        .leftJoin('offers as o', 'o.product_id', 'p.id')
        .distinctOn('p.external_id')
        .select(['p.external_id', 'p.name', 'p.spec', 'p.source_category', 'p.source_data',
          'o.price', 'o.is_stale', 'o.settlement_price', 'o.settlement_verified_at', 'o.settlement_payment_method',
          'o.settlement_quantity', 'o.settlement_total_amount',
          sql<boolean>`coalesce(m.publication_state = 'published' and sp.verification_state = 'verified'
            and not sp.hidden and sp.merged_into_id is null, false)`.as('eligible')])
        .where('p.shop_id', '=', shopId).where('p.deleted_at', 'is', null)
        .orderBy('p.external_id').orderBy('o.captured_at', 'desc').orderBy('o.id', 'desc').execute();
      const previousById = new Map(previousProducts.map(product => [product.external_id, product]));
      const { ttlMs, now } = defaultQuotePolicy();
      const needsSettlement = (item: import('../platforms/index.js').CrawlProduct, quantity: number): boolean =>
        needsSettlementRefresh(item, previousById.get(String(item.externalId)), now(), ttlMs, quantity);
      const outcomes = new Map<string, SettlementResult>();
      let shopObservation: ShopObservation | undefined;
      listStarted = performance.now();
      const completeList = await adapter.crawl(undefined, shop, fetchImpl, {
        signal,
        onShopObservation: observation => { shopObservation = observation; },
        // prism: the crawler egress cannot reach the FX feed; reuse the official-reference snapshot.
        ...(adapter.id === 'prism' ? { cnyPerUsd: await latestCnyPerUsd(database) } : {}),
        maxSettlementProducts: 5,
        settlementProductIds: new Set(previousProducts.filter(product => product.eligible).map(product => product.external_id)),
        needsSettlement,
        onSettlementResult: result => { outcomes.set(result.externalId, result); },
        onListComplete: () => {
          listFinished = true;
          metrics.data.durations.list += Math.round(performance.now() - listStarted);
          settlementStarted = performance.now();
        },
        onListStats: stats => { metrics.data.list = stats; },
      });
      const manifest = buildRatingManifest(shop, adapter.id, completeList, Date.now());
      const crawled = completeList.filter(item => outcomes.get(String(item.externalId))?.reason !== 'product_unavailable');
      if (settlementStarted !== undefined) {
        metrics.data.durations.settlement += Math.round(performance.now() - settlementStarted);
        settlementStarted = undefined;
      }
      else metrics.data.durations.list += Math.round(performance.now() - listStarted);
      listFinished = true;
      signal.throwIfAborted();
      const report = settlementReport(outcomes.values());
      const settlementError = describeSettlementError(report);
      const inputs = crawled.map(item => ({ shopId, externalId: String(item.externalId), name: String(item.name), sourceName: item.sourceName ?? item.name,
        description: item.description ?? '', spec: String(item.spec ?? ''), sourceCategory: String(item.sourceCategory ?? ''),
        sourceData: { ...item.sourceData, ...(item.ratingText ? { ratingText: item.ratingText } : {}) },
        normalizedKey: String(item.name).trim().toLowerCase(), url: String(item.url), imageUrl: item.imageUrl ?? undefined, price: String(item.price), stockAvailable: item.inStock }));
      transactionStarted = performance.now();
      await database.transaction().execute(async (transaction) => {
        await assertCurrentCrawl(transaction, job, shop);
        const shopProducts = await transaction.selectFrom('products').select('id').where('shop_id', '=', shopId).execute();
        await lockProductRowNames(transaction, shopProducts.map(row => row.id), inputs.map(row => row.name));
        const changes = await products.upsertFetchedProducts(transaction, inputs);
        // Rating evidence is stored separately from goods normalization, under the same locks and transaction fence.
        const captured = crawled.filter(item => item.ratingText);
        for (let start = 0; start < captured.length; start += 500) {
          const values = captured.slice(start, start + 500).map(item => sql`(
            ${changes.productIds.get(`${shopId}:${item.externalId}`)!}::bigint,
            ${JSON.stringify(item.ratingText)}::jsonb
          )`);
          await sql`update products as p set source_data = jsonb_set(p.source_data, '{ratingText}', v.evidence)
            from (values ${sql.join(values)}) as v(id, evidence)
            where p.id = v.id and p.source_data -> 'ratingText' is distinct from v.evidence`.execute(transaction);
        }
        const offersInput = crawled.map(item => ({
          idempotencyKey: `${shopId}:${item.externalId}`,
          productId: changes.productIds.get(`${shopId}:${item.externalId}`)!,
          price: String(item.price).replace(/,/g, ''),
          capturedAt: new Date(),
          stockAvailable: item.inStock,
          settlementPrice: item.settlement?.price ?? null,
          settlementVerifiedAt: item.settlement?.verifiedAt ?? null,
          settlementPaymentMethod: item.settlement?.paymentMethod ?? null,
          settlementQuantity: item.settlement?.quantity ?? null,
          settlementTotalAmount: item.settlement?.totalAmount ?? null,
          settlementRefreshAt: item.settlement ? new Date(Date.parse(item.settlement.verifiedAt) + ttlMs)
            : ['deferred', 'recently_verified', 'not_selected'].includes(outcomes.get(String(item.externalId))?.reason ?? '')
              ? needsSettlementRefresh(item, previousById.get(String(item.externalId)), now(), ttlMs,
                adapter.purchaseQuantity?.(item) ?? 1) ? new Date()
                : new Date(previousById.get(String(item.externalId))!.settlement_verified_at!.getTime() + ttlMs)
              : null,
          preserveSettlement: (previousById.get(String(item.externalId))?.settlement_quantity ?? 1)
              === (adapter.purchaseQuantity ? adapter.purchaseQuantity(item) : 1)
            && (outcomes.get(String(item.externalId))?.retryable === true
              || ['recently_verified', 'not_selected', 'deferred'].includes(outcomes.get(String(item.externalId))?.reason ?? '')),
        }));
        await insertOffersInTransaction(transaction, shopId, offersInput);
        // Only a successful complete snapshot can retire missing listings; stock does not affect presence.
        const presentProductIds = [...changes.productIds.values()].map(String);
        const missing = await transaction.selectFrom('products').select('id')
          .where('shop_id', '=', shopId).where('deleted_at', 'is', null)
          .where(sql<boolean>`products.id <> all(${presentProductIds}::bigint[])`).execute();
        await softDeleteProductNames(transaction, missing.map(row => row.id), 'crawler_missing');
        const changed = changes.changedProducts.length ? await transaction.selectFrom('products')
          .select(['id', 'shop_id', 'content_version', 'content_fingerprint', 'source_name', 'source_description', 'name', 'spec', 'source_category', 'source_data'])
          .where('id', 'in', changes.changedProducts).where('deleted_at', 'is', null).execute() : [];
        for (let start = 0; start < changed.length; start += 500) {
          const events = await transaction.insertInto('product_change_events').values(changed.slice(start, start + 500).map(product => ({
            source_fetch_run_id: job.id,
            product_id: product.id,
            shop_id: product.shop_id,
            content_version: product.content_version,
            fingerprint: product.content_fingerprint,
            event_type: product.content_version === 1n ? 'created' : 'evidence_changed',
            payload: JSON.stringify({ sourceName: product.source_name, description: product.source_description,
              ...normalizeProductEvidence({ name: product.name, spec: product.spec, sourceCategory: product.source_category, sourceData: product.source_data }) }) as never,
          }))).returning(['id', 'product_id', 'fingerprint']).execute();
          await transaction.insertInto('standardization_outbox').values(events.map(event => ({ product_id: event.product_id, event_id: event.id, fingerprint: event.fingerprint, status: 'queued' }))).onConflict(c => c.doNothing()).execute();
        }
        await enqueueSettlementRetry(transaction, job, shop, [...outcomes.values()]
          // 仅入队可重试失败;no_payment_channel/invalid_quote 等永久原因随下轮列表自然重试,不再烧限额
          .filter(outcome => outcome.status === 'failed' && outcome.retryable)
          .map(outcome => changes.productIds.get(`${shopId}:${outcome.externalId}`)!).filter(Boolean));
        await transaction.updateTable('shops').set({
          rating_manifest: jsonb(manifest),
          ...(shopObservation ? { shop_rating: jsonb(mergeShopObservation(shop.shop_rating, shop, shopObservation, Date.now())) } : {}),
        }).where('id', '=', shopId).execute();
        await shops.markFetchSucceeded(shopId, jitteredIntervalMs(deps.targetIntervalMs ?? DEFAULT_CRAWLER_TARGET_INTERVAL_MS, deps.minIntervalMs), transaction);
        signal.throwIfAborted();
        metrics.data.listSucceeded++;
        metrics.data.durations.transaction = transactionBefore + Math.round(performance.now() - transactionStarted!);
        metrics.data.durations.total = initialTotal + Math.round(performance.now() - startedAt);
        const completed = await transaction.updateTable('fetch_runs').set({
          item_count: BigInt(crawled.length), settlement_report: jsonb(report), error: settlementError, crawl_metrics: jsonb(metrics.data),
          status: 'succeeded', finished_at: sql<Date>`now()`, claimed_by: null, claim_token: null, lease_until: null,
        })
          .where(crawlClaim(job)).executeTakeFirst();
        if (completed.numUpdatedRows !== 1n) throw new Error('crawler lease expired before commit');
        signal.throwIfAborted();
      });
      snapshotPersisted = true;
    } catch (error) {
      if (!snapshotPersisted) {
        if (settlementStarted !== undefined) metrics.data.durations.settlement += Math.round(performance.now() - settlementStarted);
        if (!isSettlement) {
          metrics.data.listSucceeded = Number((job.row.crawl_metrics as any)?.listSucceeded ?? 0);
          metrics.data.listFailed++;
          if (!listFinished) metrics.data.durations.list += Math.round(performance.now() - listStarted);
        }
        if (/lease|claim.*expired/i.test(error instanceof Error ? error.message : String(error))) metrics.data.leaseFailures++;
        if (transactionStarted !== undefined) metrics.data.durations.transaction = transactionBefore + Math.round(performance.now() - transactionStarted);
        metrics.data.durations.total = initialTotal + Math.round(performance.now() - startedAt);
        // Diagnostics may be saved after expiry, but never after a replacement owns the row.
        await database.updateTable('fetch_runs').set({ crawl_metrics: jsonb(metrics.data) }).where(crawlClaim(job, false)).execute().catch(() => {});
      }
      const shop = observedShop;
      if (shop && !isSettlement && !signal.aborted && !snapshotPersisted) {
        await database.transaction().execute(async transaction => {
          // An obsolete run must never hide quotes from a replacement or a changed source.
          try { await assertCurrentCrawl(transaction, job, shop); } catch { return; }
          signal.throwIfAborted();
          await shops.markFetchFailed(shopId, error instanceof Error ? error.message : String(error), undefined, undefined, transaction);
          // Publish the outcome before WorkerRuntime decides whether this run is retried.
          // The final lease predicate also rolls back health/cache writes after a lock wait.
          const recorded = await transaction.updateTable('fetch_runs').set({ error: error instanceof Error ? error.message : String(error) })
            .where(crawlClaim(job)).executeTakeFirst();
          if (recorded.numUpdatedRows !== 1n) throw new Error('crawler lease expired before failure commit');
          signal.throwIfAborted();
        }).catch(() => {});
      }
      throw error;
    } finally {
      await publicClient?.close();
    }
  };
}

async function assertCurrentCrawl(transaction: Transaction<DatabaseSchema>, job: ClaimedJob, shop: Shop): Promise<void> {
  const currentShop = await transaction.selectFrom('shops').select(['id', 'url', 'platform', 'protocol']).where('id', '=', shop.id)
    .where('enabled', '=', true).where('deleted_at', 'is', null).forNoKeyUpdate().executeTakeFirst();
  if (!currentShop) throw new Error('shop is unavailable');
  if (currentShop.url !== shop.url || currentShop.platform !== shop.platform || currentShop.protocol !== shop.protocol) throw new Error('shop source changed during crawl');
  const owned = await transaction.selectFrom('fetch_runs').select('id').where('id', '=', job.id)
    .where('shop_id', '=', shop.id).where('status', '=', 'running').where('claimed_by', '=', job.claimed_by).where('attempts', '=', job.attempts)
    .where('claim_token', '=', String(job.row.claim_token)).where('lease_until', '>', sql<Date>`clock_timestamp()`)
    .executeTakeFirst();
  if (!owned) throw new Error('crawler claim or lease expired');
  const newer = await transaction.selectFrom('fetch_runs').select('id').where('shop_id', '=', shop.id)
    .where('task_type', '=', 'list')
    .where('id', '>', job.id).where(eb => eb.or([eb('status', '=', 'succeeded'), eb('error', 'is not', null)])).executeTakeFirst();
  if (newer) throw new Error('crawler snapshot superseded by a newer run');
}

async function insertOffersInTransaction(transaction: Kysely<DatabaseSchema>, shopId: bigint, input: readonly {
  idempotencyKey: string; productId: bigint; price: string; capturedAt: Date; stockAvailable: boolean;
  settlementPrice: string | null; settlementVerifiedAt: string | null; settlementPaymentMethod: string | null;
  settlementQuantity: number | null; settlementTotalAmount: string | null;
  settlementRefreshAt: Date | null;
  preserveSettlement: boolean;
}[]): Promise<void> {
  const keys = input.map((offer) => offer.idempotencyKey);
  const preservedIds = input.filter(offer => offer.preserveSettlement).map(offer => String(offer.productId));
  const preserve = sql<boolean>`offers.product_id = any(${preservedIds}::bigint[]) and offers.price = excluded.price and offers.stock_available and excluded.stock_available and not offers.is_stale`;
  if (input.length) await transaction.insertInto('offers').values(input.map((offer, index) => ({
    idempotency_key: keys[index]!, product_id: offer.productId, price: offer.price,
    currency: 'CNY', captured_at: offer.capturedAt, is_stale: false,
    stock_available: offer.stockAvailable === true,
    settlement_price: offer.settlementPrice,
    settlement_verified_at: offer.settlementVerifiedAt,
    settlement_payment_method: offer.settlementPaymentMethod,
    settlement_quantity: offer.settlementQuantity,
    settlement_total_amount: offer.settlementTotalAmount,
    settlement_refresh_at: offer.settlementRefreshAt,
  }))).onConflict((conflict) => conflict.column('idempotency_key').doUpdateSet(({ ref }) => ({
    price: ref('excluded.price'), captured_at: ref('excluded.captured_at'), is_stale: false,
    stock_available: ref('excluded.stock_available'),
    settlement_price: sql`case when ${preserve} and excluded.settlement_price is null then offers.settlement_price else excluded.settlement_price end`,
    settlement_verified_at: sql`case when ${preserve} and excluded.settlement_price is null then offers.settlement_verified_at else excluded.settlement_verified_at end`,
    settlement_payment_method: sql`case when ${preserve} and excluded.settlement_price is null then offers.settlement_payment_method else excluded.settlement_payment_method end`,
    settlement_quantity: sql`case when ${preserve} and excluded.settlement_price is null then offers.settlement_quantity else excluded.settlement_quantity end`,
    settlement_total_amount: sql`case when ${preserve} and excluded.settlement_price is null then offers.settlement_total_amount else excluded.settlement_total_amount end`,
    settlement_refresh_at: ref('excluded.settlement_refresh_at'),
  }))).execute();
  await transaction.updateTable('offers').set({ is_stale: true })
    .where('product_id', 'in', transaction.selectFrom('products').select('id').where('shop_id', '=', shopId))
    .$if(keys.length > 0, query => query.where('idempotency_key', 'not in', keys))
    .where('is_stale', '=', false).execute();
}

async function main(): Promise<void> {
  const context = await NestFactory.createApplicationContext(AppModule);
  const config = readCrawlerConfig();
  const metrics = context.get(MetricsService);
  const logger = context.get(StructuredLogger);
  const redis = context.get<CrawlerRedisClient | undefined>(CRAWLER_METRICS_REDIS, { strict: false });
  const limiter = createSharedHostRateLimiter(config.hostMinIntervalMs, redis);
  const pool = new ProxyPool(config.proxies, {
    onEvent: event => logger.warn('crawler.proxy_health', event),
  });
  const fetchFactory = createRunFetchFactory({ limiter, pool, metrics, logger, publicProxyUrl: config.proxies[0] });
  const worker = createCrawlerWorker(context.get(JobsRepository), {
    handler: createCrawlerHandler(context.get(DATABASE), context.get(ProductsRepository), {
      shops: context.get(ShopsRepository),
      targetIntervalMs: config.targetIntervalMs,
      minIntervalMs: config.minIntervalMs,
      fetchFactory,
      publicProxyUrl: config.proxies[0],
      selfHostedProxyUrl: config.selfHostedProxyUrl,
    }),
    logger,
    metrics,
    concurrency: config.concurrency,
  });
  const scheduler = new FetchSchedulerWorker(context.get(ShopsRepository), `fetch-scheduler-${worker.workerId}`, logger,
    () => enqueueDueSettlements(context.get(DATABASE)));
  const publisher = startCrawlerMetricsPublisher({
    metrics,
    redis,
    workerId: worker.workerId,
    proxyPool: pool,
  });
  const controller = new AbortController();
  void scheduler.start(controller.signal).catch(error => logger.error('fetch_scheduler.crashed', error));
  logger.log?.('crawler.started', { proxies: config.proxies.length, concurrency: config.concurrency, hostConcurrency: config.hostConcurrency });
  const shutdown = async () => {
    controller.abort();
    publisher.stop();
    await worker.stop();
    await context.close();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  worker.start();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) void main();

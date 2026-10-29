import { sql, type Kysely, type Transaction } from 'kysely';
import { jsonb, type DatabaseSchema } from '../database/types.js';
import type { ClaimedJob } from '../jobs/jobs.repository.js';
import { latestCnyPerUsd } from '../platforms/index.js';
import type { CrawlProduct, PlatformAdapter, SettlementResult } from '../platforms/index.js';
import type { Shop } from '../shops/shops.repository.js';
import { bumpCatalogVersion } from '../catalog/catalog-version.repository.js';
import type { CrawlRunMetrics } from './run-metrics.js';
import { defaultQuotePolicy } from '../catalog/quote-policy.js';
import { lockProductRowNames, softDeleteProductNames } from '../products/product-name-deletion.js';

export function settlementBatchSize(protocol: string): number {
  // Large SaaS catalogs otherwise need dozens of queue turns before every price can be checked.
  return ['liandong', '16688'].includes(protocol) ? 100 : 10;
}

export function settlementPayload(shop: Shop, rows: readonly {
  id: bigint; content_version: bigint; content_fingerprint: string;
  price: string; captured_at: Date; settlement_verified_at: Date | null;
}[]): RetryPayload {
  return {
    source: { url: shop.url, platform: shop.platform, protocol: shop.protocol },
    products: rows.map(row => ({ productId: String(row.id), contentVersion: String(row.content_version), fingerprint: row.content_fingerprint,
      price: row.price, capturedAt: row.captured_at.toISOString(), verifiedAt: row.settlement_verified_at?.toISOString() ?? null })),
  };
}

type RetryProduct = {
  productId: string; contentVersion: string; fingerprint: string;
  price: string; capturedAt: string; verifiedAt: string | null;
}
type RetryPayload = {
  source: { url: string; platform: string; protocol: string | null };
  products: RetryProduct[];
}

/** Final fenced write acquires the task lock only after product work; heartbeats stay free. */
export function crawlClaim(job: ClaimedJob, live = true) {
  return sql<boolean>`id = ${job.id} and status = 'running' and claimed_by = ${job.claimed_by}
    and attempts = ${job.attempts} and claim_token = ${String(job.row.claim_token)}
    ${live ? sql`and lease_until > clock_timestamp()` : sql``}`;
}

export function settlementReport(outcomes: Iterable<SettlementResult>, listStatus = 'succeeded') {
  const report = {
    listStatus, verified: 0, failed: 0, skipped: 0, retryable: 0,
    reasons: {} as Record<string, number>, issues: [] as Array<{ externalId: string; reason: string }>,
    terminalReasons: {} as Record<string, number>,
  };
  for (const outcome of outcomes) {
    report[outcome.status]++;
    if (outcome.retryable) report.retryable++;
    if (outcome.reason) {
      report.reasons[outcome.reason] = (report.reasons[outcome.reason] ?? 0) + 1;
      if (report.issues.length < 20 && !['not_selected', 'out_of_stock', 'recently_verified'].includes(outcome.reason)) {
        report.issues.push({ externalId: outcome.externalId, reason: outcome.reason });
      }
    }
  }
  return report;
}

export function settlementError(report: ReturnType<typeof settlementReport>): string | null {
  return report.failed ? `settlement ${report.retryable ? 'network ' : ''}failure: ${report.failed} failed; ${JSON.stringify(report.reasons)}` : null;
}

export async function enqueueSettlementRetry(
  tx: Transaction<DatabaseSchema>, job: ClaimedJob, shop: Shop, failedIds: readonly bigint[],
): Promise<void> {
  // A new complete snapshot supersedes any outstanding supplement of the previous one.
  await tx.updateTable('fetch_runs').set({ status: 'cancelled', finished_at: sql`now()`, claimed_by: null, claim_token: null, lease_until: null })
    .where('shop_id', '=', shop.id).where('task_type', '=', 'settlement').where('status', 'in', ['queued', 'running']).execute();
  if (!failedIds.length) return;
  const rows = await tx.selectFrom('products as p').innerJoin('offers as o', 'o.product_id', 'p.id')
    .select(['p.id', 'p.content_version', 'p.content_fingerprint', 'o.price', 'o.captured_at', 'o.settlement_verified_at'])
    .where('p.id', 'in', failedIds).where('p.deleted_at', 'is', null).where('o.is_stale', '=', false)
    .where('o.stock_available', '=', true).distinctOn('p.id').orderBy('p.id').orderBy('o.captured_at', 'desc').orderBy('o.id', 'desc').execute();
  if (!rows.length) return;
  const payload = settlementPayload(shop, rows);
  await tx.insertInto('fetch_runs').values({
    shop_id: shop.id, task_type: 'settlement', source_fetch_run_id: job.id,
    status: 'queued', started_at: new Date(), error: null, settlement_payload: jsonb(payload),
    available_at: sql`now() + interval '5 seconds'`,
  }).execute();
}

function sourceMatches(shop: Shop, payload: RetryPayload): boolean {
  return shop.url === payload.source.url && shop.platform === payload.source.platform && shop.protocol === payload.source.protocol;
}

async function retryCandidates(db: Kysely<DatabaseSchema>, shop: Shop, payload: RetryPayload, requirePublished = true) {
  if (!payload.products.length || !sourceMatches(shop, payload)) return [];
  const rows = await db.selectFrom('products as p').innerJoin('offers as o', 'o.product_id', 'p.id')
    .select(['p.id', 'p.external_id', 'p.content_version', 'p.content_fingerprint', 'p.name', 'p.spec', 'p.source_category', 'p.source_data', 'p.url',
      'o.id as offer_id', 'o.price', 'o.captured_at', 'o.settlement_verified_at'])
    .where('p.shop_id', '=', shop.id).where('p.id', 'in', payload.products.map(item => BigInt(item.productId)))
    .where('p.deleted_at', 'is', null).where('o.is_stale', '=', false).where('o.stock_available', '=', true)
    .where('o.captured_at', '>', new Date(Date.now() - defaultQuotePolicy().ttlMs))
    .$if(requirePublished, query => query.where(sql<boolean>`exists (select 1 from standard_product_members m join standard_products sp on sp.id = m.standard_product_id
      where m.product_id = p.id and m.publication_state = 'published' and sp.verification_state = 'verified'
        and not sp.hidden and sp.merged_into_id is null)`))
    .distinctOn('p.id').orderBy('p.id').orderBy('o.captured_at', 'desc').orderBy('o.id', 'desc').execute();
  const baselines = new Map(payload.products.map(row => [row.productId, row]));
  return rows.filter(row => {
    const baseline = baselines.get(String(row.id))!;
    return String(row.content_version) === baseline.contentVersion && row.content_fingerprint === baseline.fingerprint
      && row.price === baseline.price && row.captured_at.toISOString() === baseline.capturedAt
      && (row.settlement_verified_at?.toISOString() ?? null) === baseline.verifiedAt;
  });
}

/** Commit recovered prices and shrink the payload before WorkerRuntime retries the remainder. */
export async function runSettlementRetry(
  db: Kysely<DatabaseSchema>, job: ClaimedJob, shop: Shop, adapter: PlatformAdapter,
  fetchImpl: typeof fetch, signal: AbortSignal, metrics: CrawlRunMetrics, startedAt: number,
): Promise<string | null> {
  const payload = job.row.settlement_payload as RetryPayload;
  if (!payload?.source || !Array.isArray(payload.products)) throw new Error('invalid settlement retry payload');
  const candidates = await retryCandidates(db, shop, payload);
  const products: CrawlProduct[] = candidates.map(row => ({
    externalId: row.external_id, name: row.name, spec: row.spec, sourceCategory: row.source_category,
    sourceData: row.source_data as CrawlProduct['sourceData'], url: row.url, price: row.price, inStock: true,
  }));
  const outcomes = new Map<string, SettlementResult>();
  const settlementStarted = performance.now();
  try {
    if (products.length && adapter.settle) await adapter.settle(shop, products, fetchImpl, {
      signal, maxSettlementProducts: settlementBatchSize(adapter.id),
      // prism: the crawler egress cannot reach the FX feed; reuse the official-reference snapshot.
      ...(adapter.id === 'prism' ? { cnyPerUsd: await latestCnyPerUsd(db) } : {}),
      onSettlementResult: result => outcomes.set(result.externalId, result),
    });
  } finally { metrics.data.durations.settlement += Math.round(performance.now() - settlementStarted); }
  signal.throwIfAborted();
  const transactionStarted = performance.now();
  let failure: string | null = null;
  await db.transaction().execute(async tx => {
    const currentShop = await tx.selectFrom('shops').selectAll().where('id', '=', shop.id)
      .where('enabled', '=', true).where('deleted_at', 'is', null).forNoKeyUpdate().executeTakeFirst();
    const unavailableIds = candidates.filter(row => outcomes.get(row.external_id)?.reason === 'product_unavailable').map(row => row.id);
    if (unavailableIds.length) await lockProductRowNames(tx, unavailableIds);
    // Lock products in canonical order so concurrent edits cannot race the baseline recheck.
    if (payload.products.length) await tx.selectFrom('products').select('id').where('id', 'in', payload.products.map(row => BigInt(row.productId)))
      .orderBy('id').forNoKeyUpdate().execute();
    const current = currentShop ? await retryCandidates(tx, currentShop, payload) : [];
    const byExternal = new Map(products.map(product => [String(product.externalId), product]));
    const remaining = new Set<string>();
    const applicableOutcomes: SettlementResult[] = [];
    const verified: Array<{ id: string; price: string; at: string; method: string; quantity: number; total: string }> = [];
    const deferred: bigint[] = [];
    const retired: bigint[] = [];
    for (const row of current) {
      const outcome = outcomes.get(row.external_id);
      if (outcome) applicableOutcomes.push(outcome);
      if (outcome?.reason === 'product_unavailable') { retired.push(row.id); continue; }
      const quote = byExternal.get(row.external_id)?.settlement;
      if (quote) verified.push({ id: String(row.offer_id), price: quote.price, at: quote.verifiedAt,
        method: quote.paymentMethod, quantity: quote.quantity, total: quote.totalAmount });
      if (outcome?.retryable) remaining.add(String(row.id));
      if (outcome?.reason === 'deferred') deferred.push(row.offer_id);
    }
    if (retired.length) await softDeleteProductNames(tx, retired, 'crawler_missing');
    if (verified.length) {
      await sql`update offers o set settlement_price = v.price::numeric, settlement_verified_at = v.at::timestamptz,
        settlement_payment_method = v.method, settlement_quantity = v.quantity,
        settlement_total_amount = v.total::numeric,
        settlement_refresh_at = v.at::timestamptz + ${defaultQuotePolicy().ttlMs} * interval '1 millisecond'
        from jsonb_to_recordset(${JSON.stringify(verified)}::jsonb)
        as v(id text, price text, at text, method text, quantity integer, total text) where o.id = v.id::bigint`.execute(tx);
    }
    if (verified.length || retired.length) await bumpCatalogVersion(tx);
    if (deferred.length) await tx.updateTable('offers').set({ settlement_refresh_at: new Date() })
      .where('id', 'in', deferred).execute();
    // Only a first claim can restore eligibility; later claims may have already spent a retry budget.
    const unattempted = currentShop && job.attempts === 1n && metrics.data.attempts === 1
      ? (await retryCandidates(tx, currentShop, payload, false))
      .filter(row => !outcomes.has(row.external_id)) : [];
    if (unattempted.length) await tx.updateTable('offers').set({ settlement_refresh_at: new Date() })
      .where('id', 'in', unattempted.map(row => row.offer_id)).execute();
    const report = settlementReport(applicableOutcomes, 'not_requested');
    const previousReport = job.row.settlement_report as ReturnType<typeof settlementReport> | null;
    report.verified += previousReport?.verified ?? 0;
    report.skipped += previousReport?.skipped ?? 0;
    for (const [reason, count] of Object.entries(previousReport?.terminalReasons ?? {})) {
      report.failed += count;
      report.reasons[reason] = (report.reasons[reason] ?? 0) + count;
      report.terminalReasons[reason] = count;
    }
    for (const outcome of applicableOutcomes) {
      if (outcome.status === 'failed' && !outcome.retryable) {
        const reason = outcome.reason ?? 'invalid_quote';
        report.terminalReasons[reason] = (report.terminalReasons[reason] ?? 0) + 1;
      }
    }
    report.skipped += payload.products.length - current.length;
    if (payload.products.length !== current.length) report.reasons.superseded = payload.products.length - current.length;
    failure = report.retryable ? settlementError(report) : null;
    metrics.data.durations.transaction += Math.round(performance.now() - transactionStarted);
    metrics.data.durations.total += Math.round(performance.now() - startedAt);
    signal.throwIfAborted();
    const completed = await tx.updateTable('fetch_runs').set({
      settlement_payload: jsonb({ ...payload, products: payload.products.filter(item => remaining.has(item.productId)) }),
      settlement_report: jsonb(report), crawl_metrics: jsonb(metrics.data), error: settlementError(report), item_count: BigInt(current.length),
      ...(failure ? {} : { status: report.failed ? 'failed' as const : 'succeeded' as const, finished_at: sql<Date>`now()`, claimed_by: null, claim_token: null, lease_until: null }),
    }).where(crawlClaim(job)).executeTakeFirst();
    if (completed.numUpdatedRows !== 1n) throw new Error('crawler lease expired before settlement commit');
    signal.throwIfAborted();
  });
  return failure;
}

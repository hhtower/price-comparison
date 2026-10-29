import type { CrawlProduct } from '../platforms/index.js';

export interface SettlementBaseline {
  readonly name: string;
  readonly spec: string;
  readonly source_category: string;
  readonly source_data: unknown;
  readonly price: string | null;
  readonly is_stale: boolean | null;
  readonly settlement_price: string | null;
  readonly settlement_verified_at: Date | null;
  readonly settlement_payment_method: string | null;
  readonly settlement_quantity?: number | null;
  readonly settlement_total_amount?: string | null;
}

export function needsSettlementRefresh(
  item: CrawlProduct, previous: SettlementBaseline | undefined,
  nowMs: number, ttlMs: number, quantity = 1,
): boolean {
  if (!previous || previous.is_stale !== false
    || previous.settlement_price === null || previous.settlement_verified_at === null
    || !previous.settlement_payment_method?.trim() || previous.price === null) return true;
  const listedPrice = Number(String(item.price).replace(/,/g, ''));
  if (!Number.isFinite(listedPrice) || Number(previous.price) !== listedPrice) return true;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 2147483647
    || (previous.settlement_quantity ?? 1) !== quantity) return true;
  if (!Number.isFinite(Number(previous.settlement_price)) || Number(previous.settlement_price) < 0
    || (quantity > 1 && (previous.settlement_total_amount == null
      || !Number.isFinite(Number(previous.settlement_total_amount)) || Number(previous.settlement_total_amount) < 0))) return true;
  const ageMs = nowMs - previous.settlement_verified_at.getTime();
  return !Number.isFinite(ageMs) || ageMs < 0 || ageMs >= ttlMs;
}

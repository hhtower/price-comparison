export type SourceEvidenceValue = null | boolean | number | string | SourceEvidenceValue[] | { [key: string]: SourceEvidenceValue };
export interface CrawlProduct {
  externalId: string | number;
  name: string;
  sourceName?: string;
  description?: string;
  spec?: string;
  sourceCategory?: string;
  sourceData?: Record<string, SourceEvidenceValue>;
  ratingText?: { unitId: string; name: string; description: string; hash: string };
  price: string | number;
  url: string;
  imageUrl?: string | null;
  inStock: boolean;
  settlement?: { price: string; totalAmount: string; quantity: number; verifiedAt: string; paymentMethod: string };
}
export interface PlatformAdapter {
  id: string; name: string; hosts: string[];
  responseFormat?: 'html';
  crawl(page: unknown, shop: { url: string }, fetchImpl?: typeof fetch, options?: CrawlOptions): Promise<CrawlProduct[]>;
  probe(shop: { url: string }, fetchImpl?: typeof fetch): Promise<CrawlProduct[]>;
  settle?(shop: { url: string }, products: CrawlProduct[], fetchImpl?: typeof fetch, options?: CrawlOptions): Promise<CrawlProduct[]>;
  purchaseQuantity?(product: CrawlProduct): number | undefined;
}
export interface SettlementResult {
  externalId: string;
  status: 'verified' | 'failed' | 'skipped';
  reason?: string;
  retryable: boolean;
}
export interface ShopObservation {
  deposit: { amountMinor: number; currency: 'CNY'; purpose: null } | null;
  volume: number | null;
  counterDefinition: string;
  observedAt: string;
}
export interface CrawlOptions {
  /** Opt-in metadata for liandong/16688; missing/invalid fields are null, failed observations are omitted. */
  onShopObservation?: (observation: ShopObservation) => void | Promise<void>;
  maxSettlementProducts?: number;
  signal?: AbortSignal;
  settlementProductIds?: ReadonlySet<string>;
  needsSettlement?: (product: CrawlProduct, quantity: number) => boolean;
  onSettlementResult?: (result: SettlementResult) => void;
  onListComplete?: () => void;
  /** acg-faka: 列表完成度上报(去重条数/重复数/分类与平铺声称值),写入 crawl_metrics。 */
  onListStats?: (stats: { unique: number; duplicates: number; categories: number | null; categoryClaims: number | null; flatTotal: number | null }) => void;
  /** prism: injected official-reference USD-per-CNY rate; falls back to fetching the FX feed. */
  cnyPerUsd?: string;
}
export function platformForUrl(value: string, protocol?: string | null): PlatformAdapter;
export const platforms: PlatformAdapter[];
export const FX_URL: string;
export function latestCnyPerUsd(db: { selectFrom: Function }): Promise<string | undefined>;

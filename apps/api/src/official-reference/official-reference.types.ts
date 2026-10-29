export interface ReferenceSnapshotOffer {
  /** Stable Apple SKU ID, scoped to an app. Never merge ambiguous same-name offers. */
  id: string;
  name: string;
  amount: number;
  formatted: string;
  period: string | null;
  kind: 'app' | 'subscription' | 'purchase';
}

export interface ReferenceRegionSnapshot {
  appId: string;
  country: string;
  currency: string;
  sourceUrl: string;
  capturedAt: string;
  offers: ReferenceSnapshotOffer[];
}

export interface ReferenceCatalogPrice {
  country: string;
  countryName: string;
  currency: string;
  amount: number;
  formatted: string;
  cnyAmount: number | null;
  capturedAt: string;
  sourceUrl: string;
  stale: boolean;
}

export interface ReferenceCatalogPlan {
  id: string;
  name: string;
  period: string | null;
  kind: 'app' | 'subscription' | 'purchase';
  /** Already sorted on the server by CNY price; unknown rates are last. */
  prices: ReferenceCatalogPrice[];
}

export interface ReferenceCatalog {
  updatedAt: string | null;
  exchangeDate: string | null;
  apps: Array<{ id: string; name: string; website: string; totalRegions: number; availableRegions: number; plans: ReferenceCatalogPlan[] }>;
}

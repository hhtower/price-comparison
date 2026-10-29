import type { CrawlProduct, SourceEvidenceValue } from './index.js';

export function rawProductContent(name: string, ...bodies: unknown[]): { sourceName: string; description: string };
export function captureRatingText(unitId: unknown, name: unknown, ...bodies: unknown[]): CrawlProduct['ratingText'];
export function sourceListingId(protocol: string | null | undefined, externalId: string | number): string;
export function buildRatingManifest(
  shop: { url: string; protocol?: string | null; platform: string },
  protocol: string,
  products: readonly Pick<CrawlProduct, 'externalId' | 'ratingText' | 'sourceData'>[] & {
    readonly ratingUnits?: readonly { unitId: string; hash: string | null }[];
  },
  observedAt: number,
): {
  sourceUrl: string;
  sourceProtocol: string | null;
  sourcePlatform: string;
  observedAt: number;
  units: { unitId: string; hash: string | null }[];
} | null;
export function buildSourceEvidence(item: Record<string, unknown>): Record<string, SourceEvidenceValue>;
export function specificationText(value: unknown): string;

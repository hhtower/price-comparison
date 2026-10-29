export const CATALOG_QUOTE_POLICY = Symbol('CATALOG_QUOTE_POLICY');
export interface QuotePolicy { readonly now: () => number; readonly ttlMs: number }
export function defaultQuotePolicy(environment: NodeJS.ProcessEnv = process.env): QuotePolicy {
  const raw = environment.CATALOG_QUOTE_TTL_MS?.trim();
  const ttlMs = raw ? Number(raw) : 8_100_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new Error('CATALOG_QUOTE_TTL_MS must be a positive integer');
  }
  return { now: () => Date.now(), ttlMs };
}

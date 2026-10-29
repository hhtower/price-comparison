const MIN_INTERVAL_RATIO = 0.75;
const MIN_INTERVAL_MS = 1_000;

/** Draw a fresh delay after each success; an omitted minimum retains the legacy 75% lower bound. */
export function jitteredIntervalMs(targetIntervalMs: number, minIntervalMs?: number): number {
  const maximumMs = Math.max(MIN_INTERVAL_MS, Math.round(targetIntervalMs));
  if (minIntervalMs !== undefined && (!Number.isSafeInteger(minIntervalMs) || minIntervalMs < MIN_INTERVAL_MS || minIntervalMs > maximumMs)) {
    throw new Error('minimum interval must be an integer >= 1000 and <= maximum interval');
  }
  const minimumMs = minIntervalMs ?? Math.max(MIN_INTERVAL_MS, Math.ceil(maximumMs * MIN_INTERVAL_RATIO));
  return minimumMs + Math.floor(Math.random() * (maximumMs - minimumMs + 1));
}

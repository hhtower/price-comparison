const BASIC_ITEMS = new Set(['connectivity', 'model-identity', 'streaming', 'token-usage', 'latency']);
const BASELINE_ITEMS = new Set(['fingerprint-match']);
export interface QualityWorkPlan { items: string[]; measurement: boolean; }

/** Share observations within a unit; WorkerRuntime owns all scheduling and leases. */
export function planAiQualityWork(selected: string[]): QualityWorkPlan[] {
  const basic = selected.filter(id => BASIC_ITEMS.has(id));
  const baseline = selected.filter(id => BASELINE_ITEMS.has(id));
  return [
    ...(basic.length ? [{ items: basic, measurement: true }] : []),
    ...(baseline.length ? [{ items: baseline, measurement: false }] : []),
    ...selected.filter(id => !BASIC_ITEMS.has(id) && !BASELINE_ITEMS.has(id)).map(id => ({ items: [id], measurement: false })),
  ];
}

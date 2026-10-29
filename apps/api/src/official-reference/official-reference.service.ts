import { REFERENCE_APPS, REFERENCE_REGIONS } from './official-reference.catalog.js';
import { parseExchangeRates } from './official-reference.sources.js';
import { validateRegionSnapshot } from './official-reference.snapshot.js';
import type { ReferenceCatalog, ReferenceCatalogPlan } from './official-reference.types.js';

export interface PublishedReferenceRow { task_key: string; snapshot: unknown; last_error: string | null; }
export interface ReferenceSnapshotReader { readPublished(): Promise<PublishedReferenceRow[]>; }
const DAY = 24 * 60 * 60 * 1000;

/** Public requests only read published data; all upstream access belongs to the worker. */
export class OfficialReferenceService {
  constructor(private readonly store: ReferenceSnapshotReader, private readonly now: () => number = Date.now) {}

  async catalog(): Promise<ReferenceCatalog> {
    const rows = await this.store.readPublished();
    const now = this.now();
    const fxRow = rows.find(row => row.task_key === 'fx');
    let exchange: ReturnType<typeof parseExchangeRates> | null = null;
    if (fxRow) { try { exchange = parseExchangeRates(fxRow.snapshot); } catch { /* no usable rate */ } }
    const fxStale = Boolean(fxRow?.last_error) || !exchange || now - Date.parse(exchange.date) > 2 * DAY;
    let newest = 0;
    const apps = REFERENCE_APPS.map(app => {
      const plans = new Map<string, ReferenceCatalogPlan>();
      const regions = new Set<string>();
      // US provides a consistent English display name; ID, kind and period define identity.
      const relevant = rows.filter(row => row.task_key.startsWith('prices:' + app.id + ':'))
        .sort((a, b) => Number(b.task_key.endsWith(':us')) - Number(a.task_key.endsWith(':us')) || a.task_key.localeCompare(b.task_key));
      for (const row of relevant) {
        let snapshot;
        try { snapshot = validateRegionSnapshot(row.snapshot); } catch { continue; }
        if (snapshot.appId !== app.id || row.task_key !== 'prices:' + app.id + ':' + snapshot.country) continue;
        regions.add(snapshot.country);
        newest = Math.max(newest, Date.parse(snapshot.capturedAt));
        const region = REFERENCE_REGIONS.find(r => r[0] === snapshot.country)!;
        const rate = snapshot.currency === 'CNY' ? 1 : exchange?.rates[snapshot.currency.toLowerCase()];
        for (const offer of snapshot.offers) {
          const key = JSON.stringify([offer.id, offer.kind, offer.period]);
          let plan = plans.get(key);
          if (!plan) { plan = { id: key, name: offer.kind === 'app' ? '软件本体' : offer.name, period: offer.period, kind: offer.kind, prices: [] }; plans.set(key, plan); }
          plan.prices.push({ country: snapshot.country, countryName: region[1], currency: snapshot.currency,
            amount: offer.amount, formatted: offer.formatted,
            cnyAmount: rate ? Math.round(offer.amount / rate * 100) / 100 : null,
            capturedAt: snapshot.capturedAt, sourceUrl: snapshot.sourceUrl,
            stale: Boolean(row.last_error) || now - Date.parse(snapshot.capturedAt) > DAY || (snapshot.currency !== 'CNY' && fxStale),
          });
        }
      }
      const labels = new Map<string, number>();
      const kindOrder = { app: 0, subscription: 1, purchase: 2 };
      const ordered = [...plans.values()].sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind]
        || a.name.localeCompare(b.name, 'en', { numeric: true }) || (a.period ?? '').localeCompare(b.period ?? '') || a.id.localeCompare(b.id));
      for (const plan of ordered) {
        const labelKey = JSON.stringify([plan.name, plan.period]);
        const occurrence = (labels.get(labelKey) ?? 0) + 1;
        labels.set(labelKey, occurrence);
        if (occurrence > 1) plan.name += ' #' + occurrence;
        plan.prices.sort((a, b) => (a.cnyAmount ?? Infinity) - (b.cnyAmount ?? Infinity) || a.country.localeCompare(b.country));
      }
      return { id: app.id, name: app.name, website: app.website, totalRegions: REFERENCE_REGIONS.length,
        availableRegions: regions.size, plans: ordered };
    });
    return { apps, updatedAt: newest ? new Date(newest).toISOString() : null, exchangeDate: exchange?.date ?? null };
  }
}

import { REFERENCE_APPS, REFERENCE_REGIONS } from './official-reference.catalog.js';
import { REFERENCE_WEBSITES } from '@price-comparison/catalog/official-reference';
import type { ReferenceRegionSnapshot } from './official-reference.types.js';

/** Validate the entire region before it can replace a published snapshot. */
export function validateRegionSnapshot(input: unknown): ReferenceRegionSnapshot {
  if (!input || typeof input !== 'object') throw new Error('Invalid reference snapshot');
  const data = input as ReferenceRegionSnapshot;
  const region = REFERENCE_REGIONS.find(r => r[0] === data.country);
  const website = REFERENCE_WEBSITES.find(source => source.id === data.appId);
  const app = REFERENCE_APPS.find(a => a.id === (website?.appId ?? data.appId));
  const validRegion = website ? data.country === website.country && data.currency === 'USD' : region && data.currency === region[2];
  if (!validRegion || !app || typeof data.capturedAt !== 'string'
    || !Number.isFinite(Date.parse(data.capturedAt)) || !Array.isArray(data.offers)
    || data.offers.length < 1 || data.offers.length > 100) throw new Error('Invalid reference snapshot');
  const source = new URL(data.sourceUrl);
  if (website ? data.sourceUrl !== website.website : source.origin !== 'https://apps.apple.com' || source.username || source.password
    || source.pathname.split('/')[1] !== data.country
    || !source.pathname.endsWith('/id' + data.appId)) throw new Error('Invalid reference source');
  const ids = new Set<string>();
  for (const offer of data.offers) {
    if (!offer || typeof offer.id !== 'string' || !offer.id || offer.id.length > 180 || ids.has(offer.id)
      || typeof offer.name !== 'string' || !offer.name.trim() || offer.name.length > 200
      || !Number.isFinite(offer.amount) || offer.amount < 0 || offer.amount > 1e12
      || typeof offer.formatted !== 'string' || !offer.formatted.trim() || offer.formatted.length > 100
      || !['app', 'subscription', 'purchase'].includes(offer.kind) || (!website && offer.unit !== undefined)
      || (offer.period !== null && (typeof offer.period !== 'string' || offer.period.length > 80))) {
      throw new Error('Invalid reference offer');
    }
    if (website && !website.plans.some(plan => plan.id === offer.id && plan.name === offer.name
      && offer.kind === 'subscription' && offer.period === plan.period && offer.unit === plan.unit && offer.amount > 0)) {
      throw new Error('Invalid website subscription');
    }
    ids.add(offer.id);
  }
  if (website && ids.size !== website.plans.length) throw new Error('Incomplete website subscriptions');
  return data;
}

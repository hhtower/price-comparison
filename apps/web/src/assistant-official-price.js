import { normalizePurchaseTag } from '@price-comparison/catalog/purchase-attributes';
import { normalizeProductTag } from '@price-comparison/catalog/product-tag-policy';
import { formatPlanName } from './official-reference.js';

const identity = value => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase() : '';

function planDuration(period) {
  const match = /^P([1-9][0-9]*)([DWMY])$/u.exec(period);
  if (!match) return '';
  const [, count, unit] = match;
  return `${Number(count) * (unit === 'Y' ? 12 : unit === 'W' ? 7 : 1)} ${'MY'.includes(unit) ? 'month' : 'day'}`;
}

function offerDuration(value) {
  const match = /^([1-9][0-9]*) (day|week|month|year)s?$/u.exec(value);
  return match ? planDuration(`P${match[1]}${match[2][0].toUpperCase()}`) : '';
}

export function assistantOfficialPrice(card, catalog) {
  if (!catalog) return null;
  const tags = (card.offer?.tags ?? []).flatMap(normalizePurchaseTag);
  const regions = [...new Set(tags.filter(tag => tag.name === 'region')
    .map(tag => normalizeProductTag(tag)?.find(item => item.name === 'region')?.value))];
  const region = regions.length === 1 && /^[a-z]{2}$/u.test(regions[0]) && regions[0] !== 'eu' ? regions[0] : null;
  const durations = [...new Set(tags
    .filter(tag => tag.name === 'duration').map(tag => offerDuration(tag.value)))];
  const duration = durations.length === 1 && durations[0] ? durations[0] : null;
  const matches = catalog.apps.flatMap(app => app.plans.filter(plan => {
    if (plan.kind !== 'subscription' || !planDuration(plan.period) || (duration && planDuration(plan.period) !== duration)) return false;
    // Duplicate SKU labels are not distinct product identities; ambiguity must suppress the reference.
    const name = identity(formatPlanName(plan).replace(/\s+#\d+$/u, ''));
    return name === identity(card.title) || identity(`${app.name} ${name}`) === identity(card.title);
  }));
  if (!matches.length || new Set(matches.map(plan => planDuration(plan.period))).size !== matches.length) return null;
  const prices = matches.flatMap(plan => plan.prices.map(price => price && ({ ...price, period: plan.period }))).filter(price => {
    if (!price || (region && price.country !== region) || price.stale !== false || !Number.isFinite(price.amount) || price.amount <= 0
      || !Number.isFinite(price.cnyAmount) || price.cnyAmount <= 0 || !/^[A-Z]{3}$/u.test(price.currency)) return false;
    try {
      const url = new URL(price.sourceUrl);
      return url.protocol === 'https:' && url.hostname === 'apps.apple.com';
    } catch { return false; }
  });
  const price = prices.sort((a, b) => a.cnyAmount - b.cnyAmount || a.country.localeCompare(b.country))[0];
  return price ? { ...price, exchangeDate: catalog.exchangeDate, regionMatched: Boolean(region), periodMatched: Boolean(duration) } : null;
}

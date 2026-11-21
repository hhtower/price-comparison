import { durationToDays, normalizePurchaseTag } from '@price-comparison/catalog/purchase-attributes';
import { normalizeProductTag } from '@price-comparison/catalog/product-tag-policy';
import { REFERENCE_WEBSITES } from '@price-comparison/catalog/official-reference';

export async function readCatalog(signal) {
  const response = await fetch('/api/official-reference/catalog', {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), credentials: 'omit',
  });
  if (!response.ok) throw new Error('参考价暂时无法读取');
  const catalog = await response.json();
  if (!Array.isArray(catalog?.apps) || !catalog.apps.every(app =>
    app && Array.isArray(app.plans) && app.plans.every(plan => plan && Array.isArray(plan.prices)))) {
    throw new Error('Invalid reference catalog');
  }
  return {
    ...catalog,
    apps: catalog.apps.map(app => ({ ...app, plans: app.plans.filter(plan => plan.kind !== 'app') }))
      .filter(app => app.plans.some(plan => plan.prices.length > 0)),
  };
}

export function formatPeriod(period) {
  const match = /^P([1-9][0-9]*)([DWMY])$/.exec(period);
  if (!match) return period;
  const [, count, unit] = match;
  const units = { D: ['天', '天'], W: ['周', '周'], M: ['月', '个月'], Y: ['年', '年'] };
  return count === '1' ? '每' + units[unit][0] : '每' + count + units[unit][1];
}

export function formatPlanName(plan) {
  // Structured billing periods take precedence over stale or localized name suffixes.
  const suffix = /(?:\s*[-–—·]\s*|\s+)(?:monthly|annual|yearly|mensal|按月付费|按年付费)(\s+#\d+)?\s*$/i;
  return plan.kind === 'subscription' && /^P[1-9][0-9]*[DWMY]$/.test(plan.period)
    ? plan.name.replace(suffix, '$1').trim() || plan.name
    : plan.name;
}

const identity = value => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase() : '';

function referenceTitle(title, appId) {
  const name = identity(title);
  const unified = /^grok·x·cursor (plus|premium|super|ultra)\(统一订阅\)$/u.exec(name);
  if (appId === 'cursor' && unified) return `cursor ${unified[1]}`;
  if (appId === '6670324846') {
    if (name === identity('SuperGrok（旧版）')) return 'supergrok';
    if (name === identity('Grok Heavy（旧版）')) return 'supergrok heavy';
  }
  return name;
}

function knownSuperGrokSku(plan) {
  if (plan.appId !== '6670324846' || identity(formatPlanName(plan).replace(/\s+#\d+$/u, '')) !== 'supergrok') return false;
  try {
    // Confirmed official SKU variants share the legacy SuperGrok subscription, not unified Premium.
    return ['6741437612', '6744708035', '6741437697'].includes(JSON.parse(plan.id)[0]);
  } catch { return false; }
}

function planDuration(period) {
  const match = /^P([1-9][0-9]*)([DWMY])$/u.exec(period);
  if (!match) return '';
  const [, count, unit] = match;
  try { return durationToDays(Number(count), { D: 'day', W: 'week', M: 'month', Y: 'year' }[unit]); } catch { return null; }
}

function offerDuration(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function findOfficialPrice(title, purchaseTags, catalog) {
  if (!catalog) return null;
  const tags = purchaseTags.flatMap(normalizePurchaseTag);
  const regions = [...new Set(tags.filter(tag => tag.name === 'region')
    .map(tag => normalizeProductTag(tag)?.find(item => item.name === 'region')?.value))];
  const region = regions.length === 1 && /^[a-z]{2}$/u.test(regions[0]) && regions[0] !== 'eu' ? regions[0] : null;
  const durations = [...new Set(tags
    .filter(tag => tag.name === 'duration').map(tag => offerDuration(tag.value)))];
  const duration = durations.length === 1 && durations[0] ? durations[0] : null;
  const candidates = catalog.apps.flatMap(app => app.plans.filter(plan => {
    if (plan.kind !== 'subscription' || !planDuration(plan.period)) return false;
    // Duplicate SKU labels are not distinct product identities; ambiguity must suppress the reference.
    const name = identity(formatPlanName(plan).replace(/\s+#\d+$/u, ''));
    const target = referenceTitle(title, app.id);
    return name === target || identity(`${app.name} ${name}`) === target;
  }).map(plan => ({ ...plan, appId: app.id })));
  const samePeriod = candidates.filter(plan => planDuration(plan.period) === duration);
  const matches = samePeriod.length ? samePeriod : candidates;
  if (!matches.length || (new Set(matches.map(plan => planDuration(plan.period))).size !== matches.length && !matches.every(knownSuperGrokSku))) return null;
  const prices = matches.flatMap(plan => plan.prices.map(price => price && ({ ...price, period: plan.period, appId: plan.appId }))).filter(price => {
    if (!price || (region && price.country !== region && price.country !== 'global') || price.stale !== false || !Number.isFinite(price.amount) || price.amount <= 0
      || !Number.isFinite(price.cnyAmount) || price.cnyAmount <= 0 || !/^[A-Z]{3}$/u.test(price.currency)) return false;
    const website = REFERENCE_WEBSITES.find(source => source.id === price.appId);
    if (website) return price.sourceUrl === website.website && price.country === 'global' && price.currency === 'USD';
    try {
      const url = new URL(price.sourceUrl);
      return url.protocol === 'https:' && url.hostname === 'apps.apple.com';
    } catch { return false; }
  });
  const price = prices.sort((a, b) => a.cnyAmount - b.cnyAmount || a.country.localeCompare(b.country))[0];
  return price ? { ...price, exchangeDate: catalog.exchangeDate, regionMatched: Boolean(region) && price.country === region, periodMatched: planDuration(price.period) === duration } : null;
}

export function catalogOfficialPrice(title, offer, catalog) {
  const reference = findOfficialPrice(title, [], catalog);
  if (!reference) return null;
  const currency = offer?.currency?.toUpperCase();
  const base = currency === 'CNY' || currency === 'RMB' ? reference.cnyAmount
    : currency === reference.currency ? reference.amount : null;
  const amount = offer?.price != null && String(offer.price).trim() ? Number(offer.price) : NaN;
  const percentage = base > 0 && Number.isFinite(amount) && amount >= 0 ? amount / base * 100 : null;
  return { ...reference, percentage: Number.isFinite(percentage) ? percentage : null };
}

export function formatOfficialDiscount(percentage) {
  if (!Number.isFinite(percentage) || percentage < 0) return '';
  if (percentage === 100) return '同价';
  const value = percentage < 100 ? percentage / 10 : percentage - 100;
  const formatted = value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  return percentage < 100 ? `${formatted}折` : `贵 ${formatted}%`;
}

import { createHash } from 'node:crypto';
export { specificationText } from '../products/product-spec.js';

/** Source bytes for content change detection, before display/evidence processing. */
export function rawProductContent(name, ...bodies) {
  if (typeof name !== 'string' || bodies.some(body => body != null && typeof body !== 'string')) {
    throw new TypeError('invalid original product name or description');
  }
  return { sourceName: name, description: bodies.map(body => body ?? '').join('\n') };
}

/** Raw source listing evidence; missing bodies must never become empty evidence. */
export function captureRatingText(unitId, name, ...bodies) {
  if (unitId == null || !String(unitId) || typeof name !== 'string'
    || !bodies.length || bodies.some(body => typeof body !== 'string')) return undefined;
  const description = bodies.join('\n');
  return { unitId: String(unitId), name, description,
    hash: createHash('sha256').update(JSON.stringify([name, description])).digest('hex') };
}

const SKU_PROTOCOLS = new Set(['public-products-v1', 'acg-faka', 'orion-key', 'dujiaoka', 'emshop', 'acg-faka-v5']);

export function sourceListingId(protocol, externalId) {
  const value = String(externalId);
  return SKU_PROTOCOLS.has(protocol) ? value.split(':', 1)[0] : value;
}

/** Consume the complete adapter return, before settlement/publication filtering. */
export function buildRatingManifest(shop, protocol, products, observedAt) {
  // shortcut: acg-faka tolerates partial pagination; enable text scores after complete catalogs can be established.
  if (protocol === 'acg-faka') return null;
  const units = new Map();
  const add = (unitId, hash) => units.set(unitId, units.has(unitId) && units.get(unitId) !== hash ? null : hash);
  // Optional parent inventory survives SKU expansion, including parents with no active SKUs.
  for (const unit of products.ratingUnits ?? []) add(unit.unitId, unit.hash);
  for (const item of products) {
    // Catcard expands a catalog parent into independently numbered detail rows.
    const parentId = protocol === 'catcard' && typeof item.sourceData?.ratingUnitId === 'string'
      ? item.sourceData.ratingUnitId : item.externalId;
    const unitId = item.ratingText?.unitId ?? sourceListingId(protocol, parentId);
    const hash = item.ratingText?.hash ?? null;
    add(unitId, hash);
  }
  return { sourceUrl: shop.url, sourceProtocol: shop.protocol ?? null, sourcePlatform: shop.platform,
    observedAt, units: [...units].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([unitId, hash]) => ({ unitId, hash })) };
}

const EXCLUDED_KEYS = new Set([
  'goodsno', 'goodskey', 'externalid', 'price', 'minprice', 'maxprice',
  'marketprice', 'saleprice', 'costprice', 'stock', 'instock', 'stocknum',
  'stockavailable', 'stockavailablequantity', 'inventory', 'inventorycount',
  'stockcount', 'stockavailablestatus',
  'availability', 'sales', 'soldcount', 'url', 'link', 'image', 'imageurl',
  'thumbnail', 'status',
  'capturedat', 'fetchedat', 'crawledat', 'createdat', 'updatedat',
  'secret', 'password', 'passwd', 'token', 'accesstoken', 'refreshtoken',
  'apikey', 'authorization', 'cookie', 'setcookie', 'session', 'sessionid',
]);

const ROOT_EXCLUDED_KEYS = new Set(['name', 'sourcecategory', 'description', 'spec', 'specification', 'selectedoptions', 'sku', 'sourcedata']);

const normalizedKey = key => key.normalize('NFKC').replace(/[\s_-]+/gu, '').toLocaleLowerCase('en-US');

function normalizeJson(value, ancestors = new WeakSet()) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError('platform evidence must not contain cycles');
    ancestors.add(value);
    const result = value.flatMap(item => {
      const normalized = normalizeJson(item, ancestors);
      return normalized === undefined ? [] : [normalized];
    });
    ancestors.delete(value);
    return result;
  }
  if (value && typeof value === 'object') {
    if (ancestors.has(value)) throw new TypeError('platform evidence must not contain cycles');
    ancestors.add(value);
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (EXCLUDED_KEYS.has(normalizedKey(key))) continue;
      const normalized = normalizeJson(value[key], ancestors);
      if (normalized !== undefined) result[key] = normalized;
    }
    ancestors.delete(value);
    return result;
  }
  return undefined;
}

export function buildSourceEvidence(item) {
  const inherited = item.sourceData && typeof item.sourceData === 'object' && !Array.isArray(item.sourceData) ? item.sourceData : {};
  const root = Object.fromEntries(Object.entries({ ...inherited, ...item }).filter(([key]) => !ROOT_EXCLUDED_KEYS.has(normalizedKey(key))));
  const result = normalizeJson(root);
  if (!result.evidence && typeof item.description === 'string') result.evidence = normalizeJson(item.description);
  return result;
}

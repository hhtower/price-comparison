import { buildSourceEvidence, captureRatingText, rawProductContent } from './source-evidence.js';
import { specificationText } from '../products/product-spec.js';

export const id = 'catcard';
const fail = message => { throw new Error(`${id} goods API: ${message}`); };
const validId = value => Number.isSafeInteger(value) && value > 0;
const validText = value => typeof value === 'string' && value.trim().length > 0;
const priceText = value => {
  const text = ['string', 'number'].includes(typeof value) ? String(value).trim() : '';
  if (!/^\d+(?:\.\d+)?$/.test(text) || !Number.isFinite(Number(text))) fail('invalid price');
  return text;
};

async function read(shop, path, fetchImpl, signal) {
  signal?.throwIfAborted();
  const response = await fetchImpl(new URL(path, shop.url).href, {
    headers: { accept: 'application/json' }, redirect: 'error', cache: 'no-store', ...(signal ? { signal } : {}),
  });
  if (!response.ok) fail(`HTTP ${response.status}`);
  const data = await response.json();
  signal?.throwIfAborted();
  return data;
}

function validateProduct(item) {
  if (!item || !validId(item.id) || !validText(item.name) || !['product', 'spec_group'].includes(item.catalog_type)
    || (item.group_id !== null && !validId(item.group_id))
    || !Number.isSafeInteger(item.stock) || item.stock < 0 || typeof item.supply_paused !== 'boolean'
    || typeof item.require_login !== 'boolean' || !Number.isSafeInteger(item.max_per_user) || item.max_per_user < 0
    || !Array.isArray(item.volume_pricing)) fail('invalid or unsupported product');
  priceText(item.price);
  const thresholds = new Set();
  for (const tier of item.volume_pricing) {
    if (!validId(tier?.min_quantity) || thresholds.has(tier.min_quantity)) fail('invalid volume pricing');
    thresholds.add(tier.min_quantity);
    priceText(tier.price);
  }
}

function groupSpecs(group, ownerId, categoryId) {
  if (!group || !validId(group.id) || !validText(group.name) || !validText(group.display_title)
    || group.group_id !== categoryId || !Array.isArray(group.specs) || !group.specs.length) fail('invalid specification group');
  const seen = new Set();
  for (const spec of group.specs) {
    if (!validId(spec?.product_id) || !validText(spec.spec_name) || !validText(spec.product_name)
      || !Number.isSafeInteger(spec.stock) || spec.stock < 0 || typeof spec.supply_paused !== 'boolean'
      || seen.has(spec.product_id)) fail('invalid or duplicate specification');
    priceText(spec.price);
    seen.add(spec.product_id);
  }
  if (!seen.has(ownerId)) fail('specification owner mismatch');
  return group.specs;
}

async function catalog(shop, fetchImpl, signal) {
  // The storefront fetches this entire array once and filters categories locally.
  const items = await read(shop, '/api/products', fetchImpl, signal);
  if (!Array.isArray(items)) fail('invalid catalog');
  const entries = [], seen = new Set(), groupIds = new Set();
  for (const item of items) {
    validateProduct(item);
    if (item.catalog_type === 'product' && item.spec_group !== null) fail('unexpected grouped catalog product');
    const specs = item.catalog_type === 'spec_group' ? groupSpecs(item.spec_group, item.id, item.group_id) : [{ product_id: item.id }];
    if (item.catalog_type === 'spec_group') {
      if (groupIds.has(item.spec_group.id)) fail('duplicate specification group');
      groupIds.add(item.spec_group.id);
    }
    for (const spec of specs) {
      if (seen.has(spec.product_id)) fail('duplicate product ID');
      seen.add(spec.product_id);
      entries.push({ productId: spec.product_id, groupId: item.group_id, group: item.spec_group,
        ratingUnitId: String(item.id), ratingName: item.name });
    }
  }
  const groups = await read(shop, '/api/products/groups', fetchImpl, signal);
  if (!Array.isArray(groups)) fail('invalid categories');
  const categories = new Map();
  for (const group of groups) {
    if (!validId(group?.id) || !validText(group.name) || categories.has(group.id)) fail('invalid or duplicate category');
    categories.set(group.id, group.name.trim());
  }
  if (entries.some(entry => entry.groupId !== null && !categories.has(entry.groupId))) fail('missing category');
  return { entries, categories };
}

async function detail(shop, entry, categories, fetchImpl, signal) {
  const item = await read(shop, `/api/products/${entry.productId}`, fetchImpl, signal);
  validateProduct(item);
  if (item.id !== entry.productId || item.catalog_type !== 'product' || item.group_id !== entry.groupId) fail('detail identity mismatch');
  let selected;
  if (entry.group) {
    const specs = groupSpecs(item.spec_group, item.id, item.group_id);
    const membership = rows => JSON.stringify(rows.map(row => [row.product_id, row.spec_name]).sort(([a], [b]) => a - b));
    if (item.spec_group.id !== entry.group.id || membership(specs) !== membership(entry.group.specs)) fail('specification membership changed');
    selected = specs.find(spec => spec.product_id === item.id);
    if (item.name !== selected.product_name) fail('specification detail name mismatch');
  } else if (item.spec_group !== null) fail('unexpected detail specifications');
  const spec = selected ? specificationText([{ name: item.spec_group.name, value: selected.spec_name }]) : '';
  const unitTier = item.volume_pricing.find(tier => tier.min_quantity === 1);
  const image = typeof item.image_url === 'string' && item.image_url ? new URL(item.image_url, shop.url) : null;
  return {
    externalId: String(item.id), name: item.name.trim(), spec,
    ratingText: captureRatingText(entry.ratingUnitId, entry.group ? entry.ratingName : item.name,
      item.description, item.usage_guide, item.warranty_info),
    ...rawProductContent(item.name, item.description),
    sourceCategory: categories.get(item.group_id) ?? '',
    sourceData: buildSourceEvidence({
      ratingUnitId: entry.ratingUnitId,
      description: item.description, usage_guide: item.usage_guide, warranty_info: item.warranty_info,
      tags: Array.isArray(item.tags) ? item.tags.filter(tag => validText(tag?.text)).map(tag => tag.text) : [],
      require_login: item.require_login, max_per_user: item.max_per_user,
      wholesale_minimums: item.volume_pricing.map(tier => tier.min_quantity),
    }),
    price: priceText(unitTier?.price ?? item.price),
    // The frontend opens details in a drawer; it has no product-specific navigation URL.
    url: new URL('/', shop.url).href,
    imageUrl: image && ['http:', 'https:'].includes(image.protocol) ? image.href : null,
    inStock: item.stock > 0 && !item.supply_paused,
  };
}

export async function probe(shop, fetchImpl = globalThis.fetch) {
  const { entries, categories } = await catalog(shop, fetchImpl);
  const products = [];
  // Preview only: two catalog reads and at most three real product details.
  for (const entry of entries.slice(0, 3)) products.push(await detail(shop, entry, categories, fetchImpl));
  return products;
}

export async function crawl(_page, shop, fetchImpl = globalThis.fetch, options = {}) {
  const { entries, categories } = await catalog(shop, fetchImpl, options.signal);
  const products = [];
  for (const entry of entries) products.push(await detail(shop, entry, categories, fetchImpl, options.signal));
  options.signal?.throwIfAborted();
  options.onListComplete?.();
  return products;
}

export default { id, name: '猫咔', hosts: ['catcard.uk'], crawl, probe };

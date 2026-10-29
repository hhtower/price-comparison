import { buildSourceEvidence, captureRatingText, rawProductContent } from './source-evidence.js';
import { normalizeSpec } from '../products/product-spec.js';

export const id = 'orion-key';
const PAGE_SIZE = 100;
const MAX_PAGES = 1000;
const fail = message => { throw new Error(`${id} goods API: ${message}`); };
const validId = value => typeof value === 'string' && value.trim().length > 0;
const validStock = value => Number.isSafeInteger(value) && value >= 0;

async function readJson(url, fetchImpl, signal) {
  signal?.throwIfAborted();
  const response = await fetchImpl(url, { headers: { accept: 'application/json' }, redirect: 'error', ...(signal ? { signal } : {}) });
  signal?.throwIfAborted();
  if (!response.ok) fail(`HTTP ${response.status}`);
  const payload = await response.json();
  signal?.throwIfAborted();
  if (payload?.code !== 0 || !payload.data || typeof payload.data !== 'object') fail('invalid response');
  return payload.data;
}

function validateProduct(item) {
  if (!item || !validId(item.id) || typeof item.title !== 'string' || !item.title.trim()
    || item.currency !== 'CNY' || typeof item.has_specs !== 'boolean' || !validStock(item.stock_available)) fail('invalid product');
}

async function readPage(shop, page, fetchImpl, signal) {
  const url = new URL('/api/products', shop.url);
  url.searchParams.set('page', String(page));
  url.searchParams.set('page_size', String(PAGE_SIZE));
  const { list, pagination: meta } = await readJson(url.href, fetchImpl, signal);
  if (!Array.isArray(list) || !meta || meta.page !== page || !Number.isSafeInteger(meta.page_size) || meta.page_size < 1
    || !Number.isSafeInteger(meta.total) || meta.total < 0) fail('invalid pagination');
  const pages = Math.max(1, Math.ceil(meta.total / meta.page_size));
  if (pages > MAX_PAGES || page > pages || list.length !== Math.min(meta.page_size, Math.max(0, meta.total - (page - 1) * meta.page_size))) fail('incomplete pagination');
  for (const item of list) validateProduct(item);
  if (new Set(list.map(item => item.id)).size !== list.length) fail('duplicate product ID');
  return { items: list, total: meta.total, size: meta.page_size, pages };
}

function priceText(value) {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (!/^\d+(?:\.\d+)?$/.test(text) || !Number.isFinite(Number(text))) fail('invalid price');
  return text;
}

async function readDetail(shop, listing, fetchImpl, signal) {
  const item = await readJson(new URL(`/api/products/${encodeURIComponent(listing.id)}`, shop.url).href, fetchImpl, signal);
  validateProduct(item);
  if (item.id !== listing.id || item.has_specs !== listing.has_specs) fail('detail identity mismatch');
  if (item.spec_enabled !== item.has_specs || !Array.isArray(item.specs)
    || (item.has_specs ? !item.specs.length : item.specs.length > 0)) fail('invalid specifications');
  const step = item.quantity_step ?? 1;
  if (!Number.isSafeInteger(step) || step < 1) fail('invalid purchase step');
  if (item.discounted_price != null) fail('unsupported discounted price');
  const rows = item.has_specs ? item.specs : [{ price: item.base_price, stock_available: item.stock_available }];
  const ratingText = captureRatingText(item.id, item.title, item.description, item.detail_md);
  const seen = new Set();
  return rows.map(sku => {
    if (!sku || !validStock(sku.stock_available) || (item.has_specs && (!validId(sku.id) || typeof sku.name !== 'string' || !sku.name.trim()))) fail('invalid SKU');
    if (sku.discounted_price != null) fail('unsupported discounted price');
    if (item.has_specs && seen.has(sku.id)) fail('duplicate SKU ID');
    seen.add(sku.id);
    const spec = item.has_specs ? normalizeSpec(sku.name) : '';
    const image = typeof item.cover_url === 'string' && item.cover_url ? new URL(item.cover_url, shop.url) : null;
    return {
      externalId: item.has_specs ? `${item.id}:${sku.id}` : item.id,
      name: `${item.title.trim()}${spec ? ` · ${spec}` : ''}`, spec,
      ...(ratingText ? { ratingText } : {}),
      ...rawProductContent(item.title, item.description, item.detail_md),
      ...(typeof item.category?.name === 'string' ? { sourceCategory: item.category.name } : {}),
      sourceData: buildSourceEvidence({ description: item.description, content: item.detail_md ?? '',
        fulfillment_type: sku.fulfillment_type, quantity_step: item.quantity_step, wholesale_enabled: item.wholesale_enabled }),
      price: priceText(sku.price), url: new URL(`/product/${encodeURIComponent(item.id)}`, shop.url).href,
      imageUrl: image && ['http:', 'https:'].includes(image.protocol) ? image.href : null,
      inStock: item.stock_available >= step && sku.stock_available >= step,
    };
  });
}

export async function probe(shop, fetchImpl = globalThis.fetch) {
  const batch = await readPage(shop, 1, fetchImpl);
  return batch.items.length ? (await readDetail(shop, batch.items[0], fetchImpl)).slice(0, 3) : [];
}

export async function crawl(_page, shop, fetchImpl = globalThis.fetch, options = {}) {
  const products = [], seen = new Set();
  let expected;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await readPage(shop, page, fetchImpl, options.signal);
    expected ??= batch;
    if (batch.total !== expected.total || batch.size !== expected.size) fail('pagination changed during crawl');
    for (const item of batch.items) {
      if (seen.has(item.id)) fail('duplicate product across pages');
      seen.add(item.id);
      products.push(...await readDetail(shop, item, fetchImpl, options.signal));
    }
    if (page >= batch.pages) {
      if (seen.size !== batch.total) fail('incomplete snapshot');
      options.signal?.throwIfAborted();
      options.onListComplete?.();
      return products;
    }
  }
  fail('pagination limit exceeded');
}

export default { id, name: 'Orion Key', hosts: ['gpt.ybkjs.top', 'chong.nerver.cc', 'shop.desolate.run'], crawl, probe };

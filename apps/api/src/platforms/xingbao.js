import { buildSourceEvidence, captureRatingText, rawProductContent } from './source-evidence.js';

export const id = 'xingbao';
const fail = message => { throw new Error(`${id} catalog: ${message}`); };
const AVAILABILITY = { 'https://schema.org/InStock': true, 'https://schema.org/OutOfStock': false };

async function readText(url, fetchImpl, signal) {
  signal?.throwIfAborted();
  const response = await fetchImpl(url, { headers: { accept: 'text/html' }, redirect: 'error', ...(signal ? { signal } : {}) });
  if (!response.ok) {
    const error = new Error(`${id} catalog: HTTP ${response.status}`);
    if ([403, 429].includes(response.status)) error.name = 'CrawlerBlockedError';
    throw error;
  }
  return response.text();
}

function productSlugs(origin, xml) {
  const slugs = [];
  for (const match of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    let url;
    try { url = new URL(match[1], origin); } catch { fail('invalid sitemap URL'); }
    if (url.origin !== origin) continue;
    const slug = url.pathname.match(/^\/products\/([A-Za-z0-9_-]+)$/)?.[1];
    if (slug) slugs.push(slug);
  }
  if (!slugs.length) fail('no product URLs');
  if (new Set(slugs).size !== slugs.length) fail('duplicate product slug');
  return slugs;
}

function parseProduct(html, slug, origin) {
  let product;
  for (const match of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/g)) {
    let parsed;
    try { parsed = JSON.parse(match[1]); } catch { fail('invalid ld+json'); }
    for (const node of Array.isArray(parsed) ? parsed : [parsed]) {
      if (node?.['@type'] === 'Product') {
        if (product) fail('duplicate product block');
        product = node;
      }
    }
  }
  if (!product) fail('missing product data');
  const offers = product.offers;
  const price = typeof offers?.price === 'string' || typeof offers?.price === 'number' ? String(offers.price).trim() : '';
  if (typeof product.name !== 'string' || !product.name.trim() || product.sku !== slug
    || !offers || typeof offers !== 'object' || Array.isArray(offers)
    || !/^\d+(?:\.\d{1,2})?$/.test(price) || Number(price) <= 0 || offers.priceCurrency !== 'CNY'
    || !(offers.availability in AVAILABILITY)) fail('invalid product');
  const image = Array.isArray(product.image) && typeof product.image[0] === 'string' ? new URL(product.image[0], origin) : null;
  return {
    externalId: slug,
    name: product.name.trim(),
    spec: '',
    ...rawProductContent(product.name, product.description),
    ratingText: captureRatingText(slug, product.name, product.description),
    sourceCategory: typeof product.category === 'string' && product.category.trim() ? product.category.trim() : undefined,
    sourceData: buildSourceEvidence({ description: product.description }),
    price, url: `${origin}/products/${slug}`,
    imageUrl: image && ['https:', 'http:'].includes(image.protocol) ? image.href : null,
    inStock: AVAILABILITY[offers.availability],
  };
}

export async function crawl(_page, shop, fetchImpl = globalThis.fetch, options = {}) {
  const origin = new URL(shop.url).origin;
  const slugs = productSlugs(origin, await readText(`${origin}/sitemap.xml`, fetchImpl, options.signal));
  const products = [];
  for (const slug of slugs) {
    products.push(parseProduct(await readText(`${origin}/products/${slug}`, fetchImpl, options.signal), slug, origin));
    options.signal?.throwIfAborted();
  }
  options.onListComplete?.();
  return products;
}

// Detection scopes requests to the shop origin and rejects non-HTML responses, so the sitemap is crawl-only.
export async function probe(shop, fetchImpl = globalThis.fetch) {
  const origin = new URL(shop.url).origin;
  const html = await readText(origin + '/', fetchImpl);
  const slug = [...html.matchAll(/\/products\/([A-Za-z0-9_-]+)/g)].map(match => match[1]).find(Boolean);
  if (!slug) fail('no product links');
  return [parseProduct(await readText(`${origin}/products/${slug}`, fetchImpl), slug, origin)];
}

export default { id, name: '星星小店（schema.org）', hosts: ['xingbao-ai.shop'], responseFormat: 'html', crawl, probe };

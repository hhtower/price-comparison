import { createDecipheriv } from 'node:crypto';
import { parse } from 'parse5';
import { buildSourceEvidence, captureRatingText, rawProductContent } from './source-evidence.js';
import { normalizeSpec } from '../products/product-spec.js';

export const id = 'acg-faka-v5';
const fail = message => { throw new Error(`${id} goods HTML: ${message}`); };
const attr = (node, name) => node?.attrs?.find(item => item.name === name)?.value;
const hasClass = (node, name) => (attr(node, 'class') ?? '').split(/\s+/).includes(name);
const nodes = (node, test) => [...(test(node) ? [node] : []), ...(node.childNodes ?? []).flatMap(child => nodes(child, test))];
const rawText = node => node.nodeName === '#text' ? node.value : (node.childNodes ?? []).map(rawText).join('');
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const money = value => {
  if (!['number', 'string'].includes(typeof value) || !/^\d+(?:\.\d+)?$/.test(String(value)) || !Number.isFinite(Number(value))) fail('invalid price');
  return String(value);
};

async function readHtml(shop, path, fetchImpl, signal) {
  signal?.throwIfAborted();
  const response = await fetchImpl(new URL(path, shop.url).href, { headers: { accept: 'text/html' }, redirect: 'error', ...(signal ? { signal } : {}) });
  if (!response.ok) fail(`HTTP ${response.status}`);
  let html = await response.text();
  signal?.throwIfAborted();
  // This theme publishes an AES key/IV beside the HTML; decode the display envelope, never run JavaScript.
  const key = html.match(/var _0x5a4b=\['([a-zA-Z0-9]{16})'/)?.[1], encrypted = html.match(/'VvdIy':'([A-Za-z0-9+/=]+)'/)?.[1];
  if (key && encrypted) {
    try {
      const decipher = createDecipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(key));
      html = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString('utf8');
    } catch { fail('invalid public HTML envelope'); }
  }
  if (!/<\/html>\s*$/i.test(html)) fail('incomplete document');
  const document = parse(html);
  const currencies = nodes(document, node => node.tagName === 'script').flatMap(node => [...rawText(node).matchAll(/setVar\(\s*["']CCY["']\s*,\s*["']([^"']+)["']\s*\)/g)].map(match => match[1]));
  if (currencies.length !== 1 || !['¥', '￥'].includes(currencies[0])) fail('unsupported currency');
  if (!nodes(document, node => node.tagName === 'link' && /^\/app\/Plugin\/HimenoSena\/Assets\/Base\.css\?v=5\.0\.\d+$/.test(attr(node, 'href') ?? '')).length) fail('unsupported theme');
  if (nodes(document, node => hasClass(node, 'pagination') || hasClass(node, 'page-item') || attr(node, 'rel') === 'next'
    || (node.tagName === 'a' && /(?:[?&])(?:page|size|p)=/.test(attr(node, 'href') ?? ''))).length) fail('unsupported paginated catalog');
  return document;
}

function catalog(document, shop, expectedCategory = 0) {
  const origin = new URL(shop.url).origin;
  const navigation = nodes(document, node => hasClass(node, 'category-items'));
  if (navigation.length !== 1 || !nodes(document, node => hasClass(node, 'category-info-name') && rawText(node).trim()).length
    || nodes(document, node => hasClass(node, 'article-items')).length <= nodes(navigation[0], node => hasClass(node, 'article-items')).length) fail('missing category catalog');
  const links = nodes(navigation[0], node => node.tagName === 'a' && hasClass(node, 'article-item'));
  const categories = links.flatMap(node => {
    const url = new URL(attr(node, 'href') ?? '', shop.url);
    if (url.origin !== origin || url.pathname !== '/' || url.hash) fail('invalid category link');
    if (!url.search) return [];
    if ([...url.searchParams.keys()].join() !== 'cid' || !/^[1-9]\d*$/.test(url.searchParams.get('cid') ?? '')) fail('invalid category ID');
    return [Number(url.searchParams.get('cid'))];
  });
  if (!categories.length || categories.length > 100 || categories.some(value => !positiveId(value)) || new Set(categories).size !== categories.length) fail('invalid categories');
  const active = links.filter(node => hasClass(node, 'active'));
  const headings = nodes(document, node => hasClass(node, 'category-info-name'));
  const labels = active.length === 1 ? nodes(active[0], node => hasClass(node, 'article-item-name')) : [];
  const clean = node => rawText(node).replace(/\s+/gu, ' ').trim();
  if (active.length !== 1 || headings.length !== 1 || labels.length !== 1 || !clean(labels[0])
    || Number(new URL(attr(active[0], 'href'), shop.url).searchParams.get('cid') ?? 0) !== (expectedCategory ?? 0)
    || clean(headings[0]) !== clean(labels[0])) fail('category identity mismatch');
  const products = nodes(document, node => node.tagName === 'a' && hasClass(node, 'shop-item')).map(node => {
    const url = new URL(attr(node, 'href') ?? '', shop.url), product = Number(url.searchParams.get('id'));
    if (url.origin !== origin || url.pathname !== '/item' || url.hash || [...url.searchParams.keys()].join() !== 'id' || !positiveId(product)) fail('invalid product link');
    return product;
  });
  if (products.length > 1000 || new Set(products).size !== products.length) fail('duplicate or excessive products');
  return { categories, products };
}

async function product(shop, itemId, categoryId, fetchImpl, signal) {
  const document = await readHtml(shop, `/item?id=${itemId}`, fetchImpl, signal);
  const declarations = nodes(document, node => node.tagName === 'script').map(rawText)
    .map(script => script.match(/^\s*setVar\(\s*["']item["']\s*,\s*(\{[\s\S]*\})\s*\);?\s*$/)?.[1]).filter(Boolean);
  if (declarations.length !== 1) fail('missing item declaration');
  let item;
  try { item = JSON.parse(declarations[0]); } catch { fail('invalid item JSON'); }
  if (item?.id !== itemId || item.source?.id !== itemId || item.source.status !== 1 || !Array.isArray(item.attr) || item.attr.length
    || typeof item.name !== 'string' || !item.name.trim() || !positiveId(item.category?.id) || item.source.category_id !== item.category.id
    || (categoryId && item.category.id !== categoryId) || typeof item.category.name !== 'string' || !item.category.name.trim()
    || !Array.isArray(item.sku) || !item.sku.length || item.sku.length > 64) fail('invalid detail identity or unsupported attributes');
  const seen = new Set();
  const ratingText = captureRatingText(itemId, item.name, item.source.introduce);
  return item.sku.map(sku => {
    const restriction = sku?.quantity_restriction;
    if (!positiveId(sku?.id) || seen.has(sku.id) || typeof sku.name !== 'string' || !sku.name.trim() || !object(restriction)
      || ![restriction.min, restriction.max, restriction.total].every(value => Number.isSafeInteger(value) && value >= 0)
      || restriction.min < 1 || (restriction.max && restriction.max < restriction.min)) fail('invalid SKU or purchase restriction');
    seen.add(sku.id);
    if (!['number', 'string'].includes(typeof sku.stock) || !/^\d+$/.test(String(sku.stock)) || !Number.isSafeInteger(Number(sku.stock))
      || typeof sku.stock_available !== 'boolean' || sku.stock_available !== (Number(sku.stock) > 0)) fail('invalid or ambiguous stock');
    let price = money(sku.price), previous = 0;
    if (typeof sku.have_wholesale !== 'boolean' || !Array.isArray(sku.wholesale) || sku.have_wholesale !== (sku.wholesale.length > 0)) fail('invalid wholesale');
    for (const tier of sku.wholesale) {
      if (!positiveId(tier?.quantity) || tier.quantity <= previous) fail('invalid wholesale quantity');
      const tierPrice = money(tier.price);
      if (tier.quantity <= restriction.min) price = tierPrice;
      previous = tier.quantity;
    }
    const image = typeof sku.picture_url === 'string' && sku.picture_url ? new URL(sku.picture_url, shop.url) : null;
    const spec = normalizeSpec(sku.name);
    return { externalId: `${itemId}:${sku.id}`, name: `${item.name} · ${spec}`, spec,
      ...(ratingText ? { ratingText } : {}),
      ...rawProductContent(item.name, item.source.introduce),
      sourceCategory: item.category.name, sourceData: buildSourceEvidence({ description: item.source.introduce,
        quantityRestriction: restriction, attributes: item.attr }),
      price, url: new URL(`/item?id=${itemId}`, shop.url).href,
      imageUrl: image && ['http:', 'https:'].includes(image.protocol) ? image.href : null,
      inStock: sku.stock_available && Number(sku.stock) >= restriction.min };
  });
}

export async function probe(shop, fetchImpl = globalThis.fetch) {
  const root = catalog(await readHtml(shop, '/', fetchImpl), shop);
  const candidates = root.products.length ? root.products : catalog(await readHtml(shop, `/?cid=${root.categories[0]}`, fetchImpl), shop, root.categories[0]).products;
  return candidates.length ? (await product(shop, candidates[0], null, fetchImpl)).slice(0, 3) : [];
}

export async function crawl(_page, shop, fetchImpl = globalThis.fetch, options = {}) {
  const root = catalog(await readHtml(shop, '/', fetchImpl, options.signal), shop), listings = new Map();
  for (const category of root.categories) {
    const batch = catalog(await readHtml(shop, `/?cid=${category}`, fetchImpl, options.signal), shop, category);
    if (JSON.stringify(batch.categories) !== JSON.stringify(root.categories)) fail('category catalog changed');
    for (const item of batch.products) {
      if (listings.has(item) || listings.size >= 1000) fail('duplicate or excessive catalog');
      listings.set(item, category);
    }
  }
  if (root.products.some(item => !listings.has(item))) fail('incomplete recommendation coverage');
  const result = [];
  for (const [item, category] of listings) result.push(...await product(shop, item, category, fetchImpl, options.signal));
  options.signal?.throwIfAborted();
  options.onListComplete?.();
  return result;
}

export default { id, name: 'ACG-Faka 5（HimenoSena）', hosts: ['lemon-watermelon.com'], responseFormat: 'html', crawl, probe };

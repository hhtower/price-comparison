import { parse, serialize } from 'parse5';
import { buildSourceEvidence, captureRatingText, rawProductContent } from './source-evidence.js';
import { normalizeSpec } from '../products/product-spec.js';

export const id = 'emshop';
const fail = message => { throw new Error(`${id} goods HTML: ${message}`); };
const attr = (node, name) => node?.attrs?.find(item => item.name === name)?.value;
const hasClass = (node, name) => (attr(node, 'class') ?? '').split(/\s+/).includes(name);
const nodes = (node, test) => [...(test(node) ? [node] : []), ...(node.childNodes ?? []).flatMap(child => nodes(child, test))];
const text = node => !node || ['script', 'style'].includes(node.tagName) ? '' : node.nodeName === '#text' ? node.value : (node.childNodes ?? []).map(text).join(' ');
const clean = node => text(node).replace(/\s+/g, ' ').trim();
const positiveId = value => typeof value === 'string' && /^[1-9]\d*$/.test(value);
const scriptText = node => (node.childNodes ?? []).map(child => child.value ?? '').join('');

async function readHtml(url, fetchImpl, signal) {
  signal?.throwIfAborted();
  const response = await fetchImpl(url, { headers: { accept: 'text/html' }, redirect: 'error', ...(signal ? { signal } : {}) });
  signal?.throwIfAborted();
  if (!response.ok) fail(`HTTP ${response.status}`);
  const html = await response.text();
  signal?.throwIfAborted();
  if (!/<\/html>\s*$/i.test(html)) fail('incomplete document');
  const document = parse(html);
  const configs = nodes(document, node => node.tagName === 'script').flatMap(node => [...scriptText(node).matchAll(/window\.EMSHOP_CURRENCY\s*=\s*\{([^}]*)\}/g)].map(match => match[1]));
  if (configs.length !== 1) fail('missing currency');
  const code = configs[0].match(/\bcode\s*:\s*("(?:[^"\\]|\\.)*")/);
  const symbol = configs[0].match(/\bsymbol\s*:\s*("(?:[^"\\]|\\.)*")/);
  const rate = configs[0].match(/\brate\s*:\s*(\d+(?:\.\d+)?)\s*(?:,|$)/);
  if (!code || JSON.parse(code[1]) !== 'CNY' || !symbol || JSON.parse(symbol[1]) !== '¥' || !rate || Number(rate[1]) !== 1) fail('unsupported currency');
  return document;
}

function catalog(document, shop) {
  const main = nodes(document, node => attr(node, 'id') === 'main');
  if (main.length !== 1 || attr(main[0], 'data-nav-current-path') !== '/post-list.html') fail('invalid catalog identity');
  const allTabs = nodes(main[0], node => node.tagName === 'a' && hasClass(node, 'category-tab') && attr(node, 'href') === '/post-list.html');
  const grids = nodes(main[0], node => hasClass(node, 'goods-grid'));
  if (allTabs.length !== 1 || !hasClass(allTabs[0], 'active') || grids.length !== 1
    || nodes(document, node => hasClass(node, 'pagination')).length) fail('unsupported or paginated catalog');
  const totalText = clean(nodes(allTabs[0], node => hasClass(node, 'category-tab-count'))[0]);
  const cards = nodes(grids[0], node => node.tagName === 'a' && hasClass(node, 'goods-card'));
  if (!/^\d+$/.test(totalText) || !Number.isSafeInteger(Number(totalText)) || cards.length !== Number(totalText) || cards.length > 1000) fail('incomplete catalog');
  const ids = [], seen = new Set();
  for (const card of cards) {
    const href = attr(card, 'href');
    if (!href) fail('missing product link');
    const url = new URL(href, shop.url);
    if (!['http:', 'https:'].includes(url.protocol)) fail('invalid product link');
    // External cards are referrals. Never follow them or use their displayed price as this shop's quote.
    if (url.origin !== new URL(shop.url).origin) continue;
    const match = url.pathname.match(/^\/post-([1-9]\d*)\.html$/);
    if (!match || url.search || url.hash || seen.has(match[1])) fail('invalid or duplicate product ID');
    seen.add(match[1]); ids.push(match[1]);
  }
  return ids;
}

function readSpecs(document) {
  const initializers = nodes(document, node => node.tagName === 'script').flatMap(node => [...scriptText(node).matchAll(/GoodsDetail\.init\s*\(\s*\{\s*specs\s*:\s*/g)].map(match => scriptText(node).slice(match.index + match[0].length)));
  if (initializers.length !== 1 || initializers[0][0] !== '[') fail('missing specifications');
  const source = initializers[0];
  let depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '[') depth++;
    else if (char === ']' && --depth === 0) {
      const suffix = source.slice(index + 1).match(/^\s*,\s*currencySymbol\s*:\s*("(?:[^"\\]|\\.)*")\s*,/);
      if (!suffix || JSON.parse(suffix[1]) !== '¥') fail('invalid specification currency');
      const remainder = source.slice(index + 1);
      if ([...remainder.matchAll(/\bdiscountRules\s*:/g)].length !== 1
        || !/\bdiscountRules\s*:\s*\[\s*\]\s*[,}]/.test(remainder)) fail('unsupported discount rules');
      const specs = JSON.parse(source.slice(0, index + 1));
      if (!Array.isArray(specs) || !specs.length) fail('empty specifications');
      return specs;
    }
  }
  fail('incomplete specifications');
}

async function readProduct(shop, productId, fetchImpl, signal) {
  const url = new URL(`/post-${productId}.html`, shop.url).href;
  const document = await readHtml(url, fetchImpl, signal);
  const main = nodes(document, node => attr(node, 'id') === 'main');
  const identity = nodes(document, node => attr(node, 'id') === 'buyNowBtn');
  const nameNode = nodes(document, node => hasClass(node, 'detail-name'))[0];
  const name = clean(nameNode);
  if (main.length !== 1 || attr(main[0], 'data-nav-current-path') !== `/post-${productId}.html`
    || identity.length !== 1 || attr(identity[0], 'data-goods-id') !== productId || !name) fail('detail identity mismatch');
  const descriptionNode = nodes(document, node => hasClass(node, 'detail-body'))[0];
  const description = clean(descriptionNode);
  const ratingText = captureRatingText(productId, serialize(nameNode), descriptionNode ? serialize(descriptionNode) : undefined);
  const image = attr(nodes(nodes(document, node => hasClass(node, 'detail-img'))[0] ?? {}, node => node.tagName === 'img')[0], 'src');
  const imageUrl = image ? new URL(image, shop.url) : null;
  const seen = new Set();
  return readSpecs(document).map(sku => {
    const skuId = Number.isSafeInteger(sku?.id) && sku.id > 0 ? String(sku.id) : '';
    if (!positiveId(skuId) || seen.has(skuId) || typeof sku.name !== 'string' || !sku.name.trim()) fail('invalid or duplicate SKU ID');
    seen.add(skuId);
    const price = typeof sku.price === 'string' || typeof sku.price === 'number' ? String(sku.price).trim() : '';
    if (!/^\d+(?:\.\d+)?$/.test(price) || !Number.isFinite(Number(price))) fail('invalid SKU price');
    if (!Number.isSafeInteger(sku.stock) || sku.stock < 0) fail('invalid SKU stock');
    if (!Number.isSafeInteger(sku.min_buy) || sku.min_buy < 1 || !Number.isSafeInteger(sku.max_buy)
      || sku.max_buy < 0 || (sku.max_buy > 0 && sku.max_buy < sku.min_buy)) fail('invalid purchase quantity');
    const spec = normalizeSpec(sku.name);
    return { externalId: `${productId}:${skuId}`, name: `${name} · ${spec}`, spec, price, url,
      ...(ratingText ? { ratingText } : {}),
      ...rawProductContent(serialize(nameNode), descriptionNode ? serialize(descriptionNode) : undefined),
      sourceData: buildSourceEvidence({ description, min_buy: sku.min_buy, max_buy: sku.max_buy, tags: sku.tags }),
      imageUrl: imageUrl && ['http:', 'https:'].includes(imageUrl.protocol) ? imageUrl.href : null,
      inStock: sku.stock >= sku.min_buy };
  });
}

export async function probe(shop, fetchImpl = globalThis.fetch) {
  const ids = catalog(await readHtml(new URL('/post-list.html', shop.url).href, fetchImpl), shop);
  return ids.length ? (await readProduct(shop, ids[0], fetchImpl)).slice(0, 3) : [];
}

export async function crawl(_page, shop, fetchImpl = globalThis.fetch, options = {}) {
  const ids = catalog(await readHtml(new URL('/post-list.html', shop.url).href, fetchImpl, options.signal), shop);
  const products = [];
  for (const productId of ids) products.push(...await readProduct(shop, productId, fetchImpl, options.signal));
  options.signal?.throwIfAborted();
  options.onListComplete?.();
  return products;
}

export default { id, name: 'EMShop', hosts: ['geminipro.vip'], responseFormat: 'html', crawl, probe };

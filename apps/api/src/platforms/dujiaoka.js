import { parse, serialize } from 'parse5';
import { buildSourceEvidence, captureRatingText, rawProductContent } from './source-evidence.js';
import { normalizeSpec } from '../products/product-spec.js';
import { collectSettlements } from './settlement.js';
import { isDeepStrictEqual } from 'node:util';
import { normalizeProductEvidence } from '../standardization/fingerprint.js';

export const id = 'dujiaoka';
const fail = message => { throw new Error(`${id} goods HTML: ${message}`); };
const attr = (node, name) => node?.attrs?.find(item => item.name === name)?.value;
const hasClass = (node, name) => (attr(node, 'class') ?? '').split(/\s+/).includes(name);
const nodes = (node, test) => [...(test(node) ? [node] : []), ...(node.childNodes ?? []).flatMap(child => nodes(child, test))];
const text = node => !node || ['script', 'style'].includes(node.tagName) ? '' : node.nodeName === '#text' ? node.value : (node.childNodes ?? []).map(text).join(' ');
const clean = node => text(node).replace(/\s+/g, ' ').trim();
const positiveId = value => typeof value === 'string' && /^[1-9]\d*$/.test(value);
const freshProducts = new WeakMap();

async function readHtml(url, fetchImpl, signal) {
  signal?.throwIfAborted();
  const response = await fetchImpl(url, { headers: { accept: 'text/html' }, redirect: 'error', ...(signal ? { signal } : {}) });
  if (!response.ok) {
    const error = new Error(`${id} goods HTML: HTTP ${response.status}`);
    if ([403, 429].includes(response.status)) error.name = 'CrawlerBlockedError';
    throw error;
  }
  const html = await response.text();
  signal?.throwIfAborted();
  if (!/<\/html>\s*$/i.test(html)) fail('incomplete document');
  return parse(html);
}

function catalog(document, shop) {
  const container = nodes(document, node => attr(node, 'id') === 'goodsTabContent')[0];
  const all = nodes(container ?? {}, node => attr(node, 'id') === 'group-all')[0];
  if (!all || !nodes(document, node => (attr(node, 'href') ?? '').startsWith('/assets/unicorn/')).length
    || nodes(document, node => hasClass(node, 'pagination')).length) fail('unsupported or paginated catalog');
  const links = group => nodes(group, node => node.tagName === 'a' && /\/buy\//.test(attr(node, 'href') ?? '')).map(node => {
    const url = new URL(attr(node, 'href'), shop.url);
    const match = url.pathname.match(/^\/buy\/([1-9]\d*)$/);
    if (!match || url.origin !== new URL(shop.url).origin || url.search || url.hash) fail('invalid product link');
    return match[1];
  });
  const ids = links(all), seen = new Set(ids);
  if (seen.size !== ids.length) fail('duplicate product ID');
  const grouped = new Set(nodes(container, node => /^group-\d+$/.test(attr(node, 'id') ?? '')).flatMap(links));
  if (grouped.size !== seen.size || [...grouped].some(value => !seen.has(value))) fail('incomplete category catalog');
  if (ids.length > 1000) fail('catalog limit exceeded');
  return ids;
}

async function readProduct(shop, productId, fetchImpl, signal) {
  const url = new URL(`/buy/${productId}`, shop.url).href;
  const document = await readHtml(url, fetchImpl, signal);
  const identity = nodes(document, node => node.tagName === 'input' && attr(node, 'name') === 'gid');
  const nameNode = nodes(document, node => node.tagName === 'h3' && hasClass(node, 'card-title'))[0];
  const name = clean(nameNode);
  if (identity.length !== 1 || attr(identity[0], 'value') !== productId || !name) fail('detail identity mismatch');
  const descriptionCard = nodes(document, node => hasClass(node, 'card') && (node.childNodes ?? []).some(child => hasClass(child, 'card-header') && clean(child) === '商品描述'))[0];
  const descriptionNode = nodes(descriptionCard ?? {}, node => hasClass(node, 'card-body'))[0];
  const description = clean(descriptionNode);
  const ratingText = captureRatingText(productId, serialize(nameNode), descriptionNode ? serialize(descriptionNode) : undefined);
  const image = attr(nodes(document, node => node.tagName === 'img' && hasClass(node, 'card-img-top'))[0], 'src');
  const imageUrl = image ? new URL(image, shop.url) : null;
  const skus = nodes(document, node => hasClass(node, 'formal-sku-btn'));
  const purchase = nodes(document, node => node.tagName === 'input' && attr(node, 'name') === 'by_amount');
  const minimum = purchase.length ? attr(purchase[0], 'min') ?? '1' : '1';
  if (purchase.length > 1 || !/^[1-9]\d*$/.test(minimum) || !Number.isSafeInteger(Number(minimum))) fail('invalid purchase minimum');
  const seen = new Set();
  const rows = skus.length ? skus : [null];
  return rows.map(sku => {
    const skuId = sku ? attr(sku, 'data-sku-id') : '';
    if (sku && (!positiveId(skuId) || seen.has(skuId))) fail('invalid or duplicate SKU ID');
    seen.add(skuId);
    const price = sku ? attr(sku, 'data-sku-price') : clean(nodes(document, node => attr(node, 'id') === 'display_price')[0]).match(/[￥¥]\s*(\d+(?:\.\d+)?)/)?.[1];
    if (!price || !/^\d+(?:\.\d+)?$/.test(price) || !Number.isFinite(Number(price))) fail('invalid price');
    const stock = sku ? attr(sku, 'data-sku-stock') : clean(nodes(document, node => attr(node, 'id') === 'stock_tips')[0]).match(/^库存[：:]\s*(\d+)$/)?.[1];
    if (stock === undefined || (stock !== '' && (!/^\d+$/.test(stock) || !Number.isSafeInteger(Number(stock))))) fail('invalid stock');
    const spec = sku ? normalizeSpec(clean(sku).replace(/\s*\([￥¥][^)]*\)(?:\s*\/\s*库存.*)?$/, '')) : '';
    if (sku && !spec) fail('invalid specification');
    const product = { externalId: sku ? `${productId}:${skuId}` : productId, name: `${name}${spec ? ` · ${spec}` : ''}`, spec,
      ...(ratingText ? { ratingText } : {}),
      ...rawProductContent(serialize(nameNode), descriptionNode ? serialize(descriptionNode) : undefined),
      sourceData: buildSourceEvidence({ description, ...(minimum === '1' ? {} : { minimum: Number(minimum) }) }), price, url,
      imageUrl: imageUrl && ['http:', 'https:'].includes(imageUrl.protocol) ? imageUrl.href : null,
      inStock: (stock === '' || Number(stock) >= Number(minimum)) && !hasClass(sku, 'disabled') };
    freshProducts.set(product, purchase.length <= 1 && minimum === '1');
    return product;
  });
}

export async function probe(shop, fetchImpl = globalThis.fetch) {
  const ids = catalog(await readHtml(shop.url, fetchImpl), shop);
  return ids.length ? (await readProduct(shop, ids[0], fetchImpl)).slice(0, 3) : [];
}

export async function crawl(_page, shop, fetchImpl = globalThis.fetch, options = {}) {
  const ids = catalog(await readHtml(shop.url, fetchImpl, options.signal), shop);
  const products = [];
  for (const productId of ids) products.push(...await readProduct(shop, productId, fetchImpl, options.signal));
  options.signal?.throwIfAborted();
  options.onListComplete?.();
  return settle(shop, products, fetchImpl, options);
}

export async function settle(shop, products, fetchImpl = globalThis.fetch, options = {}) {
  return collectSettlements(products, {
    quantity: product => freshProducts.get(product) === false ? undefined : 1,
    // User confirmed ouvg.top has no purchase surcharge; this does not apply to other classic storefronts.
    channel: async () => new URL(shop.url).origin === 'https://ouvg.top' ? { show_name: '支付宝（无手续费）' } : undefined,
    quote: async product => {
      let current = product;
      if (!freshProducts.has(product)) {
        const ids = String(product.externalId).split(':');
        const expected = new URL(`/buy/${ids[0]}`, shop.url);
        if (!positiveId(ids[0]) || ids.length > 2 || ids[1] !== undefined && !positiveId(ids[1])
          || new URL(product.url).href !== expected.href) return undefined;
        current = (await readProduct(shop, ids[0], fetchImpl, options.signal)).find(row => row.externalId === String(product.externalId));
        if (!current || !current.inStock || freshProducts.get(current) !== true
          || Number(current.price) !== Number(product.price)
          || !isDeepStrictEqual(normalizeProductEvidence({ ...current, sourceCategory: '' }),
            normalizeProductEvidence({ ...product, sourceCategory: '' }))) return undefined;
      }
      return { code: 1, data: { total_amount: current.price, quantity: 1 } };
    },
  }, options);
}

export default { id, name: '独角数卡经典版（Unicorn）', hosts: ['ouvg.top'], responseFormat: 'html', crawl, probe, settle };

import { buildSourceEvidence, captureRatingText, rawProductContent } from './source-evidence.js';
import { parse } from 'parse5';
import { collectSettlements, settlementCents } from './settlement.js';
import { isDeepStrictEqual } from 'node:util';
import { normalizeProductEvidence } from '../standardization/fingerprint.js';

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
  const text = await response.text();
  signal?.throwIfAborted();
  return text;
}

const attr = (node, name) => node?.attrs?.find(item => item.name === name)?.value;
const nodes = (node, test) => [...(test(node) ? [node] : []), ...(node.childNodes ?? []).flatMap(child => nodes(child, test))];
const text = node => !node || ['script', 'style'].includes(node.tagName) ? '' : node.nodeName === '#text' ? node.value : (node.childNodes ?? []).map(text).join('');

function checkoutQuote(html, slug) {
  if (!/<\/html>\s*$/i.test(html)) return undefined;
  const document = parse(html);
  if (nodes(document, node => attr(node, 'form') !== undefined).length) return undefined;
  const forms = nodes(document, node => node.tagName === 'form');
  if (forms.length !== 1) return undefined;
  const form = forms[0];
  if (attr(form, 'method')?.toUpperCase() !== 'POST' || attr(form, 'action') !== ''
    || nodes(form, node => node.tagName === 'fieldset' && attr(node, 'disabled') !== undefined).length) return undefined;
  const controls = nodes(form, node => ['input', 'select', 'textarea', 'button'].includes(node.tagName));
  if (controls.some(node => attr(node, 'name') === 'paymentIntent'
    && (node.tagName !== 'button' || attr(node, 'type') !== 'submit'))) return undefined;
  const field = name => {
    const matches = controls.filter(node => attr(node, 'name') === name);
    return matches.length === 1 && matches[0].tagName === 'input'
      && attr(matches[0], 'type') === 'hidden' && attr(matches[0], 'disabled') === undefined
      ? attr(matches[0], 'value') : undefined;
  };
  const refs = controls.map(node => attr(node, 'name')).filter(name => /^\$ACTION_REF_\d+$/.test(name ?? ''));
  if (refs.length !== 1 || field('quantity') !== '1' || field('couponCode') !== '') return undefined;
  const prefix = refs[0].replace('_REF_', '_');
  try {
    const action = JSON.parse(field(`${prefix}:0`));
    const bound = JSON.parse(field(`${prefix}:1`));
    if (!action?.id || action.bound !== '$@1' || !Array.isArray(bound) || bound.length !== 1 || bound[0] !== slug) return undefined;
  } catch { return undefined; }
  const quotes = [], seen = new Set();
  // Crypto buttons also display CNY equivalents; only the fiat checkout options are payable in CNY.
  for (const button of nodes(form, node => node.tagName === 'button' && attr(node, 'name') === 'paymentIntent')) {
    const method = { 'online:alipay': '支付宝', 'online:wxpay': '微信支付' }[attr(button, 'value')];
    if (!method || attr(button, 'disabled') !== undefined || attr(button, 'type') !== 'submit') continue;
    if (['formaction', 'formmethod', 'formenctype'].some(name => attr(button, name) !== undefined)) return undefined;
    if (seen.has(method)) return undefined;
    seen.add(method);
    const amounts = nodes(button, node => node.tagName === 'small');
    const match = amounts.length === 1 && text(amounts[0]).trim().match(/^[¥￥]((?:\d+|\d{1,3}(?:,\d{3})+)\.\d{2})\s*·\s*含手续费\s*[¥￥]((?:\d+|\d{1,3}(?:,\d{3})+)\.\d{2})$/u);
    if (!match) return undefined;
    const total = match[1].replaceAll(',', ''), fee = settlementCents(match[2].replaceAll(',', ''));
    const cents = settlementCents(total);
    if (cents === undefined || cents <= 0n || fee === undefined || fee > cents) return undefined;
    quotes.push({ cents, code: 1, paymentMethod: method, data: { total_amount: total, quantity: 1 } });
  }
  return quotes.sort((a, b) => a.cents < b.cents ? -1 : a.cents > b.cents ? 1 : 0)[0];
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
  return settle(shop, products, fetchImpl, options, true);
}

export async function settle(shop, products, fetchImpl = globalThis.fetch, options = {}, detailsAreFresh = false) {
  const origin = new URL(shop.url).origin;
  return collectSettlements(products, {
    quantity: () => 1,
    channel: async () => ({}),
    quote: async product => {
      const slug = String(product.externalId);
      if (!/^[A-Za-z0-9_-]+$/.test(slug) || product.spec || product.url !== `${origin}/products/${slug}`) return undefined;
      if (!detailsAreFresh) {
        const fresh = parseProduct(await readText(product.url, fetchImpl, options.signal), slug, origin);
        if (!fresh.inStock) throw Object.assign(new Error('xingbao product out of stock'), { name: 'ProductOutOfStockError' });
        if (Number(product.price) !== Number(fresh.price)
          || !isDeepStrictEqual(normalizeProductEvidence({ ...fresh, ...product }), normalizeProductEvidence(fresh))) return undefined;
      }
      return checkoutQuote(await readText(`${origin}/checkout/${slug}`, fetchImpl, options.signal), slug);
    },
  }, options);
}

// Detection scopes requests to the shop origin and rejects non-HTML responses, so the sitemap is crawl-only.
export async function probe(shop, fetchImpl = globalThis.fetch) {
  const origin = new URL(shop.url).origin;
  const html = await readText(origin + '/', fetchImpl);
  const slug = [...html.matchAll(/\/products\/([A-Za-z0-9_-]+)/g)].map(match => match[1]).find(Boolean);
  if (!slug) fail('no product links');
  return [parseProduct(await readText(`${origin}/products/${slug}`, fetchImpl), slug, origin)];
}

export default { id, name: '星星小店（schema.org）', hosts: ['xingbao-ai.shop'], responseFormat: 'html', crawl, probe, settle };

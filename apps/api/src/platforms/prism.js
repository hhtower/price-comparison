import { buildSourceEvidence, captureRatingText, rawProductContent } from './source-evidence.js';
import { collectSettlements } from './settlement.js';

export const id = 'prism';
// shortcut: Official-reference FX feed; single-rate USDT≈USD→CNY estimate authorized by ops 2026-10-24, no on-site checkout exists.
export const FX_URL = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/cny.json';
const fail = message => { throw new Error(`${id} goods API: ${message}`); };

async function readJson(url, fetchImpl, signal) {
  signal?.throwIfAborted();
  const response = await fetchImpl(url, { headers: { accept: 'application/json' }, redirect: 'error', ...(signal ? { signal } : {}) });
  if (!response.ok) {
    const error = new Error(`${id} goods API: HTTP ${response.status}`);
    if ([403, 429].includes(response.status)) error.name = 'CrawlerBlockedError';
    throw error;
  }
  return response.json();
}

async function readCatalog(shop, fetchImpl, signal) {
  const payload = await readJson(new URL('/api/catalog', shop.url).href, fetchImpl, signal);
  const items = payload?.products;
  if (!Array.isArray(items)) fail('invalid response');
  const seen = new Set();
  for (const item of items) {
    if (!item || !Number.isSafeInteger(item.id) || item.id < 1 || typeof item.name !== 'string' || !item.name.trim()
      || !Number.isSafeInteger(item.price) || item.price < 0 || !Number.isSafeInteger(item.stock) || item.stock < 0) fail('invalid product');
    if (seen.has(item.id)) fail('duplicate product ID');
    seen.add(item.id);
  }
  return items;
}

// The feed quotes USD per 1 CNY; keep it exact as a scaled BigInt to avoid float drift.
function parseRate(usd) {
  if ((typeof usd !== 'string' && typeof usd !== 'number') || !/^\d+(?:\.\d{1,12})?$/.test(String(usd))) fail('invalid exchange rate');
  const [whole, fraction = ''] = String(usd).split('.');
  const scaled = BigInt(whole + fraction);
  if (scaled <= 0n) fail('invalid exchange rate');
  return { scaled, digits: BigInt(fraction.length) };
}

async function usdtCnyRate(fetchImpl, signal, injected) {
  return injected ? parseRate(injected) : parseRate((await readJson(FX_URL, fetchImpl, signal))?.cny?.usd);
}

/** The crawler egress cannot reach the FX feed; reuse the official-reference snapshot instead. */
export async function latestCnyPerUsd(db) {
  const row = await db.selectFrom('official_reference_jobs').select('snapshot').where('task_key', '=', 'fx').orderBy('id', 'desc').executeTakeFirst();
  const usd = row?.snapshot?.cny?.usd;
  return typeof usd === 'number' && usd > 0 ? String(usd) : undefined;
}

// cents = micro / 1e6 / usdPerCny * 100, half-up once.
function cnyCents(micro, rate) {
  const numerator = micro * 10n ** (rate.digits + 2n), denominator = rate.scaled * 1000000n;
  return (numerator + denominator / 2n) / denominator;
}

const centsText = cents => `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;

export async function crawl(_page, shop, fetchImpl = globalThis.fetch, options = {}) {
  options.signal?.throwIfAborted();
  const items = await readCatalog(shop, fetchImpl, options.signal);
  const rate = await usdtCnyRate(fetchImpl, options.signal, options.cnyPerUsd);
  const products = items.map(item => ({
    externalId: String(item.id),
    name: item.name.trim(),
    spec: '',
    ...rawProductContent(item.name, item.description),
    ratingText: captureRatingText(item.id, item.name, item.description),
    sourceData: buildSourceEvidence({ description: item.description, microPrice: item.price }),
    price: centsText(cnyCents(BigInt(item.price), rate)),
    url: new URL(shop.url).href,
    imageUrl: typeof item.image === 'string' && item.image ? new URL(item.image, shop.url).href : null,
    inStock: item.stock > 0,
  }));
  options.signal?.throwIfAborted();
  options.onListComplete?.();
  return settle(shop, products, fetchImpl, options);
}

export async function settle(_shop, products, fetchImpl = globalThis.fetch, options = {}) {
  options.signal?.throwIfAborted();
  let rate;
  return collectSettlements(products, {
    quantity: () => 1,
    channel: async () => { rate = await usdtCnyRate(fetchImpl, options.signal, options.cnyPerUsd); return { show_name: 'USDT 汇率折算（预估）' }; },
    quote: product => {
      const micro = product.sourceData?.microPrice;
      if (!Number.isSafeInteger(micro) || micro < 0) return undefined;
      return { code: 1, paymentMethod: 'USDT 汇率折算（预估）', data: { total_amount: centsText(cnyCents(BigInt(micro), rate)), quantity: 1 } };
    },
  }, options);
}

const microUsdt = micro => { const cents = (micro * 100n + 500000n) / 1000000n; return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`; };

// Detection scopes requests to the shop origin, so the preview keeps raw USDT prices without the cross-origin FX fetch.
export async function probe(shop, fetchImpl = globalThis.fetch) {
  const items = await readCatalog(shop, fetchImpl);
  return items.slice(0, 3).map(item => ({ externalId: String(item.id), name: item.name.trim(), spec: '', price: microUsdt(BigInt(item.price)), url: new URL(shop.url).href, inStock: item.stock > 0 }));
}

export default { id, name: '棱镜货源（USDT 折算）', hosts: ['shop.558686.xyz'], crawl, probe, settle };

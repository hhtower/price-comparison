import { buildSourceEvidence, captureRatingText, rawProductContent } from './source-evidence.js';
import { collectSettlements, minimumPurchaseQuantity, settlementJson } from './settlement.js';
import { isDeepStrictEqual } from 'node:util';
import { normalizeProductEvidence } from '../standardization/fingerprint.js';
import { specificationText } from '../products/product-spec.js';

export const id = 'public-products-v1';
const PAGE_SIZE = 12;
const MAX_PAGES = 1000;
const STOCK_STATUSES = ['in_stock', 'out_of_stock', 'low_stock', 'unlimited'];
const fail = message => { throw new Error(`${id} goods API: ${message}`); };
const validId = value => (typeof value === 'string' && value.trim().length > 0) || (Number.isSafeInteger(value) && value > 0);
const productRules = new WeakMap();

function localized(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  return [value['zh-CN'], value['zh-TW'], value['en-US'], ...Object.values(value)]
    .find(text => typeof text === 'string' && text.trim())?.trim() ?? '';
}

function rawLocalized(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const texts = [value['zh-CN'], value['zh-TW'], value['en-US'], ...Object.values(value)];
  return texts.find(text => typeof text === 'string' && text.trim())
    ?? texts.find(text => typeof text === 'string');
}

async function readJson(url, fetchImpl, signal) {
  signal?.throwIfAborted();
  const response = await fetchImpl(url, { headers: { accept: 'application/json' }, redirect: 'error', ...(signal ? { signal } : {}) });
  if (!response.ok) {
    const error = new Error(`${id} goods API: HTTP ${response.status}`);
    if ([403, 429].includes(response.status)) error.name = 'CrawlerBlockedError';
    throw error;
  }
  const payload = await response.json();
  if (payload?.status_code !== 0) fail('invalid response');
  return payload;
}

async function readPage(shop, page, fetchImpl, signal) {
  const url = new URL('/api/v1/public/products', shop.url);
  url.searchParams.set('page', String(page));
  url.searchParams.set('page_size', String(PAGE_SIZE));
  const payload = await readJson(url.href, fetchImpl, signal);
  const meta = payload.pagination;
  if (!Array.isArray(payload.data) || !meta || meta.page !== page
    || !Number.isSafeInteger(meta.page_size) || meta.page_size < 1
    || !Number.isSafeInteger(meta.total) || meta.total < 0
    || !Number.isSafeInteger(meta.total_page) || meta.total_page < 0 || meta.total_page > MAX_PAGES
    || (meta.total > 0 && (meta.total_page < page || !payload.data.length))
    || (meta.total === 0 && (meta.total_page > 1 || payload.data.length > 0))) fail('invalid pagination');
  for (const item of payload.data) validateProduct(item);
  if (new Set(payload.data.map(item => String(item.id))).size !== payload.data.length) fail('duplicate product ID');
  return { items: payload.data, total: meta.total, pages: meta.total_page };
}

function validateProduct(item) {
  if (!item || !validId(item.id) || typeof item.slug !== 'string' || !item.slug.trim()
    || !localized(item.title) || !Array.isArray(item.skus) || !item.skus.length) fail('invalid product');
}

async function readDetail(shop, listing, fetchImpl, signal) {
  const url = new URL(`/api/v1/public/products/${encodeURIComponent(listing.slug)}`, shop.url);
  const { data } = await readJson(url.href, fetchImpl, signal);
  validateProduct(data);
  if (String(data.id) !== String(listing.id) || data.slug !== listing.slug) fail('detail identity mismatch');
  return normalizeProduct(data, shop);
}

function normalizeProduct(item, shop) {
  const ids = new Set();
  const result = [];
  const ratingText = captureRatingText(item.id, rawLocalized(item.title), rawLocalized(item.description), rawLocalized(item.content));
  for (const sku of item.skus) {
    if (!sku || !validId(sku.id) || typeof sku.is_active !== 'boolean') fail('invalid SKU');
    if (ids.has(String(sku.id))) fail('duplicate SKU ID');
    ids.add(String(sku.id));
    if (!sku.is_active) continue;
    if ((sku.stock_status !== undefined && !STOCK_STATUSES.includes(sku.stock_status))
      || (sku.is_sold_out !== undefined && typeof sku.is_sold_out !== 'boolean')
      || (item.is_sold_out !== undefined && typeof item.is_sold_out !== 'boolean')
      || (item.stock_status !== undefined && !STOCK_STATUSES.includes(item.stock_status))) fail('invalid stock status');
    let available = sku.stock_status !== 'out_of_stock';
    if (sku.stock_status === undefined) {
      const quantity = item.fulfillment_type === 'manual' ? sku.manual_stock_total
        : item.fulfillment_type === 'auto' ? sku.auto_stock_available : undefined;
      if (!Number.isSafeInteger(quantity) || quantity < -1) fail('invalid legacy SKU stock');
      available = quantity !== 0;
    }
    const price = typeof sku.price_amount === 'string' || typeof sku.price_amount === 'number' ? String(sku.price_amount).trim() : '';
    if (!price || !Number.isFinite(Number(price)) || Number(price) < 0) fail('invalid SKU price');
    if (!sku.spec_values || typeof sku.spec_values !== 'object' || Array.isArray(sku.spec_values)) fail('invalid SKU specifications');
    const entries = Object.entries(sku.spec_values);
    const translations = entries.length && entries.every(([key]) => /^[a-z]{2}-[A-Z]{2}$/.test(key));
    if (translations && (entries.some(([, value]) => typeof value !== 'string') || !localized(sku.spec_values))) fail('invalid SKU specification value');
    const specs = translations
      ? localized(sku.spec_values) : entries.map(([key, value]) => {
      const text = localized(value);
      if (!text) fail('invalid SKU specification value');
      return { name: key, value: text };
    });
    const spec = specificationText(specs);
    const suffix = spec;
    const sourceData = buildSourceEvidence({
      description: localized(item.description), content: localized(item.content),
      ...(item.min_purchase_quantity > 1 ? { min_purchase_quantity: item.min_purchase_quantity } : {}),
    });
    const image = Array.isArray(item.images) && typeof item.images[0] === 'string' ? new URL(item.images[0], shop.url) : null;
    const product = {
      externalId: `${item.id}:${sku.id}`, name: `${localized(item.title)}${suffix ? ` · ${suffix}` : ''}`, spec,
      ...(ratingText ? { ratingText } : {}),
      ...rawProductContent(rawLocalized(item.title), rawLocalized(item.description), rawLocalized(item.content)),
      sourceCategory: localized(item.category?.name), sourceData, price,
      url: new URL(`/products/${encodeURIComponent(item.slug)}`, shop.url).href,
      imageUrl: image && ['https:', 'http:'].includes(image.protocol) ? image.href : null,
      inStock: item.is_sold_out !== true && item.stock_status !== 'out_of_stock' && sku.is_sold_out !== true && available,
    };
    productRules.set(product, item);
    result.push(product);
  }
  Object.defineProperty(result, 'ratingUnits', { value: [{ unitId: String(item.id), hash: ratingText?.hash ?? null }] });
  return result;
}

export async function probe(shop, fetchImpl = globalThis.fetch) {
  const first = await readPage(shop, 1, fetchImpl);
  // A probe is a preview only. It is never passed to snapshot synchronization.
  return first.items.length ? (await readDetail(shop, first.items[0], fetchImpl)).slice(0, 3) : [];
}

export async function crawl(_page, shop, fetchImpl = globalThis.fetch, options = {}) {
  const result = [], seen = new Set(), slugs = new Set();
  const ratingUnits = [];
  let expected;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await readPage(shop, page, fetchImpl, options.signal);
    expected ??= batch;
    if (batch.total !== expected.total || batch.pages !== expected.pages) fail('pagination changed during crawl');
    for (const item of batch.items) {
      if (seen.has(String(item.id)) || slugs.has(item.slug)) fail('duplicate product across pages');
      seen.add(String(item.id)); slugs.add(item.slug);
      const rows = await readDetail(shop, item, fetchImpl, options.signal);
      result.push(...rows);
      ratingUnits.push(...rows.ratingUnits);
    }
    if (page >= batch.pages) {
      if (seen.size !== batch.total) fail('incomplete snapshot');
      options.signal?.throwIfAborted();
      options.onListComplete?.();
      Object.defineProperty(result, 'ratingUnits', { value: ratingUnits });
      return settle(shop, result, fetchImpl, options, true);
    }
  }
  fail('pagination limit exceeded');
}

export const purchaseQuantity = product => {
  const rules = productRules.get(product) ?? product.sourceData;
  return rules?.min_purchase_quantity === 0 ? 1 : minimumPurchaseQuantity(rules, 'min_purchase_quantity');
};
export const paymentChannelIds = product => (productRules.get(product) ?? product.sourceData)?.payment_channel_ids;
const LEGACY_VERSIONS = new Set(['v1.0.0', 'v1.0.5', 'v1.2.2', 'v1.3.1']);
const SUPPORTED_VERSIONS = new Set([...LEGACY_VERSIONS, 'v1.4.6', 'v1.4.8', 'v1.4.9', 'v1.5.0']);
// shortcut: Exact configurations calibrated by unpaid checkouts; recheck if private conversion changes.
const VERIFIED_EPAY_CHECKOUTS = {
  'https://kkfaka.xyz': { version: 'v1.5.0', id: 4, policy: 'customer_surcharge', rate: '5.00', fixed: '0.00' },
};
// shortcut: Authorized public-price estimates exclude discounts and FX; replace with final checkout evidence when available.
const ESTIMATED_FEES = {
  'https://morimm.com': 400n,
  'https://blog.esfine.chat': 160n,
  'https://tghaopifa.cc': 400n,
  'https://ultra.makelove.cloud': 150n,
  'https://kapay.shop': 0n,
};
function cents(value) {
  if (!['number', 'string'].includes(typeof value) || !/^\d{1,12}(?:\.\d{1,2})?$/.test(String(value))) return undefined;
  const [integer, fraction = ''] = String(value).split('.');
  return BigInt(integer) * 100n + BigInt(fraction.padEnd(2, '0'));
}
const amount = value => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;

function paymentTotal(base, channel, version) {
  const legacy = LEGACY_VERSIONS.has(version);
  const surcharge = legacy || channel.fee_policy === 'customer_surcharge';
  if (channel.fee_policy !== undefined && channel.fee_policy !== 'customer_surcharge') return undefined;
  if (!legacy && !surcharge && (channel.fee_rate !== undefined || channel.fixed_fee !== undefined)) return undefined;
  const rate = cents(channel.fee_rate ?? (surcharge ? undefined : '0'));
  const fixed = cents(channel.fixed_fee ?? (surcharge ? undefined : '0'));
  if (rate === undefined || fixed === undefined || rate > 10000n || fixed >= 1000000n) return undefined;
  // Audited release payment_service.go/payment_service_rules.go: round half up once after adding fixed + percentage fees.
  return base + (surcharge ? fixed + (base * rate + 5000n) / 10000n : 0n);
}

export async function settle(shop, products, fetchImpl = globalThis.fetch, options = {}, detailsAreFresh = false) {
  options.signal?.throwIfAborted();
  const origin = new URL(shop.url).origin, confirmedCC = origin === 'https://cccrad.uk';
  const verifiedCheckout = VERIFIED_EPAY_CHECKOUTS[origin];
  const estimatedFee = ESTIMATED_FEES[origin];
  const matchesCheckout = channel => verifiedCheckout && config?.app_version === verifiedCheckout.version
    && channel.id === verifiedCheckout.id && channel.provider_type === 'epay' && channel.channel_type === 'alipay'
    && channel.fee_policy === verifiedCheckout.policy && channel.fee_rate === verifiedCheckout.rate && channel.fixed_fee === verifiedCheckout.fixed;
  let confirmedGogo = false;
  const errors = new Map(), cached = new Set(), freshProducts = new Map(detailsAreFresh ? products.map(product => [product, product]) : []), deferred = new Set();
  const limit = options.maxSettlementProducts ?? Infinity;
  if (limit !== Infinity && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('maxSettlementProducts must be a positive integer');
  let attempted = 0, stopped;
  for (const product of products) {
    if (!product.inStock || options.settlementProductIds && !options.settlementProductIds.has(String(product.externalId))) continue;
    if (options.needsSettlement && !options.needsSettlement(product, purchaseQuantity(product) ?? 1)) { cached.add(product); continue; }
    if (attempted++ >= limit) { deferred.add(product); continue; }
    if (detailsAreFresh) continue;
    try {
      options.signal?.throwIfAborted();
      if (stopped) throw stopped;
      const url = new URL(product.url, shop.url), origin = new URL(shop.url).origin;
      const ids = String(product.externalId).split(':');
      if (url.origin !== origin || !/^\/products\/[^/]+$/.test(url.pathname) || ids.length !== 2) fail('invalid settlement identity');
      const fresh = (await readDetail(shop, { id: ids[0], slug: decodeURIComponent(url.pathname.slice('/products/'.length)) }, fetchImpl, options.signal))
        .find(row => row.externalId === String(product.externalId));
      if (!fresh || !fresh.inStock || Number(product.price) !== Number(fresh.price)
        || !isDeepStrictEqual(normalizeProductEvidence({ ...fresh, ...product }), normalizeProductEvidence(fresh))) continue;
      freshProducts.set(product, fresh);
      productRules.set(product, productRules.get(fresh));
    } catch (error) {
      options.signal?.throwIfAborted();
      if (['CrawlerBlockedError', 'ProxyAuthenticationError'].includes(error.name)) stopped = error;
      errors.set(product, error);
    }
  }
  let config;
  return collectSettlements(products, {
    quantity: purchaseQuantity,
    channel: async () => {
      if (stopped) throw stopped;
      ({ data: config } = await readJson(new URL('/api/v1/public/config', shop.url).href, fetchImpl, options.signal));
      // This exact native Alipay build returned CNY payable=2.50, fee=0.00 in one unpaid checkout on 2026-10-17.
      confirmedGogo = new URL(shop.url).origin === 'https://pay.gogo77.top' && config?.app_version === 'v1.4.8-open-alipay-1';
      return config && (SUPPORTED_VERSIONS.has(config.app_version) || confirmedGogo || estimatedFee !== undefined) && config.currency === 'CNY' && !config.wallet_only_payment
        && Array.isArray(config.payment_channels) ? { show_name: '公开支付渠道' } : undefined;
    },
    quote: async (product, _channel, quantity) => {
      if (errors.has(product)) throw errors.get(product);
      if (!freshProducts.has(product) || deferred.has(product)) return undefined;
      const source = productRules.get(freshProducts.get(product)), ids = String(product.externalId).split(':').map(Number);
      if (!(source?.purchase_type === 'guest' || estimatedFee !== undefined && source?.purchase_type === 'member')
        || ids.length !== 2 || ids.some(value => !Number.isSafeInteger(value) || value < 1)) return undefined;
      const maxQuantity = source.max_purchase_quantity;
      if (maxQuantity !== undefined && (!Number.isSafeInteger(maxQuantity) || maxQuantity < 0 || maxQuantity > 0 && maxQuantity < quantity)) return undefined;
      if (estimatedFee !== undefined) {
        const unit = cents(freshProducts.get(product).price);
        if (unit === undefined) return undefined;
        const base = unit * BigInt(quantity);
        if (origin === 'https://morimm.com' && base < 100n) return undefined;
        const rate = origin === 'https://morimm.com' && base > 50000n ? 0n : estimatedFee;
        return { code: 1, paymentMethod: '店铺规则（预估）',
          data: { total_amount: amount(base + (base * rate + 5000n) / 10000n), quantity } };
      }
      const allowed = source.payment_channel_ids;
      if (allowed !== undefined && (!Array.isArray(allowed) || allowed.some(value => !Number.isSafeInteger(value) || value < 1))) return undefined;
      const channels = config.payment_channels.filter(channel => Number.isSafeInteger(channel.id) && channel.id > 0
        && typeof channel.name === 'string' && channel.name.trim()
        && (!confirmedGogo || channel.id === 2 && channel.provider_type === 'official' && channel.channel_type === 'alipay'
          && ['fee_policy', 'fee_rate', 'fixed_fee'].every(field => channel[field] === undefined))
        // Only confirmed Epay configurations can supplement the native CNY channels.
        && (channel.provider_type === 'official' && ['alipay', 'wechat'].includes(channel.channel_type)
          || confirmedCC && channel.provider_type === 'epay' && channel.channel_type === 'alipay'
            && channel.fee_policy === 'customer_surcharge' && cents(channel.fee_rate) === 295n && cents(channel.fixed_fee) === 0n
          || matchesCheckout(channel))
        && (!allowed?.length || allowed.includes(channel.id)));
      if (!channels.length) return undefined;
      const payload = await settlementJson(await fetchImpl(new URL('/api/v1/guest/orders/preview', shop.url).href, {
        method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, redirect: 'error',
        ...(options.signal ? { signal: options.signal } : {}),
        body: JSON.stringify({ email: 'price-preview@example.invalid', order_password: 'preview-only-no-order', items: [{ product_id: ids[0], sku_id: ids[1], quantity }] }),
      }));
      const data = payload?.data, item = data?.items?.[0], base = cents(data?.total_amount);
      if (payload?.status_code !== 0 || data?.currency !== 'CNY' || base === undefined || !Array.isArray(data.items) || data.items.length !== 1
        || item.product_id !== ids[0] || item.sku_id !== ids[1] || item.quantity !== quantity) return undefined;
      for (const channel of channels) {
        const min = cents(channel.min_amount), max = cents(channel.max_amount), total = paymentTotal(base, channel, config.app_version);
        if (min === undefined || max === undefined || total === undefined || min > base || max > 0n && max < base) continue;
        return { code: 1, paymentMethod: channel.name, data: { total_amount: amount(total), quantity } };
      }
      return undefined;
    },
  }, { ...options, needsSettlement: product => !cached.has(product), onSettlementResult: result => {
    const product = products.find(row => String(row.externalId) === result.externalId);
    options.onSettlementResult?.(deferred.has(product) && result.reason === 'invalid_quote'
      ? { ...result, status: 'skipped', reason: 'deferred', retryable: false } : result);
  } });
}

export default { id, name: 'Dujiao-Next（独角数卡）', hosts: [
  'suqiai.cc', 'cccrad.uk', 'ultra.makelove.cloud', 'shop.txyxt.dpdns.org', 'zhang520.store',
  'kapay.shop', 'burstpro-ai.online', 'morimm.com', 'shop.aictk.shop', 'faka.getmodel.net',
  'gpthub.ciyuanapi.ai', 'pay.gogo77.top', 'shop.huashengg.com', 'buy.aixou.top', 'sim.pst1.top',
  'kkfaka.xyz', 'lu-box.me', 'blog.esfine.chat', 'xxxyan.cc',
], crawl, probe, settle, purchaseQuantity };

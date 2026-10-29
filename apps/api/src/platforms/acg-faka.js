import { buildSourceEvidence, captureRatingText, rawProductContent } from './source-evidence.js';
import { isDeepStrictEqual } from 'node:util';
import { collectSettlements, minimumPurchaseQuantity, settlementJson } from './settlement.js';
import { normalizeProductEvidence } from '../standardization/fingerprint.js';
import { specificationText } from '../products/product-spec.js';

export const id = 'acg-faka';
const PAGE_SIZE = 12, MAX_PAGES = 1000;
const fail = message => { throw new Error(`${id} goods API: ${message}`); };
const unavailable = () => { throw Object.assign(new Error(`${id} goods API: product unavailable`), { name: 'ProductUnavailableError' }); };
const isUnavailable = payload => payload?.code === 0 && ['商品不存在', '商品已下架', '商品已经下架'].includes(payload.msg);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const estimatedGuestShop = url => { try { return new URL(url).origin === 'https://shopcardai.click'; } catch { return false; } };
const productId = value => Number.isSafeInteger(value) && value > 0;
const price = value => {
  const text = ['string', 'number'].includes(typeof value) ? String(value).trim() : '';
  if (!/^\d+(?:\.\d+)?$/.test(text) || !Number.isFinite(Number(text))) fail('invalid price');
  return text;
};

async function read(shop, path, fetchImpl, options, form) {
  options.signal?.throwIfAborted();
  const response = await fetchImpl(new URL(path, shop.url).href, {
    headers: { accept: 'application/json', ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    redirect: 'error', ...(options.signal ? { signal: options.signal } : {}),
    ...(form ? { method: 'POST', body: form.toString() } : {}),
  });
  if (!response.ok) fail(`HTTP ${response.status}`);
  const payload = await response.json();
  options.signal?.throwIfAborted();
  if ((path.startsWith('/user/api/index/commodityDetail?') || ['/user/api/index/stock', '/user/api/index/valuation'].includes(path))
    && isUnavailable(payload)) unavailable();
  // 附带原始 payload: 调用方需区分"规格级不存在"与真异常(见 normalize)
  if (payload?.code !== 200) throw Object.assign(new Error(`${id} goods API: invalid response`), { payload });
  return payload;
}

async function page(shop, current, fetchImpl, options) {
  const payload = await read(shop, `/user/api/index/commodity?page=${current}&limit=${PAGE_SIZE}`, fetchImpl, options);
  if (!Array.isArray(payload.data) || !Number.isSafeInteger(payload.total) || payload.total < 0
    || payload.total > PAGE_SIZE * MAX_PAGES || payload.data.length > PAGE_SIZE || payload.data.length > payload.total) fail('invalid pagination');
  for (const item of payload.data) {
    if (!productId(item?.id) || typeof item.name !== 'string' || !item.name.trim() || ![0, 1].includes(item.status)) fail('invalid product');
  }
  if (new Set(payload.data.map(item => item.id)).size !== payload.data.length) fail('duplicate product ID');
  return payload;
}

function validateListings(payload) {
  if (!Array.isArray(payload?.data)) fail('invalid pagination');
  for (const item of payload.data) {
    if (!productId(item?.id) || typeof item.name !== 'string' || !item.name.trim() || ![0, 1].includes(item.status)) fail('invalid product');
  }
  return payload;
}

async function categoryPage(shop, categoryId, current, fetchImpl, options) {
  // 首次请求复刻站点前端(裸 categoryId 不带分页),补页时才加 page/limit
  const query = `categoryId=${categoryId}` + (current > 1 ? `&page=${current}&limit=${PAGE_SIZE}` : '');
  return validateListings(await read(shop, `/user/api/index/commodity?${query}`, fetchImpl, options));
}

/**
 * 站点平铺分页存在窗口错位(实测 aizzx.me/accharbor.com 同商品跨页重复、AccHarbor 平铺仅 107/179)
 * 且 total 按请求波动(aiaimallss.cn 45↔42),平铺视图不可作完整快照。
 * 因此优先复刻前端行为: /data 分类清单 + 逐类列表;/data 不可用或为空时回退平铺并去重。
 * 完成度经 options.onListStats 上报,不再以整轮失败换取静默完整性。
 */
async function discoverListings(shop, fetchImpl, options) {
  const collected = new Map();
  let duplicates = 0;
  const add = items => { for (const item of items) { if (collected.has(item.id)) duplicates++; else collected.set(item.id, item); } };
  let categories = null, categoryClaims = null, flatTotal = null;
  try {
    const payload = await read(shop, '/user/api/index/data', fetchImpl, options);
    if (Array.isArray(payload?.data)) {
      const active = payload.data.filter(cat => productId(cat?.id)
        && Number.isSafeInteger(cat?.commodity_count) && cat.commodity_count > 0);
      categories = active.length;
      categoryClaims = active.reduce((sum, cat) => sum + cat.commodity_count, 0);
      for (const cat of active) {
        const first = await categoryPage(shop, cat.id, 1, fetchImpl, options);
        add(first.data);
        // 返回数少于声称值时按分页补抓,防大分类被默认 limit 截断
        if (first.data.length < cat.commodity_count) {
          for (let current = 2; current <= Math.max(2, Math.ceil(cat.commodity_count / PAGE_SIZE)); current++) {
            const batch = await categoryPage(shop, cat.id, current, fetchImpl, options);
            if (!batch.data.length) break;
            add(batch.data);
          }
        }
      }
    }
  } catch (error) {
    if (options.signal?.aborted) throw error;
    // 分类视图不可用(旧版主题/接口缺失): 回退平铺
  }
  if (!collected.size) {
    for (let current = 1; current <= MAX_PAGES; current++) {
      const batch = await page(shop, current, fetchImpl, options);
      flatTotal = Math.max(flatTotal ?? 0, batch.total);
      const before = collected.size;
      add(batch.data);
      if (!batch.data.length) break;
      // total 波动不作硬性对账: 收满声称数,或超过估算页数且本页无新增即止
      if (current >= Math.ceil(flatTotal / PAGE_SIZE) && (collected.size === before || collected.size >= flatTotal)) break;
    }
  }
  options.onListStats?.({ unique: collected.size, duplicates, categories, categoryClaims, flatTotal });
  return [...collected.values()];
}

function combinations(config) {
  if (!object(config) && !(Array.isArray(config) && config.length === 0)) fail('invalid specification configuration');
  const choices = value => {
    if (value === undefined || (Array.isArray(value) && value.length === 0)) return [];
    if (!object(value)) fail('invalid specification choices');
    return Object.entries(value).map(([name, amount]) => {
      if (!name.trim()) fail('invalid specification label');
      price(amount);
      return name;
    });
  };
  const races = choices(config.category);
  let result = (races.length ? races : ['']).map(race => ({ race, sku: {} }));
  if (config.sku !== undefined && !(Array.isArray(config.sku) && !config.sku.length) && !object(config.sku)) fail('invalid SKU groups');
  for (const [group, values] of Object.entries(config.sku ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const names = choices(values).sort();
    if (!group.trim() || !names.length) fail('incomplete SKU group');
    if (result.length * names.length > 64) fail('specification combination limit exceeded');
    result = result.flatMap(selected => names.map(value => ({ race: selected.race, sku: { ...selected.sku, [group]: value } })));
  }
  // ponytail: bound public variant enumeration; raise only with a measured request budget.
  if (result.length > 64) fail('specification combination limit exceeded');
  return result;
}

async function normalize(shop, listing, fetchImpl, options, preview = false, settlementProduct, freshProducts) {
  const { data: item } = await read(shop, `/user/api/index/commodityDetail?commodityId=${listing.id}`, fetchImpl, options);
  if (item?.id === listing.id && (item.status === 0 || item.draft_status === 1)) unavailable();
  if (!item || item.id !== listing.id || typeof item.name !== 'string' || !item.name.trim()
    || item.status !== 1 || ![0, 1].includes(item.inventory_hidden)
    || !Number.isSafeInteger(item.minimum) || item.minimum < 0 || item.draft_status !== 0) fail('invalid or unsupported detail');
  const selections = combinations(item.config), result = [];
  const ratingText = captureRatingText(item.id, item.name, item.description);
  const guestEstimate = estimatedGuestShop(shop.url);
  if (settlementProduct && (item.only_user === 1 && !guestEstimate || item.purchase_count > 0
    || (item.maximum > 0 && Math.max(1, item.minimum) > item.maximum))) unavailable();
  // Probe results are only a preview, never a complete snapshot: one list, one detail, two pairs of reads.
  for (const selected of preview ? selections.slice(0, 2) : selections) {
    const originalSpec = [selected.race ? `类型: ${selected.race}` : '', ...Object.entries(selected.sku).map(([group, value]) => `${group}: ${value}`)].filter(Boolean).join(' / ');
    const externalId = String(item.id) + (originalSpec ? `:${encodeURIComponent(JSON.stringify(selected))}` : '');
    const spec = specificationText([
      ...(selected.race ? [{ name: '类型', value: selected.race }] : []),
      ...Object.entries(selected.sku).map(([name, value]) => ({ name: `规格.${name}`, value })),
    ]);
    if (settlementProduct && externalId !== String(settlementProduct.externalId)) continue;
    const form = new URLSearchParams({ item_id: String(item.id), num: '1' });
    if (selected.race) form.set('race', selected.race);
    for (const [group, value] of Object.entries(selected.sku)) form.set(`sku[${group}]`, value);
    let stock, quote;
    try {
      ({ data: stock } = await read(shop, '/user/api/index/stock', fetchImpl, options, form));
      ({ data: quote } = await read(shop, '/user/api/index/valuation', fetchImpl, options, form));
    } catch (error) {
      // 站长已删的类型选项仍挂在商品上(实测 fk.ybkjs.top 商品21「质保」: code 0 此商品类型不存在):
      // 跳过该规格,商品其余规格照常采集,不再整轮失败
      if (error?.payload?.code === 0 && /此商品类型不存在/.test(String(error.payload?.msg ?? ''))) continue;
      throw error;
    }
    const raw = stock?.stock, state = stock?.stock_state;
    // 部分站点 state=0 时 stock 返回 ""/null(实测 web3chirou.com id49/52/186): 按 0 库存处理
    const missing = !(typeof raw === 'number' || (typeof raw === 'string' && raw.trim()));
    const count = missing ? (state === 0 ? 0 : NaN) : Number(raw);
    // Hidden-inventory counts are decorative (aizzx.me reports 9999767 under a 1–5 band); the public band stays authoritative.
    const hidden = item.inventory_hidden === 1, counted = Number.isFinite(count) && !hidden ? count : NaN;
    if (!Number.isInteger(state) || state < 0 || state > 4
      || (!Number.isSafeInteger(count) && !(Number.isNaN(count) && hidden && typeof raw === 'string' && raw.trim()))) fail('invalid stock');
    const lower = [0, 1, 6, 21, 101][state], upper = [0, 5, 20, 100, Infinity][state];
    const minimum = Math.max(1, item.minimum);
    if ((Number.isFinite(counted) && (counted < lower || counted > upper))
      || (Number.isNaN(counted) && minimum > lower && minimum <= upper)) fail('incomplete stock at minimum purchase quantity');
    const image = typeof item.cover === 'string' && item.cover ? new URL(item.cover, shop.url) : null;
    const product = {
      externalId,
      name: item.name + (spec ? ` · ${spec}` : ''), spec,
      ...(ratingText ? { ratingText } : {}),
      ...rawProductContent(item.name, item.description),
      sourceCategory: typeof listing.category?.name === 'string' ? listing.category.name : '',
      sourceData: buildSourceEvidence({ description: item.description,
        minimum: item.minimum, maximum: item.maximum, only_user: item.only_user, delivery_way: item.delivery_way }),
      price: price(quote?.price), url: new URL(`/item/${item.id}`, shop.url).href,
      imageUrl: image && ['http:', 'https:'].includes(image.protocol) ? image.href : null,
      inStock: (Number.isFinite(counted) ? counted : lower) >= minimum,
    };
    result.push(product);
    freshProducts?.set(product, (item.only_user === 0 || item.only_user === 1 && guestEstimate) && item.purchase_count === 0
      && Number.isSafeInteger(item.maximum) && item.maximum >= 0 && (!item.maximum || item.maximum >= minimum));
  }
  if (settlementProduct && result.length === 0) unavailable();
  return result;
}

export async function probe(shop, fetchImpl = globalThis.fetch) {
  const first = await page(shop, 1, fetchImpl, {});
  const live = first.data.find(item => item.status === 1);
  return live ? normalize(shop, live, fetchImpl, {}, true) : [];
}

export async function crawl(_page, shop, fetchImpl = globalThis.fetch, options = {}) {
  const result = [], freshProducts = new Map();
  const listings = await discoverListings(shop, fetchImpl, options);
  for (const item of listings) {
    if (item.status === 0) continue;
    try { result.push(...await normalize(shop, item, fetchImpl, options, false, undefined, freshProducts)); }
    catch (error) { if (error?.name !== 'ProductUnavailableError') throw error; }
  }
  options.signal?.throwIfAborted();
  options.onListComplete?.();
  return settle(shop, result, fetchImpl, options, freshProducts);
}

export const purchaseQuantity = product => product.sourceData?.only_user === 1 && !estimatedGuestShop(product.url) ? undefined
  : minimumPurchaseQuantity({ minimum: product.sourceData?.minimum === 0 ? 1 : product.sourceData?.minimum }, 'minimum');

function decimal(value) {
  const text = ['string', 'number'].includes(typeof value) ? String(value).trim() : '';
  if (!/^\d{1,12}(?:\.\d{1,12})?$/.test(text)) return undefined;
  const [whole, fraction = ''] = text.split('.');
  return { value: BigInt(whole + fraction), scale: 10n ** BigInt(fraction.length) };
}
const cents = value => { const amount = decimal(value); return amount && amount.value * 100n / amount.scale; };

export function paymentFee(channel, origin) {
  if (!productId(Number(channel?.id)) || typeof channel.name !== 'string' || channel.handle === '#system'
    || (channel.currency !== undefined && channel.currency !== 'CNY')
    || ['status', 'custom_status'].some(field => channel[field] !== undefined && ![1, '1'].includes(channel[field]))) return undefined;
  const name = channel.name.normalize('NFKC').trim();
  if (!/^(?:支付宝|微信(?:支付)?|Alipay|WeChat(?: Pay)?)(?:\s|[-:(【\d]|$)/i.test(name)) return undefined;
  if (Object.hasOwn(channel, 'cost') || Object.hasOwn(channel, 'cost_type')) {
    const amount = decimal(channel.cost);
    return amount && [0, 1, '0', '1'].includes(channel.cost_type) ? { ...amount, fixed: Number(channel.cost_type) === 0 } : undefined;
  }
  // shortcut: User-confirmed rates require rechecking if private fees change without a channel identity change.
  const confirmed = {
    'https://yufenggpt.com': { id: 7, handle: 'Epay', rate: '0' },
    'https://shopcardai.click': { id: 2, handle: 'Epay', rate: '0.06' },
    'https://nikoers.com': { id: 2, handle: 'Epay', rate: '0.04' },
    'https://fk.gptcz.cc': { id: 10, handle: 'Alipay', rate: '0.036' },
  }[origin];
  if (confirmed && Number(channel.id) === confirmed.id && channel.handle === confirmed.handle && name === '支付宝') {
    return { ...decimal(confirmed.rate), fixed: false };
  }
  const bracketed = name.match(/^(?:支付宝|微信(?:支付)?|Alipay|WeChat(?: Pay)?)(?:\((\d+(?:\.\d+)?)%\)|【(\d+(?:\.\d+)?)%】)$/i);
  const bracketedFee = decimal(bracketed?.[1] ?? bracketed?.[2]);
  if (bracketedFee) return { value: bracketedFee.value, scale: bracketedFee.scale * 100n, fixed: false };
  // Only an explicit fee declaration is evidence; a bare payment name does not mean zero fees.
  const label = name.replace(/\s*\(备用通道\)$/, '').match(/^(?:支付宝|微信(?:支付)?|Alipay|WeChat(?: Pay)?)(?:\s*[-:]?\s*(?:\(([^()]+)\)|([^()]+)))$/i);
  const fee = (label?.[1] ?? label?.[2] ?? '').trim();
  if (/^(?:无手续费|免手续费)$/.test(fee)) return { value: 0n, scale: 1n, fixed: false };
  if (!fee.includes('手续费')) return undefined;
  const percent = fee.match(/^(?:手续费\s*)?(\d+(?:\.\d+)?)\s*%\s*(?:手续费)?$/)?.[1];
  const amount = decimal(percent);
  return amount ? { value: amount.value, scale: amount.scale * 100n, fixed: false } : undefined;
}

export async function settle(shop, products, fetchImpl = globalThis.fetch, options = {}, freshProducts = new Map()) {
  const origin = new URL(shop.url).origin;
  const request = async (path, form) => {
    options.signal?.throwIfAborted();
    const response = await fetchImpl(new URL(path, shop.url).href, {
      headers: { accept: 'application/json', ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      redirect: 'error', ...(options.signal ? { signal: options.signal } : {}),
      ...(form ? { method: 'POST', body: form.toString() } : {}),
    });
    const payload = await settlementJson(response);
    options.signal?.throwIfAborted();
    if ((form || path.startsWith('/user/api/index/pay?itemId=')) && isUnavailable(payload)) unavailable();
    return payload;
  };
  return collectSettlements(products, {
    quantity: product => freshProducts.get(product) === false ? undefined : purchaseQuantity(product),
    channel: async () => {
      const payload = await request('/user/api/index/pay');
      const channels = payload?.code === 200 && Array.isArray(payload.data)
        ? payload.data.flatMap(channel => { const fee = paymentFee(channel, origin); return fee ? [{ ...channel, fee }] : []; }) : [];
      return channels.length ? { channels, show_name: channels[0].name } : undefined;
    },
    quote: async (product, { channels }, quantity) => {
      const [item, variant] = String(product.externalId).split(':');
      let selected;
      try { selected = variant ? JSON.parse(decodeURIComponent(variant)) : { race: '', sku: {} }; } catch { return undefined; }
      if (!/^[1-9]\d*$/.test(item) || !object(selected) || typeof selected.race !== 'string' || !object(selected.sku)
        || Object.entries(selected.sku).some(([group, value]) => !group.trim() || typeof value !== 'string' || !value.trim())) return undefined;
      if (!freshProducts.has(product)) {
        const [fresh] = await normalize(shop, { id: Number(item) }, fetchImpl, options, false, product);
        if (fresh && !fresh.inStock) unavailable();
        if (!fresh?.inStock || !isDeepStrictEqual(normalizeProductEvidence({ ...fresh, sourceCategory: '' }),
          normalizeProductEvidence({ ...product, sourceCategory: '' })) || cents(fresh.price) !== cents(product.price)) return undefined;
      }
      const form = new URLSearchParams({ item_id: item, num: '1' });
      if (selected.race) form.set('race', selected.race);
      for (const [group, value] of Object.entries(selected.sku)) form.set(`sku[${group}]`, value);
      form.set('num', String(quantity));
      const quote = quantity === 1 ? { code: 200, data: { price: product.price } } : await request('/user/api/index/valuation', form);
      const amount = quote?.code === 200 ? cents(quote.data?.price) : undefined;
      if (amount === undefined) return undefined;
      // Custom storefronts can restrict payment channels per item, as their checkout does.
      const payload = await request(`/user/api/index/pay?itemId=${item}`);
      const allowed = payload?.code === 200 && Array.isArray(payload.data)
        ? payload.data.flatMap(channel => { const fee = paymentFee(channel, origin); return fee ? [{ ...channel, fee }] : []; }) : [];
      let best;
      for (const channel of allowed.filter(channel => channels.some(global => Number(global.id) === Number(channel.id)))) {
        const min = channel.min_amount == null ? 0n : cents(channel.min_amount), max = channel.max_amount == null ? undefined : cents(channel.max_amount);
        if (min === undefined || amount < min || (channel.max_amount != null && (max === undefined || (max > 0n && amount > max)))) continue;
        // ACG Order::trade uses BCMath scale 2: truncate the fee to cents before adding it.
        const fee = amount === 0n ? 0n : channel.fee.value * (channel.fee.fixed ? 100n : amount) / channel.fee.scale;
        const total = amount + fee;
        if (!best || total < best.total) best = { total, channel };
      }
      return best ? { code: 1, data: { total_amount: `${best.total / 100n}.${String(best.total % 100n).padStart(2, '0')}`, quantity },
        paymentMethod: best.channel.name + (estimatedGuestShop(shop.url) ? '（游客价预估）' : '') } : undefined;
    },
  }, options);
}

export default { id, name: '异次元发卡（acg-faka）', hosts: [
  'douyiner.cn', 'fk.ybkjs.top', 'shopcardai.click', 'faka.bbanai.site', 'aichongz.cc',
  'nikoers.com', 'hiemail.store', 'fk.gptcz.cc', 'ai666.id', 'wiki123.top',
  'store.codesky.qzz.io', 'shop.sunnydolls.dpdns.org', 'gmailsol.com', 'shop.bmoplus.com',
  'shopgpt.plus', 'dimosky.com', 'yufenggpt.com', 'tehuio.com', 'shihuiai.cn',
  'accharbor.com', 'apiciyuan.top', 'aiaimallss.cn', 'www.aixiamo.com',
], crawl, probe, settle, purchaseQuantity };

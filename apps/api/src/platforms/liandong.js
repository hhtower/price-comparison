import { buildSourceEvidence, specificationText, captureRatingText, rawProductContent } from './source-evidence.js';
import { observeShop } from './shop-observation.js';
import { collectSettlements, settlementJson, minimumPurchaseQuantity, usablePaymentChannel } from './settlement.js';

export const id = 'liandong';
export const purchaseQuantity = product => minimumPurchaseQuantity(product.sourceData, 'limit_count');

async function readPage(shop, current, fetchImpl) {
  const token = new URL(shop.url).pathname.split('/').filter(Boolean).pop();
  const response = await fetchImpl(new URL('/shopApi/Shop/goodsList', shop.url).href, { method: 'POST', headers: { accept: 'application/json, text/plain, */*', 'content-type': 'application/json', referer: shop.url }, body: JSON.stringify({ token, keywords: '', category_id: 0, goods_type: 'card', current, pageSize: 100 }) });
  if (!response.ok) throw new Error(`liandong goods API HTTP ${response.status}`);
  const payload = await response.json();
  if (payload?.code !== 1 || !Array.isArray(payload.data?.list)) throw new Error(`liandong goods API: ${payload?.msg || 'invalid response'}`);
  let total;
  if (Object.hasOwn(payload.data, 'total')) {
    const value = payload.data.total;
    if (!['number', 'string'].includes(typeof value) || !/^\d+$/.test(String(value).trim())
      || !Number.isSafeInteger(Number(value))) throw new Error('liandong goods API: invalid total');
    total = Number(value);
    if (payload.data.list.length > total) throw new Error('liandong goods API: list exceeds reported total');
  }
  return { list: payload.data.list, total };
}

function appendItems(list, items, seen) {
  for (const item of list) {
    const externalId = item?.goods_key || item?.link;
    const price = typeof item?.price === 'string' || typeof item?.price === 'number' ? String(item.price).replace(/,/g, '').trim() : '';
    if (!['string', 'number'].includes(typeof externalId) || !String(externalId).trim()
      || typeof item?.name !== 'string' || !item.name.trim() || typeof item.link !== 'string' || !item.link.trim()
      || !price || !Number.isFinite(Number(price)) || Number(price) < 0) throw new Error('liandong goods API: invalid product');
    if (seen.has(String(externalId))) throw new Error('liandong goods API: duplicate product ID across pages');
    seen.add(String(externalId));
    if (Number(price) > 0) items.push(item);
  }
}

export async function crawl(_page, shop, fetchImpl = globalThis.fetch, options = {}) {
  options.signal?.throwIfAborted();
  const items = [], seen = new Set();
  let complete = false, expectedTotal;
  // Count all validated IDs, including free items; short pages do not prove completion.
  for (let current = 1; current <= 1000; current++) {
    const { list, total } = await readPage(shop, current, fetchImpl);
    if (current === 1) expectedTotal = total;
    if (total !== expectedTotal) throw new Error('liandong goods API: total changed during crawl');
    appendItems(list, items, seen);
    if (expectedTotal !== undefined && seen.size > expectedTotal) throw new Error('liandong goods API: list exceeds reported total');
    if (!list.length || seen.size === expectedTotal) {
      if (expectedTotal !== undefined && seen.size !== expectedTotal) throw new Error('liandong goods API: incomplete snapshot');
      complete = true;
      break;
    }
  }
  if (!complete) throw new Error('liandong goods API: pagination limit exceeded');
  options.onListComplete?.();
  await observeShop(id, shop, fetchImpl, options);
  return readSettlements(shop, items, fetchImpl, options);
}

async function readSettlements(shop, items, fetchImpl, options) {
  const byId = new Map(items.map(item => [String(item.goods_key ?? item.link), item]));
  return settle(shop, toProducts(items), fetchImpl, options, product => {
    const item = byId.get(String(product.externalId));
    return item.goods_key != null ? minimumPurchaseQuantity(item, 'limit_count') : undefined;
  });
}

export async function settle(shop, products, fetchImpl = globalThis.fetch, options = {}, quantity = purchaseQuantity) {
  const post = async (path, body) => settlementJson(await fetchImpl(new URL(path, shop.url).href, {
    method: 'POST', headers: { accept: 'application/json, text/plain, */*', 'content-type': 'application/json', referer: shop.url },
    body: JSON.stringify(body),
  }));
  return collectSettlements(products, {
    quantity,
    channel: async () => {
      const token = new URL(shop.url).pathname.split('/').filter(Boolean).pop();
      const payload = await post('/shopApi/Shop/getUserChannel', { token });
      return payload?.code === 1 && Array.isArray(payload.data)
        ? payload.data.find(channel => usablePaymentChannel(channel, true)) : undefined;
    },
    quote: (product, channel, quantity) => post('/shopApi/Shop/getGoodsPrice', {
      goods_key: product.externalId, quantity, coupon_code: '', channel_id: channel.id,
    }),
  }, options);
}

function toProducts(items) {
  return items.map(item => {
    const sourceData = buildSourceEvidence(item);
    const ratingText = captureRatingText(item.goods_key || item.link, item.name, item.description);
    // Current card listings expose inventory under extend, including numeric zero.
    const countedStock = item.extend?.stock_count ?? item.stock_num;
    const rawStock = countedStock ?? item.status;
    const stock = typeof rawStock === 'number' || typeof rawStock === 'string' ? Number(rawStock) : NaN;
    const sourceCategory = [item.sourceCategory, item.category?.name]
      .find(value => typeof value === 'string' && value.trim())?.trim();
    return {
      externalId: item.goods_key || item.link,
      name: item.name,
      ...(ratingText ? { ratingText } : {}),
      ...rawProductContent(item.name, item.description),
      spec: specificationText(Array.isArray(item.spec)
        ? item.spec.map(option => option && Object.hasOwn(option, 'selected') ? { name: option.name, value: option.selected } : option)
        : item.spec),
      ...(sourceCategory ? { sourceCategory } : {}),
      ...(Object.keys(sourceData).length ? { sourceData } : {}),
      price: item.price,
      url: item.link,
      imageUrl: item.image || null,
      inStock: Number.isFinite(stock) && (countedStock == null
        ? stock > 0 : stock >= (minimumPurchaseQuantity(item, 'limit_count') ?? 1))
    };
  });
}

export async function probe(shop, fetchImpl = globalThis.fetch) {
  const items = [];
  appendItems((await readPage(shop, 1, fetchImpl)).list, items, new Set());
  return toProducts(items).slice(0, 3);
}

// catfk.com runs the same shopApi SaaS as wzyp.cn (verified 2026-10-05 via public categoryList/goodsList/getGoodsPrice/getUserChannel).
export default { id, name: '联动', hosts: ['wzyp.cn', 'catfk.com'], crawl, probe, settle, purchaseQuantity };

import { buildSourceEvidence, specificationText, captureRatingText, rawProductContent } from './source-evidence.js';
import { observeShop } from './shop-observation.js';
import { collectSettlements, settlementJson, minimumPurchaseQuantity, usablePaymentChannel } from './settlement.js';

export const id = '16688';
export const purchaseQuantity = product => minimumPurchaseQuantity(product.sourceData, 'limit_quantity');

export async function crawl(_page, shop, fetchImpl = globalThis.fetch, options = {}) {
  options.signal?.throwIfAborted();
  const shopNo = new URL(shop.url).pathname.split('/').filter(Boolean).pop();
  const response = await fetchImpl(new URL('/shopApi/goods/list', shop.url).href, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      referer: shop.url
    },
    body: JSON.stringify({ shop_no: shopNo, sort: 'default' })
  });
  if (!response.ok) throw new Error(`16688 goods API HTTP ${response.status}`);
  const payload = await response.json();
  if (payload?.code !== 1 || !Array.isArray(payload.data?.list)) {
    throw new Error(`16688 goods API: ${payload?.msg || 'invalid response'}`);
  }
  const seen = new Set();
  const items = payload.data.list;
  const products = items.map(item => {
    const externalId = item?.goods_no;
    const price = typeof item?.price === 'string' || typeof item?.price === 'number' ? String(item.price).replace(/,/g, '').trim() : '';
    if (!['string', 'number'].includes(typeof externalId) || !String(externalId).trim()
      || typeof item?.name !== 'string' || !item.name.trim() || !price || !Number.isFinite(Number(price)) || Number(price) < 0) {
      throw new Error('16688 goods API: invalid product');
    }
    if (seen.has(String(externalId))) throw new Error('16688 goods API: duplicate product ID');
    seen.add(String(externalId));
    const sourceData = buildSourceEvidence(item);
    const ratingText = captureRatingText(externalId, item.name, item.description);
    const rawStock = item.stock_available_quantity;
    const stock = typeof rawStock === 'number' || typeof rawStock === 'string' ? Number(rawStock) : NaN;
    const product = {
      externalId,
      name: item.name,
      ...(ratingText ? { ratingText } : {}),
      ...rawProductContent(item.name, item.description),
      spec: specificationText(Array.isArray(item.spec)
        ? item.spec.map(option => option && Object.hasOwn(option, 'selected') ? { name: option.name, value: option.selected } : option)
        : item.spec),
      ...(typeof item.sourceCategory === 'string' ? { sourceCategory: item.sourceCategory } : {}),
      ...(Object.keys(sourceData).length ? { sourceData } : {}),
      price: item.price,
      url: `https://www.16688.com.cn/goods/${encodeURIComponent(externalId)}`,
      imageUrl: item.image || null,
      // -1 is the platform's undisclosed quantity; an explicit sold-out flag wins.
      inStock: item.stock_available_status !== 'out' && Number.isFinite(stock)
        && (stock === -1 || stock >= (minimumPurchaseQuantity(item, 'limit_quantity') ?? 1))
    };
    return product;
  });
  options.onListComplete?.();
  await observeShop(id, shop, fetchImpl, options);
  return settle(shop, products, fetchImpl, options);
}

export async function settle(shop, products, fetchImpl = globalThis.fetch, options = {}) {
  let shopNo = new URL(shop.url).pathname.split('/').filter(Boolean).pop();
  const post = async (path, body) => {
    options.signal?.throwIfAborted();
    const payload = await settlementJson(await fetchImpl(new URL(path, shop.url).href, {
      method: 'POST', headers: { accept: 'application/json, text/plain, */*', 'content-type': 'application/json', referer: shop.url },
      body: JSON.stringify(body), ...(options.signal ? { signal: options.signal } : {}),
    }));
    options.signal?.throwIfAborted();
    return payload;
  };
  return collectSettlements(products, {
    quantity: purchaseQuantity,
    channel: async () => {
      let payload = await post('/shopApi/payment/list', { shop_no: shopNo });
      // Goods accept storefront aliases; payment endpoints require the canonical shop number.
      if (payload?.code === 0 && payload.msg === '店铺不存在或已关闭') {
        const detail = await post('/shopApi/shop/detail', { shop_no: shopNo });
        if (detail?.code === 1 && detail.data?.shop_alias === shopNo
          && /^S[1-9]\d*$/.test(detail.data?.shop_no ?? '') && detail.data.shop_no !== shopNo) {
          shopNo = detail.data.shop_no;
          payload = await post('/shopApi/payment/list', { shop_no: shopNo });
        }
      }
      return payload?.code === 1 && Array.isArray(payload.data?.list)
        ? payload.data.list.find(channel => usablePaymentChannel(channel)) : undefined;
    },
    quote: (product, channel, quantity) => post('/shopApi/payment/quotePrice', {
      shop_no: shopNo, goods_no: product.externalId, quantity, channel_id: channel.id, coupon_code: '',
    }),
  }, options);
}

export async function probe(shop, fetchImpl = globalThis.fetch) {
  return (await crawl(null, shop, fetchImpl)).slice(0, 3);
}

export default { id, name: '16688', hosts: ['www.16688.com.cn'], crawl, probe, settle, purchaseQuantity };

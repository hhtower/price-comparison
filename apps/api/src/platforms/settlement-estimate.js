import { minimumPurchaseQuantity, verifiedSettlement } from './settlement.js';
import { paymentFee } from './acg-faka.js';
import { paymentChannelIds } from './public-products-v1.js';

// shortcut: Store estimates exclude discounts, private FX and wallet costs; replace with live quotes when available.
const FEES = new Map([
  ['https://ouvg.top', 0n], ['https://yufenggpt.com', 0n], ['https://kapay.shop', 0n],
  ['https://shop.txyxt.dpdns.org', 0n], ['https://gpthub.ciyuanapi.ai', 0n], ['https://shop.aictk.shop', 0n],
  ['https://cccrad.uk', 295n], ['https://nikoers.com', 400n], ['https://fk.gptcz.cc', 360n],
  ['https://shopcardai.click', 600n], ['https://morimm.com', 400n], ['https://blog.esfine.chat', 160n],
  ['https://tghaopifa.cc', 400n], ['https://ultra.makelove.cloud', 150n], ['https://shop.callai.one', 160n],
  ['https://tehuio.com', 500n], ['https://fk.10886.xyz', 600n], ['https://kkfaka.xyz', 500n],
]);

const cents = value => {
  const parsed = verifiedSettlement(value, '费用');
  return parsed ? BigInt(parsed.totalAmount.replace('.', '')) : undefined;
};
const amount = value => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;

function publicFees(payload, protocol) {
  if (protocol === 'acg-faka' && payload?.code === 200 && Array.isArray(payload.data)) {
    return payload.data.flatMap(channel => {
      // An empty origin excludes remembered rules: this path only accepts live public declarations.
      const fee = paymentFee(channel, '');
      const min = channel.min_amount == null ? 0n : cents(channel.min_amount);
      const max = channel.max_amount == null ? 0n : cents(channel.max_amount);
      return fee && min !== undefined && max !== undefined && fee.value <= fee.scale * (fee.fixed ? 10000n : 1n)
        ? [{ min, max, cost: base => fee.fixed ? fee.value * 100n / fee.scale : base * fee.value / fee.scale,
          label: `网页渠道 ${channel.name} ${fee.fixed ? `${Number(fee.value) / Number(fee.scale)}元` : `${Number(fee.value) * 100 / Number(fee.scale)}%`}` }] : [];
    });
  }
  const config = payload?.status_code === 0 ? payload.data : undefined;
  if (protocol !== 'public-products-v1' || config?.currency !== 'CNY' || !Array.isArray(config.payment_channels)) return [];
  return config.payment_channels.flatMap(channel => {
    if (!['alipay', 'wechat'].includes(channel?.channel_type) || typeof channel.name !== 'string'
      || ['status', 'custom_status'].some(field => channel[field] !== undefined && ![1, '1', true].includes(channel[field]))
      || channel.currency !== undefined && channel.currency !== 'CNY'
      || channel.fee_policy !== undefined && !['customer_surcharge', 'none'].includes(channel.fee_policy)) return [];
    const rate = channel.fee_policy === 'none' ? 0n : cents(channel.fee_rate);
    const fixed = channel.fee_policy === 'none' ? 0n : cents(channel.fixed_fee ?? '0');
    const min = cents(channel.min_amount ?? '0'), max = cents(channel.max_amount ?? '0');
    return rate !== undefined && rate <= 10000n && fixed !== undefined && fixed < 1000000n && min !== undefined && max !== undefined
      ? [{ channelId: channel.id, min, max, cost: base => fixed + (base * rate + 5000n) / 10000n,
        label: `网页渠道 ${channel.name} ${Number(rate) / 100}%${fixed ? ` + ${amount(fixed)}元` : ''}` }] : [];
  });
}

export function estimateSettlement(shop, product, quantity, fees = []) {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 2147483647) return undefined;
  const base = verifiedSettlement(product.price, '售价基准', quantity);
  if (!base) return undefined;
  const origin = new URL(shop.url).origin;
  let rate = FEES.get(origin) ?? 0n;
  const total = BigInt(base.totalAmount.replace('.', '')) * BigInt(quantity);
  if (origin === 'https://morimm.com' && total > 50000n) rate = 0n;
  const payable = total + (total * rate + 5000n) / 10000n;
  const available = fees.filter(fee => total >= fee.min && (fee.max === 0n || total <= fee.max))
    .map(fee => ({ total: total + fee.cost(total), label: fee.label })).sort((a, b) => a.total < b.total ? -1 : a.total > b.total ? 1 : 0);
  if (available.length) return verifiedSettlement(amount(available[0].total), `支付价（预估：${available[0].label}）`, quantity);
  const percent = Number(rate) / 100;
  return verifiedSettlement(`${payable / 100n}.${String(payable % 100n).padStart(2, '0')}`,
    FEES.has(origin) ? `支付价（预估：售价加${percent}%）` : '支付价（预估：售价）', quantity);
}

export function withSettlementEstimates(adapter) {
  const quantity = adapter.id === 'acg-faka'
    ? product => minimumPurchaseQuantity({ minimum: product.sourceData?.minimum === 0 ? 1 : product.sourceData?.minimum }, 'minimum')
    : adapter.purchaseQuantity ?? (product => {
      if (adapter.id === 'acg-faka-v5') return minimumPurchaseQuantity(product.sourceData?.quantityRestriction, 'min');
      if (adapter.id === 'emshop') return minimumPurchaseQuantity(product.sourceData, 'min_buy');
      if (adapter.id === 'orion-key') return minimumPurchaseQuantity(product.sourceData, 'quantity_step');
      if (adapter.id === 'dujiaoka') return minimumPurchaseQuantity(product.sourceData, 'minimum');
      return 1;
    });
  const eligible = (product, options) => product.inStock && quantity(product) !== undefined
    && (!options.settlementProductIds || options.settlementProductIds.has(String(product.externalId)))
    && (!options.needsSettlement || options.needsSettlement(product, quantity(product)));
  function feeReader(shop, fetchImpl = globalThis.fetch) {
    const origin = new URL(shop.url).origin, fees = new Map();
    let attempted = false;
    const path = adapter.id === 'acg-faka' ? '/user/api/index/pay'
      : adapter.id === 'public-products-v1' ? '/api/v1/public/config' : undefined;
    return { fees, async fetch(url, init) {
      const endpoint = new URL(url);
      const capture = endpoint.origin === origin && endpoint.pathname === path;
      if (capture) attempted = true;
      const response = await fetchImpl(url, init);
      if (capture && response.ok && response.clone) {
        const payload = await response.clone().json().catch(() => undefined);
        fees.set(endpoint.searchParams.get('itemId') ?? '', publicFees(payload, adapter.id));
      }
      return response;
    }, async readMissing(products, options) {
      if (path && !attempted && products.some(product => !product.settlement && eligible(product, options))) {
        await this.fetch(new URL(path, shop.url).href, { headers: { accept: 'application/json' }, redirect: 'error', signal: options.signal }).catch(() => {});
        options.signal?.throwIfAborted();
      }
    } };
  }
  async function finish(shop, products, options, outcomes, reader) {
    options.signal?.throwIfAborted();
    await reader.readMissing(products, options);
    for (const product of products) {
      const externalId = String(product.externalId), count = quantity(product);
      if (!eligible(product, options)) continue;
      let fees = reader.fees.get(externalId.split(':')[0]) ?? reader.fees.get('');
      const allowed = adapter.id === 'public-products-v1' ? paymentChannelIds(product) : undefined;
      if (allowed !== undefined) fees = Array.isArray(allowed) && allowed.every(id => Number.isSafeInteger(id) && id > 0)
        ? allowed.length ? fees?.filter(fee => allowed.includes(fee.channelId)) : fees : [];
      if (product.settlement && !(product.settlement.paymentMethod?.includes('店铺规则（预估）') && fees?.length)) continue;
      const quote = estimateSettlement(shop, product, count, fees);
      if (!quote) continue;
      product.settlement = quote;
      outcomes.set(externalId, { externalId, status: 'verified', reason: 'estimated', retryable: false });
    }
    for (const outcome of outcomes.values()) options.onSettlementResult?.(outcome);
    return products;
  }
  return {
    ...adapter, purchaseQuantity: quantity,
    async crawl(page, shop, fetchImpl, options = {}) {
      const outcomes = new Map(), reader = feeReader(shop, fetchImpl);
      const products = await adapter.crawl(page, shop, reader.fetch, {
        ...options, onSettlementResult: result => outcomes.set(result.externalId, result),
      });
      return finish(shop, products, options, outcomes, reader);
    },
    async settle(shop, products, fetchImpl, options = {}) {
      options.signal?.throwIfAborted();
      const outcomes = new Map(), reader = feeReader(shop, fetchImpl);
      if (adapter.settle) await adapter.settle(shop, products, reader.fetch, {
        ...options, onSettlementResult: result => outcomes.set(result.externalId, result),
      });
      return finish(shop, products, options, outcomes, reader);
    },
  };
}

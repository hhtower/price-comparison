import { isEstimatedSettlement, markEstimatedSettlement, verifiedSettlement } from './settlement.js';

// shortcut: Store estimates exclude discounts, private FX and wallet costs; replace with live quotes when available.
const FEES = new Map([
  ['https://ouvg.top', 0n], ['https://yufenggpt.com', 0n], ['https://kapay.shop', 0n],
  ['https://shop.txyxt.dpdns.org', 0n], ['https://gpthub.ciyuanapi.ai', 0n], ['https://shop.aictk.shop', 0n],
  ['https://cccrad.uk', 295n], ['https://nikoers.com', 400n], ['https://fk.gptcz.cc', 360n],
  ['https://shopcardai.click', 600n], ['https://morimm.com', 400n], ['https://blog.esfine.chat', 160n],
  ['https://tghaopifa.cc', 400n], ['https://ultra.makelove.cloud', 150n], ['https://shop.callai.one', 160n],
  ['https://tehuio.com', 500n], ['https://fk.10886.xyz', 600n], ['https://kkfaka.xyz', 500n],
]);

const amount = value => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;

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
  if (available.length) return markEstimatedSettlement(verifiedSettlement(amount(available[0].total), `支付价（预估：${available[0].label}）`, quantity));
  const percent = Number(rate) / 100;
  return markEstimatedSettlement(verifiedSettlement(`${payable / 100n}.${String(payable % 100n).padStart(2, '0')}`,
    FEES.has(origin) ? `支付价（预估：售价加${percent}%）` : '支付价（预估：售价）', quantity));
}

export function withSettlementEstimates(adapter) {
  const quantity = adapter.estimatePurchaseQuantity ?? adapter.purchaseQuantity ?? (() => 1);
  const eligible = (product, options) => product.inStock && quantity(product) !== undefined
    && (!options.settlementProductIds || options.settlementProductIds.has(String(product.externalId)))
    && (!options.needsSettlement || options.needsSettlement(product, quantity(product)));
  function feeReader(shop, fetchImpl = globalThis.fetch) {
    const origin = new URL(shop.url).origin, fees = new Map();
    let attempted = false;
    const path = adapter.settlementFeePath;
    return { fees, async fetch(url, init) {
      const endpoint = new URL(url);
      const capture = endpoint.origin === origin && endpoint.pathname === path;
      if (capture) attempted = true;
      const response = await fetchImpl(url, init);
      if (capture && response.ok && response.clone) {
        const payload = await response.clone().json().catch(() => undefined);
        const parsed = adapter.readSettlementFees?.(payload, endpoint);
        if (parsed) fees.set(parsed.key, parsed.fees);
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
    const candidates = products.filter(product => eligible(product, options)
      && !['out_of_stock', 'product_unavailable'].includes(outcomes.get(String(product.externalId))?.reason));
    await reader.readMissing(candidates.filter(product => outcomes.get(String(product.externalId))?.status !== 'failed'), options);
    for (const product of candidates) {
      const externalId = String(product.externalId), count = quantity(product);
      let fees = reader.fees.get(adapter.settlementFeeKey?.(product) ?? '') ?? reader.fees.get('');
      const allowed = adapter.settlementPaymentChannelIds?.(product);
      if (allowed !== undefined) fees = Array.isArray(allowed) && allowed.every(id => Number.isSafeInteger(id) && id > 0)
        ? allowed.length ? fees?.filter(fee => allowed.includes(fee.channelId)) : fees : [];
      if (!product.settlement || product.settlement.kind === 'estimated'
        && adapter.preferPublicSettlementFees && fees?.length) {
        const quote = estimateSettlement(shop, product, count, fees);
        if (quote) product.settlement = quote;
      }
      const outcome = outcomes.get(externalId);
      if (isEstimatedSettlement(product.settlement)) {
        outcomes.set(externalId, outcome && ['failed', 'skipped'].includes(outcome.status)
          ? { ...outcome, estimated: true }
          : { ...outcome, externalId, status: 'estimated', reason: 'estimated', retryable: false, estimated: true });
      }
    }
    for (const outcome of outcomes.values()) options.onSettlementResult?.(outcome);
    return products;
  }
  return {
    ...adapter,
    canVerifySettlement: adapter.canVerifySettlement ?? Boolean(adapter.settle),
    purchaseQuantity: quantity,
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

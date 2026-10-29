export function verifiedSettlement(totalAmount, paymentMethod, quantity = 1) {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 2147483647) return undefined;
  if ((typeof totalAmount !== 'string' && typeof totalAmount !== 'number') || !String(totalAmount).trim()) return undefined;
  if (typeof paymentMethod !== 'string' || !paymentMethod.trim()) return undefined;
  const amount = String(totalAmount).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(amount)) return undefined;
  const [rawInteger, fraction = ''] = amount.split('.');
  const integer = rawInteger.replace(/^0+(?=\d)/, '');
  if (integer.length > 12) return undefined;
  const total = `${integer}.${fraction.padEnd(2, '0')}`;
  // Divide integer cents, retaining sub-cent unit prices without binary floating-point rounding.
  const units = BigInt(quantity);
  const scaled = (BigInt(integer + fraction.padEnd(2, '0')) * 10n ** 10n * 2n + units) / (2n * units);
  const decimals = (scaled % (10n ** 12n)).toString().padStart(12, '0').replace(/0+$/, '').padEnd(2, '0');
  return { price: `${scaled / (10n ** 12n)}.${decimals}`, totalAmount: total, quantity,
    verifiedAt: new Date().toISOString(), paymentMethod: paymentMethod.trim() };
}

export function minimumPurchaseQuantity(item, field) {
  const container = field === 'limit_count' ? item?.extend : item;
  if (!container || typeof container !== 'object' || !Object.hasOwn(container, field)) return 1;
  const value = container[field];
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const text = String(value).trim();
  if (!/^\d+$/u.test(text)) return undefined;
  const quantity = Number(text);
  if (field === 'limit_count' && quantity === 0) return 1;
  return Number.isInteger(quantity) && quantity >= 1 && quantity <= 2147483647 ? quantity : undefined;
}

export function quoteMatchesQuantity(data, quantity) {
  if (!data || typeof data !== 'object' || !Object.hasOwn(data, 'quantity')) return true;
  const value = data.quantity;
  return (typeof value === 'number' && Number.isInteger(value) && value === quantity)
    || (typeof value === 'string' && /^\d+$/.test(value.trim()) && Number(value) === quantity);
}

export function usablePaymentChannel(channel, requireStatus = false) {
  const id = channel?.id;
  if ((typeof id !== 'string' && typeof id !== 'number') || !/^[1-9]\d*$/.test(String(id)) || !Number.isSafeInteger(Number(id))) return false;
  if (!paymentMethod(channel)) return false;
  return ['status', 'custom_status'].every(field =>
    channel[field] === 1 || channel[field] === '1' || (!requireStatus && channel[field] === undefined));
}

export function paymentMethod(channel) {
  for (const value of [channel?.show_name, channel?.paytype?.name]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export async function collectSettlements(products, transport, options = {}) {
  const maxProducts = options.maxSettlementProducts ?? Infinity;
  if (maxProducts !== Infinity && (!Number.isSafeInteger(maxProducts) || maxProducts < 1)) {
    throw new Error('maxSettlementProducts must be a positive integer');
  }
  const report = (product, status, reason, retryable = false) =>
    options.onSettlementResult?.({ externalId: String(product.externalId), status, ...(reason ? { reason } : {}), retryable });
  const candidates = products.filter(product => {
    const quantity = transport.quantity(product);
    const reason = !product.inStock ? 'out_of_stock'
      : options.settlementProductIds && !options.settlementProductIds.has(String(product.externalId)) ? 'not_selected'
        : quantity === undefined ? 'quantity_not_supported'
          : options.needsSettlement && !options.needsSettlement(product, quantity) ? 'recently_verified' : undefined;
    if (reason) report(product, 'skipped', reason);
    return !reason;
  });
  options.signal?.throwIfAborted();
  if (!candidates.length) return products;
  function requestFailure(error) {
    options.signal?.throwIfAborted();
    if (error?.name === 'AbortError') throw error;
    if (error?.name === 'ProxyAuthenticationError') return 'proxy_authentication';
    return error?.name === 'CrawlerBlockedError' ? 'blocked' : 'request_failed';
  }
  let channel;
  try {
    channel = await transport.channel();
    options.signal?.throwIfAborted();
  } catch (error) {
    const reason = requestFailure(error);
    for (const product of candidates) report(product, 'failed', reason, reason !== 'proxy_authentication');
    return products;
  }
  if (!channel) {
    for (const product of candidates) report(product, 'failed', 'no_payment_channel');
    return products;
  }
  let stoppedReason;
  let attempted = 0;
  for (const product of candidates) {
    options.signal?.throwIfAborted();
    if (stoppedReason) { report(product, 'failed', stoppedReason, stoppedReason !== 'proxy_authentication'); continue; }
    if (attempted >= maxProducts) { report(product, 'skipped', 'deferred'); continue; }
    attempted++;
    let quote;
    const quantity = transport.quantity(product);
    try {
      quote = await transport.quote(product, channel, quantity);
      options.signal?.throwIfAborted();
    } catch (error) {
      if (error?.name === 'ProductUnavailableError') {
        options.signal?.throwIfAborted();
        product.inStock = false;
        delete product.settlement;
        report(product, 'failed', 'product_unavailable');
        continue;
      }
      const reason = requestFailure(error);
      if (reason === 'blocked' || reason === 'proxy_authentication') stoppedReason = reason;
      report(product, 'failed', reason, reason !== 'proxy_authentication');
      continue;
    }
    const method = quote && Object.hasOwn(quote, 'paymentMethod') ? quote.paymentMethod : paymentMethod(channel);
    const settlement = quote?.code === 1 && quote.data && quoteMatchesQuantity(quote.data, quantity)
      ? verifiedSettlement(quote.data.total_amount, method, quantity) : undefined;
    if (settlement) { product.settlement = settlement; report(product, 'verified'); }
    else report(product, 'failed', 'invalid_quote');
  }
  return products;
}

export async function settlementJson(response) {
  if (!response.ok) {
    const error = new Error(`settlement API HTTP ${response.status}`);
    if (response.status === 403 || response.status === 429) error.name = 'CrawlerBlockedError';
    throw error;
  }
  return response.json();
}

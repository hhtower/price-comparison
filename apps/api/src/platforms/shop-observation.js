function nonnegativeInteger(value) {
  if (!['string', 'number'].includes(typeof value)) return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : null;
}

function deposit(value) {
  if (!['string', 'number'].includes(typeof value)) return null;
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [integer, fraction = ''] = text.split('.');
  const cents = BigInt(integer) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { amountMinor: Number(cents), currency: 'CNY', purpose: null };
}

function binding(protocol, data, identity) {
  if (protocol === 'liandong') {
    if (!Object.hasOwn(data, 'token')) return 'request_scoped';
    return data.token === identity ? 'response_echo' : null;
  }
  const hasNumber = Object.hasOwn(data, 'shop_no');
  const hasAlias = Object.hasOwn(data, 'shop_alias');
  if (!hasNumber && !hasAlias) return 'request_scoped';
  if (hasNumber && (typeof data.shop_no !== 'string' || !/^S[1-9]\d*$/.test(data.shop_no))) return null;
  if (hasAlias && (typeof data.shop_alias !== 'string' || !data.shop_alias.trim())) return null;
  // A canonical number may have a different alias; an alias request must echo that alias.
  if (/^S[1-9]\d*$/.test(identity)) {
    return (hasNumber ? data.shop_no === identity : data.shop_alias === identity) ? 'response_echo' : null;
  }
  return hasAlias && data.shop_alias === identity ? 'response_echo' : null;
}

/** Optional shop metadata only: failures must not turn a valid goods list into a failed crawl. */
export async function observeShop(protocol, shop, fetchImpl, options = {}) {
  if (typeof options.onShopObservation !== 'function') return;
  options.signal?.throwIfAborted();
  try {
    const identity = new URL(shop.url).pathname.split('/').filter(Boolean).pop();
    if (!identity) return;
    const liandong = protocol === 'liandong';
    const url = new URL(liandong ? '/shopApi/Shop/info' : '/shopApi/shop/detail', shop.url);
    const response = await fetchImpl(url.href, {
      method: 'POST',
      headers: { accept: 'application/json, text/plain, */*', 'content-type': 'application/json', referer: shop.url },
      body: JSON.stringify(liandong ? { token: identity } : { shop_no: identity }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    options.signal?.throwIfAborted();
    // Redirects cannot silently change the origin/token scope of an observation.
    if (!response.ok || (response.url && response.url !== url.href)) return;
    const payload = await response.json();
    options.signal?.throwIfAborted();
    const data = payload?.data;
    if (payload?.code !== 1 || !data || typeof data !== 'object' || Array.isArray(data)) return;
    const scope = binding(protocol, data, identity);
    if (!scope) return;
    const fields = liandong ? data : data.merchant;
    const paymentCount = typeof fields?.sales_count_text === 'string'
      ? /^(\d+)人付款$/.exec(fields.sales_count_text.trim()) : null;
    await options.onShopObservation({
      deposit: deposit(fields?.deposit_money),
      volume: nonnegativeInteger(liandong ? fields?.sell_count : paymentCount?.[1]),
      counterDefinition: `${liandong ? 'shop_sell_count_display_not_authenticated_orders' : 'merchant_sales_count_text_person_payment_display_unverified'};binding=${scope}`,
      observedAt: new Date().toISOString(),
    });
    options.signal?.throwIfAborted();
  } catch {
    options.signal?.throwIfAborted();
  }
}

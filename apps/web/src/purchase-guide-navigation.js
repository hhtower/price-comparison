export function purchaseGuideHref(field = '') {
  const source = window.location.pathname + window.location.search + window.location.hash;
  return '/guide' + (source === '/' ? '' : '?returnTo=' + encodeURIComponent(source)) + (field ? '#' + encodeURIComponent(field) : '');
}

export function refreshPurchaseGuideHref(event) {
  // Filters update the address after rendering, so read it again before navigation.
  const link = event.currentTarget;
  link.href = purchaseGuideHref(decodeURIComponent(new URL(link.href).hash.slice(1)));
}

export function purchaseGuideReturnHref() {
  const source = new URLSearchParams(window.location.search).get('returnTo') || '/';
  try {
    const url = new URL(source, window.location.origin);
    if (url.origin === window.location.origin && (url.pathname === '/' || /^\/products\/[^/]+\/?$/u.test(url.pathname))) {
      return url.pathname + url.search + url.hash;
    }
  } catch { /* Invalid return addresses fall back to the catalog. */ }
  return '/';
}

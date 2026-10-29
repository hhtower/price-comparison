import { isIP } from 'node:net';

const SHOP_HOSTS = new Set(['wzyp.cn', 'catfk.com', 'ldxp.cn', 'www.ldxp.cn', 'pay.ldxp.cn', 'pay.qxvx.cn']);
const TOKEN = /^[A-Za-z0-9_.-]{1,128}$/;

/** Keep tenant identities; only discard tracking parameters, never arbitrary query keys. */
export function normalizeShopUrl(value: string): string | null {
  if (value.length > 2048) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || isIP(host)
      || !host.includes('.') || /(?:^|\.)(?:localhost|local|internal)$/.test(host)) return null;
    url.hostname = host === 'pay.ldxp.cn' ? 'wzyp.cn' : host;
    url.protocol = 'https:';
    url.hash = '';
    // Both hosts declare tenant.host=cccrad.uk and serve the same catalog (verified 2026-10-03).
    if (url.hostname === 'www.cccrad.uk') url.hostname = 'cccrad.uk';
    if (SHOP_HOSTS.has(url.hostname) || url.hostname === 'www.16688.com.cn') {
      const token = decodeURIComponent(url.pathname.match(/^\/shop\/([^/]+)\/?$/)?.[1] ?? '');
      // wzyp resolves ZXC and zxc to the same tenant; other hosts may use case-sensitive paths.
      return TOKEN.test(token) ? `${url.origin}/shop/${url.hostname === 'wzyp.cn' ? token.toLowerCase() : token}` : null;
    }
    for (const key of [...url.searchParams.keys()]) if (/^(?:utm_.+|ref|from|spm|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.href;
  } catch { return null; }
}

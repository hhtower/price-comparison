export function validQualityUrl(value) {
  try {
    if (!value || value.length > 2048 || /[\x00- \x7f]/u.test(value)) return false;
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

export function parseQualityIp(value) {
  const raw = value.trim();
  if (!raw || raw.length > 2048 || /[\x00- \x7f]/u.test(raw)) return null;
  if (/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/u.test(raw) && raw.split('.').every(part => Number(part) <= 255)) return { type: 'ipv4', label: 'IPv4 地址' };
  if (raw.includes(':') && !/[\[\]%/]/u.test(raw)) {
    try { if (new URL('http://[' + raw + ']/').hostname.startsWith('[')) return { type: 'ipv6', label: 'IPv6 地址' }; } catch { /* Not a complete IPv6 literal. */ }
  }
  if (!/^socks5h?:\/\//iu.test(raw)) return null;
  try {
    const url = new URL(raw);
    const hostname = url.hostname;
    if (!hostname || !url.port || Number(url.port) < 1 || Number(url.port) > 65535 || url.pathname || url.search || url.hash) return null;
    if (!hostname.startsWith('[') && !/^(?=.{1,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)(?:\.[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)*$/iu.test(hostname)) return null;
    if (/^[\d.]+$/u.test(hostname) && !parseQualityIp(hostname)) return null;
    const username = decodeURIComponent(url.username); const password = decodeURIComponent(url.password);
    if (Boolean(username) !== Boolean(password) || [username, password].some(part => /[\x00- \x7f]/u.test(part) || new TextEncoder().encode(part).length > 255)) return null;
    return { type: 'socks', label: 'SOCKS5 代理' };
  } catch { return null; }
}

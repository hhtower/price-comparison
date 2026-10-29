/** Only an explicitly identified goods/service endpoint establishes a provider.
 * Listing, seller, documentation and support URLs are never provider evidence. */
export interface ServiceEvidence { endpoints: string[]; brands: string[] }

const keyName = (key: string) => key.normalize('NFKC').replace(/[\s_-]+/gu, '').toLowerCase();
const endpointKeys = new Set(['apiendpoint', 'apiurl', 'apibaseurl', 'baseurl', 'serviceurl', 'serviceendpoint', 'servicedomain']);
const serviceKeys = new Set(['service', 'apiservice', 'serviceprovider', 'apiprovider', 'serviceevidence']);
const sellerKeys = new Set(['user', 'seller', 'merchant', 'shop', 'store']);
const urlPattern = /https?:\/\/[^\s<>"',;，。；、）)】]+/giu;
const publicRoutingParameters = new Set(['tenant', 'deployment', 'region', 'api-version']);

/** Retain only known public routing parameters; other query data can be credentials. */
export function sanitizeServiceEndpoint(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname) return undefined;
    url.username = '';
    url.password = '';
    const routing = [...url.searchParams].filter(([key]) => publicRoutingParameters.has(key.toLowerCase()));
    url.search = '';
    for (const [key, value] of routing.sort(([left], [right]) => left.localeCompare(right))) url.searchParams.append(key.toLowerCase(), value);
    url.hash = '';
    // Redact credentials commonly embedded in a named path segment.
    url.pathname = url.pathname.replace(/\/(?:api[-_]?key|token|secret|password)\/[^/]+/giu, '/[redacted]');
    return url.toString().replace(/\/$/u, '');
  } catch { return undefined; }
}

/** Keep evidence text and source paths usable without sending credentials to a model. */
export function sanitizeEvidenceText(value: string): string {
  return value.replace(urlPattern, url => sanitizeServiceEndpoint(url) ?? '[redacted URL]')
    .replace(/(?:authorization\s*[:=]\s*)?bearer\s+[a-z\d._~+/-]+=*/giu, 'Bearer [redacted]')
    .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|secret)["']?\s*[:=]\s*)(?:\[redacted\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;，；}\]]+)/giu, '$1[redacted]');
}

export function extractServiceEvidence(value: unknown): ServiceEvidence {
  const endpoints = new Set<string>(), brands = new Set<string>();
  const seen = new WeakSet<object>();
  const addEndpoint = (value: string) => { const endpoint = sanitizeServiceEndpoint(value); if (endpoint) endpoints.add(endpoint); };
  const walk = (value: unknown, path: string[] = []) => {
    const key = path.at(-1) ?? '';
    const service = path.some(part => serviceKeys.has(part));
    if (typeof value === 'string') {
      if (endpointKeys.has(key) || (service && ['url', 'link', 'endpoint', 'endpoints', 'domain', 'baseurl'].includes(key))) addEndpoint(value);
      if (['servicebrand', 'servicename', 'serviceprovider', 'apiprovider'].includes(key) || (service && ['name', 'brand', 'brands', 'provider'].includes(key))) {
        const brand = sanitizeEvidenceText(value).normalize('NFKC').replace(/\s+/gu, ' ').trim();
        if (brand && !/^https?:/iu.test(brand)) brands.add(brand);
      }
      // Require the role label immediately before the URL; a bare URL is not enough.
      for (const match of value.matchAll(/(?:服务端点|服务地址|接口地址|中转地址|api\s*(?:endpoint|base\s*url|地址)|base[_ -]?url)\s*[:：=]\s*(https?:\/\/[^\s<>"',;，。；、）)】]+)/giu)) addEndpoint(match[1]!);
      for (const match of value.matchAll(/(?:服务商|服务品牌|中转站名称|service\s*(?:provider|brand))\s*[:：=]\s*([^,，。;；\n]+)/giu)) {
        const brand = sanitizeEvidenceText(match[1]!).normalize('NFKC').trim();
        if (brand && !/^https?:/iu.test(brand)) brands.add(brand);
      }
      return;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) for (const item of value) walk(item, path);
    else for (const [rawKey, item] of Object.entries(value)) {
      const childKey = keyName(rawKey);
      if (!sellerKeys.has(childKey)) walk(item, [...path, childKey]);
    }
    seen.delete(value);
  };
  walk(value);
  return { endpoints: [...endpoints].sort(), brands: [...brands].sort() };
}

export function requiresServiceProviderEvidence(value: { name: string; spec?: string | null; sourceData?: unknown }): boolean {
  const service = extractServiceEvidence(value);
  return service.endpoints.length > 0 || service.brands.length > 0 || /(?<![a-z])api(?![a-z])|模型中转|中转站/iu.test(`${value.name} ${value.spec ?? ''}`);
}

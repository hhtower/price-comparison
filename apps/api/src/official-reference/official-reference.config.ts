export function readOfficialReferenceConfig(environment: NodeJS.ProcessEnv = process.env) {
  const proxyUrl = (environment.OFFICIAL_REFERENCE_PROXY_URL || environment.AI_PROXY_URL || '').trim();
  if (proxyUrl) {
    let valid = false;
    try { const url = new URL(proxyUrl); valid = ['http:', 'https:', 'socks5:'].includes(url.protocol) && Boolean(url.hostname); } catch { /* sanitized below */ }
    if (!valid) throw new Error('官网正价参考代理配置无效：请检查 AI_PROXY_URL 或 OFFICIAL_REFERENCE_PROXY_URL');
  }
  const intervalMs = integer(environment.OFFICIAL_REFERENCE_INTERVAL_MS, 2 * 3600_000, 300_000, 7 * 86400_000);
  const concurrency = integer(environment.OFFICIAL_REFERENCE_CONCURRENCY, 2, 1, 4);
  return { enabled: environment.OFFICIAL_REFERENCE_ENABLED !== 'false', proxyUrl, intervalMs, concurrency };
}

function integer(value: string | undefined, fallback: number, min: number, max: number) {
  const result = value?.trim() ? Number(value) : fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error('官网正价参考调度配置无效');
  return result;
}

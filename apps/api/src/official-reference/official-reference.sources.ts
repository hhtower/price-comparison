import { boundedResponse } from '../crawler/response-body.js';

export interface ExchangeRates { date: string; rates: Record<string, number> }

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function parseExchangeRates(input: unknown): ExchangeRates {
  const payload = record(input); const values = record(payload.cny);
  if (typeof payload.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(payload.date)
    || !Number.isFinite(Date.parse(payload.date)) || new Date(payload.date).toISOString().slice(0, 10) !== payload.date
    || values.cny !== 1) throw new Error('Invalid CNY exchange rates');
  const rates = Object.fromEntries(Object.entries(values).filter(([code, value]) => /^[a-z]{3}$/u.test(code)
    && typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1e9)) as Record<string, number>;
  return { date: payload.date, rates };
}

export async function fetchSourceText(url: string, fetcher: (url: string | URL, init?: RequestInit) => Promise<Response>, externalSignal?: AbortSignal): Promise<string> {
  const source = new URL(url);
  const signal = AbortSignal.any([AbortSignal.timeout(12_000), ...(externalSignal ? [externalSignal] : [])]);
  signal.throwIfAborted();
  let target = source; let response: Response | undefined;
  for (let hop = 0; hop < 3; hop++) {
    response = await fetcher(target.href, { signal, redirect: 'manual',
      headers: { Accept: 'text/html,application/json', 'Accept-Language': 'en-US,en;q=0.9', 'User-Agent': 'OfficialPriceReference/1.0' } });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location) throw new Error('Invalid source redirect');
    const next = new URL(location, target);
    if (next.origin !== source.origin || next.username || next.password
      || (source.hostname === 'apps.apple.com' && (next.pathname.split('/')[1] !== source.pathname.split('/')[1]
        || next.pathname.split('/').at(-1) !== source.pathname.split('/').at(-1)))) throw new Error('Source redirect not allowed');
    target = next;
  }
  const maxBytes = 4 * 1024 * 1024;
  if (!response?.ok || Number(response.headers.get('content-length')) > maxBytes || !response.body) {
    await response?.body?.cancel(); throw new Error('Upstream response unavailable');
  }
  return (await boundedResponse(response, signal, maxBytes)).text();
}

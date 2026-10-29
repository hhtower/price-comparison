import { fetch as undiciFetch } from 'undici';
import { randomBytes } from 'node:crypto';
import { HostRateLimiter } from './rate-limiter.js';
import { ProxyAuthenticationError, type ProxyLease, type ProxyPool } from './proxy-pool.js';
import { classifyResponse } from './response-guard.js';
import { boundedResponse } from './response-body.js';

export type CrawlerFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;
export type CrawlerRequestEvent =
  | { type: 'request'; host: string; stage: 'list' | 'channel' | 'settlement'; retry: boolean }
  | { type: 'duration'; host: string; phase: 'rate_wait' | 'proxy_wait' | 'network'; ms: number }
  | { type: 'failure'; host: string; reason: 'connection' | 'rate_limited' | 'blocked' | 'timeout' };

export const DEFAULT_CRAWLER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DEFAULT_ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9';
const YUNMAO_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export class CrawlerBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrawlerBlockedError';
  }
}

export interface RunFetchFactoryOptions {
  readonly limiter: HostRateLimiter;
  readonly pool: ProxyPool;
  readonly metrics?: { incrementCrawlerCounter(key: string): void };
  readonly logger?: { warn?: (...args: unknown[]) => void };
  readonly fetchImpl?: typeof undiciFetch;  // 测试注入
  /** Optional whole-response bound, applied before HTML/challenge inspection. */
  readonly maxResponseBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly publicProxyUrl?: string;
}

/** Keep run affinity, but lease each request separately so only one recovery probe can run. */
export function createRunFetchFactory(options: RunFetchFactoryOptions): (signal: AbortSignal, observe?: (event: CrawlerRequestEvent) => void) => CrawlerFetch {
  return (signal: AbortSignal, observe?: (event: CrawlerRequestEvent) => void): CrawlerFetch => {
    let preferredProxy: string | null | undefined;
    return (url, init = {}) => request(url, init, AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])]));

    async function request(url: string | URL, init: RequestInit, requestSignal: AbortSignal): Promise<Response> {
      requestSignal.throwIfAborted();
      const host = new URL(url).host.replace(/\.(?=:|$)/, '');
      const path = new URL(url).pathname.toLowerCase();
      const stage = /\/payment\/list|\/getuserchannel/.test(path) ? 'channel'
        : /\/quoteprice|\/getgoodsprice/.test(path) ? 'settlement' : 'list';
      const headers = mergeDefaultHeaders(init.headers, url);
      // A public-address-pinned transport must not be replaced by proxy-side DNS.
      const pinnedDispatcher = (init as Parameters<typeof undiciFetch>[1])?.dispatcher;
      const send = options.fetchImpl ?? undiciFetch;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        requestSignal.throwIfAborted();
        let current: ProxyLease | undefined;
        try {
          let rateWaitMs = 0;
          const admit = async () => {
            const started = Date.now();
            try { await options.limiter.acquire(host, requestSignal); }
            finally {
              const ms = Date.now() - started;
              rateWaitMs += ms;
              observe?.({ type: 'duration', host, phase: 'rate_wait', ms });
            }
          };
          const acquisitionStarted = Date.now();
          try {
            if (pinnedDispatcher && !options.publicProxyUrl) await admit();
            else {
              current = await options.pool.acquire(requestSignal, pinnedDispatcher ? options.publicProxyUrl : preferredProxy, admit,
                pinnedDispatcher ? proxyUrl => proxyUrl === options.publicProxyUrl : undefined);
              preferredProxy = current.proxyUrl;
            }
          } finally {
            observe?.({ type: 'duration', host, phase: 'proxy_wait', ms: Math.max(0, Date.now() - acquisitionStarted - rateWaitMs) });
          }
          requestSignal.throwIfAborted();
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(new Error('crawler request timed out')), options.requestTimeoutMs ?? 30_000);
          const networkSignal = AbortSignal.any([requestSignal, controller.signal]);
          const started = Date.now();
          let phase: 'connect' | 'body' = 'connect';
          let checked!: Response;
          observe?.({ type: 'request', host, stage, retry: attempt > 0 });
          const viaProxy = !!current?.proxyUrl;
          options.metrics?.incrementCrawlerCounter(viaProxy ? 'proxy_request' : 'direct_request');
          try {
            const response = await send(url, { ...init, headers, signal: networkSignal,
              dispatcher: pinnedDispatcher ?? current?.dispatcher } as Parameters<typeof undiciFetch>[1]);
            phase = 'body';
            if (response.status === 407 && current?.proxyUrl) {
              void response.body?.cancel().catch(() => {});
              current.reportFailure('authentication');
              options.logger?.warn?.('crawler.proxy_authentication_failed', { host, stage, phase, proxyStatus: 407 });
              throw new ProxyAuthenticationError();
            }
            const bodyLimit = pinnedDispatcher ? Math.min(2 * 1024 * 1024, options.maxResponseBytes ?? Infinity) : options.maxResponseBytes;
            checked = await boundedResponse(response as unknown as Response, networkSignal, bodyLimit ?? Infinity);
          } catch (error) {
            if (requestSignal.aborted) throw requestSignal.reason;
            const details = transportDetails(error);
            options.logger?.warn?.('crawler.transport_failed', {
              host, stage, phase, viaProxy, ...details,
            });
            if (controller.signal.aborted) {
              observe?.({ type: 'failure', host, reason: 'timeout' });
              throw controller.signal.reason;
            }
            if (error instanceof ProxyAuthenticationError) throw error;
            if (current?.proxyUrl && details.proxyStatus === 407) {
              current.reportFailure('authentication');
              throw new ProxyAuthenticationError();
            }
            if (phase === 'connect') {
              current?.reportFailure('connection');
              observe?.({ type: 'failure', host, reason: 'connection' });
              options.metrics?.incrementCrawlerCounter(viaProxy ? 'proxy_connection_failure' : 'direct_connection_failure');
              preferredProxy = undefined;
              if (attempt === 0) continue;
              throw new Error(`crawler transport connection error (${details.causes.at(-1)?.code ?? 'unknown'})`);
            }
            throw error;
          } finally {
            clearTimeout(timeout);
            observe?.({ type: 'duration', host, phase: 'network', ms: Date.now() - started });
          }
          // A complete HTTP response proves transport recovery, not source-site acceptance.
          current?.reportSuccess();
          return await handle(checked, host, new Headers(headers).get('accept') === 'text/html');
        } finally { current?.release(); }
      }
      throw new Error('crawler request attempts exhausted');
    }

  async function handle(response: Response, host: string, expectsHtml: boolean): Promise<Response> {
    const headers: Record<string, string | null> = {};
    response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
    const classification = classifyResponse(response.status, headers);
    if (classification === 'blocked') {
      await options.limiter.pause(host, retryAfterMs(headers['retry-after']));
      observe?.({ type: 'failure', host, reason: response.status === 429 ? 'rate_limited' : 'blocked' });
      options.metrics?.incrementCrawlerCounter(response.status === 429 ? 'response_rate_limited' : 'response_blocked');
      throw new CrawlerBlockedError(`target blocked the request (HTTP ${response.status})`);
    }
    const contentType = headers['content-type'] ?? '';
    if (contentType.includes('text/html')) {
      // HTML adapters opt in through Accept; schema validation remains the adapter's responsibility.
      if (expectsHtml && response.ok && headers['cf-mitigated']?.toLowerCase() !== 'challenge'
        && !/just a moment|verify (?:that )?you are human|checking your browser|cf-chl|_cf_chl_opt|enable javascript and cookies|captcha/i.test(await response.clone().text())) return response;
      await options.limiter.pause(host, retryAfterMs(headers['retry-after']));
      observe?.({ type: 'failure', host, reason: 'blocked' });
      options.metrics?.incrementCrawlerCounter('response_blocked');
      throw new CrawlerBlockedError('unexpected html response from goods API');
    }
    return response;
  }
  };
}

function transportDetails(error: unknown): { causes: Array<{ name: string; code?: string }>; proxyStatus?: number } {
  const causes: Array<{ name: string; code?: string }> = [];
  let proxyStatus: number | undefined;
  let cause = error;
  // Never log provider error messages: they can contain URLs, passwords or response bodies.
  for (let depth = 0; depth < 4 && cause instanceof Error; depth++) {
    const code = Reflect.get(cause, 'code');
    causes.push({
      name: /^[\w]{1,64}$/.test(cause.name) ? cause.name : 'Error',
      ...(typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? { code } : {}),
    });
    const status = /^Proxy response \((\d{3})\) !== 200 when HTTP Tunneling$/.exec(cause.message);
    if (status) proxyStatus = Number(status[1]);
    cause = cause.cause;
  }
  return { causes, ...(proxyStatus === undefined ? {} : { proxyStatus }) };
}

function retryAfterMs(header: string | null | undefined): number {
  const seconds = header && /^\d+(?:\.\d+)?$/.test(header.trim()) ? Number(header) * 1000 : NaN;
  const date = header ? Date.parse(header) - Date.now() : NaN;
  const delay = Number.isFinite(seconds) ? seconds : date;
  return Number.isFinite(delay) && delay > 0 ? delay : 60_000;
}

export function mergeDefaultHeaders(input: RequestInit['headers'], url?: string | URL): Record<string, string> {
  const merged: Record<string, string> = {};
  if (input) {
    if (input instanceof Headers) input.forEach((value, key) => { merged[key] = value; });
    else if (Array.isArray(input)) for (const [key, value] of input) merged[key] = String(value);
    else for (const [key, value] of Object.entries(input)) merged[key] = String(value);
  }
  const has = (name: string) => Object.keys(merged).some(key => key.toLowerCase() === name);
  const yunmao = url !== undefined && new URL(url).hostname.replace(/\.$/, '') === 'catfk.com';
  if (!has('user-agent')) merged['user-agent'] = yunmao ? YUNMAO_UA : DEFAULT_CRAWLER_UA;
  if (!has('accept-language')) merged['accept-language'] = yunmao ? 'zh-CN,zh;q=0.9,en;q=0.6' : DEFAULT_ACCEPT_LANGUAGE;
  if (yunmao && !has('visitorid')) merged.visitorid = randomBytes(12).toString('hex');
  return merged;
}

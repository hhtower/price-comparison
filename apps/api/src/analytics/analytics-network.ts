import { isIP } from 'node:net';
import { isPublicAddress } from '../quality/quality-network.js';
import { createCache, type Cache } from 'cache-manager';
import { createKeyv as createMemoryKeyv } from 'cacheable';
import { createKeyvNonBlocking } from '@keyv/redis';

export interface AnalyticsNetwork {
  ip: string | null; countryCode: string | null; country: string | null;
  region: string | null; city: string | null; isp: string | null;
  geoStatus: 'unknown' | 'local' | 'resolved' | 'unavailable' | 'disabled';
}
interface ClientRequest { ip?: string; headers?: Record<string, string | string[] | undefined> }
interface NetworkOptions { environment?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; timeoutMs?: number; cache?: Cache }
const SUCCESS_TTL_MS = 30 * 86400000;
const FAILURE_TTL_MS = 5 * 60000;

export function analyticsCacheOptions(environment: NodeJS.ProcessEnv = process.env) {
  const stores = [createMemoryKeyv({ ttl: SUCCESS_TTL_MS, lruSize: 2048 })];
  const url = environment.REDIS_URL?.trim();
  if (url) {
    const redis = createKeyvNonBlocking({
      url, disableOfflineQueue: true, commandsQueueMaxLength: 128,
      socket: { connectTimeout: 1000, socketTimeout: 1000, reconnectStrategy: false },
    }, { namespace: 'analytics-ip-v1', connectionTimeout: 1000 });
    redis.on('error', () => {});
    stores.push(redis);
  }
  return { stores, ttl: SUCCESS_TTL_MS, refreshThreshold: 0, nonBlocking: false };
}
const empty = (ip: string | null, geoStatus: AnalyticsNetwork['geoStatus']): AnalyticsNetwork => ({ ip, countryCode: null, country: null, region: null, city: null, isp: null, geoStatus });

export function normalizeIp(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const ip = value.trim();
  if (ip.includes('%')) return null;
  const family = isIP(ip);
  if (family === 4) return ip;
  if (family !== 6) return null;
  const canonical = new URL('http://[' + ip + ']').hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
  if (!mapped) return canonical;
  const high = Number.parseInt(mapped[1]!, 16); const low = Number.parseInt(mapped[2]!, 16);
  return [high >>> 8, high & 255, low >>> 8, low & 255].join('.');
}

/** Matches the existing TRUST_PROXY deployment contract: ingress must overwrite XFF. */
export function analyticsClientIp(request: ClientRequest, trustProxy = process.env.TRUST_PROXY === 'true'): string | null {
  if (trustProxy) {
    const forwarded = request.headers?.['x-forwarded-for'];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const ip = value && value.length <= 2048 ? normalizeIp(value.split(',', 1)[0]) : null;
    if (ip) return ip;
  }
  return normalizeIp(request.ip);
}

function label(value: unknown, max = 128): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > max || /[<>\u0000-\u001f\u007f]/u.test(value)) throw new Error('Invalid location');
  return value.trim() || null;
}

export class AnalyticsNetworkService {
  private readonly cache: Cache;
  private pending = 0;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly send: typeof fetch;
  private readonly timeoutMs: number;
  constructor(options: NetworkOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.send = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 1500;
    this.cache = options.cache ?? createCache(analyticsCacheOptions({}));
  }

  async lookup(address: string | null): Promise<AnalyticsNetwork> {
    const ip = normalizeIp(address);
    if (!ip) return empty(null, 'unknown');
    if (!isPublicAddress(ip)) return empty(ip, 'local');
    const template = this.environment.ANALYTICS_GEO_URL ?? 'https://ipwho.is/{ip}?lang=zh-CN';
    if (!template.trim()) return empty(ip, 'disabled');
    const key = 'ip:' + ip;
    const cached = await this.cache.get<AnalyticsNetwork>(key);
    if (cached) return { ...cached };
    // Separate cooldown keys keep a delayed failed lookup from replacing a success.
    const result = await this.cache.wrap<AnalyticsNetwork>('lookup:' + ip, async () => {
      if (this.pending >= 64) return empty(ip, 'unavailable');
      this.pending++;
      try {
        const value = await this.resolve(ip, template);
        if (value.geoStatus === 'resolved') await this.cache.set(key, value, SUCCESS_TTL_MS);
        return value;
      } finally { this.pending--; }
    }, FAILURE_TTL_MS);
    return { ...(result.geoStatus === 'resolved' ? result : await this.cache.get<AnalyticsNetwork>(key) ?? result) };
  }

  /** Admin reports only read cached successes; opening a report never calls the provider. */
  async cached(addresses: string[]): Promise<AnalyticsNetwork[]> {
    const ips = [...new Set(addresses.map(normalizeIp).filter((ip): ip is string => ip !== null))];
    const results: AnalyticsNetwork[] = [];
    for (let offset = 0; offset < ips.length; offset += 256) {
      const batch = ips.slice(offset, offset + 256);
      const values = await this.cache.mget<AnalyticsNetwork>(batch.map(ip => 'ip:' + ip));
      values.forEach((value, index) => {
        if (value?.geoStatus === 'resolved' && value.ip === batch[index]) results.push(value);
      });
    }
    return results;
  }

  private async resolve(ip: string, template: string): Promise<AnalyticsNetwork> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const deadline = new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error('Location timeout')); }, this.timeoutMs); });
      const query = async (): Promise<AnalyticsNetwork> => {
        if (!template.includes('{ip}')) throw new Error('Missing IP template');
        const url = new URL(template.replaceAll('{ip}', encodeURIComponent(ip)));
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Invalid location endpoint');
        const response = await this.send(url.href, { signal: controller.signal, redirect: 'error', headers: { accept: 'application/json' } });
        if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new Error('Location timeout'); }
        if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 32768) { void response.body?.cancel().catch(() => {}); throw new Error('Location unavailable'); }
        reader = response.body?.getReader();
        if (!reader) throw new Error('Empty location response');
        const chunks: Uint8Array[] = []; let size = 0;
        for (;;) {
          controller.signal.throwIfAborted();
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength; if (size > 32768) throw new Error('Location too large');
          chunks.push(part.value);
        }
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!data || data.success !== true || normalizeIp(data.ip) !== ip) throw new Error('Mismatched location');
        const countryCode = label(data.country_code, 2);
        if (countryCode && !/^[A-Z]{2}$/.test(countryCode)) throw new Error('Invalid country');
        const country = label(data.country);
        if (!country) throw new Error('Missing country');
        return { ip, countryCode, country, region: label(data.region), city: label(data.city), isp: label(data.connection?.isp), geoStatus: 'resolved' };
      };
      return await Promise.race([query(), deadline]);
    } catch { return empty(ip, 'unavailable'); }
    finally { clearTimeout(timeout); controller.abort(); void reader?.cancel().catch(() => {}); }
  }
}

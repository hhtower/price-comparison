import { isIP } from 'node:net';
import { resolve4 } from 'node:dns/promises';
import { parseIpTarget, type ParsedIpTarget } from './quality-input.js';
import { createQualityFetch, isPublicAddress } from './quality-network.js';
import type { IpQualityInput, QualityDetector, QualityItemResult, QualityStatus } from './quality.types.js';

export interface IpServiceProbe { url: string; expectedText?: string; expectStatus?: number; }
export interface IpQualityDetectorOptions {
  environment?: NodeJS.ProcessEnv;
  createFetch?: (proxy?: ParsedIpTarget, signal?: AbortSignal) => Promise<{ fetch: typeof fetch; dial?: (host: string, port: number, signal?: AbortSignal) => Promise<{ ok: boolean; ms: number }>; close(): Promise<void> }>;
  identityUrl?: string | null;
  reputationUrl?: string | null;
  egressUrl?: string | null;
  headersUrl?: string | null;
  dnsUrl?: string | null;
  aiServices?: IpServiceProbe[];
  streamingServices?: IpServiceProbe[];
  dnsblZones?: string[];
  dnsblLookup?: (name: string) => Promise<string[]>;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

// Built-in no-key reputation source; free tier is HTTP-only, which the pinned transport allows.
const IP_API_URL = 'http://ip-api.com/json/{ip}?fields=status,message,query,country,city,isp,org,as,proxy,hosting,mobile';
// Zones verified to answer through public resolvers; the spamhaus family refuses them and is excluded.
const DNSBL_ZONES = ['b.barracudacentral.org', 'bl.spamcop.net', 'dnsbl-1.uceprotect.net', 'psbl.surriel.com', 'bl.mailspike.net', 'truncate.gbudb.net'];

type Transport = { fetch: typeof fetch; dial?: (host: string, port: number, signal?: AbortSignal) => Promise<{ ok: boolean; ms: number }>; close(): Promise<void> };
type JsonObject = Record<string, unknown>;
type Sample = { ip: string; milliseconds: number } | { failure: true };
const EXIT_ITEMS = new Set(['ai-access', 'region-limit', 'latency', 'packet-loss', 'dns', 'success-rate', 'egress', 'header-leak', 'streaming', 'mail']);
const NETWORK_TYPES: Record<string, string> = { residential: '住宅网络', hosting: '数据中心网络', business: '商业网络', mobile: '移动网络', education: '教育网络' };

class ProbeFailure extends Error {
  constructor(readonly kind: 'timeout' | 'network' | 'invalid' | 'denied' | 'cancelled') { super(kind); }
}
class NotObserved extends Error {}
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProbeFailure('invalid');
  return value as JsonObject;
}
function canonicalIp(value: string): string {
  return isIP(value) === 6 ? new URL('http://[' + value + ']').hostname : value;
}
function checkedIp(value: unknown): string {
  if (typeof value !== 'string' || !isIP(value) || !isPublicAddress(value)) throw new ProbeFailure('invalid');
  return canonicalIp(value).replace(/^\[|\]$/g, '');
}
function verifyAddress(value: unknown, address: string): void {
  if (typeof value !== 'string' || !isIP(value) || canonicalIp(value) !== canonicalIp(address)) throw new ProbeFailure('invalid');
}
function scoreValue(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw new ProbeFailure('invalid');
  return value;
}
function envServices(environment: NodeJS.ProcessEnv, name: string, fallback: IpServiceProbe[]): IpServiceProbe[] {
  const value = environment[name];
  if (!value) return fallback;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length > 5 || parsed.some(item => {
      if (!item || typeof item !== 'object' || typeof item.url !== 'string' || !/^https?:\/\//.test(item.url)) return true;
      const hasText = typeof item.expectedText === 'string' && item.expectedText.length > 0 && item.expectedText.length <= 500;
      const hasStatus = Number.isSafeInteger(item.expectStatus) && item.expectStatus >= 100 && item.expectStatus <= 599;
      return !hasText && !hasStatus;
    })) return [];
    return parsed;
  } catch { return []; }
}
function reverseLabels(ip: string): string {
  if (isIP(ip) === 4) return ip.split('.').reverse().join('.');
  const normalized = canonicalIp(ip).slice(1, -1);
  const [left, right] = normalized.split('::');
  const first = left ? left.split(':') : [];
  const last = right ? right.split(':') : [];
  const groups = right !== undefined ? [...first, ...Array(8 - first.length - last.length).fill('0'), ...last] : first;
  return groups.map(part => part.padStart(4, '0')).join('').split('').reverse().join('.');
}
function reverseName(ip: string): string {
  return reverseLabels(ip) + (isIP(ip) === 4 ? '.in-addr.arpa' : '.ip6.arpa');
}
async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, parent: AbortSignal, timeout: number): Promise<T> {
  if (parent.aborted) throw new ProbeFailure('cancelled');
  const controller = new AbortController();
  let rejectAbort: (error: Error) => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = (kind: 'cancelled' | 'timeout') => {
    controller.abort();
    rejectAbort(new ProbeFailure(kind));
  };
  const cancel = () => abort('cancelled');
  parent.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => abort('timeout'), timeout);
  try { return await Promise.race([work(controller.signal), interrupted]); }
  finally { clearTimeout(timer); parent.removeEventListener('abort', cancel); }
}
async function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), ms); timer.unref?.(); });
  try { return await Promise.race([work, guard]); } catch { return fallback; } finally { clearTimeout(timer); }
}
async function boundedBody(response: Response, signal: AbortSignal, limit: number): Promise<string> {
  const size = response.headers.get('content-length');
  if (size && Number(size) > limit) { void response.body?.cancel().catch(() => {}); throw new ProbeFailure('invalid'); }
  const reader = response.body?.getReader();
  if (!reader) throw new ProbeFailure('invalid');
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0; let body = '';
  try {
    while (true) {
      if (signal.aborted) throw new ProbeFailure('cancelled');
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > limit) { cancel(); throw new ProbeFailure('invalid'); }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    if (size && /^\d+$/.test(size) && Number(size) !== total && !response.headers.get('content-encoding')) throw new ProbeFailure('invalid');
    return body;
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

/**
 * Only the shared public-address-pinned transport performs I/O. Every request in
 * SOCKS mode, including reputation and DoH, uses that same proxy transport.
 * AI_PROXY_URL is an optional upstream hop, never a replacement for the tested exit.
 * Optional reputation JSON is a trusted deployment adapter: { ip, networkType?,
 * riskScore?, blacklisted?, abuseScore? }; numeric scores range from 0 to 100.
 * Missing evidence is unrun, while attempted failures are risk. Raw provider
 * strings, response bodies, IP addresses and credentials never enter results.
 */
export function createIpQualityDetector(options: IpQualityDetectorOptions = {}): QualityDetector<IpQualityInput> {
  const environment = options.environment ?? process.env;
  const identityUrl = options.identityUrl === undefined ? environment.QUALITY_IP_IDENTITY_URL || 'https://ipwho.is/{ip}' : options.identityUrl;
  const reputationUrl = options.reputationUrl === undefined ? environment.QUALITY_IP_REPUTATION_URL || null : options.reputationUrl;
  const egressUrl = options.egressUrl === undefined ? environment.QUALITY_IP_EGRESS_URL || 'https://api64.ipify.org?format=json' : options.egressUrl;
  const headersUrl = options.headersUrl === undefined ? environment.QUALITY_IP_HEADERS_URL || 'https://httpbingo.org/headers' : options.headersUrl;
  const dnsUrl = options.dnsUrl === undefined ? environment.QUALITY_IP_DNS_URL || 'https://cloudflare-dns.com/dns-query' : options.dnsUrl;
  // The OpenAI API gateway answers 401 without credentials from supported regions, 403 in blocked ones,
  // and carries no Cloudflare interstitial — a far more reliable signal than the marketing page.
  const aiServices = options.aiServices ?? envServices(environment, 'QUALITY_IP_AI_SERVICES', [{ url: 'https://api.openai.com/v1/models', expectStatus: 401 }]);
  const streamingServices = options.streamingServices ?? envServices(environment, 'QUALITY_IP_STREAMING_SERVICES', []);
  const envDnsblZones = environment.QUALITY_IP_DNSBL_ZONES?.split(',').map(zone => zone.trim()).filter(Boolean);
  const dnsblZones = options.dnsblZones ?? (envDnsblZones?.length ? envDnsblZones : DNSBL_ZONES);
  const dnsblLookup = options.dnsblLookup ?? ((name: string) => resolve4(name).catch(() => [] as string[]));
  const timeout = Math.max(1, Math.min(options.timeoutMs ?? 8000, 30_000));
  const byteLimit = Math.max(128, Math.min(options.maxResponseBytes ?? 262_144, 1_048_576));
  const factory = options.createFetch ?? ((proxy?: ParsedIpTarget, signal?: AbortSignal) => createQualityFetch(proxy, { signal, serverProxyUrl: environment.AI_PROXY_URL }));
  return async (input, itemIds, signal, onItem) => {
    const target = parseIpTarget(input.target);
    let transport: Transport | undefined;
    let initializing: Promise<Transport> | undefined;
    const result: QualityItemResult[] = [];
    const cache = new Map<string, Promise<unknown>>();
    const memo = <T>(key: string, work: () => Promise<T>): Promise<T> => {
      if (!cache.has(key)) cache.set(key, work());
      return cache.get(key) as Promise<T>;
    };
    const network = (initializationSignal: AbortSignal): Promise<Transport> => {
      if (!initializing) initializing = factory(target?.type === 'socks' ? target : undefined, initializationSignal).then(value => { transport = value; return value; });
      return initializing;
    };
    const request = async (url: string, accept = 'application/json, text/html;q=0.9'): Promise<{ status: number; body: string }> => bounded(async probeSignal => {
      const client = await network(probeSignal);
      if (probeSignal.aborted) throw new ProbeFailure('cancelled');
      const response = await client.fetch(url, { method: 'GET', signal: probeSignal, redirect: 'manual', headers: { accept } });
      return { status: response.status, body: await boundedBody(response, probeSignal, byteLimit) };
    }, signal, timeout);
    const json = async (url: string, accept?: string): Promise<JsonObject> => {
      const response = await request(url, accept);
      if (response.status < 200 || response.status >= 300) throw new ProbeFailure('denied');
      try { return object(JSON.parse(response.body)); }
      catch { throw new ProbeFailure('invalid'); }
    };
    const samples = () => memo<Sample[]>('samples', async () => {
      if (!egressUrl) throw new NotObserved();
      const values: Sample[] = [];
      for (let round = 0; round < input.runs; round++) {
        if (signal.aborted) throw new ProbeFailure('cancelled');
        const start = performance.now();
        try { const data = await json(egressUrl); values.push({ ip: checkedIp(data.ip), milliseconds: Math.max(0, performance.now() - start) }); }
        catch (error) { if (signal.aborted) throw error; values.push({ failure: true }); }
      }
      return values;
    });
    const address = async () => {
      if (target?.type !== 'socks') return target!.host;
      const values = await samples();
      const observed = values.find((sample): sample is Extract<Sample, { ip: string }> => 'ip' in sample);
      if (!observed) throw new ProbeFailure('network');
      return observed.ip;
    };
    const identity = () => memo('identity', async () => {
      if (!identityUrl) throw new NotObserved();
      const ip = await address();
      const data = await json(identityUrl.replaceAll('{ip}', encodeURIComponent(ip)));
      if (data.success !== true) throw new ProbeFailure('invalid');
      verifyAddress(data.ip, ip);
      return data;
    });
    const reputation = () => memo('reputation', async () => {
      if (!reputationUrl) throw new NotObserved();
      const ip = await address();
      const data = await json(reputationUrl.replaceAll('{ip}', encodeURIComponent(ip)));
      verifyAddress(data.ip, ip);
      return data;
    });
    // Built-in no-key reputation source used when no custom reputation adapter is configured.
    const ipApi = () => memo('ipapi', async () => {
      const ip = await address();
      const data = await json(IP_API_URL.replaceAll('{ip}', encodeURIComponent(ip)));
      if (data.query !== undefined) verifyAddress(data.query, ip);
      if (data.status !== 'success') throw new ProbeFailure('invalid');
      for (const flag of [data.proxy, data.hosting, data.mobile]) if (flag !== undefined && typeof flag !== 'boolean') throw new ProbeFailure('invalid');
      return data;
    });
    // DNSBL listing is a property of the tested IP, so zone lookups go through the server resolver, not the tested exit.
    const dnsbl = () => memo('dnsbl', async () => {
      const ip = await address();
      const prefix = reverseLabels(ip);
      const hits = (await Promise.all(dnsblZones.map(async zone => {
        const answers = await withDeadline(dnsblLookup(prefix + '.' + zone), 4000, [] as string[]);
        return answers.some(address => address.startsWith('127.') && !address.startsWith('127.255.255.')) ? zone : null;
      }))).filter((zone): zone is string => zone !== null);
      return { hits, zones: dnsblZones.length };
    });
    const dns = async (name: string, type: 'A' | 'PTR') => {
      if (!dnsUrl) throw new NotObserved();
      const url = new URL(dnsUrl); url.searchParams.set('name', name); url.searchParams.set('type', type);
      const data = await json(url.href, 'application/dns-json');
      // NXDOMAIN (3) is a definitive "no such name" answer (e.g. an IP without PTR records), not a probe failure.
      if (data.Status !== 0 && data.Status !== 3) throw new ProbeFailure('invalid');
      if (data.Status === 3 || data.Answer === undefined) return [];
      if (!Array.isArray(data.Answer)) throw new ProbeFailure('invalid');
      return data.Answer.map(object);
    };
    const serviceEvidence = (services: IpServiceProbe[], key: string) => memo(key, async () => {
      if (!services.length) throw new NotObserved();
      if (services.length > 5) throw new ProbeFailure('invalid');
      let unknown = false;
      for (const service of services) {
        if (service.expectedText !== undefined && (typeof service.expectedText !== 'string' || !service.expectedText || service.expectedText.length > 500)) throw new NotObserved();
        if (service.expectStatus !== undefined && (!Number.isSafeInteger(service.expectStatus) || service.expectStatus < 100 || service.expectStatus > 599)) throw new NotObserved();
        const response = await request(service.url);
        if (/unsupported_country_region_territory|country_not_supported|not available in your (?:country|region)|unavailable in your (?:country|region)|region.{0,20}not supported/i.test(response.body)) return 'regional' as const;
        // cf-chl-/_cf_chl_opt cover both generations of the Cloudflare JS challenge interstitial.
        if (/just a moment|verify (?:that )?you are human|checking your browser|cf-chl|_cf_chl_opt|enable javascript and cookies|captcha/i.test(response.body)) return 'challenge' as const;
        if (service.expectStatus !== undefined) {
          if (response.status !== service.expectStatus) unknown = true;
          continue;
        }
        if (response.status < 200 || response.status >= 300) throw new ProbeFailure('denied');
        if (!response.body.includes(service.expectedText!)) unknown = true;
      }
      return unknown ? 'unknown' as const : 'observed' as const;
    });
    // Built-in streaming probes (Netflix dual-title + TikTok + YouTube), used when no custom list is configured.
    const builtinStreaming = async (): Promise<{ status: 'pass' | 'risk'; summary: string }> => {
      const parts: string[] = []; let risky = false;
      const probeStatus = async (url: string): Promise<{ status: number | null; reachable: boolean; body: string }> => {
        try {
          const response = await request(url);
          return { status: response.status, reachable: true, body: response.body };
        } catch (error) {
          if (signal.aborted || error instanceof ProbeFailure && error.kind === 'cancelled') throw error;
          // A response whose body exceeded the read limit still proves the endpoint answered.
          const answered = error instanceof ProbeFailure && error.kind === 'invalid';
          return { status: null, reachable: answered, body: '' };
        }
      };
      const [selfTitle, nonSelfTitle] = await Promise.all([probeStatus('https://www.netflix.com/title/81280792'), probeStatus('https://www.netflix.com/title/70143836')]);
      if (selfTitle.status === 403 || nonSelfTitle.status === 403) { parts.push('Netflix 拒绝访问（403）'); risky = true; }
      else if (selfTitle.status === 200 && nonSelfTitle.status === 200) parts.push('Netflix 全解锁（网页可达，未验证账号）');
      else if (selfTitle.status === 200 && nonSelfTitle.status === 404) { parts.push('Netflix 仅自制剧可看'); risky = true; }
      else if (selfTitle.reachable || nonSelfTitle.reachable) parts.push('Netflix 可达（响应超出读取上限，未验证解锁档位）');
      else { parts.push('Netflix 不可达'); risky = true; }
      const tiktok = await probeStatus('https://www.tiktok.com/explore');
      if (tiktok.status === 200 || tiktok.reachable) parts.push('TikTok 可达' + (tiktok.status === 200 ? '' : '（未验证页面内容）')); else { parts.push('TikTok 不可达'); risky = true; }
      const youtube = await probeStatus('https://www.youtube.com/premium');
      if (youtube.status === 200 && youtube.body.includes('Premium')) parts.push('YouTube Premium 可达');
      else if (youtube.reachable) parts.push('YouTube 可达（未验证 Premium 内容）');
      else { parts.push('YouTube Premium 不可达'); risky = true; }
      return { status: risky ? 'risk' : 'pass', summary: parts.join('；') };
    };
    const item = (id: string, status: QualityStatus, summary: string, score: number | null = status === 'pass' ? 100 : status === 'risk' ? 0 : null): QualityItemResult => ({ id, status, score, summary });
    const inspect = async (id: string): Promise<QualityItemResult> => {
      if (!target || !Number.isInteger(input.runs) || input.runs < 1 || input.runs > 5) throw new ProbeFailure('invalid');
      if (target.type !== 'socks' && EXIT_ITEMS.has(id)) return item(id, 'unavailable', '需 SOCKS5 才能检测真实出口，此项不计分');
      switch (id) {
        case 'geo': {
          const data = await identity();
          if (data.country_code == null) throw new NotObserved();
          if (typeof data.country_code !== 'string' || !/^[A-Z]{2}$/.test(data.country_code)) throw new ProbeFailure('invalid');
          return item(id, 'pass', '归属地登记国家/地区：' + data.country_code);
        }
        case 'asn': {
          const data = await identity();
          if (data.connection == null) throw new NotObserved();
          const value = object(data.connection).asn;
          if (value == null) throw new NotObserved();
          if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 4294967295) throw new ProbeFailure('invalid');
          return item(id, 'pass', '已查询到自治系统 AS' + value);
        }
        case 'provider': {
          const data = await identity();
          if (data.connection == null) throw new NotObserved();
          const connection = object(data.connection);
          if (![connection.isp, connection.org].some(value => typeof value === 'string' && value.trim())) throw new NotObserved();
          return item(id, 'pass', '已取得运营商/组织登记信息，登记信息不代表信誉担保');
        }
        case 'reverse-dns': {
          const answers = await dns(reverseName(await address()), 'PTR');
          const records = answers.filter(value => value.type === 12 && typeof value.data === 'string' && /^(?:[a-z\d_-]+\.)+[a-z\d_-]+\.?$/i.test(value.data));
          return records.length ? item(id, 'pass', '已取得反向解析记录') : item(id, 'unrun', '未观察到有效反向解析记录');
        }
        case 'ip-type': {
          if (reputationUrl) {
            const value = (await reputation()).networkType;
            if (value == null) throw new NotObserved();
            if (typeof value !== 'string' || !Object.hasOwn(NETWORK_TYPES, value)) throw new ProbeFailure('invalid');
            return item(id, 'pass', '数据源标记为' + NETWORK_TYPES[value] + '，不代表原生/住宅身份认证');
          }
          const data = await ipApi();
          const type = data.hosting === true ? 'hosting' : data.mobile === true ? 'mobile' : 'residential';
          return item(id, 'pass', '数据源标记为' + NETWORK_TYPES[type] + (data.proxy === true ? '；同时标记为开放代理' : '') + '，不代表原生/住宅身份认证');
        }
        case 'risk-score': {
          if (reputationUrl) {
            const value = scoreValue((await reputation()).riskScore);
            if (value === undefined) throw new NotObserved();
            const risky = value >= 30;
            return item(id, risky ? 'risk' : 'pass', risky ? '信誉数据源观察到风险或滥用记录' : '本次数据源未标记显著风险，覆盖限于所查询数据源', Math.round(100 - value));
          }
          const [data, list] = await Promise.all([ipApi(), dnsbl()]);
          const signals = [data.proxy === true ? '开放代理标记' : null, data.hosting === true ? '机房托管标记' : null, list.hits.length ? `DNSBL 命中 ${list.hits.length} 库` : null].filter(signal => signal !== null) as string[];
          return signals.length ? item(id, 'risk', '观察到风险信号：' + signals.join('、')) : item(id, 'pass', `未观察到代理/机房/黑名单风险信号（覆盖：ip-api 与 ${list.zones} 个 DNSBL 库）`);
        }
        case 'abuse': {
          if (reputationUrl) {
            const value = scoreValue((await reputation()).abuseScore);
            if (value === undefined) throw new NotObserved();
            const risky = value > 0;
            return item(id, risky ? 'risk' : 'pass', risky ? '信誉数据源观察到风险或滥用记录' : '本次数据源未标记显著风险，覆盖限于所查询数据源', Math.round(100 - value));
          }
          const data = await ipApi();
          return data.proxy === true ? item(id, 'risk', '数据源标记为开放代理/中转，存在被滥用特征') : item(id, 'pass', '所查数据源未标记开放代理/滥用特征，覆盖有限');
        }
        case 'blacklist': {
          if (reputationUrl) {
            const value = (await reputation()).blacklisted;
            if (value == null) throw new NotObserved();
            if (typeof value !== 'boolean') throw new ProbeFailure('invalid');
            return item(id, value ? 'risk' : 'pass', value ? '所查询黑名单存在命中' : '所查询黑名单未命中，不代表全部黑名单无记录');
          }
          const list = await dnsbl();
          return list.hits.length ? item(id, 'risk', 'DNSBL 黑名单命中：' + list.hits.join('、')) : item(id, 'pass', `所查 ${list.zones} 个 DNSBL 黑名单库均未命中，不代表全部黑名单无记录`);
        }
        case 'ai-access': case 'region-limit': {
          const evidence = await serviceEvidence(aiServices, 'ai-services');
          if (evidence === 'regional') return item(id, 'risk', '服务响应明确提示地区限制');
          if (evidence === 'challenge') return item(id, 'risk', '服务返回人机验证或访问挑战，当前出口未通过');
          if (evidence === 'unknown') return item(id, 'unrun', '收到响应，但未观察到预期状态或证据');
          return item(id, 'pass', id === 'region-limit' ? '所测 AI 服务未观察到地区拦截；不代表账号或模型使用授权' : '所测 AI 服务 API 可达；未验证登录、账号或模型调用');
        }
        case 'streaming': {
          if (!streamingServices.length) {
            const builtin = await builtinStreaming();
            return item(id, builtin.status, builtin.summary);
          }
          const evidence = await serviceEvidence(streamingServices, 'streaming');
          if (evidence === 'regional') return item(id, 'risk', '服务响应明确提示地区限制');
          if (evidence === 'challenge') return item(id, 'risk', '服务返回人机验证或访问挑战，当前出口未通过');
          if (evidence === 'unknown') return item(id, 'unrun', '收到网页响应，但未观察到预期服务证据');
          return item(id, 'pass', '配置的服务网页可达；未验证播放授权或内容解锁');
        }
        case 'success-rate': case 'latency': case 'egress': {
          const values = await samples();
          const observed = values.filter((value): value is Extract<Sample, { ip: string }> => 'ip' in value);
          const complete = observed.length === values.length;
          if (id === 'success-rate') return item(id, complete ? 'pass' : 'risk', 'HTTP 出口探测 ' + observed.length + '/' + values.length + ' 轮成功', Math.round(observed.length / values.length * 100));
          if (!observed.length) throw new ProbeFailure('network');
          if (id === 'egress') {
            if (!complete || new Set(observed.map(value => value.ip)).size > 1) return item(id, 'risk', '多轮观测存在出口变化或失败，未确认稳定出口');
            if (observed.length < 2) return item(id, 'unrun', '仅有单轮出口观测，无法判断出口稳定性');
            return item(id, 'pass', '本次多轮观测到同一公网出口，长期稳定性仍需持续观察');
          }
          const timings = observed.map(value => value.milliseconds).sort((a, b) => a - b);
          const median = timings.length % 2 ? timings[Math.floor(timings.length / 2)] : (timings[timings.length / 2 - 1] + timings[timings.length / 2]) / 2;
          return item(id, complete && median < 1500 ? 'pass' : 'risk', 'HTTP 往返中位耗时 ' + Math.round(median) + ' ms（' + observed.length + '/' + values.length + ' 轮成功）', complete ? Math.max(0, Math.round(100 - median / 100)) : 0);
        }
        case 'dns': {
          const answers = await dns('example.com', 'A');
          if (!answers.some(value => value.type === 1 && typeof value.data === 'string' && isIP(value.data) === 4 && isPublicAddress(value.data))) throw new ProbeFailure('invalid');
          return item(id, 'pass', '经代理的 DNS-over-HTTPS 查询获得有效响应；未验证本地 DNS 路径');
        }
        case 'header-leak': {
          if (!headersUrl) throw new NotObserved();
          const headers = object((await json(headersUrl)).headers);
          if (!Object.keys(headers).length) throw new ProbeFailure('invalid');
          if (Object.values(headers).some(value => typeof value !== 'string' && (!Array.isArray(value) || !value.length || value.some(part => typeof part !== 'string')))) throw new ProbeFailure('invalid');
          const leaked = Object.keys(headers).some(key => /^(?:forwarded|forwarded-for|x-forwarded-for|x-real-ip|via|proxy-authorization|proxy-connection)$/i.test(key));
          return item(id, leaked ? 'risk' : 'pass', leaked ? '回显请求头中观察到代理或转发标记' : '回显请求头未观察到代理标记；不代表完全匿名');
        }
        case 'packet-loss': {
          const client = await network(signal);
          if (!client.dial) return item(id, 'unavailable', '当前传输通道不支持原始 TCP 探测');
          let failures = 0;
          for (let round = 0; round < input.runs; round++) {
            if (signal.aborted) throw new ProbeFailure('cancelled');
            const result = await withDeadline(client.dial('1.1.1.1', 443, signal), timeout, { ok: false, ms: 0 });
            if (!result.ok) failures++;
          }
          const percent = Math.round((input.runs - failures) / input.runs * 100);
          return failures === 0
            ? item(id, 'pass', `TCP 握手 ${input.runs}/${input.runs} 轮成功（目标 1.1.1.1:443；非 ICMP 丢包）`, percent)
            : item(id, 'risk', `TCP 握手失败 ${failures}/${input.runs} 轮（目标 1.1.1.1:443；非 ICMP 丢包，失败含拒绝与超时）`, percent);
        }
        case 'mail': {
          const client = await network(signal);
          if (!client.dial) return item(id, 'unavailable', '当前传输通道不支持原始 TCP 探测');
          const result = await withDeadline(client.dial('gmail-smtp-in.l.google.com', 25, signal), timeout, { ok: false, ms: 0 });
          return result.ok
            ? item(id, 'pass', `25 端口出站握手成功（${result.ms} ms；投递能力还取决于黑名单与内容信誉）`)
            : item(id, 'risk', '25 端口出站不可达（家宽与多数机房常态封锁 25 端口；587/465 提交不受影响）');
        }
        default: return item(id, 'unrun', '该检测项暂无可用观测');
      }
    };
    try {
      for (const id of itemIds) {
        let value: QualityItemResult;
        try {
          if (signal.aborted) throw new ProbeFailure('cancelled');
          value = await inspect(id);
        } catch (error) {
          value = signal.aborted || error instanceof ProbeFailure && error.kind === 'cancelled' ? item(id, 'cancelled', '检测已取消，已完成结果保留')
            : error instanceof NotObserved ? item(id, 'unrun', '未配置数据源或当前数据源缺少此项证据')
              : item(id, 'risk', error instanceof ProbeFailure && error.kind === 'timeout' ? '检测请求超时，未取得有效结果' : '检测请求失败或返回无效证据');
        }
        result.push(value); onItem(value);
      }
      return result;
    } finally {
      if (transport) { try { await transport.close(); } catch { /* Do not expose upstream cleanup errors. */ } }
      else if (initializing) void initializing.then(value => value.close()).catch(() => {});
    }
  };
}

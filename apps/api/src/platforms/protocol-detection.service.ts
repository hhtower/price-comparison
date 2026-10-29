import { Inject, Injectable, Optional } from '@nestjs/common';
import { DomainValidationError } from '../common/errors.js';
import { createQualityFetch, type QualityLookup } from '../quality/quality-network.js';
import type { HostRateLimiter } from '../crawler/rate-limiter.js';
import { boundedResponse } from '../crawler/response-body.js';
import { mergeDefaultHeaders } from '../crawler/fetch-client.js';
import { platforms, type CrawlProduct } from './index.js';

export const PROTOCOL_DETECTION_OPTIONS = Symbol('PROTOCOL_DETECTION_OPTIONS');
/** Deployment-owned proxy exits; destinations are validated and pinned to public addresses. */
export interface DetectionEgress { proxyUrl?: string; proxyDns?: boolean }
interface DetectionOptions { fetchImpl?: typeof fetch; lookup?: QualityLookup; timeoutMs?: number; maxResponseBytes?: number; egresses?: readonly DetectionEgress[]; limiter?: HostRateLimiter }
export interface ProtocolDetection {
  status: 'matched' | 'unknown' | 'failed' | 'ambiguous';
  protocol: string | null;
  products: CrawlProduct[];
  candidates: Array<{ protocol: string; name: string; products: CrawlProduct[] }>;
  attempts: Array<{ protocol: string; status: 'matched' | 'unknown' | 'failed'; reason?: string }>;
}
class NotThisProtocol extends Error {}

@Injectable()
export class ProtocolDetectionService {
  constructor(@Optional() @Inject(PROTOCOL_DETECTION_OPTIONS) private readonly options: DetectionOptions = {}) {}

  list(): Array<{ id: string; name: string }> {
    return platforms.map(({ id, name }) => ({ id, name }));
  }

  /** Egresses are tried in order; the first one that yields a non-network verdict wins, matching crawler egress rotation. */
  async detect(value: string, protocol?: string, externalSignal?: AbortSignal): Promise<ProtocolDetection> {
    let url: URL;
    try {
      url = new URL(value);
      if (url.protocol !== 'https:' || url.hostname.endsWith('.') || url.username || url.password || url.port || url.hash) throw new Error();
    } catch { throw new DomainValidationError('INVALID_SHOP_URL', '商铺地址必须是域名不带末尾点、无账号密码、端口和片段的 HTTPS 地址'); }
    if (protocol !== undefined && !platforms.some(item => item.id === protocol)) throw new DomainValidationError('INVALID_SHOP_PROTOCOL', '不支持此采集协议');
    const egresses = this.options.egresses?.length ? this.options.egresses : [{}];
    let last: ProtocolDetection | undefined;
    for (const egress of egresses) {
      externalSignal?.throwIfAborted();
      last = await this.probeViaEgress(url, protocol, egress, externalSignal);
      if (last.status !== 'failed') return last;
    }
    return last!;
  }

  private async probeViaEgress(url: URL, protocol: string | undefined, egress: DetectionEgress, externalSignal?: AbortSignal): Promise<ProtocolDetection> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('协议探测超时')), this.options.timeoutMs ?? 30_000);
    const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
    const result: ProtocolDetection = { status: 'unknown', protocol: null, products: [], candidates: [], attempts: [] };
    const client = await createQualityFetch(undefined, { serverProxyUrl: egress.proxyUrl, proxyDns: egress.proxyDns, signal, reuseConnections: false,
      fetchImpl: this.options.fetchImpl, lookup: this.options.lookup });
    const requestBudget = protocol === undefined ? platforms.length * 6 : 6;
    let requests = 0, expectsHtml = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      signal.throwIfAborted();
      const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (target.origin !== url.origin) throw new Error('协议探测请求超出范围');
      let response: Response;
      for (let attempt = 0; ; attempt++) {
        if (++requests > requestBudget) throw new Error('协议探测请求超出范围');
        await this.options.limiter?.acquire(target.host, signal);
        signal.throwIfAborted();
        try {
          response = await client.fetch(target, { ...init, signal, redirect: 'manual', headers: mergeDefaultHeaders(init?.headers, target) });
          break;
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof Error && error.message === '检测请求不允许重定向') throw error;
          // Re-admit one observed Node disconnect within the same request/deadline budget.
          if (attempt === 0 && url.hostname === 'catfk.com' && isDisconnect(error)) continue;
          throw new Error('接口连接失败，请检查代理出口或稍后重试', { cause: error });
        }
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new Error('检测请求不允许重定向');
      }
      if ([404, 405].includes(response.status) || (response.ok && !contentType.includes(expectsHtml ? 'html' : 'json'))) {
        await response.body?.cancel();
        throw new NotThisProtocol();
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error('接口请求失败'); }
      return boundedResponse(response, signal, this.options.maxResponseBytes);
    };
    try {
      const candidates = platforms.filter(item => protocol === undefined || item.id === protocol)
        .sort((a, b) => Number(b.hosts.includes(url.hostname)) - Number(a.hosts.includes(url.hostname)));
      for (const adapter of candidates) {
        try {
          expectsHtml = adapter.responseFormat === 'html';
          signal.throwIfAborted();
          const products = await adapter.probe({ url: url.href }, fetchImpl);
          result.candidates.push({ protocol: adapter.id, name: adapter.name, products });
          result.attempts.push({ protocol: adapter.id, status: 'matched' });
        } catch (error) {
          externalSignal?.throwIfAborted();
          const message = error instanceof Error ? error.message : '';
          const reason = signal.aborted ? '接口请求超时，请稍后重试'
            : message === '检测请求不允许重定向' ? '接口发生重定向，无法验证'
            : ['接口响应超过大小限制', '接口请求失败', '接口连接失败，请检查代理出口或稍后重试'].includes(message)
              ? message : '接口返回内容不符合协议';
          result.attempts.push({ protocol: adapter.id, status: error instanceof NotThisProtocol ? 'unknown' : 'failed', reason });
        }
      }
      if (result.candidates.length > 1) result.status = 'ambiguous';
      else if (result.candidates.length === 1) {
        result.status = 'matched';
        result.protocol = result.candidates[0]!.protocol;
        result.products = result.candidates[0]!.products;
      } else if (result.attempts.some(item => item.status === 'failed')) result.status = 'failed';
      return result;
    } finally { clearTimeout(timeout); await client.close(); }
  }

  async requireMatch(url: string, protocol?: string): Promise<string> {
    const result = await this.detect(url, protocol);
    if (result.status !== 'matched' || !result.protocol) throw new DomainValidationError('SHOP_PROTOCOL_UNVERIFIED',
      result.status === 'ambiguous' ? '匹配多个采集协议，请手动选择并验证' : result.status === 'unknown' ? '未识别到支持的采集协议' : result.attempts.find(attempt => attempt.status === 'failed')?.reason ?? '协议验证失败，请稍后重新探测');
    return result.protocol;
  }
}

function isDisconnect(error: unknown): boolean {
  for (let depth = 0; depth < 4 && error instanceof Error; depth++, error = error.cause) {
    if (['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE'].includes(Reflect.get(error, 'code'))) return true;
  }
  return false;
}

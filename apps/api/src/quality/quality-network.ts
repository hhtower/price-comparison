import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, connect as netConnect, isIP, type Socket } from 'node:net';
import { Agent, Client, ProxyAgent, buildConnector, fetch as undiciFetch, type Dispatcher } from 'undici';
import { socksConnector } from 'fetch-socks';
import type { ParsedIpTarget } from './quality-input.js';

export type QualityLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
const reserved = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) reserved.addSubnet(address, prefix, 'ipv4');
const global6 = new BlockList(); global6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) reserved.addSubnet(address, prefix, 'ipv6');
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !reserved.check(address, 'ipv4') : family === 6 && global6.check(address, 'ipv6') && !reserved.check(address, 'ipv6');
}
const lookup: QualityLookup = host => dnsLookup(host, { all: true, verbatim: true });
export async function resolvePublicHost(hostname: string, resolve: QualityLookup = lookup, signal?: AbortSignal): Promise<{ address: string; family: number }> {
  const host = hostname.replace(/^\[|\]$/g, '');
  let addresses: Array<{ address: string; family: number }>;
  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(new Error('检测地址解析超时')), 10_000);
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  let onAbort = () => {};
  try {
    combined.throwIfAborted();
    const interrupted = new Promise<never>((_resolve, reject) => { onAbort = () => reject(combined.reason); combined.addEventListener('abort', onAbort, { once: true }); });
    addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await Promise.race([resolve(host), interrupted]);
    combined.throwIfAborted();
  } catch { if (combined.aborted) throw combined.reason; throw new Error('无法解析检测地址'); }
  finally { clearTimeout(timeout); combined.removeEventListener('abort', onAbort); }
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address) || isIP(item.address) !== item.family)) throw new Error('检测地址必须指向公网');
  return addresses[0];
}

function createPinnedProxyAgent(proxyUrl: string, url: URL, address: string, reuseConnections: boolean): ProxyAgent {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const host = (isIP(address) === 6 ? '[' + address + ']' : address) + ':' + port;
  return new ProxyAgent({
    uri: proxyUrl,
    proxyTunnel: true,
    proxyTls: { timeout: 10_000 },
    requestTls: { servername: hostname, timeout: 10_000 },
    factory(origin, options) {
      const { connect, ...settings } = options as Client.Options;
      if (typeof connect !== 'function') throw new Error('AI 代理配置无效');
      return new Client(origin, { ...settings, ...(reuseConnections ? {} : { pipelining: 0, allowH2: false }), connect: (connection, callback) => {
        // CONNECT receives the validated IP; HTTP Host and TLS identity keep the original hostname.
        connect({ ...connection, hostname: address, host, port, servername: hostname }, callback);
      } });
    },
  });
}

/** Every target is pinned to validated public addresses; never follows redirects. */
export async function createQualityFetch(proxy?: ParsedIpTarget, options: { lookup?: QualityLookup; fetchImpl?: typeof fetch; signal?: AbortSignal; serverProxyUrl?: string; reuseConnections?: boolean; proxyDns?: boolean } = {}): Promise<{ fetch: typeof fetch; dial: (host: string, port: number, signal?: AbortSignal) => Promise<{ ok: boolean; ms: number }>; close(): Promise<void> }> {
  // Only deployment-owned configuration may use a local/private proxy. User SOCKS targets stay public-only.
  const serverProxyUrl = options.serverProxyUrl?.trim();
  if (serverProxyUrl) {
    try {
      const parsed = new URL(serverProxyUrl);
      if (!['http:', 'https:', 'socks5:'].includes(parsed.protocol) || !['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash) throw new Error();
      decodeURIComponent(parsed.username); decodeURIComponent(parsed.password);
    } catch { throw new Error('AI 代理配置无效'); }
  }
  const resolve = options.lookup ?? lookup;
  const proxyAddress = proxy ? await resolvePublicHost(proxy.host, resolve, options.signal) : undefined;
  if (proxy && (proxy.type !== 'socks' || !proxy.port)) throw new Error('代理地址无效');
  const dispatchers = new Map<string, Dispatcher>();
  const chainedDispatchers = new Set<Dispatcher>();
  const tunnelSockets = new Set<Socket>();
  const lifetime = new AbortController();
  let upstreamClient: Client | undefined;
  let closed = false;
  const send = options.fetchImpl ?? undiciFetch as unknown as typeof fetch;
  const safeFetch: typeof fetch = async (input, init) => {
    if (closed) throw new Error('检测连接已关闭');
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('检测地址无效');
    init?.signal?.throwIfAborted();
    // proxyDns：出口侧 DNS 与本地不一致（如国内解析被污染）时，跳过本地解析，CONNECT 用域名由部署侧代理解析。
    const resolved = options.proxyDns && serverProxyUrl && !proxy ? undefined : await resolvePublicHost(url.hostname, resolve, init?.signal ?? undefined);
    init?.signal?.throwIfAborted();
    if (closed) throw new Error('检测连接已关闭');
    const key = url.origin + '/' + (resolved?.address ?? 'proxy-dns');
    let dispatcher = dispatchers.get(key);
    if (proxy && serverProxyUrl) {
      const upstream = new URL(serverProxyUrl);
      upstreamClient ??= new Client(upstream.origin, { connect: { timeout: 10_000 }, headersTimeout: 10_000 });
      const client = upstreamClient;
      const path = (proxyAddress!.family === 6 ? '[' + proxyAddress!.address + ']' : proxyAddress!.address) + ':' + proxy.port;
      const headers = upstream.username || upstream.password ? { 'proxy-authorization': 'Basic ' + Buffer.from(decodeURIComponent(upstream.username) + ':' + decodeURIComponent(upstream.password)).toString('base64') } : undefined;
      const connect = socksConnector({ type: 5, host: proxyAddress!.address, port: proxy.port!, userId: proxy.username, password: proxy.password }, { timeout: 10_000 });
      // Each request owns its handshake cancellation; no expired probe signal is reused.
      dispatcher = new Agent({ connect: (connection, callback) => {
        const signals = [lifetime.signal, AbortSignal.timeout(10_000)];
        if (init?.signal) signals.push(init.signal);
        const signal = AbortSignal.any(signals);
        let socket: Socket | undefined;
        const abort = () => socket?.destroy(new Error('检测连接已中止'));
        signal.addEventListener('abort', abort, { once: true });
        const establish = async () => {
          signal.throwIfAborted();
          const tunnel = await client.connect({ path, headers, signal });
          socket = tunnel.socket as Socket;
          tunnelSockets.add(socket);
          const trackedSocket = socket;
          socket.once('close', () => tunnelSockets.delete(trackedSocket));
          signal.throwIfAborted();
          if (tunnel.statusCode !== 200) throw new Error('上游代理连接失败');
          // The upstream CONNECT reaches SOCKS, and SOCKS reaches the validated destination.
          const connected = await new Promise<Socket>((resolve, reject) => {
            connect({ ...connection, hostname: resolved!.address, host: resolved!.address, servername: url.hostname.replace(/^\[|\]$/g, ''), httpSocket: socket }, (error, value) => error ? reject(error) : resolve(value!));
          });
          signal.throwIfAborted();
          return connected;
        };
        void establish().then(value => {
          signal.removeEventListener('abort', abort);
          callback(null, value);
        }, () => {
          signal.removeEventListener('abort', abort);
          socket?.destroy();
          callback(new Error('检测网络请求失败'), null);
        });
      } });
      chainedDispatchers.add(dispatcher);
    }
    if (!dispatcher && serverProxyUrl) {
      const upstream = new URL(serverProxyUrl);
      if (upstream.protocol === 'socks5:') {
        const connect = socksConnector({ type: 5, host: upstream.hostname.replace(/^\[|\]$/g, ''), port: Number(upstream.port) || 1080,
          userId: decodeURIComponent(upstream.username), password: decodeURIComponent(upstream.password) }, { timeout: 10_000 });
        dispatcher = new Agent({ ...(options.reuseConnections === false ? { pipelining: 0, allowH2: false } : {}), connect: (connection, callback) => {
          // Own the socket before SOCKS starts so abort/close also stops a stalled handshake.
          const signal = init?.signal ? AbortSignal.any([lifetime.signal, init.signal]) : lifetime.signal;
          const socket = netConnect({ host: upstream.hostname.replace(/^\[|\]$/g, ''), port: Number(upstream.port) || 1080, signal });
          tunnelSockets.add(socket);
          socket.once('close', () => tunnelSockets.delete(socket));
          const timeout = setTimeout(() => socket.destroy(new Error('检测连接超时')), 10_000);
          let done = false;
          const finish = (error: Error | null, value: Socket | null = null) => {
            if (done) return;
            done = true;
            clearTimeout(timeout);
            socket.removeListener('error', onError);
            if (error) { socket.destroy(); callback(error, null); }
            else callback(null, value!);
          };
          const onError = (error: Error) => finish(error);
          socket.once('error', onError);
          socket.once('connect', () => connect({ ...connection, hostname: resolved!.address, host: resolved!.address,
            servername: url.hostname.replace(/^\[|\]$/g, ''), httpSocket: socket }, finish));
        } });
        // A request owns its cancellation signal; sharing this agent would reuse an expired signal.
        chainedDispatchers.add(dispatcher);
      } else if (options.proxyDns) {
        dispatcher = new ProxyAgent({ uri: serverProxyUrl, proxyTunnel: true, proxyTls: { timeout: 10_000 }, requestTls: { timeout: 10_000 } });
        dispatchers.set(key, dispatcher);
      } else {
        dispatcher = createPinnedProxyAgent(serverProxyUrl, url, resolved!.address, options.reuseConnections !== false);
        dispatchers.set(key, dispatcher);
      }
    }
    if (!dispatcher) {
      const connect = proxy ? socksConnector({ type: 5, host: proxyAddress!.address, port: proxy.port!, userId: proxy.username, password: proxy.password }, { timeout: 10_000 }) : buildConnector({ timeout: 10_000 });
      dispatcher = new Agent({ connect: (connection, callback) => {
        // Preserve original TLS SNI/certificate verification, only change the socket target.
        connect({ ...connection, hostname: resolved!.address, host: resolved!.address, servername: url.hostname.replace(/^\[|\]$/g, '') }, callback);
      } });
      dispatchers.set(key, dispatcher);
    }
    try {
      const response = await send(input, { ...init, redirect: 'manual', dispatcher } as RequestInit);
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error('检测请求不允许重定向'); }
      return response;
    } catch (error) {
      if (init?.signal?.aborted) throw init.signal.reason;
      if (error instanceof Error && error.message === '检测请求不允许重定向') throw error;
      // Upstream errors can contain keys and proxy passwords. Never propagate them.
      throw new Error('检测网络请求失败', { cause: error });
    }
  };
  /** Raw TCP handshake through the same exit path (user SOCKS tunnel or direct); for SMTP/port probes. */
  const dial = (host: string, port: number, dialSignal?: AbortSignal): Promise<{ ok: boolean; ms: number }> => new Promise(resolve => {
    if (closed) { resolve({ ok: false, ms: 0 }); return; }
    type ConnectFn = (options: Record<string, unknown>, callback: (error: Error | null, socket?: Socket) => void) => void;
    const connector = (proxy
      ? socksConnector({ type: 5, host: proxyAddress!.address, port: proxy.port!, userId: proxy.username, password: proxy.password }, { timeout: 10_000 })
      : buildConnector({ timeout: 10_000 })) as unknown as ConnectFn;
    const startedAt = performance.now();
    const signals = [lifetime.signal, AbortSignal.timeout(10_000)];
    if (dialSignal) signals.push(dialSignal);
    const guard = AbortSignal.any(signals);
    let done = false;
    const elapsed = () => Math.max(0, Math.round(performance.now() - startedAt));
    const finish = (ok: boolean) => { if (done) return; done = true; guard.removeEventListener('abort', onAbort); resolve({ ok, ms: elapsed() }); };
    const onAbort = () => finish(false);
    guard.addEventListener('abort', onAbort, { once: true });
    connector({ hostname: host, host, port, protocol: 'http:' }, (error, socket) => {
      if (error || !socket) { finish(false); return; }
      socket.destroy();
      finish(true);
    });
  });
  return { fetch: safeFetch, dial, async close() {
    if (closed) return;
    closed = true;
    lifetime.abort();
    for (const socket of tunnelSockets) socket.destroy();
    const owned = [...dispatchers.values(), ...chainedDispatchers, ...(upstreamClient ? [upstreamClient] : [])];
    await Promise.allSettled(owned.map(agent => agent.destroy()));
    dispatchers.clear(); chainedDispatchers.clear(); tunnelSockets.clear();
  } };
}

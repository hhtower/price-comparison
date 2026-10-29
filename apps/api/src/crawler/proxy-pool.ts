import { ProxyAgent, type Dispatcher } from 'undici';
import { socksDispatcher } from 'fetch-socks';
import { sleep } from '../common/sleep.js';

export type ProxyFailureKind = 'connection' | 'blocked' | 'authentication';

export class ProxyAuthenticationError extends Error {
  readonly retryClass = 'configuration';
  readonly retryable = false;
  constructor() {
    super('crawler proxy authentication failed (HTTP 407); check credentials or whitelist');
    this.name = 'ProxyAuthenticationError';
  }
}

export interface ProxyLease {
  readonly proxyUrl: string | null;      // null = 直连
  readonly dispatcher: Dispatcher | undefined;
  reportSuccess(): void;
  reportFailure(kind: ProxyFailureKind): void;
  release(): void;
  isHealthy(): boolean;
}

export interface ProxyPoolOptions {
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly dispatcherFactory?: (proxyUrl: string) => Dispatcher;
  readonly cooldownBaseMs?: number;   // Override connection (5s) / explicit block (5min) base.
  readonly cooldownMaxMs?: number;    // Override connection (60s) / explicit block (1h) cap.
  readonly onEvent?: (event: { type: string; endpoint: string; delayMs?: number }) => void;
}

const DEFAULT_COOLDOWN_BASE_MS = 300_000;
const DEFAULT_COOLDOWN_MAX_MS = 3_600_000;

export const isSocksProxy = (value: string | undefined): boolean => value?.startsWith('socks5://') ?? false;

interface PoolEntry {
  readonly proxyUrl: string;
  readonly dispatcher: Dispatcher;
  cooldownUntil: number;
  consecutiveFailures: number;
  version: number;
  probe: symbol | undefined;
  disabled: boolean;
}

/**
 * 混合协议派发器工厂：SOCKS5 代理走 fetch-socks，其余走 undici ProxyAgent。
 */
export function createDispatcher(proxyUrl: string, { reuseConnections = true }: { reuseConnections?: boolean } = {}): Dispatcher {
  const connectionOptions = reuseConnections ? {} : { pipelining: 0, allowH2: false };
  if (!isSocksProxy(proxyUrl)) return new ProxyAgent({ uri: proxyUrl, proxyTunnel: true, ...connectionOptions });
  const url = new URL(proxyUrl);
  return socksDispatcher({
    host: url.hostname,
    port: Number(url.port) || 1080,
    type: 5,
    ...(url.username ? { userId: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  }, connectionOptions);
}

/** Per-request leases, run affinity, and one half-open request per recovering endpoint. */
export class ProxyPool {
  private readonly entries: PoolEntry[];
  private readonly directLease: ProxyLease = {
    proxyUrl: null, dispatcher: undefined,
    reportSuccess() {},
    reportFailure() {},
    release() {},
    isHealthy: () => true,
  };
  private cursor = -1; // 初始 -1：首个 acquire 从 entries[0] 开始轮转
  private readonly waiters = new Set<() => void>();
  private unavailableSince: number | undefined;
  private unavailableMs = 0;
  private readonly counters = {
    proxy_cooldown_count: 0, proxy_recovery_probe: 0, proxy_recovery_success: 0,
    proxy_recovery_failure: 0, proxy_auth_failure: 0,
  };

  constructor(
    proxyUrls: readonly string[],
    private readonly options: ProxyPoolOptions = {},
  ) {
    // Reuse entry health and dispatchers, but never a crawler's proxy tunnel.
    const factory = options.dispatcherFactory ?? (url => createDispatcher(url, { reuseConnections: false }));
    this.entries = proxyUrls.map(url => ({
      proxyUrl: url,
      dispatcher: factory(url),
      cooldownUntil: 0,
      consecutiveFailures: 0,
      version: 0,
      probe: undefined,
      disabled: false,
    }));
  }

  async acquire(signal?: AbortSignal, preferredProxyUrl?: string | null, admit?: () => Promise<void>, acceptProxy?: (url: string) => boolean): Promise<ProxyLease> {
    signal?.throwIfAborted();
    const eligible = this.entries.filter(entry => !acceptProxy || acceptProxy(entry.proxyUrl));
    if (acceptProxy && !eligible.length) throw new Error('未配置符合出口策略的代理');
    if (this.entries.length === 0) {
      await admit?.();
      signal?.throwIfAborted();
      return this.directLease;
    }
    acquisition: for (;;) {
      signal?.throwIfAborted();
      const preferred = this.entries.findIndex(entry => entry.proxyUrl === preferredProxyUrl);
      const start = preferred >= 0 ? preferred : (this.cursor + 1) % this.entries.length;
      for (let index = 0; index < this.entries.length; index += 1) {
        const position = (start + index) % this.entries.length;
        const entry = this.entries[position]!;
        if (acceptProxy && !acceptProxy(entry.proxyUrl)) continue;
        if (entry.disabled || entry.probe || entry.cooldownUntil > this.now()) continue;
        // Do not hold the half-open slot while this host is paused or rate limited.
        if (admit) {
          await admit();
          signal?.throwIfAborted();
          if (entry.disabled || entry.probe || entry.cooldownUntil > this.now()) continue acquisition;
        }
        this.cursor = position;
        return this.leaseFor(entry, signal);
      }
      if (eligible.every(entry => entry.disabled)) throw new ProxyAuthenticationError();
      const wakeAt = Math.min(...eligible.filter(entry => !entry.disabled && !entry.probe).map(entry => entry.cooldownUntil));
      await this.waitForChange(Number.isFinite(wakeAt) ? Math.max(1, wakeAt - this.now()) : undefined, signal);
    }
  }

  snapshot(): Readonly<Record<string, number>> {
    return { ...this.counters, proxy_unavailable_ms: this.unavailableMs
      + (this.unavailableSince === undefined ? 0 : Math.max(0, this.now() - this.unavailableSince)) };
  }

  private leaseFor(entry: PoolEntry, signal?: AbortSignal): ProxyLease {
    const version = entry.version;
    const probe = entry.consecutiveFailures > 0 ? Symbol('recovery') : undefined;
    let released = false;
    if (probe) {
      entry.probe = probe;
      this.counters.proxy_recovery_probe++;
      this.emit(entry, 'recovery_probe');
    }
    const release = () => {
      if (released) return;
      released = true;
      signal?.removeEventListener('abort', release);
      if (probe && entry.probe === probe) {
        entry.probe = undefined;
        this.changed();
      }
    };
    signal?.addEventListener('abort', release, { once: true });
    return {
      proxyUrl: entry.proxyUrl,
      dispatcher: entry.dispatcher,
      reportSuccess: () => {
        if (released || entry.version !== version) return;
        if (probe) {
          this.counters.proxy_recovery_success++;
          this.emit(entry, 'recovery_success');
        }
        entry.consecutiveFailures = 0;
        entry.cooldownUntil = 0;
        release();
        this.changed();
      },
      reportFailure: (kind) => {
        if (released || entry.version !== version) return;
        entry.version += 1;
        entry.consecutiveFailures += 1;
        if (probe) this.counters.proxy_recovery_failure++;
        if (kind === 'authentication') {
          entry.disabled = true;
          this.counters.proxy_auth_failure++;
          this.emit(entry, 'authentication_failed');
        } else {
          const base = this.options.cooldownBaseMs ?? (kind === 'connection' ? 5_000 : DEFAULT_COOLDOWN_BASE_MS);
          const max = this.options.cooldownMaxMs ?? (kind === 'connection' ? 60_000 : DEFAULT_COOLDOWN_MAX_MS);
          const delayMs = Math.min(max, base * 2 ** Math.min(30, entry.consecutiveFailures - 1));
          entry.cooldownUntil = this.now() + delayMs;
          this.counters.proxy_cooldown_count++;
          this.emit(entry, probe ? 'recovery_failed' : 'cooldown', delayMs);
        }
        release();
        this.changed();
      },
      release,
      isHealthy: () => !released && !entry.disabled && entry.version === version && entry.cooldownUntil <= this.now(),
    };
  }

  private changed(): void {
    const unavailable = this.entries.length > 0 && this.entries.every(entry => entry.disabled || entry.consecutiveFailures > 0);
    if (unavailable && this.unavailableSince === undefined) this.unavailableSince = this.now();
    if (!unavailable && this.unavailableSince !== undefined) {
      this.unavailableMs += Math.max(0, this.now() - this.unavailableSince);
      this.unavailableSince = undefined;
    }
    for (const wake of [...this.waiters]) wake();
  }

  private emit(entry: PoolEntry, type: string, delayMs?: number): void {
    const url = new URL(entry.proxyUrl);
    this.options.onEvent?.({ type, endpoint: `${url.protocol}//${url.host}`, ...(delayMs === undefined ? {} : { delayMs }) });
  }

  private waitForChange(delayMs: number | undefined, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const timer = new AbortController();
      const finish = (error?: unknown) => {
        this.waiters.delete(wake);
        signal?.removeEventListener('abort', abort);
        timer.abort();
        if (error !== undefined) reject(error); else resolve();
      };
      const wake = () => finish();
      const abort = () => finish(signal!.reason);
      this.waiters.add(wake);
      signal?.addEventListener('abort', abort, { once: true });
      if (delayMs !== undefined) void (this.options.sleep ?? sleep)(delayMs, timer.signal).then(wake, error => {
        if (!timer.signal.aborted) finish(error);
      });
      if (signal?.aborted) abort();
    });
  }

  private now(): number {
    return (this.options.now ?? (() => Date.now()))();
  }
}

import { sleep as defaultSleep } from '../common/sleep.js';

export interface HostRateLimitRedis {
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
}

interface HostRateLimitStore {
  acquire(host: string, intervalMs: number): Promise<number>;
  pause(host: string, delayMs: number): Promise<void>;
}

const CLAIM_HOST_SLOT = `local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local interval = tonumber(ARGV[1])
local next_start = tonumber(redis.call('GET', KEYS[1])) or 0
if next_start > now then return next_start - now end
redis.call('SET', KEYS[1], now + interval, 'PX', math.max(interval, 60000))
return 0`;

const PAUSE_HOST = `local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local until_at = math.max(tonumber(redis.call('GET', KEYS[1])) or 0, now + tonumber(ARGV[1]))
redis.call('SET', KEYS[1], until_at, 'PX', math.max(until_at - now, 60000))
return until_at`;

export function createSharedHostRateLimiter(
  intervals: ReadonlyMap<string, number>,
  redis?: HostRateLimitRedis,
  wait: typeof defaultSleep = defaultSleep,
): HostRateLimiter {
  const store = redis ? {
    async acquire(host: string, intervalMs: number): Promise<number> {
      const delay = await redis.eval(CLAIM_HOST_SLOT, 1, `crawler:host-rate:v1:${host}`, String(intervalMs));
      if (typeof delay !== 'number' || !Number.isSafeInteger(delay) || delay < 0) throw new Error('invalid shared crawler rate delay');
      return delay;
    },
    async pause(host: string, delayMs: number): Promise<void> {
      await redis.eval(PAUSE_HOST, 1, `crawler:host-rate:v1:${host}`, String(delayMs));
    },
  } : undefined;
  return new HostRateLimiter(intervals, Date.now, wait, store);
}

/** Serialize request starts per host with a minimum spacing (the hard anti-ban budget). */
export class HostRateLimiter {
  private readonly lastStartAt = new Map<string, number>();
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly pausedUntil = new Map<string, number>();

  constructor(
    private readonly minIntervalMs: ReadonlyMap<string, number>,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: typeof defaultSleep = defaultSleep,
    private readonly store?: HostRateLimitStore,
  ) {}

  acquire(host: string, signal?: AbortSignal): Promise<void> {
    const previous = this.tails.get(host) ?? Promise.resolve();
    const task = this.waitFor(previous, signal).then(() => this.wait(host, signal));
    this.tails.set(host, task.catch(() => {}));
    return task;
  }

  async pause(host: string, delayMs: number): Promise<void> {
    if (this.store) await this.store.pause(host, delayMs);
    else this.pausedUntil.set(host, Math.max(this.pausedUntil.get(host) ?? 0, this.now() + delayMs));
  }

  private async waitFor(previous: Promise<unknown>, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!signal) { await previous; return; }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(signal.reason); };
      signal.addEventListener('abort', onAbort, { once: true });
      previous.then(() => { signal.removeEventListener('abort', onAbort); resolve(); }, reject);
      if (signal.aborted) onAbort();
    });
  }

  private async wait(host: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const interval = this.minIntervalMs.get(host) ?? 1_000;
    if (this.store) {
      for (;;) {
        const delay = await this.store.acquire(host, interval);
        signal?.throwIfAborted();
        if (delay === 0) return;
        await this.sleep(delay, signal);
        signal?.throwIfAborted();
      }
    }
    for (;;) {
      const last = this.lastStartAt.get(host);
      const next = Math.max(last === undefined ? 0 : last + interval, this.pausedUntil.get(host) ?? 0);
      const delay = Math.max(0, next - this.now());
      if (delay === 0) break;
      await this.sleep(delay, signal);
      signal?.throwIfAborted();
    }
    signal?.throwIfAborted();
    this.lastStartAt.set(host, this.now());
  }
}

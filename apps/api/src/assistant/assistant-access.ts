import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { ServiceUnavailableException, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { ASSISTANT_LIMITS } from '@price-comparison/catalog/assistant-contract';
import { createAiConcurrencyRedisClient, type AiConcurrencyRedis } from '../ai/ai-concurrency.js';
import { RateLimitExceededException, type RateLimitStore } from '../common/rate-limit.guard.js';

type ClientRequest = { ip?: string; headers?: Record<string, string | string[] | undefined> };
type RateReply = { header(name: string, value: string): unknown };
export interface AssistantSubscription {
  renew(): Promise<void>;
  release(): Promise<void>;
}

const ttlMs = 30_000;
const ACQUIRE = `-- ASSISTANT_STREAM_ACQUIRE
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[1]) then return 0 end
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1`;
const RENEW = `-- ASSISTANT_STREAM_RENEW
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local expiry = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not expiry or tonumber(expiry) <= now then return 0 end
redis.call('ZADD', KEYS[1], 'XX', now + tonumber(ARGV[2]), ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1`;
const RELEASE = `-- ASSISTANT_STREAM_RELEASE
return redis.call('ZREM', KEYS[1], ARGV[1])`;

export class AssistantAccess implements OnApplicationShutdown {
  private redis?: AiConcurrencyRedis;
  private connecting?: Promise<unknown>;

  constructor(
    private readonly store: RateLimitStore,
    private readonly createRedis: () => AiConcurrencyRedis = createAiConcurrencyRedisClient,
  ) {}

  async admit(kind: 'session' | 'turn', request: ClientRequest, reply?: RateReply): Promise<void> {
    let address = request.ip?.trim() || 'unknown';
    if (process.env.TRUST_PROXY === 'true') {
      const forwarded = request.headers?.['x-forwarded-for'];
      const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      if (first?.trim()) address = first.split(',', 1)[0]!.trim();
    }
    let result;
    try { result = await this.store.hit(`assistant:admission:${kind}:${address}`, 60_000); }
    catch { throw new ServiceUnavailableException('Assistant admission unavailable'); }
    const limit = kind === 'session' ? ASSISTANT_LIMITS.sessionCreatesPerIpPerMinute : ASSISTANT_LIMITS.messagesPerIpPerMinute;
    if (!Number.isSafeInteger(result.count) || result.count < 1 || !Number.isFinite(result.retryAfterMs)) {
      throw new ServiceUnavailableException('Assistant admission unavailable');
    }
    if (result.count > limit) {
      reply?.header('retry-after', String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
      throw new RateLimitExceededException();
    }
  }

  async acquire(sessionId: string): Promise<AssistantSubscription> {
    // Canonical UUID keys share the limit even when a caller changes UUID casing.
    const key = `assistant:streams:${sessionId.toLowerCase()}`;
    const token = randomUUID();
    const call = async (script: string, ...args: string[]): Promise<unknown> => {
      try {
        this.redis ??= this.createRedis();
        if (this.redis instanceof Redis && this.redis.status !== 'ready') {
          // The shared constructor disables offline queuing; wait for its first connection.
          this.connecting ??= once(this.redis, 'ready', { signal: AbortSignal.timeout(5000) })
            .finally(() => { this.connecting = undefined; });
          await this.connecting;
        }
        return await this.redis.eval(script, 1, key, ...args);
      } catch { throw new ServiceUnavailableException('Assistant subscriptions unavailable'); }
    };
    const result = await call(ACQUIRE, String(ASSISTANT_LIMITS.sessionMaxSubscriptions), String(ttlMs), token);
    if (result === 0) throw new RateLimitExceededException();
    if (result !== 1) throw new ServiceUnavailableException('Assistant subscriptions unavailable');
    let releasing: Promise<void> | undefined;
    return {
      async renew() {
        if (releasing) return;
        if (await call(RENEW, token, String(ttlMs)) !== 1) {
          throw new ServiceUnavailableException('Assistant subscription expired');
        }
      },
      release() {
        releasing ??= call(RELEASE, token).then(() => undefined);
        return releasing;
      },
    };
  }

  onApplicationShutdown(): void { this.redis?.disconnect?.(); }
}

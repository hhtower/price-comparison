import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { sleep } from '../common/sleep.js';

export type AiStage = 'standardization' | 'quality';

export interface AiConcurrencyRedis {
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
  disconnect?(): void;
}

export interface AiLease {
  readonly tokenId: string;
  readonly queueWaitMs: number;
  heartbeat(): Promise<void>;
  release(): Promise<void>;
}

export interface AiConcurrencyCoordinator {
  acquire(input: { workerId: string; stage: AiStage; signal: AbortSignal }): Promise<AiLease>;
}

export interface AiConcurrencyOptions {
  readonly concurrency: number;
  readonly key?: string;
  readonly ttlMs?: number;
  readonly pollMs?: number;
  readonly maxWaitMs?: number;
}

const ACQUIRE = `-- AI_CONCURRENCY_ACQUIRE
local now = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
for _, token in ipairs(redis.call('HKEYS', KEYS[1])) do
  local current = redis.call('HGET', KEYS[1], token)
  local expiry = tonumber(string.match(current or '', '|(%d+)$'))
  if not expiry or expiry <= now then redis.call('HDEL', KEYS[1], token) end
end
if redis.call('HLEN', KEYS[1]) >= limit then return 0 end
redis.call('HSET', KEYS[1], ARGV[4], ARGV[5] .. '|' .. (now + ttl))
redis.call('PEXPIRE', KEYS[1], ttl)
return 1`;

const HEARTBEAT = `-- AI_CONCURRENCY_HEARTBEAT
local current = redis.call('HGET', KEYS[1], ARGV[1])
local divider = current and string.find(current, '|', 1, true) or nil
local owner = divider and string.sub(current, 1, divider - 1) or nil
local expiry = divider and string.sub(current, divider + 1) or nil
if not owner or owner ~= ARGV[2] or tonumber(expiry) <= tonumber(ARGV[3]) then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], owner .. '|' .. (tonumber(ARGV[3]) + tonumber(ARGV[4])))
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return 1`;

const RELEASE = `-- AI_CONCURRENCY_RELEASE
local current = redis.call('HGET', KEYS[1], ARGV[1])
local divider = current and string.find(current, '|', 1, true) or nil
local owner = divider and string.sub(current, 1, divider - 1) or nil
local expiry = divider and string.sub(current, divider + 1) or nil
if not owner or owner ~= ARGV[2] then return 0 end
return redis.call('HDEL', KEYS[1], ARGV[1])`;

export function readAiConcurrency(environment: NodeJS.ProcessEnv = process.env): number {
  const raw = environment.AI_CONCURRENCY?.trim();
  if (!raw) return 2;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('AI concurrency must be a positive integer');
  return value;
}

export function createAiConcurrencyCoordinator(
  redis: AiConcurrencyRedis,
  options: AiConcurrencyOptions,
): AiConcurrencyCoordinator {
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) throw new Error('AI concurrency must be a positive integer');
  const key = options.key ?? 'ai:llm:semaphore';
  const ttlMs = options.ttlMs ?? 30_000;
  const pollMs = options.pollMs ?? 50;
  const maxWaitMs = options.maxWaitMs ?? 30_000;
  if (![ttlMs, pollMs, maxWaitMs].every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error('AI concurrency timing must be a positive integer');

  const redisCall = async (script: string, args: string[]): Promise<unknown> => {
    try { return await redis.eval(script, 1, key, ...args); }
    catch (error) {
      const unavailable = new Error('AI_CONCURRENCY_UNAVAILABLE');
      unavailable.cause = error;
      throw unavailable;
    }
  };

  return {
    async acquire({ workerId, stage, signal }): Promise<AiLease> {
      const owner = `${workerId}:${stage}`;
      const startedAt = performance.now();
      for (;;) {
        signal.throwIfAborted();
        const tokenId = randomUUID();
        const acquired = await redisCall(ACQUIRE, [String(Date.now()), String(options.concurrency), String(ttlMs), tokenId, owner]);
        if (Number(acquired) === 1) {
          if (signal.aborted) {
            await redisCall(RELEASE, [tokenId, owner]);
            signal.throwIfAborted();
          }
          let released = false;
          return {
            tokenId,
            queueWaitMs: Math.round(performance.now() - startedAt),
            async heartbeat() {
              if (released) return;
              const result = await redisCall(HEARTBEAT, [tokenId, owner, String(Date.now()), String(ttlMs)]);
              if (Number(result) !== 1) throw new Error('AI_CONCURRENCY_LEASE_LOST');
            },
            async release() {
              if (released) return;
              released = true;
              await redisCall(RELEASE, [tokenId, owner]);
            },
          };
        }
        if (performance.now() - startedAt >= maxWaitMs) throw new Error('AI_CONCURRENCY_QUEUE_TIMEOUT');
        await sleep(pollMs, signal);
      }
    },
  };
}

export function createAiConcurrencyRedisClient(environment: NodeJS.ProcessEnv = process.env): AiConcurrencyRedis {
  const url = environment.REDIS_URL?.trim();
  if (!url || !/^rediss?:\/\//iu.test(url)) return { eval: async () => { throw new Error('Redis is not configured'); } };
  const client = new Redis(url, { enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 5_000 });
  client.on('error', () => undefined);
  return client;
}

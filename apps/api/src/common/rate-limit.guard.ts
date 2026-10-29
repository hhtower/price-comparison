import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Redis } from 'ioredis';

export const RATE_LIMIT_STORE = Symbol('RATE_LIMIT_STORE');
export const RATE_LIMIT_OPTIONS = Symbol('RATE_LIMIT_OPTIONS');

export interface RateLimitResult {
  readonly count: number;
  readonly retryAfterMs: number;
}

export interface RateLimitStore {
  hit(key: string, windowMs: number): Promise<RateLimitResult>;
  close?(): Promise<void> | void;
}

export interface RateLimitOptions {
  readonly maxRequests?: number;
  readonly windowMs?: number;
}

export class RateLimitExceededException extends HttpException {
  constructor() {
    super('请求过于频繁，请稍后重试', HttpStatus.TOO_MANY_REQUESTS);
  }
}

class UnavailableRateLimitStore implements RateLimitStore {
  hit(): Promise<RateLimitResult> {
    return Promise.reject(new Error('Redis is required for distributed rate limiting'));
  }
}

const RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return { count, redis.call('PTTL', KEYS[1]) }
`;

export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: Pick<Redis, 'eval' | 'disconnect'>) {}

  static fromUrl(url: string): RedisRateLimitStore {
    const redis = new Redis(url, {
      enableOfflineQueue: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 5_000,
    });
    redis.on('error', () => undefined);
    return new RedisRateLimitStore(redis);
  }

  async hit(key: string, windowMs: number): Promise<RateLimitResult> {
    const result = await this.redis.eval(
      RATE_LIMIT_SCRIPT,
      1,
      key,
      String(windowMs),
    );
    if (!Array.isArray(result) || result.length < 2) {
      throw new Error('invalid Redis rate-limit response');
    }
    return {
      count: Number(result[0]),
      retryAfterMs: Math.max(1, Number(result[1])),
    };
  }

  close(): void {
    this.redis.disconnect();
  }
}

export function createRateLimitStore(
  environment: NodeJS.ProcessEnv = process.env,
): RateLimitStore {
  const url = (
    environment.RATE_LIMIT_REDIS_URL ??
    environment.REDIS_URL ??
    ''
  ).trim();
  if (!url) return new UnavailableRateLimitStore();
  if (!/^rediss?:\/\//iu.test(url)) {
    throw new Error('RATE_LIMIT_REDIS_URL must use redis:// or rediss://');
  }
  return RedisRateLimitStore.fromUrl(url);
}

export function rateLimitOptions(
  environment: NodeJS.ProcessEnv = process.env,
): Required<RateLimitOptions> {
  return {
    maxRequests: positiveInteger(environment.RATE_LIMIT_MAX, 60),
    windowMs: positiveInteger(environment.RATE_LIMIT_WINDOW_MS, 60_000),
  };
}

@Injectable()
export class RateLimitGuard implements CanActivate, OnApplicationShutdown {
  private readonly store: RateLimitStore;
  private readonly options: Required<RateLimitOptions>;

  constructor(
    @Optional() @Inject(RATE_LIMIT_STORE) store?: RateLimitStore,
    @Optional() @Inject(RATE_LIMIT_OPTIONS) options?: RateLimitOptions,
  ) {
    this.store = store ?? createRateLimitStore();
    this.options = {
      ...rateLimitOptions(),
      ...options,
    };
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<{
      headers?: Record<string, string | string[] | undefined>;
      ip?: string;
      method?: string;
      url?: string;
      routeOptions?: { url?: string };
    }>();
    const response = http.getResponse<{
      header?: (name: string, value: string) => unknown;
    }>();
    const client = this.clientAddress(request);
    const route = request.routeOptions?.url ?? request.url?.split('?', 1)[0] ?? '/';
    if (route === '/health' || route === '/ready' || route === '/metrics') {
      return true;
    }
    const key = `rate-limit:${request.method ?? 'UNKNOWN'}:${route}:${client}`;
    let result: RateLimitResult;
    try {
      result = await this.store.hit(key, this.options.windowMs);
    } catch {
      throw new ServiceUnavailableException('rate limiter unavailable');
    }
    response.header?.(
      'x-ratelimit-limit',
      String(this.options.maxRequests),
    );
    response.header?.(
      'x-ratelimit-remaining',
      String(Math.max(0, this.options.maxRequests - result.count)),
    );
    if (result.count <= this.options.maxRequests) return true;

    const retryAfterSeconds = Math.max(
      1,
      Math.ceil(result.retryAfterMs / 1_000),
    );
    response.header?.('retry-after', String(retryAfterSeconds));
    throw new RateLimitExceededException();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.store.close?.();
  }

  private clientAddress(request: {
    headers?: Record<string, string | string[] | undefined>;
    ip?: string;
  }): string {
    if (process.env.TRUST_PROXY === 'true') {
      const forwarded = request.headers?.['x-forwarded-for'];
      const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      if (first?.trim()) return first.split(',', 1)[0]!.trim();
    }
    return request.ip?.trim() || 'unknown';
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value === undefined || value.trim() === '' ? fallback : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

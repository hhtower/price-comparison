import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Redis } from 'ioredis';
import {
  Inject,
  Injectable,
  UnauthorizedException,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import type { Kysely } from 'kysely';
import { DATABASE } from '../database/database.providers.js';
import type { DatabaseSchema } from '../database/types.js';

export const REDIS = Symbol('REDIS');
export const SESSION_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_SESSION_KEY_PREFIX = 'admin:';
const KEY_PREFIX_PATTERN = /^[A-Za-z0-9_.:-]+$/;

export interface SessionStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  disconnect?(): void;
  ping?(): Promise<unknown>;
  quit?(): Promise<unknown>;
}

export interface Session {
  readonly token: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly ttlSeconds: number;
}

const scryptAsync = promisify(scrypt) as unknown as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options?: { N?: number; r?: number; p?: number; maxmem?: number },
) => Promise<Buffer>;

export function createSessionStore(environment: NodeJS.ProcessEnv = process.env): SessionStore {
  const url = environment.REDIS_URL?.trim();
  if (!url) throw new Error('REDIS_URL is required for authentication');
  const parsed = new URL(url);
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error('REDIS_URL must use redis:// or rediss://');
  }
  const prefix = environment.AUTH_SESSION_KEY_PREFIX?.trim() || DEFAULT_SESSION_KEY_PREFIX;
  if (!KEY_PREFIX_PATTERN.test(prefix)) {
    throw new Error('AUTH_SESSION_KEY_PREFIX contains unsupported characters');
  }
  return new Redis(url, {
    enableOfflineQueue: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
  });
}

export function adminSessionKey(token: string, prefix = process.env.AUTH_SESSION_KEY_PREFIX?.trim() || DEFAULT_SESSION_KEY_PREFIX): string {
  return `${prefix}session:${token}`;
}

@Injectable()
export class AuthService implements OnModuleInit, OnApplicationShutdown {
  constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(REDIS) private readonly redis: SessionStore,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.redis.ping?.();
    const password = process.env.ADMIN_PASSWORD?.trim();
    if (!password) return;
    const passwordHash = await hashPassword(password);
    await this.database
      .insertInto('admin')
      .values({ id: 1, password_hash: passwordHash })
      .onConflict((conflict) => conflict.column('id').doNothing())
      .execute();
  }

  async login(password: string): Promise<Session> {
    const row = await this.database
      .selectFrom('admin')
      .select(['id', 'password_hash'])
      .where('id', '=', 1)
      .executeTakeFirst();
    if (!row || !(await verifyPassword(password, row.password_hash))) {
      throw new UnauthorizedException('登录凭据无效');
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1_000);
    await this.redis.set(
      adminSessionKey(token),
      JSON.stringify({ version: 1, userId: row.id.toString() }),
      'EX',
      SESSION_TTL_SECONDS,
    );
    return { token, userId: row.id.toString(), expiresAt, ttlSeconds: SESSION_TTL_SECONDS };
  }

  async logout(token: string | undefined): Promise<void> {
    if (token) await this.redis.del(adminSessionKey(token));
  }

  async validate(token: string | undefined): Promise<{ userId: string } | null> {
    if (!token) return null;
    try {
      const value = await this.redis.get(adminSessionKey(token));
      if (!value) return null;
      const parsed = JSON.parse(value) as { version?: number; userId?: string };
      return parsed.version === 1 && typeof parsed.userId === 'string' && parsed.userId
        ? { userId: parsed.userId }
        : null;
    } catch {
      return null;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.disconnect) {
      this.redis.disconnect();
      return;
    }
    await this.redis.quit?.();
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const cost = 32_768;
  const blockSize = 8;
  const parallelization = 1;
  const derived = await scryptAsync(password, salt, 32, {
    N: cost,
    r: blockSize,
    p: parallelization,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${cost}$${blockSize}$${parallelization}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p) || n < 1 || r < 1 || p < 1) {
    return false;
  }
  try {
    const expected = Buffer.from(parts[5]!, 'base64');
    if (expected.length === 0) return false;
    const actual = await scryptAsync(password, Buffer.from(parts[4]!, 'base64'), expected.length, {
      N: n,
      r,
      p,
      maxmem: 64 * 1024 * 1024,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

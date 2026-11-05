import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { DATABASE } from '../database/database.providers.js';
import type { DatabaseSchema } from '../database/types.js';
import { REDIS, hashPassword, verifyPassword } from '../auth/auth.service.js';
import { RATE_LIMIT_STORE, type RateLimitStore } from '../common/rate-limit.guard.js';
import { DomainConflictError, DomainError, DomainValidationError } from '../common/errors.js';
import { McpMailer } from '../mcp/mcp-mailer.js';
import { McpCaptcha } from '../mcp/mcp-captcha.js';

export const ACCOUNT_SESSION_SECONDS = 7 * 86_400;
export interface AccountUser { id: string; email: string }
interface AccountLogin { user: AccountUser; sessionToken: string }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const emailSchema = z.string().trim().max(254).toLowerCase().email();
const passwordSchema = z.string().min(12).max(128);
const sessionKey = (token: string) => `account:session:${hash(token)}`;
const invalidCode = () => new DomainValidationError('ACCOUNT_CODE_INVALID', '邮件验证码错误、已使用或已过期，请重新获取');
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new DomainValidationError('ACCOUNT_INPUT_INVALID', '请检查邮箱、验证码和密码，密码需为 12–128 个字符');
  return result.data;
}
function equal(a: string | null, b: string) {
  return !!a && /^[a-f0-9]{64}$/u.test(a) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

@Injectable()
export class AccountService {
  constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(REDIS) private readonly redis: Pick<Redis, 'get' | 'set' | 'del'>,
    @Inject(McpMailer) private readonly mailer: McpMailer,
    @Inject(McpCaptcha) private readonly captcha: McpCaptcha,
    @Inject(RATE_LIMIT_STORE) private readonly limits: RateLimitStore,
  ) {}

  async sendCode(input: unknown, address = 'unknown') {
    const data = parse(z.object({
      email: emailSchema, captchaId: z.string().max(100).optional(), captchaAnswer: z.string().max(20).optional(),
      retryToken: tokenSchema.optional(),
    }).strict(), input);
    if (!this.mailer.enabled()) throw new DomainError(503, 'ACCOUNT_EMAIL_UNAVAILABLE', '邮件服务暂不可用，请稍后重试');
    await this.captcha.verify(data.captchaId, data.captchaAnswer, address);
    await this.limit(`account:email-ip:${hash(address)}`, 10, 3_600_000);
    const retryToken = data.retryToken ?? secret();
    const challengeId = secret();
    const code = randomInt(1_000_000).toString().padStart(6, '0');
    const retryAfterSeconds = await this.database.transaction().execute(async transaction => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${data.email}, 3200))`.execute(transaction);
      const previous = await transaction.selectFrom('account_email_challenges').selectAll().where('email', '=', data.email).forUpdate().executeTakeFirst();
      const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(transaction)).rows[0]!.now;
      if (data.retryToken && (!previous || previous.retry_expires_at <= now
        || previous.retry_address_hash !== hash(address) || !equal(previous.retry_hash, hash(retryToken)))) {
        throw new DomainError(403, 'ACCOUNT_RETRY_INVALID', '重试凭证已失效，请刷新图形验证码后重新获取');
      }
      if (previous && previous.send_after > now) {
        throw new DomainError(429, 'ACCOUNT_EMAIL_COOLDOWN', '请等待倒计时结束后重试', {
          retryAfterSeconds: Math.ceil((previous.send_after.getTime() - now.getTime()) / 1000),
          ...(data.retryToken ? { retryToken } : {}),
        });
      }
      const sameWindow = previous && now.getTime() - previous.send_window_start.getTime() < 3_600_000;
      const count = sameWindow ? previous.send_count + 1 : 1;
      if (count > 5) {
        throw new DomainError(429, 'ACCOUNT_EMAIL_COOLDOWN', '发送次数较多，请稍后再试', {
          retryAfterSeconds: Math.max(1, Math.ceil((previous!.send_window_start.getTime() + 3_600_000 - now.getTime()) / 1000)),
          ...(data.retryToken ? { retryToken } : {}),
        });
      }
      const delay = Math.min(600, 60 * 2 ** (count - 1));
      const values = {
        email: data.email, challenge_id: challengeId, code_hash: hash(`${challengeId}\0${code}`),
        code_expires_at: new Date(now.getTime() + 600_000), attempts: 0,
        retry_hash: hash(retryToken), retry_address_hash: hash(address),
        retry_expires_at: data.retryToken ? previous!.retry_expires_at : new Date(now.getTime() + 3_600_000),
        send_after: new Date(now.getTime() + delay * 1000), send_count: count,
        send_window_start: sameWindow ? previous.send_window_start : now,
        registration_hash: null, registration_expires_at: null,
      };
      await transaction.insertInto('account_email_challenges').values(values)
        .onConflict(oc => oc.column('email').doUpdateSet(values)).execute();
      return delay;
    });
    try {
      await this.mailer.send(data.email, '知途·拾价邮箱验证码', `你的邮箱验证码是：${code}\n十分钟内有效，请在原页面输入。请勿向他人提供验证码。如非本人操作，请忽略此邮件。`);
    } catch {
      await this.database.updateTable('account_email_challenges').set({ code_hash: null })
        .where('email', '=', data.email).where('challenge_id', '=', challengeId).execute();
      throw new DomainError(503, 'ACCOUNT_EMAIL_FAILED', '邮件暂未发送成功，请等待倒计时后重试', { retryToken, retryAfterSeconds });
    }
    return { challengeId, retryToken, retryAfterSeconds, expiresInSeconds: 600 };
  }

  async verifyEmail(input: unknown): Promise<AccountLogin | { registrationToken: string; email: string }> {
    const data = parse(z.object({ challengeId: tokenSchema, code: z.string().regex(/^[0-9]{6}$/u) }).strict(), input);
    const registrationToken = secret();
    const result = await this.database.transaction().execute(async transaction => {
      const row = await transaction.selectFrom('account_email_challenges').selectAll()
        .where('challenge_id', '=', data.challengeId).forUpdate().executeTakeFirst();
      const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(transaction)).rows[0]!.now;
      if (!row || !row.code_hash || row.code_expires_at <= now || row.attempts >= 5) return null;
      if (!equal(row.code_hash, hash(`${data.challengeId}\0${data.code}`))) {
        await transaction.updateTable('account_email_challenges').set({ attempts: row.attempts + 1 })
          .where('email', '=', row.email).execute();
        return null;
      }
      const user = await transaction.selectFrom('user_accounts').select(['id', 'email']).where('email', '=', row.email).executeTakeFirst();
      await transaction.updateTable('account_email_challenges').set({
        code_hash: null, registration_hash: user ? null : hash(registrationToken),
        registration_expires_at: user ? null : new Date(now.getTime() + 600_000),
      }).where('email', '=', row.email).execute();
      return { user, email: row.email };
    });
    if (!result) throw invalidCode();
    if (result.user) return this.session(result.user);
    return { registrationToken, email: result.email };
  }

  async register(input: unknown): Promise<AccountLogin> {
    const data = parse(z.object({ registrationToken: tokenSchema, password: passwordSchema }).strict(), input);
    const user = await this.database.transaction().execute(async transaction => {
      const row = await transaction.selectFrom('account_email_challenges').selectAll()
        .where('registration_hash', '=', hash(data.registrationToken))
        .forUpdate().executeTakeFirst();
      const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(transaction)).rows[0]!.now;
      if (!row || !row.registration_expires_at || row.registration_expires_at <= now) {
        throw new DomainValidationError('ACCOUNT_REGISTRATION_INVALID', '验证已失效，请重新验证邮箱');
      }
      const passwordHash = await hashPassword(data.password);
      const created = await transaction.insertInto('user_accounts').values({
        id: randomUUID(), email: row.email, password_hash: passwordHash,
      }).onConflict(oc => oc.column('email').doNothing()).returning(['id', 'email']).executeTakeFirst();
      if (!created) throw new DomainConflictError('ACCOUNT_ALREADY_EXISTS', '该邮箱已注册，请重新登录');
      await transaction.updateTable('account_email_challenges').set({ registration_hash: null, registration_expires_at: null })
        .where('email', '=', row.email).execute();
      return created;
    });
    return this.session(user);
  }

  async login(input: unknown, address = 'unknown'): Promise<AccountLogin> {
    const data = parse(z.object({
      email: emailSchema, password: z.string().min(1).max(128),
      captchaId: z.string().max(100), captchaAnswer: z.string().max(20),
    }).strict(), input);
    await this.captcha.verify(data.captchaId, data.captchaAnswer, address);
    await this.limit(`account:password-ip:${hash(address)}`, 10, 60_000);
    const user = await this.database.selectFrom('user_accounts').select(['id', 'email', 'password_hash']).where('email', '=', data.email).executeTakeFirst();
    const valid = user ? await verifyPassword(data.password, user.password_hash) : (await hashPassword(data.password), false);
    if (!valid || !user) throw new UnauthorizedException('邮箱或密码不正确');
    return this.session({ id: user.id, email: user.email });
  }

  async validate(token?: string): Promise<AccountUser | null> {
    if (!token || !tokenSchema.safeParse(token).success) return null;
    let value;
    try { value = await this.redis.get(sessionKey(token)); }
    catch { throw new DomainError(503, 'ACCOUNT_SESSION_UNAVAILABLE', '登录服务暂不可用，请稍后重试'); }
    if (!value) return null;
    try {
      const parsed = JSON.parse(value) as AccountUser;
      if (typeof parsed.id !== 'string' || typeof parsed.email !== 'string') return null;
      return await this.database.selectFrom('user_accounts').select(['id', 'email']).where('id', '=', parsed.id).where('email', '=', parsed.email).executeTakeFirst() ?? null;
    } catch { return null; }
  }

  async logout(token?: string): Promise<void> {
    if (token && tokenSchema.safeParse(token).success) {
      try { await this.redis.del(sessionKey(token)); }
      catch { throw new DomainError(503, 'ACCOUNT_SESSION_UNAVAILABLE', '退出暂未完成，请稍后重试'); }
    }
  }

  private async session(user: AccountUser): Promise<AccountLogin> {
    const sessionToken = secret();
    try {
      if (await this.redis.set(sessionKey(sessionToken), JSON.stringify(user), 'EX', ACCOUNT_SESSION_SECONDS) !== 'OK') throw new Error('Session not saved');
    } catch { throw new DomainError(503, 'ACCOUNT_SESSION_UNAVAILABLE', '登录服务暂不可用，请稍后重新登录'); }
    return { user, sessionToken };
  }

  private async limit(key: string, maximum: number, window: number) {
    let result;
    try { result = await this.limits.hit(key, window); }
    catch { throw new DomainError(503, 'ACCOUNT_LIMIT_UNAVAILABLE', '验证服务暂不可用，请稍后重试'); }
    if (!Number.isSafeInteger(result.count) || result.count < 1 || !Number.isFinite(result.retryAfterMs) || result.retryAfterMs < 0) {
      throw new DomainError(503, 'ACCOUNT_LIMIT_UNAVAILABLE', '验证服务暂不可用');
    }
    if (result.count > maximum) throw new DomainError(429, 'ACCOUNT_TOO_FREQUENT', '操作过于频繁，请稍后重试', { retryAfterSeconds: Math.max(1, Math.ceil(result.retryAfterMs / 1000)) });
  }
}

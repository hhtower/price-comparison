import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { sql, type Kysely, type Selectable } from 'kysely';
import { z } from 'zod';
import { DATABASE } from '../database/database.providers.js';
import type { DatabaseSchema, McpApplicationTable } from '../database/types.js';
import { DomainConflictError, DomainNotFoundError, DomainValidationError } from '../common/errors.js';
import { RATE_LIMIT_STORE, RateLimitExceededException, type RateLimitStore } from '../common/rate-limit.guard.js';
import { McpMailer } from './mcp-mailer.js';
import { decryptMcpKey, encryptMcpKey } from './mcp-key-storage.js';
import { readAccountPasswordMinLength } from '../config/env.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const emailSchema = z.string().trim().max(254).toLowerCase().email();
const applicationSchema = z.object({
  name: z.string().trim().min(1).max(100), email: emailSchema,
  purpose: z.string().trim().min(1).max(2000), expectedUsage: z.string().trim().min(1).max(200),
}).strict();
const accountApplicationSchema = applicationSchema.omit({ email: true });
const reviewSchema = z.object({
  expiresInDays: z.number().int().min(1).max(365),
  requestsPerMinute: z.number().int().min(1).max(1000),
  reviewNote: z.string().trim().max(1000).default(''),
}).strict();
const idSchema = z.string().uuid();
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
type Application = Selectable<McpApplicationTable>;
type Reply = { header(name: string, value: string): unknown };
const ok = () => ({ ok: true as const });
const invalidLink = () => new DomainValidationError('MCP_LINK_INVALID', '链接无效、已过期或已使用，请重新申请邮件');

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new DomainValidationError('INVALID_MCP_INPUT', '申请参数无效，请检查邮箱、必填内容和额度范围');
  return result.data;
}

@Injectable()
export class McpAccess {
  private readonly notifications = new Map<string, Promise<void>>();
  private mailTail: Promise<void> = Promise.resolve();

  constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(McpMailer) private readonly mailer: McpMailer,
    @Inject(RATE_LIMIT_STORE) private readonly limits: RateLimitStore,
  ) {}

  config() { return { enabled: this.mailer.enabled(), endpoint: '/api/mcp', passwordMinLength: readAccountPasswordMinLength() }; }

  async applyForAccount(input: unknown, accountEmail: string) {
    const data = parse(accountApplicationSchema, input);
    const email = parse(emailSchema, accountEmail);
    await this.database.insertInto('mcp_applications').values({
      id: randomUUID(), name: data.name, email, purpose: data.purpose, expected_usage: data.expectedUsage,
      status: 'pending', email_verified_at: sql<Date>`now()`, verification_hash: null, verification_expires_at: null,
      reviewed_at: null, reviewed_by: null, claim_hash: null, claim_expires_at: null, claimed_at: null,
      key_hash: null, key_prefix: null, key_expires_at: null, key_revoked_at: null,
      key_updated_at: null, key_updated_by: null, last_used_at: null,
    }).onConflict(oc => oc.column('email').doNothing()).execute();
    await this.getForAccount(email);
    return ok();
  }

  async getForAccount(accountEmail: string) {
    const email = parse(emailSchema, accountEmail);
    await this.database.updateTable('mcp_applications')
      .set({ status: 'pending', email_verified_at: sql<Date>`now()`, verification_hash: null, verification_expires_at: null })
      .where('email', '=', email).where('status', '=', 'unverified').execute();
    const row = await this.database.selectFrom('mcp_applications').selectAll().where('email', '=', email).executeTakeFirst();
    return { application: row ? {
      ...publicApplication(row),
      canClaim: row.status === 'approved' && !row.key_hash && !row.key_revoked_at
        && !!row.key_expires_at && row.key_expires_at > new Date(),
    } : null };
  }

  async claimForAccount(accountEmail: string) {
    return this.issueKey({ email: parse(emailSchema, accountEmail) });
  }

  async apply(input: unknown, address = 'unknown') {
    const data = parse(applicationSchema, input);
    this.requireMail();
    await this.admitMail(data.email, address);
    const row = await this.database.transaction().execute(async transaction => {
      // A duplicate INSERT must not wait on a notification's uncommitted credential update.
      const lock = await sql<{ acquired: boolean }>`select pg_try_advisory_xact_lock(hashtextextended(${hash(data.email)}, 3100)) as acquired`.execute(transaction);
      if (!lock.rows[0]?.acquired) return;
      const created = await transaction.insertInto('mcp_applications').values({
        id: randomUUID(), name: data.name, email: data.email, purpose: data.purpose, expected_usage: data.expectedUsage,
        email_verified_at: null, verification_hash: null, verification_expires_at: null,
        reviewed_at: null, reviewed_by: null, claim_hash: null, claim_expires_at: null, claimed_at: null,
        key_hash: null, key_prefix: null, key_expires_at: null, key_revoked_at: null,
        key_updated_at: null, key_updated_by: null, last_used_at: null,
      }).onConflict(oc => oc.column('email').doNothing()).returning('id').executeTakeFirst();
      return created ?? transaction.selectFrom('mcp_applications').select('id').where('email', '=', data.email).executeTakeFirst();
    });
    if (row) void this.notify(row.id, true).catch(() => {});
    return ok();
  }

  async verify(input: unknown) {
    const token = parse(tokenSchema, input);
    const row = await this.database.updateTable('mcp_applications')
      .set({ status: 'pending', email_verified_at: sql<Date>`now()`, verification_hash: null, verification_expires_at: null })
      .where('verification_hash', '=', hash(token)).where('status', '=', 'unverified')
      .where('verification_expires_at', '>', sql<Date>`now()`).returning('id').executeTakeFirst();
    if (!row) throw invalidLink();
    return { status: 'pending' as const };
  }

  async claim(input: unknown) {
    return this.issueKey({ token: parse(tokenSchema, input) });
  }

  private async issueKey(identity: { email: string } | { token: string }) {
    const apiKey = `mcp_${secret()}`;
    const encrypted = encryptMcpKey(apiKey);
    // Both account and legacy claims consume the same credential in one conditional UPDATE.
    let update = this.database.updateTable('mcp_applications').set({
      claim_hash: null, claim_expires_at: null, claimed_at: sql<Date>`now()`,
      key_hash: hash(apiKey), key_ciphertext: encrypted, key_prefix: apiKey.slice(0, 12), key_updated_at: sql<Date>`now()`,
    }).where('status', '=', 'approved').where('key_hash', 'is', null)
      .where('key_revoked_at', 'is', null).where('key_expires_at', '>', sql<Date>`now()`);
    update = 'email' in identity
      ? update.where('email', '=', identity.email)
      : update.where('claim_hash', '=', hash(identity.token)).where('claim_expires_at', '>', sql<Date>`now()`);
    const row = await update.returning(['key_expires_at', 'requests_per_minute']).executeTakeFirst();
    if (!row) throw invalidLink();
    return { apiKey, expiresAt: row.key_expires_at!.toISOString(), requestsPerMinute: row.requests_per_minute, endpoint: '/api/mcp' };
  }

  async list(input: unknown) {
    const query = parse(z.object({
      page: z.coerce.number().int().min(1).max(1_000_000).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(10),
      status: z.enum(['unverified', 'pending', 'approved', 'rejected']).optional(),
    }).strict(), input);
    let base = this.database.selectFrom('mcp_applications');
    if (query.status) base = base.where('status', '=', query.status);
    const [rows, total] = await Promise.all([
      base.selectAll().orderBy('created_at', 'desc').orderBy('id').limit(query.pageSize).offset((query.page - 1) * query.pageSize).execute(),
      base.select(eb => eb.fn.countAll().as('count')).executeTakeFirstOrThrow(),
    ]);
    return { items: rows.map(publicApplication), total: Number(total.count), page: query.page, pageSize: query.pageSize };
  }

  async viewKey(inputId: unknown) {
    const id = parse(idSchema, inputId);
    const row = await this.database.selectFrom('mcp_applications').select(['key_hash', 'key_ciphertext'])
      .where('id', '=', id).executeTakeFirst();
    if (!row) throw new DomainNotFoundError('MCP_APPLICATION_NOT_FOUND', '申请不存在');
    if (!row.key_hash) throw new DomainConflictError('MCP_KEY_UNCLAIMED', '用户尚未领取密钥');
    if (!row.key_ciphertext) {
      throw new DomainConflictError('MCP_KEY_UNAVAILABLE', '密钥暂不可查看，请重新发放并由用户领取');
    }
    return { apiKey: decryptMcpKey(row.key_ciphertext, row.key_hash) };
  }

  async approve(inputId: unknown, input: unknown, reviewer: string) {
    const id = parse(idSchema, inputId);
    const review = parse(reviewSchema, input);
    this.requireMail();
    const row = await this.database.updateTable('mcp_applications').set({
      status: 'approved', review_note: review.reviewNote, reviewed_at: sql<Date>`now()`, reviewed_by: reviewer,
      key_updated_at: sql<Date>`now()`, key_updated_by: reviewer,
      key_expires_at: new Date(Date.now() + review.expiresInDays * 86_400_000),
      requests_per_minute: review.requestsPerMinute,
    }).where('id', '=', id).where('status', '=', 'pending').returning('id').executeTakeFirst();
    if (!row) await this.conflict(id);
    await this.notify(id, false, true);
    return ok();
  }

  async reject(inputId: unknown, inputNote: unknown, reviewer: string) {
    const id = parse(idSchema, inputId);
    const note = parse(z.string().trim().min(1).max(1000), inputNote);
    this.requireMail();
    const row = await this.database.updateTable('mcp_applications').set({
      status: 'rejected', review_note: note, reviewed_at: sql<Date>`now()`, reviewed_by: reviewer,
    }).where('id', '=', id).where('status', '=', 'pending').returning('id').executeTakeFirst();
    if (!row) await this.conflict(id);
    await this.notify(id, false, true);
    return ok();
  }

  async reissue(inputId: unknown, input: unknown, reviewer: string) {
    const id = parse(idSchema, inputId);
    const review = parse(reviewSchema, input);
    this.requireMail();
    const row = await this.database.updateTable('mcp_applications').set({
      key_hash: null, key_ciphertext: null, key_prefix: null, claimed_at: null, claim_hash: null, claim_expires_at: null,
      key_revoked_at: null, key_expires_at: new Date(Date.now() + review.expiresInDays * 86_400_000),
      requests_per_minute: review.requestsPerMinute, review_note: review.reviewNote,
      key_updated_at: sql<Date>`now()`, key_updated_by: reviewer, last_used_at: null, request_count: 0n,
    }).where('id', '=', id).where('status', '=', 'approved').returning('id').executeTakeFirst();
    if (!row) await this.conflict(id);
    await this.notify(id, false, true);
    return ok();
  }

  async revoke(inputId: unknown, reviewer: string) {
    const id = parse(idSchema, inputId);
    const row = await this.database.updateTable('mcp_applications').set({
      key_revoked_at: sql<Date>`now()`, claim_hash: null, claim_expires_at: null,
      key_updated_at: sql<Date>`now()`, key_updated_by: reviewer,
      notification_version: sql<number>`notification_version + 1`,
    }).where('id', '=', id).where('status', '=', 'approved').returning('id').executeTakeFirst();
    if (!row) await this.conflict(id);
    return ok();
  }

  async resend(inputId: unknown) {
    const id = parse(idSchema, inputId);
    this.requireMail();
    await this.admit(`mcp:admin-mail:${id}`, 3, 3_600_000);
    await this.notify(id);
    return ok();
  }

  async authenticate(authorization?: string): Promise<{ id: string; requestsPerMinute: number }> {
    const match = /^Bearer (mcp_[A-Za-z0-9_-]{43})$/u.exec(authorization ?? '');
    if (!match) throw new UnauthorizedException('MCP 密钥无效或已失效');
    const row = await this.database.updateTable('mcp_applications').set({
      last_used_at: sql<Date>`now()`, request_count: sql<bigint>`request_count + 1`,
    }).where('key_hash', '=', hash(match[1]!)).where('status', '=', 'approved')
      .where('key_revoked_at', 'is', null).where('key_expires_at', '>', sql<Date>`now()`)
      .returning(['id', 'requests_per_minute']).executeTakeFirst();
    if (!row) throw new UnauthorizedException('MCP 密钥无效或已失效');
    return { id: row.id, requestsPerMinute: row.requests_per_minute };
  }

  admitKey(id: string, requestsPerMinute: number, reply?: Reply): Promise<void> {
    return this.admit(`mcp:key:${id}`, requestsPerMinute, 60_000, reply);
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.allSettled([...this.notifications.values()]);
  }

  private requireMail() {
    if (!this.mailer.enabled()) throw new ServiceUnavailableException('MCP 申请暂未开放，请联系管理员配置邮件服务');
  }

  private async admitMail(email: string, address: string) {
    await this.admit(`mcp:mail:ip:${hash(address)}`, 5, 3_600_000);
    await this.admit(`mcp:mail:email:${hash(email)}`, 3, 3_600_000);
  }

  private async admit(key: string, maximum: number, window: number, reply?: Reply) {
    let result;
    try { result = await this.limits.hit(key, window); }
    catch { throw new ServiceUnavailableException('MCP 限流服务暂时不可用'); }
    if (!Number.isSafeInteger(result.count) || result.count < 1 || !Number.isFinite(result.retryAfterMs)) {
      throw new ServiceUnavailableException('MCP 限流服务暂时不可用');
    }
    if (result.count > maximum) {
      reply?.header('Retry-After', String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
      throw new RateLimitExceededException();
    }
  }

  private async conflict(id: string): Promise<never> {
    const row = await this.database.selectFrom('mcp_applications').select('id').where('id', '=', id).executeTakeFirst();
    if (!row) throw new DomainNotFoundError('MCP_APPLICATION_NOT_FOUND', '申请不存在');
    throw new DomainConflictError('MCP_APPLICATION_STATE', '申请状态已变化，请刷新后重试');
  }

  private notify(id: string, recovery = false, fresh = false): Promise<void> {
    const existing = this.notifications.get(id);
    if (existing && !fresh) return existing;
    const sending = this.mailTail.then(() => this.sendNotification(id, recovery))
      .finally(() => { if (this.notifications.get(id) === sending) this.notifications.delete(id); });
    this.notifications.set(id, sending);
    // Keep at most one SMTP transaction per API process; public requests never wait for mail.
    this.mailTail = sending.catch(() => {});
    return sending;
  }

  private async sendNotification(id: string, recovery: boolean): Promise<void> {
    const informational = await this.database.transaction().execute(async transaction => {
      const identity = await transaction.selectFrom('mcp_applications').select('email').where('id', '=', id).executeTakeFirst();
      if (!identity) throw new DomainNotFoundError('MCP_APPLICATION_NOT_FOUND', '申请不存在');
      // The transaction lock coalesces overlapping sends across API instances without waiting.
      const lock = await sql<{ acquired: boolean }>`select pg_try_advisory_xact_lock(hashtextextended(${hash(identity.email)}, 3100)) as acquired`.execute(transaction);
      if (!lock.rows[0]?.acquired) return;
      const row = await transaction.selectFrom('mcp_applications').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!row) throw new DomainNotFoundError('MCP_APPLICATION_NOT_FOUND', '申请不存在');
      const value = secret();
      let subject: string;
      let text: string;
      let credentials = {};
      if (row.status === 'unverified') {
        subject = '验证 MCP 申请邮箱';
        text = `请在24小时内打开链接，并在网站点击验证：\n${this.mailer.origin()}/mcp#verify=${value}`;
        credentials = { verification_hash: hash(value), verification_expires_at: new Date(Date.now() + 86_400_000) };
      } else if (row.status === 'approved' && !row.key_hash && !row.key_revoked_at && row.key_expires_at! > new Date()) {
        const expiresAt = new Date(Math.min(Date.now() + 7 * 86_400_000, row.key_expires_at!.getTime()));
        subject = 'MCP 申请已通过，请领取密钥';
        text = `申请已通过。请在 ${expiresAt.toISOString()} 前打开链接并点击领取；完整密钥仅展示一次：\n${this.mailer.origin()}/mcp#claim=${value}\n密钥有效期至 ${row.key_expires_at!.toISOString()}，额度 ${row.requests_per_minute} 次/分钟。`;
        credentials = { claim_hash: hash(value), claim_expires_at: expiresAt };
      } else if (row.status === 'pending') {
        subject = 'MCP 申请正在审核';
        text = '邮箱已验证，申请正在审核。审核结果将发送到此邮箱。';
      } else if (row.status === 'rejected') {
        subject = 'MCP 申请审核结果';
        text = `申请未通过审核。\n原因：${row.review_note}`;
      } else {
        if (!recovery) throw new DomainConflictError('MCP_KEY_NOT_CLAIMABLE', '密钥已领取、撤销或过期，需重新发放');
        subject = 'MCP 密钥状态';
        text = '此邮箱的密钥已领取、撤销或过期。请登录网站查看状态，或联系管理员处理。密钥不会通过邮件发送。';
      }
      const version = row.notification_version + 1;
      await transaction.updateTable('mcp_applications').set({
        ...credentials, notification_status: 'pending', notification_version: version,
      }).where('id', '=', id).execute();
      const delivery = { to: row.email, subject, text: `${text}\n\n如非本人操作，请忽略此邮件。请勿转发验证或领取链接。`, version };
      // Status-only recovery must not lock an active key while SMTP is unavailable.
      if (!Object.keys(credentials).length) return delivery;
      const status = await this.deliver(delivery);
      await transaction.updateTable('mcp_applications').set({ notification_status: status })
        .where('id', '=', id).where('notification_version', '=', version).execute();
    });
    if (informational) {
      const status = await this.deliver(informational);
      await this.database.updateTable('mcp_applications').set({ notification_status: status })
        .where('id', '=', id).where('notification_version', '=', informational.version).execute();
    }
  }

  private async deliver(message: { to: string; subject: string; text: string }): Promise<'sent' | 'failed'> {
    try { await this.mailer.send(message.to, message.subject, message.text); return 'sent'; }
    catch { return 'failed'; }
  }
}

function publicApplication(row: Application) {
  return {
    id: row.id, name: row.name, email: row.email, purpose: row.purpose, expectedUsage: row.expected_usage,
    status: row.status, createdAt: row.created_at.toISOString(), emailVerifiedAt: row.email_verified_at?.toISOString() ?? null,
    reviewedAt: row.reviewed_at?.toISOString() ?? null, reviewNote: row.review_note, notificationStatus: row.notification_status,
    key: row.key_expires_at ? {
      prefix: row.key_prefix, status: row.key_revoked_at ? 'revoked' : row.key_expires_at <= new Date() ? 'expired' : row.key_hash ? 'active' : 'unclaimed',
      expiresAt: row.key_expires_at.toISOString(), lastUsedAt: row.last_used_at?.toISOString() ?? null,
      requestsPerMinute: row.requests_per_minute, requestCount: row.request_count.toString(),
      canReveal: !!row.key_ciphertext,
    } : null,
  };
}

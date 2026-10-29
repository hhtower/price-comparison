import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { DATABASE } from '../database/database.providers.js';
import type { DatabaseSchema, ShopSubmissionTable, ShopSubmissionStatus } from '../database/types.js';
import { DomainConflictError, DomainError, DomainNotFoundError, DomainValidationError } from '../common/errors.js';
import { normalizeShopUrl } from '../shops/shop-url.js';
import { platforms } from '../platforms/index.js';
import type { ShopsRepository } from '../shops/shops.repository.js';

export type ShopSubmission = Selectable<ShopSubmissionTable>;

@Injectable()
export class ShopSubmissionsRepository {
  constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  async approve(id: bigint, reviewer: string | null, createShop: (row: ShopSubmission, transaction: Transaction<DatabaseSchema>) => Promise<{ id: bigint }>): Promise<ShopSubmission> {
    return this.database.transaction().execute(async transaction => {
      const submission = await transaction.selectFrom('shop_submissions').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!submission) throw new DomainNotFoundError('SHOP_SUBMISSION_NOT_FOUND', '商铺提交不存在');
      if (submission.status !== 'pending') throw new DomainConflictError('SHOP_SUBMISSION_ALREADY_REVIEWED', '该商铺提交已审核');
      const shop = await createShop(submission, transaction);
      return transaction.updateTable('shop_submissions').set({ status: 'approved', reviewed_at: new Date(), reviewer, shop_id: shop.id })
        .where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    });
  }

  async create(input: { platform: string; url: string; name: string }, shopsRepository: ShopsRepository): Promise<ShopSubmission> {
    const url = normalizeShopUrl(input.url);
    if (!url) throw new DomainValidationError('INVALID_URL', '商铺 URL 无效');
    const protocol = platforms.find(adapter => adapter.hosts.includes(new URL(url).hostname))?.id;
    try {
      return await this.database.transaction().execute(async transaction => {
        await sql`set local lock_timeout = '5s'`.execute(transaction);
        await sql`select pg_advisory_xact_lock(hashtextextended(${'shop-submission:' + url}, 0))`.execute(transaction);
        if (await containsShopUrl(transaction, 'shop_submissions', url)) {
          throw new DomainConflictError('SHOP_SUBMISSION_EXISTS', '该商铺地址已提交');
        }
        if (await containsShopUrl(transaction, 'shops', url)) {
          throw new DomainConflictError('SHOP_EXISTS', '该商铺已存在');
        }
        const submission = await transaction.insertInto('shop_submissions')
          .values({ ...input, url, status: 'pending', reviewed_at: null, reviewer: null, shop_id: null })
          .returningAll().executeTakeFirstOrThrow();
        if (!protocol) return submission;
        const shop = await shopsRepository.upsert({
          platform: input.platform, url, name: input.name, protocol, enabled: true,
        }, transaction, { createOnly: true });
        return transaction.updateTable('shop_submissions').set({
          status: 'approved', reviewed_at: new Date(), reviewer: null, shop_id: shop.id,
        }).where('id', '=', submission.id).returningAll().executeTakeFirstOrThrow();
      });
    } catch (error) {
      if (isPostgresError(error, '55P03')) throw new DomainError(503, 'SHOP_SUBMISSION_BUSY', '商铺提交繁忙，请稍后重试');
      if (isPostgresError(error, '23505')) throw new DomainConflictError('SHOP_SUBMISSION_EXISTS', '该商铺地址已提交');
      throw error;
    }
  }

  async findById(id: bigint): Promise<ShopSubmission | undefined> {
    return this.database.selectFrom('shop_submissions').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async listPending(page: number, pageSize: number): Promise<{ items: ShopSubmission[]; total: number }> {
    const [items, total] = await Promise.all([
      this.database.selectFrom('shop_submissions').selectAll().where('status', '=', 'pending').orderBy('created_at', 'desc').orderBy('id', 'desc').limit(pageSize).offset((page - 1) * pageSize).execute(),
      this.database.selectFrom('shop_submissions').select(({ fn }) => fn.countAll<number>().as('count')).where('status', '=', 'pending').executeTakeFirstOrThrow(),
    ]);
    return { items, total: Number(total.count) };
  }

  async review(id: bigint, action: Exclude<ShopSubmissionStatus, 'pending'>, reviewer: string | null, shopId: bigint | null): Promise<ShopSubmission> {
    const updated = await this.database.updateTable('shop_submissions').set({ status: action, reviewed_at: new Date(), reviewer, shop_id: shopId }).where('id', '=', id).where('status', '=', 'pending').returningAll().executeTakeFirst();
    if (updated) return updated;
    const existing = await this.findById(id);
    if (!existing) throw new DomainNotFoundError('SHOP_SUBMISSION_NOT_FOUND', '商铺提交不存在');
    throw new DomainConflictError('SHOP_SUBMISSION_ALREADY_REVIEWED', '该商铺提交已审核');
  }
}

async function containsShopUrl(transaction: Transaction<DatabaseSchema>, table: 'shops' | 'shop_submissions', url: string): Promise<boolean> {
  let afterId = 0n;
  for (;;) {
    const rows = await transaction.selectFrom(table).select(['id', 'url']).where('id', '>', afterId)
      .orderBy('id').limit(100).execute();
    if (rows.some(row => (normalizeShopUrl(row.url) ?? row.url) === url)) return true;
    if (rows.length < 100) return false;
    afterId = rows.at(-1)!.id;
  }
}

function isPostgresError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

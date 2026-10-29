import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { DATABASE } from '../database/database.providers.js';
import type { DatabaseSchema, ShopSubmissionTable, ShopSubmissionStatus } from '../database/types.js';
import { DomainConflictError, DomainNotFoundError } from '../common/errors.js';
import { normalizeShopUrl } from '../shops/shop-url.js';
import { platforms } from '../platforms/index.js';
import type { ShopsRepository, Shop } from '../shops/shops.repository.js';

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

  async create(input: { platform: string; url: string; name: string }): Promise<ShopSubmission> {
    try {
      return await this.database.transaction().execute(async transaction => {
        const url = normalizeShopUrl(input.url) ?? input.url;
        await sql`set local lock_timeout = '5s'`.execute(transaction);
        await sql`lock table shops, shop_submissions in share row exclusive mode`.execute(transaction);
        const shops = await transaction.selectFrom('shops').select('url').execute();
        if (shops.some(row => (normalizeShopUrl(row.url) ?? row.url) === url)) {
          throw new DomainConflictError('SHOP_EXISTS', '该商铺已存在');
        }
        const submissions = await transaction.selectFrom('shop_submissions').select('url').execute();
        if (submissions.some(row => (normalizeShopUrl(row.url) ?? row.url) === url)) {
          throw new DomainConflictError('SHOP_SUBMISSION_EXISTS', '该商铺地址已提交');
        }
        return transaction.insertInto('shop_submissions')
          .values({ ...input, url, status: 'pending', reviewed_at: null, reviewer: null, shop_id: null })
          .returningAll().executeTakeFirstOrThrow();
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainConflictError('SHOP_SUBMISSION_EXISTS', '该商铺地址已提交');
      throw error;
    }
  }

  /** Registered protocol hosts and existing protocol bindings do not require manual review. */
  async autoApproveExistingProtocols(shopsRepository: ShopsRepository): Promise<number> {
    return this.database.transaction().execute(async transaction => {
      await sql`set local lock_timeout = '5s'`.execute(transaction);
      // ponytail: serialize the pending batch with shop edits; use per-URL locks if volume grows.
      await sql`lock table shops, shop_submissions in share row exclusive mode`.execute(transaction);
      const pending = await transaction.selectFrom('shop_submissions').selectAll().where('status', '=', 'pending').forUpdate().skipLocked().execute();
      if (pending.length === 0) return 0;
      const shops = await transaction.selectFrom('shops').selectAll().orderBy('id', 'asc').execute();
      const known = new Map<string, Shop>();
      for (const shop of shops) {
        const url = normalizeShopUrl(shop.url);
        if (url && (!known.has(url) || shop.url === url)) known.set(url, shop);
      }
      let approved = 0;
      for (const submission of pending) {
        const url = normalizeShopUrl(submission.url);
        if (!url) continue;
        let shop = known.get(url);
        if (shop?.deleted_at) continue;
        const protocol = shop?.protocol ?? platforms.find(adapter => adapter.hosts.includes(new URL(url).hostname))?.id;
        if (!protocol || !platforms.some(adapter => adapter.id === protocol)) continue;
        if (!shop?.protocol) {
          if (shop && shop.url !== url) await transaction.updateTable('shops').set({ url }).where('id', '=', shop.id).execute();
          shop = await shopsRepository.upsert({
            name: shop?.name ?? submission.name, platform: shop?.platform ?? submission.platform,
            url, protocol, enabled: shop?.enabled ?? true,
          }, transaction);
          known.set(url, shop);
        }
        await transaction.updateTable('shop_submissions')
          .set({ status: 'approved', reviewed_at: new Date(), reviewer: null, shop_id: shop.id })
          .where('id', '=', submission.id).where('status', '=', 'pending').executeTakeFirst();
        approved++;
      }
      return approved;
    });
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

function isUniqueViolation(error: unknown): error is { code: string } {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === '23505';
}

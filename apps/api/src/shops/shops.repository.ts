import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely, type Selectable, type Transaction, type Updateable } from 'kysely';
import { DATABASE } from '../database/database.providers.js';
import type { DatabaseSchema, ShopTable } from '../database/types.js';
import { DomainConflictError, DomainNotFoundError } from '../common/errors.js';
import { bumpCatalogVersion } from '../catalog/catalog-version.repository.js';
import { isUnavailableShopError } from '../crawler/shop-failure.js';

export type Shop = Selectable<ShopTable>;

export interface ShopUpsert {
  readonly platform: string;
  readonly protocol?: string;
  readonly url: string;
  readonly name: string;
  readonly enabled: boolean;
}

export interface ShopUpdate {
  readonly platform?: string;
  readonly protocol?: string;
  readonly url?: string;
  readonly name?: string;
  readonly enabled?: boolean;
}

export interface QueuedFetchRun {
  readonly id: bigint;
  readonly shop_id: bigint;
  readonly status: 'queued';
}
export type ShopScheduleClaim = Pick<Shop, 'id' | 'next_fetch_at' | 'fetch_backoff_level' | 'scheduler_lease_until'>;

@Injectable()
export class ShopsRepository {
  constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  async upsert(input: ShopUpsert, transaction?: Transaction<DatabaseSchema>): Promise<Shop> {
    const write = async (transaction: Transaction<DatabaseSchema>) => {
      const shop = await transaction
        .insertInto('shops')
        .values({ platform: input.platform, ...(input.protocol === undefined ? {} : { protocol: input.protocol }), url: input.url, name: input.name, enabled: input.enabled, last_fetch_at: null, last_error: null, deleted_at: null })
        .onConflict((conflict) => conflict.column('url').doUpdateSet(({ ref }) => ({ platform: ref('excluded.platform'), ...(input.protocol === undefined ? {} : { protocol: ref('excluded.protocol') }), name: ref('excluded.name'), enabled: ref('excluded.enabled'), deleted_at: null })))
        .returningAll().executeTakeFirstOrThrow();
      await bumpCatalogVersion(transaction);
      return shop;
    };
    return transaction ? write(transaction) : this.database.transaction().execute(write);
  }

  async findById(id: bigint): Promise<Shop | undefined> {
    return this.database
      .selectFrom('shops')
      .selectAll()
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
  }

  async update(id: bigint, input: ShopUpdate, expectedSource?: Pick<Shop, 'url' | 'protocol'>): Promise<Shop | undefined> {
    const changes: Updateable<ShopTable> = {};
    if (input.platform !== undefined) changes.platform = input.platform;
    if (input.protocol !== undefined) changes.protocol = input.protocol;
    if (input.url !== undefined) changes.url = input.url;
    if (input.name !== undefined) changes.name = input.name;
    if (input.enabled !== undefined) changes.enabled = input.enabled;
    if (Object.keys(changes).length === 0) return this.findById(id);
    return this.database.transaction().execute(async (transaction) => {
      let query = transaction.updateTable('shops').set(changes).where('id', '=', id).where('deleted_at', 'is', null);
      if (expectedSource) query = query.where('url', '=', expectedSource.url)
        .where('protocol', expectedSource.protocol === null ? 'is' : '=', expectedSource.protocol);
      const shop = await query.returningAll().executeTakeFirst();
      if (!shop && expectedSource) throw new DomainConflictError('SHOP_SOURCE_CHANGED', '商铺来源已改变，请重新验证后保存');
      if (shop) await bumpCatalogVersion(transaction);
      return shop;
    });
  }

  async softDelete(id: bigint): Promise<boolean> {
    return this.database.transaction().execute(async (transaction) => {
      const result = await transaction.updateTable('shops').set({ deleted_at: new Date(), enabled: false }).where('id', '=', id).where('deleted_at', 'is', null).executeTakeFirst();
      if (result.numUpdatedRows === 1n) await bumpCatalogVersion(transaction);
      return result.numUpdatedRows === 1n;
    });
  }

  async restore(id: bigint): Promise<Shop | undefined> {
    return this.database.transaction().execute(async (transaction) => {
      const shop = await transaction.updateTable('shops').set({ deleted_at: null, enabled: true }).where('id', '=', id).where('deleted_at', 'is not', null).returningAll().executeTakeFirst();
      if (shop) await bumpCatalogVersion(transaction);
      return shop;
    });
  }

  async enqueueRefresh(shopIds: readonly bigint[]): Promise<readonly QueuedFetchRun[]> {
    const uniqueIds = [...new Set(shopIds)];
    return this.database.transaction().execute(async (transaction) => {
      const shops = await transaction
        .selectFrom('shops')
        .select('id')
        .where('id', 'in', uniqueIds)
        .where('enabled', '=', true)
        .where('deleted_at', 'is', null)
        .execute();
      if (shops.length !== uniqueIds.length) {
        throw new DomainNotFoundError(
          'SHOP_NOT_REFRESHABLE',
          '部分商铺不存在、已停用或已删除',
        );
      }
      const startedAt = new Date();
      return transaction
        .insertInto('fetch_runs')
        .values(
          shops.map((shop) => ({
            shop_id: shop.id,
            started_at: startedAt,
            finished_at: null,
            status: 'queued' as const,
            error: null,
          })),
        )
        .returning(['id', 'shop_id', 'status'])
        .execute() as Promise<readonly QueuedFetchRun[]>;
    });
  }

  async claimDueShops(workerId: string, limit: number): Promise<ShopScheduleClaim[]> {
    if (!workerId.trim()) throw new Error('workerId is required');
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit must be positive');
    const result = await sql<ShopScheduleClaim>`
      with due as (
        select id from shops where enabled = true and deleted_at is null
          and next_fetch_at <= now() and (scheduler_lease_until is null or scheduler_lease_until <= now())
        order by next_fetch_at asc, id asc for update skip locked limit ${limit}
      )
      update shops s set scheduler_lease_until = now() + interval '60 seconds'
      from due where s.id = due.id returning s.id, s.next_fetch_at, s.fetch_backoff_level, s.scheduler_lease_until
    `.execute(this.database);
    return result.rows;
  }

  async enqueueFetchRun(shopId: bigint, _reason: string): Promise<bigint | null> {
    return this.database.transaction().execute(async tx => {
      await sql`select pg_advisory_xact_lock(${shopId})`.execute(tx);
      const shop = await tx.selectFrom('shops').select('id').where('id', '=', shopId)
        .where('enabled', '=', true).where('deleted_at', 'is', null).forNoKeyUpdate().executeTakeFirst();
      if (!shop) return null;
      const active = await tx.selectFrom('fetch_runs').select('id').where('shop_id', '=', shopId).where('task_type', '=', 'list').where('status', 'in', ['queued', 'running']).executeTakeFirst();
      if (active) return null;
      const row = await tx.insertInto('fetch_runs').values({ shop_id: shopId, started_at: new Date(), status: 'queued', error: null }).returning('id').executeTakeFirstOrThrow();
      return row.id;
    });
  }

  async markFetchSucceeded(shopId: bigint, intervalMs = 300_000, transaction?: Transaction<DatabaseSchema>): Promise<void> {
    const record = async (tx: Transaction<DatabaseSchema>) => {
      await tx.updateTable('shops').set({
        last_fetch_at: new Date(), last_success_at: new Date(), next_fetch_at: new Date(Date.now() + Math.max(1_000, intervalMs)),
        fetch_backoff_level: 0, scheduler_lease_until: null, last_error: null,
      }).where('id', '=', shopId).execute();
      await bumpCatalogVersion(tx);
    };
    if (transaction) await record(transaction);
    else await this.database.transaction().execute(record);
  }

  async markFetchFailed(shopId: bigint, error: string, baseMs = 30_000, maxMs = 3_600_000, transaction?: Transaction<DatabaseSchema>): Promise<void> {
    const record = async (tx: Transaction<DatabaseSchema>) => {
      const shop = await tx.selectFrom('shops').select('fetch_backoff_level').where('id', '=', shopId).forUpdate().executeTakeFirst();
      if (!shop) return;
      const level = Number(shop?.fetch_backoff_level ?? 0) + 1;
      const delay = Math.min(maxMs, baseMs * 2 ** Math.max(0, level - 1));
      await tx.updateTable('shops').set({
        last_fetch_at: new Date(), fetch_backoff_level: level, next_fetch_at: new Date(Date.now() + delay),
        scheduler_lease_until: null, last_error: error,
        ...(isUnavailableShopError(error) ? { enabled: false } : {}),
      }).where('id', '=', shopId).execute();
      await bumpCatalogVersion(tx);
    };
    if (transaction) await record(transaction);
    else await this.database.transaction().execute(record);
  }
}

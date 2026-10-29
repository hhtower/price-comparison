import { sql, type Kysely } from 'kysely';
import { jsonb, type DatabaseSchema } from '../database/types.js';
import { defaultQuotePolicy } from '../catalog/quote-policy.js';
import { settlementPayload, settlementBatchSize } from './settlement-retry.js';
import type { Shop } from '../shops/shops.repository.js';
import { platforms, platformForUrl } from '../platforms/index.js';

export async function enqueueDueSettlements(
  db: Kysely<DatabaseSchema>, limit = 32, now = new Date(), ttlMs = defaultQuotePolicy().ttlMs,
): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('settlement scheduling limit must be positive');
  const freshAfter = new Date(now.getTime() - ttlMs);
  const adapters = platforms.filter(adapter => adapter.settle);
  const protocols = adapters.map(adapter => adapter.id);
  const hosts = adapters.flatMap(adapter => adapter.hosts);
  const due = sql`o.settlement_refresh_at <= ${now} and not o.is_stale and o.stock_available
    and o.captured_at > ${freshAfter} and p.deleted_at is null
    and (o.settlement_price is null or o.settlement_verified_at <= ${freshAfter})
    and exists (select 1 from standard_product_members m join standard_products sp on sp.id = m.standard_product_id
      where m.product_id = p.id and m.publication_state = 'published'
        and sp.verification_state = 'verified' and not sp.hidden and sp.merged_into_id is null)
    and not exists (select 1 from offers newer where newer.product_id = p.id
      and (newer.captured_at, newer.id) > (o.captured_at, o.id))`;
  return db.transaction().setIsolationLevel('read committed').execute(async tx => {
    const shops = (await sql<Shop>`
      select sh.* from shops sh where sh.enabled and sh.deleted_at is null and sh.last_error is null
        and (sh.protocol = any(${protocols}::text[]) or (sh.protocol is null
          and lower(split_part(sh.url, '/', 3)) = any(${hosts}::text[])))
        and not exists (select 1 from fetch_runs f where f.shop_id = sh.id
          and ((f.task_type = 'settlement' and f.status in ('queued', 'running'))
            or (f.status = 'running' and f.lease_until > ${now})))
        and exists (select 1 from products p join offers o on o.product_id = p.id
          where p.shop_id = sh.id and ${due})
      order by sh.id for no key update of sh skip locked limit ${limit}
    `.execute(tx)).rows;
    let enqueued = 0;
    for (const shop of shops) {
      // Recheck after acquiring the shop lock; another poll may have committed since the selection snapshot.
      const active = await tx.selectFrom('fetch_runs').select('id')
        .where('shop_id', '=', shop.id).where('task_type', '=', 'settlement')
        .where('status', 'in', ['queued', 'running']).executeTakeFirst();
      if (active) continue;
      const rows = (await sql<{
        id: bigint; content_version: bigint; content_fingerprint: string;
        offer_id: bigint; price: string; captured_at: Date; settlement_verified_at: Date | null;
      }>`select p.id, p.content_version, p.content_fingerprint, o.id as offer_id, o.price, o.captured_at, o.settlement_verified_at
        from products p join offers o on o.product_id = p.id
        where p.shop_id = ${shop.id} and ${due}
        order by o.settlement_refresh_at, p.id limit ${settlementBatchSize(platformForUrl(shop.url, shop.protocol).id)}`.execute(tx)).rows;
      if (!rows.length) continue;
      await tx.insertInto('fetch_runs').values({
        shop_id: shop.id, task_type: 'settlement', started_at: now, available_at: now,
        status: 'queued', settlement_payload: jsonb(settlementPayload(shop, rows)),
      }).execute();
      await tx.updateTable('offers').set({ settlement_refresh_at: null })
        .where('id', 'in', rows.map(row => row.offer_id)).execute();
      enqueued++;
    }
    return enqueued;
  });
}

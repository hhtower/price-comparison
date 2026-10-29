import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema, ProductDeletionSource } from '../database/types.js';
import { DomainConflictError } from '../common/errors.js';

/** Also used by recovery to drain pre-fix tombstone claims. */
export async function cancelDeletedProductOutbox(db: Kysely<DatabaseSchema>, ids?: readonly bigint[]): Promise<void> {
  if (ids === undefined) {
    await db.transaction().execute(async tx => {
      // Lock products before outbox rows, as restore/delete do; skip concurrent restores.
      const rows = await tx.selectFrom('products as p').select('p.id').where('p.deleted_at', 'is not', null)
        .where(sql<boolean>`exists (select 1 from standardization_outbox o where o.product_id = p.id and o.status in ('queued', 'running'))`)
        .orderBy('p.id').limit(1000).forNoKeyUpdate('p').skipLocked().execute();
      await cancelDeletedProductOutbox(tx, rows.map(row => row.id));
    });
    return;
  }
  if (!ids.length) return;
  await db.updateTable('standardization_outbox').set({ status: 'cancelled', claimed_by: null, claim_token: null,
    lease_until: null, last_error: 'product deleted' }).where('status', 'in', ['queued', 'running'])
    .where('product_id', 'in', db.selectFrom('products').select('id').where('deleted_at', 'is not', null).where('id', 'in', ids)).execute();
}

/** Normalize the RAW products.name only: never catalog names, normalized_key or LLM identity.
 * Width, case and whitespace are formatting differences; no semantic/fuzzy match. */
export const normalizedProductName = (column: string) => sql<string>`lower(btrim(regexp_replace(normalize(${sql.ref(column)}, NFKC), '[[:space:]]+', ' ', 'g')))`;

/** Linked rows are consequences, not deletion rules; crawler tombstones only retire one listing. */
export const hasBlockingProductNameDeletion = (productAlias: string) => sql<boolean>`exists (
  select 1 from products deleted where deleted.deleted_at is not null
    and (deleted.deletion_source is null or deleted.deletion_source in ('manual', 'legacy'))
    and deleted.id <> ${sql.ref(`${productAlias}.id`)}
    and ${normalizedProductName('deleted.name')} <> ''
    and ${normalizedProductName('deleted.name')} = ${normalizedProductName(`${productAlias}.name`)})`;

/** Acquire before product row locks, in the same order across imports and deletions. */
export async function lockProductNameWrites(db: Kysely<DatabaseSchema>, names: readonly string[]): Promise<void> {
  if (!names.length) return;
  await sql`select pg_advisory_xact_lock(hashtextextended('product-name:' || name, 0))
    from (select distinct ${normalizedProductName('raw_name')} as name
      from unnest(${[...new Set(names)]}::text[]) as names(raw_name) order by name) names`.execute(db);
}

export async function lockProductRowNames(db: Kysely<DatabaseSchema>, ids: readonly bigint[], extraNames: readonly string[] = []): Promise<string[]> {
  const before = ids.length ? await db.selectFrom('products').select(['id', 'name']).where('id', 'in', ids).execute() : [];
  await lockProductNameWrites(db, [...extraNames, ...before.map(row => row.name)]);
  const after = ids.length ? await db.selectFrom('products').select(['id', 'name']).where('id', 'in', ids).execute() : [];
  const previous = new Map(before.map(row => [row.id, row.name]));
  if (after.some(row => previous.get(row.id) !== row.name)) {
    throw new DomainConflictError('PRODUCT_NAME_CHANGED', '商品名称刚刚发生变化，请重试');
  }
  return after.map(row => row.name);
}

/** Caller owns the transaction and name locks (maintenance may lock the whole table). */
export async function propagateDeletedProductNames(db: Kysely<DatabaseSchema>, names?: readonly string[]): Promise<bigint[]> {
  if (names?.length === 0) return [];
  const rows = await db.updateTable('products as p')
    .set({ deleted_at: sql`now()`, deletion_source: 'linked', updated_at: sql`now()` })
    .where('p.deleted_at', 'is', null).where(normalizedProductName('p.name'), '!=', '')
    .where(hasBlockingProductNameDeletion('p'))
    .$if(names !== undefined, q => q.where(sql<boolean>`${normalizedProductName('p.name')} in
      (select ${normalizedProductName('raw_name')} from unnest(${[...(names ?? [])]}::text[]) names(raw_name))`))
    .returning('p.id').execute();
  await cancelDeletedProductOutbox(db, rows.map(row => row.id));
  return rows.map(row => row.id);
}

export async function softDeleteProductNames(
  db: Kysely<DatabaseSchema>,
  ids: readonly bigint[],
  source: ProductDeletionSource = 'manual',
): Promise<bigint[]> {
  if (!ids.length) return [];
  const names = await lockProductRowNames(db, ids);
  const rows = await db.updateTable('products as p')
    .set({
      deleted_at: sql`now()`,
      deletion_source: sql`case when p.id = any(${ids.map(String)}::bigint[]) then ${source} else 'linked' end`,
      updated_at: sql`now()`,
    })
    .where('p.deleted_at', 'is', null)
    .where(eb => source === 'crawler_missing' ? eb('p.id', 'in', ids) : eb.or([eb('p.id', 'in', ids), sql<boolean>`${normalizedProductName('p.name')} <> '' and ${normalizedProductName('p.name')} in
      (select ${normalizedProductName('raw_name')} from unnest(${names}::text[]) names(raw_name))`]))
    .returning('p.id').execute();
  await cancelDeletedProductOutbox(db, rows.map(row => row.id));
  return rows.map(row => row.id);
}

export async function restoreCrawlerProducts(db: Kysely<DatabaseSchema>, ids: readonly bigint[]): Promise<bigint[]> {
  if (!ids.length) return [];
  const rows = await db.updateTable('products')
    .set({ deleted_at: null, deletion_source: null, updated_at: sql`now()` })
    .where('id', 'in', ids)
    .where('deleted_at', 'is not', null)
    .where('deletion_source', '=', 'crawler_missing')
    .where(sql<boolean>`not ${hasBlockingProductNameDeletion('products')}`)
    .returning('id')
    .execute();
  return rows.map(row => row.id);
}

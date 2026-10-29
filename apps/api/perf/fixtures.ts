import { randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import '../src/config/env.js';
import { migrateToLatest } from '../scripts/migrate.js';
import type { DatabaseSchema } from '../src/database/types.js';

export const PRODUCT_COUNT = 1_000_000;
export const OFFER_COUNT = 5_000_000;
export const TAG_COUNT = PRODUCT_COUNT;

function positiveCount(name: string, value: string | undefined, minimum: number): number {
  if (value === undefined || value.trim() === '') return minimum;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function schemaName(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
    throw new Error('PERF_SCHEMA must be a valid PostgreSQL identifier');
  }
  return value;
}

export function fixtureCounts(environment: NodeJS.ProcessEnv = process.env): {
  products: number;
  offers: number;
  tags: number;
} {
  return {
    products: positiveCount('PERF_PRODUCT_COUNT', environment.PERF_PRODUCT_COUNT, PRODUCT_COUNT),
    offers: positiveCount('PERF_OFFER_COUNT', environment.PERF_OFFER_COUNT, OFFER_COUNT),
    tags: positiveCount('PERF_TAG_COUNT', environment.PERF_TAG_COUNT, TAG_COUNT),
  };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const schema = schemaName(
    process.env.PERF_SCHEMA?.trim() ||
      `perf_${Date.now()}_${randomUUID().replace(/-/gu, '')}`,
  );
  const adminPool = new Pool({ connectionString: databaseUrl });
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path="${schema}",public`,
    max: Number(process.env.PG_POOL_MAX || 10),
  });
  const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
  const counts = fixtureCounts();
  let created = false;

  try {
    await adminPool.query(`create schema "${schema}"`);
    created = true;
    process.env.PG_SCHEMA = schema;
    await migrateToLatest(database);

    await sql`
      insert into shops (platform, url, name)
      values ('performance', ${`https://fixture.invalid/${schema}`}, 'Performance fixture')
      on conflict (url) do nothing
    `.execute(database);
    const shop = await sql<{ id: bigint }>`
      select id from shops where url = ${`https://fixture.invalid/${schema}`}
    `.execute(database);
    const shopId = shop.rows[0]?.id;
    if (shopId === undefined) throw new Error('fixture shop was not created');

    await sql`
      insert into standard_products (name, platform, sort_order, standard_key)
      values ('Performance product', 'performance', 1, ${`fixture:${schema}`})
      on conflict (standard_key) where standard_key is not null do nothing
    `.execute(database);
    const standard = await sql<{ id: bigint }>`
      select id from standard_products where standard_key = ${`fixture:${schema}`}
    `.execute(database);
    const standardId = standard.rows[0]?.id;
    if (standardId === undefined) throw new Error('fixture standard product was not created');

    await sql`
      insert into products (
        shop_id, external_id, name, spec, source_category, source_data,
        normalized_key, url, standardization_locked
      )
      select
        ${shopId},
        'fixture-' || series::text,
        'Performance product ' || series::text,
        'fixture',
        'performance',
        jsonb_build_object('fixture', true, 'ordinal', series),
        'performance-' || (series % 10000)::text,
        'https://fixture.invalid/products/' || series::text,
        true
      from generate_series(1, ${counts.products}) as series
      on conflict (shop_id, external_id) do nothing
    `.execute(database);
    await sql`
      insert into standard_product_members (standard_product_id, product_id)
      select ${standardId}, id
      from products
      where shop_id = ${shopId}
      on conflict do nothing
    `.execute(database);
    await sql`
      insert into product_tags (product_id, name, value)
      select id, 'region', case when id % 2 = 0 then 'us' else 'eu' end
      from products
      where shop_id = ${shopId}
      limit ${counts.tags}
      on conflict do nothing
    `.execute(database);
    await sql`
      insert into offers (
        idempotency_key, product_id, price, currency, captured_at,
        is_stale, stock_available
      )
      select
        'fixture-offer-' || series::text,
        product.id,
        ((series % 10000) + 1)::numeric(14, 2),
        'USD',
        now() - ((series % 3600) * interval '1 second'),
        series % 5 = 0,
        series % 11 <> 0
      from generate_series(1::bigint, ${counts.offers}::bigint) as series
      join (
        select id, row_number() over (order by id) - 1 as ordinal
        from products
        where shop_id = ${shopId}
      ) product
        on product.ordinal = (series - 1) % ${counts.products}::bigint
      on conflict (idempotency_key) do nothing
    `.execute(database);

    console.info(JSON.stringify({ schema, ...counts }));
  } catch (error) {
    if (created) {
      await adminPool.query(`drop schema if exists "${schema}" cascade`);
    }
    throw error;
  } finally {
    await database.destroy();
    await adminPool.end();
  }
}

if (process.argv[1]?.endsWith('fixtures.ts')) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

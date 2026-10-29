import { sql, type Kysely } from 'kysely';
import { up as installCanonicalProjection } from './016_catalog_read_offers_20261023.js';

const SOURCES = ['products', 'offers', 'catalog_product_facts', 'standard_product_members', 'shops', 'standard_products'];
const EVENTS = ['insert', 'update', 'delete', 'truncate'];
const PROJECTIONS = {
  catalog_read_offers: {
    columns: 'product_id standard_product_id shop_id product_name product_url product_spec search_text tags warranty_days facet_tags listed_price currency captured_at is_stale stock_available available settlement_price settlement_verified_at settlement_payment_method settlement_quantity'.split(' '),
    generated: ['available', 'warranty_days'],
  },
  catalog_read_offer_prices: {
    columns: 'product_id standard_product_id shop_id listed_price currency captured_at is_stale stock_available available settlement_price settlement_verified_at settlement_payment_method settlement_quantity price verification_at'.split(' '),
    generated: ['available', 'price', 'verification_at'],
  },
};
const INDEXES = [
  ['catalog_read_offers', 'catalog_read_offers_standard_product', 'btree', 'standard_product_id,product_id'],
  ['catalog_read_offers', 'catalog_read_offers_shop', 'btree', 'shop_id,product_id'],
  ['catalog_read_offers', 'catalog_read_offers_search_text_trgm', 'gin', 'search_text'],
  ['catalog_read_offers', 'catalog_read_offers_tags', 'gin', 'tags'],
  ['catalog_read_offers', 'catalog_read_offers_warranty_days', 'btree', 'warranty_days'],
  ['catalog_read_offer_prices', 'catalog_read_offer_prices_standard_product', 'btree', 'standard_product_id,product_id'],
];

interface ProjectionMetadata {
  schema: string;
  objects: { table: string; kind: string; partition: boolean }[];
  columns: { table: string; name: string; generated: string; primary: boolean }[];
  triggers: { table: string; name: string; function: string; namespace: string; enabled: string }[];
  foreign_keys: { table: string; target: string; namespace: string; columns: string[]; target_columns: string[]; deletion: string }[];
  indexes: { table: string; name: string; method: string; columns: string[]; valid: boolean }[];
  refresh: string | null;
}

async function readMetadata(database: Kysely<unknown>): Promise<ProjectionMetadata> {
  const result = await sql<ProjectionMetadata>`with namespace as (
    select oid, nspname from pg_catalog.pg_namespace where nspname = current_schema()
  )
  select namespace.nspname as schema,
    coalesce((select jsonb_agg(jsonb_build_object(
      'table', c.relname, 'kind', c.relkind, 'partition', c.relispartition))
      from pg_catalog.pg_class c where c.relnamespace = namespace.oid
        and c.relname in ('catalog_read_offers', 'catalog_read_offer_prices')), '[]'::jsonb) as objects,
    coalesce((select jsonb_agg(jsonb_build_object(
      'table', c.relname, 'name', a.attname, 'generated', a.attgenerated,
      'primary', exists (select 1 from pg_catalog.pg_constraint k where k.conrelid = c.oid
        and k.contype = 'p' and k.conkey = array[a.attnum])))
      from pg_catalog.pg_class c join pg_catalog.pg_attribute a on a.attrelid = c.oid
      where c.relnamespace = namespace.oid and c.relkind = 'r'
        and c.relname in ('catalog_read_offers', 'catalog_read_offer_prices')
        and a.attnum > 0 and not a.attisdropped), '[]'::jsonb) as columns,
    coalesce((select jsonb_agg(jsonb_build_object(
      'table', c.relname, 'name', t.tgname, 'function', p.proname, 'namespace', fn.nspname, 'enabled', t.tgenabled))
      from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid = t.tgrelid
      join pg_catalog.pg_proc p on p.oid = t.tgfoid join pg_catalog.pg_namespace fn on fn.oid = p.pronamespace
      where c.relnamespace = namespace.oid and not t.tgisinternal
        and c.relname in ('products', 'offers', 'catalog_product_facts', 'standard_product_members', 'shops', 'standard_products')
        and strpos(t.tgname, 'catalog_read_offers_') = 1), '[]'::jsonb) as triggers,
    coalesce((select jsonb_agg(jsonb_build_object(
      'table', c.relname, 'target', target.relname, 'namespace', tn.nspname, 'deletion', k.confdeltype,
      'columns', (select jsonb_agg(a.attname order by keys.ordinal)
        from unnest(k.conkey) with ordinality keys(attnum, ordinal)
        join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum = keys.attnum),
      'target_columns', (select jsonb_agg(a.attname order by keys.ordinal)
        from unnest(k.confkey) with ordinality keys(attnum, ordinal)
        join pg_catalog.pg_attribute a on a.attrelid = target.oid and a.attnum = keys.attnum)))
      from pg_catalog.pg_constraint k join pg_catalog.pg_class c on c.oid = k.conrelid
      join pg_catalog.pg_class target on target.oid = k.confrelid
      join pg_catalog.pg_namespace tn on tn.oid = target.relnamespace
      where c.relnamespace = namespace.oid and c.relname in ('catalog_read_offers', 'catalog_read_offer_prices')
        and k.contype = 'f'), '[]'::jsonb) as foreign_keys,
    coalesce((select jsonb_agg(jsonb_build_object(
      'table', c.relname, 'name', idx.relname, 'method', am.amname, 'valid', i.indisvalid and i.indisready,
      'columns', (select jsonb_agg(a.attname order by keys.ordinal)
        from unnest(i.indkey) with ordinality keys(attnum, ordinal)
        join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum = keys.attnum
        where keys.ordinal <= i.indnkeyatts)))
      from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid = i.indrelid
      join pg_catalog.pg_class idx on idx.oid = i.indexrelid join pg_catalog.pg_am am on am.oid = idx.relam
      where c.relnamespace = namespace.oid and c.relname in ('catalog_read_offers', 'catalog_read_offer_prices')),
      '[]'::jsonb) as indexes,
    (select p.prosrc from pg_catalog.pg_proc p where p.pronamespace = namespace.oid
      and p.proname = 'refresh_catalog_read_offers' and p.pronargs = 1
      and p.proargtypes[0] = 'bigint[]'::regtype and p.prorettype = 'void'::regtype) as refresh
  from namespace`.execute(database);
  if (!result.rows[0]) throw new Error('Catalog projection rebuild requires an existing current schema');
  return result.rows[0];
}

function isCanonical(metadata: ProjectionMetadata): boolean {
  const unsupported = metadata.objects.find(object => object.kind !== 'r' || object.partition);
  if (unsupported) throw new Error(`Refusing to rebuild unsupported projection relation ${metadata.schema}.${unsupported.table}`);
  // Protect data added by a parallel/newer migration; only this known draft column is disposable.
  for (const [table, expected] of Object.entries(PROJECTIONS)) {
    const unknown = metadata.columns.find(column => column.table === table && !expected.columns.includes(column.name)
      && !(table === 'catalog_read_offers' && column.name === 'shop_name'));
    if (unknown) throw new Error(`Refusing to rebuild unknown projection column ${metadata.schema}.${table}.${unknown.name}`);
  }
  for (const [table, expected] of Object.entries(PROJECTIONS)) {
    const columns = metadata.columns.filter(column => column.table === table);
    if (columns.length !== expected.columns.length
      || !expected.columns.every(name => columns.some(column => column.name === name))
      || !expected.generated.every(name => columns.some(column => column.name === name && column.generated === 's'))
      || !columns.some(column => column.name === 'product_id' && column.primary)) return false;
    const keys = metadata.foreign_keys.filter(key => key.table === table);
    if (keys.length !== 1 || keys[0]!.target !== 'products' || keys[0]!.namespace !== metadata.schema
      || keys[0]!.deletion !== 'c' || keys[0]!.columns.join(',') !== 'product_id'
      || keys[0]!.target_columns.join(',') !== 'id') return false;
  }
  if (metadata.triggers.length !== 16 || !SOURCES.slice(0, 4).every(table => EVENTS.every(event =>
    metadata.triggers.some(trigger => trigger.table === table && trigger.name === `catalog_read_offers_${table}_${event}`
      && trigger.function === `catalog_read_offers_${table}_changed` && trigger.namespace === metadata.schema
      && trigger.enabled === 'O')))) return false;
  if (!INDEXES.every(([table, name, method, columns]) => metadata.indexes.some(index =>
    index.table === table && index.name === name && index.method === method && index.valid
      && index.columns?.join(',') === columns))) return false;
  return !!metadata.refresh && /\bfor\s+no\s+key\s+update\b/iu.test(metadata.refresh)
    && metadata.refresh.includes('catalog_read_offers') && metadata.refresh.includes('catalog_read_offer_prices')
    && !/\b(?:shops|standard_products)\b|\bfor\s+share\b/iu.test(metadata.refresh);
}

export async function up(database: Kysely<unknown>): Promise<void> {
  if (!database.isTransaction) return database.transaction().execute(up);
  let metadata = await readMetadata(database);
  if (!isCanonical(metadata)) {
    // Freeze legacy parent triggers too; only the owning schema may be rebuilt.
    await sql`lock table ${sql.join(SOURCES.map(table => sql.id(metadata.schema, table)))}
      in share row exclusive mode`.execute(database);
    metadata = await readMetadata(database);
    if (!isCanonical(metadata)) {
      for (const source of SOURCES) {
        for (const event of EVENTS) {
          await sql`drop trigger if exists ${sql.id(`catalog_read_offers_${source}_${event}`)}
            on ${sql.id(metadata.schema, source)}`.execute(database);
        }
        await sql`drop function if exists ${sql.id(metadata.schema, `catalog_read_offers_${source}_changed`)}()`.execute(database);
      }
      await sql`drop function if exists ${sql.id(metadata.schema, 'refresh_catalog_read_offers')}(bigint[])`.execute(database);
      // No CASCADE: an unknown dependent object must abort and roll back the entire repair.
      await sql`drop table if exists ${sql.id(metadata.schema, 'catalog_read_offer_prices')}`.execute(database);
      await sql`drop table if exists ${sql.id(metadata.schema, 'catalog_read_offers')}`.execute(database);
      await sql`drop function if exists ${sql.id(metadata.schema, 'catalog_read_offers_max_warranty_days')}(jsonb)`.execute(database);
      await sql`drop index if exists ${sql.id(metadata.schema, 'catalog_product_facts_facet_tags')}`.execute(database);
      await installCanonicalProjection(database);
      if (!isCanonical(await readMetadata(database))) throw new Error('Catalog projection rebuild did not produce the canonical structure');
      await sql`analyze ${sql.id(metadata.schema, 'catalog_read_facet_counts')}`.execute(database);
      return;
    }
  }
  // Earlier canonical installs may lack statistics; ANALYZE preserves source and projection xmin.
  await sql`analyze ${sql.join(['catalog_read_offers', 'catalog_read_offer_prices', 'standard_products', 'shops',
    'catalog_read_facet_counts'].map(table => sql.id(metadata.schema, table)))}`.execute(database);
}

export async function down(): Promise<void> {
  // Current 016 already defines this structure. Unknown unpublished drafts cannot be restored;
  // keep canonical objects so a subsequent 017.down and 016.down can remove their own objects.
}

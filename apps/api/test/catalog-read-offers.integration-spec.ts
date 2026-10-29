import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { Kysely, Migrator, PostgresDialect } from 'kysely';
import { Pool, type PoolClient } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';

const PRICE_FIELDS = [
  'product_id', 'standard_product_id', 'shop_id', 'listed_price', 'currency', 'captured_at', 'is_stale',
  'stock_available', 'available', 'settlement_price', 'settlement_verified_at', 'settlement_payment_method', 'settlement_quantity',
];

describe('transactional catalog read offers', { concurrency: false }, () => {
  const schema = `read_offers_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let pool: Pool;
  let database: Kysely<unknown>;
  let migrator: Migrator;
  let baseline: Awaited<ReturnType<typeof fixture>>;
  let hiddenBaseline: Awaited<ReturnType<typeof fixture>>;

  before(async () => {
    const connectionString = process.env.TEST_DATABASE_URL;
    assert.ok(connectionString, 'TEST_DATABASE_URL is required');
    admin = new Pool({ connectionString });
    await admin.query(`create schema "${schema}"`);
    pool = new Pool({ connectionString, max: 5, options: `-c search_path=${schema},public -c statement_timeout=15000` });
    database = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
    migrator = new Migrator({ db: database, provider: migrationProvider, migrationTableSchema: schema });
    const previous = await migrator.migrateTo('015_ai_response_diagnostic_20261023');
    if (previous.error) throw previous.error;
    baseline = await fixture();
    await pool.query(`update catalog_product_facts set tags =
      '[{"name":"warranty_days","value":"7"},{"name":"warranty_days","value":"30"}]' where product_id = $1`,
    [baseline.product]);
    hiddenBaseline = await fixture();
    await pool.query(`update standard_products set hidden = true, verification_state = 'provisional' where id = $1`,
      [hiddenBaseline.standard]);
    await pool.query('update shops set enabled = false, deleted_at = now() where id = $1', [hiddenBaseline.shop]);
    const current = await migrator.migrateTo('016_catalog_read_offers_20261023');
    if (current.error) throw current.error;
  });

  after(async () => {
    await database?.destroy();
    if (admin) {
      await admin.query(`drop schema if exists "${schema}" cascade`);
      await admin.end();
    }
  });

  afterEach(async () => {
    await assertProjectionsMatch();
  });

  async function fixture() {
    const key = randomUUID();
    const shop = (await pool.query(`insert into shops (name, platform, url)
      values ('Original shop', 'test', $1) returning id`, [`https://${key}.invalid`])).rows[0].id;
    const standard = (await pool.query(`insert into standard_products
      (name, platform, canonical_family, canonical_product, canonical_tier, verification_state, aliases)
      values ('Readable standard', 'openai', 'openai', 'chatgpt', 'free', 'verified', array['OriginalAlias'])
      returning id`)).rows[0].id;
    const product = (await pool.query(`insert into products (shop_id, external_id, name, spec, normalized_key, url)
      values ($1, $2, 'Original product', 'Original spec', $2, $3) returning id`,
    [shop, key, `https://${key}.invalid/item`])).rows[0].id;
    await pool.query(`insert into standard_product_members
      (standard_product_id, product_id, publication_state, assignment_source)
      values ($1, $2, 'published', 'ai')`, [standard, product]);
    const offer = await addOffer(product, { price: '19.20' });
    return { shop, standard, product, offer };
  }

  async function addOffer(product: unknown, values: {
    price?: string; captured?: string; stale?: boolean; stock?: boolean;
  } = {}) {
    return (await pool.query(`insert into offers
      (product_id, idempotency_key, price, captured_at, is_stale, stock_available)
      values ($1, $2, $3, $4, $5, $6) returning id`,
    [product, randomUUID(), values.price ?? '20.00', values.captured ?? '2020-01-01T00:00:00Z',
      values.stale ?? false, values.stock ?? true])).rows[0].id;
  }

  async function read(product: unknown, client: Pick<PoolClient, 'query'> = pool) {
    const result = (await client.query(`select w.*, to_jsonb(w) as wide_quote, to_jsonb(n) as narrow_quote
      from catalog_read_offers w full join catalog_read_offer_prices n using (product_id)
      where coalesce(w.product_id, n.product_id) = $1`, [product])).rows[0];
    if (!result) return undefined;
    const { wide_quote: wide, narrow_quote: narrow, ...row } = result;
    assert.ok(wide, 'narrow projection must not retain a missing wide product');
    assert.ok(narrow, 'wide projection must have a matching narrow product');
    assert.deepEqual(Object.fromEntries(PRICE_FIELDS.map(field => [field, narrow[field]])),
      Object.fromEntries(PRICE_FIELDS.map(field => [field, wide[field]])),
      'both projections must expose the same raw quote in one snapshot');
    return row;
  }

  async function assertProjectionsMatch(client: Pick<PoolClient, 'query'> = pool) {
    const fields = PRICE_FIELDS.join(', ');
    const result = await client.query(`(
      select ${fields} from catalog_read_offers except select ${fields} from catalog_read_offer_prices
    ) union all (
      select ${fields} from catalog_read_offer_prices except select ${fields} from catalog_read_offers
    )`);
    assert.deepEqual(result.rows, [], 'both projections must have identical product sets and exact quote values');
  }

  async function version(product: unknown) {
    return (await pool.query(`select w.xmin::text as wide, n.xmin::text as narrow
      from catalog_read_offers w join catalog_read_offer_prices n using (product_id) where w.product_id = $1`,
    [product])).rows[0];
  }

  async function waitBlocked(pid: number, blocker?: number) {
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const result = await admin.query('select pg_blocking_pids($1) as blockers', [pid]);
      const blockers = result.rows[0].blockers as number[];
      if (blocker === undefined ? blockers.length > 0 : blockers.includes(blocker)) return;
      await setTimeout(10);
    }
    assert.fail('second writer did not enter a database lock wait');
  }

  async function contend(first: [string, unknown[]], second: [string, unknown[]]) {
    const a = await pool.connect();
    const b = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await a.query('begin');
      await b.query('begin');
      const pid = (await b.query('select pg_backend_pid() as pid')).rows[0].pid;
      await a.query(...first);
      pending = b.query(...second).catch((error: unknown) => error);
      await waitBlocked(pid);
      await a.query('commit');
      const result = await pending;
      if (result instanceof Error) throw result;
      await b.query('commit');
    } finally {
      await a.query('rollback');
      await b.query('rollback');
      await pending;
      a.release();
      b.release();
    }
  }

  test('avoids the crawler shop-to-product lock inversion during product and quote refresh', async () => {
    const f = await fixture();
    const a = await pool.connect();
    const b = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await a.query('begin');
      await b.query('begin');
      await a.query(`set local statement_timeout = '2000ms'`);
      await b.query(`set local statement_timeout = '2000ms'`);
      const aPid = (await a.query('select pg_backend_pid() as pid')).rows[0].pid as number;
      const bPid = (await b.query('select pg_backend_pid() as pid')).rows[0].pid as number;
      await a.query('select id from products where id = $1 for no key update', [f.product]);
      await b.query('select id from shops where id = $1 for no key update', [f.shop]);
      pending = b.query(`update products set name = 'Crawler committed product' where id = $1`,
        [f.product]).catch((error: unknown) => error);
      await waitBlocked(bPid, aPid);
      await a.query(`update products set name = 'Projection committed product' where id = $1`, [f.product]);
      await a.query('update offers set price = 32.10 where id = $1', [f.offer]);
      assert.equal((await read(f.product, a)).listed_price, '32.10');
      await a.query('commit');
      const result = await pending;
      if (result instanceof Error) throw result;
      await b.query('commit');
      const row = await read(f.product);
      assert.equal(row.product_name, 'Crawler committed product');
      assert.equal(row.listed_price, '32.10');
      assert.ok(row.search_text.includes('crawler committed product'));
    } finally {
      await a.query('rollback');
      await pending;
      await b.query('rollback');
      a.release();
      b.release();
    }
  });

  test('atomically backfills existing sources without persisting quote expiry or status', async () => {
    const installed = (await pool.query(`select to_regclass($1) as relation`, [`${schema}.catalog_read_offers`])).rows[0];
    assert.ok(installed.relation, 'migration must install catalog_read_offers');
    const row = await read(baseline.product);
    assert.equal(String(row.standard_product_id), String(baseline.standard));
    assert.equal(row.listed_price, '19.20');
    assert.equal(row.captured_at.toISOString(), '2020-01-01T00:00:00.000Z', 'old quotes must survive backfill');
    assert.equal(row.settlement_price, null);
    assert.equal(row.settlement_quantity, null);
    assert.equal(row.product_name, 'Original product');
    assert.ok(!('shop_name' in row));
    assert.ok(!row.search_text.includes('originalalias'));
    assert.ok(!row.search_text.includes('readable standard'));
    assert.ok(row.search_text.startsWith('original product original spec '));
    assert.ok(await read(hiddenBaseline.product), 'backfill retains hidden, provisional and disabled parent sources');
    assert.equal(row.warranty_days, 30, 'backfill must preserve the maximum warranty duration');
    assert.ok(!('price_status' in row));
    assert.ok(!Object.keys(row).some(key => /expir/i.test(key)));
    const parentTriggers = await pool.query(`select t.tgname from pg_trigger t
      join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relname in ('shops', 'standard_products')
        and t.tgname like 'catalog_read_offers_%'`, [schema]);
    assert.deepEqual(parentTriggers.rows, [], 'raw projections must not register parent source triggers');
  });

  test('backfills narrow raw quotes and derived values with matching raw field types', async () => {
    const installed = (await pool.query('select to_regclass($1) as relation',
      [`${schema}.catalog_read_offer_prices`])).rows[0];
    assert.ok(installed.relation, 'migration must install catalog_read_offer_prices');
    const wide = await read(baseline.product);
    const narrow = (await pool.query(
      'select * from catalog_read_offer_prices where product_id = $1', [baseline.product])).rows[0];
    assert.deepEqual(narrow, {
      product_id: wide.product_id, standard_product_id: wide.standard_product_id, shop_id: wide.shop_id,
      listed_price: '19.20', currency: 'CNY', captured_at: new Date('2020-01-01T00:00:00Z'),
      is_stale: false, stock_available: true, available: true, settlement_price: null, settlement_verified_at: null,
      settlement_payment_method: null, settlement_quantity: null,
      price: '19.20', verification_at: null,
    });
    const differences = await pool.query(`select n.column_name
      from information_schema.columns n join information_schema.columns w
        on w.table_schema = n.table_schema and w.column_name = n.column_name
      where n.table_schema = $1 and n.table_name = 'catalog_read_offer_prices' and w.table_name = 'catalog_read_offers'
        and (n.data_type, n.udt_name, n.is_nullable, n.numeric_precision, n.numeric_scale)
          is distinct from (w.data_type, w.udt_name, w.is_nullable, w.numeric_precision, w.numeric_scale)`, [schema]);
    assert.deepEqual(differences.rows, [], 'shared fields must keep the same types and nullability');
  });

  test('derives narrow price and verification time from complete valid settlement fields without a clock or TTL', async () => {
    const f = await fixture();
    const derived = async (client: Pick<PoolClient, 'query'> = pool) => (await client.query(
      'select * from catalog_read_offer_prices where product_id = $1', [f.product])).rows[0];
    let row = await derived();
    assert.equal(row.price, '19.20');
    assert.equal(row.verification_at, null);
    await pool.query(`update offers set settlement_price = 3.333333333333,
      settlement_verified_at = '2019-12-31T23:59:00Z', settlement_payment_method = 'card' where id = $1`, [f.offer]);
    row = await derived();
    assert.equal(row.price, '3.333333333333');
    assert.equal(row.verification_at.toISOString(), '2019-12-31T23:59:00.000Z');
    await pool.query(`update offers set settlement_verified_at = '2030-01-01T00:00:00Z',
      is_stale = true, stock_available = false where id = $1`, [f.offer]);
    row = await derived();
    assert.equal(row.price, '3.333333333333');
    assert.equal(row.verification_at.toISOString(), '2020-01-01T00:00:00.000Z');
    const client = await pool.connect();
    try {
      await client.query('begin');
      // Exercise malformed raw fields locally; source constraints reject these partial settlements.
      for (const [settlement, verified, method, price, verification] of [
        [null, '2019-01-01Z', 'card', '19.20', null],
        ['-1', '2019-01-01Z', 'card', '19.20', null],
        ['Infinity', '2019-01-01Z', 'card', '19.20', null],
        ['NaN', '2019-01-01Z', 'card', '19.20', null],
        ['2', null, 'card', '19.20', null],
        ['2', '2019-01-01Z', null, '19.20', null],
        ['2', '2019-01-01Z', '   ', '19.20', null],
        ['0', '2019-01-01Z', ' card ', '0', '2019-01-01T00:00:00.000Z'],
      ] as const) {
        await client.query(`update catalog_read_offer_prices set settlement_price = $1,
          settlement_verified_at = $2, settlement_payment_method = $3 where product_id = $4`,
        [settlement, verified, method, f.product]);
        row = await derived(client);
        assert.equal(row.price, price, `settlement=${settlement}, verified=${verified}, method=${method}`);
        assert.equal(row.verification_at?.toISOString() ?? null, verification);
      }
    } finally {
      await client.query('rollback');
      client.release();
    }
  });

  test('uses the trigram GIN index for substring searches and keeps it current after metadata updates', async () => {
    const f = await fixture();
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local enable_seqscan = off');
      await client.query(`update products set normalized_key = 'needle_for_read_offer_trigram' where id = $1`, [f.product]);
      const result = await client.query(`explain (format json)
        select product_id from catalog_read_offers where search_text ilike '%needle_for_read_offer_trigram%'`);
      const nodes: Record<string, unknown>[] = [];
      const visit = (node: Record<string, unknown>) => {
        nodes.push(node);
        for (const child of (node.Plans ?? []) as Record<string, unknown>[]) visit(child);
      };
      visit(result.rows[0]['QUERY PLAN'][0].Plan);
      assert.ok(nodes.some(node => node['Node Type'] === 'Bitmap Index Scan'
        && node['Index Name'] === 'catalog_read_offers_search_text_trgm'), 'substring search must have a trigram GIN index');
      const matches = () => client.query(`select product_id from catalog_read_offers
        where search_text ilike '%needle_for_read_offer_trigram%'`);
      assert.deepEqual((await matches()).rows, [{ product_id: f.product }]);
      await client.query(`update products set normalized_key = 'replacement_key' where id = $1`, [f.product]);
      assert.deepEqual((await matches()).rows, []);
      await assertProjectionsMatch(client);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });

  test('stores the maximum valid warranty days without changing raw tags and refreshes it on facts writes', async () => {
    const f = await fixture();
    assert.equal((await read(f.product)).warranty_days, null);
    const tags = [
      { name: 'warranty_days', value: '7' }, { name: 'warranty_days', value: '30' },
      { name: 'warranty_days', value: '00000000000000000000000014' },
      { name: 'warranty_days', value: '2.5' }, { name: 'warranty_days', value: 'NaN' },
      { name: 'warranty_days', value: '2147483648' }, { name: 'warranty_days', value: '-2147483649' },
      { name: 'warranty_days', value: '9999999999999999999999999999999999999999999999999' },
      { name: 'warranty_days', value: '' }, { name: 'warranty_days', value: null },
      { name: 'unrelated', value: '36500' },
    ];
    await pool.query('update catalog_product_facts set tags = $1::jsonb where product_id = $2', [JSON.stringify(tags), f.product]);
    let row = await read(f.product);
    assert.equal(row.warranty_days, 30);
    assert.deepEqual(row.tags, tags);
    assert.deepEqual((await pool.query(
      'select tags from catalog_product_facts where product_id = $1', [f.product])).rows[0].tags, tags);
    for (const [minimum, matches] of [[20, true], [30, true], [31, false]] as const) {
      const result = await pool.query(`select product_id from catalog_read_offers
        where product_id = $1 and warranty_days >= $2`, [f.product, minimum]);
      assert.equal(result.rowCount === 1, matches);
    }
    for (const [nextTags, expected] of [
      [[{ name: 'warranty_days', value: ' +00045 ' }, { name: 'warranty_days', value: '-7' }], 45],
      [[{ name: 'warranty_days', value: '2147483647' }], 2147483647],
      [[{ name: 'warranty_days', value: '-2147483648' }], -2147483648],
      [[{ name: 'warranty_days', value: 'not-a-number' }, { name: 'warranty_days', value: '1e3' }], null],
      [[{ name: 'access', value: 'dedicated' }], null],
      [[], null],
    ] as const) {
      await pool.query('update catalog_product_facts set tags = $1::jsonb where product_id = $2',
        [JSON.stringify(nextTags), f.product]);
      row = await read(f.product);
      assert.equal(row.warranty_days, expected);
      assert.deepEqual(row.tags, nextTags);
    }
    await pool.query('delete from catalog_product_facts where product_id = $1', [f.product]);
    assert.equal((await read(f.product)).warranty_days, null);
  });

  test('uses tags, warranty and shop indexes to narrow matching product IDs', async () => {
    const f = await fixture();
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local enable_seqscan = off');
      await client.query(`update catalog_product_facts set tags =
        '[{"name":"region","value":"ph"},{"name":"warranty_days","value":"60"}]' where product_id = $1`, [f.product]);
      for (const [condition, index] of [
        [`tags @> '[{"name":"region","value":"ph"}]'::jsonb`, 'catalog_read_offers_tags'],
        ['warranty_days >= 31', 'catalog_read_offers_warranty_days'],
        [`shop_id = ${f.shop}`, 'catalog_read_offers_shop'],
      ]) {
        const result = await client.query(`explain (format json) select product_id from catalog_read_offers where ${condition}`);
        const nodes: Record<string, unknown>[] = [];
        const visit = (node: Record<string, unknown>) => {
          nodes.push(node);
          for (const child of (node.Plans ?? []) as Record<string, unknown>[]) visit(child);
        };
        visit(result.rows[0]['QUERY PLAN'][0].Plan);
        assert.ok(nodes.some(node => node['Index Name'] === index), `filter must support ${index}`);
        assert.deepEqual((await client.query(`select product_id from catalog_read_offers where ${condition}`)).rows,
          [{ product_id: f.product }]);
      }
    } finally {
      await client.query('rollback');
      client.release();
    }
  });

  test('inserts an unpublished product without waiting on a locked parent', async () => {
    const f = await fixture();
    const parent = await pool.connect();
    const writer = await pool.connect();
    try {
      await parent.query('begin');
      await writer.query('begin');
      await writer.query(`set local statement_timeout = '1500ms'`);
      await parent.query(`update shops set name = 'Uncommitted parent' where id = $1`, [f.shop]);
      await assert.doesNotReject(() => writer.query(`insert into products
        (shop_id, external_id, name, normalized_key, url) values ($1, $2, 'Unpublished', $2, '')`,
      [f.shop, randomUUID()]), 'a product without members or quotes must not wait on a parent row lock');
    } finally {
      await parent.query('rollback');
      await writer.query('rollback');
      parent.release();
      writer.release();
    }
  });

  test('serializes first member, quote and facts writes before filtering products without a projection', async () => {
    const f = await fixture();
    await pool.query('delete from offers where product_id = $1', [f.product]);
    await pool.query('delete from standard_product_members where product_id = $1', [f.product]);
    assert.equal(await read(f.product), undefined);
    const member: [string, unknown[]] = [`insert into standard_product_members
      (standard_product_id, product_id, assignment_source) values ($1, $2, 'ai')`, [f.standard, f.product]];
    const quote: [string, unknown[]] = [`insert into offers (product_id, idempotency_key, price)
      values ($1, $2, 42)`, [f.product, randomUUID()]];
    await contend(member, quote);
    assert.equal((await read(f.product)).listed_price, '42.00');
    await pool.query('delete from offers where product_id = $1', [f.product]);
    await pool.query('delete from standard_product_members where product_id = $1', [f.product]);
    quote[1][1] = randomUUID();
    await contend(quote, member);
    assert.equal((await read(f.product)).listed_price, '42.00');
    await pool.query('delete from standard_product_members where product_id = $1', [f.product]);
    await contend(
      member,
      [`update offers set price = 84 where product_id = $1`, [f.product]],
    );
    assert.equal((await read(f.product)).listed_price, '84.00');
    await pool.query('delete from standard_product_members where product_id = $1', [f.product]);
    await contend(
      [`update offers set price = 96 where product_id = $1`, [f.product]],
      member,
    );
    assert.equal((await read(f.product)).listed_price, '96.00');
    await pool.query('delete from standard_product_members where product_id = $1', [f.product]);
    await contend(
      [`update catalog_product_facts set tag_text = 'first-published-facts' where product_id = $1`, [f.product]],
      member,
    );
    assert.ok((await read(f.product)).search_text.includes('first-published-facts'));
  });

  test('refresh itself waits for product serialization before taking its eligibility snapshot', async () => {
    const f = await fixture();
    await pool.query('delete from standard_product_members where product_id = $1', [f.product]);
    assert.equal(await read(f.product), undefined);
    await contend(
      [`insert into standard_product_members (standard_product_id, product_id, assignment_source)
        values ($1, $2, 'ai')`, [f.standard, f.product]],
      ['select refresh_catalog_read_offers(array[$1::bigint])', [f.product]],
    );
    assert.equal((await read(f.product)).listed_price, '19.20');
  });

  test('selects by captured_at then id and retains stale, out of stock and invalid latest prices', async () => {
    const f = await fixture();
    const sameTime = await addOffer(f.product, { price: '99.99', stale: true, stock: false });
    assert.equal((await read(f.product)).listed_price, '99.99');
    assert.equal((await read(f.product)).is_stale, true);
    assert.equal((await read(f.product)).stock_available, false);
    assert.equal((await read(f.product)).available, false);
    await addOffer(f.product, { price: '7.00', captured: '2019-12-31T23:59:59Z' });
    assert.equal((await read(f.product)).listed_price, '99.99');
    await pool.query(`update offers set price = 'NaN', is_stale = false, stock_available = true where id = $1`, [sameTime]);
    assert.equal((await read(f.product)).listed_price, 'NaN', 'invalid newest price must not fall back');
    assert.equal((await read(f.product)).available, false);
    await pool.query('update offers set price = 0 where id = $1', [sameTime]);
    assert.equal((await read(f.product)).available, true);
    await pool.query('delete from offers where id = $1', [sameTime]);
    assert.equal((await read(f.product)).listed_price, '19.20');
    await pool.query('delete from offers where product_id = $1', [f.product]);
    assert.equal(await read(f.product), undefined);
    await addOffer(f.product);
    assert.ok(await read(f.product));
  });

  test('preserves exact settlement unit price, quantity and payment fields and refreshes moved offers', async () => {
    const a = await fixture();
    const b = await fixture();
    await pool.query(`update offers set settlement_price = 3.333333333333,
      settlement_total_amount = 10, settlement_quantity = 3,
      settlement_verified_at = '2019-12-31T23:59:00Z', settlement_payment_method = 'card'
      where id = $1`, [a.offer]);
    let row = await read(a.product);
    assert.equal(row.listed_price, '19.20');
    assert.equal(row.settlement_price, '3.333333333333');
    assert.equal(row.settlement_quantity, 3);
    assert.equal(row.settlement_verified_at.toISOString(), '2019-12-31T23:59:00.000Z');
    assert.equal(row.settlement_payment_method, 'card');
    await pool.query(`update offers set product_id = $1, captured_at = '2021-01-01Z' where id = $2`, [b.product, a.offer]);
    assert.equal(await read(a.product), undefined);
    row = await read(b.product);
    assert.equal(row.settlement_price, '3.333333333333');
    assert.equal(row.settlement_quantity, 3);
    await pool.query('delete from offers where id = $1', [a.offer]);
    assert.equal((await read(b.product)).settlement_quantity, null);
  });

  test('keeps parent names, identities, aliases and visibility out of raw projection writes', async () => {
    const f = await fixture();
    const other = await fixture();
    const original = await read(f.product);
    const originalVersion = await version(f.product);
    for (const [table, id, update] of [
      ['shops', f.shop, `name = 'Renamed parent shop'`],
      ['shops', f.shop, `enabled = false, deleted_at = now()`],
      ['standard_products', f.standard, `name = 'Renamed parent standard', aliases = array['ParentAliasOnly']`],
      ['standard_products', f.standard, `platform = 'parent_platform', canonical_family = 'parent_family',
        canonical_product = 'parent_product', canonical_tier = 'parent_tier'`],
      ['standard_products', f.standard, `hidden = true, verification_state = 'provisional'`],
      ['standard_products', f.standard, `merged_into_id = ${other.standard}`],
    ] as const) {
      await pool.query(`update ${table} set ${update} where id = $1`, [id]);
      assert.deepEqual(await read(f.product), original, `${table}: ${update}`);
      assert.deepEqual(await version(f.product), originalVersion, 'parent changes must not rewrite either projection');
    }
    await pool.query('delete from offers where product_id = $1', [f.product]);
    assert.equal(await read(f.product), undefined);
    await addOffer(f.product);
    assert.ok(await read(f.product), 'new raw quotes survive hidden, merged, provisional and disabled parents');
  });

  test('tracks product deletion, publication, standard membership and shop associations', async () => {
    const f = await fixture();
    await pool.query('update products set deleted_at = now() where id = $1', [f.product]);
    assert.equal(await read(f.product), undefined);
    await pool.query('update products set deleted_at = null where id = $1', [f.product]);
    assert.ok(await read(f.product));
    await pool.query(`update standard_product_members set publication_state = 'quarantined' where product_id = $1`, [f.product]);
    assert.equal(await read(f.product), undefined);
    await pool.query(`update standard_product_members set publication_state = 'published' where product_id = $1`, [f.product]);
    assert.ok(await read(f.product));
    const other = await fixture();
    await pool.query('update standard_product_members set standard_product_id = $1 where product_id = $2', [other.standard, f.product]);
    assert.equal(String((await read(f.product)).standard_product_id), String(other.standard));
    await pool.query('update standard_products set merged_into_id = $1 where id = $2', [f.standard, other.standard]);
    assert.ok(await read(f.product), 'parent merging is handled by live API joins');
    await pool.query('update standard_products set merged_into_id = null where id = $1', [other.standard]);
    await pool.query('update products set shop_id = $1 where id = $2', [other.shop, f.product]);
    assert.equal(String((await read(f.product)).shop_id), String(other.shop));
    await pool.query('delete from standard_product_members where product_id = $1', [f.product]);
    assert.equal(await read(f.product), undefined);
    await pool.query(`insert into standard_product_members (standard_product_id, product_id, assignment_source)
      values ($1, $2, 'ai')`, [f.standard, f.product]);
    assert.ok(await read(f.product));
  });

  test('normalizes only product and fact text and keeps tags current', async () => {
    const f = await fixture();
    await pool.query(`update products set name = 'ＰＲＯＤＵＣＴ', spec = 'ＳＰＥＣ',
      normalized_key = 'ＮＯＲＭＡＬ', url = 'https://changed.invalid/item' where id = $1`, [f.product]);
    await pool.query(`update shops set name = 'ＳＨＯＰ' where id = $1`, [f.shop]);
    await pool.query(`update standard_products set name = 'ＳＴＡＮＤＡＲＤ', platform = 'ＰＬＡＴＦＯＲＭ',
      canonical_family = 'wechat', canonical_product = 'domain_email', canonical_tier = 'us_annual',
      aliases = array['ＡＬＩＡＳ'] where id = $1`, [f.standard]);
    let row = await read(f.product);
    for (const term of ['product', 'spec', 'normal']) {
      assert.ok(row.search_text.includes(term), term);
    }
    for (const term of ['shop', 'standard', 'platform', 'wechat', 'domain_email', 'us_annual', 'alias']) {
      assert.ok(!row.search_text.includes(term), `parent term ${term} must stay out of the raw document`);
    }
    assert.equal(row.product_url, 'https://changed.invalid/item');
    await pool.query(`insert into product_tags (product_id, name, value) values ($1, 'region', 'us')`, [f.product]);
    row = await read(f.product);
    assert.ok(row.tags.some((t: { name: string; value: string }) => t.name === 'region' && t.value === 'us'));
    assert.ok(JSON.parse(row.facet_tags).some((t: { name: string }) => t.name === 'region'));
    await pool.query(`update catalog_product_facts set tag_text = 'ＦＡＣＴ ＴＥＸＴ',
      tags = '[{"name":"region","value":"jp"}]'::jsonb where product_id = $1`, [f.product]);
    row = await read(f.product);
    assert.equal(row.search_text, 'product spec normal fact text');
    assert.deepEqual(row.tags, [{ name: 'region', value: 'jp' }]);
    assert.deepEqual(JSON.parse(row.facet_tags), [{ name: 'region', value: 'jp' }]);
    await pool.query('delete from catalog_product_facts where product_id = $1', [f.product]);
    row = await read(f.product);
    assert.deepEqual(row.tags, []);
    assert.equal(row.facet_tags, '[]');
    assert.ok(!row.search_text.includes('fact text'));
    await pool.query(`insert into catalog_product_facts (product_id, tags, tag_text)
      values ($1, '[{"name":"access","value":"dedicated"}]', 'dedicated')`, [f.product]);
    assert.ok((await read(f.product)).search_text.includes('dedicated'));
  });

  test('ignores irrelevant updates and does not rewrite unchanged historical offer projections', async () => {
    const f = await fixture();
    const original = await version(f.product);
    await pool.query('update shops set last_fetch_at = now() where id = $1', [f.shop]);
    await pool.query('update standard_products set sort_order = sort_order + 1 where id = $1', [f.standard]);
    await pool.query('update products set updated_at = now() where id = $1', [f.product]);
    await pool.query('update offers set settlement_refresh_at = now() where id = $1', [f.offer]);
    await pool.query('update standard_product_members set decision_version = decision_version + 1 where product_id = $1', [f.product]);
    await addOffer(f.product, { captured: '2010-01-01Z' });
    assert.deepEqual(await version(f.product), original);
  });

  test('refreshes both old and new product IDs when memberships and facts move', async () => {
    const a = await fixture();
    const b = await fixture();
    await pool.query('delete from standard_product_members where product_id = $1', [b.product]);
    await pool.query('update standard_product_members set product_id = $1 where product_id = $2', [b.product, a.product]);
    assert.equal(await read(a.product), undefined);
    assert.equal(String((await read(b.product)).standard_product_id), String(a.standard));
    await pool.query('delete from catalog_product_facts where product_id = $1', [b.product]);
    await pool.query(`update catalog_product_facts set product_id = $1, tag_text = 'moved-facts' where product_id = $2`,
      [b.product, a.product]);
    assert.ok((await read(b.product)).search_text.includes('moved-facts'));
    await pool.query(`insert into standard_product_members (standard_product_id, product_id, assignment_source)
      values ($1, $2, 'ai')`, [a.standard, a.product]);
    assert.deepEqual((await read(a.product)).tags, []);
    assert.ok(!(await read(a.product)).search_text.includes('moved-facts'));
  });

  test('rolls back source changes and projection updates together and hides uncommitted rows', async () => {
    const f = await fixture();
    const original = await read(f.product);
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`update offers set price = 987.65 where id = $1`, [f.offer]);
      await client.query(`update products set name = 'Uncommitted product' where id = $1`, [f.product]);
      assert.equal((await read(f.product, client)).listed_price, '987.65');
      assert.equal((await read(f.product, client)).product_name, 'Uncommitted product');
      await assertProjectionsMatch(client);
      assert.deepEqual(await read(f.product), original);
    } finally {
      await client.query('rollback');
      client.release();
    }
    assert.deepEqual(await read(f.product), original);
  });

  test('reads a fresh source snapshot after waiting on product locks across offer and facts writers', async () => {
    const f = await fixture();
    await contend(
      [`update products set name = 'Committed product' where id = $1`, [f.product]],
      [`update offers set price = 32.10 where id = $1`, [f.offer]],
    );
    let row = await read(f.product);
    assert.equal(row.product_name, 'Committed product');
    assert.equal(row.listed_price, '32.10');
    await contend(
      [`update offers set price = 45.60 where id = $1`, [f.offer]],
      [`update catalog_product_facts set tag_text = 'committed-facts' where product_id = $1`, [f.product]],
    );
    row = await read(f.product);
    assert.equal(row.listed_price, '45.60');
    assert.ok(row.search_text.includes('committed-facts'));
    const next = await addOffer(f.product, { price: '70.00', captured: '2022-01-01Z' });
    await contend(
      [`delete from offers where id = $1`, [next]],
      [`update offers set price = 88.00 where id = $1`, [f.offer]],
    );
    assert.equal((await read(f.product)).listed_price, '88.00');
  });

  test('keeps the highest ID for concurrent same-time inserts, including an unavailable latest quote', async () => {
    const f = await fixture();
    await contend(
      [`insert into offers (product_id, idempotency_key, price, captured_at)
        values ($1, $2, 60, '2023-01-01T00:00:00Z')`, [f.product, randomUUID()]],
      [`insert into offers (product_id, idempotency_key, price, captured_at, stock_available)
        values ($1, $2, 90, '2023-01-01T00:00:00Z', false)`, [f.product, randomUUID()]],
    );
    const row = await read(f.product);
    assert.equal(row.listed_price, '90.00');
    assert.equal(row.stock_available, false);
  });

  test('associates a new shop and projects a first quote without waiting on parent row locks', async () => {
    const f = await fixture();
    const shop = (await pool.query(`insert into shops (name, platform, url)
      values ('Empty shop', 'test', $1) returning id`, [`https://${randomUUID()}.invalid`])).rows[0].id;
    const standard = (await pool.query(`insert into standard_products (name, platform, verification_state)
      values ('Empty standard', 'test', 'provisional') returning id`)).rows[0].id;
    // The existing member redirect guard locks standards independently of projection refresh.
    await pool.query('update standard_product_members set standard_product_id = $1 where product_id = $2',
      [standard, f.product]);
    await pool.query('delete from offers where product_id = $1', [f.product]);
    assert.equal(await read(f.product), undefined);
    const parent = await pool.connect();
    const writer = await pool.connect();
    try {
      await parent.query('begin');
      await writer.query('begin');
      await writer.query(`set local statement_timeout = '2000ms'`);
      await parent.query('select id from shops where id = $1 for no key update', [shop]);
      await parent.query('select id from standard_products where id = $1 for no key update', [standard]);
      await writer.query('update products set shop_id = $1 where id = $2', [shop, f.product]);
      await writer.query(`insert into offers (product_id, idempotency_key, price)
        values ($1, $2, 27.70)`, [f.product, randomUUID()]);
      assert.equal(String((await read(f.product, writer)).shop_id), String(shop));
      assert.equal(String((await read(f.product, writer)).standard_product_id), String(standard));
      assert.equal((await read(f.product, writer)).listed_price, '27.70');
      await writer.query('commit');
      await parent.query('commit');
      assert.equal(String((await read(f.product)).shop_id), String(shop));
      assert.equal(String((await read(f.product)).standard_product_id), String(standard));
    } finally {
      await parent.query('rollback');
      await writer.query('rollback');
      parent.release();
      writer.release();
    }
  });

  test('removes cascaded products and standards and handles batch changes', async () => {
    const a = await fixture();
    const b = await fixture();
    await pool.query(`update offers set price = 55.00 where product_id = any($1::bigint[])`, [[a.product, b.product]]);
    assert.equal((await read(a.product)).listed_price, '55.00');
    assert.equal((await read(b.product)).listed_price, '55.00');
    await pool.query(`update standard_product_members set assignment_source = 'human'
      where product_id = any($1::bigint[])`, [[a.product, b.product]]);
    await pool.query('delete from standard_products where id = $1', [a.standard]);
    assert.equal(await read(a.product), undefined);
    await pool.query('delete from shops where id = $1', [b.shop]);
    assert.equal(await read(b.product), undefined);
    const c = await fixture();
    await pool.query('delete from products where id = $1', [c.product]);
    assert.equal(await read(c.product), undefined);
  });

  test('refreshes after source truncation and rebuilds through down/up without altering source rows', async () => {
    const f = await fixture();
    await pool.query('truncate catalog_product_facts');
    assert.deepEqual((await read(f.product)).tags, []);
    await assertProjectionsMatch();
    await pool.query('truncate offers');
    assert.equal((await pool.query('select count(*)::int as count from catalog_read_offers')).rows[0].count, 0);
    await assertProjectionsMatch();
    await addOffer(f.product);
    assert.ok(await read(f.product));
    await pool.query('truncate standard_product_members');
    assert.equal(await read(f.product), undefined);
    await assertProjectionsMatch();
    await pool.query(`insert into standard_product_members (standard_product_id, product_id, assignment_source)
      values ($1, $2, 'ai')`, [f.standard, f.product]);
    const sources = async () => (await pool.query(`select
      (select jsonb_agg(p order by id) from products p) as products,
      (select jsonb_agg(o order by id) from offers o) as offers,
      (select jsonb_agg(f order by product_id) from catalog_product_facts f) as facts,
      (select jsonb_agg(m order by product_id) from standard_product_members m) as members,
      (select jsonb_agg(s order by id) from standard_products s) as standards,
      (select jsonb_agg(s order by id) from shops s) as shops`)).rows[0];
    const original = await sources();
    const down = await migrator.migrateTo('015_ai_response_diagnostic_20261023');
    if (down.error) throw down.error;
    assert.equal((await pool.query('select to_regclass($1) as relation', [`${schema}.catalog_read_offers`])).rows[0].relation, null);
    for (const relation of ['catalog_read_offer_prices', 'catalog_read_offers_shop', 'catalog_read_offers_search_text_trgm',
      'catalog_read_offers_tags', 'catalog_read_offers_warranty_days']) {
      assert.equal((await pool.query('select to_regclass($1) as relation', [`${schema}.${relation}`])).rows[0].relation, null);
    }
    assert.equal((await pool.query('select to_regprocedure($1) as routine',
      [`${schema}.catalog_read_offers_max_warranty_days(jsonb)`])).rows[0].routine, null);
    assert.deepEqual(await sources(), original);
    const up = await migrator.migrateTo('016_catalog_read_offers_20261023');
    if (up.error) throw up.error;
    assert.deepEqual(await sources(), original);
    assert.ok(await read(f.product));
    await assertProjectionsMatch();
    await pool.query('truncate shops cascade');
    assert.equal((await pool.query('select count(*)::int as count from catalog_read_offers')).rows[0].count, 0);
  });
});

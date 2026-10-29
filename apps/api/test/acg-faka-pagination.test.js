import test from 'node:test';
import assert from 'node:assert/strict';
import { crawl } from '../src/platforms/acg-faka.js';

const shop = { url: 'https://acg.example/' };
const listing = id => ({ id, name: `Product ${id}`, status: 1 });
const rows = Array.from({ length: 30 }, (_, index) => listing(index + 1));
const json = data => Response.json({ code: 200, data });

function network({ categories = [{ id: 9, commodity_count: 30 }], defaultLimit = 5, intercept } = {}) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push(url);
    const changed = await intercept?.(url, init);
    if (changed) return changed;
    if (url.pathname.endsWith('/data')) return json(categories);
    if (url.pathname.endsWith('/commodity')) {
      const current = Number(url.searchParams.get('page') ?? 1);
      const limit = Number(url.searchParams.get('limit') ?? defaultLimit);
      return Response.json({ code: 200, total: rows.length, data: rows.slice((current - 1) * limit, current * limit) });
    }
    if (url.pathname.endsWith('/commodityDetail')) return json({
      ...listing(Number(url.searchParams.get('commodityId'))), draft_status: 0, inventory_hidden: 0,
      minimum: 1, maximum: 0, only_user: 0, purchase_count: 0, config: {},
    });
    if (url.pathname.endsWith('/stock')) return json({ stock: 5, stock_state: 1 });
    if (url.pathname.endsWith('/valuation')) return json({ price: '9.90' });
    if (url.pathname.endsWith('/pay')) return json([]);
    throw new Error(`Unexpected endpoint ${url.pathname}`);
  };
  return { fetch, calls };
}

function observe() {
  const stats = [];
  let completed = 0;
  return { stats, get completed() { return completed; }, options: {
    onListStats: value => stats.push(value),
    onListComplete: () => { completed++; },
  } };
}

const listCalls = net => net.calls.filter(url => url.pathname.endsWith('/commodity'));

for (const defaultLimit of [5, 20]) {
  test(`ACG category pagination covers every offset with server default limit ${defaultLimit}`, async () => {
    const net = network({ defaultLimit }), events = observe();
    const products = await crawl(null, shop, net.fetch, events.options);
    assert.deepEqual(products.map(product => product.externalId), rows.map(row => String(row.id)));
    assert.deepEqual(listCalls(net).map(url => Object.fromEntries(url.searchParams)), [
      { categoryId: '9', page: '1', limit: '12' },
      { categoryId: '9', page: '2', limit: '12' },
      { categoryId: '9', page: '3', limit: '12' },
    ]);
    assert.equal(events.completed, 1);
    assert.deepEqual(events.stats, [{ unique: 30, duplicates: 0, categories: 1, categoryClaims: 30, flatTotal: null }]);
  });
}

for (const [name, brokenPage, remaining] of [
  ['empty first page', 1, []],
  ['empty middle page', 2, []],
  ['short first page', 1, rows.slice(0, 5)],
  ['short middle page', 2, rows.slice(12, 17)],
  ['missing final row', 3, rows.slice(24, 29)],
]) {
  test(`ACG rejects an incomplete category snapshot with ${name}`, async () => {
    const net = network({ defaultLimit: 12, intercept: url => {
      if (url.pathname.endsWith('/commodity') && url.searchParams.has('categoryId')
        && Number(url.searchParams.get('page') ?? 1) === brokenPage) return json(remaining);
    } }), events = observe();
    await assert.rejects(crawl(null, shop, net.fetch, events.options), /incomplete.*pagination/);
    assert.equal(events.completed, 0);
    assert.deepEqual(events.stats, []);
    assert.ok(listCalls(net).every(url => url.searchParams.has('categoryId')));
    assert.ok(!net.calls.some(url => url.pathname.endsWith('/commodityDetail')));
  });
}

test('ACG does not turn a completely empty claimed category into a successful flat snapshot', async () => {
  const net = network({ categories: [{ id: 9, commodity_count: 1 }], intercept: url =>
    url.pathname.endsWith('/commodity') && url.searchParams.has('categoryId') ? json([]) : undefined,
  }), events = observe();
  await assert.rejects(crawl(null, shop, net.fetch, events.options), /incomplete.*pagination/);
  assert.equal(events.completed, 0);
  assert.deepEqual(events.stats, []);
  assert.equal(listCalls(net).length, 1);
});

for (const [name, failure] of [
  ['HTTP failure', () => new Response('', { status: 503 })],
  ['network failure', () => { throw new Error('discovery failed'); }],
  ['invalid JSON', () => new Response('invalid JSON')],
  ['API failure', () => Response.json({ code: 0, msg: 'unavailable' })],
  ['malformed discovery', () => json({})],
]) {
  test(`ACG propagates category discovery ${name} without a flat fallback`, async () => {
    const net = network({ intercept: url => url.pathname.endsWith('/data') ? failure() : undefined });
    const events = observe();
    await assert.rejects(crawl(null, shop, net.fetch, events.options));
    assert.equal(events.completed, 0);
    assert.deepEqual(events.stats, []);
    assert.equal(listCalls(net).length, 0);
  });
}

for (const categories of [
  [{ id: 0, commodity_count: 1 }],
  [{ id: 9, commodity_count: '30' }],
  [{ id: 9, commodity_count: -1 }],
  [{ id: 9, commodity_count: 1.5 }],
  [{ id: 9, commodity_count: 12001 }],
  [{ id: 9, commodity_count: 0 }, { id: 9, commodity_count: 0 }],
  [{ id: 9, commodity_count: 30 }, { id: 10 }],
]) {
  test(`ACG rejects invalid category coverage ${JSON.stringify(categories)}`, async () => {
    const net = network({ categories }), events = observe();
    await assert.rejects(crawl(null, shop, net.fetch, events.options), /invalid categor/);
    assert.equal(events.completed, 0);
    assert.deepEqual(events.stats, []);
    assert.equal(listCalls(net).length, 0);
  });
}

for (const [data, error] of [[rows.slice(0, 13), /invalid pagination/], [[listing(1), listing(1)], /duplicate product ID/]]) {
  test(`ACG rejects oversized or duplicate category pages (${data.length} rows)`, async () => {
    const net = network({ intercept: url => url.pathname.endsWith('/commodity') ? json(data) : undefined });
    const events = observe();
    await assert.rejects(crawl(null, shop, net.fetch, events.options), error);
    assert.equal(events.completed, 0);
    assert.deepEqual(events.stats, []);
  });
}

test('ACG rejects category overflow even if the category has fewer than twelve claimed rows', async () => {
  const net = network({ categories: [{ id: 9, commodity_count: 1 }], intercept: url =>
    url.pathname.endsWith('/commodity') ? json(rows.slice(0, 2)) : undefined,
  }), events = observe();
  await assert.rejects(crawl(null, shop, net.fetch, events.options), /invalid pagination/);
  assert.equal(events.completed, 0);
  assert.deepEqual(events.stats, []);
});

for (const during of ['before discovery', 'discovery', 'category page 1', 'category page 2']) {
  test(`ACG cancellation during ${during} never completes or falls back`, async () => {
    const controller = new AbortController(), events = observe();
    if (during === 'before discovery') controller.abort();
    const net = network({ defaultLimit: 12, intercept: (url, init) => {
      assert.equal(init.signal, controller.signal);
      if (during === 'discovery' && url.pathname.endsWith('/data')
        || url.pathname.endsWith('/commodity') && during === `category page ${url.searchParams.get('page') ?? '1'}`) {
        controller.abort();
      }
    } });
    await assert.rejects(crawl(null, shop, net.fetch, { ...events.options, signal: controller.signal }), { name: 'AbortError' });
    assert.equal(events.completed, 0);
    assert.deepEqual(events.stats, []);
    assert.ok(listCalls(net).every(url => url.searchParams.has('categoryId')));
  });
}

test('ACG later category page errors propagate without completing or falling back', async () => {
  const net = network({ defaultLimit: 12, intercept: url =>
    url.pathname.endsWith('/commodity') && url.searchParams.get('page') === '2'
      ? new Response('', { status: 503 }) : undefined,
  }), events = observe();
  await assert.rejects(crawl(null, shop, net.fetch, events.options), /HTTP 503/);
  assert.equal(events.completed, 0);
  assert.deepEqual(events.stats, []);
  assert.ok(listCalls(net).every(url => url.searchParams.has('categoryId')));
});

for (const categories of [[], [{ id: 9, commodity_count: 0 }]]) {
  test(`ACG supports a flat-only empty or permission-filtered catalog (${categories.length} categories)`, async () => {
    for (const total of [0, 25]) {
      const net = network({ categories, intercept: url =>
        url.pathname.endsWith('/commodity') ? Response.json({ code: 200, total, data: [] }) : undefined,
      }), events = observe();
      assert.deepEqual(await crawl(null, shop, net.fetch, events.options), []);
      assert.deepEqual(listCalls(net).map(url => url.searchParams.get('page')), total === 0 ? ['1'] : ['1', '2', '3']);
      assert.ok(listCalls(net).every(url => !url.searchParams.has('categoryId')));
      assert.equal(events.completed, 1);
      assert.deepEqual(events.stats, [{ unique: 0, duplicates: 0, categories: 0, categoryClaims: 0, flatTotal: total }]);
    }
  });
}

test('ACG flat permission filtering cannot put rows beyond the final advertised offset', async () => {
  const net = network({ categories: [], intercept: url => url.pathname.endsWith('/commodity')
    ? Response.json({ code: 200, total: 13, data: url.searchParams.get('page') === '1' ? [listing(1)] : [listing(13), listing(14)] })
    : undefined,
  }), events = observe();
  await assert.rejects(crawl(null, shop, net.fetch, events.options), /invalid pagination/);
  assert.equal(events.completed, 0);
  assert.deepEqual(events.stats, []);
});

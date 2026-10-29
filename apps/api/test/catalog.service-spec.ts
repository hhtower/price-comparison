import assert from 'node:assert/strict';
import test from 'node:test';
import { createCache } from 'cache-manager';
import { CatalogService, normalizeCatalogQuery, type CatalogQueryInput } from '../src/catalog/catalog.service.js';
import type { CatalogFacets, CatalogPage, CatalogQuery, CatalogRepository } from '../src/catalog/catalog.repository.js';

const emptyPage = { items: [], platformFacets: [], total: 0 };

test('catalog reads use the live projection without a version round trip or a cached response', async () => {
  for (const kind of ['page', 'facets'] as const) {
    let reads = 0;
    const first = kind === 'page' ? { ...emptyPage, total: 1 } : { tagFacets: [] };
    const latest = kind === 'page' ? { ...emptyPage, total: 2 }
      : { tagFacets: [{ name: 'region', value: 'us', priority: 2 }] };
    let projection: CatalogPage | CatalogFacets = first;
    const loader = async () => { reads += 1; return projection; };
    const cache = createCache();
    const service = new CatalogService({ search: loader, facets: loader } as unknown as CatalogRepository, cache);
    const read = () => kind === 'page' ? service.getCatalog({ view: 'summary' }) : service.getFacets({});
    try {
      assert.deepEqual(await read(), first);
      projection = latest;
      assert.deepEqual(await read(), latest, `${kind} sees source changes without a catalog version change`);
      assert.equal(reads, 2);
    } finally { await cache.disconnect(); }
  }
});

test('page and facet query failures propagate unchanged without falling back to a previous response', async () => {
  for (const kind of ['page', 'facets'] as const) {
    let reads = 0;
    const failure = new Error('database unavailable');
    const first = kind === 'page' ? { ...emptyPage, total: 1 } : { tagFacets: [] };
    const recovered = kind === 'page' ? { ...emptyPage, total: 3 }
      : { tagFacets: [{ name: 'region', value: 'jp', priority: 3 }] };
    const loader = async () => {
      reads += 1;
      if (reads === 2) throw failure;
      return reads === 1 ? first : recovered;
    };
    const cache = createCache();
    const service = new CatalogService({ search: loader, facets: loader } as unknown as CatalogRepository, cache);
    const read = () => kind === 'page' ? service.getCatalog({}) : service.getFacets({});
    try {
      assert.deepEqual(await read(), first);
      await assert.rejects(read(), (error: unknown) => error === failure);
      assert.deepEqual(await read(), recovered);
      assert.equal(reads, 3);
    } finally { await cache.disconnect(); }
  }
});

test('a new page or facets request finishes before an older slow request and later reads stay fresh', async () => {
  for (const kind of ['page', 'facets'] as const) {
    let reads = 0;
    const oldResult = kind === 'page' ? { ...emptyPage, total: 1 } : { tagFacets: [] };
    const latest = kind === 'page' ? { ...emptyPage, total: 2 }
      : { tagFacets: [{ name: 'region', value: 'us', priority: 2 }] };
    let finishOld!: (value: typeof oldResult) => void;
    const slow = new Promise<typeof oldResult>(resolve => { finishOld = resolve; });
    const loader = () => ++reads === 1 ? slow : Promise.resolve(latest);
    const cache = createCache();
    const service = new CatalogService({ search: loader, facets: loader } as unknown as CatalogRepository, cache);
    const read = () => kind === 'page' ? service.getCatalog({}) : service.getFacets({});
    try {
      const oldRequest = read();
      let currentFinished = false;
      const currentRequest = read().then(result => { currentFinished = true; return result; });
      await new Promise(resolve => setImmediate(resolve));
      const finishedBeforeOld = currentFinished;
      const readsBeforeOld = reads;
      finishOld(oldResult);
      const [old, current] = await Promise.all([oldRequest, currentRequest]);
      assert.equal(finishedBeforeOld, true, `${kind} must not coalesce behind a previous query`);
      assert.equal(readsBeforeOld, 2);
      assert.deepEqual(old, oldResult);
      assert.deepEqual(current, latest);
      assert.deepEqual(await read(), latest, 'a late old result cannot replace a later live read');
      assert.equal(reads, 3);
    } finally {
      finishOld(oldResult);
      await cache.disconnect();
    }
  }
});

for (const kind of ['page', 'facets'] as const) test(`${kind} rechecks both expired slow loads and performs a fourth read on the next request`, async context => {
  context.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  let reads = 0;
  const loader = async () => {
    reads += 1;
    const result = { ...(kind === 'page' ? emptyPage : { tagFacets: [] }),
      nextExpiryAt: reads <= 2 ? new Date(Date.now() + 5).toISOString() : null };
    if (reads <= 2) context.mock.timers.tick(10);
    return result;
  };
  const cache = createCache();
  const service = new CatalogService({ search: loader, facets: loader } as unknown as CatalogRepository, cache);
  const read = () => kind === 'page' ? service.getCatalog({}) : service.getFacets({});
  try {
    const result = await read();
    assert.equal(result.nextExpiryAt, null, 'a second expired load cannot be returned');
    assert.equal(reads, 3);
    assert.equal(Date.now(), 1_020);
    assert.deepEqual(await read(), result);
    assert.equal(reads, 4, 'a stable response still requires a live read on the next request');
  } finally { await cache.disconnect(); }
});

test('repository calls receive normalized queries, distinct detail pages and filters on every request', async () => {
  const pages: CatalogQuery[] = [];
  const facets: unknown[] = [];
  const cache = createCache();
  const service = new CatalogService({
    search: async (query: CatalogQuery) => { pages.push(query); return emptyPage; },
    facets: async (query: unknown) => { facets.push(query); return { tagFacets: [] }; },
  } as unknown as CatalogRepository, cache);
  const base = { standardProductId: '42', view: 'full', detailKind: 'offers' };
  const detail = { standardProductId: '42', detailKind: 'offers', detailPage: 0, detailPageSize: 4, tags: [], limit: 20 };
  try {
    for (const input of [
      base, { ...base, detailPage: 0, detailPageSize: 4 }, { ...base, detailPage: 1 },
      { ...base, detailKind: 'shops' }, { ...base, detailPageSize: 2 },
      { ...base, tag: { name: 'region', value: 'us' } }, { standardProductId: '42', view: 'full' }, base,
    ]) await service.getCatalog(input);
    assert.deepEqual(pages, [
      detail, detail, { ...detail, detailPage: 1 }, { ...detail, detailKind: 'shops' },
      { ...detail, detailPageSize: 2 }, { ...detail, tags: [{ name: 'region', value: 'us' }] },
      { standardProductId: '42', tags: [], limit: 20 }, detail,
    ]);
    const filters = { platform: ' OpenAI ', q: ' Ｐｌｕｓ ', shopQuery: ' Ｍａｌｌ ',
      priceMin: '7', priceMax: 9, offerSort: 'priceDesc', tag: { name: ' region ', value: ' US ' } };
    await service.getCatalog({ ...filters, sort: 'default', view: 'full', limit: 999 });
    assert.deepEqual(pages.at(-1), { platform: 'openai', search: 'plus', shopQuery: 'Mall',
      priceMin: '7.00', priceMax: '9.00', currency: 'CNY', offerSort: 'priceDesc',
      tags: [{ name: 'region', value: 'us' }], limit: 100 });
    await service.getFacets(filters);
    await service.getFacets({ platform: 'openai', search: 'plus', shopQuery: 'Mall',
      priceMin: '7.00', priceMax: '9.00', currency: 'CNY', tag: { name: 'region', value: 'us' } });
    const expectedFacets = { platform: 'openai', search: 'plus', shopQuery: 'Mall',
      priceMin: '7.00', priceMax: '9.00', currency: 'CNY', tags: [{ name: 'region', value: 'us' }] };
    assert.deepEqual(facets, [expectedFacets, expectedFacets]);
    assert.equal(pages.length, 9);
  } finally { await cache.disconnect(); }
});

test('invalid page and facet inputs reach no repository query', async () => {
  let reads = 0;
  const cache = createCache();
  const service = new CatalogService({
    search: async () => { reads += 1; return emptyPage; },
    facets: async () => { reads += 1; return { tagFacets: [] }; },
  } as unknown as CatalogRepository, cache);
  const invalid: { input: CatalogQueryInput; code: string; both: boolean }[] = [
    { input: { view: 'anything' }, code: 'INVALID_VIEW', both: false },
    { input: { sort: 'anything' }, code: 'INVALID_SORT', both: false },
    { input: { detailKind: 'offers' }, code: 'INVALID_DETAIL_QUERY', both: false },
    { input: { standardProductId: '0' }, code: 'INVALID_STANDARD_PRODUCT', both: true },
    { input: { tag: 'not-json' }, code: 'INVALID_FILTER', both: true },
    { input: { warrantyDaysMin: 0 }, code: 'INVALID_WARRANTY_DAYS', both: true },
    { input: { priceMin: '9', priceMax: '7' }, code: 'INVALID_PRICE_RANGE', both: true },
    { input: { currency: 'cny' }, code: 'INVALID_CURRENCY', both: true },
  ];
  try {
    for (const { input, code, both } of invalid) {
      await assert.rejects(service.getCatalog(input), { code });
      if (both) await assert.rejects(service.getFacets(input), { code });
    }
    assert.equal(reads, 0);
  } finally { await cache.disconnect(); }
});

test('validates summary, detail and sorting query parameters before reading the catalog', () => {
  assert.deepEqual(normalizeCatalogQuery({ view: 'summary', standardProductId: '42', sort: 'price' }), { view: 'summary', standardProductId: '42', sort: 'price', tags: [], limit: 20 });
  for (const standardProductId of ['0', '-1', 'abc', '9223372036854775808']) {
    assert.throws(() => normalizeCatalogQuery({ standardProductId }), { code: 'INVALID_STANDARD_PRODUCT' });
  }
  assert.throws(() => normalizeCatalogQuery({ view: 'anything' }), { code: 'INVALID_VIEW' });
  assert.throws(() => normalizeCatalogQuery({ sort: 'anything' }), { code: 'INVALID_SORT' });
});

test('detail pagination normalizes defaults and rejects invalid or unbounded requests', () => {
  const base = { standardProductId: '42', detailKind: 'offers' };
  assert.deepEqual(normalizeCatalogQuery(base), { standardProductId: '42', detailKind: 'offers', detailPage: 0, detailPageSize: 4, tags: [], limit: 20 });
  assert.deepEqual(normalizeCatalogQuery({ ...base, view: 'full', detailPage: 0, detailPageSize: 4 }), normalizeCatalogQuery(base));
  assert.equal(normalizeCatalogQuery({ ...base, detailKind: 'shops', detailPage: 2, detailPageSize: 50 }).detailPage, 2);
  for (const input of [
    { detailKind: 'offers' }, { ...base, view: 'summary' }, { ...base, detailKind: 'other' },
    { standardProductId: '42', detailPage: 0 }, { standardProductId: '42', detailPageSize: 4 },
    ...[-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER].map(detailPage => ({ ...base, detailPage })),
    ...[0, -1, 1.5, 51, Number.NaN, Number.POSITIVE_INFINITY].map(detailPageSize => ({ ...base, detailPageSize })),
  ]) {
    assert.throws(() => normalizeCatalogQuery(input), { code: 'INVALID_DETAIL_QUERY' });
  }
});

test('catalog query normalization trims values and bounds page size', () => {
  const query = normalizeCatalogQuery({ platform: '  ChatGPT ', q: ' Plus ', tags: [{ name: ' region ', value: ' Philippines ' }], limit: 999 });
  assert.deepEqual(query, { platform: 'chatgpt', search: 'plus', tags: [{ name: 'region', value: 'philippines' }], limit: 100 });
});

test('explicit purchase filters override inferred same-dimension conditions', () => {
  const query = normalizeCatalogQuery({ q: 'Plus 已接码 质保30天', tags: [{ name: 'sms_verification', value: 'unverified' }], warrantyDaysMin: 7 });
  assert.equal(query.search, 'plus');
  assert.equal(query.warrantyDaysMin, 7);
  assert.deepEqual(query.tags.filter(tag => tag.name === 'sms_verification'), [{ name: 'sms_verification', value: 'unverified' }]);
});

test('invalid purchase filters fail closed rather than silently broadening search', () => {
  for (const tag of ['not-json', 'null', JSON.stringify({ name: 'warranty', value: null })]) {
    assert.throws(() => normalizeCatalogQuery({ tag }), { code: 'INVALID_FILTER' });
  }
  for (const warrantyDaysMin of [-1, 0, 1.5, Number.NaN, 36501]) {
    assert.throws(() => normalizeCatalogQuery({ warrantyDaysMin }), { code: 'INVALID_WARRANTY_DAYS' });
  }
});

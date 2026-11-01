import assert from 'node:assert/strict';
import test from 'node:test';
import { createCache } from '../src/cache/cache.js';
import { CatalogService, normalizeCatalogQuery, type CatalogQueryInput } from '../src/catalog/catalog.service.js';
import type { CatalogFacets, CatalogPage, CatalogQuery, CatalogRepository } from '../src/catalog/catalog.repository.js';

const emptyPage = { items: [], platformFacets: [], total: 0 };

for (const kind of ['page', 'facets'] as const) test(`${kind} caches for at most five seconds and propagates failures after expiry`, async context => {
  context.mock.timers.enable({ apis: ['Date'], now: 1000 });
  let reads = 0;
  const failure = new Error('database unavailable');
  const loader = async () => {
    if (++reads === 2) throw failure;
    return kind === 'page' ? { ...emptyPage, total: reads } : { tagFacets: [], nextExpiryAt: null };
  };
  const cache = createCache();
  const service = new CatalogService({ search: loader, facets: loader } as unknown as CatalogRepository, cache);
  const read = () => kind === 'page' ? service.getCatalog({}) : service.getFacets({});
  try {
    const first = await read();
    assert.deepEqual(await read(), first);
    assert.equal(reads, 1);
    context.mock.timers.tick(5000);
    await assert.rejects(read(), (error: unknown) => error === failure);
    await read();
    assert.equal(reads, 3);
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
  const base = { standardProductId: '42', detailKind: 'offers' };
  const detail = { standardProductId: '42', detailKind: 'offers', detailPage: 0, detailPageSize: 4, tags: [], limit: 20 };
  try {
    for (const input of [
      base, { ...base, detailPage: 0, detailPageSize: 4 }, { ...base, detailPage: 1 },
      { ...base, detailKind: 'shops' }, { ...base, detailPageSize: 2 },
      { ...base, tag: { name: 'region', value: 'us' } }, { standardProductId: '42' }, base,
    ]) await service.getCatalog(input);
    assert.deepEqual(pages, [
      detail, { ...detail, detailPage: 1 }, { ...detail, detailKind: 'shops' },
      { ...detail, detailPageSize: 2 }, { ...detail, tags: [{ name: 'region', value: 'us' }] },
      { standardProductId: '42', tags: [], limit: 20 },
    ]);
    const filters = { platform: ' OpenAI ', q: ' Ｐｌｕｓ ', shopQuery: ' Ｍａｌｌ ',
      priceMin: '7', priceMax: 9, offerSort: 'priceDesc', tag: { name: ' region ', value: ' US ' } };
    await service.getCatalog({ ...filters, sort: 'default', limit: 999 });
    assert.deepEqual(pages.at(-1), { platform: 'openai', search: 'plus', shopQuery: 'Mall',
      priceMin: '7.00', priceMax: '9.00', currency: 'CNY', offerSort: 'priceDesc',
      tags: [{ name: 'region', value: 'us' }], limit: 100 });
    await service.getFacets(filters);
    await service.getFacets({ platform: 'openai', search: 'plus', shopQuery: 'Mall',
      priceMin: '7.00', priceMax: '9.00', currency: 'CNY', tag: { name: 'region', value: 'us' } });
    const expectedFacets = { platform: 'openai', search: 'plus', shopQuery: 'Mall',
      priceMin: '7.00', priceMax: '9.00', currency: 'CNY', tags: [{ name: 'region', value: 'us' }] };
    assert.deepEqual(facets, [expectedFacets]);
    assert.equal(pages.length, 7);
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
  assert.deepEqual(normalizeCatalogQuery({ standardProductId: '42', sort: 'price' }), { standardProductId: '42', sort: 'price', tags: [], limit: 20 });
  for (const standardProductId of ['0', '-1', 'abc', '9223372036854775808']) {
    assert.throws(() => normalizeCatalogQuery({ standardProductId }), { code: 'INVALID_STANDARD_PRODUCT' });
  }
  assert.throws(() => normalizeCatalogQuery({ sort: 'anything' }), { code: 'INVALID_SORT' });
});

test('detail pagination normalizes defaults and rejects invalid or unbounded requests', () => {
  const base = { standardProductId: '42', detailKind: 'offers' };
  assert.deepEqual(normalizeCatalogQuery(base), { standardProductId: '42', detailKind: 'offers', detailPage: 0, detailPageSize: 4, tags: [], limit: 20 });
  assert.deepEqual(normalizeCatalogQuery({ ...base, detailPage: 0, detailPageSize: 4 }), normalizeCatalogQuery(base));
  assert.equal(normalizeCatalogQuery({ ...base, detailKind: 'shops', detailPage: 2, detailPageSize: 50 }).detailPage, 2);
  for (const input of [
    { detailKind: 'offers' }, { ...base, detailKind: 'other' },
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

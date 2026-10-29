import assert from 'node:assert/strict';
import test from 'node:test';
import { CatalogController } from '../src/catalog/catalog.controller.js';
import { CatalogService } from '../src/catalog/catalog.service.js';
import type { CatalogQuery, CatalogRepository } from '../src/catalog/catalog.repository.js';
import { createCache } from '../src/cache/cache.js';

test('public product endpoints return metadata, preserve merges and return real 404 without masking failures', async () => {
  let unavailable = false;
  const product = { id: '42', name: 'Codex 手机接码', platform: 'openai', kind: '手机接码' };
  const merged = { ...product, id: '41', mergedIntoId: '42' };
  const service = new CatalogService({
    publicProducts: async () => { if (unavailable) throw Error('database unavailable'); return { items: [product] }; },
    publicProduct: async (id: string) => { if (id === '43') throw Error('database unavailable'); return id === '42' ? product : id === '41' ? merged : null; },
  } as unknown as CatalogRepository, createCache());
  const controller = new CatalogController(service);
  assert.deepEqual(await controller.getProducts(), { items: [product] });
  assert.deepEqual(await controller.getProduct('42'), product);
  assert.deepEqual(await controller.getProduct('41'), merged);
  for (const id of ['44', '0', '9223372036854775808', 'bad']) await assert.rejects(() => controller.getProduct(id), error => (error as { getStatus(): number }).getStatus() === 404);
  await assert.rejects(() => controller.getProduct('43'), error => (error as { getStatus(): number }).getStatus() === 503);
  unavailable = true;
  await assert.rejects(() => controller.getProducts(), error => (error as { getStatus(): number }).getStatus() === 503);
});

test('facet endpoint normalizes only filters and never fetches a product page', async () => {
  let actual: unknown;
  const facets = { tagFacets: [{ name: 'access', value: 'dedicated', priority: 1 }] };
  const service = new CatalogService({
    facets: async (query: unknown) => { actual = query; return facets; },
    search: async () => { throw new Error('facets must not load products'); },
  } as unknown as CatalogRepository, createCache({ ttl: 30_000 }));
  assert.deepEqual(await new CatalogController(service).getFacets({
    platform: ' OpenAI ', q: 'Plus 已接码',
    tag: [JSON.stringify({ name: 'region', value: 'us' }), JSON.stringify({ name: 'sms_verification', value: 'unverified' })],
    warrantyDaysMin: '30', limit: 'bad', sort: 'bad', cursor: 'bad',
  }), facets);
  assert.deepEqual(actual, { platform: 'openai', search: 'plus',
    tags: [{ name: 'region', value: 'us' }, { name: 'sms_verification', value: 'unverified' }], warrantyDaysMin: 30 });
});

test('facet endpoint rejects invalid filters before querying data', async () => {
  let reads = 0;
  const service = new CatalogService({ facets: async () => { reads += 1; } } as unknown as CatalogRepository,
    createCache({ ttl: 30_000 }));
  const controller = new CatalogController(service);
  for (const tag of ['not-json', 'null', JSON.stringify({ name: 'region', value: null })]) {
    await assert.rejects(async () => controller.getFacets({ tag }), { code: 'INVALID_FILTER' });
  }
  await assert.rejects(async () => controller.getFacets({ warrantyDaysMin: '0' }), { code: 'INVALID_WARRANTY_DAYS' });
  assert.equal(reads, 0);
});

test('catalog controller preserves detail pagination and purchase filters from URL query values', async () => {
  let actual: CatalogQuery | undefined;
  const service = new CatalogService(
    { search: async (query: CatalogQuery) => { actual = query; return { items: [], total: 0, platformFacets: [] }; } } as unknown as CatalogRepository,
    createCache({ ttl: 30_000 }),
  );
  await new CatalogController(service).getCatalog({
    standardProductId: '42', detailKind: 'shops', detailPage: '2', detailPageSize: '3',
    platform: ' OpenAI ', q: 'Plus', tag: JSON.stringify({ name: 'region', value: 'us' }), warrantyDaysMin: '30',
  });
  assert.deepEqual(actual, {
    standardProductId: '42', detailKind: 'shops', detailPage: 2, detailPageSize: 3,
    platform: 'openai', search: 'plus', tags: [{ name: 'region', value: 'us' }], warrantyDaysMin: 30, limit: 20,
  });
});

test('catalog controller rejects malformed and repeated detail query values before reading data', async () => {
  let reads = 0;
  const service = new CatalogService({
    search: async () => { reads += 1; return { items: [], total: 0, platformFacets: [] }; },
  } as unknown as CatalogRepository, createCache({ ttl: 30_000 }));
  const controller = new CatalogController(service);
  const base = { standardProductId: '42', detailKind: 'offers' };
  for (const query of [
    ...['', ' ', '-1', '+1', '1.0', '1e1', '01', 'Infinity', 'NaN', '9007199254740992', ['0', '1'], {}, null].map(detailPage => ({ ...base, detailPage })),
    ...['', '0', '51', '2.5', ['4', '5'], {}, null].map(detailPageSize => ({ ...base, detailPageSize })),
    ...['', 'invalid', ['offers', 'shops'], {}, null].map(detailKind => ({ ...base, detailKind })),
    { ...base, standardProductId: ['42', '43'] },
    { standardProductId: '42', detailPage: '1' }, { detailKind: 'offers' },
  ]) {
    await assert.rejects(async () => controller.getCatalog(query), { code: 'INVALID_DETAIL_QUERY' });
  }
  assert.equal(reads, 0);
});

test('catalog and facets normalize shop and monetary filters with an explicit currency scope', async () => {
  const actual: unknown[] = [];
  const service = new CatalogService({
    search: async (query: unknown) => { actual.push(query); return { items: [], total: 0, platformFacets: [] }; },
    facets: async (query: unknown) => { actual.push(query); return { tagFacets: [] }; },
  } as unknown as CatalogRepository, createCache({ ttl: 30_000 }));
  const controller = new CatalogController(service);
  const filters = { standardProductId: '42', shopQuery: '  Ｓｈｏｐ％＿  ', shopId: '9223372036854775807', priceMin: '9', priceMax: '10.5' };
  await controller.getCatalog({ ...filters, detailKind: 'offers', offerSort: 'priceDesc' });
  await controller.getFacets(filters);
  const normalized = { standardProductId: '42', shopQuery: 'Shop%_', shopId: '9223372036854775807', priceMin: '9.00', priceMax: '10.50', currency: 'CNY', tags: [] };
  assert.deepEqual(actual, [
    { ...normalized, detailKind: 'offers', detailPage: 0, detailPageSize: 4, offerSort: 'priceDesc', limit: 20 },
    normalized,
  ]);
  await controller.getCatalog({ priceMin: '0', priceMax: '999999999999.99', currency: 'USD', offerSort: 'updated' });
  assert.deepEqual(actual[2], { priceMin: '0.00', priceMax: '999999999999.99', currency: 'USD', offerSort: 'updated', tags: [], limit: 20 });
});

test('both catalog endpoints reject malformed and repeated shop and price parameters before database reads', async () => {
  let reads = 0;
  const service = new CatalogService({
    search: async () => { reads += 1; return { items: [], total: 0, platformFacets: [] }; },
    facets: async () => { reads += 1; return { tagFacets: [] }; },
  } as unknown as CatalogRepository,
    createCache({ ttl: 30_000 }));
  const controller = new CatalogController(service);
  const malformed: [string, unknown, string][] = [
    ...[['one', 'two'], {}, null, 2, 'x'.repeat(101)].map(value => ['shopQuery', value, 'INVALID_SHOP_QUERY'] as [string, unknown, string]),
    ...['', '0', '-1', '1.0', '1e1', '01', '9223372036854775808', ['1', '2'], {}, null].map(value => ['shopId', value, 'INVALID_SHOP'] as [string, unknown, string]),
    ...['priceMin', 'priceMax'].flatMap(key => ['', ' ', '-1', '+1', '.5', '1.', '01', '1e2', '1.001', '1000000000000', 'NaN', 'Infinity', ['1', '2'], {}, null]
      .map(value => [key, value, 'INVALID_PRICE_RANGE'] as [string, unknown, string])),
    ...['', 'cny', ' CNY ', 'CN', 'CNYX', ['CNY', 'USD'], {}, null].map(value => ['currency', value, 'INVALID_CURRENCY'] as [string, unknown, string]),
    ...['', 'default', 'invalid', ['price', 'updated'], {}, null].map(value => ['offerSort', value, 'INVALID_OFFER_SORT'] as [string, unknown, string]),
    ...['', 'intent', ['literal', 'literal'], {}, null].map(value => ['searchMode', value, 'INVALID_SEARCH_MODE'] as [string, unknown, string]),
    ...[['1', '2'], {}, null].map(value => ['standardProductId', value, 'INVALID_STANDARD_PRODUCT'] as [string, unknown, string]),
  ];
  for (const method of ['getCatalog', 'getFacets'] as const) {
    for (const [key, value, code] of malformed) await assert.rejects(async () => controller[method]({ [key]: value }), { code }, `${method}: ${key}=${JSON.stringify(value)}`);
    await assert.rejects(async () => controller[method]({ priceMin: '10', priceMax: '9.99' }), { code: 'INVALID_PRICE_RANGE' });
  }
  assert.equal(reads, 0);
});

test('literal detail search preserves purchase words in shop names for lists and facets', async () => {
  const actual: CatalogQuery[] = [];
  const service = new CatalogService({
    search: async (query: CatalogQuery) => { actual.push(query); return { items: [], total: 0, platformFacets: [] }; },
    facets: async (query: CatalogQuery) => { actual.push(query); return { tagFacets: [] }; },
  } as unknown as CatalogRepository, createCache());
  const controller = new CatalogController(service);
  const filters = { standardProductId: '42', q: '星河代充 独享', searchMode: 'literal', currency: 'CNY' };
  await controller.getCatalog({ ...filters, detailKind: 'offers' });
  await controller.getFacets(filters);
  assert.equal(actual.length, 2);
  for (const query of actual) {
    assert.equal(query.search, '星河代充 独享');
    assert.deepEqual(query.tags, []);
  }
  await controller.getCatalog({ q: '星河代充 独享' });
  assert.ok(actual[2]!.tags.some(tag => tag.name === 'delivery' && tag.value === 'top_up'));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createCache } from '../src/cache/cache.js';
import { CatalogService, normalizeCatalogQuery, type CatalogQueryInput } from '../src/catalog/catalog.service.js';
import type { CatalogFacets, CatalogPage, CatalogQuery, CatalogRepository } from '../src/catalog/catalog.repository.js';

const emptyPage = { items: [], platformFacets: [], total: 0 };

test('rental and all four membership kinds pass catalog validation without changing newcomer scope', () => {
  assert.deepEqual(normalizeCatalogQuery({ membershipKind: 'rental', newcomer: true }),
    { membershipKinds: ['rental'], newcomer: true, tags: [], limit: 20 });
  const kinds = ['account', 'top_up', 'rental', 'short_term'];
  assert.deepEqual(normalizeCatalogQuery({ membershipKinds: kinds }).membershipKinds, [...kinds].sort());
  for (const membershipKinds of [[], ['unknown'], [...kinds, 'rental']]) {
    assert.throws(() => normalizeCatalogQuery({ membershipKinds }), { code: 'INVALID_MEMBERSHIP_KIND' });
  }
});

test('rental search terms infer AI membership while keeping literal and negated terms literal', () => {
  for (const term of ['租号', '共享', '合租']) {
    const query = normalizeCatalogQuery({ q: `ChatGPT ${term}`, newcomer: true });
    assert.deepEqual(query.membershipSearch?.kinds, ['rental']);
    assert.deepEqual(query.membershipSearch?.terms, [term]);
    assert.equal(query.membershipSearch?.access, term !== '租号' ? true : undefined);
    const explicit = normalizeCatalogQuery({ q: `ChatGPT ${term}`, tags: [{ name: 'access', value: 'dedicated' }] });
    assert.equal(explicit.membershipSearch?.access, undefined);
    assert.deepEqual(explicit.tags, [{ name: 'access', value: 'dedicated' }]);
    const literal = normalizeCatalogQuery({ q: `ChatGPT ${term}`, searchMode: 'literal' });
    assert.equal(literal.membershipSearch, undefined);
    assert.equal(literal.search, `ChatGPT ${term}`);
    assert.deepEqual(literal.tags, []);
    for (const phrase of [
      ...['不要', '不需要', '不是', '非', '不接受', '不想要', '不支持', '无需', '是否', '不确定', '没有', '未明确', '未说明'].map(prefix => `${prefix}${term}`),
      ...['未说明', '未知', '不支持', '不保证', '不确定', '状态未知', '状态未说明', '状态不确定'].map(suffix => `${term}${suffix}`),
    ]) {
      const negated = normalizeCatalogQuery({ q: `ChatGPT ${phrase}` });
      assert.equal(negated.membershipSearch, undefined);
      assert.ok(negated.search?.includes(phrase));
      assert.deepEqual(negated.tags, []);
    }
  }
});

test('uncertain compound rental labels and mixed negated category searches remain literal', () => {
  for (const q of ['租号（共享）未说明', '不接受租号(共享)', '租号 ( 合租 )未知', '共享但不要代充', '不要成品号，租号',
    '没有租号（共享）', '租号(共享)状态未知', '租号 ( 合租 ) 状态 未说明']) {
    const query = normalizeCatalogQuery({ q });
    assert.equal(query.membershipSearch, undefined, q);
    assert.equal(query.search, q.normalize('NFKC'), q);
    assert.deepEqual(query.tags, [], q);
  }
});

test('compound rental normalization retains dedicated access alongside the shared alias', () => {
  const query = normalizeCatalogQuery({ q: 'ChatGPT Plus 租号（共享） 独享', newcomer: true });
  assert.deepEqual(query.tags, [{ name: 'access', value: 'dedicated' }, { name: 'access', value: 'shared' }]);
  assert.equal(query.membershipSearch?.access, true);
  assert.deepEqual(query.membershipSearch?.kinds, ['rental']);
});

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

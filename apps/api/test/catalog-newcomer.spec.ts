import assert from 'node:assert/strict';
import test from 'node:test';
import { createCache } from '../src/cache/cache.js';
import { CatalogController } from '../src/catalog/catalog.controller.js';
import { CatalogService, normalizeCatalogQuery } from '../src/catalog/catalog.service.js';
import type { CatalogQuery, CatalogRepository } from '../src/catalog/catalog.repository.js';

test('newcomer mode is explicit and does not replace stricter purchase filters', () => {
  const input = { tag: [{ name: 'bulk_purchase', value: 'supported' }] };
  assert.deepEqual(normalizeCatalogQuery({ ...input, newcomer: 'true' }), {
    tags: input.tag, newcomer: true, limit: 20,
  });
  assert.deepEqual(normalizeCatalogQuery({ newcomer: 'false' }), normalizeCatalogQuery({}));
  assert.deepEqual(normalizeCatalogQuery({ newcomer: true }), normalizeCatalogQuery({ newcomer: 'true' }));
});

test('membership kinds have an explicit validated interface independent of purchase tags', () => {
  assert.deepEqual(normalizeCatalogQuery({ membershipKind: ['top_up', 'account', 'top_up'],
    tag: { name: 'access_channel', value: 'web' }, newcomer: true }), {
    membershipKinds: ['account', 'top_up'], tags: [{ name: 'access_channel', value: 'web' }], newcomer: true, limit: 20,
  });
  assert.deepEqual(normalizeCatalogQuery({ membershipKinds: ['short_term'] }).membershipKinds, ['short_term']);
  for (const membershipKind of ['', 'all', 'account,top_up', [], ['account', 'invalid'], null, {}, true]) {
    assert.throws(() => normalizeCatalogQuery({ membershipKind }), { code: 'INVALID_MEMBERSHIP_KIND' });
  }
  assert.throws(() => normalizeCatalogQuery({ membershipKind: 'account', membershipKinds: ['top_up'] }),
    { code: 'INVALID_MEMBERSHIP_KIND' });
});

test('HTTP catalog and facets forward the same membership kind scope', async () => {
  const queries: CatalogQuery[] = [];
  const cache = createCache();
  const controller = new CatalogController(new CatalogService({
    search: async (query: CatalogQuery) => { queries.push(query); return { items: [], total: 0, platformFacets: [] }; },
    facets: async (query: CatalogQuery) => { queries.push(query); return { tagFacets: [] }; },
  } as unknown as CatalogRepository, cache));
  try {
    await controller.getCatalog({ membershipKind: ['account', 'top_up'], newcomer: 'true' });
    await controller.getFacets({ membershipKind: ['account', 'top_up'], newcomer: 'true' });
    assert.equal(queries.length, 2);
    assert.ok(queries.every(query => JSON.stringify(query.membershipKinds) === '["account","top_up"]'));
    await assert.rejects(async () => controller.getFacets({ membershipKind: 'all' }), { code: 'INVALID_MEMBERSHIP_KIND' });
  } finally { await cache.disconnect(); }
});

test('both catalog endpoints validate newcomer mode before reading data', async () => {
  const queries: CatalogQuery[] = [];
  const cache = createCache();
  const controller = new CatalogController(new CatalogService({
    search: async (query: CatalogQuery) => { queries.push(query); return { items: [], total: 0, platformFacets: [] }; },
    facets: async (query: CatalogQuery) => { queries.push(query); return { tagFacets: [] }; },
  } as unknown as CatalogRepository, cache));
  try {
    await controller.getCatalog({ newcomer: 'true' });
    await controller.getFacets({ newcomer: 'true' });
    assert.equal(queries.length, 2);
    assert.ok(queries.every(query => query.newcomer === true));
    for (const newcomer of ['', '1', 'yes', ['true', 'false'], {}, null]) {
      await assert.rejects(async () => controller.getCatalog({ newcomer }), { code: 'INVALID_NEWCOMER_MODE' });
      await assert.rejects(async () => controller.getFacets({ newcomer }), { code: 'INVALID_NEWCOMER_MODE' });
    }
    assert.equal(queries.length, 2);
  } finally { await cache.disconnect(); }
});

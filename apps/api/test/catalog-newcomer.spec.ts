import assert from 'node:assert/strict';
import test from 'node:test';
import { createCache } from '../src/cache/cache.js';
import { CatalogController } from '../src/catalog/catalog.controller.js';
import { CatalogService, normalizeCatalogQuery } from '../src/catalog/catalog.service.js';
import type { CatalogQuery, CatalogRepository } from '../src/catalog/catalog.repository.js';

test('newcomer mode is explicit and does not replace stricter purchase filters', () => {
  const input = { tag: [{ name: 'delivery', value: 'top_up' }], warrantyDaysMin: 90 };
  assert.deepEqual(normalizeCatalogQuery({ ...input, newcomer: 'true' }), {
    tags: input.tag, warrantyDaysMin: 90, newcomer: true, limit: 20,
  });
  assert.deepEqual(normalizeCatalogQuery({ newcomer: 'false' }), normalizeCatalogQuery({}));
  assert.deepEqual(normalizeCatalogQuery({ newcomer: true }), normalizeCatalogQuery({ newcomer: 'true' }));
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

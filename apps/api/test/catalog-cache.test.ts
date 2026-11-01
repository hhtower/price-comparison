import assert from 'node:assert/strict';
import test from 'node:test';
import { createCache } from '../src/cache/cache.js';
import { CatalogService } from '../src/catalog/catalog.service.js';
import type { CatalogRepository } from '../src/catalog/catalog.repository.js';

test('equivalent catalog searches share one read and expire five seconds from its start', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: 10_000 });
  let reads = 0;
  const cache = createCache();
  const service = new CatalogService({ search: async () => {
    reads++;
    context.mock.timers.tick(1_000);
    return { items: [], platformFacets: [], total: reads, nextExpiryAt: new Date(0).toISOString() };
  } } as unknown as CatalogRepository, cache);
  try {
    const results = await Promise.all([service.getCatalog({ q: ' Plus ' }), service.getCatalog({ search: 'plus', sort: 'default' })]);
    assert.deepEqual(results.map(result => result.total), [1, 1]);
    assert.equal(reads, 1, 'expired observation metadata never retries the query');
    context.mock.timers.tick(3_999);
    assert.equal((await service.getCatalog({ q: 'plus' })).total, 1);
    context.mock.timers.tick(1);
    assert.equal((await service.getCatalog({ q: 'plus' })).total, 2);
    assert.equal((await service.getCatalog({ q: 'claude' })).total, 3);
  } finally { await cache.disconnect(); }
});

test('slow loads and failed loads do not create a renewed five-second cache window', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: 10_000 });
  let reads = 0;
  const cache = createCache();
  const service = new CatalogService({ search: async () => {
    reads++;
    if (reads === 2) throw new Error('offline');
    context.mock.timers.tick(5_001);
    return { items: [], platformFacets: [], total: reads };
  } } as unknown as CatalogRepository, cache);
  try {
    assert.equal((await service.getCatalog({})).total, 1);
    await assert.rejects(service.getCatalog({}), /offline/);
    assert.equal((await service.getCatalog({})).total, 3);
  } finally { await cache.disconnect(); }
});

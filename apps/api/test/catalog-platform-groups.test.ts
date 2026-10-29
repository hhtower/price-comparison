import assert from 'node:assert/strict';
import test from 'node:test';
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery } from 'kysely';
import { CatalogRepository } from '../src/catalog/catalog.repository.js';
import type { DatabaseSchema } from '../src/database/types.js';
import * as platformGroups from '@price-comparison/catalog/platform-groups';
const { CATALOG_PLATFORMS, groupCatalogPlatforms } = platformGroups;

test('replaces Microsoft and Apple navigation with IP while preserving email grouping', () => {
  assert.equal(CATALOG_PLATFORMS.find(group => group.id === 'ip')?.label, 'IP');
  assert.deepEqual(groupCatalogPlatforms(['Microsoft', 'Apple', 'Office', 'Bing', '苹果', ' IP ', 'Proxy', '代理 IP', '住宅IP', 'Gmail', 'Outlook']),
    ['ip', 'email', 'other']);
});

test('Grok, X and Cursor share navigation and normalize old platform links', () => {
  assert.equal(CATALOG_PLATFORMS.find(group => group.id === 'xai')?.label, 'Grok / X / Cursor');
  assert.equal(CATALOG_PLATFORMS.some(group => String(group.id) === 'x'), false);
  assert.equal(CATALOG_PLATFORMS.some(group => String(group.id) === 'cursor'), false);
  assert.equal(CATALOG_PLATFORMS.some(group => group.id === 'github'), false);
  assert.deepEqual(groupCatalogPlatforms(['Grok', 'xai', 'x', 'Twitter', 'X/Twitter', 'Cursor', 'github']), ['xai', 'other']);
  for (const platform of ['xai', 'Grok', 'x', 'twitter', ' Cursor ']) {
    assert.equal(platformGroups.normalizeCatalogPlatform(platform), 'xai');
  }
});

test('recognizes IP product identities without matching accounts, scripts or API reverse proxies', () => {
  const pattern = new RegExp(platformGroups.CATALOG_IP_PRODUCT_PATTERN);
  for (const product of ['ip', 'residential_ip', 'dynamic-ip', 'ip_proxy']) assert.match(product, pattern);
  for (const product of ['chatgpt', 'script', 'subscription', 'stripe', 'cliproxy', 'reverse_proxy']) assert.doesNotMatch(product, pattern);
});

test('catalog lists, summaries and facets filter the IP group using canonical product identity', async () => {
  const queries: CompiledQuery[] = [];
  class Driver extends DummyDriver {
    async acquireConnection(): Promise<any> {
      return { executeQuery: async (query: CompiledQuery) => {
        queries.push(query);
        return { rows: [{ entries: [], platform_facets: [], total: 0, offer_total: 0, tag_facets: [], next_expiry_at: null }] };
      } };
    }
  }
  const db = new Kysely<DatabaseSchema>({ dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new Driver(),
    createIntrospector: database => new PostgresIntrospector(database),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  } });
  try {
    const repository = new CatalogRepository(db);
    await repository.search({ platform: 'ip', tags: [] });
    await repository.search({ platform: 'ip', tags: [], view: 'summary' });
    await repository.facets({ platform: 'ip', tags: [] });
    const reads = queries.filter(query => query.sql.includes('as platform_group'));
    assert.equal(reads.length, 3);
    for (const query of reads) {
      const identity = query.sql.match(/when lower\(coalesce\(sp\.canonical_product, ''\)\) ~ \$(\d+) then 'ip'/u);
      assert.ok(identity, 'IP classification must use the standard product identity');
      assert.equal(query.parameters[Number(identity[1]) - 1], platformGroups.CATALOG_IP_PRODUCT_PATTERN);
      const filter = query.sql.match(/sp\.platform_group = \$(\d+)/u);
      assert.ok(filter, 'IP requests must select the group, not just a raw platform named ip');
      assert.equal(query.parameters[Number(filter[1]) - 1], 'ip');
    }
  } finally {
    await db.destroy();
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery } from 'kysely';
import { CatalogRepository } from '../src/catalog/catalog.repository.js';
import type { DatabaseSchema } from '../src/database/types.js';
import { matchesRequestedProduct } from '../src/assistant/assistant-candidates.js';
import { emptyShoppingNeeds } from '@price-comparison/catalog/assistant-contract';

test('all product metadata reads retain identities used for matching translated and renamed products', async () => {
  let row = { id: '42', name: 'openai / chatgpt / business', platform: 'OpenAI', platform_group: 'openai',
    family: 'openai', product: 'chatgpt', tier: 'business', aliases: ['ChatGPT 企业版'], merged_into_id: null };
  class Driver extends DummyDriver {
    async acquireConnection(): Promise<any> {
      return { executeQuery: async (query: CompiledQuery) => {
        assert.match(query.sql, /sp\.aliases/u);
        return { rows: [row] };
      } };
    }
  }
  const db = new Kysely<DatabaseSchema>({ dialect: {
    createAdapter: () => new PostgresAdapter(), createDriver: () => new Driver(),
    createIntrospector: database => new PostgresIntrospector(database),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  } });
  try {
    const repository = new CatalogRepository(db);
    for (const sample of [
      { name: row.name, tier: 'business', alias: 'ChatGPT 企业版', requested: 'ChatGPT Business', display: 'ChatGPT 商业版' },
      { name: 'ChatGPT Pro 5x', tier: 'pro_5x', alias: 'ChatGPT Pro 100', requested: 'ChatGPT Pro 5x', display: 'ChatGPT Pro 100' },
    ]) {
      row = { ...row, name: sample.name, tier: sample.tier, aliases: [sample.alias] };
      for (const product of [(await repository.publicProducts()).items[0], await repository.publicProduct('42'),
        await repository.resolvePublicProductIdentity({ platform: 'openai', product: 'chatgpt', tier: sample.tier })]) {
        assert.ok(product);
        assert.equal(product.name, sample.display);
        for (const requested of [sample.requested, sample.alias]) {
          assert.equal(matchesRequestedProduct(product, { ...emptyShoppingNeeds(), product: requested }), true, requested);
        }
        assert.equal(matchesRequestedProduct(product, { ...emptyShoppingNeeds(), product: 'ChatGPT Plus' }), false);
      }
    }
  } finally {
    await db.destroy();
  }
});

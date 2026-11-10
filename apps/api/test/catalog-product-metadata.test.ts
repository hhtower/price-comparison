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
      { family: 'openai', product: 'chatgpt', name: row.name, tier: 'business', alias: 'ChatGPT 企业版', requested: 'ChatGPT Business', display: 'ChatGPT 商业版' },
      { family: 'openai', product: 'chatgpt', name: 'ChatGPT Pro 5x', tier: 'pro_5x', alias: 'ChatGPT Pro 100', requested: 'ChatGPT Pro 5x', display: 'ChatGPT Pro 100' },
      { family: 'openai', product: 'chatgpt', name: 'ChatGPT Team 5x', tier: 'team_5x', alias: 'ChatGPT Team 10x', requested: 'ChatGPT Premium', display: 'ChatGPT Premium' },
      { family: 'openai', product: 'chatgpt', name: 'ChatGPT Premium', tier: 'team_5x', alias: 'ChatGPT Business Premium', requested: 'ChatGPT Team 5x', display: 'ChatGPT Premium' },
      { family: 'anthropic', product: 'claude', name: 'Claude Max 20x', tier: 'max_20x', alias: 'Claude Ultra', requested: 'Claude Max 20x', display: 'Claude Ultra' },
      { family: 'anthropic', product: 'claude', name: 'Claude Ultra', tier: 'max_20x', alias: 'Claude Ultra 10x', requested: 'Claude Max 20x', display: 'Claude Ultra' },
      { family: 'anthropic', product: 'claude', name: 'Claude Team 5x', tier: 'team_5x', alias: 'Claude Team Premium', requested: 'Claude Team 5x', display: 'Claude Team Premium' },
    ]) {
      row = { ...row, family: sample.family, product: sample.product, name: sample.name, tier: sample.tier, aliases: sample.family === 'anthropic' || sample.tier === 'team_5x' ? [] : [sample.alias] };
      for (const product of [(await repository.publicProducts()).items[0], await repository.publicProduct('42'),
        await repository.resolvePublicProductIdentity({ platform: sample.family, product: sample.product, tier: sample.tier })]) {
        assert.ok(product);
        assert.equal('membershipKind' in product, false, 'membership features belong to offers, never standard identities');
        assert.equal('splitInto' in product, false);
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

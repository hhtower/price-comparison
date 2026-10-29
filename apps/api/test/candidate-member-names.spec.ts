import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery } from 'kysely';
import type { DatabaseSchema } from '../src/database/types.js';
import { recordCandidateCatalogChanges } from '../src/catalog/catalog-version.repository.js';
import { VersionedCandidateIndex } from '../src/standardization/versioned-candidate-index.js';
import type { CandidateDocument } from '../src/standardization/candidate-index.js';
import { buildCanonicalStandardKey } from '../src/standardization/canonical-key.js';

function fixture(memberNames: Array<{ standard_product_id: bigint; member_names: string[] }>, standards = [
  { id: 1n, name: 'software / yunfan_protocol_card / standard', canonical_family: 'software', canonical_product: 'yunfan_protocol_card', canonical_tier: 'standard' },
  { id: 2n, name: 'software / mofang_card / standard', canonical_family: 'software', canonical_product: 'mofang_card', canonical_tier: 'standard' },
]) {
  let documents: CandidateDocument[] = [];
  const queries: CompiledQuery[] = [];
  class Driver extends DummyDriver {
    async acquireConnection() {
      return {
        async executeQuery(query: CompiledQuery) {
          queries.push(query);
          let rows: unknown[] = [];
          if (query.sql.includes('member_names')) rows = memberNames;
          else if (query.sql.includes('update standardization_catalog_versions')) rows = [{ version: 2n, alias_policy_version: 'test' }];
          else if (query.sql.includes('from "standard_products" as "sp"')) {
            rows = standards.map(s => ({ ...s, verification_state: 'verified', merged_into_id: null, has_published_member: true }));
          } else if (query.sql.startsWith('insert into "catalog_index_changes"')) {
            documents = query.parameters.filter((value): value is string => typeof value === 'string' && value.startsWith('{')).map(value => JSON.parse(value));
          }
          return { rows, numAffectedRows: 1n };
        },
      };
    }
  }
  const database = new Kysely<DatabaseSchema>({ dialect: {
    createAdapter: () => new PostgresAdapter(), createDriver: () => new Driver(),
    createIntrospector: db => new PostgresIntrospector(db), createQueryCompiler: () => new PostgresQueryCompiler(),
  } });
  return { database, queries, documents: () => documents };
}

test('incremental candidate documents recall Chinese member names without promoting them to confirmed aliases', async () => {
  const f = fixture([
    { standard_product_id: 1n, member_names: ['云帆(小美协议)天卡'] },
    { standard_product_id: 2n, member_names: ['魔方周卡(顺丰+美团AI智能助手)'] },
  ]);
  try {
    await recordCandidateCatalogChanges(f.database, [1n, 2n], 'test');
    const documents = f.documents();
    const index = VersionedCandidateIndex.build({ version: 2n, aliasPolicyVersion: 'test', documents });
    for (const [name, id] of [['云帆(小美协议)天卡', '1'], ['魔方周卡(顺丰+美团AI智能助手)', '2']]) {
      const result = index.search({ text: name, primaryText: name });
      const candidate = result.candidates.find(c => c.id === id);
      assert.ok(candidate, `missing ${name}`);
      assert.equal(candidate.routes.includes('alias'), false);
      assert.deepEqual(candidate.aliases, []);
      assert.ok(result.stats.scanned <= 2000 && result.stats.compared <= 400 && result.candidates.length <= 20);
    }
  } finally { await f.database.destroy(); }
});

test('shared member names recall distinct brands and tiers without alias ownership or identity folding', async () => {
  const f = fixture([
    { standard_product_id: 1n, member_names: ['共享助手周卡'] },
    { standard_product_id: 2n, member_names: ['共享助手周卡'] },
    { standard_product_id: 3n, member_names: ['共享助手周卡'] },
  ], [
    { id: 1n, name: 'first / assistant / pro', canonical_family: 'first', canonical_product: 'assistant', canonical_tier: 'pro' },
    { id: 2n, name: 'second / assistant / pro', canonical_family: 'second', canonical_product: 'assistant', canonical_tier: 'pro' },
    { id: 3n, name: 'first / assistant / vip', canonical_family: 'first', canonical_product: 'assistant', canonical_tier: 'vip' },
  ]);
  try {
    await recordCandidateCatalogChanges(f.database, [1n, 2n, 3n], 'test');
    const documents = f.documents();
    const index = VersionedCandidateIndex.build({ version: 2n, aliasPolicyVersion: 'test', documents });
    const result = index.search({ text: '共享助手周卡' });
    assert.deepEqual(new Set(result.candidates.map(c => c.id)), new Set(['1', '2', '3']));
    assert.ok(result.candidates.every(c => !c.routes.includes('alias')));
    assert.equal(new Set(documents.map(buildCanonicalStandardKey)).size, 3);
  } finally { await f.database.destroy(); }
});

test('member name hints are normalized and capped while excluding source bodies from documents', async () => {
  const f = fixture([{ standard_product_id: 1n, member_names: [
    '', '---', '  云帆  天卡 ', '云帆 天卡',
    ...Array.from({ length: 20 }, (_, i) => `云帆规格${String(i).padStart(2, '0')}`),
  ] }]);
  try {
    await recordCandidateCatalogChanges(f.database, [1n], 'test');
    const document = f.documents()[0]!;
    assert.ok(document.displayName?.includes('云帆 天卡'));
    assert.equal(document.displayName?.match(/云帆 天卡/g)?.length, 1);
    assert.ok(document.displayName?.includes('云帆规格10'));
    assert.equal(document.displayName?.includes('云帆规格11'), false, 'retain at most twelve distinct names');
    assert.deepEqual(document.aliases, []);
    assert.equal(f.queries.some(q => /source_data|description|evidence/.test(q.sql)), false);
  } finally { await f.database.destroy(); }
});

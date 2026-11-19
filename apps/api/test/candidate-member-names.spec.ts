import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery } from 'kysely';
import type { DatabaseSchema } from '../src/database/types.js';
import { recordCandidateCatalogChanges } from '../src/catalog/catalog-version.repository.js';
import { VersionedCandidateIndex } from '../src/standardization/versioned-candidate-index.js';
import type { CandidateDocument } from '../src/standardization/candidate-index.js';

function fixture(memberNames: Array<{ standard_product_id: bigint; member_names: string[] }>, standards = [
  { id: 1n, name: 'software / yunfan_protocol_card / standard', canonical_family: 'software', canonical_product: 'yunfan_protocol_card', canonical_tier: 'standard' },
  { id: 2n, name: 'software / mofang_card / standard', canonical_family: 'software', canonical_product: 'mofang_card', canonical_tier: 'standard' },
], definition: string | null = 'Approved product definition') {
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
            rows = standards.map(s => ({ ...s, verification_state: 'verified', merged_into_id: null, catalog_definition: definition }));
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

test('approved candidate definitions remain searchable without historical member names or published offers', async () => {
  const f = fixture([
    { standard_product_id: 1n, member_names: ['Wrong previous classification'] },
    { standard_product_id: 2n, member_names: ['Wrong previous classification'] },
  ]);
  try {
    await recordCandidateCatalogChanges(f.database, [1n, 2n], 'test');
    const documents = f.documents();
    assert.equal(documents.length, 2);
    assert.deepEqual(documents.map(document => document.displayName), [
      'software / yunfan_protocol_card / standard', 'software / mofang_card / standard',
    ]);
    assert.doesNotMatch(JSON.stringify(documents), /Wrong previous classification/);
    assert.ok(documents.every(document => document.definition === 'Approved product definition'));
    const index = VersionedCandidateIndex.build({ version: 2n, aliasPolicyVersion: 'test', documents });
    assert.ok(index.search({ text: 'yunfan_protocol_card' }).candidates.some(candidate => candidate.id === '1'));
    assert.equal(f.queries.some(query => /standard_product_members|member_names/.test(query.sql)), false);
  } finally { await f.database.destroy(); }
});

test('legacy verified standards without approved definitions are absent from the candidate catalog', async () => {
  const f = fixture([], undefined, null);
  try {
    await recordCandidateCatalogChanges(f.database, [1n, 2n], 'test');
    assert.deepEqual(f.documents(), []);
  } finally { await f.database.destroy(); }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery, type DatabaseConnection } from 'kysely';
import type { DatabaseSchema } from '../src/database/types.js';
import { recordCandidateCatalogChanges } from '../src/catalog/catalog-version.repository.js';
import { loadCatalogAliases, relatedCatalogAliasOwners } from '../src/standardization/catalog-aliases.js';

interface Standard {
  id: bigint;
  aliases: string[];
  active: boolean;
}

function fixture(standards: Standard[]) {
  const queries: CompiledQuery[] = [];
  let aliasRowsTransferred = 0;
  let documents: Array<{ id: string; aliases: string[] }> = [];
  class Driver extends DummyDriver {
    async acquireConnection(): Promise<DatabaseConnection> {
      return {
        async executeQuery<R>(query: CompiledQuery) {
          queries.push(query);
          let rows: unknown[] = [];
          if (query.sql.includes('as member_names')) rows = [];
          else if (query.sql.includes('as standard_product_id') && query.sql.includes('as active')) {
            assert.match(query.sql, /select sp\.id as standard_product_id, sp\.aliases,/);
            assert.match(query.sql, /where sp\.aliases <> '\{\}'::text\[\]/);
            const gated = query.sql.includes('exists');
            if (gated) {
              assert.match(query.sql, /where target\.id in \(/);
              assert.match(query.sql, /and target\.aliases <> '\{\}'::text\[\]/);
            }
            const hasTargetAliases = standards.some(s => query.parameters.includes(s.id) && s.aliases.length);
            const selected = !gated || hasTargetAliases ? standards.filter(s => s.aliases.length) : [];
            rows = selected.map(s => ({ standard_product_id: s.id, aliases: s.aliases, active: s.active }));
            aliasRowsTransferred += rows.length;
          } else if (query.sql.includes('update standardization_catalog_versions')) {
            rows = [{ version: 2n, alias_policy_version: 'test' }];
          } else if (query.sql.includes('from "standardization_catalog_versions"')) {
            rows = [{ version: 1n, alias_policy_version: 'test' }];
          } else if (query.sql.includes('from "standard_products" as "sp"')) {
            rows = standards.filter(s => query.parameters.includes(s.id)).map(s => ({
              id: s.id, name: `Standard ${s.id}`, canonical_family: 'family',
              canonical_product: `product${s.id}`, canonical_tier: 'standard',
              verification_state: s.active ? 'verified' : 'quarantined',
              merged_into_id: null, has_published_member: true,
            }));
          } else if (query.sql.startsWith('insert into "catalog_index_changes"')) {
            documents = query.parameters.filter((v): v is string => typeof v === 'string' && v.startsWith('{')).map(v => JSON.parse(v));
          }
          return { rows: rows as R[], numAffectedRows: 1n };
        },
        async *streamQuery<R>(): AsyncIterableIterator<{ rows: R[] }> { throw new Error('Unexpected streaming query in catalog alias test'); },
      };
    }
  }
  const database = new Kysely<DatabaseSchema>({ dialect: {
    createAdapter: () => new PostgresAdapter(), createDriver: () => new Driver(),
    createIntrospector: db => new PostgresIntrospector(db), createQueryCompiler: () => new PostgresQueryCompiler(),
  } });
  return { database, queries, documents: () => documents,
    aliasQueries: () => queries.filter(q => q.sql.includes('as active')),
    transferred: () => aliasRowsTransferred };
}

test('refreshing a standard without aliases transfers no unrelated aliases and reads the snapshot once', async () => {
  const f = fixture([
    { id: 1n, aliases: [], active: true },
    ...Array.from({ length: 1000 }, (_, i) => ({ id: BigInt(i + 2), aliases: [`Unrelated ${i}`], active: true })),
  ]);
  try {
    const result = await recordCandidateCatalogChanges(f.database, [1n], 'test');
    assert.equal(result.changeCount, 1);
    assert.deepEqual(f.documents().map(d => [d.id, d.aliases]), [['1', []]]);
    assert.equal(f.transferred(), 0, 'unrelated alias rows must stay in the database');
    assert.equal(f.aliasQueries().length, 1);
    assert.deepEqual(f.aliasQueries()[0]!.parameters, [1n]);
  } finally { await f.database.destroy(); }
});

test('one alias snapshot refreshes both ambiguous owners and retains global ambiguity for their other aliases', async () => {
  const f = fixture([
    { id: 1n, aliases: ['Shared X', 'Only First'], active: true },
    { id: 2n, aliases: ['shared-x', 'Shared Y'], active: true },
    { id: 3n, aliases: ['shared-y'], active: true },
    { id: 4n, aliases: ['Unrelated'], active: true },
  ]);
  try {
    const result = await recordCandidateCatalogChanges(f.database, [1n, 1n], 'test');
    assert.equal(result.changeCount, 2, 'related owners are expanded only one hop');
    assert.deepEqual(f.documents().map(d => [d.id, d.aliases]), [['1', ['Only First']], ['2', []]]);
    assert.equal(f.aliasQueries().length, 1);
    assert.equal(f.transferred(), 4, 'the global snapshot must not be loaded twice');
  } finally { await f.database.destroy(); }
});

test('an inactive alias owner still refreshes the active owner and restores its unambiguous alias', async () => {
  const f = fixture([
    { id: 1n, aliases: ['Shared X'], active: false },
    { id: 2n, aliases: ['shared-x'], active: true },
  ]);
  try {
    const result = await recordCandidateCatalogChanges(f.database, [1n], 'test');
    assert.equal(result.changeCount, 2);
    assert.deepEqual(f.documents().map(d => [d.id, d.aliases]), [['2', ['shared-x']]]);
    const insert = f.queries.find(q => q.sql.startsWith('insert into "catalog_index_changes"'))!;
    assert.ok(insert.parameters.includes('isolate'));
    assert.equal(f.aliasQueries().length, 1);
  } finally { await f.database.destroy(); }
});

test('clearing an alias refreshes owners captured before editing and restores the remaining alias', async () => {
  const standards = [
    { id: 1n, aliases: ['Shared X'], active: true },
    { id: 2n, aliases: ['shared-x'], active: true },
  ];
  const f = fixture(standards);
  try {
    const ownersBefore = await relatedCatalogAliasOwners(f.database, [1n]);
    assert.deepEqual(ownersBefore, [1n, 2n]);
    standards[0]!.aliases = [];
    const beforeQueries = f.aliasQueries().length;
    const result = await recordCandidateCatalogChanges(f.database, ownersBefore, 'test');
    assert.equal(result.changeCount, 2);
    assert.deepEqual(f.documents().map(d => [d.id, d.aliases]), [['1', []], ['2', ['shared-x']]]);
    assert.equal(f.aliasQueries().length - beforeQueries, 1);
  } finally { await f.database.destroy(); }
});

test('scoped alias reads preserve global ambiguity and empty scopes avoid alias queries', async () => {
  const f = fixture([
    { id: 1n, aliases: ['Shared X', 'Only First'], active: true },
    { id: 2n, aliases: ['shared-x'], active: true },
  ]);
  try {
    assert.deepEqual((await loadCatalogAliases(f.database, [1n])).map(a => a.alias), ['Only First']);
    assert.equal(f.aliasQueries().length, 1);
    assert.deepEqual(await loadCatalogAliases(f.database, []), []);
    assert.deepEqual(await relatedCatalogAliasOwners(f.database, []), []);
    assert.equal((await recordCandidateCatalogChanges(f.database, [], 'test')).changeCount, 0);
    assert.equal(f.aliasQueries().length, 1);
  } finally { await f.database.destroy(); }
});

test('unscoped alias reads retain normalization and ignore inactive owners', async () => {
  const f = fixture([
    { id: 1n, aliases: ['  Ｓｈａｒｅｄ X ', 'Only\u0000First', 'only-first', '---'], active: true },
    { id: 2n, aliases: ['shared-x'], active: true },
    { id: 3n, aliases: ['only-first', 'Inactive Only'], active: false },
  ]);
  try {
    assert.deepEqual(await loadCatalogAliases(f.database), [
      { standard_product_id: 1n, alias: 'Only First', normalized_alias: 'onlyfirst' },
    ]);
    assert.equal(f.aliasQueries().length, 1);
    assert.deepEqual(f.aliasQueries()[0]!.parameters, []);
  } finally { await f.database.destroy(); }
});

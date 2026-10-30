import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler,
  type CompiledQuery, type DatabaseConnection, type TransactionSettings,
} from 'kysely';
import type { DatabaseSchema } from '../src/database/types.js';
import { reconcileNameConsensus } from '../src/standardization/name-consensus-repair.js';

const member = (id: bigint, standardProductId: bigint) => ({
  id, standard_product_id: standardProductId, name: 'Microsoft Outlook Hotmail OAuth2 account', spec: '',
  source_category: '', source_data: {}, assignment_source: 'ai', standardization_locked: false,
  standardization_revision: 0n, content_version: 1n, content_fingerprint: 'stored-source-hash',
  canonical_family: 'microsoft', canonical_product: 'outlook', canonical_tier: 'standard',
});

function fixture(rows = [member(1n, 1n), member(2n, 2n), member(3n, 2n)], options: {
  afterPreview?: () => void;
  lockError?: Error;
  changedProducts?: boolean;
  changedMemberships?: boolean;
} = {}) {
  const state = {
    rows,
    manual: [] as { product_id: bigint; content_version: bigint; content_fingerprint: string; evidence_known: boolean }[],
    protectedIds: [] as bigint[],
  };
  const transactions: { settings: TransactionSettings; queries: CompiledQuery[]; outcome?: 'commit' | 'rollback' }[] = [];
  let snapshot = structuredClone(state);
  class Driver extends DummyDriver {
    async beginTransaction(_connection?: DatabaseConnection, settings: TransactionSettings = {}) {
      assert.ok(!transactions.length || transactions.at(-1)!.outcome, 'preview must finish before apply starts');
      transactions.push({ settings, queries: [] });
      snapshot = structuredClone(state);
    }
    async commitTransaction() {
      transactions.at(-1)!.outcome = 'commit';
      if (transactions.length === 1) options.afterPreview?.();
    }
    async rollbackTransaction() { transactions.at(-1)!.outcome = 'rollback'; }
    async acquireConnection(): Promise<DatabaseConnection> {
      return {
        async executeQuery<R>(query: CompiledQuery) {
          transactions.at(-1)!.queries.push(query);
          const text = query.sql.trim();
          let result: unknown[];
          if (text.startsWith('lock table')) {
            assert.match(text, /shops, products, standard_products, standard_product_members,\s+catalog_cache_versions, standardization_catalog_versions, catalog_index_changes\s+in exclusive mode nowait$/);
            if (options.lockError) throw options.lockError;
            result = [];
          } else if (text.includes('inner join "standard_products" as "sp"')) result = snapshot.rows;
          else if (text.startsWith('select') && text.includes('from "product_standardization_decisions"')) result = snapshot.manual;
          else if (text.startsWith('select "p"."id" from "products" as "p"')) result = snapshot.protectedIds.map(id => ({ id }));
          else if (text.startsWith('select') && text.includes('from "products" as "p"')) result = [];
          else if (text.startsWith('select') && text.includes('from "products"')) result = snapshot.rows.map(({ id }) => ({ id }));
          else if (text.startsWith('select') && text.includes('from "standard_products"')) result = [];
          else if (text.startsWith('select') && text.includes('from standard_products sp')) result = [];
          else if (text.startsWith('update products p') || text.startsWith('update standard_product_members m')) {
            const changed = text.startsWith('update products p') ? options.changedProducts : options.changedMemberships;
            result = changed ? [] : query.parameters.filter((_, index) => index % 5 === 0)
              .map(id => ({ id, product_id: id }));
          } else if (text.startsWith('update catalog_cache_versions')) result = [{ version: 2n }];
          else if (text.startsWith('update standardization_catalog_versions')) result = [{ version: 2n, alias_policy_version: 'test' }];
          else if (text.startsWith('insert into "catalog_index_changes"')) result = [];
          else throw new Error(`Unexpected repair query: ${text}`);
          return { rows: result as R[] };
        },
        async *streamQuery<R>(): AsyncIterableIterator<{ rows: R[] }> { throw new Error('Unexpected stream'); },
      };
    }
  }
  const db = new Kysely<DatabaseSchema>({ dialect: {
    createAdapter: () => new PostgresAdapter(), createDriver: () => new Driver(),
    createIntrospector: database => new PostgresIntrospector(database), createQueryCompiler: () => new PostgresQueryCompiler(),
  } });
  return { db, state, transactions };
}

test('no-op apply only plans in a read-only repeatable-read transaction without maintenance locks or backup', async t => {
  const f = fixture([member(1n, 1n)]);
  t.after(() => f.db.destroy());
  const result = await reconcileNameConsensus(f.db, { apply: true, beforeApply: async () => assert.fail('no-op backup') });
  assert.deepEqual(result.changes, []);
  assert.equal(f.transactions.length, 1);
  assert.deepEqual(f.transactions[0]!.settings, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  assert.equal(f.transactions[0]!.outcome, 'commit');
  assert.ok(f.transactions[0]!.queries.every(query => query.sql.startsWith('select')));
});

test('explicit preview returns the plan without maintenance locks, backup or writes', async t => {
  const f = fixture();
  t.after(() => f.db.destroy());
  const result = await reconcileNameConsensus(f.db, { apply: false });
  assert.deepEqual(result.changes.map(change => [change.productId, change.toStandardProductId]), [[1n, 2n]]);
  assert.equal(f.transactions.length, 1);
  assert.ok(f.transactions[0]!.queries.every(query => query.sql.startsWith('select')));
});

test('apply replans after preview and uses the current winner, revision and source version for backup and writes', async t => {
  const f = fixture(undefined, { afterPreview: () => {
    f.state.rows[1]!.standard_product_id = 3n;
    f.state.rows[2]!.standard_product_id = 3n;
    f.state.rows[0]!.standardization_revision = 7n;
    f.state.rows[0]!.content_version = 4n;
  } });
  t.after(() => f.db.destroy());
  let backups = 0;
  const result = await reconcileNameConsensus(f.db, { apply: true, beforeApply: async plan => {
    backups++;
    assert.deepEqual(plan.changes.map(change => [change.productId, change.toStandardProductId, change.previousRevision, change.contentVersion]),
      [[1n, 3n, 7n, 4n]]);
    const apply = f.transactions[1]!;
    assert.equal(apply.settings.isolationLevel, 'serializable');
    assert.ok(apply.queries[0]!.sql.startsWith('lock table'));
    assert.ok(apply.queries.some(query => query.sql.includes('inner join "standard_products" as "sp"')));
    assert.ok(apply.queries.at(-1)!.sql.endsWith('for update'));
    assert.ok(!apply.queries.some(query => query.sql.trimStart().startsWith('update')));
  } });
  assert.equal(backups, 1);
  assert.equal(result.changes[0]!.toStandardProductId, 3n);
  assert.deepEqual(f.transactions.map(tx => tx.outcome), ['commit', 'commit']);
  const updates = f.transactions[1]!.queries.filter(query => query.sql.startsWith('update products p') || query.sql.startsWith('update standard_product_members m'));
  assert.equal(updates.length, 2);
  for (const query of updates) assert.deepEqual(query.parameters, [1n, 1n, 3n, 7n, 4n]);
});

for (const protection of ['membership', 'lock', 'human', 'manual', 'review'] as const) {
  test(`apply replans when ${protection} protection changes after preview and skips backup when no changes remain`, async t => {
    const f = fixture(undefined, { afterPreview: () => {
      const row = f.state.rows[0]!;
      if (protection === 'membership') row.standard_product_id = 2n;
      if (protection === 'lock') row.standardization_locked = true;
      if (protection === 'human') row.assignment_source = 'human';
      if (protection === 'review') f.state.protectedIds.push(row.id);
      if (protection === 'manual') {
        row.content_version = 2n;
        row.content_fingerprint = 'new-source-hash';
        f.state.manual.push({ product_id: row.id, content_version: 2n, content_fingerprint: 'new-source-hash', evidence_known: true });
      }
    } });
    t.after(() => f.db.destroy());
    const result = await reconcileNameConsensus(f.db, { apply: true, beforeApply: async () => assert.fail('stale preview backup') });
    assert.deepEqual(result.changes, []);
    assert.equal(result.protectedProducts, protection === 'membership' ? 0 : 1);
    assert.deepEqual(f.transactions.map(tx => tx.outcome), ['commit', 'commit']);
    assert.ok(f.transactions[1]!.queries[0]!.sql.startsWith('lock table'));
    assert.ok(!f.transactions[1]!.queries.some(query => /for update|^update|^insert/.test(query.sql.trimStart())));
  });
}

test('existing writers still fail with NOWAIT before replanning, backup or mutations', async t => {
  const lockError = Object.assign(new Error('writer holds lock'), { code: '55P03' });
  const f = fixture(undefined, { lockError });
  t.after(() => f.db.destroy());
  await assert.rejects(reconcileNameConsensus(f.db, { apply: true, beforeApply: async () => assert.fail('locked backup') }),
    error => error === lockError);
  assert.deepEqual(f.transactions.map(tx => tx.outcome), ['commit', 'rollback']);
  assert.equal(f.transactions[1]!.queries.length, 1);
  assert.ok(f.transactions[1]!.queries[0]!.sql.startsWith('lock table'));
});

test('beforeApply failure rolls back the locked apply transaction before any mutations', async t => {
  const f = fixture();
  t.after(() => f.db.destroy());
  const failure = new Error('backup failed');
  await assert.rejects(reconcileNameConsensus(f.db, { apply: true, beforeApply: async () => { throw failure; } }),
    error => error === failure);
  assert.deepEqual(f.transactions.map(tx => tx.outcome), ['commit', 'rollback']);
  assert.ok(f.transactions[1]!.queries.at(-1)!.sql.endsWith('for update'));
  assert.ok(f.transactions.every(tx => !tx.queries.some(query => /^(update|insert)/.test(query.sql.trimStart()))));
});

for (const changed of ['Products', 'Memberships'] as const) {
  test(`apply retains optimistic ${changed.toLowerCase()} validation after replanning`, async t => {
    const f = fixture(undefined, { changedProducts: changed === 'Products', changedMemberships: changed === 'Memberships' });
    t.after(() => f.db.destroy());
    await assert.rejects(reconcileNameConsensus(f.db, { apply: true, beforeApply: async () => {} }),
      new RegExp(`${changed} changed during consensus repair`));
    assert.deepEqual(f.transactions.map(tx => tx.outcome), ['commit', 'rollback']);
    assert.ok(!f.transactions[1]!.queries.some(query => query.sql.includes('update catalog_cache_versions')));
  });
}

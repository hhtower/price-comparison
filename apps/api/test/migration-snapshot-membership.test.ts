import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { DummyDriver, Kysely, PostgresAdapter, PostgresDialect, PostgresIntrospector, PostgresQueryCompiler, sql } from 'kysely';
import { FileMigrationProvider } from 'kysely/migration';
import { Pool } from 'pg';
import type { DatabaseSchema } from '../src/database/types.js';
import * as initial from '../src/database/migrations/037_catalog_membership_kinds_20261113.js';
import * as topUp from '../src/database/migrations/052_top_up_half_price_feature_20261123.js';
import * as source from '../src/database/migrations/054_membership_source_binding_20261124.js';
import * as decision from '../src/database/migrations/055_membership_decision_metadata_20261124.js';

type Statement = { sql: string; parameters: readonly unknown[] };
type Snapshot = { name: string; revision: string; kindSql: string; up: Statement[]; down: Statement[] };
// Captured from each migration and its dependencies at the recorded Git revision, not from current code.
const snapshots: Snapshot[] = JSON.parse(await fs.readFile(
  new URL('./fixtures/migration-snapshot-membership.json', import.meta.url), 'utf8'));
const migrations: Array<{
  up: (database: Kysely<DatabaseSchema>) => Promise<void>;
  down: (database: Kysely<DatabaseSchema>) => Promise<void>;
}> = [initial, topUp, source, decision];
const migrationFolder = fileURLToPath(new URL('../src/database/migrations/', import.meta.url));

for (const [index, snapshot] of snapshots.entries()) {
  test(`${snapshot.name} replays the SQL from ${snapshot.revision.slice(0, 8)}`, async () => {
    const statements: Statement[] = [];
    const database = new Kysely<DatabaseSchema>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: db => new PostgresIntrospector(db),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
      log(event) {
        if (event.level === 'query') statements.push({
          sql: event.query.sql.replace(/\s+/gu, ' ').trim(), parameters: event.query.parameters,
        });
      },
    });
    try {
      await migrations[index]!.up(database);
      assert.deepEqual(statements.splice(0), snapshot.up);
      await migrations[index]!.down(database);
      assert.deepEqual(statements.splice(0), snapshot.down);
    } finally {
      await database.destroy();
    }
  });
}

test('all migration dependencies stay inside the migration directory', async () => {
  const visited = new Set<string>();
  async function inspect(file: string): Promise<void> {
    if (visited.has(file)) return;
    visited.add(file);
    const content = await fs.readFile(file, 'utf8');
    for (const [, specifier] of content.matchAll(/(?:^\s*(?:import|export)\b[^;'"`]*?\bfrom\s*|^\s*import\s*|\b(?:import|require)\s*\(\s*)['"]([^'"]+)['"]/gmu)) {
      if (specifier === 'kysely') continue;
      assert.ok(specifier?.startsWith('.'), `Live dependency: ${specifier} in ${file}`);
      const dependency = path.resolve(path.dirname(file), specifier!.replace(/\.js$/u, '.ts'));
      assert.ok(!path.relative(migrationFolder, dependency).startsWith('..'), `Live dependency: ${dependency}`);
      await inspect(dependency);
    }
  }
  async function inspectDirectory(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await inspectDirectory(file);
      else if (/\.[cm]?[jt]s$/u.test(entry.name)) await inspect(file);
    }
  }
  await inspectDirectory(migrationFolder);
});

test('the file provider discovers only numbered migrations and never scans snapshot helpers', async () => {
  const loaded: string[] = [];
  const provider = new FileMigrationProvider({
    fs, migrationFolder,
    path: { join: (...parts: string[]) => pathToFileURL(path.join(...parts)).href },
    import: async file => {
      loaded.push(fileURLToPath(file));
      return import(file);
    },
  });
  const discovered = await provider.getMigrations();
  const expected = (await fs.readdir(migrationFolder)).filter(file => /^\d+_.*\.ts$/u.test(file))
    .map(file => file.slice(0, -3)).sort();
  assert.deepEqual(Object.keys(discovered).sort(), expected);
  assert.ok(loaded.every(file => path.dirname(file) === path.resolve(migrationFolder)));
  assert.ok(loaded.every(file => /^\d+_/u.test(path.basename(file))));
});

test('historical stages rebuild and maintain their own membership projection in PostgreSQL',
  { skip: !process.env.TEST_DATABASE_URL }, async () => {
    const schema = `migration_snapshot_${process.pid}_${Date.now()}`;
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({
      pool: new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` }),
    }) });
    const source = { url: 'https://migration.invalid', protocol: null, platform: 'test' };
    const base = { contentVersion: '2', fingerprint: 'current', revision: '3',
      policyVersion: 'ai-membership-20261110-v3', tags: [], evidence: [], rejectedNames: [] };
    const account = { kind: 'account', reason: 'llm_reviewed' };
    const cases = [
      { name: 'account', feature: { ...base, source, decision: account }, kinds: ['account', 'account', 'account', 'account'] },
      { name: 'missing-source', feature: { ...base, decision: account }, kinds: ['account', 'account', null, null] },
      { name: 'old-metadata', feature: { ...base, source,
        decision: { ...account, durationSource: 'explicit', requiredWarrantyDays: 28 } },
      kinds: ['account', 'account', 'account', 'account'] },
      { name: 'unknown-metadata', feature: { ...base, source, decision: { ...account, unknown: true } },
        kinds: ['account', 'account', 'account', null] },
      { name: 'old-top-up', feature: { ...base, source, decision: { kind: 'top_up', reason: 'llm_reviewed' } },
        kinds: ['top_up', null, null, null] },
      { name: 'top-up', feature: { ...base, source, topUpPolicyVersion: 'top-up-eligibility-20261124-v1',
        decision: { kind: 'top_up', reason: 'llm_reviewed' } }, kinds: ['top_up', 'top_up', 'top_up', 'top_up'] },
      { name: 'half-price', feature: { ...base, source, topUpPolicyVersion: 'top-up-eligibility-20261124-v1',
        decision: { kind: 'top_up_half_price', reason: 'llm_reviewed' } },
      kinds: [null, 'top_up_half_price', 'top_up_half_price', 'top_up_half_price'] },
      { name: 'wrong-source', feature: { ...base, source: { ...source, url: 'https://other.invalid' }, decision: account },
        kinds: [null, null, null, null] },
      { name: 'null-source', feature: { ...base, source: null, decision: account }, kinds: [null, null, null, null] },
      { name: 'extra-source', feature: { ...base, source: { ...source, extra: true }, decision: account },
        kinds: [null, null, null, null] },
      { name: 'stale', feature: { ...base, source, revision: '1', decision: account }, kinds: [null, null, null, null] },
      { name: 'wrong-policy', feature: { ...base, source, policyVersion: 'old', decision: account },
        kinds: [null, null, null, null] },
      { name: 'unknown-kind', feature: { ...base, source, decision: { ...account, kind: 'unknown' } },
        kinds: [null, null, null, null] },
    ];
    const projection = async (id: number) => (await sql<{ kind: string }>`
      select kind from catalog_membership_kinds where product_id = ${id}`.execute(database)).rows[0]?.kind ?? null;
    try {
      await admin.query(`create schema "${schema}"`);
      await sql`create table shops (id bigint primary key, url text, protocol text, platform text);
        create table products (id bigint primary key, shop_id bigint references shops(id), membership_features jsonb,
          content_version bigint not null default 2, content_fingerprint text not null default 'current',
          standardization_revision bigint not null default 3);
        create table catalog_cache_versions (id integer primary key, version bigint, updated_at timestamptz);
        insert into catalog_cache_versions values (1, 0, now())`.execute(database);
      await sql`insert into shops values (1, ${source.url}, ${source.protocol}, ${source.platform})`.execute(database);
      for (const [index, fixture] of cases.entries()) {
        await sql`insert into products (id, shop_id, membership_features)
          values (${index + 1}, 1, ${JSON.stringify(fixture.feature)}::jsonb)`.execute(database);
      }
      for (const [stage, migration] of migrations.entries()) {
        await migration.up(database);
        for (const [index, fixture] of cases.entries()) {
          assert.equal(await projection(index + 1), fixture.kinds[stage], `${snapshots[stage]!.name}: ${fixture.name} backfill`);
          const inserted = index + 101;
          await sql`insert into products (id, shop_id, membership_features)
            values (${inserted}, 1, ${JSON.stringify(fixture.feature)}::jsonb)`.execute(database);
          const expected = stage === 3 && fixture.name === 'old-metadata' ? null : fixture.kinds[stage];
          assert.equal(await projection(inserted), expected, `${snapshots[stage]!.name}: ${fixture.name} trigger`);
          await sql`update products set content_version = 4 where id = ${inserted}`.execute(database);
          assert.equal(await projection(inserted), null, `${fixture.name}: stale trigger deletion`);
          await sql`update products set content_version = 2 where id = ${inserted}`.execute(database);
          assert.equal(await projection(inserted), expected, `${fixture.name}: restored trigger projection`);
          await sql`delete from products where id = ${inserted}`.execute(database);
          assert.equal(await projection(inserted), null);
        }
        const version = (await sql<{ version: string }>`select version::text from catalog_cache_versions`.execute(database)).rows[0]!;
        assert.equal(version.version, String(stage));
      }
      const cleaned = (await sql<{ feature: unknown }>`select membership_features as feature from products where id = 3`
        .execute(database)).rows[0]!.feature;
      assert.deepEqual(cleaned, { ...base, source, decision: account });
      const unknown = (await sql<{ decision: unknown }>`select membership_features->'decision' as decision from products where id = 4`
        .execute(database)).rows[0]!.decision;
      assert.deepEqual(unknown, { ...account, unknown: true });
      await initial.down(database);
      assert.equal((await sql<{ name: string | null }>`select to_regclass('catalog_membership_kinds')::text as name`
        .execute(database)).rows[0]!.name, null);
    } finally {
      await database.destroy();
      await admin.query(`drop schema if exists "${schema}" cascade`);
      await admin.end();
    }
  });

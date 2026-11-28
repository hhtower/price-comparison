import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DummyDriver, Kysely, PostgresAdapter, PostgresDialect, PostgresIntrospector, PostgresQueryCompiler, sql } from 'kysely';
import { Pool } from 'pg';
import { AI_MEMBERSHIP_TIERS } from '@price-comparison/catalog/membership-policy';
import type { DatabaseSchema } from '../src/database/types.js';
import { up, down } from '../src/database/migrations/034_ai_membership_kind_20261109.js';

type Statement = { sql: string; parameters: readonly unknown[] };
// Captured from 034 and its policy at a517acb9, before replacing the live dependency.
const snapshot: { revision: string; identities: Array<[string, string, string]>; up: Statement[]; down: Statement[] } =
  JSON.parse(await readFile(new URL('./fixtures/migration-snapshot-ai-membership.json', import.meta.url), 'utf8'));

test('034 preserves its historical SQL when the application membership list changes', async () => {
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
  const previous = AI_MEMBERSHIP_TIERS['openai/chatgpt'];
  try {
    Reflect.set(AI_MEMBERSHIP_TIERS, 'openai/chatgpt', ['future-tier']);
    await up(database);
    assert.deepEqual(statements.splice(0), snapshot.up);
    await down(database);
    assert.deepEqual(statements.splice(0), snapshot.down);
  } finally {
    Reflect.set(AI_MEMBERSHIP_TIERS, 'openai/chatgpt', previous);
    await database.destroy();
  }
});

test('034 installs exactly the historical AI identities and rolls back in PostgreSQL',
  { skip: !process.env.TEST_DATABASE_URL }, async () => {
    const schema = `migration_snapshot_ai_${process.pid}_${Date.now()}`;
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({
      pool: new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` }),
    }) });
    try {
      await admin.query(`create schema "${schema}"`);
      await sql`create table shops (id bigint primary key, url text, protocol text, platform text);
        create table products (id bigint primary key, shop_id bigint references shops(id),
          content_version bigint, content_fingerprint text, standardization_revision bigint);
        create table standard_products (id bigint primary key);
        create table ai_jobs (id bigint primary key, job_type text, parent_identity_job_id bigint, retry_of_job_id bigint)`
        .execute(database);
      await database.transaction().execute(up);
      for (const [family, product, tier] of snapshot.identities) {
        const { rows } = await sql<{ accepted: boolean; wrongTier: boolean }>`
          select is_ai_membership(${family}, ${product}, ${tier}) as accepted,
            is_ai_membership(${family}, ${product}, ${`${tier}-unknown`}) as "wrongTier"`.execute(database);
        assert.deepEqual(rows, [{ accepted: true, wrongTier: false }], `${family}/${product}/${tier}`);
      }
      for (const [family, product, tier] of [
        ['openai', 'claude', 'pro'], ['anthropic', 'chatgpt', 'plus'], ['openai', 'chatgpt', 'future-tier'],
        ['OpenAI', 'chatgpt', 'plus'], ['', '', ''], [null, 'chatgpt', 'plus'], ['openai', null, 'plus'],
        ['openai', 'chatgpt', null],
      ]) {
        const { rows } = await sql<{ accepted: boolean }>`
          select is_ai_membership(${family}, ${product}, ${tier}) as accepted`.execute(database);
        assert.deepEqual(rows, [{ accepted: false }], `${family}/${product}/${tier}`);
      }
      await database.transaction().execute(down);
      assert.equal((await sql<{ name: string | null }>`
        select to_regprocedure('is_ai_membership(text,text,text)')::text as name`.execute(database)).rows[0]!.name, null);
    } finally {
      await database.destroy();
      await admin.query(`drop schema if exists "${schema}" cascade`);
      await admin.end();
    }
  });

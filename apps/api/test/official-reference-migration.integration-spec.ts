import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { up, down } from '../src/database/migrations/048_official_reference_sources_20261121.js';

test('official reference analytics migration admits registered sources and preserves history on rollback', {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const schema = 'official_reference_test_' + randomBytes(6).toString('hex');
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  let database: Kysely<unknown> | undefined;
  try {
    await admin.query(`create schema "${schema}"`);
    database = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({
      connectionString: process.env.TEST_DATABASE_URL, options: '-c search_path=' + schema, max: 1,
    }) }) });
    await sql`create table analytics_actions (id integer primary key, name varchar(24) not null,
      reference_app_id varchar(14), reference_plan_id varchar(96),
      constraint analytics_actions_reference_check check (true),
      constraint analytics_actions_reference_plan_check check (true))`.execute(database);
    const insert = (id: number, name: string, app: string | null, plan: string | null) =>
      sql`insert into analytics_actions values (${id}, ${name}, ${app}, ${plan})`.execute(database!);
    await insert(1, 'reference_plan_select', '6448311069', '["6744120541","subscription","P1M"]');
    await database.transaction().execute(up);
    for (const [index, [app, plan]] of [
      ['6670324846', '["6741437612","subscription","P1M"]'],
      ['cursor', '["premium","subscription","P1M"]'],
      ['kiro', '["pro_plus","subscription","P1M"]'],
    ].entries()) {
      await insert(index + 2, 'reference_plan_select', app, plan);
      await insert(index + 5, 'reference_product', app, null);
    }
    await insert(8, 'search', null, null);
    for (const [name, app, plan] of [
      ['reference_product', 'unknown', null],
      ['reference_plan_select', 'kiro', '["premium","subscription","P1M"]'],
      ['reference_plan_select', 'cursor', '["pro","subscription","P1M"]'],
      ['reference_plan_select', 'cursor', '["premium","subscription","P1Y"]'],
      ['reference_plan_select', 'kiro', '["6741437612","subscription","P1M"]'],
      ['reference_plan_select', '6670324846', '["pro","subscription","P1M"]'],
      ['reference_plan_select', 'cursor', 'https://private.example'],
      ['reference_product', 'kiro', '["pro","subscription","P1M"]'],
      ['search', 'kiro', null],
      ['reference_plan_select', 'cursor', null],
    ]) await assert.rejects(insert(99, name!, app, plan), { code: '23514' });
    await assert.rejects(database.transaction().execute(down), { code: '23514' });
    assert.equal((await sql<{ count: number }>`select count(*)::int as count from analytics_actions`.execute(database)).rows[0].count, 8);
    await sql`delete from analytics_actions where id between 2 and 7`.execute(database);
    await database.transaction().execute(down);
    await assert.rejects(insert(99, 'reference_product', 'kiro', null), { code: '23514' });
    await insert(9, 'reference_product', '6448311069', null);
  } finally {
    await database?.destroy();
    await admin.query(`drop schema if exists "${schema}" cascade`);
    await admin.end();
  }
});

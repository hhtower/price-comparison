import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { up as previous } from '../src/database/migrations/048_official_reference_sources_20261121.js';
import { up, down } from '../src/database/migrations/049_official_membership_prices_20261121.js';

test('membership price migration permits only registered website plans under their existing apps', {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const schema = 'membership_prices_test_' + randomBytes(6).toString('hex');
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
    await previous(database);
    const insert = (id: number, app: string, plan: string, period = 'P1M') =>
      sql`insert into analytics_actions values (${id}, 'reference_plan_select', ${app},
        ${JSON.stringify([plan, 'subscription', period])})`.execute(database!);
    await insert(1, '6448311069', '6744120541');
    await insert(2, 'cursor', 'premium');
    await database.transaction().execute(up);
    const plans = [
      ['6448311069', 'business-standard-month', 'P1M'], ['6448311069', 'business-standard-year', 'P1Y'],
      ['6448311069', 'business-premium-month', 'P1M'], ['6448311069', 'business-premium-year', 'P1Y'],
      ['6473753684', 'team-standard-month', 'P1M'], ['6473753684', 'team-standard-year', 'P1Y'],
      ['6473753684', 'team-premium-month', 'P1M'], ['6473753684', 'team-premium-year', 'P1Y'],
      ['6477489729', 'google-ai-plus-month', 'P1M'], ['6477489729', 'google-ai-pro-month', 'P1M'],
      ['6477489729', 'google-ai-ultra-5x-month', 'P1M'], ['6477489729', 'google-ai-ultra-20x-month', 'P1M'],
    ];
    for (const [index, [app, plan, period]] of plans.entries()) await insert(index + 3, app, plan, period);
    for (const [app, plan, period] of [
      ['6473753684', 'business-standard-month', 'P1M'],
      ['6448311069', 'business-premium-year', 'P1M'],
      ['6477489729', 'google-ai-ultra-5x-month', 'P1Y'],
      ['google-ai', 'google-ai-pro-month', 'P1M'],
      ['kiro', 'business-standard-month', 'P1M'],
      ['6448311069', 'unregistered-plan', 'P1M'],
    ]) await assert.rejects(insert(99, app, plan, period), { code: '23514' });
    await assert.rejects(database.transaction().execute(down), { code: '23514' });
    assert.equal((await sql<{ count: number }>`select count(*)::int as count from analytics_actions`.execute(database)).rows[0].count, 14);
    await sql`delete from analytics_actions where id > 2`.execute(database);
    await database.transaction().execute(down);
    await assert.rejects(insert(99, '6448311069', 'business-standard-month'), { code: '23514' });
    await insert(100, 'kiro', 'pro');
  } finally {
    await database?.destroy();
    await admin.query(`drop schema if exists "${schema}" cascade`);
    await admin.end();
  }
});

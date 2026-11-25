import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { AnalyticsRepository } from '../src/analytics/analytics.repository.js';
import { analyticsPeriod } from '../src/analytics/analytics-input.js';
import type { AnalyticsNetworkService } from '../src/analytics/analytics-network.js';

const query = { days: 30, page: 1, limit: 20 };

for (const report of ['summary', 'visits'] as const) {
  test(`${report} runs on one client with transaction-local JIT disabled`, async () => {
    const statements: string[] = [];
    const released: unknown[] = [];
    const data = { total: 0, items: [] };
    const client = {
      query: async (text: string, values?: unknown[]) => {
        statements.push(text);
        if (text.startsWith('with ')) {
          assert.deepEqual(statements.slice(0, -1), ['begin read only', 'set local jit = off']);
          assert.equal(values?.[0], analyticsPeriod(30).start);
        }
        return { rows: [{ data }] };
      },
      release: (destroy?: boolean) => { released.push(destroy); },
    };
    const pool = { connect: async () => client, query: () => assert.fail('report must use the acquired client') } as unknown as Pool;
    const result = await new AnalyticsRepository(pool)[report](query);
    assert.equal(result.total, 0);
    assert.deepEqual(result.items, []);
    assert.equal(statements.length, 4);
    assert.equal(statements.at(-1), 'commit');
    assert.deepEqual(released, [false]);
  });

  for (const failure of ['begin read only', 'set local jit = off', 'report', 'commit']) {
    for (const rollbackFails of [false, true]) {
      test(`${report} preserves ${failure} error and ${rollbackFails ? 'discards' : 'releases'} client after rollback`, async () => {
        const original = new Error('original failure');
        const statements: string[] = [];
        const released: unknown[] = [];
        const client = {
          query: async (text: string) => {
            statements.push(text);
            if (text === failure || (failure === 'report' && text.startsWith('with '))) throw original;
            if (text === 'rollback' && rollbackFails) throw new Error('rollback failure');
            return { rows: [{ data: { total: 0, items: [] } }] };
          },
          release: (destroy?: boolean) => { released.push(destroy); },
        };
        const pool = { connect: async () => client, query: () => assert.fail('unexpected pool query') } as unknown as Pool;
        await assert.rejects(new AnalyticsRepository(pool)[report](query), error => error === original);
        assert.equal(statements.at(-1), 'rollback');
        assert.deepEqual(released, [rollbackFails]);
      });
    }
  }
}

test('summary releases the cache-address query client before reading the network cache', async () => {
  let leased = false;
  let jitOff = false;
  const pool = {
    connect: async () => {
      assert.equal(leased, false);
      leased = true;
      return {
        query: async (text: string) => {
          if (text === 'begin read only') jitOff = false;
          else if (text === 'set local jit = off') jitOff = true;
          else if (text === 'commit') jitOff = false;
          else {
            assert.equal(jitOff, true);
            return { rows: text.startsWith('select distinct') ? [{ ip: '8.8.8.8' }] : [{ data: { overview: {} } }] };
          }
          return { rows: [] };
        },
        release: () => { leased = false; },
      };
    },
    query: () => assert.fail('cache-address lookup must use the report transaction'),
  } as unknown as Pool;
  const network = {
    cached: async (ips: string[]) => {
      assert.equal(leased, false, 'cache reads must not hold a database connection');
      assert.deepEqual(ips, ['8.8.8.8']);
      return [];
    },
  } as unknown as AnalyticsNetworkService;
  await new AnalyticsRepository(pool, network).summary(query);
  assert.equal(leased, false);
});

test('report connection acquisition failure propagates unchanged', async () => {
  const original = new Error('pool unavailable');
  const pool = { connect: async () => { throw original; } } as unknown as Pool;
  await assert.rejects(new AnalyticsRepository(pool).summary(query), error => error === original);
});

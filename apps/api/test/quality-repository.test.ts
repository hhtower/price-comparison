import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QualityRepository } from '../src/quality/quality.repository.js';
import { buildQualityReport } from '../src/quality/quality-report.js';

test('report store persists one complete whitelist record and validates readback independent of JSON key order', async () => {
  const queries: Array<{ sql: string; values: any[] }> = [];
  const report = buildQualityReport({ id: '12345678-1234-1234-1234-123456789abc', kind: 'ip', state: 'completed', target: '8.8.*.*', createdAt: '2026-09-26T00:00:00.000Z', completedAt: '2026-09-26T00:00:01.000Z', configuration: { runs: 3, mode: null, selected: ['geo'] }, progress: [] }, []);
  const reordered = JSON.parse(JSON.stringify(report), (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value);
  const store = new QualityRepository({ async query(sql: string, values: any[]) { queries.push({ sql, values }); return { rows: [{ report: reordered, access_hash: 'a'.repeat(64), identity_hash: 'b'.repeat(64) }] }; } } as any);
  await assert.rejects(store.save({ ...report, state: 'running' }, 'a'.repeat(64), 'b'.repeat(64), new Date()));
  assert.equal(queries.length, 0);
  await store.save(report, 'a'.repeat(64), 'b'.repeat(64), new Date());
  assert.equal(queries.length, 1); assert.match(queries[0].sql, /^insert into quality_reports/);
  assert.deepEqual(JSON.parse(queries[0].values[3]), report);
  assert.deepEqual((await store.read(report.id))?.report, report);
  assert.match(queries[1].sql, /expires_at > now\(\)/);
});

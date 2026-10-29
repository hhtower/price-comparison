import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildQualityReport, validateQualityItem, validateQualityReport } from '../src/quality/quality-report.js';
import { validateQualityConfiguration, validateQualityEvidence, validateQualityProgress } from '../src/quality/quality-evidence.js';
import type { QualityConfiguration, QualityItemResult } from '../src/quality/quality.types.js';

const configuration: QualityConfiguration = { runs: 1, mode: 'standard', selected: ['iq-test', 'latency'] };
const timestamp = '2026-09-26T00:00:00.000Z';
const progress = { itemId: 'iq-test', stage: 'probe' as const, attempt: 1, total: 1, startedAt: timestamp };
const item: QualityItemResult = { id: 'iq-test', status: 'pass', score: 100, summary: '通过。', evidence: { attempts: [{ run: 1, outcome: 'pass' }] } };
const base = { id: 'contract', kind: 'ai' as const, state: 'completed' as const, target: 'https://relay.example/…', createdAt: timestamp, completedAt: timestamp, configuration, progress: [] };

test('configuration rejects missing fields, enum coercion, duplicates and unexpected fields', () => {
  assert.deepEqual(validateQualityConfiguration(configuration, 'ai'), configuration);
  for (const patch of [{ runs: 0 }, { runs: 1.1 }, { runs: '1' }, { runs: 6 }, { mode: undefined }, { mode: { toString: () => 'standard' } }, { baseline: ['platform'] }, { selected: [] }, { selected: ['iq-test', 'iq-test'] }, { selected: ['unknown'] }, { apiKey: 'sensitive' }]) assert.throws(() => validateQualityConfiguration({ ...configuration, ...patch }, 'ai'));
  assert.throws(() => validateQualityConfiguration(configuration, 'ip'));
});

test('active progress rejects wrong plans, timestamps, duplicate items and finalized results', () => {
  assert.deepEqual(validateQualityProgress([progress], configuration, 'running'), [progress]);
  for (const patch of [{ attempt: 0 }, { attempt: 2 }, { total: 2 }, { total: '1' }, { stage: 'measurement' }, { stage: ['probe'] }, { startedAt: '2026-02-30T00:00:00.000Z' }, { startedAt: '2026-09-26' }, { itemId: 'math-reasoning' }, { raw: 'answer' }]) assert.throws(() => validateQualityProgress([{ ...progress, ...patch }], configuration, 'running'));
  for (const state of ['queued', 'completed', 'cancelled', 'failed'] as const) assert.throws(() => validateQualityProgress([progress], configuration, state));
  assert.throws(() => validateQualityProgress([progress, progress], configuration, 'running'));
  assert.throws(() => buildQualityReport({ ...base, state: 'running', progress: [progress] }, [item]));
});

test('evidence permits bounded numeric observations only, with strict item and run limits', () => {
  const valid = { attempts: [{ run: 1, outcome: 'pass' }], measurements: [{ run: 1, firstTokenMs: 2, responseMs: 5, tokensPerSecond: null }] };
  assert.deepEqual(validateQualityEvidence(valid), valid);
  for (const value of [{}, { attempts: undefined }, { attempts: [] }, { attempts: [{ run: 2, outcome: 'pass' }] }, { attempts: [{ run: 1, outcome: ['pass'] }] }, { attempts: [{ run: 1, outcome: 'pass', answer: 21 }] }, { measurements: [{ run: 1, firstTokenMs: 7, responseMs: 5, tokensPerSecond: null }] }, { measurements: [{ run: 1, firstTokenMs: null, responseMs: Infinity, tokensPerSecond: null }] }, { measurements: [{ run: 1, firstTokenMs: null, responseMs: 1, tokensPerSecond: -1 }] }, { raw: 'secret' }]) assert.throws(() => validateQualityEvidence(value));
  assert.throws(() => buildQualityReport(base, [{ ...item, evidence: { attempts: [{ run: 1, outcome: 'pass' }, { run: 2, outcome: 'pass' }] } }]));
  assert.throws(() => buildQualityReport(base, [{ ...item, evidence: { measurements: valid.measurements } }]));
  assert.throws(() => validateQualityItem({ ...item, raw: 'secret' } as any));
  assert.throws(() => buildQualityReport(base, [{ ...item, status: 'unrun', score: null }]));
});

test('strict reports reject old contract, extra fields, changed labels and malformed terminal dates', () => {
  const report = buildQualityReport(base, [item]);
  assert.deepEqual(validateQualityReport(report), report);
  for (const patch of [{ configuration: undefined }, { progress: undefined }, { completedAt: undefined }, { completedAt: '2026-02-30T00:00:00.000Z' }, { createdAt: 'September 26, 2026' }, { raw: 'private' }, { items: report.items.map(entry => entry.id === item.id ? { ...entry, label: 'unknown' } : entry) }]) assert.throws(() => validateQualityReport({ ...report, ...patch }));
  const retained = buildQualityReport({ ...base, configuration: { ...configuration, selected: ['latency'] } }, [{ ...item, evidence: { attempts: [{ run: 1, outcome: 'pass' }, { run: 2, outcome: 'mismatch' }] } }]);
  assert.equal(retained.items.find(entry => entry.id === item.id)?.evidence?.attempts?.length, 2, 'untouched retest evidence retains original runs');
});

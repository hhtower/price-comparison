import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQualityApi } from '../../web/src/quality-api.js';
import { buildQualityReport, validateQualityReport } from '../src/quality/quality-report.js';
import { QUALITY_CATALOG } from '../src/quality/quality.catalog.js';
import type { QualityItemResult, QualityKind, QualityReport } from '../src/quality/quality.types.js';

const createdAt = '2026-09-26T00:00:00.000Z';
const handle = { id: 'contract-task', accessToken: 'mock-contract-token' };
function snapshot(kind: QualityKind, running = false): QualityReport {
  const selected = kind === 'ai' ? ['connectivity', 'streaming', 'latency', 'iq-test', 'math-reasoning', 'fingerprint-match'] : QUALITY_CATALOG.ip.filter(item => !item.proxyOnly).map(item => item.id);
  const results: QualityItemResult[] = QUALITY_CATALOG[kind].map(item => {
    if (kind === 'ip' && item.proxyOnly) return { id: item.id, status: 'unavailable', score: null, summary: '需要代理地址。' };
    if (!selected.includes(item.id)) return { id: item.id, status: 'unrun', score: null, summary: '未选择。', reason: 'not-selected' };
    if (item.id === 'fingerprint-match') return { id: item.id, status: 'unrun', score: null, summary: '指纹库未覆盖。', reason: 'unsupported' };
    if (running && ['iq-test', 'math-reasoning'].includes(item.id)) return { id: item.id, status: 'unrun', score: null, summary: '正在检测。' };
    if (item.id === 'iq-test') return { id: item.id, status: 'risk', score: 33, summary: '重复检测出现差异。', evidence: { attempts: [{ run: 1, outcome: 'pass' }, { run: 2, outcome: 'mismatch' }, { run: 3, outcome: 'invalid-response' }] } };
    if (kind === 'ai' && item.id === 'latency') return { id: item.id, status: 'pass', score: 100, summary: '响应时间可用。', evidence: { measurements: [{ run: 1, firstTokenMs: 240, responseMs: 720, tokensPerSecond: null }] } };
    return { id: item.id, status: 'pass', score: 100, summary: '检测完成。' };
  });
  return validateQualityReport(buildQualityReport({
    id: handle.id, kind, state: running ? 'running' : 'completed', target: kind === 'ai' ? 'https://relay.example/…' : '8.8.*.*', createdAt,
    ...(!running ? { completedAt: createdAt } : {}),
    ...(kind === 'ai' ? { model: 'test-model' } : {}),
    configuration: { runs: 3, mode: kind === 'ai' ? 'standard' : null, selected },
    progress: running ? [{ itemId: 'iq-test', stage: 'probe', attempt: 2, total: 3, startedAt: createdAt }, { itemId: 'math-reasoning', stage: 'probe', attempt: 1, total: 3, startedAt: createdAt }] : [],
  }, results));
}
const read = (value: unknown) => createQualityApi(async () => Response.json(value)).get(handle);

test('browser API accepts actual server reports for AI, IP, parallel progress and retained retest evidence', async () => {
  const completed = snapshot('ai');
  const retained = validateQualityReport(buildQualityReport({ ...completed, configuration: { ...completed.configuration, runs: 1, selected: ['latency'] } }, completed.items));
  for (const value of [completed, snapshot('ip'), snapshot('ai', true), retained]) {
    assert.deepEqual(await read(value), value);
    const reordered = JSON.parse(JSON.stringify(value), (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).reverse()) : entry);
    assert.deepEqual(await read(reordered), value, 'JSON object key order is not part of the wire contract');
  }
});

test('browser API rejects the same malformed configuration, evidence and summary as the server', async () => {
  const report = snapshot('ai');
  const mutations = [
    { ...report, configuration: { ...report.configuration, mode: null } },
    { ...report, configuration: { ...report.configuration, selected: ['iq-test', 'iq-test'] } },
    { ...report, privateResponse: 'must-not-render' },
    { ...report, summary: { ...report.summary, score: 100 } },
    { ...report, items: report.items.map(item => item.id === 'iq-test' ? { ...item, evidence: { attempts: [{ run: 1, outcome: 'pass', raw: 'must-not-render' }] } } : item) },
    { ...report, progress: [{ itemId: 'iq-test', stage: 'probe', attempt: 1, total: 3, startedAt: createdAt }] },
  ];
  for (const value of mutations) {
    assert.throws(() => validateQualityReport(value));
    await assert.rejects(read(value), /报告/);
  }
});

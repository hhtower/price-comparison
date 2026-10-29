import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseIpTarget, validateQualityInput, maskQualityTarget } from '../src/quality/quality-input.js';
import { QUALITY_CATALOG } from '../src/quality/quality.catalog.js';
import { buildQualityReport, validateQualityReport } from '../src/quality/quality-report.js';

test('parses complete IPv4 IPv6 and SOCKS5 without accepting partial addresses or leaking credentials', () => {
  assert.equal(parseIpTarget(' 1.2.3.4 ')?.type, 'ipv4');
  assert.equal(parseIpTarget('2001:db8::1')?.type, 'ipv6');
  assert.equal(parseIpTarget('::ffff:192.0.2.1')?.type, 'ipv6');
  for (const bad of [':::1', ':', '1.2.3.256', '01.2.3.4', 'example.com', 'https://example.com', 'socks5://', 'socks5://host:0', 'socks5://host:65536', 'socks5://host:1080/path', 'socks5://host:1080?key=x', 'socks5://host', 'socks5://u:%zz@host:80']) assert.equal(parseIpTarget(bad), null, bad);
  const parsed = parseIpTarget('socks5://user:p%40ss@[2001:db8::1]:1080');
  assert.equal(parsed?.host, '2001:db8::1'); assert.equal(parsed?.password, 'p@ss');
  assert.equal(parsed?.display.includes('user'), false); assert.equal(parsed?.display.includes('p%40ss'), false);
});

const ai = { kind: 'ai', endpoint: 'https://relay.example/v1', apiKey: 'secret', model: 'test', mode: 'quick', runs: 1, items: ['connectivity', 'streaming', 'latency'] };
test('validates inputs and makes connectivity plus protocol checks mandatory', () => {
  assert.deepEqual(validateQualityInput(ai), ai);
  for (const patch of [{ runs: 0 }, { runs: 6 }, { runs: 1.5 }, { endpoint: 'file:///x' }, { endpoint: 'https://user:secret@example.com' }, { endpoint: 'https://example.com?token=x' }, { items: ['latency'] }, { apiKey: '' }, { model: 'x'.repeat(201) }, { extra: 'bad' }, { baseline: 'official' }]) assert.throws(() => validateQualityInput({ ...ai, ...patch }));
  assert.deepEqual(validateQualityInput({ kind: 'ip', target: '1.2.3.4' }), { kind: 'ip', target: '1.2.3.4', runs: 3 });
  assert.equal(maskQualityTarget({ ...ai, endpoint: 'https://relay.example/private/key-path' } as any), 'https://relay.example/…');
});

const base = { id: 'abc', kind: 'ai' as const, state: 'completed' as const, target: 'https://relay.example/…', model: 'test', createdAt: '2026-09-26T00:00:00.000Z', completedAt: '2026-09-26T00:00:01.000Z', configuration: { runs: 1, mode: 'quick' as const, selected: ['streaming'] }, progress: [] };
const ipBase = { ...base, kind: 'ip' as const, configuration: { runs: 3, mode: null, selected: ['geo'] } };

for (const [mode, total] of [['quick', 4], ['standard', 13], ['full', 17]] as const) {
  test(`${mode} report counts only selected checks and passes when all of them pass`, () => {
    const selected = QUALITY_CATALOG.ai.filter(item => item.modes?.includes(mode)).map(item => item.id);
    const report = buildQualityReport({ ...base, configuration: { ...base.configuration, mode, selected } },
      selected.map(id => ({ id, status: 'pass', score: 100, summary: '正常。' })));
    assert.equal(report.items.length, 17); // Preserve the catalogue contract for selection and retests.
    assert.deepEqual(report.summary, { score: 100, tested: total, risk: 0, unrun: 0, unavailable: 0, cancelled: 0, total, overall: '通过' });
    assert.deepEqual(validateQualityReport(report), report);
  });
}

test('selected unsupported checks remain uncovered while unselected checks do not count', () => {
  const report = buildQualityReport({ ...base, configuration: { runs: 1, mode: 'standard', selected: ['streaming', 'fingerprint-match'] } }, [
    { id: 'streaming', status: 'pass', score: 100, summary: '正常。' },
    { id: 'fingerprint-match', status: 'unrun', score: null, reason: 'unsupported', summary: '指纹库未覆盖。' },
  ]);
  assert.equal(report.summary.total, 2);
  assert.equal(report.summary.unrun, 1);
  assert.equal(report.summary.tested, 1);
  assert.equal(report.summary.overall, '存在未覆盖风险');
});

test('single-item retest retains previous results without adding checks outside the original scope', () => {
  const selected = QUALITY_CATALOG.ai.filter(item => item.modes?.includes('standard')).map(item => item.id);
  const original = buildQualityReport({ ...base, configuration: { runs: 1, mode: 'standard', selected } },
    selected.map(id => id === 'fingerprint-match' ? { id, status: 'unrun', score: null, reason: 'unsupported', summary: '指纹库未覆盖。' } : { id, status: 'pass', score: 100, summary: '正常。' }));
  const retest = buildQualityReport({ ...original, configuration: { ...original.configuration, selected: ['streaming'] } },
    original.items.map(item => item.id === 'streaming' ? { id: item.id, status: 'risk', score: 0, summary: '请求失败。' } : item));
  assert.equal(retest.summary.total, 13);
  assert.equal(retest.summary.tested, 12);
  assert.equal(retest.summary.unrun, 1);
  assert.equal(retest.summary.risk, 1);
  assert.equal(retest.summary.overall, '存在风险');
});
test('keeps risk without a score as completed failure and cancellation as incomplete', () => {
  const report = buildQualityReport(base, [{ id: 'streaming', status: 'risk', score: null, summary: '请求失败。' }]);
  assert.equal(report.summary.tested, 1); assert.equal(report.summary.risk, 1); assert.equal(report.summary.score, 0); assert.equal(report.summary.overall, '存在风险');
  const cancelled = buildQualityReport({ ...base, state: 'cancelled' }, [{ id: 'streaming', status: 'pass', score: 100, summary: '正常。' }]);
  assert.equal(cancelled.summary.overall, '检测未完成'); assert.equal(cancelled.summary.tested, 1);
  assert.equal(cancelled.summary.cancelled, 0);
  assert.equal(cancelled.summary.total, 1);
  const partial = buildQualityReport({ ...base, state: 'cancelled', configuration: { ...base.configuration, selected: ['streaming', 'latency'] } }, [{ id: 'streaming', status: 'pass', score: 100, summary: '正常。' }]);
  assert.equal(partial.summary.cancelled, 1);
  assert.equal(partial.summary.total, 2);
  assert.equal(partial.items.find(item => item.id === 'long-context')?.reason, 'not-selected');
});

test('weights dimensions on the server and excludes extra services and proxy-only checks from IP score', () => {
  const report = buildQualityReport({ ...ipBase, target: '1.2.3.4' }, QUALITY_CATALOG.ip.map(item => ({ id: item.id, status: item.proxyOnly ? 'unavailable' as const : 'pass' as const, score: item.proxyOnly ? null : item.group === '风险信誉' ? 0 : 100, summary: '检测结果。' })));
  assert.equal(report.summary.score, 33); // 15/(15+30), not a per-item average.
  assert.equal(report.summary.unrun, 0); assert.equal(report.summary.overall, '通过');
  const withoutExtra = buildQualityReport(ipBase, [{ id: 'geo', status: 'pass', score: 100, summary: '正常。' }]);
  const withExtra = buildQualityReport(ipBase, [{ id: 'geo', status: 'pass', score: 100, summary: '正常。' }, { id: 'streaming', status: 'risk', score: 0, summary: '服务受限。' }]);
  assert.equal(withExtra.summary.score, withoutExtra.summary.score); assert.equal(withExtra.summary.overall, '存在风险');
});

test('validates complete report shape and excludes probe and credential fields', () => {
  assert.throws(() => buildQualityReport(base, [{ id: 'streaming', status: 'pass', score: 100, summary: '正常。', raw: 'secret prompt' } as any]));
  const report = buildQualityReport(base, [{ id: 'streaming', status: 'pass', score: 100, summary: '正常。' }]);
  assert.equal(JSON.stringify(report).includes('secret prompt'), false);
  assert.deepEqual(validateQualityReport(report), report);
  assert.throws(() => validateQualityReport({ ...report, apiKey: 'secret' }));
  assert.throws(() => validateQualityReport({ ...report, items: [] }));
  assert.throws(() => validateQualityReport({ ...report, summary: { ...report.summary, score: 999 } }));
  assert.throws(() => buildQualityReport(base, [{ id: 'streaming', status: 'pass', score: 101, summary: 'x' }]));
  assert.throws(() => buildQualityReport(base, [{ id: 'streaming', status: 'pass', score: null, summary: 'x' }]));
});

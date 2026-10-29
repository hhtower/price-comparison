import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QualityService } from '../src/quality/quality.service.js';
import { createIpQualityDetector } from '../src/quality/ip-quality-detector.js';
import type { QualityReport, QualityItemResult } from '../src/quality/quality.types.js';
import type { QualityReportStore } from '../src/quality/quality.repository.js';

const input = { kind: 'ai', endpoint: 'https://relay.example/v1', apiKey: 'task-only-secret', model: 'test', mode: 'quick', runs: 1, items: ['connectivity', 'streaming', 'latency'] };
function store() {
  const records = new Map<string, { report: QualityReport; accessHash: string; identityHash: string }>();
  let writes = 0;
  return { records, get writes() { return writes; },
    async save(report, accessHash, identityHash) { writes++; records.set(report.id, { report: structuredClone(report), accessHash, identityHash }); },
    async read(id) { return records.get(id) ?? null; },
  } satisfies QualityReportStore & { records: typeof records; writes: number };
}
async function until(check: () => boolean | Promise<boolean>) { for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('condition did not settle'); }

test('runs through WorkerRuntime with shared AI leases, streams safe progress and saves only the terminal report', async t => {
  const repository = store(); let acquire = 0; let release = 0;
  const service = new QualityService({ repository, aiConcurrency: 1, coordinator: { async acquire() { acquire++; return { tokenId: 'lease', queueWaitMs: 0, async heartbeat() {}, async release() { release++; } }; } },
    aiDetector: async (_config, ids, _signal, onItem) => { assert.equal(repository.writes, 0); const results: QualityItemResult[] = []; for (const id of ids) { const item = { id, status: 'pass' as const, score: 100, summary: '通过检测。' }; results.push(item); onItem(item); } return results; },
    ipDetector: async () => [],
  });
  t.after(() => service.onModuleDestroy());
  const task = await service.create(input); const events: QualityReport[] = [];
  const unsubscribe = await service.subscribe(task.id, task.accessToken, report => events.push(report));
  await service.runOnce(); await until(() => repository.writes === 1); await until(() => release === 1);
  const report = await service.read(task.id, task.accessToken);
  assert.equal(report.state, 'completed'); assert.equal(report.summary.tested, 3); assert.equal(report.summary.unrun, 0); assert.equal(report.summary.total, 3); assert.equal(report.summary.overall, '通过');
  assert.ok(events.some(event => event.state === 'running' && event.summary.tested === 1));
  assert.equal(acquire, 1); assert.equal(release, 1); assert.equal(repository.writes, 1);
  assert.equal(JSON.stringify([...repository.records.values(), ...events]).includes('task-only-secret'), false);
  assert.equal(JSON.stringify([...repository.records.values()]).includes(task.accessToken), false);
  await assert.rejects(service.read(task.id, 'wrong-token'));
  unsubscribe();
});

test('cancellation aborts in-flight work, retains completed checks and ignores late results', async t => {
  const repository = store(); let aborted = false; let started = false;
  const service = new QualityService({ repository, aiConcurrency: 1,
    aiDetector: async (_config, _ids, signal, onItem) => { onItem({ id: 'connectivity', status: 'pass', score: 100, summary: '可连接。' }); started = true; await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true })); onItem({ id: 'streaming', status: 'pass', score: 100, summary: '不应生效。' }); return []; },
    ipDetector: async () => [],
  });
  t.after(() => service.onModuleDestroy());
  const task = await service.create(input); await service.runOnce(); await until(() => started);
  const report = await service.cancel(task.id, task.accessToken);
  assert.equal(report.state, 'cancelled'); assert.equal(report.summary.tested, 1); assert.equal(report.summary.cancelled, 2); assert.equal(report.summary.unrun, 0); assert.equal(report.summary.total, 3);
  assert.equal(report.items.find(item => item.id === 'connectivity')?.status, 'pass');
  assert.equal(report.items.find(item => item.id === 'streaming')?.status, 'cancelled');
  await until(() => aborted); assert.equal(repository.writes, 1);
});

test('single-item retest keeps the old report and other results, requires credentials and matching target', async t => {
  const repository = store(); const executions: string[][] = [];
  const service = new QualityService({ repository, aiConcurrency: 1, aiDetector: async (_config, ids, _signal, onItem) => { executions.push(ids); return ids.map(id => { const item = { id, status: 'pass' as const, score: executions.length === 1 ? 80 : 100, summary: '已完成。' }; onItem(item); return item; }); }, ipDetector: async () => [] });
  t.after(() => service.onModuleDestroy());
  const first = await service.create(input); await service.runOnce(); await until(() => repository.writes === 1);
  await assert.rejects(service.retest(first.id, first.accessToken, { itemIds: ['streaming'], input: { ...input, apiKey: '' } }));
  await assert.rejects(service.retest(first.id, first.accessToken, { itemIds: ['streaming'], input: { ...input, endpoint: 'https://different.example/v1' } }));
  const second = await service.retest(first.id, first.accessToken, { itemIds: ['streaming'], input }); await service.runOnce(); await until(() => repository.writes === 2);
  assert.deepEqual(executions[1], ['streaming']);
  const report = await service.read(second.id, second.accessToken);
  assert.equal(report.items.find(item => item.id === 'connectivity')?.score, 80);
  assert.equal(report.items.find(item => item.id === 'streaming')?.score, 100);
  assert.equal((await service.read(first.id, first.accessToken)).items.find(item => item.id === 'streaming')?.score, 80);
});

test('ordinary IP checks do not acquire an AI lease and retain unavailable states', async t => {
  const repository = store();
  const service = new QualityService({ repository, coordinator: { async acquire() { throw new Error('IP must not acquire'); } }, aiDetector: async () => [], ipDetector: async (_config, ids, _signal, onItem) => ids.map(id => { const item = { id, status: 'pass' as const, score: 100, summary: '已查询。' }; onItem(item); return item; }) });
  t.after(() => service.onModuleDestroy());
  const task = await service.create({ kind: 'ip', target: '8.8.8.8' }); await service.runOnce(); await until(() => repository.writes === 1);
  const report = await service.read(task.id, task.accessToken);
  assert.equal(report.summary.unavailable, 10); assert.equal(report.summary.unrun, 0); assert.equal(report.summary.score, 100);
});

test('timeouts and invalid detector results become risk, never successful or partially persisted', async t => {
  const repository = store();
  const service = new QualityService({ repository, taskTimeoutMs: 20, aiDetector: async (_config, _ids, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), ipDetector: async () => [] });
  t.after(() => service.onModuleDestroy());
  const task = await service.create(input); await service.runOnce(); await until(() => repository.writes === 1);
  const report = await service.read(task.id, task.accessToken);
  assert.equal(report.state, 'failed'); assert.equal(report.summary.risk, 3); assert.equal(report.summary.overall, '存在风险');
});

test('persistence failure is explicit and does not leave a successful terminal event', async t => {
  const repository = store(); repository.save = async () => { throw new Error('database password'); };
  const service = new QualityService({ repository, aiDetector: async () => [], ipDetector: async () => [] });
  t.after(() => service.onModuleDestroy());
  const task = await service.create(input); await service.runOnce(); await until(async () => (await service.read(task.id, task.accessToken)).state === 'failed');
  const report = await service.read(task.id, task.accessToken);
  assert.equal(report.summary.overall, '存在风险'); assert.equal(JSON.stringify(report).includes('password'), false);
});

test('cancelling a task also cancels a pending shared AI lease acquisition', async t => {
  const repository = store(); let waiting = false; let aborted = false;
  const service = new QualityService({ repository, coordinator: { async acquire({ signal }) { waiting = true; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true })); } }, aiDetector: async () => { throw new Error('must not execute'); }, ipDetector: async () => [] });
  t.after(() => service.onModuleDestroy());
  const task = await service.create(input); await service.runOnce(); await until(() => waiting);
  await service.cancel(task.id, task.accessToken); await until(() => aborted);
  assert.equal((await service.read(task.id, task.accessToken)).state, 'cancelled');
});

test('common SOCKS passwords do not turn valid evidence or fixed report fields into task failures', async t => {
  for (const password of ['pass', 'score', 'id', '国家']) {
    const repository = store();
    const detector = createIpQualityDetector({
      identityUrl: 'https://identity.example/{ip}', egressUrl: 'https://egress.example/',
      reputationUrl: null, headersUrl: null, dnsUrl: null, aiServices: [], streamingServices: [],
      createFetch: async proxy => {
        assert.equal(proxy?.password, password);
        return { close: async () => {}, fetch: (async url => new Response(JSON.stringify(String(url).includes('identity.example')
          ? { success: true, ip: '8.8.8.8', country_code: 'US', connection: { asn: 15169, org: 'Provider' } }
          : { ip: '8.8.8.8' }))) as typeof fetch };
      },
    });
    const service = new QualityService({ repository, ipDetector: detector, aiDetector: async () => [] });
    t.after(() => service.onModuleDestroy());
    const task = await service.create({ kind: 'ip', target: 'socks5://user:' + encodeURIComponent(password) + '@proxy.example:1080', runs: 3 });
    await service.runOnce(); await until(() => repository.writes === 1);
    const report = await service.read(task.id, task.accessToken);
    assert.equal(report.state, 'completed', password);
    assert.equal(report.items.find(item => item.id === 'geo')?.status, 'pass', password);
    assert.equal(report.items.find(item => item.id === 'geo')?.score, 100, password);
  }
});

test('sensitive display text is hidden before progress and storage without corrupting valid check results', async t => {
  const repository = store();
  const apiKey = 'task-"quoted\\secret';
  const service = new QualityService({ repository, ipDetector: async () => [],
    aiDetector: async (_config, ids, _signal, onItem) => ids.map(id => {
      const value: QualityItemResult = { id, status: 'pass', score: 100, summary: '响应包含 ' + apiKey, impact: '详情包含 ' + apiKey };
      onItem(value); return value;
    }),
  });
  t.after(() => service.onModuleDestroy());
  const task = await service.create({ ...input, apiKey });
  const events: QualityReport[] = [];
  await service.subscribe(task.id, task.accessToken, report => events.push(report));
  await service.runOnce(); await until(() => repository.writes === 1);
  const report = await service.read(task.id, task.accessToken);
  assert.equal(report.state, 'completed');
  assert.equal(report.summary.tested, 3);
  assert.equal(report.items.find(item => item.id === 'connectivity')?.status, 'pass');
  for (const snapshot of [...events, report, ...[...repository.records.values()].map(row => row.report)]) {
    for (const item of snapshot.items) {
      assert.equal(item.summary.includes(apiKey), false);
      assert.equal(item.impact?.includes(apiKey) ?? false, false);
    }
  }
});

test('expired in-memory reports defer to expiry-filtered storage and do not remain accessible', async t => {
  let now = Date.now(); let reads = 0;
  t.mock.method(Date, 'now', () => now);
  const repository = store();
  repository.read = async () => { reads++; return null; };
  const service = new QualityService({ repository, reportTtlMs: 100, aiDetector: async (_input, ids) => ids.map(id => ({ id, status: 'pass', score: 100, summary: '已完成。' })), ipDetector: async () => [] });
  t.after(() => service.onModuleDestroy());
  const task = await service.create(input);
  await service.runOnce(); await until(() => repository.writes === 1);
  assert.equal((await service.read(task.id, task.accessToken)).state, 'completed');
  assert.equal(reads, 0);
  now += 101;
  await assert.rejects(service.read(task.id, task.accessToken), /不存在或已过期/);
  assert.equal(reads, 1);
});

test('shutdown cancels queued and running tasks, preserves completed evidence and releases the shared lease', async t => {
  const repository = store(); let started = false; let aborted = false; let released = false;
  const service = new QualityService({ repository, aiConcurrency: 1,
    coordinator: { async acquire() { return { tokenId: 'shutdown-lease', queueWaitMs: 0, async heartbeat() {}, async release() { released = true; } }; } },
    aiDetector: async (_config, _ids, signal, onItem) => {
      onItem({ id: 'connectivity', status: 'pass', score: 100, summary: '可连接。' }); started = true;
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
      return [];
    }, ipDetector: async () => [],
  });
  t.after(() => service.onModuleDestroy());
  const running = await service.create(input); const queued = await service.create(input);
  await service.runOnce(); await until(() => started);
  await service.onModuleDestroy();
  assert.ok(aborted && released);
  assert.equal(repository.writes, 2);
  const activeReport = await service.read(running.id, running.accessToken);
  const queuedReport = await service.read(queued.id, queued.accessToken);
  assert.equal(activeReport.state, 'cancelled'); assert.equal(activeReport.summary.tested, 1);
  assert.equal(queuedReport.state, 'cancelled'); assert.equal(queuedReport.summary.cancelled, 3);
  assert.equal(JSON.stringify([...repository.records.values()]).includes(input.apiKey), false);
  await assert.rejects(service.create(input), /检测服务正在停止/);
});

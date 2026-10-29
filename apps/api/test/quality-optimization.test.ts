import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QualityService } from '../src/quality/quality.service.js';
import { createAiQualityDetector } from '../src/quality/ai-quality-detector.js';
import { validateQualityReport } from '../src/quality/quality-report.js';
import type { AiQualityInput, QualityReport } from '../src/quality/quality.types.js';
import type { QualityReportStore } from '../src/quality/quality.repository.js';
import { createAiConcurrencyCoordinator } from '../src/ai/ai-concurrency.js';

const input: AiQualityInput = { kind: 'ai', endpoint: 'https://relay.example/v1', apiKey: 'secret-quality-test', model: 'quality-test', mode: 'standard', runs: 1, items: ['connectivity', 'streaming', 'latency', 'math-reasoning', 'logic-reasoning'] };
const noProgress = () => {};
function stream(content: string, finish = 'stop') {
  const chunk = (text: string, end = false) => `data: ${JSON.stringify({ id: 'check', model: input.model, choices: [{ delta: { content: text }, ...(end ? { finish_reason: finish } : {}) }] })}\n\n`;
  return new Response(chunk(content.slice(0, 3)) + chunk(content.slice(3), true) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}
function memoryStore() {
  const reports: QualityReport[] = [];
  return { reports, async save(report) { reports.push(structuredClone(report)); }, async read() { return null; } } satisfies QualityReportStore & { reports: QualityReport[] };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 2500;
  while (!check()) { if (Date.now() >= deadline) assert.fail('Expected progress did not occur'); await new Promise(resolve => setTimeout(resolve, 5)); }
}

test('independent probes overlap under shared leases only after measurement, with unchanged request count', async t => {
  const repository = memoryStore(); let basicCalls = 0; let active = 0; let peak = 0; let leases = 0; let peakLeases = 0;
  const entered: string[] = []; const finish: Array<() => void> = []; const snapshots: QualityReport[] = [];
  const detector = createAiQualityDetector({ fetchImpl: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); assert.equal(body.stream, true);
    assert.ok(leases > 0, 'every upstream request owns a shared lease');
    const prompt = body.messages[0].content;
    if (prompt.includes('integers from 1')) { basicCalls++; return stream('1 2 3'); }
    assert.equal(basicCalls, 1, 'measurement finishes before independent probes');
    entered.push(prompt); active++; peak = Math.max(peak, active);
    await new Promise<void>(resolve => { finish.push(resolve); init!.signal!.addEventListener('abort', () => resolve(), { once: true }); });
    active--; return stream(prompt.includes('101') ? '{"answer":10403}' : '{"answer":"B"}');
  } });
  const service = new QualityService({ repository, aiDetector: detector, ipDetector: async () => [], aiConcurrency: 2, coordinator: { async acquire() { leases++; peakLeases = Math.max(peakLeases, leases); return { tokenId: String(leases), queueWaitMs: 0, async heartbeat() {}, async release() { leases--; } }; } } });
  t.after(() => service.onModuleDestroy());
  const handle = await service.create(input); await service.subscribe(handle.id, handle.accessToken, value => snapshots.push(value)); service.onModuleInit();
  await until(() => entered.length === 2);
  assert.equal(peak, 2); assert.equal(peakLeases, 2); assert.equal(repository.reports.length, 0);
  assert.ok(snapshots.some(report => report.progress.length === 2));
  finish.forEach(resolve => resolve()); await until(() => repository.reports.length === 1);
  const report = repository.reports[0]; assert.equal(report.state, 'completed'); assert.equal(report.summary.tested, 5);
  assert.equal(basicCalls + entered.length, 3); assert.deepEqual(report.progress, []);
  assert.deepEqual(report.configuration, { runs: 1, mode: 'standard', selected: input.items });
  assert.equal(JSON.stringify(snapshots).includes(input.apiKey), false);
});

test('full custom scope and stability retest preserve selected runs through actual streamed requests', async t => {
  const repository = memoryStore(); const requests: Array<{ key: string | null; content: string }> = [];
  const detector = createAiQualityDetector({ environment: {}, fetchImpl: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const content = body.messages.at(-1).content;
    requests.push({ key: new Headers(init?.headers).get('authorization'), content });
    assert.equal(body.stream, true);
    return stream(body.messages.some((message: { role: string }) => message.role === 'system') ? 'READY-7' : content.includes('READY') ? 'READY' : '{"answer":21}');
  } });
  const service = new QualityService({ repository, aiConcurrency: 2, aiDetector: detector, ipDetector: async () => [] });
  t.after(() => service.onModuleDestroy());
  const config = { ...input, mode: 'full', runs: 1, items: ['connectivity', 'streaming', 'iq-test', 'stability'] };
  const first = await service.create(config); service.onModuleInit();
  await until(() => repository.reports.length === 1);
  const original = repository.reports[0];
  assert.equal(original.state, 'completed'); assert.equal(original.summary.total, 4);
  assert.equal(requests.length, 2, 'one shared basic request and one candy request only');
  assert.deepEqual(original.configuration, { mode: 'full', runs: 1, selected: config.items });
  assert.equal(original.items.find(item => item.id === 'stability')?.reason, 'insufficient-samples');
  const second = await service.retest(first.id, first.accessToken, { itemIds: ['stability'], input: { ...config, runs: 3, apiKey: 'refilled-test-key' } });
  await until(() => repository.reports.length === 2);
  const result = await service.read(second.id, second.accessToken);
  assert.equal(result.state, 'completed'); assert.equal(result.summary.unrun, 0);
  assert.deepEqual(result.configuration, { mode: 'full', runs: 3, selected: ['stability'] });
  assert.equal(requests.length, 5, 'the stability retest adds exactly three requests');
  assert.ok(requests.slice(2).every(request => request.key === 'Bearer refilled-test-key'));
  assert.equal(result.items.find(item => item.id === 'stability')?.evidence?.attempts?.length, 3);
  assert.deepEqual(result.items.filter(item => item.id !== 'stability'), original.items.filter(item => item.id !== 'stability'));
  assert.equal(result.items.find(item => item.id === 'iq-test')?.evidence?.attempts?.length, 1);
});

test('attempt evidence distinguishes wrong answers, invalid JSON and stream failure without changing IQ scoring', async () => {
  const answers = ['{"answer":22}', '{"answer":"21"}', '{"answer":21}']; const progress: any[] = []; let sent = 0;
  const detector = createAiQualityDetector({ fetchImpl: async () => stream(answers[sent++]) });
  const [item] = await detector({ ...input, runs: 3 }, ['iq-test'], new AbortController().signal, () => {}, value => progress.push(value));
  assert.equal(item.score, 33); assert.equal(item.status, 'risk');
  assert.deepEqual(item.evidence?.attempts, [{ run: 1, outcome: 'mismatch' }, { run: 2, outcome: 'invalid-response' }, { run: 3, outcome: 'pass' }]);
  assert.deepEqual(progress.map(value => [value.itemId, value.attempt, value.total]), [['iq-test', 1, 3], ['iq-test', 2, 3], ['iq-test', 3, 3]]);
  const truncated = createAiQualityDetector({ fetchImpl: async () => stream('{"answer":21}', 'length') });
  const [bad] = await truncated(input, ['iq-test'], new AbortController().signal, () => {}, noProgress);
  assert.equal(bad.score, 0); assert.equal(bad.evidence?.attempts?.[0].outcome, 'invalid-response');
  assert.equal(JSON.stringify(item).includes('answer'), false);
});

test('later basic request failure retains earlier measurements and item-specific attempt outcomes without extra requests', async () => {
  let requests = 0;
  const detector = createAiQualityDetector({ fetchImpl: async () => {
    requests++;
    if (requests > 1) throw new Error('mock transport failure');
    const response = stream('READY');
    return new Response((await response.text()).replaceAll(input.model, 'different-model'), { headers: response.headers });
  } });
  const ids = ['connectivity', 'model-identity', 'streaming', 'token-usage', 'latency'];
  const results = await detector({ ...input, runs: 3 }, ids, new AbortController().signal, () => {});
  assert.equal(requests, 2, 'a failed shared sample still stops later repetitions');
  assert.ok(results.every(item => item.status === 'risk' && item.score === 0), 'preserve existing fail-fast scoring');
  for (const id of ids) {
    const item = results.find(item => item.id === id)!;
    assert.deepEqual(item.evidence?.attempts, [
      { run: 1, outcome: ['model-identity', 'token-usage'].includes(id) ? 'mismatch' : 'pass' },
      { run: 2, outcome: 'request-error' },
    ], id);
  }
  const measurements = results.find(item => item.id === 'latency')?.evidence?.measurements;
  assert.equal(measurements?.length, 1);
  assert.equal(measurements![0].run, 1);
  assert.equal(typeof measurements![0].firstTokenMs, 'number');
  assert.ok(measurements![0].responseMs >= measurements![0].firstTokenMs!);
  assert.equal(measurements![0].tokensPerSecond, null);
  assert.equal(JSON.stringify(results).includes('READY'), false);
});

test('cancellation aborts every in-flight unit and never starts waiting probes or writes twice', async t => {
  const repository = memoryStore(); let started = 0; let aborted = 0; let releases = 0;
  const detector = createAiQualityDetector({ fetchImpl: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); if (body.messages[0].content.includes('integers from 1')) return stream('1 2 3');
    started++; return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => { aborted++; reject(init!.signal!.reason); }, { once: true }));
  } });
  const service = new QualityService({ repository, aiDetector: detector, ipDetector: async () => [], aiConcurrency: 2, coordinator: { async acquire() { return { tokenId: 'slot', queueWaitMs: 0, async heartbeat() {}, async release() { releases++; } }; } } });
  t.after(() => service.onModuleDestroy());
  const handle = await service.create({ ...input, items: [...input.items, 'iq-test'] }); service.onModuleInit();
  await until(() => started === 2); const report = await service.cancel(handle.id, handle.accessToken);
  await until(() => aborted === 2 && releases === 3);
  assert.equal(started, 2); assert.equal(report.summary.tested, 3); assert.equal(report.summary.cancelled, 3);
  assert.deepEqual(report.progress, []); assert.equal(repository.reports.length, 1);
  assert.deepEqual(validateQualityReport(report), report);
});

test('timeout, transport errors, overflow and truncated responses retain separate sanitized attempt categories without retries', async () => {
  for (const [expected, response] of [
    ['timeout', (_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }))],
    ['request-error', async () => { throw new Error('private upstream diagnostic'); }],
    ['invalid-response', async () => stream('{"answer":21}', 'length')],
    ['invalid-response', async () => stream('x'.repeat(100))],
  ] as const) {
    let calls = 0;
    const detector = createAiQualityDetector({ timeoutMs: 20, maxOutputBytes: 32, fetchImpl: async (url, init) => { calls++; return response(url, init!); } });
    const [item] = await detector({ ...input, runs: 2 }, ['iq-test'], new AbortController().signal, () => {});
    assert.equal(calls, 2); assert.equal(item.score, 0);
    assert.deepEqual(item.evidence?.attempts, [{ run: 1, outcome: expected }, { run: 2, outcome: expected }]);
    assert.equal(JSON.stringify(item).includes('private'), false);
  }
});

test('multi-turn dependency stays serial within one unit and reports each real request', async () => {
  let active = 0; let firstComplete = false; const messages: any[][] = []; const progress: any[] = [];
  const detector = createAiQualityDetector({ fetchImpl: async (_url, init) => {
    assert.equal(active++, 0); const body = JSON.parse(String(init?.body)); messages.push(body.messages);
    if (body.messages.length === 1) { await new Promise(resolve => setTimeout(resolve, 5)); firstComplete = true; active--; return stream('ACK'); }
    assert.ok(firstComplete); assert.equal(body.messages[1].content, 'ACK');
    const code = body.messages[0].content.match(/REFERENCE=([A-Z0-9-]+)/)[1]; active--; return stream(JSON.stringify({ code }));
  } });
  const [result] = await detector({ ...input, runs: 2 }, ['multi-turn'], new AbortController().signal, () => {}, value => progress.push(value));
  assert.equal(result.score, 100); assert.deepEqual(messages.map(value => value.length), [1, 3, 1, 3]);
  assert.deepEqual(progress.map(value => [value.attempt, value.total]), [[1, 4], [2, 4], [3, 4], [4, 4]]);
  assert.equal(result.evidence?.attempts?.length, 2);
});

test('shared coordinator enforces global quota and cancellation removes units waiting behind another worker', async t => {
  const tokens = new Set<string>(); let peak = 0; let waiting = 0;
  const coordinator = createAiConcurrencyCoordinator({ async eval(script: string, _keys: number, _key: string, ...args: string[]) {
    if (script.includes('AI_CONCURRENCY_ACQUIRE')) {
      if (tokens.size >= Number(args[1])) { waiting++; return [0]; }
      tokens.add(args[3]); peak = Math.max(peak, tokens.size); return [1];
    }
    if (script.includes('AI_CONCURRENCY_RELEASE')) return tokens.delete(args[0]) ? 1 : 0;
    return tokens.has(args[0]) ? 1 : 0;
  } }, { concurrency: 2, pollMs: 2 });
  const other = await coordinator.acquire({ workerId: 'unrelated-worker', stage: 'standardization', signal: new AbortController().signal });
  const repository = memoryStore(); let probes = 0; let aborted = 0;
  const detector = createAiQualityDetector({ fetchImpl: async (_url, init) => {
    assert.equal(tokens.size, 2); const body = JSON.parse(String(init?.body));
    if (body.messages[0].content.includes('integers from 1')) return stream('1 2 3');
    probes++; return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => { aborted++; reject(init!.signal!.reason); }, { once: true }));
  } });
  const service = new QualityService({ repository, aiDetector: detector, ipDetector: async () => [], aiConcurrency: 3, coordinator });
  t.after(async () => { await service.onModuleDestroy(); await other.release(); });
  const handle = await service.create({ ...input, items: [...input.items, 'iq-test'] }); service.onModuleInit();
  await until(() => probes === 1 && waiting > 1);
  const report = await service.cancel(handle.id, handle.accessToken);
  await until(() => aborted === 1 && tokens.size === 1);
  assert.equal(peak, 2); assert.equal(probes, 1); assert.equal(report.summary.cancelled, 3); assert.equal(repository.reports.length, 1);
});

test('batched risk retest preserves every untouched result and its original evidence using one strict scope array', async t => {
  const repository = memoryStore();
  const service = new QualityService({ repository, aiConcurrency: 2, aiDetector: async (config, ids) => ids.map(id => ({ id, status: config.runs === 3 ? 'risk' : 'pass', score: config.runs === 3 ? 0 : 100, summary: '已完成。', evidence: { attempts: Array.from({ length: config.runs }, (_, index) => ({ run: index + 1, outcome: config.runs === 3 ? 'mismatch' as const : 'pass' as const })) } })), ipDetector: async () => [] });
  t.after(() => service.onModuleDestroy());
  const originalInput = { ...input, runs: 3, items: ['connectivity', 'streaming', 'latency'] };
  const first = await service.create(originalInput); await service.runOnce(); await until(() => repository.reports.length === 1);
  const original = await service.read(first.id, first.accessToken);
  for (const body of [{ itemId: 'streaming', input }, { itemIds: [], input }, { itemIds: ['streaming', 'streaming'], input }, { itemIds: ['missing'], input }, { itemIds: ['streaming'], input, raw: true }]) await assert.rejects(service.retest(first.id, first.accessToken, body));
  const second = await service.retest(first.id, first.accessToken, { itemIds: ['streaming', 'latency'], input });
  await service.runOnce(); await until(() => repository.reports.length === 2);
  const report = await service.read(second.id, second.accessToken);
  assert.deepEqual(report.configuration.selected, ['streaming', 'latency']);
  assert.deepEqual(report.items.find(item => item.id === 'connectivity'), original.items.find(item => item.id === 'connectivity'));
  assert.equal(report.items.find(item => item.id === 'streaming')?.score, 100);
  assert.equal(report.items.find(item => item.id === 'latency')?.score, 100);
  assert.deepEqual(await service.read(first.id, first.accessToken), original);
  assert.deepEqual(validateQualityReport(report), report);
});

test('cancellation preserves completed unsupported conclusions while cancelling pending probes', async t => {
  const repository = memoryStore(); let running = false;
  const service = new QualityService({ repository, aiConcurrency: 2, ipDetector: async () => [], aiDetector: async (_input, ids, signal, onItem) => {
    if (ids.includes('iq-test')) { running = true; await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return []; }
    return ids.map(id => { const item = id === 'fingerprint-match' ? { id, status: 'unrun' as const, score: null, summary: '指纹库未覆盖。', reason: 'unsupported' as const } : { id, status: 'pass' as const, score: 100, summary: '通过。' }; onItem(item); return item; });
  } });
  t.after(() => service.onModuleDestroy());
  const handle = await service.create({ ...input, items: ['connectivity', 'streaming', 'fingerprint-match', 'iq-test'] }); service.onModuleInit();
  await until(() => running);
  const report = await service.cancel(handle.id, handle.accessToken);
  assert.equal(report.items.find(item => item.id === 'fingerprint-match')?.reason, 'unsupported');
  assert.equal(report.items.find(item => item.id === 'fingerprint-match')?.status, 'unrun');
  assert.equal(report.items.find(item => item.id === 'iq-test')?.status, 'cancelled');
  assert.equal(repository.reports.length, 1);
});

test('invalid detector evidence is rejected before mutating live results and still saves one valid failed report', async t => {
  const repository = memoryStore(); const snapshots: QualityReport[] = [];
  const service = new QualityService({ repository, ipDetector: async () => [], aiDetector: async (_input, ids, _signal, onItem) => {
    onItem({ id: ids[0], status: 'pass', score: 100, summary: '通过。', evidence: { attempts: [{ run: 1, outcome: 'pass' }, { run: 2, outcome: 'pass' }] } });
    return [];
  } });
  t.after(() => service.onModuleDestroy());
  const handle = await service.create(input); await service.subscribe(handle.id, handle.accessToken, report => snapshots.push(report));
  await service.runOnce(); await until(() => repository.reports.length === 1);
  assert.equal(repository.reports[0].state, 'failed');
  assert.ok(snapshots.every(report => report.items.every(item => !item.evidence)));
  assert.deepEqual(validateQualityReport(repository.reports[0]), repository.reports[0]);
});

test('callbacks from a finished unit cannot rewrite its results while sibling probes remain running', async t => {
  const repository = memoryStore(); let running = false; let late: (() => void) | undefined;
  const service = new QualityService({ repository, aiConcurrency: 2, ipDetector: async () => [], aiDetector: async (_input, ids, signal, onItem, onProgress) => {
    if (ids.includes('iq-test')) { running = true; await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return []; }
    late = () => { onItem({ id: 'connectivity', status: 'risk', score: 0, summary: '迟到的结果。' }); onProgress?.({ itemId: 'connectivity', stage: 'measurement', attempt: 1, total: 1, startedAt: new Date().toISOString() }); };
    return ids.map(id => ({ id, status: 'pass', score: 100, summary: '已完成。' }));
  } });
  t.after(() => service.onModuleDestroy());
  const handle = await service.create({ ...input, items: ['connectivity', 'streaming', 'iq-test'] }); service.onModuleInit();
  await until(() => running); assert.doesNotThrow(() => late!());
  const report = await service.read(handle.id, handle.accessToken);
  assert.equal(report.items.find(item => item.id === 'connectivity')?.score, 100); assert.deepEqual(report.progress, []);
  await service.cancel(handle.id, handle.accessToken); assert.equal(repository.reports.length, 1);
});

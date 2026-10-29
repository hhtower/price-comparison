import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAiQualityDetector } from '../src/quality/ai-quality-detector.js';
import type { AiQualityInput, QualityItemResult } from '../src/quality/quality.types.js';

const input: AiQualityInput = { kind: 'ai', endpoint: 'https://relay.example/v1', apiKey: 'private-test-key', model: 'target-model', mode: 'standard', runs: 2, items: [] };
const signal = () => new AbortController().signal;
function sse(content: string, extra: Record<string, unknown> = {}) {
  const { model = 'target-model', usage = { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }, finish_reason = 'stop', ...rest } = extra;
  return new Response(`data: ${JSON.stringify({ id: 'chatcmpl-test', model, choices: [{ delta: { content: content.slice(0, Math.floor(content.length / 2)) } }] })}\n\n` +
    `data: ${JSON.stringify({ id: 'chatcmpl-test', model, choices: [{ delta: { content: content.slice(Math.floor(content.length / 2)) }, finish_reason }], ...rest })}\n\n` +
    `data: ${JSON.stringify({ id: 'chatcmpl-test', model, choices: [], usage })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}
function detector(response: string | ((body: any, url: string, init: RequestInit) => Response | Promise<Response>), options: Record<string, unknown> = {}) {
  const sent: any[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    sent.push({ body, url: String(url), authorization: new Headers(init?.headers).get('authorization') });
    return typeof response === 'string' ? sse(response) : response(body, String(url), init!);
  };
  return { run: createAiQualityDetector({ fetchImpl, ...options }), sent };
}
async function result(id: string, response: string, options: Record<string, unknown> = {}) {
  const { run, sent } = detector(response, options);
  const output = await run(input, [id], signal(), () => {});
  return { item: output[0], sent };
}

test('AI basics use real streaming requests and publish only sanitized conclusions', async () => {
  const { run, sent } = detector('READY');
  const emitted: QualityItemResult[] = [];
  const results = await run(input, ['connectivity', 'model-identity', 'streaming', 'token-usage', 'latency'], signal(), item => emitted.push(item));
  assert.equal(results.length, 5);
  assert.ok(results.every(item => item.status === 'pass'));
  assert.deepEqual(emitted, results);
  assert.ok(sent.length >= 1);
  assert.ok(sent.every(item => item.body.stream === true));
  assert.ok(!JSON.stringify(results).includes(input.apiKey));
  assert.ok(!JSON.stringify(results).includes('READY'));
});

test('response model mismatch cannot pass identity', async () => {
  const { run } = detector(() => sse('READY', { model: 'different-model' }));
  assert.equal((await run(input, ['model-identity'], signal(), () => {}))[0]?.status, 'risk');
});

test('reasoning probes grade literal validated answers and reject malformed or extra output', async () => {
  for (const [id, good, bad] of [
    ['iq-test', '{"answer":21}', '{"answer":22}'],
    ['math-reasoning', '{"answer":10403}', '{"answer":10404}'],
    ['logic-reasoning', '{"answer":"B"}', '{"answer":"A"}'],
    ['instruction-following', 'READY-7', 'I will output READY-7'],
    ['structured-output', '{"label":"ok","count":3}', '{"label":"ok","count":"3"}'],
  ]) {
    assert.equal((await result(id, good)).item?.status, 'pass', id);
    assert.equal((await result(id, bad)).item?.status, 'risk', id);
    assert.equal((await result(id, 'private invalid answer')).item?.status, 'risk', id);
  }
});

test('tool calling requires an actual completed function call with validated arguments', async () => {
  const { run, sent } = detector(() => new Response(
    `data: ${JSON.stringify({ id: 't', model: input.model, choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'record_quality_sample', arguments: '{"code":"Q7",' } }] } }] })}\n\n` +
    `data: ${JSON.stringify({ id: 't', model: input.model, choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"value":17}' } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`));
  assert.equal((await run(input, ['tool-calling'], signal(), () => {}))[0]?.status, 'pass');
  assert.equal(sent[0].body.tools[0].function.name, 'record_quality_sample');
  assert.equal((await result('tool-calling', '{"code":"Q7","value":17}')).item?.status, 'risk');
});

test('long context uses a real long input and verifies its per-run reference', async () => {
  let size = 0;
  const { run } = detector(body => {
    const prompt = body.messages.at(-1).content;
    size = prompt.length;
    const code = prompt.match(/REFERENCE=([A-Z0-9-]+)/)?.[1];
    return sse(JSON.stringify({ code }));
  });
  assert.equal((await run(input, ['long-context'], signal(), () => {}))[0]?.status, 'pass');
  assert.ok(size > 20000);
});

test('multimodal and PDF probes send actual in-memory media and validate extracted content', async () => {
  let imageSeen = false, pdfSeen = false;
  const { run } = detector(body => {
    const parts = body.messages.at(-1).content;
    const picture = parts.find((part: any) => part.type === 'image_url');
    if (picture) { imageSeen = picture.image_url.url.startsWith('data:image/png;base64,'); return sse('{"color":"red"}'); }
    const file = parts.find((part: any) => part.type === 'file');
    const pdf = Buffer.from(file.file.file_data.split(',')[1], 'base64').toString('ascii');
    pdfSeen = pdf.startsWith('%PDF-') && pdf.includes('%%EOF');
    return sse(JSON.stringify({ code: pdf.match(/Reference (QP-[A-F0-9]+)/)?.[1] }));
  });
  assert.deepEqual((await run(input, ['multimodal', 'pdf'], signal(), () => {})).map(item => item.status), ['pass', 'pass']);
  assert.ok(imageSeen && pdfSeen);
});

test('multi-turn consistency sends actual prior messages and grades the recalled reference', async () => {
  let seenConversation = false;
  const { run } = detector(body => {
    if (body.messages.length === 1) return sse('ACK');
    seenConversation = body.messages[1].role === 'assistant' && body.messages[1].content === 'ACK';
    const code = body.messages[0].content.match(/REFERENCE=([A-Z0-9-]+)/)?.[1];
    return sse(JSON.stringify({ code }));
  });
  assert.equal((await run(input, ['multi-turn'], signal(), () => {}))[0]?.status, 'pass');
  assert.equal(seenConversation, true);
});

test('stability counts failed attempts as risk rather than silently retrying them', async () => {
  let attempts = 0;
  const { run } = detector(() => ++attempts === 2 ? new Response('private failure detail', { status: 503 }) : sse('READY-7'));
  const results = await run({ ...input, runs: 3 }, ['stability'], signal(), () => {});
  assert.equal(results[0]?.status, 'risk');
  assert.equal(results[0]?.score, 67);
  assert.equal(attempts, 3);
  assert.ok(!JSON.stringify(results).includes('private failure detail'));
});

test('missing usage and truncated or invalid streams cannot pass', async () => {
  for (const response of [() => sse('READY', { usage: null }), () => sse('READY', { finish_reason: 'length' })]) {
    const { run } = detector(response);
    assert.equal((await run(input, ['token-usage'], signal(), () => {}))[0]?.status, 'risk');
  }
});

test('cancellation retains completed results and cancels remaining items without sending them', async () => {
  const controller = new AbortController();
  const { run, sent } = detector('READY');
  const results = await run({ ...input, runs: 1 }, ['connectivity', 'math-reasoning', 'pdf'], controller.signal, () => { controller.abort(); });
  assert.deepEqual(results.map(item => item.status), ['pass', 'cancelled', 'cancelled']);
  assert.equal(sent.length, 1);
});

test('timeout and output overflow are sanitized failed checks with no retries', async () => {
  const slow = detector((_body, _url, init) => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })), { timeoutMs: 20 });
  assert.equal((await slow.run(input, ['connectivity'], signal(), () => {}))[0]?.status, 'risk');
  assert.equal(slow.sent.length, 1);
  const overflow = await result('connectivity', 'private-large-response', { maxOutputBytes: 4 });
  assert.equal(overflow.item?.status, 'risk');
  assert.ok(!JSON.stringify(overflow.item).includes('private-large-response'));
});

test('an in-flight abort cancels the request without publishing partial content', async () => {
  const controller = new AbortController();
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const { run, sent } = detector((_body, _url, init) => new Response(new ReadableStream({
    start(stream) {
      stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: 'c', model: input.model, choices: [{ delta: { content: 'private-partial-answer' } }] })}\n\n`));
      init.signal!.addEventListener('abort', () => stream.error(init.signal!.reason), { once: true });
      ready();
    },
  })));
  const emitted: QualityItemResult[] = [];
  const running = run(input, ['connectivity', 'math-reasoning'], controller.signal, item => emitted.push(item));
  await started;
  controller.abort(new Error('private-cancellation-detail'));
  const results = await running;
  assert.deepEqual(results.map(item => item.status), ['cancelled', 'cancelled']);
  assert.equal(sent.length, 1);
  assert.deepEqual(emitted, results);
  assert.ok(!JSON.stringify(results).includes('private-'));
});

test('JSON answers reject extra properties even if the expected answer is present', async () => {
  assert.equal((await result('math-reasoning', '{"answer":10403,"leaked":"private-response"}')).item.status, 'risk');
});

test('all modes honor requested shared observations without duplicating them per item', async () => {
  for (const [mode, runs, expected] of [['quick', 2, 2], ['standard', 2, 2], ['full', 2, 2], ['full', 5, 5]] as const) {
    const { run, sent } = detector('READY');
    const results = await run({ ...input, mode, runs }, ['connectivity', 'streaming', 'latency'], signal(), () => {});
    assert.ok(results.every(item => item.status === 'pass'));
    assert.equal(sent.length, expected, `${mode} with ${runs} requested runs`);
  }
});

test('latency with simultaneous first content and completion does not claim measured generation speed', async t => {
  t.mock.method(performance, 'now', () => 1000);
  const { run } = detector('token '.repeat(64));
  const [item] = await run({ ...input, runs: 1 }, ['latency'], signal(), () => {});
  assert.equal(item.status, 'pass');
  assert.match(item.summary, /未评价生成速度/);
});

test('a single content frame cannot establish generation speed even with a positive completion interval', async t => {
  const timestamps = [0, 100, 500];
  t.mock.method(performance, 'now', () => timestamps.shift() ?? 500);
  const { run } = detector(() => new Response(
    `data: ${JSON.stringify({ id: 'speed', model: input.model, choices: [{ delta: { content: 'token '.repeat(64) }, finish_reason: 'stop' }] })}\n\n` +
    `data: ${JSON.stringify({ id: 'speed', model: input.model, choices: [], usage: { prompt_tokens: 20, completion_tokens: 64, total_tokens: 84 } })}\n\ndata: [DONE]\n\n`));
  const [item] = await run({ ...input, runs: 1 }, ['latency'], signal(), () => {});
  assert.equal(item.status, 'pass');
  assert.match(item.summary, /未评价生成速度/);
});

test('insufficient output, duration or visible token evidence leaves generation speed unevaluated', async t => {
  let timestamps: number[] = [];
  t.mock.method(performance, 'now', () => timestamps.shift() ?? 500);
  for (const [content, completionTokens, reasoningTokens, duration] of [
    ['token '.repeat(64), 64, 0, 20],
    ['READY', 64, 0, 400],
    ['token '.repeat(64), 4, 0, 400],
    ['token '.repeat(64), 64, 60, 400],
  ] as const) {
    timestamps = [0, 100, 100 + duration];
    const { run } = detector(() => sse(content, { usage: { prompt_tokens: 20, completion_tokens: completionTokens, total_tokens: completionTokens + 20, completion_tokens_details: { reasoning_tokens: reasoningTokens } } }));
    const [item] = await run({ ...input, runs: 1 }, ['latency'], signal(), () => {});
    assert.equal(item.status, 'pass');
    assert.match(item.summary, /未评价生成速度/);
  }
});

test('sufficient streamed output measures normal speed and rejects slow generation independently of latency', async t => {
  let timestamps: number[] = [];
  t.mock.method(performance, 'now', () => timestamps.shift() ?? 500);
  for (const [duration, expected] of [[400, 'pass'], [10000, 'risk']] as const) {
    timestamps = [0, 100, 100 + duration];
    const { run } = detector(() => sse('token '.repeat(64), { usage: { prompt_tokens: 20, completion_tokens: 32, total_tokens: 52 } }));
    const [item] = await run({ ...input, runs: 1 }, ['latency'], signal(), () => {});
    assert.equal(item.status, expected);
    assert.doesNotMatch(item.summary, /未评价/);
  }
});

test('slow first content still fails when generation speed cannot be evaluated', async t => {
  const timestamps = [0, 6000, 6100];
  t.mock.method(performance, 'now', () => timestamps.shift() ?? 6100);
  const { run } = detector('READY');
  const [item] = await run({ ...input, runs: 1 }, ['latency'], signal(), () => {});
  assert.equal(item.status, 'risk');
  assert.match(item.summary, /未评价生成速度/);
});

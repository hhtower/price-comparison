import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStreamingCall, readAiConcurrency } from '../src/ai/llm-runtime.js';
import { classifyProviderRequestFailure as classify } from '../src/ai/standardization-state.js';

const environment = { AI_BASE_URL: 'https://model.invalid/v1', AI_API_KEY: 'test-key', AI_TIMEOUT_MS: '1000' };
const input = { model: 'model', messages: [{ role: 'user' as const, content: 'hello' }], responseFormat: { type: 'json_schema' }, signal: new AbortController().signal };

test('reads one positive integer concurrency value for every AI worker', () => {
  assert.equal(readAiConcurrency({ AI_CONCURRENCY: '4' }), 4);
  assert.equal(readAiConcurrency({}), 2);
  assert.throws(() => readAiConcurrency({ AI_CONCURRENCY: '0' }), /concurrency/i);
  assert.throws(() => readAiConcurrency({ AI_CONCURRENCY: '1.5' }), /concurrency/i);
  assert.throws(() => readAiConcurrency({ AI_CONCURRENCY: 'abc' }), /concurrency/i);
});

test('aggregates SSE content while forcing stream mode', async () => {
  let sent: any;
  const call = createStreamingCall(environment, async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: '{"ok":' } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'true}' }, finish_reason: 'stop' }] })}\n\n` +
      'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    );
  });
  const result = await call(input);
  assert.equal(sent.stream, true);
  assert.equal(result.content, '{"ok":true}');
  assert.equal(result.finishReason, 'stop');
  assert.ok(result.firstContentMs !== null);
});

test('fragmented length completion is confirmed invalid output and never retried', async () => {
  let attempts = 0;
  const events: unknown[] = [];
  const call = createStreamingCall(environment, async () => {
    attempts++;
    return eventStream([
      { choices: [{ delta: { content: '{"ok":' } }] },
      { choices: [{ delta: { content: 'true' }, finish_reason: 'length' }] },
    ]);
  }, { log: event => { events.push(event); } });
  await assert.rejects(call(input), (error: any) => {
    assert.match(error.message, /incomplete|length/i);
    assert.equal(error.retryClass, 'invalid_response');
    assert.equal(error.requestOutcome, 'confirmed');
    assert.equal(error.retryable, false);
    assert.deepEqual(classify(error), { retryClass: 'invalid_response', requestOutcome: 'confirmed', retryable: false });
    assert.equal('content' in error, false);
    return true;
  });
  assert.equal(attempts, 1);
  assert.equal(events.includes('ai.response_completed'), false);
});

test('rejects accumulated UTF-8 output beyond the configured byte limit and cancels the stream', async () => {
  let cancelled = false;
  let part = 0;
  const call = createStreamingCall({...environment,AI_MAX_OUTPUT_BYTES:'5'},async()=>new Response(new ReadableStream({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({choices:[{delta:{content:part++<2?'中':'x'},finish_reason:part>2?'stop':null}]})}\n\n`));
      if(part>2) controller.close();
    },
    cancel(){cancelled=true;},
  })));
  await assert.rejects(call(input),/output.*(limit|bytes)/i);
  assert.equal(cancelled,true);
});

test('accepts the exact output byte limit and validates the limit configuration', async () => {
  const fetchImpl=async()=>new Response(`data: ${JSON.stringify({choices:[{delta:{content:'中'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);
  assert.equal((await createStreamingCall({...environment,AI_MAX_OUTPUT_BYTES:'3'},fetchImpl)(input)).content,'中');
  assert.throws(()=>createStreamingCall({...environment,AI_MAX_OUTPUT_BYTES:'0'},fetchImpl),/configuration/i);
});

test('propagates caller cancellation to the fetch signal', async () => {
  const controller = new AbortController();
  let aborted = false;
  const call = createStreamingCall(environment, async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => { aborted = true; reject(init!.signal!.reason); }, { once: true });
  }));
  const running = call({ ...input, signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('cancelled'));
  await assert.rejects(running, /cancelled/i);
  assert.equal(aborted, true);
});

test('maps AI_THINKING to the endpoint thinking control and validates values', async () => {
  let sent: any;
  const fetchImpl = async (_url: unknown, init?: { body?: unknown }) => {
    sent = JSON.parse(String(init?.body));
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '{}' }, finish_reason: 'stop' }] })}\n\n`);
  };
  await createStreamingCall({ ...environment, AI_THINKING: 'disabled' }, fetchImpl as typeof fetch)(input);
  assert.deepEqual(sent.thinking, { type: 'disabled' });
  await createStreamingCall({ ...environment, AI_THINKING: 'auto' }, fetchImpl as typeof fetch)(input);
  assert.equal('thinking' in sent, false);
  assert.throws(() => createStreamingCall({ ...environment, AI_THINKING: 'yes' }, fetchImpl as typeof fetch), /configuration/i);
});

function eventStream(chunks: unknown[]) {
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}

function failedResponse(events: unknown[][]) {
  assert.equal(events.some(([event]) => event === 'ai.response_completed'), false);
  const failures = events.filter(([event]) => event === 'ai.response_failed');
  assert.equal(failures.length, 1);
  const metadata = failures[0][1] as Record<string, any>;
  assert.ok(Number.isInteger(metadata.responseMs) && metadata.responseMs >= 0);
  assert.ok(metadata.firstContentMs === null || (Number.isInteger(metadata.firstContentMs) && metadata.firstContentMs >= 0));
  assert.deepEqual(Object.keys(metadata).sort(), [
    'model', 'parentJobId', 'batchId', 'responseModel', 'responseId', 'responseMs', 'firstContentMs',
    'chunkCount', 'contentChunks', 'outputBytes', 'finishReason', 'usage', 'failureReason',
  ].sort());
  return metadata;
}

const diagnosticContext = {
  parentJobId: 'job-1', batchId: 'batch-2', model: 'untrusted-context-model',
  messages: 'private prompt', apiKey: 'private credential', baseURL: 'https://private.invalid',
  content: 'private response', error: { message: 'private error body' },
  responseMs: -1, outputBytes: -1, failureReason: 'spoofed',
};

test('failure diagnostics distinguish clean missing completion with body, empty choices or no chunks', async () => {
  for (const chunks of [
    [{ id: 'response-1', model: 'actual-model', choices: [{ delta: { content: '中private response' } }] }],
    [{ id: 'response-1', model: 'actual-model', choices: [] }],
    [],
  ]) {
    const events: unknown[][] = [];
    const call = createStreamingCall(environment, async () => eventStream(chunks), { log: (...args) => { events.push(args); } });
    await assert.rejects(call({ ...input, context: diagnosticContext }), /missing finish reason/);
    const metadata = failedResponse(events);
    assert.equal(metadata.failureReason, 'missing_finish_reason');
    assert.equal(metadata.model, 'model');
    assert.equal(metadata.parentJobId, 'job-1');
    assert.equal(metadata.batchId, 'batch-2');
    assert.equal(metadata.responseModel, chunks.length ? 'actual-model' : null);
    assert.equal(metadata.responseId, chunks.length ? 'response-1' : null);
    assert.equal(metadata.chunkCount, chunks.length);
    assert.equal(metadata.contentChunks, chunks[0]?.choices.length ? 1 : 0);
    assert.equal(metadata.outputBytes, chunks[0]?.choices.length ? 19 : 0);
    assert.equal(metadata.firstContentMs === null, !chunks[0]?.choices.length);
    assert.equal(metadata.finishReason, null);
    assert.equal(metadata.usage, null);
    assert.doesNotMatch(JSON.stringify(events.filter(([event]) => event === 'ai.response_failed')), /private|untrusted|spoofed|test-key|model\.invalid/);
  }
});

test('completed invalid responses log validation failure and only valid usage', async () => {
  for (const finalUsage of [
    undefined,
    { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    { prompt_tokens: 1, completion_tokens: 2, total_tokens: 20 },
    { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, completion_tokens_details: { reasoning_tokens: 4 } },
  ]) {
    const events: unknown[][] = [];
    const validUsage = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 };
    const chunks = [
      { choices: [{ delta: { content: 'private response' }, finish_reason: 'length' }], usage: finalUsage ? validUsage : undefined },
      ...(finalUsage ? [{ choices: [], usage: finalUsage }] : []),
    ];
    const call = createStreamingCall(environment, async () => eventStream(chunks), { log: (...args) => { events.push(args); } });
    await assert.rejects(call({ ...input, context: diagnosticContext }), (error: any) => error.retryClass === 'invalid_response');
    const metadata = failedResponse(events);
    assert.equal(metadata.failureReason, 'validation_error');
    assert.equal(metadata.finishReason, 'length');
    assert.equal(metadata.outputBytes, 16);
    assert.deepEqual(metadata.usage, finalUsage?.total_tokens === 3 && !('completion_tokens_details' in finalUsage)
      ? { promptTokens: 1, completionTokens: 2, totalTokens: 3 } : null);
  }
});

test('timeout and caller cancellation diagnostics preserve abort reasons and partial counters', async () => {
  for (const cancel of [false, true]) {
    for (const partial of [false, true]) {
      const controller = new AbortController();
      const reason = new Error('private cancellation reason');
      const events: unknown[][] = [];
      let fetchSignal: AbortSignal | undefined;
      const call = createStreamingCall({ ...environment, AI_TIMEOUT_MS: '25' }, async (_url, init) => {
        fetchSignal = init!.signal!;
        return new Response(new ReadableStream({
          start(stream) {
            if (partial) stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"private response"}}]}\n\n'));
            fetchSignal!.addEventListener('abort', () => stream.error(fetchSignal!.reason), { once: true });
          },
        }));
      }, { log: (...args) => { events.push(args); if (cancel && args[0] === 'ai.first_content') controller.abort(reason); } });
      const running = call({ ...input, signal: controller.signal, context: diagnosticContext });
      if (cancel && !partial) {
        await new Promise(resolve => setImmediate(resolve));
        controller.abort(reason);
      }
      await assert.rejects(running, (error: unknown) => cancel ? error === reason : error instanceof Error && /timed out/.test(error.message));
      assert.equal(fetchSignal!.aborted, true);
      const metadata = failedResponse(events);
      assert.equal(metadata.failureReason, cancel ? 'cancelled' : 'timeout');
      assert.equal(metadata.chunkCount, partial ? 1 : 0);
      assert.equal(metadata.contentChunks, partial ? 1 : 0);
      assert.equal(metadata.outputBytes, partial ? 16 : 0);
      assert.equal(metadata.finishReason, null);
      assert.equal(metadata.usage, null);
      assert.doesNotMatch(JSON.stringify(events.filter(([event]) => event === 'ai.response_failed')), /private/);
    }
  }
});

test('HTTP, provider and transport diagnostics never include error bodies or response text', async () => {
  for (const scenario of ['http', 'provider', 'transport', 'connection', 'invalid'] as const) {
    const events: unknown[][] = [];
    const original = new Error('private transport error body');
    const call = createStreamingCall(environment, async () => {
      if (scenario === 'http') return new Response(JSON.stringify({ error: { message: 'private HTTP body', code: 'private-code' } }), { status: 500 });
      if (scenario === 'provider') return eventStream([{ error: { message: 'private provider body', code: 'private-code' } }]);
      if (scenario === 'connection') throw original;
      if (scenario === 'invalid') return eventStream([{ id: 'response-1', model: 'actual-model', choices: 'private invalid choices' }]);
      let pulls = 0;
      return new Response(new ReadableStream({
        async pull(stream) {
          if (pulls++ === 0) stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"private response"},"finish_reason":"stop"}]}\n\n'));
          else {
            await new Promise(resolve => setImmediate(resolve));
            stream.error(original);
          }
        },
      }));
    }, { log: (...args) => { events.push(args); } });
    await assert.rejects(call({ ...input, context: diagnosticContext }), (error: any) => {
      if (scenario === 'transport') assert.equal(error, original);
      if (scenario === 'connection') assert.equal(error.cause, original);
      if (scenario === 'http') assert.equal(error.status, 500);
      return true;
    });
    const metadata = failedResponse(events);
    assert.equal(metadata.failureReason, scenario === 'invalid' ? 'validation_error'
      : scenario === 'http' ? 'http_error' : scenario === 'provider' ? 'provider_error' : 'transport_error');
    assert.equal(metadata.chunkCount, scenario === 'transport' || scenario === 'invalid' ? 1 : 0);
    assert.equal(metadata.responseId, scenario === 'invalid' ? 'response-1' : null);
    assert.equal(metadata.responseModel, scenario === 'invalid' ? 'actual-model' : null);
    assert.equal(metadata.finishReason, scenario === 'transport' ? 'stop' : null);
    assert.equal(metadata.usage, null);
    assert.doesNotMatch(JSON.stringify(events.filter(([event]) => event === 'ai.response_failed')), /private|test-key|model\.invalid/);
  }
});

test('failure logger errors preserve the original exception and clear the deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const combine = t.mock.method(AbortSignal, 'any');
  const original = new Error('original stream error');
  let logged = 0;
  const call = createStreamingCall(environment, async () => new Response(new ReadableStream({ pull() { throw original; } })),
    { log: event => { if (event === 'ai.response_failed') { logged++; throw new Error('logger failed'); } } });
  await assert.rejects(call(input), error => error === original);
  assert.equal(logged, 1);
  const deadlineSignal = [...combine.mock.calls[0].arguments[0]][1];
  t.mock.timers.tick(2000);
  assert.equal(deadlineSignal.aborted, false);
});

test('failure diagnostics retain valid usage received after invalid content', async () => {
  const events: unknown[][] = [];
  const call = createStreamingCall(environment, async () => eventStream([
    { choices: [{ delta: { content: 123 }, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
  ]), { log: (...args) => { events.push(args); } });
  await assert.rejects(call({ ...input, context: diagnosticContext }), /invalid content/);
  assert.deepEqual(failedResponse(events).usage, { promptTokens: 1, completionTokens: 2, totalTokens: 3 });
});

test('preflight cancellation and invalid request diagnostics preserve rejection without sending', async () => {
  for (const cancelled of [false, true]) {
    const controller = new AbortController();
    const reason = new Error('private preflight cancellation');
    if (cancelled) controller.abort(reason);
    let requests = 0;
    const events: unknown[][] = [];
    const call = createStreamingCall(environment, async () => { requests++; return eventStream([]); },
      { log: (...args) => { events.push(args); } });
    await assert.rejects(call({ ...input, signal: controller.signal, maxOutputTokens: cancelled ? undefined : 0, context: diagnosticContext }),
      (error: unknown) => cancelled ? error === reason : error instanceof Error && /token limit/.test(error.message));
    assert.equal(requests, 0);
    const metadata = failedResponse(events);
    assert.equal(metadata.failureReason, cancelled ? 'cancelled' : 'validation_error');
    assert.equal(metadata.firstContentMs, null);
    assert.equal(metadata.chunkCount, 0);
    assert.equal(metadata.contentChunks, 0);
    assert.equal(metadata.outputBytes, 0);
    assert.equal(metadata.finishReason, null);
    assert.equal(metadata.usage, null);
  }
});

test('failure diagnostics omit malformed finish metadata and retain explicit policy finish reasons', async () => {
  for (const finishReason of ['content_filter', 'private response', { message: 'private error body' }]) {
    const events: unknown[][] = [];
    const call = createStreamingCall(environment, async () => eventStream([
      { choices: [{ delta: {}, finish_reason: finishReason }] },
    ]), { log: (...args) => { events.push(args); } });
    await assert.rejects(call({ ...input, context: diagnosticContext }));
    const metadata = failedResponse(events);
    assert.equal(metadata.finishReason, finishReason === 'content_filter' ? 'content_filter' : null);
    assert.equal(metadata.failureReason, finishReason === 'content_filter' ? 'provider_error' : 'validation_error');
    assert.doesNotMatch(JSON.stringify(events), /private/);
  }
});

for (const malformed of [
  { name: 'null chunk', chunk: null },
  { name: 'object tool_calls', chunk: { choices: [{ delta: { tool_calls: { body: 'private response body' } }, finish_reason: 'tool_calls' }] } },
  { name: 'null tool entry', chunk: { choices: [{ delta: { tool_calls: [null] }, finish_reason: 'tool_calls' }] } },
]) {
  test(`malformed ${malformed.name} logs validation failure with unknown outcome and no retry`, async () => {
    let requests = 0;
    const events: unknown[][] = [];
    const call = createStreamingCall(environment, async () => {
      requests++;
      return eventStream([malformed.chunk]);
    }, { log: (...args) => { events.push(args); } });
    await assert.rejects(call({ ...input, context: diagnosticContext }), (error: unknown) => {
      assert.deepEqual(classify(error), { retryClass: 'provider_unknown', requestOutcome: 'unknown', retryable: false });
      return true;
    });
    assert.equal(requests, 1);
    const metadata = failedResponse(events);
    assert.equal(metadata.failureReason, 'validation_error');
    assert.equal(metadata.chunkCount, 1);
    assert.equal(metadata.contentChunks, 0);
    assert.equal(metadata.outputBytes, 0);
    assert.equal(metadata.usage, null);
    assert.doesNotMatch(JSON.stringify(events.filter(([event]) => event === 'ai.response_failed')), /private|test-key|model\.invalid/);
  });
}

test('generic streaming call aggregates fragmented tools, model identity and final usage', async () => {
  let sent: any;
  const call = createStreamingCall(environment, async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return eventStream([
      { id: 'chatcmpl-1', model: 'model', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'record', arguments: '{"value":' } }] } }] },
      { id: 'chatcmpl-1', model: 'model', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '7}' } }] }, finish_reason: 'tool_calls' }] },
      { id: 'chatcmpl-1', model: 'model', choices: [], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20, completion_tokens_details: { reasoning_tokens: 3 } } },
    ]);
  });
  const result = await call({ ...input, tools: [{ type: 'function', function: { name: 'record', parameters: { type: 'object' } } }], toolChoice: { type: 'function', function: { name: 'record' } }, includeUsage: true });
  assert.equal(sent.stream, true);
  assert.equal(sent.stream_options.include_usage, true);
  assert.equal(sent.tools[0].function.name, 'record');
  assert.deepEqual(result.toolCalls, [{ id: 'call-1', type: 'function', function: { name: 'record', arguments: '{"value":7}' } }]);
  assert.deepEqual(result.usage, { promptTokens: 12, completionTokens: 8, totalTokens: 20, reasoningTokens: 3 });
  assert.equal(result.responseModel, 'model');
  assert.equal(result.responseId, 'chatcmpl-1');
  assert.equal(result.chunkCount, 3);
  assert.ok(result.firstContentMs !== null);
});

test('generic streaming call forwards multimodal message parts without losing payloads', async () => {
  let sent: any;
  const call = createStreamingCall(environment, async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return eventStream([{ choices: [{ delta: { content: 'red' }, finish_reason: 'stop' }] }]);
  });
  await call({ ...input, messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe the image' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA=' } }] }] });
  assert.equal(sent.messages[0].content[1].image_url.url, 'data:image/png;base64,AAA=');
});

test('generic streaming call rejects incomplete and invalid JSON tool arguments', async () => {
  for (const args of ['{"value":', '[1]', 'null']) {
    const call = createStreamingCall(environment, async () => eventStream([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'record', arguments: args } }] }, finish_reason: 'tool_calls' }] }]));
    await assert.rejects(call(input), (error: any) => {
      assert.match(error.message, /tool|JSON/i);
      assert.deepEqual(classify(error), { retryClass: 'invalid_response', requestOutcome: 'confirmed', retryable: false });
      return true;
    });
  }
});

test('generic streaming call enforces the output byte budget on tool arguments', async () => {
  const call = createStreamingCall({ ...environment, AI_MAX_OUTPUT_BYTES: '5' }, async () => eventStream([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'x', type: 'function', function: { name: 'f', arguments: '{"x":12}' } }] }, finish_reason: 'tool_calls' }] }]));
  await assert.rejects(call(input), /output.*(limit|bytes)/i);
});

test('timeout aborts the underlying request and rejects without retrying', async () => {
  let attempts = 0;
  const call = createStreamingCall({ ...environment, AI_TIMEOUT_MS: '20' }, async (_url, init) => {
    attempts++;
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
  });
  await assert.rejects(call(input), /timed out/i);
  assert.equal(attempts, 1);
});

test('an already cancelled signal never sends a request', async () => {
  const controller = new AbortController();
  controller.abort(new Error('already cancelled'));
  let attempts = 0;
  const call = createStreamingCall(environment, async () => { attempts++; return eventStream([]); });
  await assert.rejects(call({ ...input, signal: controller.signal }), /already cancelled/i);
  assert.equal(attempts, 0);
});

test('generic streaming call rejects invalid usage and missing stream choices', async () => {
  for (const chunk of [
    { choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 20 } },
    { choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, completion_tokens_details: { reasoning_tokens: 4 } } },
    { content: 'not a chat completion event' },
  ]) {
    const call = createStreamingCall(environment, async () => eventStream([chunk]));
    await assert.rejects(call(input), /invalid/i);
  }
});

test('invalid usage or content is confirmed only after an explicit completion', async () => {
  for (const invalid of [
    { usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 20 }, content: 'x' },
    { usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, completion_tokens_details: { reasoning_tokens: 4 } }, content: 'x' },
    { content: 123 },
  ]) {
    for (const finishReason of ['stop', undefined]) {
      const call = createStreamingCall(environment, async () => eventStream([{
        choices: [{ delta: { content: invalid.content }, finish_reason: finishReason }], usage: invalid.usage,
      }]));
      await assert.rejects(call(input), (error: unknown) => {
        assert.deepEqual(classify(error), finishReason
          ? { retryClass: 'invalid_response', requestOutcome: 'confirmed', retryable: false }
          : { retryClass: 'provider_unknown', requestOutcome: 'unknown', retryable: false });
        return true;
      });
    }
  }
  const call = createStreamingCall(environment, async () => eventStream([
    { choices: [{ delta: { content: '{}' }, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 20 } },
  ]));
  await assert.rejects(call(input), (error: unknown) => {
    assert.deepEqual(classify(error), { retryClass: 'invalid_response', requestOutcome: 'confirmed', retryable: false });
    return true;
  });
});

for (const invalid of [
  { name: 'usage totals', content: 'x', usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 20 } },
  { name: 'reasoning usage', content: 'x', usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, completion_tokens_details: { reasoning_tokens: 4 } } },
  { name: 'content', content: 123, usage: undefined },
]) {
  for (const finishReason of ['length', 'stop']) {
    for (const failure of ['reset', 'timeout', 'cancel']) {
      test(`invalid ${invalid.name} with ${finishReason} remains unknown after ${failure}`, async () => {
        const controller = new AbortController();
        let attempts = 0;
        let pulls = 0;
        const events: unknown[] = [];
        const call = createStreamingCall({ ...environment, AI_TIMEOUT_MS: failure === 'timeout' ? '50' : '1000' }, async (_url, init) => {
          attempts++;
          return new Response(new ReadableStream({
            start(stream) {
              init!.signal!.addEventListener('abort', () => stream.error(init!.signal!.reason), { once: true });
            },
            async pull(stream) {
              if (pulls++ === 0) stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
                choices: [{ delta: { content: invalid.content }, finish_reason: finishReason }], usage: invalid.usage,
              })}\n\n`));
              else if (failure !== 'timeout') {
                await new Promise(resolve => setImmediate(resolve));
                if (failure === 'cancel') controller.abort(new Error('caller cancelled after invalid output'));
                else stream.error(new Error('connection reset after invalid output'));
              }
            },
          }));
        }, { log: event => { events.push(event); } });
        await assert.rejects(call({ ...input, signal: controller.signal }), (error: any) => {
          assert.match(error.message, failure === 'reset' ? /connection reset/ : failure === 'timeout' ? /timed out/ : /caller cancelled/);
          assert.deepEqual(classify(error), { retryClass: 'provider_unknown', requestOutcome: 'unknown', retryable: false });
          assert.equal('content' in error, false);
          return true;
        });
        assert.equal(attempts, 1);
        assert.equal(events.includes('ai.response_completed'), false);
      });
    }
  }
}

for (const invalid of [
  { name: 'usage', content: 'x', usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 20 } },
  { name: 'content', content: 123, usage: undefined },
]) {
  for (const output of ['content', 'tools']) {
    test(`deferred invalid ${invalid.name} still aborts oversized subsequent ${output} as unknown`, async () => {
      let attempts = 0;
      const events: unknown[][] = [];
      const call = createStreamingCall({ ...environment, AI_MAX_OUTPUT_BYTES: '5' }, async () => {
        attempts++;
        return eventStream([
          { choices: [{ delta: { content: invalid.content } }], usage: invalid.usage },
          { choices: [{ delta: output === 'content' ? { content: '123456' }
            : { tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'f', arguments: '123456' } }] },
          finish_reason: output === 'content' ? 'stop' : 'tool_calls' }] },
        ]);
      }, { log: (...args) => { events.push(args); } });
      await assert.rejects(call(input), (error: any) => {
        assert.match(error.message, /output.*(limit|bytes)/i);
        assert.deepEqual(classify(error), { retryClass: 'provider_unknown', requestOutcome: 'unknown', retryable: false });
        assert.equal('content' in error, false);
        return true;
      });
      assert.equal(attempts, 1);
      assert.equal(events.some(([event]) => event === 'ai.first_content' || event === 'ai.response_completed'), false);
      const failures = events.filter(([event]) => event === 'ai.response_failed');
      assert.equal(failures.length, 1);
      const metadata = failures[0][1] as Record<string, unknown>;
      assert.equal(metadata.failureReason, 'validation_error');
      assert.equal(metadata.usage, null);
      assert.equal(metadata.firstContentMs, null);
      assert.equal(metadata.contentChunks, 0);
      assert.equal(metadata.chunkCount, 2);
      assert.equal(metadata.outputBytes, output === 'content' ? (invalid.name === 'usage' ? 7 : 6) : (invalid.name === 'usage' ? 9 : 8));
    });
  }
}

test('missing finish markers and interrupted SSE frames remain unknown', async () => {
  for (const body of [
    'data: {"choices":[{"delta":{"content":"{}"}}]}\n\ndata: [DONE]\n\n',
    'data: {"choices":[{"delta":{"content":"{}"}}]}\n\ndata: {"choices":',
  ]) {
    const call = createStreamingCall(environment, async () => new Response(body));
    await assert.rejects(call(input), (error: unknown) => {
      assert.deepEqual(classify(error), { retryClass: 'provider_unknown', requestOutcome: 'unknown', retryable: false });
      return true;
    });
  }
});

test('transport interruption remains unknown even after observing a finish reason', async () => {
  for (const finishReason of [undefined, 'length', 'stop']) {
    let pulls = 0;
    const call = createStreamingCall(environment, async () => new Response(new ReadableStream({
      async pull(controller) {
        if (pulls++ === 0) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
          choices: [{ delta: { content: '{"partial":' }, finish_reason: finishReason }],
        })}\n\n`));
        else {
          await new Promise(resolve => setImmediate(resolve));
          controller.error(new Error('connection reset after chunk'));
        }
      },
    })));
    await assert.rejects(call(input), (error: any) => {
      assert.match(error.message, /connection reset/i);
      assert.deepEqual(classify(error), { retryClass: 'provider_unknown', requestOutcome: 'unknown', retryable: false });
      return true;
    });
  }
});

test('stream timeout or caller cancellation remains unknown after partial or length output', async () => {
  for (const finishReason of [undefined, 'length']) {
    for (const cancel of [false, true]) {
      const controller = new AbortController();
      let attempts = 0;
      const call = createStreamingCall({ ...environment, AI_TIMEOUT_MS: '30' }, async (_url, init) => {
        attempts++;
        return new Response(new ReadableStream({
          start(stream) {
            stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
              choices: [{ delta: { content: '{"partial":' }, finish_reason: finishReason }],
            })}\n\n`));
            init!.signal!.addEventListener('abort', () => stream.error(init!.signal!.reason), { once: true });
          },
        }));
      }, { log: () => { if (cancel) controller.abort(new Error('caller cancelled')); } });
      await assert.rejects(call({ ...input, signal: controller.signal }), (error: any) => {
        assert.match(error.message, cancel ? /caller cancelled/i : /timed out/i);
        assert.deepEqual(classify(error), { retryClass: 'provider_unknown', requestOutcome: 'unknown', retryable: false });
        return true;
      });
      assert.equal(attempts, 1);
    }
  }
});

test('streamed responses reject conflicting model or message identities', async () => {
  for (const last of [{ id: 'changed', model: 'model' }, { id: 'same', model: 'changed-model' }]) {
    const call = createStreamingCall(environment, async () => eventStream([
      { id: 'same', model: 'model', choices: [{ delta: { content: 'A' } }] },
      { ...last, choices: [{ delta: { content: 'B' }, finish_reason: 'stop' }] },
    ]));
    await assert.rejects(call(input), /identity|model|message/i);
  }
});

test('a later finish event cannot hide truncation or append content after completion', async () => {
  for (const firstFinish of ['length', 'stop']) {
    const call = createStreamingCall(environment, async () => eventStream([
      { choices: [{ delta: { content: 'A' }, finish_reason: firstFinish }] },
      { choices: [{ delta: { content: 'B' }, finish_reason: 'stop' }] },
    ]));
    await assert.rejects(call(input), /complet|finish/i);
  }
});

test('tool fragments require the tool completion finish reason', async () => {
  const call = createStreamingCall(environment, async () => eventStream([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }] }, finish_reason: 'stop' }] }]));
  await assert.rejects(call(input), /tool.*finish|incomplete/i);
});

test('explicit streaming refusal is confirmed terminal policy rejection', async () => {
  for (const chunk of [
    { choices: [{ delta: { refusal: 'Cannot provide this content' }, finish_reason: 'stop' }] },
    { choices: [{ delta: { content: '' }, finish_reason: 'content_filter' }] },
  ]) {
    let attempts = 0;
    const call = createStreamingCall(environment, async () => { attempts++; return eventStream([chunk]); });
    await assert.rejects(call(input), (error: any) => error.retryClass === 'provider_policy_rejection' && error.requestOutcome === 'confirmed' && error.retryable === false);
    assert.equal(attempts, 1);
  }
});

test('output token allowance is sent to the provider through the shared transport', async () => {
  let sent: any;
  const call = createStreamingCall(environment, async (_url, init) => { sent = JSON.parse(String(init?.body)); return eventStream([{ choices: [{ delta: { content: '{}' }, finish_reason: 'stop' }] }]); });
  await call({ ...input, maxOutputTokens: 1024 } as any);
  assert.equal(sent.max_tokens, 1024);
});

test('GPT Sol sends a completion budget and explicit reasoning without DeepSeek thinking', async () => {
  let sent: any;
  const call = createStreamingCall({ ...environment, AI_THINKING: 'disabled' }, async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return eventStream([{ choices: [{ delta: { content: '{}' }, finish_reason: 'stop' }] }]);
  });
  await call({ ...input, model: 'gpt-6.1-sol', maxOutputTokens: 32768 });
  assert.equal(sent.max_completion_tokens, 32768);
  assert.equal(sent.reasoning_effort, 'medium');
  assert.equal('max_tokens' in sent, false);
  assert.equal('thinking' in sent, false);
});

test('GLM 5.3 defaults to low reasoning with thinking enabled through the streaming transport', async () => {
  let sent: any;
  const call = createStreamingCall({ ...environment, AI_THINKING: 'disabled' }, async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return eventStream([{ choices: [{ delta: { content: '{}' }, finish_reason: 'stop' }] }]);
  });
  for (const model of ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flash-2026-10-22']) {
    await call({ ...input, model, maxOutputTokens: 1024 });
    assert.equal(sent.reasoning_effort, 'low');
    assert.deepEqual(sent.thinking, { type: 'enabled' });
    assert.equal(sent.max_tokens, 1024);
    assert.equal(sent.stream, true);
    assert.equal('max_completion_tokens' in sent, false);
  }
});

test('GLM 5.3 honors each supported explicit reasoning effort', async () => {
  for (const effort of ['low', 'high', 'max']) {
    let sent: any;
    const call = createStreamingCall({ ...environment, AI_REASONING_EFFORT: ` ${effort.toUpperCase()} ` }, async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return eventStream([{ choices: [{ delta: { content: '{}' }, finish_reason: 'stop' }] }]);
    });
    await call({ ...input, model: 'glm-5.3-flash' });
    assert.equal(sent.reasoning_effort, effort);
    assert.deepEqual(sent.thinking, { type: 'enabled' });
  }
});

test('GLM 5.3 rejects unsupported reasoning efforts before sending a request', async () => {
  let attempts = 0;
  for (const effort of ['medium', 'xhigh']) {
    const call = createStreamingCall({ ...environment, AI_REASONING_EFFORT: effort }, async () => {
      attempts++;
      return eventStream([]);
    });
    await assert.rejects(call({ ...input, model: 'glm-5.3-flash' }), /AI_REASONING_EFFORT.*GLM/u);
  }
  assert.equal(attempts, 0);
});

test('Sol reasoning configuration supports snapshots and leaves other models unchanged', async () => {
  let sent: any;
  const call = createStreamingCall({ ...environment, AI_REASONING_EFFORT: ' LOW ', AI_THINKING: 'disabled' }, async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return eventStream([{ choices: [{ delta: { content: '{}' }, finish_reason: 'stop' }] }]);
  });
  for (const model of ['gpt-6.1-sol', 'gpt-6.1-sol-2026-10-07']) {
    await call({ ...input, model });
    assert.equal(sent.reasoning_effort, 'low');
    assert.equal('max_completion_tokens' in sent, false);
    assert.equal('thinking' in sent, false);
  }
  await call({ ...input, model: 'gpt-4o', maxOutputTokens: 1024 });
  assert.equal(sent.max_completion_tokens, 1024);
  assert.equal('reasoning_effort' in sent, false);
  for (const model of ['deepseek-flash', 'glm-4.7', 'glm-5.2']) {
    await call({ ...input, model, maxOutputTokens: 1024 });
    assert.equal(sent.max_tokens, 1024);
    assert.deepEqual(sent.thinking, { type: 'disabled' });
    assert.equal('reasoning_effort' in sent, false);
    assert.equal('max_completion_tokens' in sent, false);
  }
});

test('invalid reasoning and output budgets fail before sending a request', async () => {
  let sent = 0;
  const fetchImpl = async () => { sent++; return eventStream([]); };
  for (const effort of ['none', 'minimal', 'auto', 'unknown']) {
    assert.throws(() => createStreamingCall({ ...environment, AI_REASONING_EFFORT: effort }, fetchImpl), /AI_REASONING_EFFORT/);
  }
  const call = createStreamingCall(environment, fetchImpl);
  for (const maxOutputTokens of [0, -1, 1.5, NaN]) {
    await assert.rejects(call({ ...input, model: 'gpt-6.1-sol', maxOutputTokens }), /token limit/i);
  }
  assert.equal(sent, 0);
});

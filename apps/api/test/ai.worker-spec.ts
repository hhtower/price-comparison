import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAiWorker, createOpenAiModelCall, buildStandardizationRequest, estimateStandardizationRequest, readStandardizationRequestLimits } from '../src/ai/ai.worker.js';
import type { ClaimedJob } from '../src/jobs/jobs.repository.js';

const claimed = (step: 'request' | 'publish' = 'request'): ClaimedJob => ({
  kind: 'ai_batch', id: 7n, attempts: 1n, claimed_by: 'worker',
  lease_until: new Date(Date.now() + 60_000),
  row: { job_id: 3n, step, claim_token: 'claim', input_bytes: 123n },
});

function service(item: ClaimedJob | null = claimed()) {
  return {
    item, completed: 0, failed: 0, requeued: 0,
    failureOptions: undefined as { retry?: boolean; retryClass?: string | null; backoffMs?: number } | undefined,
    async claimNext() { const value = this.item; this.item = null; return value; },
    async heartbeat() {},
    async complete() { this.completed += 1; },
    async fail(_kind: string, _id: bigint, _workerId: string, _error: string, options?: { retry?: boolean; retryClass?: string | null; backoffMs?: number }) {
      this.failed += 1; this.failureOptions = options;
    },
    async requeue() { this.requeued += 1; },
  };
}

const request = {
  jobId: 3n,
  model: 'configured',
  candidates: [{ id: '91', family: 'openai', product: 'chatgpt', tier: 'plus', aliases: [] }],
  inputs: [
    { productId: 11n, fingerprint: 'a'.repeat(64), payload: { id: '11', name: 'ChatGPT Plus monthly' }, candidateStandardProductIds: ['91'] },
    { productId: 12n, fingerprint: 'b'.repeat(64), payload: { id: '12', name: 'Claude Team annual' }, candidateStandardProductIds: [] },
    { productId: 13n, fingerprint: 'c'.repeat(64), payload: { id: '13', name: 'unclear listing' }, candidateStandardProductIds: [] },
  ],
};

const citation = (quote: string) => ({ path: 'name', quote });
const rawIdentity = (family: string, product: string, tier: string) => ({
  family, product, tier, reason: 'identity follows the listing', evidence: [citation(product + ' ' + tier)],
});
const rawItem = (id: string, identity: ReturnType<typeof rawIdentity> | null, candidateRef: string | null) => ({
  id, ...(identity ? { action: 'create_identity', identity } : { action: 'reuse_candidate', candidateRef }),
  ruleIds: ['identity-v1'], evidence: [citation(request.inputs.find(input => String(input.productId) === id)!.payload.name)], reason: 'classified from evidence',
});
const validResponse = {
  items: [
    rawItem('11', null, 'i1c1'),
    rawItem('12', rawIdentity('Anthropic', 'Claude', 'Team'), null),
  ],
};

function modelCall(body: unknown, options: { status?: number; finishReason?: string; split?: number } = {}) {
  return createOpenAiModelCall({ getBatchRequest: async () => request } as never, {
    AI_BASE_URL: 'https://model.invalid/v1', AI_API_KEY: 'secret', AI_MODEL: 'configured', AI_TIMEOUT_MS: '1000',
  }, async (_url, init) => {
    if (options.status && options.status !== 200) return new Response(JSON.stringify(body), { status: options.status });
    const content = typeof body === 'string' ? body : JSON.stringify(body);
    const split = options.split ?? content.length;
    const chunks = [content.slice(0, split), content.slice(split)].filter(Boolean);
    const sse = chunks.map((part, index) => `data: ${JSON.stringify({ choices: [{ delta: { content: part }, ...(index === chunks.length - 1 ? { finish_reason: options.finishReason ?? 'stop' } : {}) }] })}\n\n`).join('') + 'data: [DONE]\n\n';
    assert.equal(JSON.parse(String(init?.body)).stream, true);
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
}

test('the extraction stage preserves every candidate for independent semantic review', async () => {
  const payload = { productId: 11n, name: 'Team 5X成品JSON', spec: '', sourceData: { evidence: '成品JSON交付，仅支持Sub2API。禁止反代。质保30天，封号不保。' } };
  const tags = [
    { name: 'delivery_format', value: 'json', path: 'sourceData.evidence', quote: 'JSON' },
    { name: 'supported_client', value: 'sub2api', path: 'sourceData.evidence', quote: 'Sub2API' },
    { name: 'usage_restriction', value: '禁止反代', path: 'sourceData.evidence', quote: '禁止反代' },
    { name: 'access_channel', value: 'reverse_proxy', path: 'sourceData.evidence', quote: '反代' },
    { name: 'access_channel', value: 'web', path: 'sourceData.evidence', quote: '仅支持Sub2API' },
    { name: 'warranty_days', value: '30', path: 'sourceData.evidence', quote: '质保30天' },
  ];
  const call = (items: unknown) => createOpenAiModelCall({ getTagExtractionBatchInputs: async () => ({ jobId: 3n, model: 'mock', inputs: [payload] }) } as never,
    { AI_BASE_URL: 'https://mock.invalid/v1', AI_API_KEY: 'mock', AI_MODEL: 'mock' }, async (_url, init) => {
      const sent = JSON.parse(String(init?.body)); assert.equal(sent.stream, true);
      assert.match(sent.messages[0].content, /supported_client/);
      const body = JSON.stringify({ items });
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: body }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
  const job = { ...claimed(), row: { ...claimed().row, job_type: 'tag_extraction' } };
  const result = await call([{ id: '11', tags }])(job, new AbortController().signal) as any;
  assert.deepEqual(result.tagExtractionItems[0].tags, tags.map(({ path, quote, ...tag }) => ({ ...tag, evidence: [{ path, quote }] })));
  assert.equal(result.tagExtractionStage, 'extract');
  assert.deepEqual(result.tagExtractionItems[0].rejectedTags, []);
  await assert.rejects(call([{ id: '99', tags }])(job, new AbortController().signal));
  await assert.rejects(call([{ id: '11', tags }, { id: '11', tags }])(job, new AbortController().signal));
});

test('tag worker checkpoints complete candidates before semantic review or product publication', async () => {
  const events: string[] = [];
  let saved: any;
  const job = { ...claimed(), row: { ...claimed().row, job_type: 'tag_extraction' } };
  const state = service(job);
  const repository = {
    prepareBatch: async () => undefined,
    reserveBatchRequest: async () => { events.push('reserve'); return 'reserved'; },
    recordBatchRequestOutcome: async (_id: bigint, outcome: string) => { events.push(outcome); },
    getTagExtractionBatchInputs: async () => ({ jobId: 3n, model: 'mock', inputs: [
      { productId: 11n, name: '账号', spec: '1个月', sourceData: {} },
      { productId: 12n, name: '账号', spec: '不可续费', sourceData: {} },
    ] }),
    checkpointTagExtractionBatchDecision: async (_job: bigint, _batch: bigint, items: unknown) => { events.push('checkpoint'); saved = items; },
  };
  const call = createOpenAiModelCall(repository as never, {
    AI_BASE_URL: 'https://mock.invalid/v1', AI_API_KEY: 'mock', AI_MODEL: 'mock',
  }, async () => {
    events.push('send');
    const content = JSON.stringify({ items: [
      { id: '11', tags: [
        { name: 'duration', value: '1 month', path: 'spec', quote: '1个月' },
        { name: 'invented', value: 'yes', path: 'spec', quote: '1个月' },
      ] },
      { id: '12', tags: [
        { name: 'renewable', value: '无', path: 'spec', quote: '不可续费' },
        { name: 'renewable', value: 'no', path: 'spec', quote: '不可续费' },
      ] },
    ] });
    return new Response([content.slice(0, 30), content.slice(30)].map((part, index) =>
      `data: ${JSON.stringify({ choices: [{ delta: { content: part }, ...(index ? { finish_reason: 'stop' } : {}) }] })}\n\n`).join('') + 'data: [DONE]\n\n');
  });
  const worker = createAiWorker(state as never, { repository: repository as never, modelCall: call });
  try {
    await worker.runOnce();
    for (let i = 0; i < 40 && !state.completed && !state.failed; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(state.completed, 1);
    assert.equal(state.failed, 0);
    assert.deepEqual(events, ['reserve', 'send', 'checkpoint']);
    assert.deepEqual(saved.map((item: any) => item.tags.map((tag: any) => [tag.name, tag.value])),
      [[['duration', '1 month'], ['invented', 'yes']], [['renewable', '无'], ['renewable', 'no']]]);
    assert.deepEqual(saved.map((item: any) => item.rejectedTags), [[], []]);
  } finally { await worker.stop(); }
});

test('frozen job model selects provider options and preflight measures the exact outbound body', async () => {
  for (const model of ['gpt-6.1-sol', 'deepseek-flash', 'glm-5.3-flash']) {
    const frozen = { ...request, model };
    const environment = {
      AI_BASE_URL: 'https://model.invalid/v1', AI_API_KEY: 'test', AI_MODEL: 'deepseek-flash',
      AI_REASONING_EFFORT: 'high', AI_THINKING: 'disabled',
    };
    let body = '';
    const call = createOpenAiModelCall({ getBatchRequest: async () => frozen } as never, environment, async (_url, init) => {
      body = String(init?.body);
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(validResponse) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
    const result = await call(claimed(), new AbortController().signal);
    const sent = JSON.parse(body);
    assert.equal(result.items[0]?.status, 'classified');
    assert.equal(sent.model, model);
    assert.equal(sent.stream, true);
    assert.equal(estimateStandardizationRequest(buildStandardizationRequest(frozen), readStandardizationRequestLimits(environment)).requestBytes, Buffer.byteLength(body));
    if (model === 'gpt-6.1-sol') {
      assert.equal(sent.max_completion_tokens, 32768);
      assert.equal(sent.reasoning_effort, 'high');
      assert.equal('max_tokens' in sent, false);
      assert.equal('thinking' in sent, false);
    } else if (model === 'glm-5.3-flash') {
      assert.equal(sent.max_tokens, 32768);
      assert.equal(sent.reasoning_effort, 'high');
      assert.deepEqual(sent.thinking, { type: 'enabled' });
      assert.equal('max_completion_tokens' in sent, false);
    } else {
      assert.equal(sent.max_tokens, 32768);
      assert.deepEqual(sent.thinking, { type: 'disabled' });
      assert.equal('reasoning_effort' in sent, false);
    }
  }
});

test('streams one finite-action request using the job model and frozen per-input candidate refs', async () => {
  let sent: any;
  const call = createOpenAiModelCall({ getBatchRequest: async () => ({ ...request, model: 'selected-model' }) } as never, {
    AI_BASE_URL: 'https://model.invalid/v1', AI_API_KEY: 'secret', AI_MODEL: 'default-model', AI_TIMEOUT_MS: '1000',
  }, async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    const content = JSON.stringify(validResponse);
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  const result = await call(claimed(), new AbortController().signal);
  assert.equal(sent.model, 'selected-model');
  assert.equal(sent.stream, true);
  assert.deepEqual(sent.response_format, { type: 'json_object' });
  // The messages must carry the contract because json_object does not enforce
  // a schema. Verify the actual outbound request.
  const contract = JSON.parse(sent.messages[0].content.split('Output JSON Schema:\n')[1]);
  assert.deepEqual(contract.required, ['items']);
  assert.equal(Object.hasOwn(contract.$defs, 'tag'), false);
  assert.match(sent.messages[0].content, /reuse_candidate.*create_identity.*insufficient_evidence.*not_sellable/);
  assert.match(sent.messages[0].content, /not_sellable:.*excluded model API relay product/iu);
  assert.match(sent.messages[0].content, /Relay\/API mentions in after-sales or policy warnings.*alone do not establish the sold object/iu);
  const payload = JSON.parse(sent.messages[1].content);
  assert.deepEqual(payload.items.map((item: any) => item.candidateRefs), [{ i1c1: 'c1' }, {}, {}]);
  assert.deepEqual(payload.candidates, { c1: { family: 'openai', product: 'chatgpt', tier: 'plus', aliases: [] } });
  assert.deepEqual(result.items.map(item => item.id), ['11', '12']);
  assert.deepEqual(result.missingIds, ['13']);
  assert.ok(result.items.every(item => !Object.hasOwn(item, 'tags')));
});

test('assembles streamed chunks before JSON and business validation', async () => {
  const result = await modelCall(validResponse, { split: 37 })(claimed(), new AbortController().signal);
  assert.equal(result.identities.length, 1);
  assert.equal(result.items[1]?.identity?.kind, 'new');
});

test('accepts one complete JSON code fence after streaming without bypassing validation', async () => {
  const json = JSON.stringify(validResponse);
  for (const content of [
    `\`\`\`json\n${json}\n\`\`\``,
    `\`\`\`\n${json}\n\`\`\``,
    ` \n\`\`\`JSON \r\n${json}\r\n\`\`\`\n `,
    `\uFEFF${json}`,
  ]) {
    const result = await modelCall(content, { split: 4 })(claimed(), new AbortController().signal);
    assert.equal(result.items[0]?.status, 'classified');
    assert.equal(result.items[1]?.identity?.kind, 'new');
    assert.deepEqual(result.missingIds, ['13']);
  }
  const fabricated = structuredClone(validResponse);
  fabricated.items[0]!.evidence = [citation('invented evidence')];
  const rejected = await modelCall(`\`\`\`json\n${JSON.stringify(fabricated)}\n\`\`\``)(claimed(), new AbortController().signal);
  assert.equal(rejected.items[0]?.reasonCode, 'evidence_invalid');
  const duplicate = { items: [validResponse.items[0], validResponse.items[0]] };
  await assert.rejects(modelCall(`\`\`\`json\n${JSON.stringify(duplicate)}\n\`\`\``)(claimed(), new AbortController().signal), /duplicate|重复/i);
});

test('invalid JSON reports bounded format diagnostics without exposing response text', async () => {
  const json = JSON.stringify(validResponse);
  for (const [content, format] of [
    [' \n\t ', 'empty'],
    ['{"secret-private-listing":', 'json'],
    ['{"secret-private-listing":true,}', 'json'],
    [`Here is the result: ${json}`, 'text'],
    [`<think>secret-private-listing</think>${json}`, 'text'],
    [`\`\`\`json\n${json}`, 'markdown'],
    [`\`\`\`json\n${json}\n\`\`\`\nsecret-private-listing`, 'markdown'],
    [`\`\`\`json\n${json}\n\`\`\`\n\`\`\`json\n${json}\n\`\`\``, 'markdown'],
    [`${json}\n${json}`, 'json'],
  ]) {
    await assert.rejects(modelCall(content, { split: 4 })(claimed(), new AbortController().signal), (error: any) => {
      assert.equal(error.message, `AI response JSON is invalid (format=${format}, chars=${content.length})`);
      assert.equal(error.retryClass, 'invalid_response');
      assert.equal(error.requestOutcome, 'confirmed');
      assert.equal(error.retryable, false);
      assert.equal('content' in error, false);
      assert.doesNotMatch(error.message, /secret-private-listing|ChatGPT|Claude/);
      return true;
    });
  }
});

test('streamed multiline citations match the frozen field after whitespace normalization', async () => {
  const response = structuredClone(validResponse);
  response.items[0]!.evidence = [citation('ChatGPT\nPlus\tmonthly')];
  const result = await modelCall(response, { split: 37 })(claimed(), new AbortController().signal);
  assert.equal(result.items[0]?.status, 'classified');
  assert.equal(result.items[0]?.evidence[0]?.quote, 'ChatGPT Plus monthly');
});

test('rejects fabricated, borrowed, absent and incorrectly located evidence before saving decisions', async () => {
  for (const evidence of [
    [citation('invented evidence')], [citation('Claude Team annual')], [],
    [{ path: 'sourceData.nonexistent', quote: 'ChatGPT Plus monthly' }],
    [{ path: 'candidates.c1.product', quote: 'chatgpt' }], [{ path: 'candidateRefs.i1c1', quote: 'c1' }],
    [{ path: '__proto__.constructor', quote: 'Object' }],
  ]) {
    const response = structuredClone(validResponse);
    response.items[0]!.evidence = evidence;
    const result = await modelCall(response)(claimed(), new AbortController().signal);
    assert.equal(result.items[0]?.status, 'unclassified');
    assert.equal(result.items[0]?.reasonCode, 'evidence_invalid');
    assert.equal(result.items[1]?.status, 'classified', 'invalid evidence must remain item-local');
    assert.deepEqual(result.missingIds, ['13']);
  }
});

test('generation preserves authentic identity proposals for independent LLM semantic review', async () => {
  const response = structuredClone(validResponse);
  response.items[0] = rawItem('11', { ...rawIdentity('google', 'gemini', 'pro'), evidence: [citation('ChatGPT Plus')] }, null);
  const result = await modelCall(response)(claimed(), new AbortController().signal);
  assert.equal(result.items[0]?.status, 'classified');
  assert.equal(result.standardizationStage, 'generate');
  assert.equal(result.identities[0]?.family, 'google');
});

test('rejects candidate refs borrowed from another item as an item-local invalid response', async () => {
  const response = structuredClone(validResponse);
  response.items[1] = rawItem('12', null, 'i1c1');
  const result = await modelCall(response)(claimed(), new AbortController().signal);
  assert.equal(result.items[1]?.status, 'unclassified');
  assert.equal(result.items[1]?.reasonCode, 'invalid_response');
});

test('rejects duplicate and unknown IDs globally while allowing omitted IDs', async () => {
  const duplicate = structuredClone(validResponse);
  duplicate.items.push(structuredClone(duplicate.items[0]!));
  await assert.rejects(modelCall(duplicate)(claimed(), new AbortController().signal), /duplicate|重复/i);
  const unknown = structuredClone(validResponse);
  unknown.items[0]!.id = '999';
  await assert.rejects(modelCall(unknown)(claimed(), new AbortController().signal), /unknown|未知/i);
  const omitted = await modelCall({ items: [] })(claimed(), new AbortController().signal);
  assert.deepEqual(omitted.missingIds, ['11', '12', '13']);
});

test('rejects invalid JSON and truncated streamed output after the full response', async () => {
  await assert.rejects(modelCall('{')(claimed(), new AbortController().signal), (error: any) => {
    assert.match(error.message, /JSON/i);
    assert.equal(error.retryClass, 'invalid_response');
    assert.equal(error.requestOutcome, 'confirmed');
    assert.equal(error.retryable, false);
    return true;
  });
  await assert.rejects(modelCall(validResponse, { split: 37, finishReason: 'length' })(claimed(), new AbortController().signal), (error: any) => {
    assert.match(error.message, /incomplete|length/i);
    assert.equal(error.retryClass, 'invalid_response');
    assert.equal(error.requestOutcome, 'confirmed');
    assert.equal(error.retryable, false);
    return true;
  });
});

test('whole-response deadline aborts a stream stalled after headers', async () => {
  const call = createOpenAiModelCall({ getBatchRequest: async () => request } as never, {
    AI_BASE_URL: 'https://model.invalid/v1', AI_API_KEY: 'secret', AI_MODEL: 'configured', AI_TIMEOUT_MS: '30',
  }, async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"{"}}]}\n\n'));
      init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason), { once: true });
    },
  }), { headers: { 'content-type': 'text/event-stream' } }));
  await assert.rejects(call(claimed(), new AbortController().signal), /timed out/i);
});

test('caller cancellation reaches the concrete fetch signal', async () => {
  const controller = new AbortController();
  let fetchAborted = false;
  const call = createOpenAiModelCall({ getBatchRequest: async () => request } as never, {
    AI_BASE_URL: 'https://model.invalid/v1', AI_API_KEY: 'secret', AI_MODEL: 'configured', AI_TIMEOUT_MS: '1000',
  }, async (_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => {
    fetchAborted = true; reject(init!.signal!.reason);
  }, { once: true })));
  const running = call(claimed(), controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('cancelled'));
  await assert.rejects(running, /cancelled/);
  assert.equal(fetchAborted, true);
});

test('validates production configuration before work is claimed', () => {
  const repository = { getBatchRequest: async () => request } as never;
  assert.throws(() => createOpenAiModelCall(repository, {}), /configuration/i);
  assert.throws(() => createOpenAiModelCall(repository, { AI_BASE_URL: 'file:///tmp/model', AI_API_KEY: 'secret', AI_MODEL: 'configured' }), /configuration/i);
});

test('invalid frozen GLM tag options fail before reserving or recording any provider request', async () => {
  for (const effort of ['medium', 'xhigh']) {
    const calls: string[] = [];
    const state = service({ ...claimed(), row: { ...claimed().row, job_type: 'tag_extraction' } });
    const repository = {
      prepareBatch: async () => {},
      getTagExtractionBatchInputs: async () => ({
        jobId: 3n, model: 'glm-5.3-flash', inputs: [{ productId: 11n, name: 'ChatGPT Plus', spec: '', sourceData: {} }],
      }),
      reserveBatchRequest: async () => { calls.push('reserve'); return 'reserved' as const; },
      recordBatchRequestOutcome: async () => { calls.push('outcome'); },
    };
    const call = createOpenAiModelCall(repository as never, {
      AI_BASE_URL: 'https://model.invalid/v1', AI_API_KEY: 'test', AI_MODEL: 'deepseek-flash', AI_REASONING_EFFORT: effort,
    }, async () => { calls.push('fetch'); throw new Error('Unexpected provider request'); });
    let settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    const worker = createAiWorker(Object.assign(state, { onSettled: settle }) as never, {
      repository: repository as never, modelCall: call, maxRetries: 0,
    });
    try {
      await worker.runOnce();
      await settled;
      assert.deepEqual(calls, []);
      assert.equal(state.failed, 1);
      assert.equal(state.completed, 0);
      assert.notEqual(state.failureOptions?.retryClass, 'provider_unknown');
    } finally { await worker.stop(); }
  }
});

test('request step prepares, reserves and atomically checkpoints its confirmed result, then completes', async () => {
  const calls: string[] = [];
  const state = service();
  const worker = createAiWorker(state as never, {
    repository: {
      prepareBatch: async () => { calls.push('prepare'); },
      reserveBatchRequest: async () => { calls.push('reserve'); },
      recordBatchRequestOutcome: async (_id: bigint, outcome: string) => { calls.push(`outcome:${outcome}`); },
      persistBatchDecision: async () => { calls.push('persist'); },
      publishBatch: async () => { calls.push('publish'); },
    } as never,
    modelCall: async () => Object.assign({ identities: [], items: [], missingIds: ['11', '12', '13'] }, { metadata: { responseMs: 2, outputBytes: 10 } }),
  });
  await worker.runOnce();
  await new Promise(resolve => setImmediate(resolve));
  await worker.stop();
  assert.deepEqual(calls, ['prepare', 'reserve', 'persist']);
  assert.equal(state.completed, 1);
});

test('skipped request batches never call the model or consume a provider outcome', async () => {
  const calls: string[] = [];
  const state = service();
  const worker = createAiWorker(state as never, {
    repository: {
      prepareBatch: async () => { calls.push('prepare'); },
      reserveBatchRequest: async () => { calls.push('reserve'); return 'skipped' as const; },
      recordBatchRequestOutcome: async () => { calls.push('outcome'); },
      persistBatchDecision: async () => { calls.push('persist'); },
      publishBatch: async () => { calls.push('publish'); },
    } as never,
    modelCall: async () => { calls.push('model'); return { identities: [], items: [], missingIds: [] }; },
  });
  await worker.runOnce();
  await new Promise(resolve => setImmediate(resolve));
  await worker.stop();
  assert.deepEqual(calls, ['prepare', 'reserve']);
  assert.equal(state.completed, 1);
});

test('changed batches rebuild the request before reserving a provider attempt', async () => {
  const calls: string[] = [];
  const state = service();
  const modelCall = Object.assign(
    async () => ({ identities: [], items: [], missingIds: [] }),
    { prepare: async () => {
      const request = calls.filter(call => call.startsWith('request:')).length + 1;
      calls.push(`request:${request}`);
      return async () => { calls.push(`model:${request}`); return { identities: [], items: [], missingIds: [] }; };
    } },
  );
  let reservations = 0;
  const worker = createAiWorker(state as never, {
    repository: {
      prepareBatch: async () => { calls.push('prepare'); },
      reserveBatchRequest: async () => ++reservations === 1 ? 'refresh' as const : 'reserved' as const,
      recordBatchRequestOutcome: async (_id: bigint, outcome: string) => { calls.push(`outcome:${outcome}`); },
      persistBatchDecision: async () => { calls.push('persist'); },
      publishBatch: async () => { calls.push('publish'); },
    } as never,
    modelCall,
  });
  await worker.runOnce();
  await new Promise(resolve => setImmediate(resolve));
  await worker.stop();
  assert.deepEqual(calls, ['prepare', 'request:1', 'prepare', 'request:2', 'model:2', 'persist']);
  assert.equal(reservations, 2);
  assert.equal(state.completed, 1);
});

test('publish step uses no model request and calls only recoverable publication', async () => {
  const calls: string[] = [];
  const state = service(claimed('publish'));
  const worker = createAiWorker(state as never, {
    repository: {
      prepareBatch: async () => { calls.push('prepare'); },
      reserveBatchRequest: async () => { calls.push('reserve'); },
      recordBatchRequestOutcome: async () => { calls.push('outcome'); },
      persistBatchDecision: async () => { calls.push('persist'); },
      publishBatch: async () => { calls.push('publish'); },
    } as never,
    modelCall: async () => { calls.push('model'); return { identities: [], items: [], missingIds: [] }; },
  });
  await worker.runOnce();
  await new Promise(resolve => setImmediate(resolve));
  await worker.stop();
  assert.deepEqual(calls, ['prepare', 'publish']);
  assert.equal(state.completed, 1);
});

test('provider failure records its send outcome and never persists a partial response', async () => {
  const calls: string[] = [];
  const state = service();
  const worker = createAiWorker(state as never, {
    repository: {
      prepareBatch: async () => undefined,
      reserveBatchRequest: async () => { calls.push('reserve'); },
      recordBatchRequestOutcome: async (_id: bigint, outcome: string) => { calls.push(`outcome:${outcome}`); },
      persistBatchDecision: async () => { calls.push('persist'); },
    } as never,
    modelCall: async () => { throw new Error('connection reset after send'); },
  });
  await worker.runOnce();
  await new Promise(resolve => setImmediate(resolve));
  await worker.stop();
  assert.deepEqual(calls, ['reserve', 'outcome:unknown']);
  assert.equal(state.failed, 1);
});

test('stream failures consume one shared reservation without persisting or automatically resending', async () => {
  for (const failure of [
    { finishReason: 'length', content: '{"items":', outcome: 'confirmed', retryClass: 'invalid_response' },
    { finishReason: 'stop', content: '{', outcome: 'confirmed', retryClass: 'invalid_response' },
    { finishReason: 'stop', content: '{}', usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 20 }, outcome: 'confirmed', retryClass: 'invalid_response' },
    { finishReason: undefined, content: '{"items":', outcome: 'unknown', retryClass: 'provider_unknown' },
  ]) {
    const calls: string[] = [];
    const state = service();
    const repository = {
      prepareBatch: async () => { calls.push('prepare'); },
      getBatchRequest: async () => request,
      reserveBatchRequest: async () => { calls.push('reserve'); },
      recordBatchRequestOutcome: async (_id: bigint, outcome: string) => { calls.push(`outcome:${outcome}`); },
      persistBatchDecision: async () => { calls.push('persist'); },
    };
    const call = createOpenAiModelCall(repository as never, {
      AI_BASE_URL: 'https://model.invalid/v1', AI_API_KEY: 'test', AI_MODEL: 'configured',
    }, async (_url, init) => {
      calls.push('send');
      assert.equal(JSON.parse(String(init?.body)).stream, true);
      return new Response([
        { choices: [{ delta: { content: failure.content.slice(0, 1) } }] },
        { choices: [{ delta: { content: failure.content.slice(1) }, finish_reason: failure.finishReason }], usage: failure.usage },
      ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n');
    });
    const worker = createAiWorker(state as never, { repository: repository as never, modelCall: call });
    try {
      await worker.runOnce();
      for (let i = 0; i < 40 && !state.failed; i++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(state.failed, 1);
      assert.equal(state.completed, 0);
      assert.equal(state.requeued, 0);
      assert.deepEqual(calls, ['prepare', 'reserve', 'send', `outcome:${failure.outcome}`]);
      assert.deepEqual(state.failureOptions, { retry: false, backoffMs: 0, retryClass: failure.retryClass });
      await worker.runOnce();
      assert.deepEqual(calls, ['prepare', 'reserve', 'send', `outcome:${failure.outcome}`]);
    } finally { await worker.stop(); }
  }
});

test('preflight reuses the exact frozen request once and preserves provider usage metadata', async () => {
  let reads = 0; let sends = 0; let saved: any; const events: string[] = [];
  const frozen = structuredClone(request);
  const repository = {
    prepareBatch: async () => undefined,
    getBatchRequest: async () => { reads++; events.push('read'); return frozen; },
    reserveBatchRequest: async () => { events.push('reserve'); frozen.inputs[0]!.payload.name = 'changed after preflight'; },
    recordBatchRequestOutcome: async (_id: unknown, outcome: string) => { events.push(outcome); },
    persistBatchDecision: async (_job: unknown, _batch: unknown, decision: unknown, metadata: unknown) => { saved = { decision, metadata }; },
  };
  const state = service();
  const call = createOpenAiModelCall(repository as never, { AI_BASE_URL: 'https://model.invalid/v1', AI_API_KEY: 'test', AI_MODEL: 'configured' }, async (_url, init) => {
    sends++; const sent = JSON.parse(String(init?.body));
    assert.equal(JSON.parse(sent.messages[1].content).items[0].name, 'ChatGPT Plus monthly');
    assert.equal(sent.stream_options.include_usage, true);
    return new Response([
      { id: 'response-1', model: 'actual-model', choices: [{ delta: { content: JSON.stringify(validResponse) }, finish_reason: 'stop' }] },
      { id: 'response-1', model: 'actual-model', choices: [], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } },
    ].map(chunk => 'data: ' + JSON.stringify(chunk) + '\n\n').join('') + 'data: [DONE]\n\n');
  });
  const runtime = createAiWorker(state as never, { repository: repository as never, modelCall: call });
  await runtime.runOnce();
  for (let i = 0; i < 30 && !state.completed && !state.failed; i++) await new Promise(resolve => setTimeout(resolve, 5));
  await runtime.stop();
  assert.equal(state.completed, 1); assert.equal(reads, 1); assert.equal(sends, 1);
  assert.deepEqual(events, ['read', 'reserve']);
  assert.equal(saved.decision.standardizationStage, 'generate');
  assert.equal(saved.decision.items[0].status, 'classified');
  assert.deepEqual(saved.metadata.usage, { promptTokens: 100, completionTokens: 50, totalTokens: 150 });
  assert.equal(saved.metadata.responseModel, 'actual-model'); assert.equal(saved.metadata.responseId, 'response-1');
});

test('known generic goods, email, courses and human services retain the new-identity path', async () => {
  for (const [family, product, tier] of [
    ['stationery', 'notebook', 'lined'], ['google', 'email', 'standard'],
    ['education', 'mathematics_course', 'basic'], ['services', 'consultation', 'standard'],
  ]) {
    const name = family + ' ' + product + ' ' + tier; const evidence = [citation(name)];
    const genericRequest = { jobId: 3n, model: 'configured', candidates: [], inputs: [{ productId: 11n, fingerprint: 'a'.repeat(64), payload: { id: '11', name }, candidateStandardProductIds: [] }] };
    const call = createOpenAiModelCall({ getBatchRequest: async () => genericRequest } as never, { AI_BASE_URL: 'https://model.invalid/v1', AI_API_KEY: 'test', AI_MODEL: 'configured' }, async () => new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ items: [{ id: '11', action: 'create_identity', identity: { family, product, tier, reason: 'Explicit offer', evidence }, ruleIds: [], reason: 'Explicit offer', evidence }] }) }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'));
    const result = await call(claimed(), new AbortController().signal);
    assert.equal(result.items[0]?.status, 'classified', product);
    assert.equal(result.items[0]?.identity?.kind, 'new');
  }
});
